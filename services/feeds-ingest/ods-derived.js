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
const BASE_LIST = '00000000-0000-0000-0000-0000c0ffee02'; // commercial.price_lists BASE-MXN (is_default)

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

/**
 * PRECIO DE VENTA → commercial.product_prices (BASE-MXN).
 *
 * REGLA (Edgar 2026-08-25): **manda lo que el punto de venta COBRA**, no la configuración.
 * Medido en prod: la configuración (`kdii.c90`) sólo coincide exacto con lo cobrado en ~58% de los
 * casos, y en 982 de 4,712 SKUs con volumen se aparta más de 25% — en ambas direcciones.
 *
 * FUENTE PRIMARIA — moda de lo cobrado, `kdm2.c12`:
 *   · Documentos de VENTA según el catálogo `kdmm` (género U, naturaleza D): 3 Factura TK Crédito ·
 *     5 Factura TK Contado · 6 Factura global · 7 Factura Global Con · 8 Factura Telemarketing ·
 *     9 Ticket Crédito · 10 TICKET CONTADO CAJA · 12/13 Factura No Fiscal · 45 Remisión.
 *     NO se incluyen: `U-A-*` (cobros, notas de crédito, devoluciones, recepción de traspaso),
 *     género `N` (inventario y traspasos: N-D-6 / N-D-25 / N-A-6 / N-A-25) ni género `X` (COMPRAS —
 *     leer X-A-35/X-A-37 como venta devolvía el costo disfrazado de precio).
 *   · `qty < 3`: abajo del primer escalón de volumen. Ahí el precio es FIRME — dispersión mediana
 *     0.0% y 78% de los SKUs con rango intercuartil ≤2% (en ticket de caja, 86%). Con `qty >= 3`
 *     sube a 9.9% porque entra la escalera, que es otra cosa.
 *   · Sólo la unidad BASE (`kdii.c11`): "la facturación es siempre sobre la unidad Base".
 *   · Sucursales retail (se excluye CEDIS), documentos vigentes (`kdm1.c43='N'`), 90 días, ≥5 líneas.
 *
 * RESPALDO — el PV configurado (`kdii.c90` de la unidad base, mediana de retail), sólo donde no hay
 * ventas suficientes (~39% del catálogo no vende nada en 90 días). Ahí sí se valida, porque no hay
 * con qué contrastarlo:
 *   1. <= $0.05            marcador de promo, no precio público
 *   2. > 3x costo          precio de CAJA colado en el slot de la unidad base (p99 real = 2.03x).
 *                          El escalón NO perdona este caso: también trae el valor de caja y
 *                          confirmaría el error.
 *   3. escalón de volumen  si `kdpv_prod_util` confirma el PV, manda sobre el costo (misma unidad
 *                          que el precio; `cost_base` con frecuencia viene en caja)
 *   4. < costo             se vendería perdiendo
 * Lo que sale rechazado conserva su precio anterior y se reporta — se arregla EN Kepler.
 *
 * Ver docs/IMPLEMENTACION/KEPLER_PRECIOS_MODELO.md.
 */
const MAX_COSTO = 3;      // p99 real de precio/costo = 2.03x
const MIN_LINEAS = 5;     // mínimo de líneas de venta para creerle a la moda
const VENTANA_DIAS = 90;
/** Documentos de venta a cliente, del catálogo kdmm (género U, naturaleza D). */
const DOCS_VENTA = '3,5,6,7,8,9,10,12,13,45';

/**
 * Cadena de CTEs que deja `evaluado` con una fila por SKU: el precio, de dónde salió (`fuente`) y,
 * si el respaldo no pasa, el motivo del rechazo. ÚNICA definición del cómputo — la comparten
 * `normalizeSalePrice` (escribe) y el script de auditoría (reporta). No duplicarla en ningún lado.
 */
