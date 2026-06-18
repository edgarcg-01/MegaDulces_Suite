# Changelog

> Cambios notables del repo Trade Marketing. Vivo como complemento de
> [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) (detalle de sprints) y
> [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) (kanban). Este archivo es para "¿qué cambió las últimas N semanas?" sin abrir git log.
>
> Convención: secciones por fecha (más reciente arriba). Cada release agrupa por **Added / Changed / Fixed / Deprecated / Removed / Internal**. Actualizar al cerrar sprint o feature relevante.

---

## [Unreleased]

### Added — Inventario físico: reason-codes de varianza (P1)
- **Clasificación estructurada del motivo de varianza** al resolver un item (merma / caducado /
  dañado / robo / error_conteo / error_sistema / devolución / transferencia / encontrado / otro)
  en vez de solo `notes` libre. `caducado` es clave para dulcería. Taxonomía validada a nivel
  servicio (`VARIANCE_REASONS`), extensible sin migración.
- **Migración `20260618180000`**: columna `reason_code` en `inventory_count_items` y propagada al
  **ledger** (`commercial.stock_movements` + `inventory.warehouse_stock_movements`) → analytics/IRA
  podrán agregar shrinkage por causa sin re-joinear los items del folio.
- **Endpoint** `GET /commercial/inventory/counts/variance-reasons` (gate SUPERVISAR) para el dropdown.
- **Frontend**: el dialog "Resolver item" (`/comercial/inventory/sessions/:id`) ahora tiene un
  selector de motivo (`p-select`) + nota de detalle; la clasificación persiste y sobrevive a
  re-computar discrepancias. Smoke I.5 extendido (catálogo + persistencia de `merma`).
- Habilita el siguiente P1 (KPI de IRA + dashboard de shrinkage por causa).

### Added — Inventario físico: ledger auditable + costo en modo `inventory` (P1/A3)
- **Nueva tabla `inventory.warehouse_stock_movements`** (mig `20260618170000`): bitácora append-only
  por SKU, espejo de `commercial.stock_movements` para el mundo `inventory.*` (RLS forzado, grant
  `app_runtime`). La reconciliación de folios en **modo inventory** ya **deja rastro** (`adjust` con
  before/after, `reference_type=inventory_count`) — antes ajustaba `inventory.warehouse_stock` sin
  auditoría.
- **`getProgress.value_at_variance` deja de salir $0 en modo inventory**: costo proxy derivado de
  `inventory.products` (`venta_valor_costo_anual / venta_unidad_anual`), con fallback a
  `catalog.products.cost_base`. El supervisor ya ve el $ en riesgo en folios inventory-source.
- Pendiente: test E2E del modo inventory (el smoke I.5 cubre modo commercial). Ver `FASE_I_INVENTARIO.md` §I.5.

### Fixed — Inventario físico (conteo): endurecimiento de correctness (P0)
- **Freeze integrity guard en `reconcile`**: si el almacén no quedó congelado y hubo movimientos
  de stock desde que se abrió el folio, la reconciliación (set absoluto al físico) **borraba esas
  ventas**. Ahora `reconcile` **bloquea** con error claro si detecta `stock_movements` (ref ≠
  `inventory_count`) desde `started_at` (modo `commercial`).
- **`computeDiscrepancies` ya no revierte resoluciones manuales**: re-correr "calcular
  discrepancias" devolvía items `resolved`→`discrepancy` (bloqueando el reconcile) y pisaba
  overrides del supervisor. Ahora salta los `resolved`.
- **Segregación en el 3er conteo (desempate)**: `submitCount` rechaza `count_3` de quien ya hizo
  `count_1`/`count_2` de ese SKU (antes solo `count_2` tenía segregación).
- Verificado en LOCAL que `inventory_count_items.product_id` es nullable + FK dropeada (modo
  `inventory`). **Pendiente confirmar en prod**. Roadmap P1/P2 en `FASE_I_INVENTARIO.md` §I.5.

### Fixed — Stock: freeze guard en `release` + error claro al entregar sin físico
- **`OrderStockService.release` ahora respeta el freeze guard** (`assertNotFrozen`), igual que
  `reserve`/`consume`. Antes, con un conteo físico congelado (`freeze_movements`), cancelar /
  borrar / reducir-línea de un pedido **sí movía `reserved_quantity`** a media cuenta y falseaba
  la varianza. **Cambio de comportamiento:** esas acciones ahora devuelven **409** mientras el
  almacén tenga un folio de inventario abierto (intencional — el conteo es breve, se reintenta al cerrar).
- **`OrderStockService.consume`**: si el físico no alcanza al entregar (caso preventa, que no
  reserva al confirmar por diseño), rebota con **409 claro** en vez de la violación cruda de
  `CHECK quantity>=0`. No cambia el diseño de preventa.

### Removed — Scanners de alertas huérfanos (split L.7 abortado)
- Borrados `commercial-alerts/low-stock-scanner.service.ts` y `vip-inactive-scanner.service.ts`:
  nunca se registraron como providers (sus `@Cron` jamás corrieron). `AlertsScannerService` queda
  como única fuente de `low_stock` + `vip_inactive` (gateado por `ENABLE_COMMERCIAL_ALERTS`).
  Elimina el footgun de doble emisión. Ver `FASE_L_SCHEMA_REORG.md` §L.7.

### Added — CM.6 · "Productos más frecuentes" por tienda en el Mapa Comercial
- En el detalle de tienda (`/dashboard/commercial-map`), nueva sección con los **productos que más
  aparecen en las capturas de esa tienda** (`daily_captures.exhibiciones[].productosMarcados`):
  ranking por **en cuántas visitas apareció** (+ veces marcado). Backend
  `GET /commercial-map/stores/:id/top-products` (gate `COMMERCIAL_MAP_VER`, store-céntrico
  tenant+zona). Smoke extendido.
- **Decisión de fuente:** se evaluó el ERP Kepler (`ventas.tercero_id`) pero las tiendas auditadas
  **no cruzan** con los clientes de venta del ERP (0/35 por código, ~7/35 por nombre — universos
  distintos: PdV de trade vs terceros-persona del ERP). Por eso la fuente son las **capturas** (sí
  ligadas a la tienda por `store_id`). Se revirtió la maquinaria ERP/Thot explorada (feature
  `customer_product_history` + señal de historial en `thot.suggest`): con 3.4% de linkage no
  aportaba. Thot queda igual.

### Added — CM.5 · Superbuscador de productos en el Mapa Comercial + ruta de la tienda
- **Endpoint `GET /commercial-map/product-presence`** (gate `COMMERCIAL_MAP_VER`): dado `q`
  (contains ILIKE sobre nombre/sku/barcode) **o** `product_ids` (CSV, ej. del matcher IA),
  devuelve las **tiendas y las visitas** donde esos productos aparecen en
  `exhibiciones[].productosMarcados` (contención JSONB `@>`, GIN-friendly). Store-céntrico
  (tenant + zona, sin filtro own/team); cada visita trae `matchedProducts`. Coord híbrida.
