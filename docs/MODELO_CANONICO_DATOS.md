# Modelo canónico de datos y arquitectura anti-desincronización

> Plataforma B2B multi-tenant (Mega Dulces) · Postgres en Railway (prod) · feeds Kepler/Wincaja
> Alcance analizado: PRODUCTO, PRECIO, COSTO, EXISTENCIA, CLIENTE, MARCA/CATEGORÍA, VENTAS/SELL-OUT.
> **Producido por un análisis multi-agente (7 analistas de entidad + síntesis + crítica adversarial) que trazó el linaje REAL en el código y verificó los desvíos contra prod (2026-08-15).**
> ⚠️ Leer la **§7 (Salvedades críticas)** ANTES de ejecutar cualquier fase — corrige promesas del plan que no aplican a este stack.

---

## 1. Resumen ejecutivo

**El problema de raíz.** El mismo atributo de negocio (el nombre de un producto, su precio de venta, su costo, su existencia) se **escribe en varias tablas por varios feeds distintos, que leen de fuentes distintas, a cadencias distintas** — y encima muchos de esos feeds siguen leyendo copias viejas (KP_CONCENTRADA @4h cross-LAN, o Mega_Dulces basado en archivos y stale) **cuando la copia más fresca ya vive en el mismo Postgres de prod** (`kepler_ods.*`, replicado directo de las 6 sucursales @~1–10 min). El resultado es *split-brain*: `product_prices.BASE-MXN` muestra el precio de hoy mientras `P1-P4/MAYOREO` muestran el de hace 6 días desde otra fuente; `catalog.products` tiene 1685 barcodes divergentes y 635 SKUs faltantes porque su feed va 4h atrás; `inventory.warehouse_stock` lleva 2 meses congelada modelando la misma existencia que `commercial.stock` refresca cada 15 min. No es un bug puntual: es un patrón arquitectónico — **N escritores compitiendo por la misma columna sin un único dueño, snapshot ni orden**.

**La tesis del fix.** Una entidad = una fuente de verdad = un escritor. La fuente de verdad debe ser **`kepler_ods.*`, que ya está en prod** (cero egress, same-DB, al minuto), no las N tablas viejas fuera de prod. Todo lo demás **se deriva, no se copia**: vista/MV sobre la maestra siempre que la tabla no tenga columnas propias de app; y cuando *sí* hay que materializar, **un solo feed atómico, un solo snapshot, una sola transacción** con reglas de dedup unificadas. Los snapshots point-in-time (precio en `order_lines`, existencia en `purchase_requisition_lines`) son correctos y deben quedar congelados por diseño. Los paths viejos (Mega_Dulces: `import-catalog-bulk`, `import-prices-bulk`, `mega_dulces_sync`) **se retiran del orquestador**, no se dejan "por si acaso": mientras existan, alguien los corre y revierten identidad fresca a valores viejos.

> **Matiz crítico (ver §7):** `kepler_ods` es la copia más fresca PERO es infraestructura de 4 días, UPSERT-only (no propaga bajas), con skew per-sucursal y falla silenciosa post-VACUUM. Es un **push frágil monitoreado**, no un oráculo. Y "una fuente única" debe leerse como **"un escritor por (entidad, partición)"** porque Kepler y Wincaja son universos disjuntos legítimos (no redundantes).

---

## 2. Mapa de fuente única de verdad

