-- Debug portal /catalog en local

-- 1. Customer demo
SELECT c.code, c.default_price_list_id, pl.name AS pl_name
FROM commercial.customers c
LEFT JOIN commercial.price_lists pl ON pl.id = c.default_price_list_id
WHERE c.code = 'TST-PORTAL-001';

-- 2. Counts en local catalog.products
SELECT
  COUNT(*) AS total_products,
  COUNT(*) FILTER (WHERE activo = true AND deleted_at IS NULL) AS activos,
  COUNT(*) FILTER (WHERE sku IS NOT NULL OR articulo IS NOT NULL) AS con_sku_o_articulo
FROM catalog.products;

-- 3. Counts en price_lists
SELECT pl.code, pl.name, COUNT(pp.id) AS prices_count
FROM commercial.price_lists pl
LEFT JOIN commercial.product_prices pp ON pp.price_list_id = pl.id AND pp.deleted_at IS NULL
GROUP BY pl.id, pl.code, pl.name
ORDER BY pl.code;

-- 4. Query del portal (listAllProducts simulation) — para BASE-MXN
SELECT
  COUNT(*)                                                AS total_rows,
  COUNT(*) FILTER (WHERE pp.id IS NOT NULL)               AS con_precio,
  COUNT(*) FILTER (WHERE ipa.image_url IS NOT NULL)       AS con_imagen
FROM catalog.products p
LEFT JOIN catalog.brands b
  ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
LEFT JOIN commercial.product_prices pp
  ON pp.product_id = p.id
 AND pp.tenant_id = p.tenant_id
 AND pp.price_list_id = '00000000-0000-0000-0000-0000c0ffee02'
 AND pp.deleted_at IS NULL
LEFT JOIN inventory.products_active ipa
  ON ipa.sku = COALESCE(p.sku, p.articulo)
WHERE p.activo = true
  AND p.deleted_at IS NULL
  AND (b.is_commercial = true OR b.id IS NULL);

-- 5. Sample con imagen y precio
SELECT p.nombre, COALESCE(p.sku, p.articulo) AS sku, pp.price, ipa.image_url
FROM catalog.products p
LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
LEFT JOIN commercial.product_prices pp
  ON pp.product_id = p.id
 AND pp.price_list_id = '00000000-0000-0000-0000-0000c0ffee02'
 AND pp.deleted_at IS NULL
LEFT JOIN inventory.products_active ipa
  ON ipa.sku = COALESCE(p.sku, p.articulo)
WHERE p.activo = true AND p.deleted_at IS NULL
  AND pp.id IS NOT NULL
  AND ipa.image_url IS NOT NULL
LIMIT 5;
