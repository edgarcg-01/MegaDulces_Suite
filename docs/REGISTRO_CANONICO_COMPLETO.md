# Registro canónico de fuentes únicas — completo

> **Propósito.** Un solo lugar que declara, para cada entidad del dominio de datos de Mega Dulces, **cuál es la fuente de verdad**, cuántas representaciones la copian hoy, quién las escribe, y cuál es el **fix por clase**. Extiende `docs/MODELO_CANONICO_DATOS.md` (7 entidades del core comercial) con los **8 dominios faltantes** (proveedor, banco, almacén, folio/documento, vendedor/chofer, ruta/vehículo, fiscal/CFDI, contable/póliza).
> **Verificado contra prod** (Railway PG18.6, tenant `mega_dulces` `00000000-…-d01c`) el **2026-08-15**.

---

## 1. Resumen ejecutivo

El desync no es un problema; son **tres problemas distintos** que exigen **tres fixes distintos**. Confundirlos es la causa raíz de que "una fuente única" nunca se logre: se aplica el remedio equivocado.

### Las 3 clases

| Clase | Qué es | Síntoma | Fix |
|---|---|---|---|
| **A — atributo-copiado** | Un valor (nombre, precio, costo, stock, estatus) que vive en una maestra y se **copia** a N tablas. | Dos pantallas, dos números para el mismo dato. | **Un feed atómico** escribe **una maestra** (tabla RLS); los demás son **vistas `security_invoker` (PG18)** o refresh materializado — **derivar, no copiar**. |
| **B — dimensión-crosswalk** | La **misma entidad real** (almacén, vendedor, proveedor, ruta, cuenta) representada por **múltiples llaves** que todo joinea. | Códigos que colisionan entre plazas, joins por string que mienten, huérfanos silenciosos. | **Una dim canónica (uuid)** + **tabla crosswalk curada** que mapea cada representación → id canónico + **FK**. Todo join pasa por el crosswalk, nunca por string. |
| **C — convención-de-join** | Una **llave que colisiona** (folio, cfdi_uuid) — no es una copia, es una regla de join mal impuesta. | UPSERT que pisa en silencio; join por folio que trae el doctype equivocado. | **Regla/constraint, NO tabla nueva**: el discriminador (`doc_prefix`, `serie`, `source_branch`) **DEBE** ser parte de toda PK/UNIQUE/JOIN. |

### Conteo de entidades

- **7 previas** (core comercial, `MODELO_CANONICO_DATOS.md`): PRODUCTO, PRECIO, COSTO, EXISTENCIA, CLIENTE, MARCA, VENTAS.
- **25 nuevas** (8 dominios): 4 proveedor · 4 banco · 5 almacén · 4 folio · 2 vendedor/chofer · 4 ruta/vehículo · 6 fiscal · 6 contable *(con solapes deliberados: RFC, CFDI↔póliza y sucursal aparecen en más de un dominio porque son la misma entidad vista desde ángulos distintos)*.

**Distribución por clase (entidades distintas, colapsando solapes):** ~**5 clase A** · ~**16 clase B** · ~**10 clase C**.

**La lección estructural:** la **clase B (dimensión-crosswalk)** es la mayoritaria y la más cara. El **ALMACÉN** (~161 columnas/tablas en 5 namespaces) es la dimensión crítica: si driftea rompe **stock + ventas + reabasto + finanzas a la vez**. Casi todo lo demás depende de que la dim de almacén exista primero.

**Anti-patrón transversal #1:** `kepler_ods.*` y casi todos los feeds Kepler son **UPSERT-only sin propagación de bajas** → identidades muertas (proveedor retirado, SKU descontinuado, sucursal cerrada, póliza cancelada) quedan **vivas para siempre**. ContPAQi sí borra (`goneIds`); Kepler no. Esta asimetría es un riesgo en casi todas las entidades B.

**Anti-patrón transversal #2:** `analytics.*` **NO tiene RLS** (filtro `tenant_id` explícito, olvidable) mientras `finance.*`/`commercial.*`/`logistics.*`/`fiscal.*` sí. Toda vista de reconciliación que cruce esa frontera puede **fugar cross-tenant** si se olvida el filtro.

---

## 2. Registro canónico completo

### 2.A — Clase A: atributo-copiado (una maestra + vistas derivadas)

| Entidad | Fuente de verdad | Representaciones (copias) | Escritor(es) hoy | Riesgo principal |
|---|---|---|---|---|
| **PRODUCTO** | `catalog.products` ← `kepler_ods.kdii` | commercial/analytics que copian nombre/brand | `sync-product-master` (feed atómico) | Copia de nombre/brand a múltiples tablas; staleness UPSERT-only |
| **PRECIO** | `commercial.product_prices` ← `kepler_ods.kdii c90/91/92` + `kdpv` tiers | product_prices snapshots en líneas de pedido | feeds precio (`repoint-catalog-prices --sync`) | Sync ~10-40 min KP_CONCENTRADA; piso c90>0.05 anti-promo |
| **COSTO** | `catalog.products.cost_base` ← `kepler_ods.kdik.c16` | costo copiado en analytics de margen | feed costo | Neto vs bruto (`cost_base`=NETO/`with_tax`=BRUTO) confundibles |
| **EXISTENCIA** | `commercial.stock` (multi-fuente **Kepler ∪ Wincaja**) ← `kepler_ods.kdil` | `inventory.warehouse_stock` (**congelada 2 meses, duplica**), 17 tablas analytics con snapshots | `import-branch-stock-live` + wincaja stock + CEDIS wincaja + overlay app | Dos pantallas, dos números; acople feed-order frágil CEDIS '00' |
| **VENTAS** | `analytics.sales_daily` ← `mart.ventas` (**anclar a REVENUE, no units**) | rollups por vendedor/ruta/marca | `import-sales-fact` + rollups | units inflado ~3.9× desde oct-2025; revenue = verdad |
| **ESTATUS SAT del CFDI** | El SAT (`ConsultaCFDIService`) → `fiscal.cfdis.estatus_sat` | `finance.findings` (regla `cfdi_cancelado`) | `estatus.service` (recibidas) + `emision.service` (emitidas) | Rescan cada 30d → cancelado del proveedor queda "vigente"; no-op si `SAT_ESTATUS_PORT` no ligado |
| **PÓLIZA / asiento Kepler** | Kepler `md.kdc2YYMM` (verdad operativa) | `gl_poliza_lines`(master) + `expense_entries` + `ledger_monthly` + `expense_doc_chain` (**4 re-lecturas**) | `import-kepler-polizas` + `import-expenses-polizas` + `import-ledger-chain` | **Δ 1.1% medido** (fam6: $2,487,630 vs $2,460,375); 1,434 folios cross-sucursal double-count |
| **BALANZA de comprobación** | Debería derivar del detalle de partidas | `ledger_monthly` (Kepler) + `contpaqi_ledger_monthly` (SaldosCuentas) + `gl_polizas` | `import-ledger-chain` + `import-contpaqi-ledger` @2h | Dos agregados independientes a cadencias distintas (@2h vs @1min) |
| **EMISOR fiscal + folio emisión** | `fiscal.issuer_config` + `fiscal.invoice_sequences` (secuencia atómica) | snapshot inmutable en `fiscal.cfdis` (emitidas) | `emision.service` (**DORMIDO**: 0 filas) | Snapshot inmutable = correcto por diseño legal; folio atómico bien hecho — **no tocar** |

### 2.B — Clase B: dimensión-crosswalk (una dim + crosswalk + FK)

