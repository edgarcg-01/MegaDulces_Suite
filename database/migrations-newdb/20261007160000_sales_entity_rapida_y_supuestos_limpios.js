'use strict';
/**
 * `[VE.6.1]` — **Dos defectos que dejó `[VE.6]`, medidos contra prod.** Reportados por Edgar al
 * abrir la pantalla: *«tarda mucho para cargar, además el proceso deja llenar o editar los datos»*.
 *
 * ── 1. La vista se volvió 3× más lenta, y fue por mi join ───────────────────────────────────
 *
 * Medido en prod, la misma consulta:
 *
 *     DISTINCT solo (como estaba antes)          309 ms
 *     DISTINCT + LEFT JOIN al mapa (mi [VE.6])   907 ms   ← 2.9×
 *     DISTINCT primero, mapeo después            247 ms   ← esta migración
 *
 * El join rompía el index-only scan: `SELECT DISTINCT` sobre la matvista podía resolverse con
 * `ux_mv_sellout_monthly`, y al meter `sellout_channel_map` en el mismo nivel hay que traer
 * `source` y `branch_name` fuera del índice y recorrer la matvista entera.
 *
 * ⭐ El arreglo no es un índice nuevo: es el **orden**. El DISTINCT crudo devuelve ~50 filas
 * (canal × almacén); mapear 50 filas es gratis. Mapear primero y deduplicar después obliga a pasar
 * el mapa por cada fila de la matvista. *Deduplicar antes de enriquecer, no al revés.*
 *
 * Y queda **más rápida que antes** de tocarla, que es la vara correcta: una vista que se arregla
 * dejando una regresión de rendimiento a medias no está arreglada.
 *
 * ── 2. Los supuestos seguían guardados con un canal muerto ──────────────────────────────────
 *
 * `[VE.6]` remapeó `budget.sales_plan_lines` y **se olvidó de `budget.sales_plan_settings`**. El
 * JSONB vivo en prod era:
 *
 *     {"ruta": 0.013, "credito": -0.294, "preventa": 0.444, "mostrador": 0.125}
 *
 * O sea: la pantalla seguía ofreciendo «Credito» para capturar, con el **−29.4 % que ya sabemos
 * que es la reclasificación** y no una caída.
 *
 * ⛔ La clave muerta **se borra, no se renombra a `mayoreo`**. Renombrarla conservaría el número
 * contaminado y lo dejaría con aspecto de supuesto legítimo sobre el canal correcto — que es peor
 * que no tenerlo: el motor sabe re-derivarlo (el valor correcto medido es **−8.4 %**), y una clave
 * ausente hace que lo re-derive. *Arrastrar un número que sabemos malo porque "ya estaba" es cómo
 * un error sobrevive a su propio arreglo.*
 */

const VISTA = 'analytics.v_sales_entity';