- **Frontend**: superbuscador en `/dashboard/commercial-map` con toggle **"Inteligente"** —
  ON interpreta el texto vía matcher IA Fase K (`/api/ai/products/match-ai`, Voyage) → product_ids
  → presencia, con **fallback automático a contains** si la IA no da match o no está disponible.
  Al buscar, el **mapa se filtra** a las tiendas con el producto (resaltadas) y un **panel de
  resultados** lista cada tienda (con su ruta) → visitas donde apareció (folio/fecha/vendedor +
  productos que matchearon); clic en tienda abre su historial; botón "Limpiar".
- **Ruta de la tienda** ahora en la info: `getStoreHistory` devuelve `store.ruta` (join a
  `catalogs`), mostrada en el detalle de la tienda y en el header del dialog de visita.
- Smoke `http-commercial-map-test.js` extendido (product-presence por ids y por `q` + ruta).
  **Requiere reinicio de la API** para registrar la ruta nueva (HMR no re-registra rutas).

### Added — Fase I.4 · Asignación de personas a un folio de inventario
- **Permiso `COMMERCIAL_INVENTORY_ASIGNAR`** (enum BE+FE, ability.factory, permission-meta, seed + backfill a superadmin/admin/supervisor). Quién puede asignar contadores/supervisores a un folio.
- **Migración `20260615160000`**: `commercial.inventory_count_assignments` (count_id, user_id, assignment_role counter|supervisor, assigned_by; RLS; FK cascade al folio).
- **Backend** (endpoints en `/commercial/inventory/counts`): `GET assignable-users?role=` (usuarios cuyo rol tiene CONTAR/SUPERVISAR), `GET :id/assignments`, `POST :id/assignments` (reemplaza la lista de un rol), `GET mine` (folios que el contador puede contar). **Opt-in por folio**: si un folio tiene contadores asignados, `submitCount` solo deja contar a ellos; si no tiene ninguno, queda abierto (compat). El contador ahora ve solo sus folios (o los abiertos).
- **Frontend**: en el detalle del folio (`/comercial/inventory/sessions/:id`), panel con dos MultiSelect — **Contadores** y **Supervisores** asignados (guarda al cerrar el panel). Visible solo con permiso ASIGNAR. La página de Conteo usa `mine` (cada contador ve lo que le toca).

### Added — Reporte de stock muerto (capital parado)
- **Backend** `GET /commercial/analytics/dead-stock?warehouse_id=&limit=` (gate ORDERS_VER): existencia > 0 sin venta en **90 días** (`sales_units_90d = 0` estricto — NULL = rotación no computada, no se reporta) → capital parado al costo, items + resumen por almacén. Usa `catalog.products` (la vista public no expone rotación). Migración `20260615150000` agrega `sales_units_90d`; el feed de rotación Kepler ahora lo persiste (ventana 90d evita falsos positivos estacionales como el aguinaldo navideño que 30d marcaba). KEPLER-03: **473 SKUs / $1.22M parado**.
- **Frontend** página `/comercial/dead-stock` ("Stock muerto", nav, icono alerta): KPIs (capital parado / SKUs), resumen por almacén, tabla densa (almacén/SKU/producto/marca/rotación/existencia/costo/capital) con filtro por almacén y paginación. Accionable para compras (liquidar / dejar de surtir).

### Added — Write-back de Fase I → formato de ajuste Kepler (export)
- Endpoint `GET /commercial/inventory/counts/:id/kepler-export` (gate RECONCILIAR): toma un folio de inventario **reconciliado** y emite el ajuste en formato Kepler — sucursal (de `KEPLER-NN`), y por cada varianza: `InvOut` (merma, variance<0) / `InvIn` (sobrante, variance>0) con cantidad, unidad, costo y valor; summary merma/sobrante/neto. Mapeo descifrado de `doctype`: PhysInv (ND3001) / InvIn (NA2002) / InvOut (ND0502). **No escribe en el ERP** (producción, header 200 cols, import desconocido) — produce el documento para importar/capturar. Validado: AGUA −4→InvOut $9.93, CHURRO +5→InvIn $22.68.

### Added — Proveedores reales de Kepler → suppliers + products.supplier_id
- **Migración `20260615140000`**: tabla `catalog.suppliers` (code/name, RLS, FK tenant) + `catalog.products.supplier_id` (FK `ON DELETE SET NULL (supplier_id)` PG15+). El `category_id` previo era inconsistente (a veces proveedor real, a veces depto genérico) → queda deprecado, no se toca (usado en thot/pricing/analytics); la taxonomía real ya vive en department/product_line.
- **Importer** `import-kepler-suppliers.js`: siembra **542 proveedores** desde `kdig` y enlaza **7,221 productos** a su proveedor real vía `kdii.c3`. Top: MONDELEZ 297 / FÁBRICAS SELECTAS 294 / DE LA ROSA 246. Verificado: AGUA→NUEVA WALT MART (antes mal como "ABARROTES"), KINDER→FERRERO, CHURRO→JUANA AYALA. (Costo de compra disponible en `kdpv_prov_prod` si se requiere; cost_base ya está poblado.)

### Added — UoM real + taxonomía de categorías de Kepler → products
- **Mapeo descifrado** de catálogos de dimensión Kepler: `kdid`=unidad (PZA/PAQ/CJA/KG), `kdie`=departamento (DULCES/BEBIDAS/BOTANAS), `kdif`=línea (CHOCOLATE PASTELITO…), `kdig`=proveedor. Columnas: `kdii.c11`=unidad, `c4`=depto, `c5`=línea, `c3`=proveedor.
- **Migración `20260615130000`**: + `catalog.products.department` + `product_line` (no toca `category_id`, que en realidad = proveedor).
- **Importer** `import-kepler-uom-categories.js`: corrige `unit_sale`/`unit_purchase` desde Kepler (**7,795 productos** — el sync previo había defaulteado casi todo a PZA; ahora PAQ 5,848/PZA 4,831/KG 189, realista → **cierra el hueco de UoM de Fase I**) y puebla department/product_line (**2,210** con taxonomía real; el resto es "NO APLICA" en Kepler). Verificado: GALL ANIMALITOS=KG, Kinder=DULCES/CHOCOLATE PASTELITO, Agua=BEBIDAS/AGUA EMBOTELLADA.

### Added — Rotación real de Kepler → Thot (catalog.products)
- **Análisis** `database/scripts/kepler-rotation-analysis.js` (read-only): descifra ventas en `kdm1`/`kdm2` (doc venta c2='U' c3='D' c4=10, 149k tickets POS). Top movers, **stock muerto** (existencia sin ventas → capital parado al costo) y slow movers por días de inventario. Suc 03 90d: **503 SKUs muertos = $567,877 parados**.
- **Feed a Thot** `database/importers/kepler/import-kepler-rotation.js` (dry-run/apply): puebla `catalog.products.rotation_tier` (alta/media/baja por percentil de unidades 90d; **dead=null** → peso mínimo) + `sales_units_30d` con venta real. **3,855 productos** (alta 856 / media 1215 / baja 1307 / dead 477). Thot usa estos campos sin cambio de código → la rotación real y el stock muerto entran al score; verificado AGUA/CHURRO/Kinder=alta. (Branch 03 como referencia; sync vivo pendiente.)