| Entidad | Fuente de verdad (dim canónica) | Representaciones a mapear | Escritor(es) hoy | Riesgo principal |
|---|---|---|---|---|
| **MARCA** | `catalog.brands` ← `kepler_ods.kdig` | brand_id copiado; nombres UPPERCASE | feed marca | Normalización UPPERCASE inconsistente |
| **CLIENTE** | `commercial.customers` ← `md.kdud` (falta replicar a `kepler_ods`) | crosswalk `erp_code`; `wincaja.clientes` | `import-erp-customers` (omite c12) + customers-from-excel | c12 vendedor asignado **dormante**; numeraciones disjuntas |
| **ALMACÉN físico** | `commercial.warehouses` (uuid, RLS FORCE) | `commercial.stock`, `kepler_ods.kdil`, `md.kdil`, **17 analytics** (sin FK), 18 commercial (con FK), `inventory.warehouse_stock` (legacy) | ~6 importers con `STOCK_BRANCH_MAP` duplicado | 5 namespaces, ~161 tablas; sin FK/RLS en analytics; `STOCK_BRANCH_MAP` hardcodeado ×6 |
| **SUCURSAL comercial / PdV** | Derivar de `commercial.warehouses` (flag `sells_to_public`) | `store-branches.ts`, `live-tickets-poller BRANCHES`, `import-cash-sessions BRANCH_NAMES`, `users.warehouse_code`, `home_delivery_warehouses` | **3 hardcodes copiados a mano** | Lista+nombres copiados en ≥3 archivos; alta/rename diverge |
| **CAMIÓN de ruta** | `commercial.warehouses` (`kind='truck'`, `RUTA-*`) | `wincaja.branches` (is_route), `sales_daily`(channel wincaja_ruta) | migración seed W.10 + wincaja routes | **5 rutas vecinales huérfanas** (1V*, VEC-PH-H sin warehouse); `owner_user_id` sin FK |
| **TIENDA externa (`store_id`)** | `public.stores` (**dim propia, dominio trade**) | `customers.store_id`, 8 tablas thot/horus/captures/denue | trade / field-ops | Confusión `store_id` vs `warehouse_id` (ambos uuid) → join accidental compila |
| **PROVEEDOR mercantil** | `catalog.suppliers` (uuid; `code`=`kdxd.c2`) | `products.supplier_id`, `erp_supplier_payments.proveedor_code`(c10), `ap_provider.proveedor_norm`, `supplier_discount_policy`, `payment_program`(fuzzy), `wincaja.proveedores`, `contpaqi_suppliers.codigo` | `import-kepler-suppliers` + 8 más | **3 namespaces de código** (kdxd.c2 / kdm1.c10 / ContPAQi.Codigo), CERO FK; merges dejan 9/147 políticas huérfanas |
| **IDENTIDAD FISCAL (RFC) del proveedor** | `analytics.contpaqi_suppliers.rfc` (SoR, 99.6%) + `fiscal.sat_list_rfcs` (EFOS) | `expense_documents.rfc`, `erp_supplier_payments.proveedor_rfc`, `wincaja.rfc`, `supplier_payment_proofs.ocr_rfc`, `sat_list_matches` | contpaqi + kepler + wincaja + fiscal | **`catalog.suppliers` NO tiene RFC**; EFOS = 4 vs 105 según la tabla (**26×**) |
| **BENEFICIARIO de egreso (payee)** | `analytics.expense_documents.beneficiario+rfc` (ledger, **many-to-many name↔rfc**) | `expense_findings.beneficiario`, Neo4j `(:Beneficiario)-[:USA_RFC]->(:Rfc)` | `import-expenses-polizas` + `sync-maat-provider-graph` | Superset del proveedor; texto libre sin llave → arista de colusión perdida (falso negativo forense) |
| **CUENTA bancaria** | `finance.bank_accounts` (20 filas) | `contpaqi_bank_movements.cuenta`(102xxx), `kepler_bank_movements.clave_banco`, `caja_bank_crosswalk`(**vacía**), `payment_program.bank_account_id`, `caja_bancos_catalog` | seed + app | `payment_program` resuelto 31/2716 (1.1%); `caja_bank_crosswalk` 0 filas; `kepler_link` 0/20 |
| **MOVIMIENTO bancario** *(excepción SoR disjuntos)* | **3-4 SoR legítimos**: `finance.bank_movements` (estado cuenta) / `contpaqi_bank_movements` (libros, 151k) / `kepler_bank_movements` (tesorería) / caja | `bank_postings`, `caja_depositos`, `bank_recon_matches` | Excel manual + contpaqi @1min + kepler @1h + nightly | **Excel solo ene y ago** de 8 meses; matching fuzzy ±$1 greedy; bajas heterogéneas |
| **CUENTA contable GL (el "102")** | **2 planes**: `finance.kepler_accounts` (mayor 102 colapsa 18→1) vs ContPAQi (18 cuentas 102xxx inyectivo) | `ledger_monthly.cuenta`, `gl_poliza_lines.cuenta`, `movement_categories.kepler_account` | `import-kepler-accounts` (solo suc '00') + contpaqi | Crosswalk cuenta-bancaria **DEBE** ir por ContPAQi; join por mayor Kepler mezcla 18 cuentas |
| **CUENTA contable / plan** | `finance.dim_cuenta` (a crear) + `cuenta_crosswalk` (Kepler↔ContPAQi↔SAT) | `kepler_accounts`, `contpaqi_ledger_monthly`, `gl_poliza_lines.cuenta_*` copiado ×5 | import-kepler-accounts + contpaqi | Sin crosswalk → reconcilia solo a familia×mes; `afectable` null del lado Kepler |
| **VENDEDOR-ventas** | `analytics.vendor_identity` (crosswalk `(source_branch,vendedor)→canonical`) | `wincaja.vendedores`, `v_sales_lines`, `clientes.vendedor`, `sales_by_vendor_monthly`, `md.kdud.c12`(dormante) | **seed manual en migración** (sin feed) | Crosswalk 3/21 sucursales; código **reusado entre plazas** (75=Sergio PH ≠ Alberto Morelia) |
| **CHOFER / driver-reparto** | `logistics.drivers` (uuid, RLS, FK correctos) | `md.kdm_chofer`, `delivery_guides.driver_id`, `fuel/liquidations/…` FK | `import-logistics-dims` (dedup por nombre, solo md_03) | Dedup por `upper(full_name)` sin crosswalk de código; altas-only |
| **RUTA de venta** | `trade.catalogs` (`catalog_id='rutas'`, uuid) | `stores.ruta_id`, `daily_assignments.route_id`, `vendor_sale_lines.route_id`, `customers.sales_route`(TEXT), `route_tickets.route_code`(número), `sales_by_route_monthly`(4 convenciones) | app trade + 5 feeds | **Dos keyspaces desconectados** (uuid vs códigos); sell-out no joinea a cartera |
| **RUTA de reparto / flete** | `logistics.routes` (`kind='flete'`, code estable) | seed Excel 105 DESTINOS + `md.kdm_rutas` (**conflaciona venta+flete**) | `logistics_baseline` + `import-logistics-dims` | Dos semánticas dedup por NAME; kdm_rutas contamina tabla de flete |
| **VEHÍCULO / unidad flota** | `logistics.vehicles` (plate normalizada) | `md.kdm_transporte`, `config_finance costo_km_*`(keyed-by-descripción), 'MOVIL:NNN' OCR | logistics-fleet + `import-logistics-dims` | costo/km solo 15/84 unidades keyed por descripción sin FK |
| **SUCURSAL / segmento contable** | Dim almacén (owned por dominio ALMACÉN) | `gl_polizas.sucursal` (Kepler c14 real vs ContPAQi '00' consolidado) | import-kepler-polizas + contpaqi | **Colisión del literal '00'**: CEDIS Kepler ≠ consolidado ContPAQi |
| **CFDI recibido** | `fiscal.cfdis` (uuid) — verdad = SAT + ContPAQi AsocCFDIs | `gl_poliza_lines.cfdi_uuid`, `cfdi_assignments`, `cfdi_payment_links` | `cfdi-ingest` + `import-contpaqi-polizas` | **98.7% de UUID de ContPAQi no existen en `fiscal.cfdis`** (descarga: 1 ventana de 17 días) |
| **CFDI emitido** | `fiscal.cfdis` (rol=emitidas) | `commercial.orders.cfdi_uuid`, `emission_errors` | `emision.service` (**0 filas**) + hook commercial | 2 escritores sin trx común; idempotencia solo en `orders.cfdi_uuid` (latente) |