function salePriceCtes(scoped) {
  const f1 = scoped ? 'AND btrim(c1) = ANY($2)' : '';
  const fpv = scoped ? 'AND btrim(c1) = ANY($2)' : '';
  const fm2 = scoped ? 'AND btrim(m2.c8::text) = ANY($2)' : '';
  return `
      WITH base_unit AS (
        SELECT btrim(sucursal) AS suc, btrim(c1) AS sku, btrim(c11::text) AS unidad,
               round(c90::numeric, 2) AS pv
          FROM kepler_ods.kdii
         WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c11::text,'')) <> '' ${f1}
      ), pos AS (
        SELECT btrim(m2.c8::text) AS sku,
               mode() WITHIN GROUP (ORDER BY round(m2.c12::numeric,2)) AS precio,
               count(*)::int AS lineas
          FROM kepler_ods.kdm2 m2
          JOIN kepler_ods.kdm1 m1
            ON btrim(m1.sucursal)=btrim(m2.sucursal)
           AND btrim(m1.c5::text)=btrim(m2.c5::text) AND btrim(m1.c6::text)=btrim(m2.c6::text)
          JOIN base_unit bu
            ON bu.suc=btrim(m2.sucursal) AND bu.sku=btrim(m2.c8::text)
           AND bu.unidad=btrim(m2.c11::text)
         WHERE m1.c9::date >= current_date - ${VENTANA_DIAS}
           AND btrim(coalesce(m1.c43::text,'N'))='N'
           AND btrim(m1.c2::text)='U' AND btrim(m1.c3::text)='D'
           AND m1.c4::int IN (${DOCS_VENTA})
           AND m2.c12::numeric > 0.05 AND m2.c9::numeric > 0 AND m2.c9::numeric < 3
           AND btrim(m2.sucursal) <> '00' ${fm2}
         GROUP BY 1 HAVING count(*) >= ${MIN_LINEAS}
      ), cfg AS (
        SELECT sku, mode() WITHIN GROUP (ORDER BY unidad) AS unidad,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pv)::numeric, 2) AS pv
          FROM base_unit WHERE suc <> '00' AND pv > 0 GROUP BY sku
      ), tier AS (
        SELECT btrim(c1) AS sku, btrim(c2) AS present, max(c7::numeric) AS tope
          FROM kepler_ods.kdpv_prod_util
         WHERE btrim(sucursal) <> '00' AND c7::numeric > 0.05 ${fpv}
         GROUP BY 1,2
      ), evaluado AS (
        SELECT pr.id AS product_id, btrim(pr.sku) AS sku, pr.nombre,
               COALESCE(pos.precio, cfg.pv) AS precio,
               CASE WHEN pos.precio IS NOT NULL THEN 'pos' ELSE 'config' END AS fuente,
               pos.lineas AS lineas_pos, cfg.pv, cfg.unidad,
               COALESCE(pr.iva_rate,0) AS iva, pr.cost_base, pp.price AS actual, t.tope AS tier_tope,
               CASE
                 -- Lo que el PdV cobra ES el precio: no se valida contra nada.
                 WHEN pos.precio IS NOT NULL                                   THEN NULL
                 WHEN cfg.pv IS NULL OR cfg.pv <= 0.05                         THEN 'sin_precio'
                 WHEN pr.cost_base > 0 AND cfg.pv > pr.cost_base*${MAX_COSTO}   THEN 'sobre_costo'
                 WHEN t.tope IS NOT NULL AND cfg.pv >= t.tope*0.9              THEN NULL
                 WHEN t.tope IS NOT NULL                                       THEN 'bajo_su_escalon'
                 WHEN pr.cost_base > 0 AND cfg.pv < pr.cost_base               THEN 'bajo_costo'
               END AS rechazo
          FROM catalog.products pr
          LEFT JOIN pos ON pos.sku = btrim(pr.sku)
          LEFT JOIN cfg ON cfg.sku = btrim(pr.sku)
          LEFT JOIN tier t ON t.sku = btrim(pr.sku) AND t.present = cfg.unidad
          LEFT JOIN commercial.product_prices pp
            ON pp.tenant_id=$1 AND pp.price_list_id='${BASE_LIST}' AND pp.product_id=pr.id
           AND pp.deleted_at IS NULL
         WHERE pr.tenant_id=$1 AND pr.deleted_at IS NULL AND NOT coalesce(pr.is_promo,false)
           AND (pos.precio IS NOT NULL OR cfg.pv IS NOT NULL)
           ${scoped ? 'AND btrim(pr.sku) = ANY($2)' : ''}
      )`;
}

async function normalizeSalePrice(client, tenantId, skus) {
  const s = clean(skus);
  const scoped = s.length > 0;
  const params = scoped ? [tenantId, s] : [tenantId];
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const up = await client.query(`${salePriceCtes(scoped)}
      INSERT INTO commercial.product_prices AS t
        (id, tenant_id, price_list_id, product_id, price, tax_rate, min_qty, created_at, updated_at)
      SELECT gen_random_uuid(), $1, '${BASE_LIST}', product_id, precio, iva, 1, now(), now()
        FROM evaluado WHERE rechazo IS NULL
      ON CONFLICT (tenant_id, price_list_id, product_id) DO UPDATE
        SET price=EXCLUDED.price, updated_at=now()
      WHERE t.price IS DISTINCT FROM EXCLUDED.price`, params);
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

module.exports = { normalizeCost, normalizeReorder, normalizeBoxFactor, normalizeBoxPrice, normalizeSalePrice, salePriceCtes };
