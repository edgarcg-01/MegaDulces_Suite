/* eslint-disable no-console */
/**
 * Catálogo — RELLENO de PRECIO base para productos sin precio, desde KP_CONCENTRADA (`kp.kdii.c90`).
 *
 * ~2.7k productos activos NO tienen precio de venta en `commercial.product_prices` (ninguna lista)
 * porque `import-prices-bulk` lee la fuente externa `catalogo_etiquetas` (.245, incompleta/stale),
 * mientras `KP_CONCENTRADA.kp.kdii.c90` (fresca, nuestra) sí trae el precio de mostrador. Este feed
 * cierra ese hueco: inserta `c90` en la lista base (BASE-MXN, is_default) SOLO donde el producto
 * NO tiene precio en NINGUNA lista.
 *
 * **UPSERT-only, NO pisa (egress mínimo):** `INSERT ... ON CONFLICT DO NOTHING` (nunca sobreescribe
 * un precio ya cargado). No baja el catálogo al cliente: empuja (sku, precio) a una TEMP y hace un
 * INSERT-SELECT server-side. NO borra nada.
 *
 * OJO: el COSTO casi no se puede rellenar así (Kepler `kdik` es ralo, cubre ~1/6 de los faltantes)
 * → este feed es SOLO precio. `is_promo`: no aplica (c90 real > $0.05).
 *
 *   SRC_URL = KP_CONCENTRADA (default .245)  ·  DST_URL / DATABASE_URL_NEW = destino (prod)
 *   node database/importers/kepler/repoint-catalog-prices.js            # dry-run (cuenta)
 *   node database/importers/kepler/repoint-catalog-prices.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const BASE_LIST = '00000000-0000-0000-0000-0000c0ffee02'; // commercial.price_lists BASE-MXN (is_default)
const SRC = process.env.SRC_URL || process.env.KP_CONCENTRADA_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  try {
    console.log(`\n=== RELLENO de precio base (KP_CONCENTRADA c90 → BASE-MXN, solo faltantes) (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    try { await src.connect(); }
    catch (e) { console.error(`❌ sin conexión a KP_CONCENTRADA (${e.message}) — abortando`); process.exitCode = 1; return; }

    // precio fresco por sku (dedupe, la carga más reciente; solo c90 > 0)
    const rows = (await src.query(
      `SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, c90::numeric AS precio
         FROM kp.kdii WHERE btrim(coalesce(c1,'')) <> '' AND c90::numeric > 0
        ORDER BY btrim(c1), _loaded_at DESC`)).rows;
    console.log(`  KP_CONCENTRADA kp.kdii: ${rows.length} SKUs con c90 > 0`);
    if (!rows.length) { console.log('  nada que hacer.'); return; }

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    await dst.query(`CREATE TEMP TABLE stg_price (sku text, precio numeric) ON COMMIT DROP`);
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => `($${ri * 2 + 1},$${ri * 2 + 2})`);
      const params = [];
      for (const r of chunk) params.push(r.sku, r.precio);
      await dst.query(`INSERT INTO stg_price (sku, precio) VALUES ${vals.join(',')}`, params);
    }

    // candidatos: producto activo, con sku en KP, SIN precio en NINGUNA lista.
    const FROM = `
      FROM catalog.products p
      JOIN stg_price s ON s.sku = p.sku
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM commercial.product_prices pp WHERE pp.tenant_id=$1 AND pp.product_id=p.id)`;
    const willCount = Number((await dst.query(`SELECT count(*)::int n ${FROM}`, [M])).rows[0].n);
    console.log(`  a rellenar (sin precio en ninguna lista, con c90): ${willCount} productos → BASE-MXN`);

    if (!APPLY) { await dst.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    const res = await dst.query(`
      INSERT INTO commercial.product_prices (id, tenant_id, price_list_id, product_id, price, tax_rate, min_qty, created_at, updated_at)
      SELECT gen_random_uuid(), $1, '${BASE_LIST}', p.id, s.precio, COALESCE(p.iva_rate, 0), 1, now(), now()
      ${FROM}
      ON CONFLICT (tenant_id, price_list_id, product_id) DO NOTHING`, [M]);
    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${res.rowCount} precios base insertados (ON CONFLICT DO NOTHING, sin pisar).`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