| Entidad | Fuente de verdad autoritativa (ya en prod) | Tablas copia / derivadas | Quién las escribe HOY | Riesgo |
|---|---|---|---|---|
| **PRODUCTO** (sku/nombre/barcode) | `kepler_ods.kdii` @~1min (c1=sku, c2=nombre, c7=barcode, c3=línea) + `wincaja.articulos` para SKUs POS-only | `catalog.products` (tabla con cols de app), `products_active` (vista), `top_sellers_live`, `products_top_sellers` (MV legacy), `inventory.products/_active` | **Multi-writer:** repoint-catalog-presence + repoint-catalog-names (KP_CONCENTRADA @4h) + import-catalog-bulk (Mega_Dulces stale, match por NOMBRE) + import-wincaja-missing-products + mega_dulces_sync (legacy) | 🔴 635 SKUs vivos faltan · 1685 barcodes divergen · 35 nombres divergen · race @02:00 revierte identidad |
| **PRECIO venta** | `kepler_ods.kdii` @~10min (c90=pieza, c91=pack, c92=caja) + `kp.kdpv_prod_util` para tiers P1-P4/MAYOREO | `commercial.product_prices` (BASE-MXN + tiers), `product_label_prices`, `analytics.product_box_price` | BASE-MXN: repoint-catalog-prices (KP_CONCENTRADA c90). **Tiers: import-prices-bulk (Mega_Dulces STALE)**. Label: import-label-data. + legacy | 🔴 split-brain en la MISMA tabla: BASE fresco (14:10) vs P1-P4 stale (6 días) |
| **COSTO** unitario | `kepler_ods.kdik.c16` @~10min (26.660 filas, 6 suc; median_ratio vs cost_base = 1.0000) | `catalog.products.cost_base/with_tax`, `top_sellers_live`, `products_top_sellers` (fósil), `analytics.sales_daily.cost` (COGS ≠ costo) | import-catalog-bulk (modo catalog = **semanal**) + legacy mega_dulces_sync (net/gross mezclado) | 🔴 939 SKUs (16%) divergen >3%, 167 (2.9%) >20%; `updated_at` engaña |
| **EXISTENCIA** | `commercial.stock` (operativa @15:35, 9 almacenes) ← branches `md.kdil` (c4+c8−c9) **∪** `wincaja.v_stock`; linaje crudo = `kepler_ods.kdil` @10min | `inventory.warehouse_stock` (legacy), `analytics.inventory_health`, `replenishment_findings`, `purchase_requisition_lines` (snapshot OK) | import-branch-stock-live (Kepler 01-05) + wincaja stock (00/30/32/50) + app overlay. **warehouse_stock: feed NO agendado** | 🔴 `warehouse_stock` congelada 2 meses · skew 4h CEDIS↔sucursales |
| **CLIENTE** (identidad/rfc) | `md.kdud` 6 suc (c2=code, c3=name, c10=rfc); copia decodificada = `analytics.erp_customers` @nightly. **`kepler_ods.kdud` NO existe en prod** | `commercial.customers` (rfc vacío 3/3195), `wincaja.clientes` (47965, POS), `finance.bank_capture_senders` | erp_customers: import-erp-customers (nightly). customers: customers-from-excel + app | 🔴 dos maestros sin llave común (6/3195 matchean); facturación sin RFC real |
| **MARCA/LÍNEA** | `kepler_ods.kdig` @~10min (550 líneas c1) — hoy nadie deriva brands de aquí | `catalog.brands` (curada), `wincaja.familias/subfamilias` | import-brands-lineas (md.kdig, ALTAS-only) + **legacy mega_dulces_sync.syncBrands (RENOMBRA)** + fallback SIN-LINEA | 🔴 42 líneas nuevas faltan · 206 productos caen a "SIN LINEA" |
| **CATEGORÍA** | Kepler `kdie`/`kdif` vía `kdii.c4/c5` | `catalog.categories` (congelada 2026-06-01), `products.department/product_line` | mega_dulces_sync.syncCategories (NO agendado) + script que apunta a localhost | 🟡 congelada 2.5 meses; 3109/11099 sin category_id |
| **VENTAS/SELL-OUT** | Revenue/costo/tickets: `analytics.sales_daily` (canónico @15:49). Crudo más fresco: `kepler_ods.kdm1/kdm2` @~1min | `sales_monthly`, `product_sales_daily/monthly`, `sales_by_vendor_monthly`, vistas wincaja | sales_daily: import-sales-fact (mart.ventas :5433). **product_sales_*: leen 6 suc EN VIVO, c9 CRUDO** | 🔴 "unidades" definido 2× (normalizado vs crudo); Command Center ≠ /salidas |
| **⚠️ PROVEEDOR** (ver §7-G1) | Falta analizar — `commercial.suppliers` vs `analytics.contpaqi_suppliers` vs Kepler vs `wincaja` | idem | idem | 🔴 maneja dinero + EFOS + OCs |
| **⚠️ BANCO/movimiento** (ver §7-G2) | Falta analizar — 3 almacenes: `finance.bank_movements` vs `contpaqi_bank_movements` vs `kepler_bank_movements` | idem | idem | 🔴 conciliación manual, Piedra Rosetta |
| **⚠️ UOM/factor-caja** (ver §7-G3) | Falta analizar — factor en `catalog` (roto) vs `wincaja_product_box_factor` vs etiquetera | idem | idem | 🔴 "cajas infladas 10-40×", subyace al bug units |

