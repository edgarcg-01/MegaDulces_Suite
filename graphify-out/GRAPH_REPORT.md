# Graph Report - .  (2026-07-09)

## Corpus Check
- 54 files · ~56,821 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 347 nodes · 369 edges · 55 communities (36 shown, 19 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.71)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Docker kepler_consolidado (localhost:543
- mega_dulces_sync.js
- kdii (maestro de productos)
- doctype (taxonomía maestra de documentos
- concentrate-kepler.js
- import-ledger-chain.js
- install-service.js
- import-expenses-polizas.js
- live-tickets-poller.js
- run-prod-feeds.js
- import-ap-findings.js
- import-kardex.js
- Cuenta 511 COMPRAS
- import-cash-cuts.js
- import-kepler-warehouse-stock.js
- import-label-data.js
- import-pos-cashiers.js
- import-catalog-bulk.js
- import-computed-reorder.js
- import-expense-requests.js
- import-kepler-stock.js
- import-pos-ticket-sales.js
- railway-product-prices-by-sku.js
- railway-stock-by-sku.js
- import-kepler-prices.js
- import-kepler-rotation.js
- import-transfers-monthly.js
- kdud (maestro de clientes)
- import-prices-bulk.js
- import-erp-customers.js
- import-erp-promos.js
- import-erp-shipments.js
- import-kepler-suppliers.js
- import-product-sales-daily.js
- import-product-sales-monthly.js
- import-rotation-from-consolidado.js
- import-sales-by-route-monthly.js
- uninstall-service.js
- sync-inventory-from-erp.js
- kdpord (pedidos / embarques con estado)
- import-branch-stock-live.js
- import-brands-lineas.js
- import-customer-sales.js
- import-inventory-health.js
- import-kepler-uom-categories.js
- import-logistics-dims.js
- import-margin.js
- import-ph-stock-live.js
- import-reorder-policy.js
- import-sales-fact.js
- import-sales-stats.js
- import-top-sellers-from-consolidado.js
- Réplicas por sucursal (md_00..md_05, mis
- kdxd (catálogo de proveedores CXP)
- kdmx_25/kdmx_26 (store XML CFDI timbrado

## God Nodes (most connected - your core abstractions)
1. `main()` - 14 edges
2. `kdii (maestro de productos)` - 12 edges
3. `withTenantTx()` - 9 edges
4. `doctype (taxonomía maestra de documentos)` - 9 edges
5. `clean()` - 7 edges
6. `Docker kepler_consolidado (localhost:5433, mart.ventas FDW)` - 6 edges
7. `qid()` - 5 edges
8. `tick()` - 5 edges
9. `kdil (existencia por sucursal×almacén)` - 5 edges
10. `kdik (valuación y costo por sucursal×SKU)` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Sync nocturno BullMQ + tablas espejo` --semantically_similar_to--> `run-prod-feeds.js (orquestador de feeds a prod)`  [INFERRED] [semantically similar]
  docs/IMPLEMENTACION/FASES/FASE_B_INTEGRACION_KEPLER.md → docs/IMPLEMENTACION/RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md
- `kdmm (tipos de movimiento/documento)` --conceptually_related_to--> `doctype (taxonomía maestra de documentos)`  [INFERRED]
  docs/IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md → docs/IMPLEMENTACION/KEPLER_CATALOGO_TABLAS.md
- `postgres_fdw (Foreign Data Wrapper)` --semantically_similar_to--> `KP_CONCENTRADA (ODS concentrado kp.*)`  [INFERRED] [semantically similar]
  docs/IMPLEMENTACION/FASES/FASE_B_INTEGRACION_KEPLER.md → docs/IMPLEMENTACION/RUNBOOKS/KP_CONCENTRADA.md
- `Mapeo kdii.c1 == public.products.sku` --references--> `kdii (maestro de productos)`  [EXTRACTED]
  docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md → docs/IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md
- `import-kepler-stock.js (importer de stock)` --references--> `kdil (existencia por sucursal×almacén)`  [EXTRACTED]
  docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md → docs/IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cálculo de existencia Kepler (inicial + entradas − salidas)** — docs_implementacion_kepler_tablas_completo_kdil, docs_implementacion_kepler_tablas_completo_kdik, docs_implementacion_kepler_tablas_completo_existencia_kdil_formula, docs_implementacion_kepler_tablas_completo_existencia_kdik_formula, docs_implementacion_kepler_tablas_completo_existencia_concepto [EXTRACTED 1.00]
- **Política de reorden kdii (c33 mínimo / c34 reorden / c35 máximo)** — docs_implementacion_kepler_tablas_completo_kdii, docs_implementacion_kepler_tablas_completo_kdii_reorder_cols, docs_implementacion_kepler_tablas_completo_kdpv_prod_util [EXTRACTED 1.00]
- **Taxonomía de documentos e interpretación de venta real** — docs_implementacion_kepler_catalogo_tablas_doctype, docs_implementacion_kepler_catalogo_tablas_doctype_codigo, docs_implementacion_kepler_tablas_completo_kdm1, docs_implementacion_kepler_tablas_completo_kdm2, docs_implementacion_kepler_tablas_completo_kdij, docs_implementacion_kepler_tablas_completo_venta_real [EXTRACTED 1.00]
- **Ciclo contable de compra (511→201→102/513)** — docs_implementacion_kepler_contabilidad_modelo_cuenta_511_compras, docs_implementacion_kepler_contabilidad_modelo_cuenta_201_proveedores, docs_implementacion_kepler_contabilidad_modelo_doctypes, docs_implementacion_kepler_contabilidad_modelo_ciclo_compra [EXTRACTED 1.00]
- **Pipeline de consolidación Kepler → Prod** — docs_implementacion_runbooks_kp_concentrada_branch_dbs, docs_implementacion_runbooks_kepler_consolidado_prod_docker_kepler_consolidado, docs_implementacion_runbooks_kepler_consolidado_prod_run_prod_feeds, docs_implementacion_runbooks_kepler_consolidado_prod_pipeline [EXTRACTED 1.00]
- **Flujo KV: consolidación → fact de venta → inteligencia** — docs_implementacion_fases_fase_kv_explotacion_kepler_mart_ventas_enriched, docs_implementacion_fases_fase_kv_explotacion_kepler_import_sales_fact, docs_implementacion_fases_fase_kv_explotacion_kepler_sales_daily, docs_implementacion_fases_fase_kv_explotacion_kepler_inventory_health [EXTRACTED 1.00]

## Communities (55 total, 19 thin omitted)

### Community 0 - "Docker kepler_consolidado (localhost:543"
Cohesion: 0.11
Nodes (24): Fase B — Integración ERP Kepler (DEFERRED), postgres_fdw (Foreign Data Wrapper), Sync nocturno BullMQ + tablas espejo, import-sales-fact.js, analytics.inventory_health (demanda/reabasto), md.kdpord (embarques ERP), md.kdpv_prod_util (margen/markup por SKU), mart.ventas_enriched (vista, kepler_consolidado) (+16 more)

### Community 1 - "mega_dulces_sync.js"
Cohesion: 0.23
Nodes (20): buildSourceKnex(), buildTargetKnex(), clean(), knexLib, main(), MD_WAREHOUSE_CODES, parseArgs(), PRICE_LISTS (+12 more)

### Community 2 - "kdii (maestro de productos)"
Cohesion: 0.15
Nodes (18): import-kepler-stock.js (importer de stock), Mapeo kdii.c1 == public.products.sku, Existencia (inventario disponible), kdik existencia = c4 + c5 − c6, kdil existencia = c4 + c8 − c9, kdid (catálogo de unidades de medida), kdie (catálogo de departamentos/giros), kdif (catálogo de líneas de producto) (+10 more)

### Community 3 - "doctype (taxonomía maestra de documentos"
Cohesion: 0.16
Nodes (17): Write-back de inventario físico (Fase I → Kepler), doctype (taxonomía maestra de documentos), Código de documento {género}{naturaleza}{grupo}{tipo}, Género X (compras) vs N (inventario/traspaso) vs U/S (ventas), InvIn1 (NA2002) entrada de inventario / sobrante, InvOut1 (ND0502) salida de inventario / merma, InvTrsf1 (ND2501) traspaso entre sucursales, kdco (catálogo de conceptos contables) (+9 more)

### Community 4 - "concentrate-kepler.js"
Cohesion: 0.18
Nodes (13): APPLY, { Client }, copyRows(), CREATE_DB, ensureDatabase(), ensureDestTable(), EXCLUDE, FULL (+5 more)

### Community 5 - "import-ledger-chain.js"
Cohesion: 0.20
Nodes (3): APPLY, { Client }, MONTHS

### Community 6 - "install-service.js"
Cohesion: 0.20
Nodes (9): cfg, ENV_PATH, fs, LOG_DIR, path, problems, SCRIPT, { Service } (+1 more)

### Community 7 - "import-expenses-polizas.js"
Cohesion: 0.22
Nodes (4): APPLY, AREA_ALIASES, { Client }, MONTHS

### Community 8 - "live-tickets-poller.js"
Cohesion: 0.42
Nodes (8): { Client }, DRY, pad(), pollBranch(), push(), sinceLocalMX(), startOfTodayMX(), tick()

### Community 9 - "run-prod-feeds.js"
Cohesion: 0.22
Nodes (6): APPLY, DIR, K, path, { spawn }, STEPS

### Community 10 - "import-ap-findings.js"
Cohesion: 0.25
Nodes (3): APPLY, { Client }, MONTHS

### Community 11 - "import-kardex.js"
Cohesion: 0.32
Nodes (6): APPLY, claseMov(), { Client }, knexLib, num(), readBranch()

### Community 12 - "Cuenta 511 COMPRAS"
Cohesion: 0.29
Nodes (8): md.kdud (maestro de clientes Kepler), Ciclo de compra contable, Ciclo de inventario periódico / COGS, Cuenta 201 PASIVO A PROVEEDORES, Cuenta 401 VENTAS, Cuenta 511 COMPRAS, Cuenta 999 PRESUPUESTOS (cuenta puente), import-expenses-polizas.js (importer egresos)

### Community 13 - "import-cash-cuts.js"
Cohesion: 0.33
Nodes (5): APPLY, { Client }, knexLib, num(), readBranch()

### Community 14 - "import-kepler-warehouse-stock.js"
Cohesion: 0.29
Nodes (5): APPLY, BRANCH, { Client }, DST_URL, WAREHOUSE

### Community 16 - "import-pos-cashiers.js"
Cohesion: 0.33
Nodes (5): APPLY, clean(), { Client }, knexLib, readBranch()

### Community 17 - "import-catalog-bulk.js"
Cohesion: 0.33
Nodes (3): APPLY, { Client }, COLS

### Community 18 - "import-computed-reorder.js"
Cohesion: 0.33
Nodes (5): APPLY, { Client }, CYCLE_DAYS, LEAD_DEFAULT, SAFETY_DAYS

### Community 19 - "import-expense-requests.js"
Cohesion: 0.33
Nodes (3): APPLY, { Client }, TODAY

### Community 20 - "import-kepler-stock.js"
Cohesion: 0.33
Nodes (4): APPLY, BRANCH, { Client }, WAREHOUSE

### Community 21 - "import-pos-ticket-sales.js"
Cohesion: 0.33
Nodes (3): APPLY, { Client }, knexLib

### Community 22 - "railway-product-prices-by-sku.js"
Cohesion: 0.53
Nodes (5): fs, knexLib, main(), parseArgs(), parseCsv()

### Community 23 - "railway-stock-by-sku.js"
Cohesion: 0.53
Nodes (5): fs, knexLib, main(), parseArgs(), parseCsv()

### Community 24 - "import-kepler-prices.js"
Cohesion: 0.40
Nodes (4): APPLY, { Client }, LIST_ORDER, PRESENT_PREF

### Community 25 - "import-kepler-rotation.js"
Cohesion: 0.40
Nodes (3): APPLY, bi, { Client }

### Community 26 - "import-transfers-monthly.js"
Cohesion: 0.40
Nodes (4): APPLY, { Client }, RESET, yi

### Community 27 - "kdud (maestro de clientes)"
Cohesion: 0.40
Nodes (5): kdud (maestro de clientes), kdue (cuentas por cobrar), kduj (catálogo de rutas de venta), kduk (catálogo de zonas de venta), kduv (maestro de vendedores)

### Community 28 - "import-prices-bulk.js"
Cohesion: 0.50
Nodes (3): APPLY, { Client }, PLS

### Community 30 - "import-erp-promos.js"
Cohesion: 0.50
Nodes (3): APPLY, { Client }, SRCS

### Community 31 - "import-erp-shipments.js"
Cohesion: 0.50
Nodes (3): APPLY, { Client }, DATE_COL

### Community 33 - "import-product-sales-daily.js"
Cohesion: 0.50
Nodes (3): APPLY, { Client }, di

### Community 34 - "import-product-sales-monthly.js"
Cohesion: 0.50
Nodes (3): APPLY, { Client }, yi

### Community 36 - "import-sales-by-route-monthly.js"
Cohesion: 0.50
Nodes (3): APPLY, { Client }, yi

### Community 37 - "uninstall-service.js"
Cohesion: 0.50
Nodes (3): path, { Service }, svc

### Community 38 - "sync-inventory-from-erp.js"
Cohesion: 0.83
Nodes (3): knexLib, main(), parseArgs()

### Community 39 - "kdpord (pedidos / embarques con estado)"
Cohesion: 0.50
Nodes (4): kdm_chofer (catálogo de choferes), kdm_rutas (catálogo de rutas de distribución), kdm_transporte (flota de vehículos), kdpord (pedidos / embarques con estado)

## Knowledge Gaps
- **162 isolated node(s):** `{ Client }`, `APPLY`, `FULL`, `CREATE_DB`, `{ Client }` (+157 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Póliza contable (kdc2YYMM)` connect `Docker kepler_consolidado (localhost:543` to `Cuenta 511 COMPRAS`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `import-expenses-polizas.js (importer egresos)` connect `Cuenta 511 COMPRAS` to `Docker kepler_consolidado (localhost:543`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Are the 10 inferred relationships involving `kdii (maestro de productos)` (e.g. with `kdid (catálogo de unidades de medida)` and `kdie (catálogo de departamentos/giros)`) actually correct?**
  _`kdii (maestro de productos)` has 10 INFERRED edges - model-reasoned connections that need verification._
- **What connects `{ Client }`, `APPLY`, `FULL` to the rest of the system?**
  _162 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Docker kepler_consolidado (localhost:543` be split into smaller, more focused modules?**
  _Cohesion score 0.11231884057971014 - nodes in this community are weakly interconnected._