### Added — Precios de venta reales de Kepler → product_prices
- **Importer** `database/importers/kepler/import-kepler-prices.js` (dry-run/apply): fuente `md.kdpv_prod_util` (9,036 SKUs con precio escalonado por presentación + tiers de volumen). Decisión: el gradiente de precio por cliente son los **tiers de volumen** (no la presentación). Por SKU se toma su presentación principal (PZA>PAQ>CJA>KG>BTO) y sus tiers ordenados caro→barato se mapean **tier 0 → P1 (público) … → P4 (mayorista)**, rellenando listas faltantes con el mejor precio. **7,617 SKUs match, 30,468 upserts P1-P4**. Verificado: CHURRO P1 $5.35(min3)/P2 $5.08(min5)/P3-P4 $4.99(min10). tax_rate=0.16 asumido (verificar si Kepler ya incluye IVA).

### Fixed — FKs compuestas ON DELETE SET NULL anulaban tenant_id (bug sistémico)
- Migración `20260615120000`: **31 FKs** en commercial/logistics/trade tenían `FOREIGN KEY (tenant_id, X) REFERENCES ... ON DELETE SET NULL`, que al borrar el padre intentaba poner NULL en `tenant_id` (NOT NULL) → crash (vivido al borrar pedidos: `shipments`). Recreadas con la forma de Postgres 15+ `ON DELETE SET NULL (X)` que anula **solo** las columnas no-tenant. Migración dinámica + idempotente (no toca las ya corregidas). 0 FKs buggy restantes.

### Changed — Limpieza de datos inventados (deja solo data real) + import logística Kepler
- **Comercial** (`database/scripts/cleanup-invented-data.js`, transaccional dry-run/apply): borradas 1,397 filas inventadas — 354 pedidos dev (PD-*) + líneas/historial, 22 clientes TST-/DEMO- + refs (recommended_baskets/customer_360/commerce_signals), 26 productos + 5 marcas testdata (B.3.2), almacenes `INV-TEST-WH` y `TRUCK-*`, stock seed de MD-CENTRAL, 2 folios smoke. Conserva catálogo real, 2,925 clientes reales, listas de precio reales, **MD-10/30/50/CEDIS** (stock real) y **KEPLER-03**. Desliga `shipments.order_id` (FK compuesta ON DELETE SET NULL anularía `tenant_id` NOT NULL — bug de schema esquivado).
- **Logística** (`database/scripts/logistics-clean-and-import-kepler.js`): wipe de data de prueba (241 embarques EMB-* + cascade guías/gastos/checklists/fotos, 37 choferes TEST, 39 vehículos TEST, 27 periodos de nómina, "Ruta Local Demo") + **import real de Kepler**: 8 choferes (nombres reales), 11 vehículos (placas reales), 27 rutas nuevas (25 de las 52 ya existían del import del Excel → confirma que son las rutas reales). Conserva rutas reales del Excel + config_finance. Resultado: 8 choferes / 11 unidades / 123 rutas / 0 embarques.

### Added — ERP Kepler: dump restaurado + descifrado + importer de stock real
- **`database/BACKUP.sql`** (228 MB, pg_dump custom-format de la DB `md_03` schema `md`) restaurado a Postgres local (`localhost:5433`, DB `md_03`). Es el ERP **Kepler** de Mega Dulces, **esquema ofuscado** (tablas `kdXX`, columnas `c1..cN` sin nombres). Mapeo inferido desde datos documentado en [`docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md`](docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md): `kdii`=maestro productos (c1=SKU, c2=nombre, c7=barcode), `kdil`=existencia por sucursal (c9), `kdik`=valuación (costo=c9/c6), `kdm1/kdm2`=documentos (incl. ajustes de inventario — no hay tabla de conteo físico dedicada). 2 sucursales: 02 (vieja) y 03 (viva).
- **Importer** `database/importers/kepler/import-kepler-stock.js` (dry-run por defecto, `--apply` escribe, idempotente): join `kdii.c1 == public.products.sku` (97% overlap), existencia `kdil.c9`, costo `kdik`. **Aplicado**: sucursal 03 → almacén nuevo **KEPLER-03**, **3,936 SKUs / 1,127,490 unidades** de stock real. La Fase I ya puede contar contra cifras verdaderas. Costos validados como realistas (Agua $2.52, Kinder Delice $11.28).