### 2.C — Clase C: convención-de-join (regla/constraint, no tabla)

| Entidad | Regla canónica | Representaciones | Riesgo principal |
|---|---|---|---|
| **FOLIO documento Kepler** | Llave = `(source_branch, doc_prefix, serie, folio)` | `stock_movements`, `erp_supplier_payments`(**doc_prefix EN PK ✓**), `erp_collections`(doc_prefix fuera de PK ✗), `erp_goods_receipts`(fuera ✗) | `collections`/`goods_receipts` **UPSERT pisa en silencio** al añadir 2º doctype |
| **FOLIO pago/entrada proveedor** | `doc_prefix` NOT NULL + en PK | `erp_supplier_payments`(XD2601/2501/6001), `supplier_payment_proofs`(nullable) | 623 folios coexisten XD2501+XD2601; adjunto sin prefix cuelga del doctype erróneo |
| **FOLIO documento bancario** | Todo join banco↔Kepler porta `doc_tipo` | `bank_postings`, `kepler_bank_movements`, `bank_recon_matches`(`kepler_doc_tipo`), `contpaqi_bank_movements` | Mayormente mitigado; matching por importe, no por folio verificable 1:1 |
| **FOLIO póliza / documento** | `(doc_prefix, folio)` llave natural; 'S/F' = marcador | `gl_polizas`(✓), `expense_entries`(✓), `expense_doc_chain` | Join por folio solo colisiona doctypes; 'S/F' colapsa N pólizas de diario |
| **ENLACE cadena documental** | Tripleta `(parent_doc_prefix, parent_serie, parent_folio)` | `stock_movements`(c37/38/39), `erp_goods_receipts`(vale/oc), `erp_purchase_adjustments`(fuzzy) | ship↔rcv por ventana 15d heurístico; XA4001 vs XA2001 comparten folio (GRUPO LEVI 0008231) |
| **FOLIO fiscal CFDI (UUID)** | **UUID = única llave global**; serie/folio = atributos | `fiscal.cfdis`(UNIQUE ✓), `cartaporte_documents`(sin UNIQUE uuid), `AsocCFDIs`(roto G5) | Ligar CFDI↔Kepler por serie/folio colisiona; AsocCFDIs roto → materialidad sin cruce |
| **VÍNCULO CFDI ↔ póliza** | Grano **CFDI-header vs SUMA de patas** (no pata vs total) | `gl_poliza_lines.cfdi_uuid`, `cfdi_assignments`(vacía), heurístico runtime | **465/508 (91.5%) falsos "importe difiere"** por comparar pata vs total |
| **DOCUMENTO / ticket POS Wincaja** | `source_branch` = **partición obligatoria** de la llave | `movimiento_proveedores/clientes`(CR/CC/NP), `erp_goods_receipts`(WCJ-), `stock_movements`(W%), `store_live_tickets` | `stock_movements` mezcla folios Kepler+Wincaja; separador único = `source_branch LIKE 'W%'` |
| **LLAVE/serie ruta POS-analytics** | `(warehouse_id, route_no_norm, source/doc_prefix)` | `sales_by_route_monthly.route_code`(**4 convenciones**: UDxxxx/WIN-NN/WIN-1V/WIN-VEC), `kdm1.c63`, `mart.ventas`, `route_tickets` | serie c63 ≠ ruta empresa; filtro `WIN-%` deja **126 filas UDxxxx invisibles** |
| **NUMERACIÓN de sucursal** | `wincaja.branches.warehouse_code` = `commercial.warehouses.code` | `sales-daily-projection`(CASE), `stock-movements`(UNITS), `wincaja-analytics`, CUTOVER dup ×2 | **11/27 filas `warehouse_code` huérfanas** (MD-10≠'01'); mapeo triplicado hardcodeado |

---

## 3. Las dimensiones crosswalk (clase B) — diseño objetivo

Para cada dimensión: la **dim canónica** que debe ser la única maestra, las **N representaciones** a mapear, y el **mecanismo** (crosswalk table + FK). El patrón es siempre el mismo: **una tabla dim (uuid) + una tabla crosswalk curada `(representación) → canonical_id` con FK + regla dura "todo join pasa por el crosswalk, nunca por string"**.

### 3.1 ALMACÉN — la dimensión crítica (~161 tablas, 5 namespaces)

**Dim canónica:** `commercial.warehouses` (uuid, RLS FORCE, ya existe).

**Los 5 namespaces que colisionan:**
- `warehouse_id` (uuid) — 37 tablas
- `sucursal` ('00'..'05') — 37 tablas
- `source_branch` ('md_00'/'wincaja_XX') — 46 tablas
- `warehouse_code` ('MD-*', 'RUTA-*') — 24 tablas
- `almacen` — 17 tablas

**Diseño objetivo:**
1. Agregar a `commercial.warehouses` **columnas crosswalk explícitas** con UNIQUE por namespace: `kepler_code`, `wincaja_source_branch` (text[] o tabla puente `warehouse_source_branch`), `sucursal_display`, `sells_to_public` (bool). `kind` ya existe.
2. Migrar tablas hijas de `warehouse_code`/`sucursal`/`almacen` (texto) → `warehouse_id` (uuid) + FK compuesta `(tenant_id, warehouse_id)`. En `analytics.*` (sin FK posible), agregar **trigger/CHECK** que valide contra la dim + forzar `tenant_id`.
3. **Reparar `wincaja.branches.warehouse_code`** (11/27 huérfanas: MD-10/40/42/44/54/00, RUTA-1V*, RUTA-VEC-PH-H) o borrar la columna rota y usar `kepler_code` como único puente.
4. **Borrar los 3 mapeos hardcodeados** `source_branch→code` (`sales-daily-projection.js` CASE, `import-wincaja-stock-movements` UNITS, `import-wincaja-analytics`) → reemplazar por JOIN a la dim en un módulo compartido.
5. Centralizar `STOCK_BRANCH_MAP` (hoy default duplicado en ~6 importers) en **un solo módulo/config** + alerta dead-man (el `continue on error` congela stock sin señal).
6. Centralizar constantes **CUTOVER** (fechas de corte Kepler↔Wincaja) en un módulo único.
7. `inventory.warehouse_stock` → **vista sobre `commercial.stock` o drop** (congelada 2 meses, duplica existencia).
8. Constraint: `code 'RUTA-%' ⇔ kind='truck'` y **excluido de agregados de existencia** (vista `commercial.stock_fixed` filtra `kind<>'truck'`).