---

## 3. Los landmines de desync priorizados

Ranked por severidad × probabilidad de ver **el mismo dato distinto en dos pantallas**.

### 🔴 HIGH

1. **PRECIO split-brain dentro de `commercial.product_prices`.** `BASE-MXN` desde KP_CONCENTRADA c90 (fresco 14:10); `P1-P4/MAYOREO` desde Mega_Dulces (STALE 6 días). Mismo atributo, misma tabla, dos fuentes, dos feeds. Cliente BASE ve precio de hoy; cliente P1-P4 ve el de hace 6 días.
2. **PRODUCTO — barcode nunca se corrige.** `repoint-catalog-names` solo actualiza si el **nombre** difiere (`WHERE upper(nombre)<>upper(nombre)`). Un barcode que cambia sin cambiar nombre **jamás** se corrige. Verificado: 1685 barcodes divergentes. *Gate lógico defectuoso.*
3. **PRODUCTO — presence-feed 4h+ atrás.** `catalog.products` recibe identidad de KP_CONCENTRADA @4h cuando `kepler_ods.kdii` @1min ya está en la misma DB. 635 SKUs vivos faltan.
4. **PRODUCTO — race @02:00 revierte identidad.** `import-catalog-bulk` (Mega_Dulces, matchea por NOMBRE) @02:00 revierte; `repoint-*` @03:00 re-corrige. ~1h de identidad stale.
5. **COSTO — refresh semanal contra fuente @10min.** `cost_base` semanal (Mega_Dulces) vs `kepler_ods.kdik` @10min. 939 SKUs (16%) divergen >3%. Peor: `updated_at` se ve fresco (lo bumpean otros feeds) → **falsa frescura**.
6. **COSTO — dos escritores con semántica opuesta.** `import-catalog-bulk` escribe `cost_base = NET`; legacy `mega_dulces_sync` escribe `cost_base = CON IVA (bruto)`. Si el legacy corre, mezcla net/gross.
7. **EXISTENCIA — tabla fantasma congelada 2 meses.** `inventory.warehouse_stock` modela la misma existencia que `commercial.stock` pero su feed (solo md_03) NO está agendado. Congelada desde 2026-06-15.
8. **EXISTENCIA — skew entre almacenes + race del overlay.** `commercial.stock` la escriben ≥4 escritores a cadencias distintas (hasta 4h skew). El overlay optimista de la app puede perderse/doble-contarse contra el snapshot Kepler.
9. **CLIENTE — dos maestros sin llave común.** `commercial.customers` (rfc vacío, codes IMP-*) no alinea con `erp_code` (6/3195). Facturación no obtiene el RFC real.
10. **VENTAS — "unidades" definido dos veces.** `sales_daily` normaliza (PAQ×pack, CJA×box); `product_sales_*` suma `kdm2.c9` CRUDO sin normalizar. Command Center ≠ /comercial/salidas. *(⚠️ ver §7-R4: el fix NO es centralizar en sales_daily.units)*
11. **MARCA — ALTAS semanal vs asignación nightly.** 42 líneas en `kepler_ods.kdig` aún no existen como brand → 206 productos "SIN LINEA" hasta la corrida semanal.
12. **MARCA — legacy renombra desde stale.** `mega_dulces_sync.syncBrands` pisa la normalización UPPERCASE curada.

### 🟡 MED