### Added — Fase I · Inventario físico (I.0 + I.1 backend): conteo cíclico/total por almacén
- **Digitaliza "hacer inventario"** (marbeteo + doble conteo + recaptura del checador) como sesión con **conteo ciego**, **doble conteo** por contadores distintos y **reconciliación auditable**. Jerarquía: contador (cuenta a ciegas) → supervisor (analiza/resuelve) → reconciliador/jefe (autoriza el ajuste del saldo = del dinero).
- **Schema** (mig `20260613100000`, `commercial.*`): `inventory_counts` (folio INV-YYYY-NNNNN, state machine open→counting→review→ready_to_reconcile→reconciled|cancelled, índice parcial único **un folio abierto por almacén**), `inventory_count_items` (`expected_qty` = snapshot del teórico **oculto al contador**, `count_1/2/3`+`counted_by_*`, `final_qty`, `variance`, status), `inventory_count_sequences`. RLS forzado + grants `app_runtime`. FK tenant→`identity.tenants`, producto→`catalog.products` (los `public.*` son vistas tras la reorg).
- **Permisos** `COMMERCIAL_INVENTORY_{CONTAR,SUPERVISAR,RECONCILIAR}` (enum BE+FE, `ability.factory` subject `commercial_inventory`, seed de roles + backfill idempotente `20260613110000`). **Requiere re-login**.
- **Backend** `InventoryCountService`+`InventoryCountController` (`/commercial/inventory/counts`): open+snapshot, count (ciego, barcode o product_id, segregación count_2≠count_1, sobrantes), progress (cobertura %, discrepancias, **valor $ en riesgo**, productividad por contador), items, compute (discrepancias + count_3 rompe empate), resolve, reconcile (ajusta stock + movimientos `adjust` reference_type=`inventory_count` en una trx), cancel.
- **3 controles críticos**: (1) **coverage guard** — reconcile rechaza SKUs con `count_1 IS NULL` (un no-contado nunca se trata como cero → no se destruye stock real); (2) **freeze guard cross-module** — `assertWarehouseNotFrozen` en `orders.reserveStockInline/consumeStockInline` + `adjustStock/recordMovement`: con folio abierto y `freeze_movements`, se bloquea mover stock (el teórico no deriva); (3) varianza contra `quantity` (on-hand) respetando el CHECK `quantity >= reserved`.
- **Smoke** `test-newdb-inventory-count.js` (DB-direct, `app_runtime`, RLS) **13/13 ✓**, en `run-all-tests.js`.
- **I.2 frontend contador** — página `/comercial/inventory/count` (mobile-first para handheld HID): selector de folio, barra de progreso **ciega** (`GET /count-progress`, sin teórico/varianza), captura código→cantidad→Enter de un gesto, feed de últimos conteos con badge de slot. Nav "Conteo físico". Backend: endpoint count-progress ciego (gate CONTAR), submit devuelve sku/nombre para confirmar el SKU escaneado, y corrección same-counter (re-escaneo del mismo contador sobreescribe su count_1; solo otro contador dispara count_2).
- **I.3 frontend supervisor** — `/comercial/inventory/sessions` (lista + dialog abrir folio: almacén, tipo, toggles congelar/doble-ciego) y `/comercial/inventory/sessions/:id` (KPIs cobertura/sin-contar/discrepancias/**valor $ en riesgo**, calcular discrepancias, **reconciliar** con confirmación gate RECONCILIAR, cancelar, filtro Todos/Discrepancias/Pendientes, tabla de items teórico/C1/C2/C3/final/varianza, dialog resolver item con motivo). Nav "Folios inventario". **Fase I frontend+backend completos (beta scope)**; falta validación visual.

### Fixed — /dashboard/routes responsive en móvil
- La tabla densa "Visitas y tiempos" (8 columnas) no contenía su overflow → empujaba el ancho de **toda** la página en teléfono (KPIs/mapa/header se renderizaban a ~660px, cortados y con scroll horizontal global). Ahora las tablas tienen **scroll horizontal propio** (`overflow-x:auto` + `min-width` solo en la tabla ancha), así la página vuelve al ancho del viewport y la tabla se navega con swipe.

### Added — Mapa Comercial (CM): exhibidores Mega Dulces vs competencia en mapa + historial por tienda
- **Módulo `commercial-map`** (`libs/trade`, 2 endpoints read-only sobre `daily_captures.exhibiciones` JSONB — la fuente VIVA; las tablas `visits`/`exhibitions` son código muerto): `GET /commercial-map/stores` (tiendas con **coord híbrida** `COALESCE(stores.lat, última GPS de captura)` + conteo propio/competencia/sin-clasificar derivado del flag `perteneceMegaDulces` + `presence` + `unlocatedCount`) y `GET /commercial-map/stores/:id/history` (historial de visitas con exhibiciones separadas **Mega Dulces vs Competencia**: foto, concepto, ubicación, nivel, score, productos). Connection legacy + filtro `tenant_id` explícito (**no** `TenantKnexService`). Scoping **store-céntrico**: el historial y los conteos traen **todas las visitas de la tienda** (acotado por tenant + zona del requester, que ya controla qué tiendas ve) — sin filtro own/team de usuario, que ocultaría visitas de otros reps en la misma tienda.
- **Permiso `COMMERCIAL_MAP_VER`** (enum BE+FE, `ability.factory` subject `commercial_map`+action `read`, `AppSubject`). Seed de roles (superadmin/admin/supervisor/jefe_marketing) + backfill idempotente `20260613100000` (`-> 'KEY' IS NULL`). **Requiere re-login** (el permiso vive en el JWT).
- **Página `/dashboard/commercial-map`** ("Mapa Comercial", nav Trade, icono `pi-map-marker`): superficie Operations (densa, master-detail). Mapa Leaflet con marcadores coloreados por presencia (🟢 Mega Dulces · 🔴 competencia · 🟠 ambas · 🔵 sin clasificar · ⚪ sin visitar), leyenda con conteos + badge "N sin ubicar", filtros de presencia/zona/búsqueda (client-side) + **selector de período** (Todo/Hoy/Semana/Mes/Personalizado con datepicker, estilo /reports — recarga del server). Click en tienda → panel con KPIs + **lista de visitas**; clic en una visita → **ventana (`p-dialog`) con su descripción completa** (exhibiciones con foto, chips propio/competencia, productos, ubicación/nivel, score — estilo Seguimiento); clic en la foto → **lightbox ampliado**. El mapa Leaflet va aislado (`isolation`) para no pisar el sidebar.
- **`MapComponent`** (`shared/components/map`): nuevo `output markerClick` + campo opcional `id` en `MapMarker` (no-breaking; routes-analysis sin cambios).
- **Smoke `http-commercial-map-test.js`** registrado en `run-all-tests.js`.

### Added — Modo Vendedor v2 · V.0: cartera del vendedor + orden de visita
- **`commercial.vendor_sales_routes`** (mig `20260610100000`): qué rutas de venta (`sales_route`) cubre cada vendedor — el `supervisor_ventas` asigna. La cartera del vendedor = clientes de esas rutas. + **`customers.visit_sequence`**: orden de visita del cliente dentro de su ruta. FK a `identity.*` (las tablas reales; `public.users/tenants` son vistas), RLS, idempotente.
- **Módulo `commercial-vendor-routes`** (7 endpoints): rutas+conteo+asignados, vendedores asignables, clientes-por-ruta, asignar/quitar (idempotente), "mi cartera" (vendedor), ordenar (`visit_sequence` 1..N). Gestión gateada por `USUARIOS_ASIGNAR_RUTA` (lo tiene `supervisor_ventas`), lectura por `COMMERCIAL_CUSTOMERS_VER` — sin permiso nuevo (evita el riesgo de ability.factory).
- **Página `/comercial/cartera`** ("Cartera de ventas"): el supervisor asigna/quita rutas a vendedores y **ordena la secuencia de visita** de los clientes de cada ruta con botones subir/bajar (PrimeNG 18 no expone `reorderableRows`). Ítem en el nav comercial.

### Added — Modo Vendedor v2 · V.1: backend de pedidos por cartera + ciclo de vida del vendedor
- **`GET /commercial/orders` con filtros nuevos**: `?statuses=pending_approval,confirmed` (multi-status CSV), `?mine=true` (restringe a clientes de la cartera del vendedor del JWT vía `vendor_sales_routes`) y columna calculada **`is_preventa`** (`true` si el pedido lo originó el cliente desde el Portal B2B — su user es `customer_b2b`; `false` si lo tomó un vendedor en campo). Base de "Por entregar".
- **`GET /commercial/customers?mine=true`**: cartera del vendedor (clientes de sus rutas) ordenada por `visit_sequence` (nulls al final). Base de "Clientes por ver" / "Pedido nuevo".
- **`VendorService`**: métodos `myCartera()`, `pendingDeliveries()`, `approve()` (pending_approval→confirmed), `fulfill()` (confirmed→fulfilled) + tipo `VendorOrder` (Order enriquecida con `is_preventa`/`customer_name`/`route_name`).
- **Ciclo de pedido para roles de campo**: el vendedor ahora gestiona su cartera de punta a punta. Seed `FIELD_PERMS` + backfill `20260610110000` activan `COMMERCIAL_ORDERS_CONFIRMAR` / `FULFILL` / `CANCELAR` en `colaborador` / `ejecutivo` / `vendedor` (idempotente, merge guardado por `@>`). Las 3 keys ya estaban mapeadas en `ability.factory`. **Requiere re-login** (el permiso vive en el JWT).

### Changed — Modo Vendedor v2 · V.2: el modo vendedor reorganizado en 4 apartados
- **Nuevo bottom nav del modo vendedor**: **Pedido** · **Por entregar** · **Por visitar** · **Buscar** (antes Clientes / Mi día / Cierre). "Mi día" y "Cierre de ruta" pasan a accesos en el header (no pierden alcance). Default de `/vendor` → `new-order`. Entradas a Modo Vendedor (nav admin, landing de proyectos, links internos) repuntadas a `/vendor/new-order`; `/vendor/customers` queda como redirect a `search`.
- **Pedido nuevo** (`/vendor/new-order`): la cartera del vendedor (clientes de sus rutas asignadas) **en orden de visita** (`visit_sequence`, badge numerado), con filtro y tag de ruta. Tocar un cliente abre la toma de pedido. Empty state guía a pedir cartera al supervisor + fallback a Buscar.
- **Buscar** (`/vendor/search`): búsqueda sobre **todo** el catálogo de clientes (esté o no en la cartera) — es el `vendor-customers` previo, retitulado.
- **Por entregar** (`/vendor/pending`, V.3) y **Por visitar** (`/vendor/visits`, V.4): apartados creados con placeholder "Disponible pronto" — el backend de Por entregar (`pendingDeliveries`/`approve`/`fulfill`) ya existe (V.1).

### Added — Modo Vendedor v2 · V.3: apartado "Por entregar" operativo
- **`/vendor/pending`** ya no es placeholder: lista los pedidos pendientes de la cartera del vendedor (preventa del Portal B2B + de campo), en dos secciones — **Por aprobar** (`pending_approval`) y **Listos para entregar** (`confirmed`). Cada pedido muestra cliente, folio, total, hora, tag de origen (**Preventa**/**Campo** según `is_preventa`) y expande sus líneas bajo demanda (`orderById`).
- **Acciones con confirmación**: **Aprobar** (`pending_approval → confirmed`) y **Marcar entregado** (`confirmed → fulfilled`, descuenta inventario), cada una con `ConfirmDialog` + toast de resultado y recarga de la lista. Botón con `loading` mientras la operación está en vuelo; errores del backend se muestran en el toast.

