'use strict';
/**
 * `[VE.6]` — **El presupuesto deja de partir canales que el negocio une.** Pedido de Edgar
 * (2026-10-07): *«todo debe salir de un canal verdadero y normalizado»*.
 *
 * ── El hallazgo ─────────────────────────────────────────────────────────────────────────────
 *
 * `analytics.v_sales_entity` **es** una vista derivada —cumple la mitad de la regla— pero publica
 * el canal **CRUDO** de `mv_sellout_monthly`: seis rótulos donde el negocio tiene cuatro. El mapa
 * canónico `analytics.sellout_channel_map` (Fase VSO.1) ya declara las equivalencias, con su
 * evidencia escrita, y esta vista no lo leía:
 *
 *     wincaja:credito    → mayoreo     "caja 70 = Mayoreo a credito — el MISMO canal que U-D-8,
 *                                       del otro lado del cutover"
 *     kepler:contado_nf  → mostrador   "U-D-12 Factura Contado No Fiscal = venta de PISO"
 *
 * ⭐ **Y no es teoría: el canal `credito` dejó de existir el 2026-09-18.** Medido — sus tres
 * plazas (01 Padre Hidalgo, 06 Canindo, 08 Morelia Abastos) dejan de aportar el 19-sep, y la 08
 * aparece en `mayoreo` **exactamente ese día**, que es su cutover a Kepler. El canal no cayó: se
 * renombró.
 *
 * Lo que eso provocaba, medido sobre el plan FY2027 real:
 *
 *   · **$76.0 M de meta (16.2 % del plan) en rótulos muertos** — `credito` $74,950,668 y
 *     `contado_nf` $1,049,299. El real de 2027 va a entrar por `mayoreo` y `mostrador`, así que
 *     esos renglones habrían mostrado **0 % de cumplimiento para siempre** y `mayoreo` un
 *     sobrecumplimiento falso con apenas $20.7 M de meta para lo que factura ~$95 M.
 *   · **El supuesto de crecimiento salía −29.4 % cuando el correcto es −8.4 %** (crédito+mayoreo:
 *     $140.2 M → $128.4 M). 21 puntos sobre el segundo canal más grande, y el negocio entero
 *     creció **+12.4 %**.
 *
 * ⚠️ El candado `[VSO.8]` no podía verlo: vigila que la entidad **exista** en el catálogo, y
 * `credito` seguía existiendo. Pasaba en verde. Es el patrón que `[VSO.1]` ya había nombrado —
 * *la distancia entre el vocabulario real y el publicado no está en ninguna lista*.
 *
 * ── Lo delicado: 90 COLISIONES ──────────────────────────────────────────────────────────────
 *
 * Al remapear, **93 líneas cambian de `entity_key`** y **90 quedan pisando una que ya existe**
 * (180 líneas, $261.9 M involucrados): `credito:06` y `mayoreo:06` del mismo periodo pasan a ser
 * la misma celda. ⛔ Un `UPDATE` directo violaría el único por `(budget, entity_key, period)`, y
 * un `ON CONFLICT DO UPDATE` **se quedaría con una sola de las dos metas y perdería la otra**.
 *
 * Se **FUSIONAN sumando**, que es lo que el negocio significa: dos pedazos del mismo canal. El
 * `method` resultante conserva `manual` si alguno de los dos lo era —una captura humana no se
 * degrada a derivada— y la nota deja el rastro de qué se fusionó.
 *
 * ── El candado está DENTRO de la migración ──────────────────────────────────────────────────
 *
 * La suma total del plan **tiene que ser idéntica antes y después**: esto reagrupa, no recalcula.
 * Si cambia un centavo, algo se perdió y la migración **aborta** — no hay forma de revisar 418
 * metas a mano después.
 */

const VISTA = 'analytics.v_sales_entity';

