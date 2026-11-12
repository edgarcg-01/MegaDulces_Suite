/* eslint-disable no-console */
/**
 * `is_promo` — la marca de clave promo/regalo de Kepler ($0.01/$0.05, no venta real) en
 * `catalog.products.is_promo`.
 *
 * ⛔ RETIRADO del carril `prices` 2026-11-12 `[CANON.6.9]`. La marca la mantiene el hop-2 de la ingesta
 * AL LLEGAR el cambio de `kdii` (precio, nombre) o `kdik` (costo): `normalizePromo` en
 * `services/feeds-ingest/ods-derived.js`. Los dos nocturnos que todavía escriben costo o nombre
 * (`repoint-catalog-cost`, `repoint-catalog-names`) la recalculan al terminar.
 *
 * Antes este script corría cada 30 min con TRES pases que se peleaban dentro de la misma transacción: el
 * pase 1 (precio, en los dos sentidos) apagaba 4–13 productos y el pase 2 (costo) los volvía a encender
 * — 1,013 de 1,443 corridas del mes fueron «13 + 13». La regla única da exactamente el mismo estado
 * (medido el 12-nov: 0 diferencias en 14,946 filas).
 *
 * Queda como herramienta MANUAL, con la MISMA regla (la importa, no la copia):
 *   node database/importers/kepler/repoint-catalog-prices.js           # sólo lectura: cuántos difieren
 *                                                                       # (debe dar 0 con el hop-2 sano)
 *   node database/importers/kepler/repoint-catalog-prices.js --apply   # recalcula el catálogo completo
 *
 * Lo que se quitó, y por qué:
 *   · `--escribir-precio` — escribía `kdii.c90` (lo que Kepler CONFIGURA) en BASE-MXN. Desde `[VPR.3]`
 *     (2026-10-05, Edgar: «todo se debe tomar desde la misma fuente») el precio es lo que el punto de venta
 *     COBRA y lo escribe `normalizeSalePrice`; este modo sólo podía deshacer sus rechazos.
 *   · `--source=kp` — leer `KP_CONCENTRADA` en el `.245`, que ya no se usa. La fuente es `kepler_ods`.
 */
const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { normalizePromo, promoSql } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
if (process.argv.includes('--escribir-precio')) {
  console.error('⛔ --escribir-precio se retiró (`[CANON.6.9]`): el precio de venta lo escribe normalizeSalePrice (VPR.3).');
  process.exit(1);
}

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  // [VP.3.2] Quien escribe, declarado: el trigger de analytics.master_data_history lo lee
  // solo. Nunca lanza — el actor es metadata, un feed no se cae por no poder firmar.
  await declararActor(db, 'repoint-catalog-prices');
  try {
    console.log(`\n=== is_promo desde kepler_ods (${APPLY ? 'APPLY' : 'SÓLO LECTURA'}) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const { rows: [c] } = await db.query(
      `SELECT count(*)::int AS filas, count(*) FILTER (WHERE promo IS DISTINCT FROM antes)::int AS difieren,
              count(*) FILTER (WHERE promo)::int AS en_promo
         FROM (${promoSql(false)}) f`, [M]);
    await db.query('ROLLBACK');
    console.log(`  filas: ${c.filas} · en promo según la regla: ${c.en_promo} · difieren de lo guardado: ${c.difieren}`);

    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const n = await normalizePromo(db, M, null);
    console.log(`\n[APPLY] COMMIT — is_promo: ${n} productos cambiaron de marca.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
