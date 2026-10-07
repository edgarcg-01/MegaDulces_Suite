'use strict';
/**
 * [IC.3] analytics.v_sku_count_variance_history — qué SKUs descuadran SIEMPRE.
 *
 * La señal más preventiva del conjunto: contar seguido lo que siempre falla. Alimenta la 4ª
 * componente del score del top (IC.4, decisión D2 de Edgar) y la bandeja de Prevención.
 *
 * ── ⛔ LO QUE ESTA VISTA TIENE QUE DECLARAR, O MIENTE ───────────────────────────────────
 *
 * La profundidad histórica es MUY desigual. Medido (conteos reales, sin cargas iniciales):
 *
 *     02 → 10 eventos      03 → 8      04 → 3      05 → 3
 *     01 →  1 evento       06 → 1      07 → 0      08 → 0
 *
 * "Descuadró 1 de 1 vez" **no es** una tasa del 100%: es una sola observación. Publicar eso
 * junto al 8 de 10 de la `02` como si fueran lo mismo convierte la señal en ruido, y el top
 * terminaría priorizando SKUs de los almacenes con menos historia — exactamente al revés.
 *
 * Por eso `tasa_descuadre` es **NULL cuando hay menos de 2 observaciones**, con el motivo en
 * `tasa_motivo`. No es una limitación a documentar en un `.md` que nadie va a leer: es una
 * columna que obliga al consumidor a decidir qué hace con el hueco (ADR-056).
 *
 * ── Grano y fuente ─────────────────────────────────────────────────────────────────────
 *
 * Una fila por (tenant, almacén, SKU). Deriva de `kepler_ods` sin tabla ni importer:
 *   · el universo = las CAPTURAS (`N-A-45`): cuántas veces ese SKU estuvo en un conteo
 *   · el descuadre = los AJUSTES (`N-A-30`/`N-D-30`)
 *
 * ⚠️ El universo son las capturas y no los ajustes, y la diferencia importa: un SKU que se
 * contó 8 veces y descuadró 1 no se parece a uno que se contó 1 vez y descuadró 1, pero si
 * sólo se miran los ajustes **los dos aparecen como "descuadró una vez"**.
 *
 * ⚠️ Las CARGAS INICIALES quedan fuera del universo y del numerador: una migración de ERP no
 * es un conteo ni un descuadre (FASE_IC §1.4).
 * ⚠️ El join lleva `c1` (almacén) y `c2`/`c3` — ver FASE_IC §1.9.
 */