13. **PRECIO — mismo c90, dos reglas de dedup.** BASE-MXN (DISTINCT ON por `_loaded_at`) vs `product_label_prices` (DISTINCT ON por c90 más alto) → etiqueta ≠ pedido.
14. **PRECIO — caja duplicada.** `product_box_price.cja_price` (de kdpv) vs `kdii.c92`. `cja_price` ancla el reabasto.
15. **COSTO — 'cost' significa dos cosas.** Costo unitario (`cost_base`) vs COGS (`sales_daily.cost`, markup de una sola sucursal). Joins dan márgenes inconsistentes.
16. **EXISTENCIA — derivados 6-9h atrás.** `inventory_health.on_hand` nightly + `replenishment_findings` @06:00 vs `commercial.stock` @15min. Reorden sobre existencia ~9h vieja.
17. **VENTAS — sales_by_vendor_monthly stale 16 días.** Schedule separado fuera de run-prod-feeds. NO está en el dead-man switch.
18. **VENTAS — cutover Wincaja↔Kepler hardcodeado en 2 archivos.** Constantes CUTOVER duplicadas → si divergen, doble conteo o hueco.
19. **CATEGORÍA congelada + dos taxonomías.** `catalog.categories` sin feed; `products.department/product_line` por script que apunta a localhost.

### 🟢 LOW

20. **kepler_ods.kdil/kdig como trampa latente** — si un consumidor lee crudo en vez de la maestra curada.
21. **Wincaja universos paralelos** — `clientes`/`precios`/`articulo_proveedor.costo` nunca reconciliados por SKU/erp_code.
22. **Escritores ad-hoc residuales** — `import-kepler-prices`, `railway-product-prices-by-sku`, `commercial_import`, `mega_dulces_sync`: si se corren, reintroducen stale.

---

## 4. El patrón ANTI-DESYNC (la regla de oro)

> **Un atributo de negocio tiene un dueño, una fuente y un escritor _por partición_. Todo lo demás lo lee, no lo copia.**

### (a) Una ingesta, una fuente — leer lo que ya está en prod
La copia más fresca de Kepler **ya vive en `kepler_ods.*`** dentro del mismo Postgres (kdm1/kdm2/kdij/kdue @~1min; kdii/kdil/kdik/kdig @~10min). Same-DB, cero egress.
- **PROHIBIDO** que un feed lea KP_CONCENTRADA (@4h) o Mega_Dulces (archivos) para un atributo que `kepler_ods.*` ya expone.
- **PROHIBIDO** que un feed haga N pulls a las 6 sucursales cuando el ODS ya las consolidó. Un solo linaje: `md.* → kepler_ods.* → derivados`.
- **Excepción:** `kepler_ods.kdud` (cliente) no existe en prod → agregarlo a `KP_ODS_TABLES` (ver §7-P3, no es gratis).

### (b) Derivar, no copiar — vista/MV sobre la maestra
Si una tabla **no tiene columnas propias de app**, debe ser **vista**, no tabla.
- `catalog.products_active` ✅ ya es vista — modelo a seguir.
- `product_label_prices`, `product_box_price` → vistas sobre `kepler_ods.kdii`.
- `inventory.products_active` → vista sobre `catalog.products` + `image_url` propio.
- `product_sales_daily/monthly` → rollup sobre `analytics.sales_daily` (⚠️ ver §7-R4).
- `inventory.warehouse_stock` → vista sobre `commercial.stock` (o drop).
- **Regla:** materializar solo si (1) tiene columnas curadas/de app, o (2) el cálculo es caro y es hot-path. Si no → vista. *(⚠️ ver §7-R5: RLS no aplica a vistas/MVs tenant-scoped.)*

### (c) Fan-out atómico — un feed / un snapshot / una transacción
Cuando la tabla **sí** debe ser tabla (cols de app):
1. **Un solo escritor** por atributo. Nunca dos feeds tocando la misma columna.
2. **Un solo snapshot** leído una vez (`DISTINCT ON (sku)` con **una** regla de reconciliación en módulo compartido).
3. **Una transacción**: INSERT (nuevos) + REACTIVATE (borrados-vivos) + UPDATE (siempre-que-difiera, **sin gates tipo "el nombre debe diferir"**).
4. **Orden explícito** cuando hay dependencia (marca ANTES que producto, misma corrida, publica el mapa `code→brand_id`).

Ejemplo: reemplazar `repoint-catalog-presence`+`repoint-catalog-names`+`import-catalog-bulk` por **un** `sync-catalog-identity` que lee un snapshot de `kepler_ods.kdii` LEFT JOIN `wincaja.articulos` y sincroniza sku+nombre+barcode+brand en una transacción.