**Fronteras a sellar:** `public.stores` (PdV externo, trade) ≠ `commercial.warehouses` (almacén propio). Prohibir por lint cualquier join `store_id ↔ warehouse_id`.

### 3.2 PROVEEDOR

**Dim canónica:** `catalog.suppliers` (uuid, `code`=`kdxd.c2`).

**Representaciones a mapear:** `erp_supplier_payments.proveedor_code`(c10), `contpaqi_suppliers.codigo`, `ap_provider.proveedor_norm`, `supplier_discount_policy.proveedor_code`, `payment_program.supplier_id`(fuzzy), `wincaja.proveedores`(por source_branch).

**Diseño objetivo:**
1. Crear **`analytics.supplier_identity`** (crosswalk CURADO, espejo de `analytics.vendor_identity`): `(source_system, key) → supplier_id`. Cubre: `kepler_accounting_code`(c10), `contpaqi_codigo`, `ap_provider.proveedor_norm`, `wincaja(proveedor+source_branch)`.
2. **Un solo normalizer** de razón social (reemplaza los 3 divergentes: `bkey`, `normLight`+trigramas, `normProv`).
3. En `merge-supplier.js`: repuntar **también** las satélites por-código (o rekeyearlas a `supplier_id`). Reparar las **9/147 políticas de descuento huérfanas**.
4. Agregar **identidad fiscal como crosswalk `supplier_rfc (supplier_id, rfc, source, primero_visto)`** — NO columna única, porque un proveedor factura desde N RFC (EFOS shells). Backfill desde ContPAQi (99.6%) + `kdm1.c22` + wincaja, dedup por RFC.
5. **Un ÚNICO cruce EFOS** sobre la UNIÓN de todas las fuentes de RFC contra `fiscal.sat_list_rfcs`, con FK del match a `supplier_id`. **Alarma sobre la brecha 4-vs-105** y sobre pagos programados a RFC en lista 69B.
6. Mantener **beneficiario/RFC como dimensión propia** (no colapsar a proveedor): preserva la relación many-to-many name↔rfc que el forense Maat necesita; arista opcional `beneficiario→supplier_id`.

### 3.3 VENDEDOR-ventas

**Dim canónica:** `analytics.vendor_identity` (hoy seed manual, debe ser feed).

**Representaciones:** `wincaja.vendedores` (21 sucursales), `clientes.vendedor` (rol asignado), `sales_by_vendor_monthly`, `md.kdud.c12` (dormante).

**Diseño objetivo:**
1. Promover a **dim canónica + FEED nightly**: PK `canonical_key`, crosswalk `(source_branch, vendedor, source_system) → canonical_key` con FK.
2. Importer que lea **las 21 sucursales** + `kdud`(c2/c3/c12) y **auto-proponga** matches por nombre; **auto-merge PROHIBIDO** → cola de curación humana para cruces cross-plaza.
3. **Regla dura:** resolver SIEMPRE por `(source_branch, vendedor)`; prohibido joinear por `vendedor` pelón (los códigos se reusan entre plazas).
4. Materializar `canonical_key` en `sales_by_vendor_monthly` (no depender del coalesce en runtime).
5. Centralizar anti-ruido (buckets 00/99, genéricos OMNICANAL/RUTA) en la dim (columna `is_bucket/exclude`); retirar `isNoiseVendor` del servicio.
6. Importar `kdud.c12` → `erp_customers.assigned_vendor_code` para reconciliar Kepler↔Wincaja.

### 3.4 CHOFER / driver

**Dim canónica:** `logistics.drivers` (**ya resuelta en destino**: FK compuestos correctos). Fix en la **ingesta**.

**Diseño objetivo:**
1. Agregar `source_system` + `source_code`(`kdm_chofer.c1`) con **UNIQUE(tenant_id, source_system, source_code)**; cambiar `import-logistics-dims` de dedup-por-nombre → **UPSERT-por-código**.
2. Reconciliar las ~32 altas manuales de la app contra Kepler (cola de match).
3. **Propagar bajas** (`status='inactivo'`), no solo altas.
4. Poblar `driver.user_id` (crosswalk a `public.users`).
5. Ingestar de **N sucursales**, no solo md_03.

### 3.5 RUTA (venta + reparto) y VEHÍCULO

**Dim canónica ruta-venta:** `trade.catalogs`(`catalog_id='rutas'`) con **`code` estable**.
**Dim canónica ruta-flete:** `logistics.routes` con **`kind='flete'`** (separar de kdm_rutas).
**Dim canónica vehículo:** `logistics.vehicles` (plate normalizada).

**Diseño objetivo:**
1. Crear **`route_xref`** (crosswalk): `canonical_route_id ↔ {analytics route_code, wincaja source_branch, kepler serie c63, kdm_ruta R00NN, kduv 1V00N, mart 'ruta_NN'}`. FK-ear `sales_by_route_monthly` y `route_tickets` **a través del xref**.
2. Reemplazar `customers.sales_route` y `vendor_sales_routes.sales_route` (TEXT) por **`route_id` FK** (backfill una vez; texto → vista derivada).
3. **Sacar `kdm_rutas` de `logistics.routes`** (es ruta-venta, pertenece a `trade.catalogs`). Dejar de deduplicar por NAME; linkear flete↔venta por `canonical_route_id`.
4. Vehículo: mover los 15 `costo_km_*` de `config_finance` (keyed-by-descripción) → columna `cost_per_km` en `logistics.vehicles` (FK). Crear **`vehicle_route_assignment(vehicle_id, canonical_route_id, valid_from)`** en vez de `MOVIL:NNN` OCR.
5. Unificar `sales_by_route_monthly` a **UNA convención** (columna `source` + `route_no` limpio) para que `/ventas-por-ruta` no pierda las 126 filas UDxxxx al filtrar `WIN-%`.
6. Mapear serie c63 → ruta con **tabla explícita** (no substring): serie ≠ ruta (base md_01-005 = ruta 27).

### 3.6 BANCO / CUENTA + CUENTA CONTABLE GL

**Dim canónica cuenta bancaria:** `finance.bank_accounts` (20 filas).

**Diseño objetivo:**
1. **Resolver `bank_account_id` EN EL IMPORT** (no en la query) y persistirlo como **FK** en `contpaqi_bank_movements`, `kepler_bank_movements`, `bank_postings`, `payment_program`; dejar `cuenta`/`clave_banco`/`bank_text` solo como columnas-fuente.
2. **Poblar `caja_bank_crosswalk`** (hoy 0 filas); resolver `payment_program.bank_account_id` (hoy 31/2716); marcar 'multi-cuenta/sin resolver' explícito en vez de FK NULL silenciosa.
3. **Regla dura de granularidad:** crosswalk cuenta-bancaria↔GL **SOLO contra ContPAQi 102xxxxxxx** (inyectivo). **Prohibir joins por mayor Kepler 102** (colapsa 18→1). `finance.movement_categories.kepler_account` → FK a `kepler_accounts`.
4. Movimiento bancario = **excepción SoR disjuntos** (como Kepler∪Wincaja): NO colapsar. Construir **vista de reconciliación canónica** keyed por `(bank_account_id, periodo, direccion)` que exponga **delta + cobertura**, distinguiendo 'delta real' de 'Excel sin estado de cuenta ese mes'.

### 3.7 CUENTA contable / plan (Kepler ↔ ContPAQi)