exports.up = async function up(knex) {
  // ── 1. La vista, deduplicando ANTES de enriquecer ────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH crudo AS (
      -- ~50 filas. Este DISTINCT se resuelve con el índice de la matvista; todo lo que se le
      -- sume acá adentro lo rompe.
      SELECT DISTINCT tenant_id, source, channel, warehouse_code, branch_name
        FROM analytics.mv_sellout_monthly
    ),
    ent AS (
      SELECT DISTINCT c.tenant_id,
             coalesce(cm.canonical_channel, c.channel)     AS channel,
             coalesce(cm.label, initcap(c.channel))        AS channel_label,
             c.warehouse_code,
             c.branch_name
        FROM crudo c
        LEFT JOIN analytics.sellout_channel_map cm
               ON cm.tenant_id = c.tenant_id AND cm.source = c.source AND cm.raw_channel = c.channel
    )
    SELECT e.tenant_id,
           (e.channel || ':'::text) || e.warehouse_code::text AS entity_key,
           e.channel,
           e.channel_label,
           CASE WHEN e.channel = 'ruta'::text THEN 'ruta'::text ELSE 'sucursal_canal'::text END AS entity_type,
           e.warehouse_code,
           e.branch_name,
           CASE WHEN e.warehouse_code::text ~~ 'RUTA-%'::text
                THEN SUBSTRING(e.warehouse_code FROM 6) ELSE NULL::text END AS route_code,
           crc.zona  AS route_zona,
           w.zone_id
      FROM ent e
      LEFT JOIN warehouses w
             ON w.tenant_id = e.tenant_id AND w.code::text = e.warehouse_code::text AND w.deleted_at IS NULL
      LEFT JOIN commission_route_config crc
             ON crc.tenant_id = e.tenant_id AND e.warehouse_code::text ~~ 'RUTA-%'::text
            AND crc.route_code::text = SUBSTRING(e.warehouse_code FROM 6) AND crc.deleted_at IS NULL`);

  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  // ── 2. Sacar del JSONB las claves de canales alias ───────────────────────────────────────
  const { rows: alias } = await knex.raw(
    `SELECT DISTINCT raw_channel FROM analytics.sellout_channel_map
      WHERE raw_channel <> canonical_channel`);
  const muertas = alias.map((r) => r.raw_channel);

  if (muertas.length) {
    // ⚠️ `jsonb_exists_any(...)` y NO el operador `?|`: knex lee cada `?` del SQL como un
    // placeholder, así que `?|` le hace contar un binding de más y la migración muere con
    // «Expected 2 bindings, saw 3». Es la misma trampa que `CLAUDE.md` ya documenta para el
    // operador `?` de JSONB en los diffs de `role_permissions`, y la que `[CV.7]` midió cuando
    // NINGUNA query parametrizada funcionaba. La función hace exactamente lo mismo.
    const { rowCount } = await knex.raw(
      `UPDATE budget.sales_plan_settings
          SET growth_by_channel = growth_by_channel - ?::text[], updated_at = now()
        WHERE jsonb_exists_any(growth_by_channel, ?::text[])`,
      [muertas, muertas]);
    console.log(`[VE.6.1] supuestos limpiados en ${rowCount ?? 0} fila(s); `
      + `claves retiradas: ${muertas.join(', ')} — el motor las re-deriva sobre el canal canónico`);
  }
};

exports.down = async function down(knex) {
  // Vuelve a la forma de `[VE.6]` (mapeo en el mismo nivel del DISTINCT): correcta en resultado,
  // 3× más lenta. Las claves retiradas del JSONB NO se reponen: eran el número contaminado.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH ent AS (
      SELECT DISTINCT m.tenant_id,
             coalesce(cm.canonical_channel, m.channel) AS channel,
             coalesce(cm.label, initcap(m.channel))    AS channel_label,
             m.warehouse_code, m.branch_name
        FROM analytics.mv_sellout_monthly m
        LEFT JOIN analytics.sellout_channel_map cm
               ON cm.tenant_id = m.tenant_id AND cm.source = m.source AND cm.raw_channel = m.channel
    )
    SELECT e.tenant_id,
           (e.channel || ':'::text) || e.warehouse_code::text AS entity_key,
           e.channel, e.channel_label,
           CASE WHEN e.channel = 'ruta'::text THEN 'ruta'::text ELSE 'sucursal_canal'::text END AS entity_type,
           e.warehouse_code, e.branch_name,
           CASE WHEN e.warehouse_code::text ~~ 'RUTA-%'::text
                THEN SUBSTRING(e.warehouse_code FROM 6) ELSE NULL::text END AS route_code,
           crc.zona AS route_zona, w.zone_id
      FROM ent e
      LEFT JOIN warehouses w
             ON w.tenant_id = e.tenant_id AND w.code::text = e.warehouse_code::text AND w.deleted_at IS NULL
      LEFT JOIN commission_route_config crc
             ON crc.tenant_id = e.tenant_id AND e.warehouse_code::text ~~ 'RUTA-%'::text
            AND crc.route_code::text = SUBSTRING(e.warehouse_code FROM 6) AND crc.deleted_at IS NULL`);
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};