### (d) Cuándo un snapshot SÍ es correcto
Un snapshot point-in-time **inmutable es el diseño correcto** cuando el valor debe congelarse por evento legal/auditoría:
- ✅ `order_lines.unit_price` (precio al pedir, congelado por factura)
- ✅ `stock_reservation_lines.unit_price`
- ✅ `purchase_requisition_lines.on_hand` (existencia al crear la requisición)
- ✅ `erp_goods_receipt_lines.costo_unitario` (costo transaccional a la entrada)

**Test:** *¿el valor DEBE cambiar cuando cambia la fuente?* Sí → derivar. No (congelado por evento) → snapshot inmutable, **documentado como intocable**.

### (e) Matar los paths viejos — no "por si acaso"
Mientras un escritor stale exista y sea agendable, **alguien lo corre**. Retirarlos del orquestador y a `_legacy/`:
- Sacar de `run-prod-feeds.js`: `import-catalog-bulk`, `import-prices-bulk`.
- Retirar `mega_dulces_sync.js` (⚠️ ver §7-R6: primero dar reemplazo a categoría).
- Mover a `_legacy/`: `import-kepler-warehouse-stock`, `import-kepler-stock`, `import-kepler-prices`, `railway-product-prices-by-sku`.
- **Guardrail:** revocar grant / trigger que prohíba escritura libre de `rfc`/`cost_base` salvo por el feed dueño (⚠️ ver §7-P5: triggers han mordido el boot en este stack).

---

## 5. Plan de remediación por fases

### Fase 0 — Detener el sangrado (BAJO/BAJO) · *días*
- [ ] Sacar `import-catalog-bulk` e `import-prices-bulk` del modo `catalog`. → Mata reversión @02:00 + split-brain de tiers.
- [ ] Retirar `mega_dulces_sync.js` como escritor **(⚠️ dar reemplazo a categoría primero — §7-R6)**.
- [ ] Mover a `_legacy/`: `import-kepler-warehouse-stock`, `import-kepler-stock`, `import-kepler-prices`, `railway-product-prices-by-sku`.
- [ ] Quitar el gate "el nombre debe diferir" de `repoint-catalog-names`. → Corrige 1685 barcodes.

### Fase 1 — Repuntar SRC a `kepler_ods.*` (BAJO-MEDIO/BAJO) · *1-2 semanas*
- [ ] `repoint-catalog-presence/names` → leer `kepler_ods.kdii` (no KP_CONCENTRADA @4h). → Cierra 635 SKUs + 35 nombres.
- [ ] `repoint-catalog-prices` + `import-label-data` → SRC = `kepler_ods.kdii` (c90/91/92). **Aplicar piso anti-promo c90>0.05 (§7-R7)**.
- [ ] `import-brands-lineas` → SRC = `kepler_ods.kdig`, mover a nightly **ANTES** de productos. → Cierra 42 líneas / 206 productos.
- [ ] Nuevo feed de costo desde `kepler_ods.kdik.c16` (net+gross), nightly. → Cierra 939 SKUs.
- [ ] Replicar `kdpv_prod_util`, `kdud`, `kdie/kdif` a `kepler_ods` **(§7-P3: incrementa carga del push frágil)**.

### Fase 2 — Feeds atómicos (MEDIO/MEDIO) · *2-4 semanas*
- [ ] `sync-catalog-identity` — presence+names+wincaja en UN feed atómico (verificar ghost products §7-R8 antes).
- [ ] `sync-prices` atómico — un snapshot kdii+kdpv → product_prices (BASE+tiers) + label + box en una transacción, misma regla de dedup.
- [ ] Feed único de stock — Kepler + wincaja en el mismo ciclo; watermark en DB (no `.stock-live-snapshot.json`).
- [ ] Centralizar constantes de cutover Wincaja↔Kepler en módulo compartido.
- [ ] Crosswalk `commercial.customers.erp_code` + backfill + proyección de rfc/name desde `erp_customers`.

### Fase 3 — Derivar, no copiar (MEDIO-ALTO/MEDIO) · *3-6 semanas*
- [ ] `product_label_prices`, `product_box_price` → vistas (o materialización del feed de Fase 2).
- [ ] `product_sales_*` → rollup sobre `sales_daily` **anclado a REVENUE, no units (§7-R4)**.
- [ ] `inventory.warehouse_stock` → vista sobre `commercial.stock` (o drop; verificar consumidores §7-Verif6).
- [ ] `inventory.products_active` → vista sobre `catalog.products` + `image_url`.
- [ ] `inventory_health.on_hand` / `replenishment_findings.on_hand` → derivar de `commercial.stock`.
- [ ] Resolver **RLS en vistas** antes de convertir tablas tenant-scoped (§7-R5).

