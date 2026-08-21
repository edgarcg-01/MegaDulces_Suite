/* eslint-disable no-console */
/**
 * Normalizadores AL-MOMENTO de current-state derivado del ODS (feedback_ods_derived_realtime_no_batch_lag).
 * ÚNICA fuente de verdad compartida por el hop-2 (apply-handlers → ODS_NORMALIZERS, scoped a los SKUs que
 * llegaron) y el backstop nocturno (los importers, con skus=null = full-catálogo).
 *
 * Todo es SQL server-side sobre el MISMO Postgres de prod (kepler_ods ⋈ catalog/commercial/analytics):
 * cero fan-out per-branch, cero round-trips, churn-free (solo reescribe si cambió), NUNCA pisa source='manual'.
 * El caller NO necesita tx propia: cada función maneja su BEGIN/COMMIT.
 *
 * Decode: kdik c2=sku c16=costo · kdii c1=sku c90=precio c84=pzas/caja c33/c34/c35=mín/reorden/máx ·
 * kdpv_prod_util c1=sku c2=presentación c4=min_qty c7=precio. sucursal='00'=CEDIS (se excluye del retail).
 */

const HOUSE = 1.2333;   // costo implícito = c90 / 1.2333 (ancla del costo)
const TOL = 0.005;      // churn-free costo

const clean = (skus) => Array.from(new Set((Array.isArray(skus) ? skus : []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean)));

/**
 * COSTO (CANON.0.1) — kdik.c16 (mediana retail) anclado a kdii.c90 → catalog.products.cost_*.
 * UPDATE-only, clamp in-band [1/3,3]× anti-unidad-caja, churn-free. Dispara en kdii (ancla) y kdik (costo).
 */