**Dim canónica:** crear `finance.dim_cuenta` + `finance.cuenta_crosswalk`(`kepler_cuenta, contpaqi_cuenta, agrupador_sat, familia, afectable`) curado tipo `vendor_identity` + FK desde toda tabla de hechos. Derivar nombre/mayor/afectable por vista. Poblar `afectable` también del lado Kepler para desbloquear el detector `cuenta_no_afectable`.

### 3.8 RFC / IDENTIDAD FISCAL (coordinar entre PROVEEDOR y FISCAL)

Es **la misma entidad** vista desde dos dominios. **Dim tercero canónica** keyed by `rfc_norm = UPPER(TRIM(rfc))` (columna generada, normalizar UNA vez en ingesta) + crosswalk desde `emisor_rfc`, `expense.rfc`, `contpaqi.rfc`, `wincaja`. Cierra el **57.3% de `expense_documents` sin RFC** vía crosswalk contra `contpaqi_suppliers`, no vía heurística por nombre.

---

## 4. Las convenciones de join (clase C) — la regla que falta

**Principio:** clase C **NO es una tabla nueva**. Es un discriminador que debe ser parte de toda PK/UNIQUE/JOIN. El fix es constraint + lint, no ETL.

### 4.1 Llave canónica de documento Kepler = `(source_branch, doc_prefix, serie, folio)`

**Acción inmediata (constraint):**
- Agregar `doc_prefix` (y `serie` donde aplique) a la **PK de `analytics.erp_collections` y `analytics.erp_goods_receipts`** — hoy PK `(tenant, sucursal, folio)`, para igualar a `analytics.erp_supplier_payments` que ya lo hace bien. **Cierra el landmine de UPSERT-que-pisa** al añadir un 2º doctype.
- `doc_prefix` NOT NULL en `finance.supplier_payment_proofs` + obligatorio en el endpoint attach.
- **Centralizar la derivación de `doc_prefix`** en UN módulo compartido alimentado por el catálogo autoritativo `md.doctype` (género+naturaleza+tipo → code), eliminando los hardcodes/heurísticos por importer (`goods-receipts` 'XA2001', `collections` 'UA0501', `supplier-payments` grupo→XDxx, wincaja 'WCJ-').

**Normalización de folio:** normalizar a forma canónica (texto numérico **sin relleno de ceros**) EN LA INGESTA; retirar el fan-out `padStart(5/6/7/8)` de `folioSearch()` → igualdad exacta.

**Enlace de cadena documental:** persistir tripleta `(parent_doc_prefix, parent_serie, parent_folio)`; materializar FK real documento→documento **UNA vez en el feed** (no re-parear por ventana 15d en cada consulta).

### 4.2 Folio fiscal CFDI = UUID (única llave global)

- Usar **EXCLUSIVAMENTE el UUID** como llave inter-sistema. `serie/folio` del CFDI = atributos, NO join key.
- Agregar **UNIQUE(tenant_id, uuid_fiscal)** a `logistics.cartaporte_documents`.
- Construir crosswalk **explícito** `CFDI(uuid) ↔ documento Kepler`; reparar/reemplazar el join `AsocCFDIs` (G5) roto.

### 4.3 Vínculo CFDI ↔ póliza al grano correcto

- **Agrupar patas** por `(ejercicio, periodo, tipo_pol, folio)` y comparar `SUM(importe con ese cfdi_uuid)` o el total del asiento vs `cfdi.total`. Elimina los **465/508 falsos** "importe difiere" del detector Maat.
- Crear `fiscal.cfdi_poliza_link(source, poliza_key, uuid, match_type=exact|heuristic, confidence)` — exacto desde AsocCFDIs, heurístico marcado. Constraint: un UUID no liga a >1 póliza de gasto.

### 4.4 Partición POS Wincaja obligatoria

- `source_branch` = **partición obligatoria** de toda llave de documento (partición legítima, no redundancia). Todo agregado por folio en `stock_movements` **DEBE** particionar por `source_branch` (folio 100 Kepler ≠ folio 100 Wincaja).

### 4.5 Resolver el literal '00'

- **CEDIS Kepler '00' ≠ consolidado ContPAQi '00'.** Separar: `sucursal='00'` (CEDIS) vs `sucursal='CONS'` o flag `es_consolidado`. FK a la dim canónica de almacén.

---

## 5. Backlog de migración unificado

El orden respeta las dependencias: **primero las dimensiones crosswalk que todo lo demás referencia** (almacén es la raíz), luego las masters clase A (que joinean a las dims), luego las convenciones clase C (constraints que se pueden aplicar en paralelo pero verifican contra las dims ya limpias).

### Fase 0 — Prerrequisitos de replicación (habilitadores)
- **0.1** Replicar a `kepler_ods`: `kdud` (cliente), `kdm_rutas`, `kdm_transporte`, `kdm_chofer`, `kdpord`. Hoy los feeds leen las 6 sucursales EN VIVO o solo md_03 → skew + dependencia LAN.
- **0.2** Añadir **propagación de bajas** (delete-not-seen por ventana) al patrón UPSERT-only en los feeds Kepler críticos (polizas, suppliers, stock, drivers, rutas).
- **0.3** Blindar frontera RLS: helper único que inyecte `tenant_id` en todo join `analytics.* ↔ finance/commercial/fiscal.*`.

### Fase 1 — Dimensión ALMACÉN (raíz; todo depende de ella) 🔥
- **1.1** Columnas crosswalk en `commercial.warehouses` (`kepler_code`, `wincaja_source_branch`, `sucursal_display`, `sells_to_public`) + UNIQUE.
- **1.2** Reparar/eliminar `wincaja.branches.warehouse_code` (11/27 huérfanas).
- **1.3** Centralizar `STOCK_BRANCH_MAP` + constantes CUTOVER en módulos compartidos.
- **1.4** Borrar los 3 mapeos hardcodeados `source_branch→code` → JOIN a la dim.
- **1.5** Migrar tablas hijas a `warehouse_id` + FK; trigger/CHECK en analytics.
- **1.6** `inventory.warehouse_stock` → vista o drop.
- **1.7** Eliminar listas de sucursal copiadas (`STORE_BRANCHES`, `BRANCHES`, `BRANCH_NAMES`) → derivar de la dim.
- **Depende de:** Fase 0. **Bloquea:** stock, ventas, reabasto, finanzas, rutas.

### Fase 2 — Dimensiones crosswalk de personas y flota
- **2.1** `analytics.vendor_identity` seed→feed (21 sucursales) + cola de curación. **Depende de:** 0.1 (kdud).
- **2.2** `logistics.drivers`: source_code UNIQUE + upsert-por-código + bajas. **Depende de:** 0.1 (kdm_chofer).
- **2.3** `route_xref` + separar `logistics.routes` (flete vs venta) + `vehicle_route_assignment`. **Depende de:** 1.x (warehouse_id), 0.1 (kdm_rutas/transporte).
- **2.4** Vehículo: `cost_per_km` a `logistics.vehicles` (matar keyed-by-descripción).

### Fase 3 — Dimensión PROVEEDOR + RFC (dinero + riesgo fiscal)
- **3.1** `analytics.supplier_identity` (crosswalk 3 namespaces de código). **Depende de:** 1.x (source_branch limpio).
- **3.2** Un solo normalizer de razón social.
- **3.3** `merge-supplier.js` repunta satélites por-código; reparar 9/147 huérfanas.
- **3.4** `supplier_rfc` crosswalk (backfill ContPAQi + kdm1.c22 + wincaja).
- **3.5** Cruce EFOS único sobre la UNIÓN de RFC + alarma brecha 4-vs-105.
- **3.6** Beneficiario/RFC como dim propia (many-to-many) con arista opcional a supplier.

