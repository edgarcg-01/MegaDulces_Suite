'use strict';
/**
 * `[RE.ETQ.0.2]` — **Los renglones de orden de entrada que llevan etiqueta de caja**, derivados del ODS
 * (`derive-no-copy`, ADR-056): `analytics.v_box_label_lines`. Una fila por renglón de `X-A-40` en
 * unidad de empaque (CJA · BTO · CUB), con lo que la etiqueta imprime y lo que la pantalla avisa.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_ETQ_GR_ETIQUETAS_GRANEL.md` §4–§5.
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-19) ──
 *  · La forma vigente de Kepler (`MD_OE.rep_etiq`) imprime los renglones en `BTO`, `CUB` y `CJA`,
 *    `qx` etiquetas por renglón con `qx = kdm2.c56` y `UXC = kdm2.c58` (`fac`). `c56 = c9 / c58` en
 *    **4,805 de 4,805** renglones de 30 días: la cantidad en cajas es la de Kepler, no se recalcula.
 *  · `c9` está en la unidad BASE del renglón (`c11`: PZA, PAQ, KG…), no siempre en piezas: el 70106
 *    trae 360 PZA / 18 = 20 cajas, y 2,268 renglones en CJA traen la base en PAQ.
 *  · UXC sale del renglón y NO del catálogo: el catálogo trae `kdii.c84` = 0 en el 39 % de los
 *    renglones en caja (`[RE.ETQ]` §2.3).
 *  · `kdii.c83` (la «caja» del producto en Kepler) está VACÍA en 1,501 renglones en CJA de 30 días y
 *    es otra unidad en ~47: el código `C`+clave (D5) se imprime igual y la vista lo marca.
 *  · Llaves: `kdm1` (sucursal,c1..c6) y `kdm2` (…,c7) — el join va por las 7 columnas del
 *    encabezado (lección R.5: por menos casa el documento equivocado). Anti-réplica `c1 = sucursal`
 *    (1,055 de 1,055 órdenes de oct-nov lo cumplen). Canceladas: `c43 = 'C'` (37 órdenes).
 *  · Índice que usa el filtro de fecha: `ix_kdm1_captura ((c68)::date)` → la columna se expone tal
 *    cual (`capturada_el = c68::date`) para que el `WHERE` de quien consulta lo alcance.
 *
 * ── Columnas que NO se imprimen ─────────────────────────────────────────────────────────────
 *  `fecha_documento`, `capturada_el` y `vale_capturado_el` NO van en la etiqueta (D6: la etiqueta
 *  lleva el día en que se imprime, porque el vale o la orden pueden quedar pendientes). Van a la cola
 *  y a la bitácora, para medir el atraso llegada → etiqueta.
 *
 * Sin tablas, sin filas, sin índices. Idempotente (`CREATE OR REPLACE VIEW`).
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

/** Texto → numérico sin reventar por basura del ERP (mismo criterio que las vistas `erp_*`). */
const NUM = (x) => `nullif(regexp_replace((${x})::text, '[^0-9.-]', '', 'g'), '')::numeric`;

/**
 * El cuerpo de la vista. Se exporta para que la verificación contra prod corra EXACTAMENTE este texto
 * (`database/scripts/re-etq-v-box-label-lines-prod.js`).
 */
const SELECT_SQL = `
SELECT
  '${M}'::uuid                                              AS tenant_id,
  m.sucursal                                                AS sucursal,
  NULLIF(btrim(s.c2), '')                                   AS sucursal_nombre,
  m.c5::int                                                 AS serie,
  btrim(m.c6)                                               AS folio,
  l.c7::int                                                 AS linea,
  m.c9::date                                                AS fecha_documento,
  m.c68::date                                               AS capturada_el,
  CASE WHEN btrim(coalesce(m.c69, '')) ~ '^[0-9]{1,2}:[0-9]{2}'
       THEN substr(btrim(m.c69), 1, 5) END                  AS capturada_hora,
  btrim(coalesce(m.c43, ''))                                AS estado_kepler,
  CASE WHEN m.c37 = 37 THEN NULLIF(btrim(m.c39), '') END    AS vale_folio,
  v.vale_capturado_el                                       AS vale_capturado_el,
  btrim(l.c8)                                               AS sku,
  coalesce(NULLIF(btrim(i.c2), ''), NULLIF(btrim(l.c10), '')) AS nombre,
  upper(btrim(l.c55))                                       AS unidad,
  upper(NULLIF(btrim(l.c11), ''))                           AS unidad_base,
  ${NUM('l.c58')}                                           AS uxc,
  round(l.c9::numeric, 4)                                   AS cantidad_base,
  ${NUM('l.c56')}                                           AS cajas,
  floor(${NUM('l.c56')})::int                               AS cajas_completas,
  round(l.c9::numeric - floor(${NUM('l.c56')}) * ${NUM('l.c58')}, 4) AS piezas_sueltas,
  'C' || btrim(l.c8)                                        AS codigo,
  upper(NULLIF(btrim(i.c83), ''))                           AS kepler_unidad_caja,
  i.c84                                                     AS kepler_factor_caja,
  NULLIF(btrim(i.c85), '')                                  AS kepler_codigo_caja,
  (i.c1 IS NULL)                                            AS sin_catalogo
FROM kepler_ods.kdm1 m
JOIN kepler_ods.kdm2 l
  ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
 AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
LEFT JOIN kepler_ods.kdii i ON i.sucursal = l.sucursal AND i.c1 = l.c8
LEFT JOIN kepler_ods.kdms s ON s.sucursal = m.sucursal AND btrim(s.c1) = m.sucursal
LEFT JOIN LATERAL (
  SELECT min(x.c68)::date AS vale_capturado_el
    FROM kepler_ods.kdm1 x
   WHERE x.sucursal = m.sucursal AND x.c2 = 'X' AND x.c3 = 'A'
     AND btrim(x.c4::text) = '37' AND btrim(x.c6) = btrim(m.c39) AND btrim(x.c1) = m.sucursal
) v ON m.c37 = 37
WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 40
  AND btrim(m.c1) = m.sucursal
  AND btrim(coalesce(m.c43, '')) <> 'C'
  AND upper(btrim(l.c55)) IN ('CJA', 'BTO', 'CUB')`;

exports.SELECT_SQL = SELECT_SQL;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_box_label_lines AS ${SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW analytics.v_box_label_lines IS
    '[RE.ETQ.0.2] Renglones de orden de entrada X-A-40 en unidad de empaque (CJA/BTO/CUB) que llevan etiqueta de caja. derive-no-copy sobre kdm1/kdm2/kdii/kdms. UXC = kdm2.c58 y cajas = kdm2.c56 (como Kepler); codigo = C+clave (D5). Las fechas NO se imprimen (D6): son para la cola y la bitacora.'`);
  await knex.raw(`GRANT SELECT ON analytics.v_box_label_lines TO app_runtime`);
  const n = (await knex.raw(`SELECT count(*)::int AS n FROM analytics.v_box_label_lines WHERE capturada_el >= current_date - 7`)).rows[0].n;
  console.log(`  ✓ [RE.ETQ.0.2] analytics.v_box_label_lines creada · ${n} renglones con etiqueta en los últimos 7 días`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista es nueva y nada depende de ella. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_box_label_lines`);
};