### Added — Modo Vendedor v2 · V.4: apartado "Por visitar" + check-in (cierra v2)
- **`commercial.vendor_visits`** (mig `20260610120000`): cada fila = un check-in explícito del vendedor a un cliente (`visited_at`, `notes`, `latitude`/`longitude` nullable para geo-check-in futuro). FK a `identity.*` (tablas reales) + a `commercial.customers (tenant_id, id)`, RLS forzado, grants `app_runtime`, idempotente.
- **Backend** (`commercial-vendor-routes`): `GET /coverage` (cobertura del día — la cartera anotada con `visited_today` calculado en **TZ MX** + última visita; gateado por `COMMERCIAL_CUSTOMERS_VER`) y `POST /check-in` (registra la visita; gateado por `VISITAS_REGISTRAR`, que los roles de campo ya tienen). Smoke RLS E2E OK (cartera → check-in voltea el flag).
- **`/vendor/visits`** ya no es placeholder: la cartera en orden de visita con barra de progreso ("X de N visitados hoy"), check-in por cliente (optimista + toast) que pinta el cliente como visitado, y atajo a tomar pedido. `VendorService.coverage()`/`checkIn()` + tipo `CoverageCustomer`.

### Added — Modo Vendedor v2 · V.5.0: backend para "Mi ruta" (interfaz única client-centric)
- **`commercial.orders.requested_delivery_date`** (date, nullable; mig `20260610130000` + índice parcial): fecha de entrega agendada para el "pedido futuro". `createDraft`/`updateDraft` la aceptan (validan `YYYY-MM-DD`); `list()` la devuelve.
- **`POST /commercial/orders/:id/deliver-now`** (autoventa — "pedido al instante"): fast-forward a `fulfilled` en **una transacción** desde `draft`/`pending_approval`/`confirmed` (reserva + congela + confirma + consume stock, reusando `fulfillInTransaction`). Gateado por `COMMERCIAL_ORDERS_FULFILL`. Consume del almacén central (beta); la conciliación del camión vive en los tickets del cierre.
- **`GET /commercial/vendor-routes/home`**: feed del home "Mi ruta" — la cartera del vendedor (orden de visita) anotada de **un solo fetch** con `visited_today`, `ordered_today` (TZ MX), `last_visit_at` y `pending_orders[]` (total + `is_preventa` + fecha de entrega) + `pending_count`/`pending_total`/`has_preventa_pending`. Smoke RLS E2E OK (campo vs preventa distinguidos).
- **`VendorService`**: `home()`, `deliverNow()` + `updateDraftHeader` acepta `requested_delivery_date` + tipos `HomeCustomer`/`HomePendingOrder`.

### Changed — Modo Vendedor v2 · V.5.1: home "Mi ruta" client-centric (una sola pantalla)
- **El modo vendedor es ahora una sola pantalla**: `/vendor/route-home` ("Mi ruta") = la cartera en orden de visita; cada cliente abre un **bottom-sheet** con todas sus acciones sin salir de la lista — **Ver pedido pendiente · Pedido al instante · Pedido futuro · Marcar visita · Registrar ticket · Capturar exhibición · Llamar/WhatsApp**. Consume `home()` de un fetch. Chips por cliente (preventa pendiente · N por entregar · pedido hoy · visitado), barra de progreso de visitas y filtro client-side.
- **Check-in en el sheet** (reusa `checkIn`, optimista). Contacto directo (tel / wa.me). "Capturar exhibición" enlaza a `/dashboard/vendor-capture` (fusión profunda en V.5.3).
- **Nav colapsado**: bottom nav a **2** (Mi ruta · Cierre) + **Buscar** y **Mi día** como íconos en el header. Las pestañas Pedido/Por entregar/Por visitar se vuelven el home + sus rutas siguen vivas (las usa el sheet). `/vendor` y `/vendor/new-order` redirigen a `route-home`; se eliminó el componente `vendor-new-order` (superado).

### Changed — Modo Vendedor v2 · Rediseño móvil "Mercado" (R.1: Mi ruta)
- **`/vendor/route-home` rediseñada** mobile-first sobre el design system Mercado (preview en `designs/vendor-redesign-20260610/`): **hero full-bleed** con gradiente cálido (sangra el gutter del shell), **anillo de progreso** (visitados/total) y **KPIs del día** (pedidos · vendido · por entregar, mono tabular). El banner de reorden NBA pasa a **identidad ember** (✦). Las cards de cliente ganan **riel de estado** a la izquierda (verde visitado · ámbar preventa · sunset reordenar · stone pendiente), chips tokenizados (se eliminó el hex inline), y **FAB sunset "Pedido"** en la zona del pulgar que abre el próximo cliente. El bottom-sheet ahora destaca la acción primaria ("Pedido al instante") como botón sunset; sheet entra con `--spring`. `prefers-reduced-motion` respetado.
- **Motion tokens** en `tokens.css`: `--ease-standard`, `--ease`, `--spring` (reuso global). Toda la lógica NBA (`nbaDue`/`recordSignal`/dueIds/onlyDue) + check-in + sheet preservada.
- **R.2 · Tomar pedido** rediseñado + modos cableados: header con chip de modo, catálogo en filas livianas con **"+" de 44px** (badge de cantidad en carrito), sección de carrito con **steppers** + totales, y **cart pill flotante** (zona del pulgar) como CTA único. **Instante** (autoventa) → `POST /orders/:id/deliver-now` ("Cobrar y entregar", descuenta stock); **futuro** → date-picker + `requested_delivery_date` y confirma ("Agendar pedido"). Háptico en add/stepper/confirm. Se quitaron `p-table`/`p-inputNumber`/`p-card`/`p-selectButton` (markup propio liviano).
- **R.3 · Pedido confirmado** (`/vendor/order-success`): pantalla de éxito que celebra al instante (datos por queryParams, sin fetch) — **check dibujado** (SVG stroke) + pop spring + **confetti** amarillo (sello) + háptico de éxito. Verde "¡Entregado!" (instante) / info "¡Pedido agendado!" (futuro, con fecha). CTA en zona del pulgar: **enviar ticket por WhatsApp** (mensaje pre-armado) + volver a la ruta. `take-order` navega acá tras cobrar/agendar. `prefers-reduced-motion` desactiva confetti/animación.
- **R.4 · Notificaciones** (`/vendor/notifications`) + **bell en el header**: inbox derivado (sin backend persistente todavía) que agrega lo accionable de endpoints existentes — **preventa pendiente** (→ aprobar), **clientes para reordenar hoy** (NBA, → tomar pedido) y **pedidos de hoy** — agrupado, con íconos de tipo (warn/ember/ok) y tap-to-act. Badge en vivo diferido (requiere conteo liviano / backend de notificaciones).
- **R.5 · re-skin de pantallas secundarias**: **Mi día** ahora con mini-hero + KPIs (mono tabular) y filas de pedido con chip de estado tokenizado (Spanish labels). **Buscar** con search pill + filas livianas con avatar de iniciales (sin `p-card`). *Por entregar* / *Por visitar* ya usaban el lenguaje de chips/riel (V.3/V.4); *Cierre de ruta* conserva su diseño propio. Cierra el rediseño móvil del Modo Vendedor (R.1–R.5).
- **R.6 · pulido: esquinas + colorimetría de /vendor-capture**: el shell del vendedor sube los radios (`--r-sm..2xl`) vía override scopeado → **todas las esquinas con token quedan más redondeadas** (look moderno) en cascada a todo el módulo; + bump de los radios hardcodeados (badges/avatares/botones). **Colorimetría golden** tomada de `/vendor-capture` (fusionado al shell como "Capturar"): los heroes pasan de sunset rojo a **golden-orange** (`#F68F1E`, vía `--v-hero-grad`), el seq badge a tinte marca/ámbar (`--v-seq-bg/fg`). Sunset `--action` se conserva solo en CTAs sólidos (contraste de texto blanco).