### Fase 4 — Gobierno y observabilidad (BAJO, continuo)
- [ ] Check de desync en `/admin/db-health`: por entidad, contar `barcode_diff / name_diff / missing / cost_diff / price_skew(BASE vs tiers vs label) / units(sales_daily vs product_sales)` y alarmar.
- [ ] Registrar TODOS los feeds en `db-health` CRON_JOBS (incl. `sales_by_vendor_monthly`, wincaja analytics).
- [ ] Documentar en `CLAUDE.md` / `ARQUITECTURA_DATOS.md` la fuente única por entidad + snapshots inmutables.

---

## 6. Reglas de gobierno — checklist antes de agregar tabla/feed

**Fuente:** 1) ¿el atributo ya tiene fuente de verdad en §2? → no crees otra, deriva. 2) ¿leo la más fresca ya en prod (`kepler_ods.*`)? → si voy a leer KP_CONCENTRADA/Mega_Dulces, detente.
**Forma:** 3) ¿mi tabla tiene columnas propias de app? → si no, hazla vista. 4) ¿un solo escritor por columna?
**Escritura:** 5) ¿un snapshot, una transacción, una regla de dedup? 6) ¿UPDATE siempre-que-difiera (sin gates)? 7) ¿dependencias en orden en la misma corrida?
**Snapshot:** 8) ¿el valor debe cambiar con la fuente? sí→derivar / no→snapshot inmutable documentado.
**Paths viejos:** 9) ¿dejo un escritor stale "por si acaso"? → no, a `_legacy/`.
**Observabilidad:** 10) ¿está en el dead-man switch + check de divergencia?

> **Test de una línea para revisar cualquier PR de datos:** *"¿Este atributo, para este SKU/cliente, puede aparecer distinto en dos tablas al mismo tiempo?"* Si la respuesta no es un **no** demostrable → hay un desync latente, no lo mergees.

---

## 7. Salvedades críticas (revisión adversarial) — LEER ANTES DE EJECUTAR

La crítica adversarial encontró que el plan de §1-§6 es sólido en las 7 entidades elegidas pero **omitió la mitad del universo de duplicación** y **descansa en `kepler_ods` — infraestructura de 4 días** cuyos modos de falla silenciosa el plan trata como "oráculo". Varias promesas ("mata el skew de 4h", "mata el bug de units") son **falsas** para este stack. Estas salvedades enmiendan el plan:

### Entidades HIGH que faltan (agregar al mapa §2)
- **G1 — PROVEEDOR** (gemelo de CLIENTE, omitido): `commercial.suppliers` vs `analytics.contpaqi_suppliers` (3411) vs Kepler vs `wincaja.articulo_proveedor`, dedup 1219→959. **Maneja dinero y riesgo fiscal**: enruta OCs, pagos ($346M), detección EFOS. Split-brain = OC mal enrutada + EFOS no detectado + pago duplicado.
- **G2 — BANCO/movimiento**: **tres** almacenes del mismo hecho — `finance.bank_movements` (Excel CB) vs `analytics.contpaqi_bank_movements` (147k) vs `analytics.kepler_bank_movements` (tesorería) + crosswalk `bank_accounts.contpaqi_cuenta`.
- **G3 — UOM / factor de caja**: la raíz REAL del bug de "units". El factor vive en `catalog` (roto), `wincaja_product_box_factor`, la etiquetera — "cajas infladas 10-40×". Alimenta precio-caja, reabasto y sell-out a la vez.
- **G4 — FOLIO** (clase distinta: correctness de JOIN, no frescura): el folio **NO es único entre doctypes** → JOIN por folio sin `doc_prefix` colisiona pagos con órdenes con notas de crédito. El patrón anti-desync no lo cubre.
- **G5 — POLIZA** (`gl_polizas` Kepler 75k + ContPAQi 17.5k, join `AsocCFDIs` roto) · **G6 — RUTA/VENDEDOR** (colisión `RUTA-NN` vs `01-NNN`, `serie c63≠ruta`) · **G7 — ALMACEN** (mapeos hardcodeados `STOCK_BRANCH_MAP` que pueden driftar).

