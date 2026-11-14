/* eslint-disable no-console */
/**
 * RA-PRO.39 — Precio de LISTA de la CAJA (CJA) por producto → analytics.product_box_price.
 * Fuente kdpv_prod_util: precio de la presentación 'CJA' en el umbral de menor volumen (por moda entre plazas,
 * `[CANON.6.20]`); respaldo PAQ×factor_sale. Base de `cajas = revenue / cja_price` del sell-out.
 *
 * ⛔ RETIRADO del nocturno el 2026-11-14 [CANON.6.20]. HERRAMIENTA MANUAL. Lo de cada día lo hace el hop-2
 * `normalizeBoxPrice` (services/feeds-ingest/ods-derived.js) al llegar `kdpv_prod_util` y, desde CANON.6.20, también al
 * llegar `kdii` (alta, reactivación o `factor_sale` nuevo): la MISMA computación (`boxPriceSql`). Medido antes de
 * retirarlo: sus «37–77 correcciones por noche» no eran huecos, eran la regla sin desempate (el acotado y el completo
 * elegían distinto precio entre plazas empatadas); con la moda, el acotado y el completo dan lo mismo. Lo vigila el
 * árbitro `caja_precio_evento` de db-health.
 *
 *   node database/importers/kepler/import-box-price.js            # mide, en sólo lectura: cuántos cambiarían (debe dar 0)
 *   node database/importers/kepler/import-box-price.js --apply    # recalcula el catálogo entero con la regla del hop-2
 */
const { Client } = require('pg');
const { normalizeBoxPrice, boxPriceSql } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== PRECIO CAJA (kdpv CJA) → analytics.product_box_price (${APPLY ? 'APPLY' : 'EN SECO'}) — la regla del hop-2 (boxPriceSql) ===`);
    if (!APPLY) {
      // `[CANON.6.20]` Medición real (antes el dry-run no medía nada): la regla contra la tabla, en sólo lectura.
      await db.query('BEGIN READ ONLY');
      await db.query(`SET LOCAL app.tenant_id = '${M}'`);
      const regla = new Map((await db.query(boxPriceSql(false), [M])).rows.map((r) => [r.product_id, r]));
      const tabla = (await db.query(`
        SELECT t.product_id, t.cja_price::numeric AS cja_price, t.source, p.sku, p.deleted_at IS NULL AS vivo
          FROM analytics.product_box_price t LEFT JOIN catalog.products p ON p.id = t.product_id
         WHERE t.tenant_id = $1`, [M])).rows;
      await db.query('COMMIT');
      const enTabla = new Map(tabla.map((r) => [r.product_id, r]));
      const cambian = tabla.filter((t) => regla.has(t.product_id)
        && (Number(t.cja_price) !== Number(regla.get(t.product_id).cja_price) || t.source !== regla.get(t.product_id).source));
      const faltan = [...regla.keys()].filter((k) => !enTabla.has(k));
      const sobranVivos = tabla.filter((t) => !regla.has(t.product_id) && t.vivo);
      const deBorrados = tabla.filter((t) => !regla.has(t.product_id) && !t.vivo);
      console.log(`  regla: ${regla.size} productos · tabla: ${tabla.length} filas`);
      console.log(`  cambiarían ${cambian.length} · faltan ${faltan.length} · sobran (productos vivos) ${sobranVivos.length}`
        + ` · de productos borrados o inexistentes ${deBorrados.length} (inertes: --apply los borra)`);
      for (const t of cambian.slice(0, 10)) console.log(`    ${t.sku}: ${Number(t.cja_price)} → ${Number(regla.get(t.product_id).cja_price)} (${regla.get(t.product_id).source})`);
      console.log('\n[EN SECO] nada cambió. Corré con --apply.');
      return;
    }
    const n = await normalizeBoxPrice(db, M, null);
    console.log(`[APPLY] ${n} filas escritas o borradas (sin churn, catálogo entero).`);
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('\nERROR:', e.message); process.exitCode = 1; }
  finally { await db.end().catch(() => {}); }
})();
