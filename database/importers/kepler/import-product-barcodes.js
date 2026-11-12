/* eslint-disable no-console */
/**
 * Códigos de barras por UNIDAD (`catalog.product_barcodes`) desde `kepler_ods.kdii`.
 *
 * ⛔ RETIRADO del carril `prices` (cada 30 min) 2026-11-12 `[CANON.6.14]`. Lo mantiene el hop-2 de la ingesta
 * (`normalizeBarcodesFromOds`, al llegar un cambio de `kdii` — y desde CANON.6.14 también al BORRARSE una fila de
 * `kdii`, que era el único hueco que este reconciliador tapaba de Kepler: 4 de sus 5 bajas en dos semanas eran SKUs
 * que ya no existen en `kdii`).
 *
 * Lo medido antes de retirarlo (prod, sólo lectura, 12-nov): de ~190 cambios por día a 0–4 desde el 30-oct, y
 * esos pocos eran casi todos su parte de WINCAJA. `wincaja.articulos` está CONGELADA (última importación el
 * 29-sep; la mayoría de las sucursales, julio): de ahí ya no sale nada nuevo — lo único que hacía era REVIVIR,
 * como `source=wincaja` y unidad `CJA` (su unidad de compra), códigos que Kepler acababa de retirar (102 vivos
 * así; en 47 Kepler los había reemplazado por otro código real). Por eso la parte Wincaja se QUITA: las 1,609
 * filas Wincaja que ya están se quedan como están (su limpieza es decisión aparte).
 *
 * Queda como herramienta MANUAL, Kepler y nada más, con la MISMA función del hop-2 (la importa, no la copia):
 *   node database/importers/kepler/import-product-barcodes.js           # sólo lectura: qué cambiaría
 *   node database/importers/kepler/import-product-barcodes.js --apply   # todo el catálogo
 */
const { Client } = require('pg');
const { computeBarcodes } = require('../../../services/feeds-ingest/barcode-compute');
const { normalizeBarcodesFromOds } = require('../../../services/feeds-ingest/apply-handlers');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 300000 });
  await c.connect();
  try {
    console.log(`=== códigos de barras Kepler (${APPLY ? 'APPLY' : 'SÓLO LECTURA'}) ===`);
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
    const kepler = await computeBarcodes(c, { schema: 'kepler_ods' });
    const vivos = (await c.query(`SELECT btrim(b.sku) sku, b.barcode, b.unit, b.factor::float8 factor, b.source, b.is_primary
        FROM catalog.product_barcodes b WHERE b.tenant_id=$1 AND b.deleted_at IS NULL`, [TENANT])).rows;
    const conProducto = new Set((await c.query(`SELECT btrim(sku) s FROM catalog.products WHERE tenant_id=$1 AND deleted_at IS NULL AND sku IS NOT NULL`, [TENANT])).rows.map((r) => r.s));
    await c.query('ROLLBACK');
    const k = (r) => `${r.sku}\u0000${r.barcode}`;
    const hoy = new Map(vivos.map((r) => [k(r), r]));
    const debe = new Map(kepler.filter((r) => conProducto.has(r.sku)).map((r) => [k(r), r]));
    let alta = 0, cambia = 0, baja = 0;
    for (const [key, r] of debe) {
      const v = hoy.get(key);
      if (!v) alta++;
      else if (v.source !== r.source || v.unit !== r.unit || v.is_primary !== r.is_primary || (v.factor == null ? null : Number(v.factor)) !== (r.factor == null ? null : Number(r.factor))) cambia++;
    }
    for (const v of vivos) if (String(v.source).startsWith('kepler_') && !debe.has(k(v))) baja++;
    console.log(`  Kepler: ${kepler.length} códigos · faltan ${alta} · distintos ${cambia} · de baja ${baja}`);
    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    // Todos los SKUs de kdii y los que tienen un código Kepler vivo (los que Kepler ya quitó también se bajan).
    const skus = [...new Set([...kepler.map((r) => r.sku), ...vivos.filter((v) => String(v.source).startsWith('kepler_')).map((v) => v.sku)])];
    const n = await normalizeBarcodesFromOds(c, TENANT, skus);
    console.log(`\n[APPLY] COMMIT — ${n} filas (altas, cambios y bajas) sobre ${skus.length} SKUs.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERR', e.message); process.exitCode = 1;
  } finally { await c.end().catch(() => {}); }
})();