### Riesgos pasados por alto (corrigen el plan)
- **R1 — `kepler_ods` NO propaga hard-DELETE** (`replicate-ods-fast.js:14`, UPSERT-only). Una **vista sobre `kepler_ods`** deja SKUs descontinuados **vivos para siempre**. La §4(b) asume que la maestra expresa altas Y bajas; no puede.
- **R2 — CDC por ctid tiene staleness silenciosa post-VACUUM** (`:15-16`). Requiere `--full` nightly; si falla, updates se pierden **sin error**. "@2min" es cierto solo si el reset nightly funciona.
- **R3 — El skew de 4h NO se elimina; se relocaliza.** El ODS lee 6 branch DBs en 6 subredes independientes con watermark propio → si una es inalcanzable, sus tablas ODS se congelan mientras otras avanzan. La promesa de Fase 2 "elimina el skew" es **falsa**: es inherente a 6 servidores.
- **R4 — `sales_daily.units` es la fuente EQUIVOCADA para arreglar units.** Quiebre Wincaja oct-2025: **revenue = verdad, units = sospechoso**. Hacer `product_sales_*` vista sobre `sales_daily` **propaga el número malo**. El fix real es **anclar demanda a revenue**, no centralizar units.
- **R5 — RLS vs "derivar como vista" (hueco de seguridad).** RLS **no aplica a MVs**; convertir `commercial.stock`/`catalog.products` en vistas sobre `kepler_ods` (raw ERP single-tenant) rompe el aislamiento o exige reinyectar `tenant_id` manual en cada vista (el filtro olvidable que causa fugas cross-tenant).
- **R6 — Retirar `mega_dulces_sync` en Fase 0 deja CATEGORÍA sin escritor** (contradicción interna: su reemplazo no llega hasta Fase 3). Secuenciar: reemplazo primero.
- **R7 — Piso anti-promo omitido** en el feed atómico de precio: promo $0.01/$0.05 contamina c90, requiere `c90>0.05`.
- **R8 — Ghost products** (1138 sin SKU) pueden ser parte de los "635 SKUs faltantes" → verificar antes de "arreglarlos" y meter basura.

### La regla de oro, corregida
**"Una entidad = una fuente = un escritor" es absolutista y falso.** EXISTENCIA y PRODUCTO vienen de Kepler **∪** Wincaja (POS-only 30/32/50), fuentes **disjuntas legítimas**. El modelo correcto es **un escritor por (entidad, PARTICIÓN)** con unión-por-precedencia, no fuente-única.

### 7 verificaciones ANTES de ejecutar
1. Lag real per-tabla/per-sucursal: `SELECT table_name, last_push_at FROM kepler_ods._sync_status` en prod (Fase 1 asume frescura uniforme que R3 niega).
2. `sales_daily.units` confiable → **casi seguro FALSO** (oct-2025).
3. `kepler_ods` expresa bajas → **FALSO** (UPSERT-only, R1).
4. `median_ratio kdik=1.0000` → verificar en las 6 sucursales (puede diferir per-branch).
5. Los 635 SKUs faltantes son vendibles → cruzar contra ghost (R8).
6. `inventory.warehouse_stock` tiene consumidores → `grep` antes de rankearla HIGH (si nadie la lee, es peso muerto, no desync).
7. Retirar paths viejos no borra el único escritor de alguna columna → inventariar columnas que SOLO `mega_dulces_sync` escribe (categoría confirmado).

**Archivos clave:** `database/importers/kepler/replicate-ods-fast.js` (líneas 14-16: modos de falla), `apps/api/src/modules/db-health/db-health.service.ts:56-58` (cadencia ODS @2min), `services/feeds-ingest/apply-handlers.js` (escritor real de stock/ODS en Railway).

---

*Generado por análisis multi-agente (workflow `desync-canonical-model`, 9 agentes, 2026-08-15). Regenerar tras cambios grandes de pipeline. La §7 es parte integral — el plan sin sus salvedades reintroduce desync.*
