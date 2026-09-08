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
--   RUTA...    → ruta      (la ruta manda, igual que en analytics.mv_kepler_sales_daily)
--   doctype 8  → mayoreo   ⭐ K.3 — U-D-8 Factura Telemarketing = MAYOREO (decisión Edgar 2026-09-02)
--   doctype 12 → credito   (U-D-12 Factura Cont No Fiscal)
--   CONTADO    → tienda    (mostrador, ~97% de filas, cliente anónimo)
--   resto      → credito   (código numérico de cliente a crédito)
--
-- ⛔ K.3 — SE RETIRA la rama `TI%` → mayoreo, y con medición, no por gusto. El comentario
-- original decía "transferencias/CEDIS mayoreo", y tenía razón sobre QUÉ es `TI%`: en
-- `kepler_ods.kdm1` (histórico completo, nov-2025 → hoy) los documentos U-D con `c10 LIKE 'TI%'`
-- son 1,360 de `U-D-40` **Pedido** y 1,254 de `U-D-41` **Embarque** — ninguno de los dos está en
-- nuestro corte — más 6 de `U-D-13` (traspaso) y sólo 2 de `U-D-8`. Y `TI001`/`TI002` NO existen
-- como clientes en `kdud`: son referencias internas, no compradores.
-- En `mart.ventas` la rama alcanzaba 12 filas / $2,837 (12-13 mar), y esas 12 son justamente los
-- 2 documentos `U-D-8` → la rama `doctype = 8` ya las clasifica igual. **Delta medido: cero.**
-- Sacarla importa igual, porque devuelve filo al candado `verify-no-transfer-leak`: si `TI%`
-- siguiera mapeando a `mayoreo`, un Pedido o un Embarque que algún día entrara al corte se
-- publicaría como venta de mayoreo y el guard ya no podría distinguirlo del telemarketing real.
-- Ahora la ÚNICA vía a `mayoreo` es el doctype 8.
--
-- ⭐ K.3 2026-09-08 — POR QUÉ ENTRA `doctype` AL CASE. Hasta hoy el canal salía SÓLO de
-- `forma_pago` (= kdm1.c10), y eso alcanzaba porque el cargador filtraba `c4=10`: todo era
-- ticket. Al abrir el corte a 8/10/12 (ver mart_refresh_ventas.sql) medimos a dónde caía
-- cada doctype con la regla vieja, contra prod, 90 d:
--       U-D-8   →  credito   15,266 renglones  $14,580,181   ← el 100%
--       U-D-12  →  credito    5,139 renglones   $1,037,699
--                  tienda     1,152 renglones     $205,768
--                  ruta          14 renglones     $248,317
-- O sea: la rama `TI%`→mayoreo NUNCA se dispara con esta data, y el telemarketing entero
-- se habría publicado como CRÉDITO — inflándolo de $10.9M a $25.5M (+133%). Arreglar el
-- total con un canal falso no es arreglarlo. Con el doctype, U-D-8 va a `mayoreo` como en
-- el matview del sell-out, y las dos superficies dicen lo mismo.
--
-- ⚠️ `v.doctype` es NULL en las filas de escritores que no lo informan (el push de
-- camionetas `ruta_NN` de .249, fuera de este repo). Todas las ramas `doctype =` son
-- falsas con NULL → esas filas caen en la rama de siempre. Cero cambio para ellas, a
-- propósito.
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
    WHEN upper(v.forma_pago) LIKE 'RUTA%' THEN 'ruta'
    WHEN v.doctype = 8                   THEN 'mayoreo'
    WHEN v.doctype = 12                  THEN 'credito'
    WHEN v.forma_pago = 'CONTADO'        THEN 'tienda'
    ELSE 'credito'
  END                                          AS channel,
  NULLIF(v.forma_pago, 'CONTADO')              AS erp_customer_ref,
  v.sku,
  v.producto,
  v.unidad,
  v.cantidad,
  v.precio_neto,
  v.importe,
  -- Va al FINAL: CREATE OR REPLACE VIEW sólo admite columnas nuevas al final.
  v.doctype
FROM mart.ventas v
WHERE v.sku NOT IN ('00001','00002','00004')        -- pseudo: ventas 0% / devoluciones
  AND v.producto !~* 'devoluc|^tiempo aire$|ventas al [0-9]';  -- summary/no-producto

COMMENT ON VIEW mart.ventas_enriched IS
  'KV.0: mart.ventas + channel + erp_customer_ref + filtro pseudo-productos. Aditiva. K.3: el canal usa doctype (U-D-8 = mayoreo).';
