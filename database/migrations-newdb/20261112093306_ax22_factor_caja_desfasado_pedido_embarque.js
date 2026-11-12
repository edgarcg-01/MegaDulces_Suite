'use strict';
/**
 * `[AX.22]` — Renglón de pedido / embarque de Kepler contra la ficha VIGENTE: ¿se capturó con un
 * factor de caja que ya cambió?
 *
 * Por qué: el renglón de Kepler guarda la presentación capturada (`kdm2.c55`), la cantidad en ella
 * (`c56`), el factor (`c58`) y la cantidad en unidad base (`c9 = c56 × c58`). La factura arrastra
 * `c9` del embarque y la vuelve a presentar con la ficha de HOY. Si la ficha cambió entre la
 * captura y la factura, la factura dice otro número de cajas que el embarque — y regenerarla lo
 * repite, porque `c9` no se mueve.
 *
 * Caso que lo abrió (Canindo, 2026-11-10): pedido 06UD4001-0001608 y embarque 06UD4101-0001823,
 * `95644 CHILITO` = 10 CJA × 40 = 400 PAQ. La ficha de la 06 pasó a CJA = 25 el 29-oct (la compra
 * de ese día ya entró a 25). La factura 06UD0801-0001350 presentó 400 PAQ = 16 cajas; salieron 10.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-12) ────────────────────────────────────────
 *  · Árbitro: la ficha de ESA sucursal (`analytics.kdii_ficha`, la misma regla que la historia de
 *    fichas de PQ.59 y que el factor de almacén de PQ.13: el 98.61 % de las OC reales llevan
 *    exactamente el factor de la ficha).
 *  · Control de calibración: los 4,611 renglones de pedido/embarque capturados hoy y ayer salen
 *    `al_dia` (100 %). Positivo: 95644 del embarque 1823 → `factor_cambio` (40 vs 25). Negativo:
 *    95641 del mismo embarque (15 = 15) → `al_dia`.
 *  · 30 días de embarques (47,298 renglones): `al_dia` 46,883 · `factor_cambio` 26 (en 16
 *    embarques de 01, 06 y 08) · `unidad_base_cambio` 274 · `presentacion_no_en_ficha` 98 ·
 *    `sin_ficha` 16 · `sin_presentacion` 1.
 *  · Por llave constante (sucursal, tipo, serie, folio): 17 ms. 30 días agregados: ~2.6 s.
 *
 * ⚠️ Lo que NO dice: `unidad_base_cambio` (la ficha renombró o cambió la unidad base, p. ej.
 *    PZA→PAQ) puede ser un cambio de rótulo o un cambio real — esta vista no los distingue y no se
 *    afirma ninguno. `captured_qty` es `c56`: en un renglón agregado en surtido/checado (`c51`
 *    vacío) Kepler lo calcula como `c9 ÷ c58` (de ahí 0.57 CJA). La ficha es la de HOY: si cambió
 *    dos veces, sólo se ve la última.
 *
 * Vista derive-no-copy sobre `kepler_ods` (cero tablas, cero importers). Si el entorno no tiene el
 * ODS o la regla de ficha (PQ.59), se omite sin fallar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const VISTA = 'analytics.v_erp_order_line_box_factor';

// Número tolerante: Kepler guarda c56/c58 como texto y a veces vacío.
const num = (col) => `NULLIF(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric`;

const CUERPO = `
  SELECT '${M}'::uuid AS tenant_id,
         x.sucursal, x.doc_type, x.serie, x.folio,
         x.sucursal || 'UD' || x.doc_type::text || lpad(x.serie::text, 2, '0') || '-' || x.folio AS folio_digital,
         x.line_no, x.sku,
         x.captured_unit, x.captured_qty, x.captured_factor, x.base_qty, x.base_unit, x.base_unit_price,
         x.ficha_base_unit, x.ficha_unit_two, x.ficha_factor_two, x.ficha_unit_three, x.ficha_factor_three,
         x.current_factor,
         CASE WHEN x.captured_unit IS NULL OR x.captured_factor IS NULL THEN 'sin_presentacion'
              WHEN x.ficha_base_unit IS NULL THEN 'sin_ficha'
              WHEN x.base_unit IS DISTINCT FROM x.ficha_base_unit THEN 'unidad_base_cambio'
              WHEN x.current_factor IS NULL THEN 'presentacion_no_en_ficha'
              WHEN x.captured_factor <> x.current_factor THEN 'factor_cambio'
              ELSE 'al_dia' END AS status,
         -- Lo que la factura presentará con la ficha de hoy (Canindo: 400 / 25 = 16).
         CASE WHEN x.current_factor > 0 THEN round(x.base_qty / x.current_factor, 4) END AS qty_in_current_unit,
         -- Lo que serían las mismas cajas con la caja de hoy (Canindo: 10 × 25 = 250).
         CASE WHEN x.current_factor > 0 THEN x.captured_qty * x.current_factor END AS base_qty_at_current_factor
    FROM (
      SELECT btrim(l.sucursal) AS sucursal,
             (l.c4)::integer AS doc_type,
             (l.c5)::integer AS serie,
             btrim(l.c6) AS folio,
             (l.c7)::integer AS line_no,
             btrim(l.c8) AS sku,
             NULLIF(upper(btrim(l.c55)), '') AS captured_unit,
             ${num('l.c56')} AS captured_qty,
             ${num('l.c58')} AS captured_factor,
             (l.c9)::numeric AS base_qty,
             NULLIF(upper(btrim(l.c11)), '') AS base_unit,
             -- Precio por unidad base, con IEPS y sin el descuento del cliente (c12; c13 = c9 × c12).
             ${num('l.c12')} AS base_unit_price,
             f.u1 AS ficha_base_unit, f.u2 AS ficha_unit_two, f.f2 AS ficha_factor_two,
             f.u3 AS ficha_unit_three, f.f3 AS ficha_factor_three,
             CASE WHEN f.sku IS NULL THEN NULL
                  WHEN NULLIF(upper(btrim(l.c55)), '') = f.u1 THEN 1::numeric
                  WHEN NULLIF(upper(btrim(l.c55)), '') = f.u2 AND f.f2 > 0 THEN f.f2
                  WHEN NULLIF(upper(btrim(l.c55)), '') = f.u3 AND f.f3 > 0 THEN f.f3 END AS current_factor
        FROM kepler_ods.kdm2 l
        LEFT JOIN kepler_ods.kdii k ON btrim(k.sucursal) = btrim(l.sucursal) AND btrim(k.c1) = btrim(l.c8)
        LEFT JOIN LATERAL analytics.kdii_ficha(k) f ON k.c1 IS NOT NULL
       WHERE l.c2 = 'U' AND l.c3 = 'D' AND (l.c4)::integer IN (40, 41)
         AND btrim(l.c1) = btrim(l.sucursal)
         AND NULLIF(btrim(l.c8), '') IS NOT NULL
    ) x`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdm2') AS kdm2, to_regclass('kepler_ods.kdii') AS kdii,
    to_regprocedure('analytics.kdii_ficha(kepler_ods.kdii)') AS ficha`);
  const h = hay.rows[0];
  if (!h.kdm2 || !h.kdii || !h.ficha) {
    console.log('[AX.22] falta el ODS o analytics.kdii_ficha (PQ.59) — se omite.');
    return;
  }

  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${CUERPO}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[AX.22] Renglón de pedido (U-D-40) / embarque (U-D-41) de Kepler contra la ficha VIGENTE de su sucursal: status factor_cambio = se capturó con un factor de caja que la ficha ya no tiene; la factura presentará qty_in_current_unit. unidad_base_cambio no distingue rótulo de cambio real.'`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    GRANT SELECT ON ${VISTA} TO dev_ro; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