exports.up = async function up(knex) {
  // `CREATE SCHEMA IF NOT EXISTS` pide el privilegio CREATE sobre la base AUNQUE el schema ya
  // exista — Postgres valida el permiso antes que la condición. Con un rol de aplicación sin
  // ese privilegio, la migración muere en la primera línea por algo que no necesitaba hacer.
  const [{ hay }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AS hay`)).rows;
  if (!hay) await knex.raw('CREATE SCHEMA analytics');

  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL
        AND to_regclass('commercial.warehouses') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  falta kepler_ods.kdm1 o commercial.warehouses — vista omitida');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sku_count_variance_history
      WITH (security_invoker = true) AS
    WITH doc AS (
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha, m.c3 AS nat, m.c4 AS tipo_doc,
             count(l.*)::int AS lineas
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
       WHERE m.c2 = 'N' AND m.c4 IN ('30', '45') AND m.c3 IN ('A', 'D')
       -- ⛔ ANTI-REPLICA: el almacen tiene que PERTENECER a la sucursal. Medido: la
       -- sucursal 03 arrastra 220 cabeceras del almacen 02 (nov-2025 a ene-2026), el mismo
       -- fenomeno que kdil ya documenta. Sin este filtro se atribuyen a 8ESQ documentos que
       -- son de La Piedad. El LIKE conserva los SUB-ALMACENES legitimos (01-006 = Ruta 28).
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
       GROUP BY 1, 2, 3, 4, 5
    ),
    evento AS (
      -- Un evento por (almacen, fecha), clasificado. Las cargas iniciales se marcan para
      -- excluirlas: la entrada replica la captura y no hay faltante.
      SELECT d.sucursal, d.almacen, d.fecha,
             (max(d.lineas) FILTER (WHERE d.tipo_doc='45' AND d.nat='A') IS NOT NULL
              AND max(d.lineas) FILTER (WHERE d.tipo_doc='30' AND d.nat='A') IS NOT NULL
              AND abs(max(d.lineas) FILTER (WHERE d.tipo_doc='45' AND d.nat='A')
                    - max(d.lineas) FILTER (WHERE d.tipo_doc='30' AND d.nat='A')) <= 1
              AND coalesce(max(d.lineas) FILTER (WHERE d.tipo_doc='30' AND d.nat='D'), 0) = 0
             ) AS es_carga
        FROM doc d GROUP BY 1, 2, 3
    ),
    contado AS (
      -- EL UNIVERSO: cada vez que el SKU estuvo en una captura de un conteo real.
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha, btrim(l.c8) AS sku
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
        JOIN evento e
          ON e.sucursal = m.sucursal AND e.almacen = m.c1 AND e.fecha = m.c9::date
       WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45' AND NOT e.es_carga
       -- ⛔ ANTI-REPLICA: el almacen tiene que PERTENECER a la sucursal. Medido: la
       -- sucursal 03 arrastra 220 cabeceras del almacen 02 (nov-2025 a ene-2026), el mismo
       -- fenomeno que kdil ya documenta. Sin este filtro se atribuyen a 8ESQ documentos que
       -- son de La Piedad. El LIKE conserva los SUB-ALMACENES legitimos (01-006 = Ruta 28).
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
         AND btrim(l.c8) <> ALL (ARRAY['00001', '00002', '00022'])
       GROUP BY 1, 2, 3, 4
    ),
    descuadre AS (
      -- ⚠️ DUPLICA la lógica de v_erp_physical_count_variance, y es a propósito: MEDIDO,
      -- leer el descuadre a través de esa vista hace que esta consulta pase de ~944 ms a
      -- MÁS DE 90 SEGUNDOS (timeout). El costo es el anidamiento, no el volumen — las
      -- piezas sueltas corren en 126/158/16 ms.
      -- La duplicación es deuda, así que NO queda suelta: el smoke
      -- test-newdb-sku-variance-history.js compara las dos vistas y se pone ROJO si
      -- divergen. Deuda vigilada, no deuda silenciosa.
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha, btrim(l.c8) AS sku,
             sum(CASE WHEN m.c3 = 'A' THEN l.c13::numeric ELSE 0 END) AS sobrante,
             sum(CASE WHEN m.c3 = 'D' THEN l.c13::numeric ELSE 0 END) AS faltante
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
        JOIN evento e
          ON e.sucursal = m.sucursal AND e.almacen = m.c1 AND e.fecha = m.c9::date
       WHERE m.c2 = 'N' AND m.c4 = '30' AND m.c3 IN ('A', 'D') AND NOT e.es_carga
       -- ⛔ ANTI-REPLICA: el almacen tiene que PERTENECER a la sucursal. Medido: la
       -- sucursal 03 arrastra 220 cabeceras del almacen 02 (nov-2025 a ene-2026), el mismo
       -- fenomeno que kdil ya documenta. Sin este filtro se atribuyen a 8ESQ documentos que
       -- son de La Piedad. El LIKE conserva los SUB-ALMACENES legitimos (01-006 = Ruta 28).
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
         AND btrim(l.c8) <> ALL (ARRAY['00001', '00002', '00022'])
       GROUP BY 1, 2, 3, 4
    )
    SELECT w.tenant_id,
           w.id                                  AS warehouse_id,
           w.code                                AS warehouse_code,
           c.sucursal                            AS kepler_sucursal,
           pr.id                                 AS product_id,
           c.sku,
           count(*)::int                         AS veces_contado,
           count(d.sku)::int                     AS veces_descuadro,
           count(*) FILTER (WHERE d.sobrante > 0)::int AS veces_sobrante,
           count(*) FILTER (WHERE d.faltante > 0)::int AS veces_faltante,
           -- ⛔ NULL con MENOS DE 2 observaciones: "1 de 1" no es una tasa del 100%.
           CASE WHEN count(*) >= 2
                THEN round(count(d.sku)::numeric / count(*)::numeric, 4)
           END                                   AS tasa_descuadre,
           CASE WHEN count(*) >= 2 THEN 'medida'
                ELSE 'sin_base_historica' END    AS tasa_motivo,
           round(coalesce(sum(d.sobrante), 0) + coalesce(sum(d.faltante), 0), 2) AS pesos_abs,
           round(coalesce(sum(d.sobrante), 0) - coalesce(sum(d.faltante), 0), 2) AS pesos_neto,
           max(c.fecha)                          AS ultimo_conteo,
           max(d.fecha)                          AS ultimo_descuadre
      FROM contado c
      JOIN commercial.warehouses w
        ON w.kepler_code = c.sucursal AND w.kepler_code <> '00' AND w.deleted_at IS NULL
      LEFT JOIN descuadre d
        ON d.sucursal = c.sucursal AND d.almacen = c.almacen
       AND d.fecha = c.fecha AND d.sku = c.sku
      LEFT JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id AND pr.sku = c.sku AND pr.deleted_at IS NULL
     GROUP BY w.tenant_id, w.id, w.code, c.sucursal, pr.id, c.sku
  `);

  await knex.raw('GRANT SELECT ON analytics.v_sku_count_variance_history TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_sku_count_variance_history IS
    'IC.3 - Historial de descuadre por (almacen, SKU) derivado de kepler_ods. El UNIVERSO son las CAPTURAS (cuantas veces el SKU estuvo en un conteo), no los ajustes: mirar solo los ajustes hace que "contado 8 veces, descuadro 1" y "contado 1 vez, descuadro 1" se vean iguales. tasa_descuadre es NULL con menos de 2 observaciones y el motivo va en tasa_motivo: la profundidad historica es MUY desigual (02 tiene 10 conteos, 01 y 06 tienen 1, 07 y 08 ninguno) y publicar 1-de-1 como 100%% haria que el top priorice los almacenes con menos historia, al reves de lo que se busca. Excluye cargas iniciales y pseudo-SKUs contables.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_sku_count_variance_history');
};