### Fase 4 — Dimensión BANCO + CUENTA contable
- **4.1** Resolver `bank_account_id` en el import (FK en analytics bank movements + payment_program).
- **4.2** Poblar `caja_bank_crosswalk`; resolver payment_program (31→2716).
- **4.3** `finance.dim_cuenta` + `cuenta_crosswalk` (Kepler↔ContPAQi↔SAT). **Depende de:** regla granularidad ContPAQi-only.
- **4.4** Resolver literal '00' (CEDIS vs consolidado). **Depende de:** 1.x.
- **4.5** Vista de reconciliación bancaria canónica `(bank_account_id, periodo, direccion)`.

### Fase 5 — Masters clase A (derivar-no-copiar) sobre las dims ya limpias
- **5.1** Unificar fan-out Kepler pólizas: un feed atómico kdc2→`gl_poliza_lines` (own-suc `btrim(c14)=code`, dedup, delete-not-seen); `expense_entries`/`ledger_monthly`/`expense_doc_chain` → vistas `security_invoker`. **Quick-fix inmediato:** aplicar guard `btrim(c14)=code` a `import-kepler-polizas.js` (elimina 1,434 folios duplicados).
- **5.2** PRODUCTO/PRECIO/COSTO/EXISTENCIA/MARCA/VENTAS/CLIENTE: confirmar feed atómico único + vistas derivadas (ya diseñado en `MODELO_CANONICO_DATOS.md`). **Depende de:** 1.x, 3.x.
- **5.3** Dim CFDI canónica `fiscal.cfdis` union-por-precedencia (SAT + backfill ContPAQi AsocCFDIs). Cerrar brecha de descarga masiva (4/5 requests en error). **Depende de:** 3.4 (RFC).

### Fase 6 — Convenciones clase C (constraints; parcialmente paralelizable con Fase 5)
- **6.1** `doc_prefix` en PK de `erp_collections` + `erp_goods_receipts`; NOT NULL en `supplier_payment_proofs`.
- **6.2** Módulo compartido de derivación `doc_prefix` desde `md.doctype`.
- **6.3** Normalizar folio en ingesta; retirar fan-out padStart.
- **6.4** Vínculo CFDI↔póliza a grano header vs SUMA de patas; `cfdi_poliza_link` con confidence.
- **6.5** UNIQUE(uuid_fiscal) en cartaporte; UUID como única llave inter-sistema.
- **6.6** Lint/review: prohibir join por folio sin doc_prefix, por vendedor pelón, por `store_id↔warehouse_id`.

### Fase 7 — Observabilidad
- **7.1** Registrar TODOS los feeds en dead-man switch / `/admin/db-health`.
- **7.2** Checks de desync: cobertura Excel vs ContPAQi vs Kepler por `(cuenta, periodo)`; huérfanos de reconciliación; filas kepler sin `account_label` (923); UUID huérfanos (98.7%); filas UDxxxx invisibles al filtro WIN-; rutas del push sin venta fresca (habría cachado ruta_23/27); vehículos sin costo/km; `customers.sales_route` que no matchea catalogs; brecha EFOS 4-vs-105.

**Grafo de dependencias resumido:**
```
Fase 0 (replicación + bajas + RLS)
   └─> Fase 1 (ALMACÉN — raíz)
          ├─> Fase 2 (vendedor/chofer/ruta/vehículo)
          ├─> Fase 3 (proveedor + RFC)
          └─> Fase 4 (banco + cuenta contable)
                 └─> Fase 5 (masters A: pólizas, producto, CFDI)
                        └─> Fase 6 (convenciones C — constraints)
                               └─> Fase 7 (observabilidad)
```

---

## 6. Modelo de gobierno — cómo se registra una entidad canónica nueva

Toda entidad de datos nueva (o descubierta) **debe** pasar por este flujo antes de que cualquier feed la escriba en más de un lugar.

### 6.1 Clasificar (la pregunta que determina el fix)

1. **¿Es un valor que se copia?** → **Clase A**. Fix: una maestra-tabla-RLS + un feed atómico + derivados = vistas `security_invoker`.
2. **¿Es la misma entidad real con múltiples llaves que todo joinea?** → **Clase B**. Fix: una dim canónica (uuid) + tabla crosswalk curada + FK.
3. **¿Es una llave que colisiona entre tipos?** → **Clase C**. Fix: regla/constraint (discriminador en la PK/join), NO tabla.
4. **¿Son SoR disjuntos legítimos** (ej. Kepler∪Wincaja, los 3 universos de banco)? → **excepción B**: no colapsar; construir vista de reconciliación keyed por la dim + exponer delta + cobertura.

### 6.2 Registrar en este documento
- Agregar fila a la tabla §2 (clase correspondiente): Entidad · Clase · Fuente de verdad · Representaciones · Escritor(es) · Riesgo.
- Si es clase B: agregar sub-sección en §3 con la dim canónica objetivo + crosswalk.
- Si es clase C: agregar la regla en §4.

### 6.3 Reglas duras (no negociables)
- **Un escritor por `(entidad, partición)`.** Si dos feeds escriben la misma tabla con lógica distinta → refactor a un feed + vistas.
- **Derivar-no-copiar:** un derivado es una vista/refresh sobre la maestra, nunca una re-lectura de la fuente cruda.
- **Fuente única = `kepler_ods.*`** si la entidad ya está replicada en prod (no leer md.* en vivo salvo lo aún no replicado).
- **Propagación de bajas obligatoria:** todo feed UPSERT-only debe llevar delete-not-seen por ventana, o documentar explícitamente por qué no (y el riesgo de identidad-muerta-viva).
- **Toda dim B lleva `tenant_id` NOT NULL + RLS** (o filtro explícito verificado en analytics.*).
- **Crosswalk = tabla CURADA, auto-merge PROHIBIDO.** Los matches ambiguos (nombre fuzzy, cross-plaza) van a cola de curación humana; nunca se fusionan automáticamente.
- **Discriminador en la PK:** `doc_prefix`/`serie`/`source_branch` es parte de toda llave de documento; ningún join por folio pelón.
- **Normalizar una vez en ingesta** (RFC, UUID, folio, plate, razón social) con un **normalizer compartido único** por tipo; joinear siempre por la columna normalizada.

### 6.4 Registrar el feed en observabilidad
- Todo feed nuevo entra al **dead-man switch** con su cadencia esperada; un check de cobertura/huérfanos por partición; alarma en `/admin/db-health` cuando driftea.

### 6.5 ADR
- Si la entidad implica una decisión estructural (nueva dim canónica, nuevo SoR, cambio de fuente de verdad), crear **ADR** en `docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md` y referenciarlo aquí.

---

*Fin del registro. Este documento es la memoria canónica de fuentes únicas; se actualiza cada vez que una entidad nueva se clasifica (§6.2) o una dimensión crosswalk se completa (§3).*

---

# Anexo — Crítica adversarial de completitud

Verified against the codebase. Key findings that change the critique: `kepler_ods` exists but is 4 days old (`20260811120000_kepler_ods_schema.js`) and almost no importer reads it — `import-kepler-prices.js` still reads `md.kdpv_prod_util` **live**; box-factor is a real multi-representation entity (`analytics.product_box_factor` + `v_product_box_factor` + `wincaja_product_box_factor` + label source + override); ContPAQi importer genuinely does `goneIds` deletes. Critique below.

---