### Fixed — Supervisor de ventas asignable a vendedores (no solo colaboradores)
- **`/admin/users`**: el selector "Jefe / Supervisor de Ventas" solo aparecía (y solo se conservaba) para el rol `colaborador`; al elegir `vendedor` o `ejecutivo` se ocultaba y el `supervisor_id` se forzaba a `null`. Ahora aplica a todos los roles de campo (`colaborador`, `ejecutivo`, `vendedor`) — vía `isSupervisedRole()` — tanto en el form como en el listado (desktop + mobile).
- **Efecto colateral resuelto en Asignación diaria**: esa pantalla arma el equipo con `users WHERE supervisor_id = <supervisor logueado>`. Como los vendedores nunca podían tener `supervisor_id`, no aparecían en el equipo de su supervisor de ventas. Con el supervisor ya asignable, el vendedor aparece y el supervisor puede asignarle su ruta diaria. (Backend ya soportaba `supervisor_id` + `/users/supervisors` + `findBySupervisor`; el hueco era solo de UI.)

### Fixed — Ventas (comercial): sesión de corrección de bugs
- **Televenta dashboard 100% roto** (`dashboardMetrics`): consultaba columnas inexistentes en `commercial.lead_reservations` (`status`, `user_id` → 500 siempre) y filtraba `call_logs.outcome` por valores en español (`pedido_tomado`…) que el CHECK prohíbe (métricas en 0). Alineado al schema real (`released_at IS NULL`, `reserved_by_user_id`) y al enum canónico (`sale`/`no_answer`/`callback_scheduled`/`no_sale`).
- **`adjustStock` no atómico**: se partía en 3 transacciones (read → recordMovement → overwrite) → saldo corrupto ante crash y lost-update concurrente. Ahora un único `tk.run` con `forUpdate`, valida `new_quantity >= reserved` y registra `quantity_before/after` correctos.
- **`reserveLead` 409 espurio**: no pre-liberaba reservas vencidas antes del INSERT → chocaba el UNIQUE parcial sobre leads que la cola sí ofrece. Ahora pre-libera (`released_reason='expired'`) en el mismo trx.
- **`bulkUpsertPrices` no avanzaba `updated_at`**: el `.merge()` lo referenciaba pero las rows no lo seteaban. Ahora cada row setea `updated_at: now()`.
- **Fechas por defecto en UTC, no MX** (route-tickets + vendor-sales): `toISOString().slice(0,10)` ocultaba capturas de 18:00–23:59 MX. Ahora usan `todayMx()`/`toMxDateKey()`.
- **Desvincular tienda de cliente no persistía**: tanto el `linkStore` inline como el dialog de edición (`save()`) mandaban `store_id: undefined` (backend lo trata como "sin cambio"). Ahora ambos mandan `null`, consistente con `linkRoute`. Quitado de paso el método muerto `onToggleActive()`.
- **KPIs de pedidos sobre la página visible**: hero "Ventas en la ventana" y counts de history reflejaban solo la página. El backend `list` ahora devuelve `total_amount` agregado del filtro y el front usa `statusCounts()` reales.
- **Fugas RxJS**: 25 `.subscribe()` en 6 componentes de `/comercial` sin `takeUntilDestroyed` (incl. streams permanentes `route.data` y `search$`). Todas envueltas.

### Changed — Alertas realtime desactivadas
- **Apagadas todas las alertas realtime del Command Center** (decisión de producto): el scanner cron `AlertsScannerService` (emitía `low_stock_critical` + `vip_inactive` cada 5 min) queda gateado por `ENABLE_COMMERCIAL_ALERTS` (default off); el Command Center ya no abre el socket de alertas ni muestra el feed/toasts en vivo (se limpió el feed, el tag "En vivo" y los helpers huérfanos). Se mantienen el panel informativo "Stock bajo" del dashboard (endpoint analytics) y el resto del dashboard. Reactivable con `ENABLE_COMMERCIAL_ALERTS=true`.

### Added — Cliente comercial: WhatsApp + ruta de venta estructurada
- **Columna `whatsapp`** en `commercial.customers` (normalizada a E.164, índice único parcial por tenant) — migración `20260609140000` idempotente (local+prod). El backend normaliza a `+52…` en create/update y mapea colisiones (23505) a 409; el front la expone en el dialog y en la ficha del cliente, en lugar del viejo selector de tienda.
- **Columna `sales_route`** (ruta de venta): la ruta que el ERP traía como texto en `notes` ("Ruta: RUTA 21") se migró a un campo estructurado. Script `backfill-customer-sales-route.js` pobló **2.859 clientes** (12 rutas). La columna "Ruta" de `/comercial/customers` ahora muestra `sales_route`. (`route_id` sigue apuntando a logística, hoy vacía — son rutas distintas.)

### Changed — /comercial/customers alineado al vínculo tienda↔cliente
- **Vínculo de tienda ahora es de solo lectura**: se quitó el selector inline "Vincular tienda" de la tabla y el campo editable del dialog (cada tienda nace como cliente al alta; el vínculo no se edita a mano). Se muestra como chip read-only. Eliminados los métodos/signals huérfanos (`linkStore`, `linkRoute`, `routeName`, etc.).
- **Backend blindado**: `store_id` es inmutable vía PATCH (no se puede cambiar ni quitar un vínculo existente — `BadRequestException`); violaciones de unicidad devuelven **409** con mensaje claro en vez de 500.
- **Hallazgo (workflow de análisis)**: el modelo NO es 1:1 en los datos — hay **2.941 clientes del ERP** vs **36 tiendas** de Trade. Los 19 STR- del bulk previo no duplican clientes ERP (tiendas piloto distintas); quedan 5 homónimos internos del ERP para revisión manual.

