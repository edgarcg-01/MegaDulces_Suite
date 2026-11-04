'use strict';
/**
 * `[FCT.0.1]` — El viaje de entrega de Telemarketing, derivado de Kepler: una fila por PARADA
 * (embarque `U-D-41` serie 1) con su guía `c86`, que es EL VIAJE. Es el lado «venta» de la hoja
 * «RENTABILIDAD TLMKT 2026 – desgloce de gastos por ruta» (Edgar, 2026-11-04): con ella la hoja
 * deja de ser la única fuente de qué viaje salió, a dónde y con cuánta venta.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, sid 7688376744939610156, 2026-11-04) ─────────────
 *  · La hoja es por viaje y su VENTA es la Σ de los embarques TM de UNA guía: de los 78 viajes de
 *    la hoja dentro de la cobertura del ODS (Hidalgo ≥ 27-jun, Morelia Abastos ≥ 19-sep), 55 casan
 *    con exactamente una guía a ±$10 (diferencia media $2.02) y SIEMPRE un día después del
 *    embarque (la hoja anota la entrega). Control negativo: con la venta +3 %, 0 casan.
 *  · Dos implementaciones: esta lectura directa de `kdm1` contra `analytics.erp_shipment_headers`
 *    (serie 1, jun–nov): 556 de 556 guías iguales en paradas y total, al centavo.
 *  · Costo: 28 ms un mes, 71 ms cuatro meses (todas las sucursales) — usa `ix_kdm1_venta_fecha`.
 *    Por eso es una vista por PARADA y no por viaje: agrupada por guía, el filtro de fecha ya no
 *    bajaría al índice. El servicio agrupa.
 *  · ⚠️ Kepler NO sirve para la unidad ni el chofer de estos viajes: en 56 viajes que casan, la
 *    unidad de la guía contradice a la hoja en la mayoría («MOTOCICLETA» o «FORD 450» donde la hoja
 *    dice Nissan) y el chofer viene vacío en ~80 %. Por eso las claves crudas `c83/c84` se publican
 *    con sufijo `_kepler` y SIN resolver a un vehículo: el km por GPS colgado de esa unidad sería
 *    falso. La unidad, el chofer y los km salen del cierre del viaje (EMB), no de aquí.
 *  · El universo es mayor que la hoja: octubre trae 206 guías TM (Hidalgo 73, Morelia Abastos 87,
 *    Canindo 46) y la hoja 21. La serie 1 también lleva vecinal, piso y e-commerce: la vista no
 *    filtra vendedor — eso lo decide quien la lee, con el vendedor a la vista.
 *
 * ⛔ derive-no-copy sobre `kepler_ods.kdm1`; sin tabla, sin importer. No hay JOIN a tablas con RLS
 *    (el costo del viaje se cruza en el servicio, bajo RLS, no en una vista del dueño).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
CREATE OR REPLACE VIEW analytics.v_tlmk_trip_stops AS
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
        btrim(h.c1) AS sucursal,
        NULLIF(NULLIF(btrim(h.c86), ''), '0000000') AS guia,
        (btrim(h.c1) || '-G') || NULLIF(NULLIF(btrim(h.c86), ''), '0000000') AS guia_digital,
        btrim(h.c6) AS embarque_folio,
        (btrim(h.c1) || 'UD4101-') || btrim(h.c6) AS embarque_folio_digital,
        h.c9::date AS fecha,
        NULLIF(btrim(h.c10), '') AS cliente_code,
        NULLIF(btrim(h.c32), '') AS destino_nombre,
        NULLIF(btrim(h.c34), '') AS destino_ciudad,
        NULLIF(btrim(h.c12), '') AS vendedor_code,
        COALESCE(vi.canonical_name, NULLIF(btrim(h.c12), '')) AS vendedor_nombre,
        NULLIF(btrim(h.c83), '') AS transporte_code_kepler,
        NULLIF(btrim(h.c84), '') AS chofer_code_kepler,
        round(COALESCE(NULLIF(regexp_replace(h.c16::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2) AS total
   FROM kepler_ods.kdm1 h
   LEFT JOIN analytics.vendor_identity vi
          ON vi.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
         AND vi.source_branch = btrim(h.c1)
         AND vi.vendedor = btrim(h.c12)
  WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer = 41 AND h.c5::integer = 1
    AND btrim(h.c1) = btrim(h.sucursal)`;

const COMENTARIOS = [
  `COMMENT ON VIEW analytics.v_tlmk_trip_stops IS
   '[FCT.0.1] Paradas de los viajes de entrega Telemarketing: embarque U-D-41 serie 1 de kdm1, una fila por embarque; guia (c86) = el viaje. total = c16 del embarque (lo que la hoja RENTABILIDAD TLMKT llama venta del viaje). Filtrar SIEMPRE por fecha (indice ix_kdm1_venta_fecha) y agrupar en el servicio. transporte/chofer de Kepler NO son confiables en TM (medido 2026-11-04): no resolver vehiculo ni km con ellos.'`,
  `COMMENT ON COLUMN analytics.v_tlmk_trip_stops.fecha IS
   'Fecha del embarque (c9). La entrega es, medido, el dia siguiente en 55 de 55 viajes cotejados.'`,
];

/** Que la vista exista no prueba que lea: la sonda la ejerce con el filtro con el que se usa. */
const SONDA = `
  SELECT sucursal, guia, count(*)::int AS paradas, sum(total) AS venta
    FROM analytics.v_tlmk_trip_stops
   WHERE fecha >= current_date - 7 AND guia IS NOT NULL
   GROUP BY 1, 2 LIMIT 5`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // `kepler_ods.*` lo crea la ingesta, no una migración: en una base sin moldes la vista no
  // compila. Se omite CON aviso; el siguiente run la crea.
  const [{ ods }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL
        AND to_regclass('analytics.vendor_identity') IS NOT NULL) AS ods`)).rows;
  if (!ods) {
    // eslint-disable-next-line no-console
    console.log('  ⚠ [FCT.0.1] falta kepler_ods.kdm1 o analytics.vendor_identity — vista omitida');
    return;
  }
  await knex.raw(VISTA);
  for (const c of COMENTARIOS) await knex.raw(c);
  await knex.raw('GRANT SELECT ON analytics.v_tlmk_trip_stops TO app_runtime');
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
      GRANT SELECT ON analytics.v_tlmk_trip_stops TO dev_ro;
    END IF; END $$`);
  await knex.raw(SONDA);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_tlmk_trip_stops');
};

exports.SQL = { VISTA, SONDA };