# Crítica adversarial — Registro canónico de fuentes únicas

## Q1 — Entidades/dimensiones que AÚN faltan (priorizadas)

**P0 — faltan y corrompen dinero/stock hoy:**

1. **UOM / FACTOR-CAJA (conversión de unidad)** — el hueco más grave y no está en el registro. Verificado en prod: vive copiado en `analytics.product_box_factor`, vista `v_product_box_factor`, `wincaja_product_box_factor` (per-almacén), `commercial.product_label_prices`, override del "/N" del nombre, y la etiquetera (`kdii c90/91/92`). Es una **dimensión de conversión (clase B)** de la que dependen EXISTENCIA (Kepler=piezas ∪ Wincaja=unidad-venta), reabasto en cajas (`suppliers.min_order_boxes`, RA.13a), demanda y sales-boxes. Sin esta dim, "un master `commercial.stock`" es una mentira: mezcla unidades no comparables. `factor_purchase` está roto (cajas infladas 10-40×). **Debe ser dim raíz junto con ALMACÉN.**

2. **ARQUEO / CORTE / SESIÓN DE CAJA** — verificado: `analytics.cash_sessions`, `analytics.cash_cuts`, `cash_cuts_desglose`, `store_live_tickets_caja`, `import-cash-sessions/-cuts/-pos-cashiers`, más el sistema Access de arqueo por denominación (caja 20 viva, 70 muerta). Dos SoR de caja disjuntos + el retiro-plug $64M que enmascara descuadre. Es **excepción-B (SoR disjuntos)** con reconciliación por denominación. Ausente del registro; es dinero real.

3. **SALDO ABIERTO — CxC (cobro) + CxP (pago) / aging** — el registro trata pagos y cobros como *movimientos* (erp_supplier_payments, erp_collections) pero NO como **saldo/cuenta-abierta** derivado. Wincaja `movimiento_proveedores` trae `saldo`+`fecha_vencimiento`; RE.3 necesita aging. Es un **derivado clase A** (debe derivar de facturas−pagos), hoy inexistente como entidad canónica → cada pantalla recalcula aging distinto.

**P1 — estructurales:**

4. **USUARIO / PERSONA (identidad que cruza roles)** — el registro trata vendedor, chofer, customer_b2b, repartidor y operador como dimensiones separadas, pero **una persona física puede ser vendedor + chofer + capturista** y todas cuelgan de `public.users` (`users.customer_id`, `users.warehouse_code`, `driver.user_id`). Falta la dim-persona canónica que unifique; hoy `driver.user_id` está sin poblar (lo dice el propio doc §3.4.4). Sin esto, el crosswalk vendedor y el crosswalk chofer se resuelven por separado y nunca se sabe que son la misma persona.

5. **PROMOCIÓN / precio promocional** — `import-erp-promos.js`, `analytics.erp_promotions`, `is_promo`, SKUs $0.01/$0.05, piso `c90>0.05`, promo-solo-rutas. El registro lo menciona como *nota al pie* de PRECIO pero la promo es una entidad con vigencia + ámbito (ruta/plaza) que altera precio y ensucia demanda. Clase B/C (regla de precedencia precio-base vs promo).

6. **FAMILIA / CATEGORÍA contable (fam 1-9)** — distinta de MARCA (`kdig`). Las familias 1-9 gobiernan balanza, ABC-XYZ y P&L. No hay dim de jerarquía de categoría; hoy `fam` es un literal suelto en `ledger_monthly`. Clase B.

**P2:**

7. **LOTE / CADUCIDAD (FEFO, ADR-022)** — entidad diseñada, poca data. Clase B (dim lote) sobre stock. Baja urgencia pero es candy: caduca.
8. **PLANOGRAMA / EXHIBICIÓN** — `in_planogram`, `exhibition_products` (diferido repetidamente). Dominio trade, clase B. Baja.
9. **MÉTODO/FORMA DE PAGO (vocabulario controlado)** — transferencia/cheque/anticipo + forma-pago SAT, aparece en N tablas. Dim menor.

---

## Q2 — Errores de clasificación A/B/C

1. **BALANZA mal clasificada como A.** Hoy NO es "una maestra + vistas": son **dos libros independientes** (`ledger_monthly` Kepler operativo vs `contpaqi_ledger_monthly` fiscal), a cadencias distintas (@2h vs @1min), que deben *reconciliarse, no colapsarse*. Es **excepción-B (SoR disjuntos)**, exactamente como movimiento bancario — el doc es inconsistente en tratar banco como disjunto pero balanza como copia. El Δ1.1% no es drift-de-copia, es diferencia legítima libros-vs-operación.

2. **CFDI recibido mal clasificado como B.** No hay "múltiples llaves para la misma entidad" — el UUID **es** la única llave (eso ya está en §4.2 como clase C). El problema real es doble y ninguno es B: (a) **cobertura de master** — `fiscal.cfdis` está incompleto (descarga masiva = 1 ventana de 17 días → 98.7% de UUIDs de ContPAQi ausentes) = clase A master-incompleto; (b) **regla de join UUID** = clase C. Llamarlo B invita a construir un crosswalk que no se necesita. Corolario: **`fiscal.cfdis` NO es hoy la fuente de verdad de CFDI recibido** — ContPAQi AsocCFDIs tiene más cobertura. El registro nombra un SoR aspiracional, no el real.

3. **EXISTENCIA sobre-simplificada como A pura.** Es A (valor copiado a 17 analytics) **encima de dos B no resueltas (almacén + UOM) y un merge SoR-disjunto (Kepler∪Wincaja)**. Etiquetarla "un master limpio" oculta que el master mezcla piezas y unidades-venta. Debe marcarse "A dependiente de dim-almacén + dim-UOM + reconciliación disjunta".

4. **`store_id` (tienda externa) forzado en B.** `public.stores` ya es una dim única y limpia — no hay múltiples llaves que mapear. El riesgo declarado ("join accidental `store_id↔warehouse_id`") es un problema **clase C (lint/constraint)**, no un crosswalk. Sacarlo de B; dejar solo la regla anti-join en §4.

5. **SUCURSAL/segmento contable** listado en B, pero su riesgo principal (colisión del literal '00' CEDIS-Kepler vs consolidado-ContPAQi) es **clase C** (§4.5). Es la dim-almacén (B) *más* una regla de discriminador (C); está bien pero el fix es C, no B.

---

## Q3 — Orden de dependencias del backlog

**Correcto:** Fase 0→1(almacén)→2/3/4→5→6→7, y almacén-como-raíz. Bien.

**Errores de orden:**

1. **Falta UOM/factor-caja como dim raíz en Fase 1.** La reconciliación de stock Kepler(piezas)∪Wincaja(unidades) es **imposible** sin la dim de conversión. Hoy el backlog planea limpiar almacén y migrar `commercial.stock` a `warehouse_id` sin resolver que los valores no son comparables. UOM debe entrar **Fase 1, en paralelo a almacén** — es co-raíz, no un olvido.

2. **Constraints de corrupción-activa enterradas en Fase 5/6.** El propio doc etiqueta como "acción inmediata" el `doc_prefix` en PK de `erp_collections`/`erp_goods_receipts` (UPSERT que **pisa en silencio** al añadir 2º doctype) y el guard `btrim(c14)=code` (elimina 1,434 folios duplicados / el Δ1.1% de double-count). Son **bugs de pérdida de datos y de números financieros incorrectos EN CURSO**. Ponerlos en Fase 5/6 contradice su propia etiqueta. Deben ser **P0 hotfixes independientes del refactor**, aplicables hoy sin esperar dims.