### Added — Modelo 1:1 tienda↔cliente (Ventas)
- **Cada tienda de Trade Marketing es un cliente comercial.** `database/scripts/promote-all-stores-to-customers.js` (dry-run default, `--apply` para escribir): promueve en bulk todas las tiendas activas sin cliente a `commercial.customers`, idempotente, reusando la lógica de `createFromStore` (code `STR-…`, name = nombre de la tienda, price_list default). Poblado inicial: **36/36 tiendas activas ↔ clientes**.
- **Auto-provisión al alta**: al crear una tienda en Trade (`StoresService.create`) se crea automáticamente su cliente comercial, vía el nuevo Port `CUSTOMER_PROVISIONING_PORT` (inversión de dependencia trade→commercial en el composition root, `@Optional` para no acoplar la app legacy, best-effort post-commit — si falla no rompe el alta de la tienda).
- Migración `20260609120000`: índice único parcial `commercial.customers (tenant_id, store_id) WHERE store_id IS NOT NULL AND deleted_at IS NULL` — garantiza el 1:1 (un store, un cliente activo).

### Added
- `database/scripts/README.md` — mapa de 92 archivos agrupado en 11 familias con estado 🟢🟡🔵⚫.
- `.env.example` — +18 vars que estaban undocumentadas (cutover, vector, tests E2E, S3, etc.).
- `package.json` — npm scripts `regression`, `import:commercial`, `seed:testdata` (loop completo), `cutover:preflight`, `cutover:smoke`, `embeddings:backfill`, `embeddings:sync`, `migrate:new`, `seed:new`.
- `DESIGN.md` — sección **"Mercado / Operations"** extendiendo el design system a `/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/televenta/*`. Mismo sistema, 2 surfaces (Storefront + Operations).
- `CHANGELOG.md` — este archivo.

### Changed
- `CLAUDE.md` — Design System ahora cubre 2 surfaces (era solo `/portal`).
- **Rutas — tienda↔ruta "última gana"**: el hook `maybeAssignStoreRoute` ahora reasigna `stores.ruta_id` a la ruta de CADA captura (antes solo asignaba si la tienda no tenía ruta). Así el apartado Rutas agrupa cada tienda bajo la ruta que la capturó por última vez. Cambio en `libs/trade/.../daily-captures.service.ts`.

### Added
- `database/scripts/backfill-store-route-from-captures.js` — backfill idempotente (dry-run por default) que aplica "última gana" a la data histórica: cada tienda hereda la ruta de su captura más reciente con `route_id`.

### Fixed
- **Rutas — ruta duplicada por zona del store**: `getRoutesData` sacaba la zona de cada tienda (`stores.zona_id`) y la metía en el `GROUP BY`, fragmentando una ruta en una fila por cada zona distinta de sus tiendas (ej. "RUTA 23 / LA PIEDAD RD" + "RUTA 23 / —" para tiendas sin zona). Ahora la zona viene de la **ruta** (`catalogs.parent_id → zones`) y el filtro de zona usa `c.parent_id` → una fila por ruta. Complemento: el hook `maybeAssignStoreRoute` ahora también alinea `stores.zona_id` a la zona de la ruta en cada captura, y `database/scripts/backfill-store-zone-from-route.js` corrige la data histórica (dry-run por default).
- **Rutas — timezone mismatch maestro vs detalle**: la lista de rutas (`getRoutesData`) filtraba por `DATE(hora_inicio)` en UTC mientras el detalle (`getRouteVisits`/`getRouteStores`) usaba `AT TIME ZONE 'America/Mexico_City'`. Las capturas de la tarde-noche MX caían en el día UTC siguiente → el conteo "N vis" del maestro no cuadraba con el detalle y rutas con actividad real desaparecían con el rango default = hoy. Alineado todo a MX.
- **vendor-capture**: selector de ruta ahora usa `p-select` (igual que captura diaria) en vez de `<select>` nativo.

### Added — Tiempos muertos (detección)
- **Fase 1 (derivado, sin captar data nueva)**: `GET /reports/routes/:id/idle` y `GET /reports/idle/summary`. Detecta tiempo muerto entre visitas consecutivas del mismo vendedor: `idle = max(0, gap − traslado_estimado)`, traslado = haversine(tiendas)/25 km/h, umbral muerto 20 min. UI en /routes: KPI "Tiempo muerto" + columna "Muerto antes" por visita. Resumen agregado por vendedor para dashboard. `computeIdleSegments` corta por (vendedor, día MX).
- **Fase 2 (breadcrumbs GPS)**: tabla `public.route_location_pings` (mig 20260609100000, sin RLS patrón push_subscriptions). Dexie v5 `routePings` + `RoutePingService` (ping cada 3 min en foreground con ruta activa, cola offline, sync bulk idempotente a `POST /reports/route-pings`). Refinamiento: `getRouteIdle` separa estacionado vs traslado con los pings (idle real = tiempo estacionado), con indicador GPS en la UI. Fallback al estimado por haversine si no hay breadcrumbs.

### Pending
- **Plan migración tokens.css** documentado en DESIGN.md → no aplicado (riesgo de regresión visual cross-app).
- **T1** scripts hardening (`--dry-run` uniforme + `assertEnvVars()`).
- **T2** hints contextuales en tests al fallar (TenantKnex, ability.factory).
- **T3** `docker-compose.dev.yml` + `npm run dev:up`.

---

## 2026-06-08 — Apartado Rutas + Cierre Ruta UI + DX hardening

### Added
- **`/dashboard/routes`** — apartado completo con master-detail (lista rutas + KPIs + mapa Leaflet recorrido + tabla visitas + tabla tiendas). Permiso `RUTAS_VER`. Backend reusa `/reports` (cero schema nuevo). Fases 0-3 (permiso → backend → frontend → backfill).
- **`/comercial` cierre-ruta** — vista admin "Ventas de vendedor" (ticket OCR).
- **Customers Kepler import** — `customers-from-excel.js` + `link-customers-to-stores.js` para combinar maestro Kepler con `commercial.customers`.

### Fixed
- **PWA overflow-x** — `<main>` con `overflow-y-auto` forzaba `overflow-x: auto` → pantalla se deslizaba lateral. Fix: `overflow-x: hidden` en main + body + html, sin romper tablas anchas.
- **Reports** — chromium del SO en Docker + `executablePath` puppeteer, templates `hbs` en webpack assets.
- **PWA service worker** — catalogs/zones/customers a estrategia **freshness** (no cache-first, evita data stale post-merge).

### Internal
- DX review aplicada (F1+F2+F5 del review `/plan-devex-review`): scripts README, .env.example, npm aliases.

---

## 2026-06-07 a 2026-06-05 — Vendor capture + tickets + auth

### Added
- **Vendor capture** — ticket multi-foto, OCR mejorado, visita siempre primero + link `daily_capture_id` + `product_id` via aliases.
- **Catalog aliases** — sistema `trade.catalog_aliases` para mapear UUIDs viejos de conceptos a vigentes. Reporte y resolver de capturas consultan aliases. Migración faltante 20260606100000 agregada en remediation.

