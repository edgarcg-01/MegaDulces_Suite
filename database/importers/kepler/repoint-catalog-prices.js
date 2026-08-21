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
 * → este feed es precio + `is_promo`. CANON.0.2: absorbió el recálculo de `is_promo` (marca de
 * clave promo/regalo Kepler $0.01/$0.05) que vivía en `import-prices-bulk` (.245, retirado).
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
// CANON.1.3 — fuente por default `ods`: kepler_ods.kdii en el MISMO Postgres de prod (same-DB, @min).
// Reconciliación decidida (Edgar 2026-08-20): EXCLUIR CEDIS (sucursal 00, cotiza mayoreo más alto) +
// MODA retail (01-06); fallback a CEDIS solo si el SKU no tiene retail. Verificado: 99% de los BASE-MXN
// vivos quedan idénticos; los 90 que cambian son correcciones al consenso. Fallback `--source=kp` = .245.
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
const KSCHEMA = SOURCE === 'ods' ? 'kepler_ods' : 'kp';
const APPLY = process.argv.includes('--apply');
// Kepler es la AUTORIDAD del precio de venta → SYNC (ACTUALIZA los existentes a c90 fresco,
// churn-free) es el DEFAULT. Opt-out: --gap-fill-only restaura el viejo comportamiento (solo
// rellena faltantes). Los c90 de $0.01/$0.05 son marcadores de PROMO (solo rutas, no público)
// → se excluyen del precio base con el piso `c90 > 0.05` (abajo).
const SYNC = !process.argv.includes('--gap-fill-only');

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const useOds = SOURCE === 'ods';                    // ods → lee kepler_ods en la misma conexión de prod
  const src = useOds ? null : new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  const readSrc = useOds ? dst : src;
  try {
    console.log(`\n=== Precio base ${useOds ? 'kepler_ods' : 'KP_CONCENTRADA'} c90 (excl CEDIS + moda retail) → BASE-MXN (${SYNC ? 'SYNC: actualiza todos' : 'solo faltantes'}) (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    if (!useOds) {
      try { await src.connect(); }
      catch (e) { console.error(`❌ sin conexión a KP_CONCENTRADA (${e.message}) — abortando`); process.exitCode = 1; return; }
    }

    // Precio retail robusto (regla Edgar 2026-08-20): EXCLUIR CEDIS (sucursal '00' = mayoreo, cotiza
    // más alto) + MODA de c90 entre retail (01-06); fallback a CEDIS solo si el SKU NO tiene retail.
    // Piso c90 > 0.05: los $0.01/$0.05 son marcadores de PROMO (solo rutas) → nunca entran al base.
    const rows = (await readSrc.query(`
      WITH retail AS (
        SELECT btrim(c1) AS sku, mode() WITHIN GROUP (ORDER BY c90::numeric) AS precio
          FROM ${KSCHEMA}.kdii
         WHERE btrim(coalesce(c1,'')) <> '' AND c90::numeric > 0.05 AND btrim(sucursal) <> '00'
         GROUP BY btrim(c1)),
      cedis AS (
        SELECT btrim(c1) AS sku, mode() WITHIN GROUP (ORDER BY c90::numeric) AS precio
          FROM ${KSCHEMA}.kdii
         WHERE btrim(coalesce(c1,'')) <> '' AND c90::numeric > 0.05 AND btrim(sucursal) = '00'
         GROUP BY btrim(c1))
      SELECT sku, precio FROM retail
      UNION ALL
      SELECT c.sku, c.precio FROM cedis c WHERE NOT EXISTS (SELECT 1 FROM retail r WHERE r.sku=c.sku)`)).rows;
    console.log(`  ${KSCHEMA}.kdii: ${rows.length} SKUs con precio retail (excl CEDIS, promos excluidas)`);
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

    // candidatos: producto activo con sku en KP. Gap-fill (default): SOLO sin precio en ninguna
    // lista. Sync (--sync): TODOS (actualiza el precio existente de BASE-MXN a c90 fresco).
    const gapOnly = SYNC ? '' : `AND NOT EXISTS (SELECT 1 FROM commercial.product_prices pp WHERE pp.tenant_id=$1 AND pp.product_id=p.id)`;
    const FROM = `
      FROM catalog.products p
      JOIN stg_price s ON s.sku = p.sku
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL ${gapOnly}`;

    if (SYNC) {
      const chg = Number((await dst.query(`
        SELECT count(*)::int n
          FROM catalog.products p JOIN stg_price s ON s.sku=p.sku
          LEFT JOIN commercial.product_prices pp
            ON pp.tenant_id=$1 AND pp.price_list_id='${BASE_LIST}' AND pp.product_id=p.id
         WHERE p.tenant_id=$1 AND p.deleted_at IS NULL
           AND (pp.price IS NULL OR pp.price IS DISTINCT FROM s.precio)`, [M])).rows[0].n);
      console.log(`  a sincronizar (falta o precio ≠ c90): ${chg} productos → BASE-MXN`);
    } else {
      const willCount = Number((await dst.query(`SELECT count(*)::int n ${FROM}`, [M])).rows[0].n);
      console.log(`  a rellenar (sin precio en ninguna lista, con c90): ${willCount} productos → BASE-MXN`);
    }

    if (!APPLY) { await dst.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    // Gap-fill NO pisa (DO NOTHING). Sync ACTUALIZA solo si el precio cambió (churn-free).
    const onConflict = SYNC
      ? `ON CONFLICT (tenant_id, price_list_id, product_id) DO UPDATE SET price=EXCLUDED.price, updated_at=now()
         WHERE commercial.product_prices.price IS DISTINCT FROM EXCLUDED.price`
      : `ON CONFLICT (tenant_id, price_list_id, product_id) DO NOTHING`;
    const res = await dst.query(`
      INSERT INTO commercial.product_prices (id, tenant_id, price_list_id, product_id, price, tax_rate, min_qty, created_at, updated_at)
      SELECT gen_random_uuid(), $1, '${BASE_LIST}', p.id, s.precio, COALESCE(p.iva_rate, 0), 1, now(), now()
      ${FROM}
      ${onConflict}`, [M]);

    // ── CANON.0.2 — recálculo de is_promo (REUBICADO de import-prices-bulk, que se retiró) ──
    // Los tiers P1-P4/MAYOREO eran DATO MUERTO (0 consumidores). Lo único de prices-bulk con
    // valor era `is_promo`: la marca de clave promo/regalo Kepler ($0.01/$0.05, NO venta real).
    // Se recalcula acá desde la MISMA fuente fresca (kdii.c90, no la tabla .245 muerta), 3 pases,
    // tolerante a prod sin la columna (mig 20260706150000). Corre en el mismo trx del sync.
    const hasPromo = (await dst.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='catalog' AND table_name='products' AND column_name='is_promo'`)).rowCount > 0;
    let promoMsg = 'is_promo: columna ausente, skip';
    if (hasPromo) {
      // Pase 1 (PRECIO, BIDIRECCIONAL): promo = precio Kepler MÁX (retail, excl CEDIS) ≤ $0.05.
      // Si el SKU reaparece con precio real (>0.05, reúso de clave para producto real), el flag se
      // LIMPIA solo. stg_promo = max(c90) por SKU sobre TODO kdii (incl las filas $0.01 de promo).
      const promoSrc = (await readSrc.query(`
        SELECT btrim(c1) AS sku, max(c90::numeric) AS maxp
          FROM ${KSCHEMA}.kdii
         WHERE btrim(coalesce(c1,'')) <> '' AND btrim(sucursal) <> '00'
         GROUP BY btrim(c1)`)).rows;
      await dst.query(`CREATE TEMP TABLE stg_promo (sku text PRIMARY KEY, maxp numeric) ON COMMIT DROP`);
      for (let i = 0; i < promoSrc.length; i += BATCH) {
        const chunk = promoSrc.slice(i, i + BATCH);
        const vals = chunk.map((_, ri) => `($${ri * 2 + 1},$${ri * 2 + 2})`);
        const params = [];
        for (const r of chunk) params.push(r.sku, r.maxp);
        await dst.query(`INSERT INTO stg_promo (sku, maxp) VALUES ${vals.join(',')}
          ON CONFLICT (sku) DO UPDATE SET maxp=GREATEST(stg_promo.maxp, EXCLUDED.maxp)`, params);
      }
      const promo = await dst.query(`
        UPDATE catalog.products p SET is_promo = (s.maxp <= 0.05), updated_at = now()
        FROM stg_promo s
        WHERE p.tenant_id=$1 AND p.sku = s.sku AND p.is_promo IS DISTINCT FROM (s.maxp <= 0.05)`, [M]);
      // Pase 2 (COSTO): claves promo/regalo Kepler ($0.01 placeholder) SIN precio en kdii → el
      // pase 1 no las evalúa; costo en (0, 0.05] es la señal precisa. EXCLUYE costo=0 a propósito
      // (ahí suele ser costo FALTANTE de un producto real, no promo). Solo MARCA true.
      const promoCost = await dst.query(`
        UPDATE catalog.products SET is_promo = true, updated_at = now()
        WHERE tenant_id=$1 AND deleted_at IS NULL AND is_promo = false
          AND cost_base IS NOT NULL AND cost_base > 0 AND cost_base <= 0.05`, [M]);
      // Pase 3 (NOMBRE): trade-promo "compra X = GRATIS Y" sin precio ni costo. El '=' es la firma
      // (— "30% GRATIS"/"+172ML GRATIS" son productos reales SIN '=' → no se tocan). Guard de costo.
      const promoName = await dst.query(`
        UPDATE catalog.products SET is_promo = true, updated_at = now()
        WHERE tenant_id=$1 AND deleted_at IS NULL AND is_promo = false
          AND upper(nombre) LIKE '%= GRATIS%' AND (cost_base IS NULL OR cost_base <= 0.05)`, [M]);
      promoMsg = `is_promo recalculado: ${promo.rowCount} (precio c90≤$0.05, bidireccional) + ${promoCost.rowCount} (costo) + ${promoName.rowCount} (nombre "= GRATIS")`;
    }

    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${res.rowCount} precios base ${SYNC ? 'sincronizados (insert+update churn-free)' : 'insertados (sin pisar)'} · ${promoMsg}.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    if (src) await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