3. **Observabilidad (Fase 7) al final = migración a ciegas.** Los feeds se cuelgan en silencio (patrón conocido en este proyecto). Registrar feeds en dead-man + checks de huérfanos/cobertura debe ir **Fase 0**, para que las migraciones riesgosas 1-6 tengan red. Mover 7.1 y los checks de orphans al arranque.

4. **RLS-frontier (0.3) es seguridad, no "prerrequisito".** Fuga cross-tenant en `analytics.*` es P0 de seguridad, no un habilitador de ETL. Sepáralo como hotfix propio antes que todo.

5. **Sobre-serialización:** CFDI-coverage (5.3, arreglar descarga masiva SAT 4/5 requests en error) y supplier_identity (3.1, mayormente independiente de almacén salvo la representación wincaja) pueden arrancar en paralelo temprano; no dependen de la cadena almacén.

---

## Q4 — Suposiciones sobre fuentes que probablemente están mal

1. **"Fuente ← `kepler_ods.*`" es aspiracional, no real.** Verificado: `kepler_ods` es un schema de hace 4 días (`20260811120000`) con replicadores, pero **ningún importer productivo lo lee todavía** — `import-kepler-prices.js` lee `md.kdpv_prod_util` en vivo, no `kepler_ods`. El registro declara como fuente de verdad algo que hoy casi nadie consume. La regla de gobierno §6.3 "fuente única = kepler_ods si ya replicada" describe un estado futuro. **Riesgo:** cada fila "← kepler_ods.kdXX" debe auditarse contra qué feed lee realmente; la mayoría siguen leyendo `md.*` live (skew + dependencia LAN).

2. **PRECIO: "kepler_ods.kdii c90/91/92 + kdpv tiers" mal-ubicada.** Los tiers vienen de `md.kdpv_prod_util` (c1=SKU, c3=tier, c4=min_qty) **live**, y el hint confirma que kepler_ods NO tiene kdpv. La fuente declarada (kepler_ods) es incorrecta para el componente de tiers; y `kdii c90/91/92` es la **etiquetera**, no el precio de venta transaccional (que sale de KP_CONCENTRADA/mart). Dos fuentes distintas colapsadas en una fila.

3. **`fiscal.cfdis` como "fuente de verdad" de CFDI — falso hoy.** Solo tiene 17 días de descarga; ContPAQi AsocCFDIs cubre más. La fuente de verdad *real* actual es ContPAQi. Declarar fiscal.cfdis como SoR sin marcar que está 98.7% vacío es engañoso.

4. **RFC-via-ContPAQi asume un match que no existe aún.** El backfill de `supplier_rfc` (3.4) desde ContPAQi 99.6% requiere el crosswalk `contpaqi_codigo↔supplier_id` — que es el match **más difícil** (namespaces disjuntos: `kdxd.c2` ≠ `ContPAQi.Codigo`). Dependencia circular no capturada: 3.4 depende de que 3.1 ya haya resuelto el match ContPAQi, que es precisamente lo incierto. Igual para "cerrar 57.3% de expense sin RFC vía crosswalk" — beneficiario es texto-libre many-to-many; el cierre por crosswalk será parcial, no 57.3%.

5. **VENTAS ← `mart.ventas` como fuente única — probablemente incompleta.** Ventas son Kepler ∪ Wincaja con CUTOVER; si `mart.ventas` es una sola fuente, "anclar a revenue" no cierra el seam multi-fuente. Verificar que mart.ventas ya unifica ambos SoR o es solo Kepler.

6. **"ContPAQi 18 cuentas 102xxx inyectivo y usable para crosswalk" — parcialmente falso.** Egresos/Cheques de ContPAQi están muertos desde 2019; el ledger vivo son movs de póliza en 102xxx. Asumir las 18 cuentas usables para el crosswalk bancario puede fallar en las cuentas muertas.

7. **"EXISTENCIA = un master `commercial.stock`" asume unidad consistente** — es la misma trampa del punto Q2.3/Q1.1: sin UOM, el master silenciosamente mezcla piezas y unidades-venta por almacén.

**Suposición que SÍ verifiqué correcta:** "ContPAQi sí borra (goneIds), Kepler no" — confirmado en `import-contpaqi-bank-movements.js` (líneas 62-118, DELETE de goneIds). La asimetría UPSERT-only es real.

---

## Lista consolidada priorizada de gaps

| # | Gap | Tipo | Acción |
|---|---|---|---|
| **1** | **UOM/factor-caja ausente** como dim canónica | Falta entidad (B) + orden | Añadir dim UOM co-raíz en Fase 1; sin ella stock/reabasto/demanda mienten |
| **2** | **doc_prefix en PK + guard btrim(c14)** enterrados en Fase 5/6 | Orden | Sacar a **P0 hotfix hoy** — pérdida de datos y Δ1.1% financiero en curso |
| **3** | **RLS-frontier analytics.\*** como prerrequisito | Orden/seguridad | P0 de seguridad, separar antes de todo |
| **4** | **`kepler_ods` declarado como fuente pero casi nadie lo lee** | Suposición | Auditar cada "← kepler_ods.kdXX" vs feed real; la mayoría lee md.* live |
| **5** | **BALANZA mis-clasificada A** (son 2 libros) | Clase | Reclasificar a excepción-B (SoR disjuntos), como banco |
| **6** | **CFDI recibido mis-clasificado B**; `fiscal.cfdis` no es el SoR real | Clase + suposición | Reclasificar A(cobertura)+C(UUID); marcar ContPAQi como SoR de facto |
| **7** | **ARQUEO/corte de caja ausente** ($64M plug enmascara) | Falta entidad | Excepción-B, reconciliación por denominación |
| **8** | **SALDO/aging CxC+CxP ausente** como derivado canónico | Falta entidad (A) | Necesario para RE.3/tesorería |
| **9** | **USUARIO/PERSONA cross-rol ausente** | Falta dim (B) | Unifica vendedor+chofer+repartidor; `driver.user_id` sin poblar |
| **10** | **PRECIO: fuente/tiers mal ubicados** (kdpv es md.* live, no kepler_ods) | Suposición | Separar etiquetera (kdii) de precio transaccional (mart/KP) |
| **11** | **EXISTENCIA sobre-simplificada A pura** | Clase | Etiquetar "A sobre B(almacén)+B(UOM)+merge disjunto" |
| **12** | **Circularidad RFC↔supplier_identity** no capturada | Orden | 3.4 depende del match más difícil de 3.1; marcar riesgo |
| **13** | **Observabilidad (Fase 7) al final** | Orden | Front-load dead-man + orphan checks a Fase 0 |
| **14** | **PROMOCIÓN / FAMILIA contable** ausentes | Falta entidad | Promo=B/C precedencia; familia 1-9=B jerarquía |
| **15** | **`store_id` forzado en B** | Clase | Es dim limpia; su riesgo es C (lint anti-join), sacar de B |

Ruta crítica corregida: **P0 hotfixes (doc_prefix PK, btrim guard, RLS-frontier) → Fase 0 (replicación + bajas + observabilidad) → Fase 1 (ALMACÉN + UOM co-raíz) → resto**. El documento es sólido en el marco A/B/C y en identificar almacén como raíz; sus dos fallas mayores son (a) **omitir UOM como segunda raíz** y (b) **posponer constraints que están corrompiendo datos hoy**.

---
*Generado por workflow canonical-registry-full (10 agentes, 2026-08-15).*