### Fixed
- **Auth JWT** — JWT >4KB no entraba en cookie → persistir en localStorage.
- **Auth-trigger** — `auto_populate_tenant_id` no sobrevivió `SET SCHEMA` en prod → mig 20260606000000 dinámica recrea trigger en 57 tablas multi-tenant.
- **Captures** — ticket vendedor acumula varias fotos del MISMO ticket; remap `sku→product_id`; bloquear visita vendedor sin productos.
- **Touch targets ≥44px** en sidebar nav + topbar user menu (F010 design audit).

---

## 2026-06-04 — Portal B2B standalone deploy + Design audit codemods

### Added
- **Portal B2B en repo aparte** — `Portal_MegaDulces` con `API_UPSTREAM` + nginx resolver. `customer_b2b` permisos scoped (mig 20260605120000).
- **Telemetría endpoint** — `commercial-portal-telemetry` con ingesta + resumen.

### Changed
- **Design audit codemods** — sweep monocromo `comercial/*`, `logistica/*`, `portal/catalog`. Codemod hex pass 2 (cart, televenta). AI accent purple `#8b5cf6` → token `--ai-accent` semantic (G1). Tipografía 10-12px + font-weight hierarchy + shadow decorativa fuera (F4/F6/F9).

---

## 2026-06-03 — Module Isolation Sprint (iso.0–iso.6)

### Internal
- **Monolito modular endurecido** — 41 módulos NestJS reorganizados en libs Nx por dominio (`platform-core`, `contracts`, `commercial`, `logistics`, `trade`). Fronteras enforced con `enforce-module-boundaries: error`. Port DI-invertido logistics→commercial. 1 deployable. Ver memoria `project_module_isolation`.

### Fixed
- **FDW boot migrations** — migraciones que ejecutan query contra FDW mega_dulces_srv (.245) crasheaban boot en Railway. Mig 110000 ajustada. Ver memoria `feedback_fdw_boot_migrations`.

---

## 2026-06-02 — Cierre formal Comercial Fases B+C+D+E

### Added
- **ADR-013** — `pending_approval` order status (cliente confirm → `/approve` vendedor → confirmed).
- **Regression suite ampliada** — 19/19 verde, ~155 sub-assertions en ~10.6s.

### Fixed
- **28 mappings ability.factory** — permisos COMMERCIAL_* y LOGISTICS_* sin map a subject/action causaban 403 "permisos dinámicos" para todo rol sin `manage:all`. Ver memoria `feedback_ability_factory_mapping`.

### Internal
- **Fases B+C+D+E cerradas** (beta scope) con regression suite como fuente de verdad. Ver memoria `project_comercial_cierre_formal`.

---

## 2026-05-27 — Fase E Televenta + Fase J Logística + Fase K AI

### Added
- **Fase E Televenta** (CERRADA beta) — workflow call center sin telefonía. Rol `tele_operator`, pool autoservicio, cron @5min libera leads expirados. Smoke 29/29. Endpoints `/api/commercial/televenta/*`. Frontend `/televenta/*` con 4 páginas.
- **Fase J Logística** (CERRADA beta) — embarques, flotilla, costos, guías, liquidaciones, reports. 7 backend modules + 5 admin pages + analytics + hooks cross-project Comercial↔Logística. UI port desde `_imported/logistica/` (Dashboard ops, Personal/Staff con MultiSelect roles, Guides global con 5 KPIs, Costs con KPIs + dialog 10 categorías).
- **Fase K AI product match** (CERRADA beta) — Docker `pgvector-md` (pg18 + vector 0.8.2) + Voyage AI `voyage-3` (1024 dims) + Claude Haiku 4.5 en wizard captures paso 5. 1278 SKUs embedded. Endpoint `/api/ai/products/match-ai`, threshold 0.40, throttle tier `long`. EmbeddingSyncService @Cron cada 15min + endpoint manual. Script `sync-from-remote.js` Docker↔.245.

### Internal
- **K-debt cerrado** — refactor `catalogs.service.ts` + `daily-assignments.service.ts` + `stores.service.ts` para no escribir a columna virtual `activo BOOLEAN GENERATED`.

---

## 2026-05-26 — Sprint A.0-multitenant + Fases B+C+D (todo en un día)

### Added
- **A.0 Multitenant** (CERRADA beta) — nueva DB Postgres 18.4 multi-tenant en `192.168.0.245:5432/postgres_platform`. Schema completo 19 tablas + 95 índices + 18 RLS + rol `app_runtime` + seeds. `TenantContextService` (AsyncLocalStorage) + Interceptor + auth-mt. 1804/1830 rows migrados desde legacy (98.6%).
- **Fase B Core Comercial** (CERRADA beta) — 9 tablas en schema `commercial.*` (customers, warehouses, price_lists, product_prices, stock, stock_movements, orders, order_lines, payments). State machine orders `draft → confirmed → fulfilled`. Generator `PD-YYYY-NNNNN`. CLI importer + test data realista (5 brands + 25 products + 25 prices + 20 customers + 25 stock).
- **Fase C Sales Intelligence** (CERRADA beta) — 7 endpoints `/commercial/analytics/*` (overview, top-customers, top-products, sales-by-brand, low-stock, etc.) + 3 materialized views + `AnalyticsRefreshService` @Cron('*/15min'). Frontend Command Center con 4 KPIs + 4 tablas + alertas WS realtime (low_stock_critical, vip_inactive).
- **Fase D Catálogo + Portal B2B** (CERRADA beta) — `customer_id` UUID + composite FK + `commercial.order_status_history`. Rol `customer_b2b`. Portal Web B2B en `/portal/*` (PortalLogin, PortalCatalog, PortalCart, PortalOrders, PortalOrderDetail). Vendor app mobile-first `/vendor/*` (ADR-005: extender `apps/view` no app RN separada). Canasta estratégica v1 (base/focus/exploration/innovation con score 0..1).
- **ADRs 010, 011, 012** — multi-tenancy shared DB + tenant_id, Voyage AI embeddings, pgvector en DB legacy.

### Internal
- **A.0bis hardening** — Helmet + Throttler 3-tier + body limits 2mb, nginx security headers, console→Logger, Zod schemas para JSONBs.

---

## Pre-2026-05 — Auditoría base + decisiones iniciales

### Added
- **Auditoría base** (60 findings) en [`docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md).
- **Stack inicial** — NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary; Angular 18 standalone + PrimeNG + Tailwind + Spartan UI; Capacitor + Dexie mobile; Nx monorepo + Docker + Railway.
- **Auditoría visitas + scoring + reports** funcional. No tomaba pedidos, no catálogo comercial, no multi-tenant.

---

## Convención de updates

1. **Al cerrar feature o sprint** — agregar entry bajo la fecha actual.
2. **Una sección `[Unreleased]`** al tope agrega los cambios sin tag formal.
3. **Categorías estándar:** Added · Changed · Fixed · Deprecated · Removed · Internal · Pending.
4. **No duplicar lo de `03_LOG_REVISIONES.md`** — ese tiene el detalle de lessons learned + diff de archivos. CHANGELOG es la vista "scan en 30 segundos".
5. **Referenciar memoria cuando aplique** — `project_*` o `feedback_*` para más contexto.