exports.up = async function up(knex) {
  // ── 1. La vista, derivando el canal del MAPA ─────────────────────────────────────────────
  // `label` y `orden` salen del mapa, no de un CASE: tener el rótulo en dos lugares es cómo se
  // llega a que uno diga «Mayoreo / Crédito» y el otro «Mayoreo» para el mismo canal.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH ent AS (
      SELECT DISTINCT m.tenant_id,
             coalesce(cm.canonical_channel, m.channel) AS channel,
             coalesce(cm.label, initcap(m.channel))    AS channel_label,
             m.warehouse_code,
             m.branch_name
        FROM analytics.mv_sellout_monthly m
        LEFT JOIN analytics.sellout_channel_map cm
               ON cm.tenant_id = m.tenant_id
              AND cm.source      = m.source
              AND cm.raw_channel = m.channel
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

  // `CREATE OR REPLACE VIEW` no conserva la opción ni el GRANT (ADR-057).
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  // ── 2. Las metas ya guardadas ────────────────────────────────────────────────────────────
  const { rows: antesRows } = await knex.raw(
    `SELECT coalesce(sum(meta_amount), 0)::numeric AS total, count(*)::int AS n
       FROM budget.sales_plan_lines`);
  const antes = { total: Number(antesRows[0].total), n: Number(antesRows[0].n) };

  // Fusiona sumando. `method`: si alguno de los dos era manual, el resultado es manual — una
  // captura humana no se degrada a derivada por un reagrupamiento del catálogo.
  //
  // ⚠️ Va en TRES pasos explícitos (tabla temporal → borrar → reinsertar) y no en un solo
  // `WITH borrado AS (DELETE …) INSERT …`: en una sentencia así el orden de ejecución de los
  // sub-statements lo decide el planner, y acá el DELETE es **sin WHERE**. No es algo que convenga
  // dejar a una garantía sutil de visibilidad de snapshot cuando lo que está en juego son las 418
  // metas del único plan que existe.
  await knex.raw(`
    CREATE TEMP TABLE ve6_agr ON COMMIT DROP AS
    WITH mapa AS (SELECT DISTINCT raw_channel, canonical_channel FROM analytics.sellout_channel_map),
    remap AS (
      SELECT s.*,
             coalesce(m.canonical_channel, split_part(s.entity_key, ':', 1))
               || ':' || split_part(s.entity_key, ':', 2) AS nuevo
        FROM budget.sales_plan_lines s
        LEFT JOIN mapa m ON m.raw_channel = split_part(s.entity_key, ':', 1)
    ),
    agr AS (
      SELECT tenant_id, budget_id, nuevo AS entity_key, period_no,
             sum(meta_amount)                                    AS meta_amount,
             CASE WHEN bool_or(method = 'manual') THEN 'manual'
                  ELSE min(method) END                           AS method,
             -- El crecimiento y la base dejan de ser comparables al fusionar dos canales: se
             -- ponen en NULL en vez de quedarse con el de una de las dos piernas, que sería
             -- atribuirle a la celda fusionada un supuesto que no la produjo.
             CASE WHEN count(*) > 1 THEN NULL ELSE min(growth_pct) END  AS growth_pct,
             CASE WHEN count(*) > 1 THEN NULL ELSE min(base_amount) END AS base_amount,
             CASE WHEN count(*) > 1
                  THEN '[VE.6] fusionada desde: ' || string_agg(DISTINCT entity_key, ' + ')
                  ELSE min(notes) END                            AS notes,
             min(created_by)  AS created_by,
             min(created_at)  AS created_at,
             count(*)         AS piezas
        FROM remap GROUP BY 1, 2, 3, 4
    )
    SELECT * FROM agr`);

  await knex.raw(`DELETE FROM budget.sales_plan_lines`);
  const { rowCount: escritas } = await knex.raw(`
    INSERT INTO budget.sales_plan_lines
      (tenant_id, budget_id, entity_key, period_no, meta_amount, method, growth_pct, base_amount,
       notes, created_by, created_at, updated_by, updated_at)
    SELECT tenant_id, budget_id, entity_key, period_no, meta_amount, method, growth_pct, base_amount,
           notes, created_by, created_at, 'migracion_ve6', now()
      FROM ve6_agr`);

  const { rows: despuesRows } = await knex.raw(
    `SELECT coalesce(sum(meta_amount), 0)::numeric AS total, count(*)::int AS n
       FROM budget.sales_plan_lines`);
  const despues = { total: Number(despuesRows[0].total), n: Number(despuesRows[0].n) };

  // ⭐ EL CANDADO, DENTRO DE LA MIGRACIÓN. Esto reagrupa, no recalcula: la suma del plan tiene que
  // ser idéntica al centavo. Si no lo es, algo se perdió, y 418 metas no se revisan a mano.
  const delta = Math.round((despues.total - antes.total) * 100) / 100;
  if (Math.abs(delta) > 0.01) {
    throw new Error(
      `[VE.6] ABORTA: la meta total cambió ${delta} (antes ${antes.total}, después ${despues.total}). `
      + 'Esto reagrupa canales, no recalcula metas — un cambio de total significa que se perdió una.');
  }
  console.log(`[VE.6] plan reagrupado al canal canónico: ${antes.n} → ${despues.n} líneas, `
    + `${escritas} escritas · total intacto (${despues.total})`);
};

exports.down = async function down(knex) {
  // ⛔ El remapeo NO se puede deshacer: al fusionar `credito:06` con `mayoreo:06` se suma, y de la
  // suma no se recuperan los sumandos. La vista sí vuelve a su forma anterior (canal crudo); las
  // metas se quedan agrupadas, que además es la forma correcta.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH ent AS (
      SELECT DISTINCT tenant_id, channel, warehouse_code, branch_name FROM analytics.mv_sellout_monthly
    )
    SELECT e.tenant_id,
           (e.channel || ':'::text) || e.warehouse_code::text AS entity_key,
           e.channel,
           CASE e.channel
             WHEN 'mostrador'::text THEN 'Mostrador'::text
             WHEN 'credito'::text   THEN 'Mayoreo / Crédito'::text
             WHEN 'ruta'::text      THEN 'Ruta directa (RD)'::text
             WHEN 'preventa'::text  THEN 'Vecinal / Preventa'::text
             ELSE initcap(e.channel) END AS channel_label,
           CASE WHEN e.channel = 'ruta'::text THEN 'ruta'::text ELSE 'sucursal_canal'::text END AS entity_type,
           e.warehouse_code,
           e.branch_name,
           CASE WHEN e.warehouse_code::text ~~ 'RUTA-%'::text
                THEN SUBSTRING(e.warehouse_code FROM 6) ELSE NULL::text END AS route_code,
           crc.zona AS route_zona,
           w.zone_id
      FROM ent e
      LEFT JOIN warehouses w
             ON w.tenant_id = e.tenant_id AND w.code::text = e.warehouse_code::text AND w.deleted_at IS NULL
      LEFT JOIN commission_route_config crc
             ON crc.tenant_id = e.tenant_id AND e.warehouse_code::text ~~ 'RUTA-%'::text
            AND crc.route_code::text = SUBSTRING(e.warehouse_code FROM 6) AND crc.deleted_at IS NULL`);
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};