async function normalizeCost(client, tenantId, skus) {
  const s = clean(skus);                 // null/[] = full
  const scoped = s.length > 0;
  const params = scoped ? [tenantId, s] : [tenantId];
  const f2 = scoped ? 'AND btrim(c2) = ANY($2)' : '';
  const f1 = scoped ? 'AND btrim(c1) = ANY($2)' : '';
  const fp = scoped ? 'AND p.sku = ANY($2)' : '';
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const res = await client.query(`
      WITH kk AS (
        SELECT btrim(c2) AS sku, (percentile_cont(0.5) WITHIN GROUP (ORDER BY c16::numeric))::numeric AS med
          FROM kepler_ods.kdik
         WHERE c16::numeric > 0 AND btrim(sucursal) <> '00' AND btrim(coalesce(c2,'')) <> '' ${f2}
         GROUP BY btrim(c2)),
      anchor AS (
        SELECT sku, (precio / ${HOUSE})::numeric AS net FROM (
          SELECT btrim(c1) AS sku, mode() WITHIN GROUP (ORDER BY c90::numeric) AS precio
            FROM kepler_ods.kdii
           WHERE c90::numeric > 0.05 AND btrim(sucursal) <> '00' AND btrim(coalesce(c1,'')) <> '' ${f1}
           GROUP BY btrim(c1)) r),
      net AS (
        SELECT COALESCE(kk.sku, a.sku) AS sku,
          CASE WHEN kk.med IS NOT NULL AND a.net IS NOT NULL
                 THEN CASE WHEN kk.med BETWEEN a.net*0.25 AND a.net*4 THEN kk.med ELSE a.net END
               WHEN kk.med IS NOT NULL THEN kk.med ELSE a.net END AS net
        FROM kk FULL OUTER JOIN anchor a ON a.sku = kk.sku)
      UPDATE catalog.products p SET
        cost_base     = round(n.net, 6),
        cost_with_tax = round(n.net * (1 + COALESCE(p.iva_rate,0) + COALESCE(p.ieps_rate,0)), 6),
        cost_per_case = CASE WHEN p.factor_sale > 0
                             THEN round(n.net * (1 + COALESCE(p.iva_rate,0) + COALESCE(p.ieps_rate,0)) * p.factor_sale, 6)
                             ELSE p.cost_per_case END,
        updated_at = now()
      FROM net n
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=n.sku ${fp} AND n.net > 0
        AND (p.cost_base IS NULL OR abs(p.cost_base::numeric - n.net) > ${TOL})
        AND (p.cost_base IS NULL OR (n.net BETWEEN p.cost_base::numeric/3 AND p.cost_base::numeric*3))`, params);
    await client.query('COMMIT');
    return res.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

/**
 * REORDEN (RA.2) — kdii c33/34/35 (ladder sano c34<>0, c35>1, c35>=c34) por sucursal → commercial.reorder_policy
 * (warehouse×product). sucursal → warehouses.kepler_code. Upsert churn-free + delete de los 'kepler' que ya no vienen.
 */
async function normalizeReorder(client, tenantId, skus) {
  const s = clean(skus);
  const scoped = s.length > 0;
  const params = scoped ? [tenantId, s] : [tenantId];
  const fk = scoped ? 'AND btrim(k.c1) = ANY($2)' : '';
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    await client.query(`
      CREATE TEMP TABLE stg_ro ON COMMIT DROP AS
      SELECT w.id AS warehouse_id, p.id AS product_id,
             max(k.c33::numeric) AS min_stock, max(k.c34::numeric) AS reorder_point, max(k.c35::numeric) AS max_stock
        FROM kepler_ods.kdii k
        JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.kepler_code=btrim(k.sucursal) AND w.deleted_at IS NULL
        JOIN catalog.products p ON p.tenant_id=$1 AND p.sku=btrim(k.c1) AND p.deleted_at IS NULL
       WHERE k.c34::numeric<>0 AND k.c35::numeric>1 AND k.c35::numeric>=k.c34::numeric ${fk}
       GROUP BY w.id, p.id`, params);
    // Guard anti-wipe: en full, si el read del ODS vino VACÍO (outage transitorio), NO borrar toda la tabla.
    if (!scoped && !Number((await client.query(`SELECT count(*)::int c FROM stg_ro`)).rows[0].c)) { await client.query('COMMIT'); return 0; }
    // delete: filas 'kepler' de los productos tocados (scoped) o global (full) que ya no están en stg_ro
    const delScope = scoped
      ? `AND rp.product_id IN (SELECT id FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,'')) = ANY($2))`
      : `AND rp.warehouse_id IN (SELECT DISTINCT warehouse_id FROM stg_ro)`;
    await client.query(`
      DELETE FROM commercial.reorder_policy rp
       WHERE rp.tenant_id=$1 AND rp.source='kepler' ${delScope}
         AND NOT EXISTS (SELECT 1 FROM stg_ro s WHERE s.warehouse_id=rp.warehouse_id AND s.product_id=rp.product_id)`, params);
    const up = await client.query(`
      INSERT INTO commercial.reorder_policy (id, tenant_id, warehouse_id, product_id, min_stock, reorder_point, max_stock, source, computed_at, updated_at)
      SELECT gen_random_uuid(), $1, warehouse_id, product_id, min_stock, reorder_point, max_stock, 'kepler', now(), now() FROM stg_ro
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET min_stock=EXCLUDED.min_stock, reorder_point=EXCLUDED.reorder_point, max_stock=EXCLUDED.max_stock,
            source='kepler', computed_at=now(), updated_at=now()
        WHERE commercial.reorder_policy.source <> 'manual'
          AND (commercial.reorder_policy.min_stock, commercial.reorder_policy.reorder_point, commercial.reorder_policy.max_stock, commercial.reorder_policy.source)
              IS DISTINCT FROM (EXCLUDED.min_stock, EXCLUDED.reorder_point, EXCLUDED.max_stock, 'kepler')`, [tenantId]);
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

/** BOX FACTOR (RA-PRO.37) — kdii.c84 (MAX>1 retail) → analytics.product_box_factor. Upsert churn-free + delete. */
async function normalizeBoxFactor(client, tenantId, skus) {
  const s = clean(skus);
  const scoped = s.length > 0;
  const params = scoped ? [tenantId, s] : [tenantId];
  const fk = scoped ? 'AND btrim(k.c1) = ANY($2)' : '';
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    await client.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_factor (
      tenant_id uuid NOT NULL, product_id uuid NOT NULL, box_factor numeric NOT NULL,
      source text NOT NULL DEFAULT 'kepler_c84', updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id))`);
    await client.query(`
      CREATE TEMP TABLE stg_bf ON COMMIT DROP AS
      SELECT p.id AS product_id, max(k.c84::numeric) AS box_factor
        FROM kepler_ods.kdii k
        JOIN catalog.products p ON p.tenant_id=$1 AND p.sku=btrim(k.c1) AND p.deleted_at IS NULL
       WHERE k.c84::numeric > 1 AND btrim(k.sucursal) <> '00' ${fk}
       GROUP BY p.id`, params);
    if (!scoped && !Number((await client.query(`SELECT count(*)::int c FROM stg_bf`)).rows[0].c)) { await client.query('COMMIT'); return 0; }
    const delScope = scoped
      ? `AND t.product_id IN (SELECT id FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,'')) = ANY($2))`
      : '';
    await client.query(`
      DELETE FROM analytics.product_box_factor t
       WHERE t.tenant_id=$1 ${delScope}
         AND NOT EXISTS (SELECT 1 FROM stg_bf s WHERE s.product_id=t.product_id)`, params);
    const up = await client.query(`
      INSERT INTO analytics.product_box_factor AS t (tenant_id, product_id, box_factor, source, updated_at)
      SELECT $1, product_id, box_factor, 'kepler_c84', now() FROM stg_bf
      ON CONFLICT (tenant_id, product_id) DO UPDATE SET box_factor=EXCLUDED.box_factor, updated_at=now()
       WHERE t.box_factor IS DISTINCT FROM EXCLUDED.box_factor`, [tenantId]);
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

/** BOX PRICE (RA-PRO.39) — kdpv CJA (list=min c4 tier), fallback PAQ×factor_sale → analytics.product_box_price. */
async function normalizeBoxPrice(client, tenantId, skus) {
  const s = clean(skus);
  const scoped = s.length > 0;
  const params = scoped ? [tenantId, s] : [tenantId];
  const fk = scoped ? 'AND btrim(c1) = ANY($2)' : '';
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    await client.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_price (
      tenant_id uuid NOT NULL, product_id uuid NOT NULL, cja_price numeric NOT NULL,
      source text NOT NULL DEFAULT 'kepler_kdpv', updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id))`);
    await client.query(`
      CREATE TEMP TABLE stg_bp ON COMMIT DROP AS
      WITH pv AS (
        SELECT btrim(c1) AS sku, c2 AS present, (array_agg(c7::numeric ORDER BY c4::numeric ASC))[1] AS price
          FROM kepler_ods.kdpv_prod_util
         WHERE c2 IN ('CJA','PAQ') AND c7::numeric > 0 AND btrim(sucursal) <> '00' ${fk}
         GROUP BY btrim(c1), c2),
      agg AS (SELECT sku, max(price) FILTER (WHERE present='CJA') AS cja, max(price) FILTER (WHERE present='PAQ') AS paq FROM pv GROUP BY sku)
      SELECT p.id AS product_id,
             CASE WHEN a.cja > 0 THEN a.cja
                  WHEN a.paq > 0 AND COALESCE(p.factor_sale,1) > 1 THEN a.paq * p.factor_sale END AS cja_price,
             CASE WHEN a.cja > 0 THEN 'kepler_kdpv' ELSE 'derived_paq' END AS source
        FROM agg a
        JOIN catalog.products p ON p.tenant_id=$1 AND p.sku=a.sku AND p.deleted_at IS NULL
       WHERE (a.cja > 0) OR (a.paq > 0 AND COALESCE(p.factor_sale,1) > 1)`, params);
    if (!scoped && !Number((await client.query(`SELECT count(*)::int c FROM stg_bp`)).rows[0].c)) { await client.query('COMMIT'); return 0; }
    const delScope = scoped
      ? `AND t.product_id IN (SELECT id FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,'')) = ANY($2))`
      : '';
    await client.query(`
      DELETE FROM analytics.product_box_price t
       WHERE t.tenant_id=$1 ${delScope}
         AND NOT EXISTS (SELECT 1 FROM stg_bp s WHERE s.product_id=t.product_id)`, params);
    const up = await client.query(`
      INSERT INTO analytics.product_box_price AS t (tenant_id, product_id, cja_price, source, updated_at)
      SELECT $1, product_id, cja_price, source, now() FROM stg_bp WHERE cja_price IS NOT NULL
      ON CONFLICT (tenant_id, product_id) DO UPDATE SET cja_price=EXCLUDED.cja_price, source=EXCLUDED.source, updated_at=now()
       WHERE (t.cja_price, t.source) IS DISTINCT FROM (EXCLUDED.cja_price, EXCLUDED.source)`, [tenantId]);
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

module.exports = { normalizeCost, normalizeReorder, normalizeBoxFactor, normalizeBoxPrice };
