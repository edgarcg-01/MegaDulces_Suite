'use strict';
/**
 * `[IC.26]` — **Traspasos en camino: la entrada que Existencia negativa no veía.**
 *
 * Pedido de Edgar (2026-11-10), a partir del 83816 (CHIDAS LOCO MIX) en Padre Hidalgo: estuvo en
 * negativo del 6 al 9-nov y en `/almacen/incidencias` habría salido como «Salió sin existencia
 * registrada». No era eso: CEDIS le traspasó 150 pz el 6-nov (UD4102-0001457), la tienda ya las
 * vendía y mandó 30 a Yurécuaro, pero la RECEPCIÓN (UA5001-0000625) se capturó hasta el 9-nov.
 * La causa `entrada_sin_aplicar` sólo conocía los vales de compra (`v_kepler_unapplied_receipts`);
 * un traspaso enviado y sin recibir era invisible.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-11) ────────────────────────────────────────
 *  · 5,144 embarques entre sucursales (U-D-41) en 60 días; 376 sin recepción (U-A-50) que los apunte.
 *  · De 3,133 negativos de hoy, **47 tienen un traspaso en camino** hacia su sucursal y 45 quedarían
 *    en 0 o más al capturarlo. Por vale de compra hoy sólo se explican 21.
 *  · Testigos de la llave (ver abajo): las 2,391 recepciones de 75 días resuelven su origen por
 *    `kdm1.c10`, y 2,389 casan con un embarque real de ese origen a esa sucursal.
 *  · Dos implementaciones dieron los MISMOS 376 embarques pendientes: la de `[DM.20]` (destino
 *    declarado + ventana de fechas −15/+90) y esta (llave exacta). Esta tarda ~185 ms la vista entera;
 *    la otra ~860 ms, porque el planeador estima 1–12 filas donde hay miles y anida ciclos.
 *
 * ── La llave: origen, destino, serie y folio — los cuatro los declara Kepler ───────────────
 *  · Embarque (`kdm1`, U-D-41): `c10` = código del DESTINO → `analytics.transfer_dest_map`.
 *  · Recepción (`kdm1`, U-A-50): `c37/c38/c39` = grupo/serie/folio del embarque que recibe (`c37='41'`)
 *    y `c10` = código del ORIGEN. Verificado con el caso: la recepción 0000625 de Padre Hidalgo trae
 *    `41/2/0001457` y `c10 = TI000` (CEDIS); el embarque 0001457 de CEDIS trae `c10 = TI001`
 *    (Padre Hidalgo).
 *  · El folio es secuencia POR SUCURSAL: sin el origen en la llave, un embarque de Morelia Abastos
 *    con el mismo folio y serie que uno de CEDIS se daría por recibido con la recepción ajena.
 *  · `NOT IN` contra una CTE materializada se resuelve con una tabla hash: estable aunque el
 *    planeador estime mal (por eso no `NOT EXISTS`, que con 1 fila estimada anida 2,449 × 1,411).
 *
 * ── Qué NO afirma ──────────────────────────────────────────────────────────────────────────
 *  · Que la mercancía ya llegó: dice que salió hacia esa sucursal y que ahí no hay recepción. Cuando
 *    la sucursal además está en negativo, es la explicación que el dato prueba.
 *  · Ventana de 60 días de embarques (la misma de los vales). Más viejo no entra: un embarque de
 *    hace 4 meses sin recepción es otro problema (traspaso perdido), y lo mira el Diario de MX.
 *  · Las piezas son `kdm2.c9`, la unidad base de Kepler (la misma de `kdil`): el kardex suma `c9` y
 *    cuadra con Kepler en 286 de 300 negativos (`[MX.2.9]`).
 *
 * Idempotente (CREATE OR REPLACE). Sólo lectura sobre `kepler_ods`; ninguna tabla nueva.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
CREATE OR REPLACE VIEW analytics.v_kepler_transfers_in_transit AS
WITH dmap AS MATERIALIZED (
  SELECT dm.tenant_id, dm.dest_code, dw.id AS wh_id, dw.kepler_code AS suc
    FROM analytics.transfer_dest_map dm
    JOIN commercial.warehouses dw ON dw.id = dm.warehouse_id AND dw.deleted_at IS NULL AND dw.kepler_code IS NOT NULL
), env AS MATERIALIZED (
  -- embarques a otra sucursal: el destino lo declara el documento (c10)
  SELECT d.tenant_id, btrim(h.sucursal) AS origen, d.suc AS destino, d.wh_id AS dest_wh,
         coalesce(nullif(h.c5::text, ''), '') AS serie, h.c6 AS folio, h.c9::date AS fecha
    FROM kepler_ods.kdm1 h
    JOIN dmap d ON d.dest_code = btrim(h.c10)
   WHERE h.c1 = h.sucursal AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
     AND h.c9 >= current_date - 60 AND d.suc <> btrim(h.sucursal)
), rec AS MATERIALIZED (
  -- recepciones: apuntan a su embarque (c37/c38/c39) y declaran su origen (c10)
  SELECT d.suc AS origen, btrim(h.sucursal) AS destino, coalesce(nullif(h.c38::text, ''), '') AS serie, h.c39 AS folio
    FROM kepler_ods.kdm1 h
    JOIN dmap d ON d.dest_code = btrim(h.c10)
   WHERE h.c1 = h.sucursal AND h.c2 = 'U' AND h.c3 = 'A' AND h.c4 = 50 AND h.c37::text = '41'
     AND h.c9 >= current_date - 75 AND h.c39 IS NOT NULL
), pend AS MATERIALIZED (
  SELECT e.* FROM env e
   WHERE (e.origen, e.destino, e.serie, e.folio) NOT IN (SELECT origen, destino, serie, folio FROM rec)
), onom AS MATERIALIZED (
  -- el NOMBRE de la sucursal que envía (nunca el código)
  SELECT DISTINCT ON (tenant_id, kepler_code) tenant_id, kepler_code, coalesce(name, code) AS nombre
    FROM commercial.warehouses WHERE deleted_at IS NULL AND kepler_code IS NOT NULL
   ORDER BY tenant_id, kepler_code, (code = kepler_code) DESC, name
)
SELECT p.tenant_id, p.dest_wh AS warehouse_id, p.destino AS kepler_code, btrim(l.c8) AS sku,
       sum(l.c9)::numeric AS piezas, min(p.fecha) AS desde,
       string_agg(DISTINCT p.folio, ',' ORDER BY p.folio) AS folios,
       string_agg(DISTINCT coalesce(o.nombre, p.origen), ', ') AS origenes
  FROM pend p
  JOIN kepler_ods.kdm2 l ON l.sucursal = p.origen AND l.c1 = p.origen AND l.c2 = 'U' AND l.c3 = 'D' AND l.c4 = 41
                        AND l.c6 = p.folio AND coalesce(nullif(l.c5::text, ''), '') = p.serie
  LEFT JOIN onom o ON o.tenant_id = p.tenant_id AND o.kepler_code = p.origen
 WHERE coalesce(btrim(l.c11), '') <> 'SER'
 GROUP BY p.tenant_id, p.dest_wh, p.destino, btrim(l.c8)`;

const COMENTARIO = `
COMMENT ON VIEW analytics.v_kepler_transfers_in_transit IS
'[IC.26] Por sucursal destino y SKU: piezas de traspasos (U-D-41, 60 d) enviados hacia ella cuya recepción (U-A-50) no existe en Kepler. Llave origen+destino+serie+folio. Lo lee Existencia negativa para explicar el negativo.'`;

/** La sonda pide TODAS las columnas: un count(*) pelado no compila la proyección. */
const SONDA = `
SELECT tenant_id, warehouse_id, kepler_code, sku, piezas, desde, folios, origenes
  FROM analytics.v_kepler_transfers_in_transit LIMIT 5`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // `kepler_ods.*` lo crea la ingesta, no una migración: sin moldes la vista no compila. Se omite
  // CON aviso; el siguiente run la crea. El servicio la busca con to_regclass y, si falta, DECLARA
  // que no revisó traspasos (no los da por cero).
  const [{ ods }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL AND to_regclass('kepler_ods.kdm2') IS NOT NULL
            AND to_regclass('analytics.transfer_dest_map') IS NOT NULL) AS ods`)).rows;
  if (!ods) {
    // eslint-disable-next-line no-console
    console.log('  ⚠ [IC.26] falta kepler_ods.kdm1/kdm2 o analytics.transfer_dest_map — vista omitida');
    return;
  }
  await knex.raw(VISTA);
  await knex.raw(COMENTARIO);
  await knex.raw('GRANT SELECT ON analytics.v_kepler_transfers_in_transit TO app_runtime');
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
      GRANT SELECT ON analytics.v_kepler_transfers_in_transit TO dev_ro;
    END IF; END $$`);
  await knex.raw(SONDA);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_transfers_in_transit');
};

exports.SQL = { VISTA, SONDA };
