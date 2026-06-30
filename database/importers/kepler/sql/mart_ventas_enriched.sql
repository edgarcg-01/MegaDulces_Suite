-- KV.0 — Vista enriquecida sobre mart.ventas (consolidación on-prem, localhost:5433).
-- ADITIVA: no toca la tabla base mart.ventas ni la función mart.refresh_ventas.
-- Reusable por todos los feeds (sales-fact, rotación, top-sellers).
--
-- Aporta sobre mart.ventas:
--   channel           — derivado de forma_pago (= kdm1.c10).
--   erp_customer_ref  — referencia de cliente Kepler (forma_pago cuando NO es CONTADO).
--   (filtro)          — excluye pseudo-productos (DEVOLUCIONES / TIEMPO AIRE inflado).
--
-- Canal:
--   CONTADO  → tienda   (mostrador, ~97% de filas, cliente anónimo)
--   TI...    → mayoreo   (transferencias/CEDIS mayoreo)
--   RUTA...  → ruta
--   resto    → credito   (código numérico de cliente a crédito; ruta/mayoreo se afina en KV.3)
--
-- Costo: NO se incluye acá. El importer de KV.1 lo calcula con catalog.products.cost_base
-- (costo actual). Costo al momento de la venta (kdij.c22) = refinamiento futuro.

CREATE SCHEMA IF NOT EXISTS mart;

CREATE OR REPLACE VIEW mart.ventas_enriched AS
SELECT
  v.sucursal,
  v.almacen,
  v.folio,
  v.fecha,
  v.forma_pago,
  CASE
    WHEN v.forma_pago = 'CONTADO'        THEN 'tienda'
    WHEN v.forma_pago LIKE 'TI%'         THEN 'mayoreo'
    WHEN upper(v.forma_pago) LIKE 'RUTA%' THEN 'ruta'
    ELSE 'credito'
  END                                          AS channel,
  NULLIF(v.forma_pago, 'CONTADO')              AS erp_customer_ref,
  v.sku,
  v.producto,
  v.unidad,
  v.cantidad,
  v.precio_neto,
  v.importe
FROM mart.ventas v
WHERE v.sku NOT IN ('00001','00002','00004')        -- pseudo: ventas 0% / devoluciones
  AND v.producto !~* 'devoluc|^tiempo aire$|ventas al [0-9]';  -- summary/no-producto

COMMENT ON VIEW mart.ventas_enriched IS
  'KV.0: mart.ventas + channel + erp_customer_ref + filtro pseudo-productos. Aditiva.';
