# Fase RA — Reabastecimiento (Punto de Reorden · Existencia Crítica · Sugerido de Compra)

> **Estado:** 🟢 CERRADA (beta) — 2026-07-09. RA.0–RA.9 + RA.11–RA.14 en código y verificados. **Desplegada a prod**: 5 migraciones aplicadas a Railway (batch previo + batch 96), código en origin/main, permisos `COMPRAS_*` en prod. Smoke dedicado `test-newdb-replenishment.js` (18/18) en la regression suite (RA.9). **Diferidos** (bajo valor / bloqueados): RA.10 forecast (requiere backfill multi-año), RA.13b fill rate histórico (~100% artificial), RA.14 auto-received (matching frágil), write-back Kepler. Operacional: el runner nightly puebla `purchase_in_transit` + hallazgos.
>
> **Implementación (2026-07-08):**
> - **RA.1** ✅ Migración `20260708120000_commercial_reorder_policy` (reorder_policy + requisitions/lines + requisition_sequences + `suppliers.lead_time_days`, RLS forzado) + `20260708120100_compras_perms_backfill` (COMPRAS_VER/GESTIONAR). Permisos en 6 lugares (enum backend+frontend, ability.factory subject+action, AppSubject, permission-meta, seed). Aplicado local (Batch 149, 15 roles).
> - **RA.2** ✅ `import-reorder-policy.js` (BULK, reusa STOCK_BRANCH_MAP, preserva `manual`) + wire `run-prod-feeds nightly`. Aplicado local: **3924 políticas** (KEPLER-03 1681, KEPLER-02 1001, MD-30 643, MD-50 599; CEDIS 0; PH VPN).
> - **RA.3** ✅ `import-computed-reorder.js` (reorden por demanda, no pisa kepler/manual). SQL válida; produce 0 en local (sin ventas locales) → se ejercita en prod.
> - **RA.4** ✅ Módulo `commercial-replenishment` (critical-stock + sugerido + summary + filters), wireado en AppModule. SQL validada vs data real: 449 agotado / 447 bajo mín / 83 bajo reorden / 2909 sobrestock, sugerido $1.1M.
> - **RA.6** ✅ Proyecto **Compras** (`/compras`): tile en projects, nav en layout (`comprasNavItems`), rutas, `compras.service.ts`, página **Existencia Crítica** (KPIs+filtros+tabla+generar requisición). `nx build view` OK.
> - **RA.7** ✅ Requisiciones HITL: backend (create folio atómico / approve / reject) + bandeja + detalle (aprobar/rechazar). Smoke DB OK (folio 1→2, insert FK). `nx build api` OK.
> - **RA.5** 🧪 IMPLEMENTADO local 2026-07-09 (mig `20260709140000_analytics_purchase_in_transit`, Batch 156): `analytics.purchase_in_transit` (sin RLS) + `import-in-transit.js` (OCs `X-A-35` sin `X-A-40` aguas abajo vía vale `X-A-37`, BULK, reusa STOCK_BRANCH_MAP, filtra `kdm1.c1`=sucursal) + wire `run-prod-feeds nightly`. Backend: `inTransit()` deja de ser 0 → join a `purchase_in_transit`; sugerido = `max(0, objetivo − existencia − tránsito)`. Frontend: columna "OC a recibir". Builds api+view OK; smoke SQL OK (sugerido 1→0 con tránsito 1). Se ejercita en prod (local sin OCs Kepler).
> - **RA.8** 🧪 IMPLEMENTADO local 2026-07-09 (mig `20260709160000_replenishment_findings`, Batch 157): tabla `commercial.replenishment_findings` (RLS forzado, UPSERT por `dedup_key`, se auto-resuelve) + `ReplenishmentScannerService` (`@Cron` nocturno 06:00 UTC = 00:00 MX + `scanTenant`/`scanAllTenants`) que detecta **agotado_abc** (clase A ≤ 0 → crítica) y **bajo_reorden** (≤ punto de reorden → alta si A, media si no), restando el tránsito (RA.5). Endpoints `GET /replenishment/findings` + `POST /replenishment/scan-now`. Frontend: página **`/compras/hallazgos`** (bandeja + "Escanear ahora") + nav. WS realtime = diferido (la bandeja es la superficie; el cron se apaga con `ENABLE_REPLENISHMENT_SCAN=false`). Builds api+view OK; smoke: 979 hallazgos local, UPSERT idempotente.
> - **RA.11 + RA.13a + RA.14** 🧪 IMPLEMENTADO local 2026-07-09 (mig `20260709120000_ra_purchasing_flow`, Batch 155): **RA.11** origen proveedor/sucursal por línea (`source_type`+`source_warehouse_id`, MVP solo clasifica) · **RA.13a** mínimo de pedido EN CAJAS (`suppliers.min_order_boxes`, aviso en el dialog) · **RA.14** flujo `approved→ordered→received` (markOrdered/markReceived + received_qty → fill rate). **RA.12** selector multi-sucursal (p-multiSelect, key `product_id|warehouse_id`, N requisiciones por almacén). Backend (service+controller) + frontend (existencia-crítica reescrita + detalle con botones/columnas + bandeja). Builds api+view OK; smoke SQL OK (branch CHECK, estados, fill 20/24, min_boxes). **Pendiente:** RA.13b fill rate histórico + RA.14 auto-received (dependen de RA.5), y prod (migs Railway + re-login + redeploy).
> - **Pendiente prod:** aplicar migs 20260708120000/120100 a Railway + `re-login` (permisos) + agendar `import-reorder-policy`/`import-computed-reorder` en el runner + redeploy api+view.
> **Tesis:** portar a la plataforma la lógica de reabastecimiento que Mega Dulces ya opera en Kepler (reporte "Existencia Crítica" → orden de compra sugerida), reusando la infraestructura de inventario (Fase I/ABC/FEFO), analytics (inventory_health) y el patrón HITL (Maat/SM). El **motor decide** (umbrales + demanda), el **humano aprueba** (bandeja de requisiciones), el **LLM fuera del camino** (ADR-016).
> **Fuente de la investigación:** decode del ERP Kepler + verificación contra datos vivos (2026-07-08). Ver §2.

---

## 1. Objetivo y alcance

### Qué resuelve
Hoy la plataforma **no sabe cuándo pedir ni cuánto**. El low-stock es un umbral **hardcodeado** (`10` en analytics, `50`/`20` en alertas — ver `commercial-analytics.service.ts:721`, `alerts.types.ts:35`). Mega Dulces **ya tiene** umbrales de reorden reales capturados en Kepler (`kdii.c33/c34/c35` = mínimo/reorden/máximo) que hoy no explotamos.

**Fase RA trae eso a la plataforma:**
1. **Importa** los umbrales reales de Kepler (mínimo / punto de reorden / máximo) por producto×sucursal.
2. **Computa** umbrales para el ~82% de SKUs sin config en Kepler, desde demanda real (rotación).
3. **Reporte "Existencia Crítica"**: clasifica cada SKU (agotado / bajo mínimo / bajo reorden / sano / sobrestock) cruzando existencia vs umbrales vs OC en tránsito.
4. **Sugerido de compra**: `objetivo − existencia − en_tránsito` por producto.
5. **Bandeja HITL de requisiciones**: el comprador revisa, ajusta, aprueba → genera requisición (semilla del futuro módulo de Compras).

### Fuera de scope (diferido — ver §12)
- Write-back de la orden de compra a Kepler (`comopecompras`).
- Módulo de Compras completo (recepción, CxP, matching factura).
- Optimización multi-proveedor / EOQ / pronóstico ML.
- Reorden por lote/caducidad (se apoya en FEFO existente pero no lo altera).

---

## 2. Hallazgo de investigación (base del plan)

### 2.1 Decode confirmado
Del **source del propio Kepler** (`Z:\Kepler\K95_Dev\temp\invcatprdpag.kpl`, form de producto, sección *Inventario*):

| Etiqueta Kepler | Binding | Columna |
|---|---|---|
| Mínimo | `set("invMin","a33")` · `Cambio(33,…)` | `kdii.c33` |
| Punto de reorden | `set("PR","a34")` · `Cambio(34,…)` | `kdii.c34` |
| Máximo | `set("invMax","a35")` · `Cambio(35,…)` | `kdii.c35` |

`tabla_base="kdii"`, `camposDeseados="a1...a36,..."` → los campos `aN` son columnas `cN` de `kdii`.

### 2.2 Verificación contra datos vivos (md_03, `platform_ro`, 2026-07-08)
- **Poblado por sucursal** (kdii es físico por branch): `md_00`/CEDIS = **0** configurados; `md_03` = **1699 / 9344 (18%)**, con los tres seteados **juntos**.
- **Valores coherentes**: ratio constante ≈ **1 : 1.5 : 2** (mín : reorden : máx). Ej. `ETIQUETAS` 3867/5800/7714.
- **NO son precios** (resuelve el conflicto con la doc): `FRES KIDD` precio $1.69 pero c33/34/35 = 1437/2155/2866; `CHURRO` $6.83 pero c33=1167. Son **unidades**. `kdii.c13/c14` (donde la doc vieja ponía "precios") están en **0**. Los precios reales viven en `md.kdpv_prod_util`. → `KEPLER_TABLAS_COMPLETO.md:85` ya corregido.

### 2.3 Cómo Kepler lo consume (flujo de referencia a replicar)
Reporte **"Reporte de Existencia Crítica"** (`invconpanecrrep.kpl`):
- **Fuentes**: existencia (`kdik`: `c4+c5−c6`) + umbrales (`kdii.c33/34/35`) + **OC a recibir** (compras en tránsito: `kdm2` doctype `X-A-35`).
- **Clasificación** (loop): `exist < min` → *MÍNIMOS*; `min ≤ exist < reorden` → *PREORDEN*; `reorden ≤ exist < max` → normal. Filtro "por debajo de: Mínimo / Punto reorden / Todo".
- **Sugerido**: `cantidad = objetivo − existencia`, con `objetivo ∈ {mínimo, punto de reorden, máximo}` (radio; default hasta el objetivo elegido). Si `≤ 0` no pide. Muestra OC a recibir para no duplicar.
- **Acción**: genera orden de compra (`comopecompras`) con el proveedor del producto; botón "para todos".

### 2.4 Mapeo sucursal Kepler → almacén plataforma + cobertura (verificado 2026-07-08)

| Branch Kepler | DB | `commercial.warehouses.code` | SKUs c/stock | Cobertura reorden (`c34<>0`) |
|---|---|---|---:|---:|
| 00 · CEDIS | md_00 | `MD-CEDIS` | 158 | **0 / 9345 (0%)** |
| 01 · Padre Hidalgo | md_01 | `MD-10` | 1918 | pendiente (VPN timeout) |
| 02 · La Piedad | md_02 | `KEPLER-02` | 3270 | 1010 / 9346 (11%) |
| 03 · 8 Esquinas | md_03 | `KEPLER-03` | 3848 | 1699 / 9344 (18%) |
| 04 · Yurécuaro | md_04 | `MD-30` o `MD-50` (TBD) | — | 647 / 9344 (7%) |
| 05 · Zamora | md_05 | `MD-30` o `MD-50` (TBD) | — | 600 / 9345 (6%) |

Naming **mixto** (`KEPLER-0X` vs `MD-XX`) por historia de importers. **Regla de oro:** el importer de reorden **reusa el mismo `STOCK_BRANCH_MAP`** que el stock → misma clave `code` → reorden y existencia siempre en el mismo `warehouse_id`. Cobertura total ≈ 0–18% ⇒ el cómputo (RA.3) cubre el grueso, especialmente CEDIS.

### 2.5 Cadena de compras real en Kepler (decode verificado end-to-end, 2026-07-09)

Investigación contra `md_03` vivo (`platform_ro`), catálogos `md.doctype`/`md.kdmm`, kardex `md.kdij` y las formas custom de Mega Dulces (`Z:\Kepler\K95_Dev\temp\MD_*.kpl`). **El folio `xa3701-0007556` = Vale de entrada** (doctype custom `X-A-37`).

**Codificación de documentos:** todo doc = `{género}{naturaleza}{grupo}{tipo}` en `md.kdm1` (encabezado) + `md.kdm2` (líneas). Compras = **género `X`**. Columnas clave `kdm1`: `c1`=sucursal, `c2`=género, `c3`=naturaleza, `c4`=grupo, `c5`=tipo, `c6`=folio, `c9`=fecha, `c10`=proveedor, `c16`=total, `c24`=almacén destino, `c32`=nombre proveedor, `c63`=prefijo folio. **Enlace entre eslabones = back-pointer `c36`(nat)/`c37`(grupo)/`c38`(tipo)/`c39`(folio) → apunta al documento PADRE.** Líneas `kdm2`: `c8`=sku, `c9`=qty, `c11`=unidad, `c12`=precio, `c13`=importe.

**La cadena (verificada ≈1:1:1:1 en la columna vertebral, branch 03):**

| # | Documento | doctype | tabla | enlace `c37/c39`→ | ¿mueve inventario? |
|---|---|---|---|---|---|
| 1 | Requisición de compra | `X-A-30` (XA3001) | kdm1/kdm2 | raíz (**opcional**) | NO |
| 2 | Orden de compra | `X-A-35` (XA3501) | kdm1/kdm2 | → req(30) | NO |
| 3 | **Vale de entrada** | `X-A-37` (XA3701) | kdm1/kdm2 | → OC(35) | NO |
| 4 | **Orden de entrada** | `X-A-40` (XA4001) | kdm1/kdm2 + **kdij** | → vale(37) | **SÍ (suma existencia)** |
| 5 | Aplica orden de entrada | `X-A-20` (XA2001) | kdm1 | → entrada(40) | NO (genera CxP: deb 511 / hab 201) |

Luego pago: `X-D-10` solicitud → `X-D-20/23/24` pago → `X-D-25/26` cheque/transferencia. Devoluciones `X-D-30/35/40`.

**Hallazgos duros:**
- **La mercancía entra al inventario en el paso 4 (Orden de entrada `X-A-40`), no antes.** De toda la cadena X, solo `X-A-40` aparece en el kardex `kdij` (14,022 movs / +543k uds en branch 03). Requisición, OC y vale NO tocan existencia.
- **La requisición es OPCIONAL:** ~⅔ de las OC nacen directas sin requisición (544 sin padre vs 280 con). El resto de la cadena (OC→vale→entrada→aplica) es ~1:1:1:1.
- **`X-A-37` (vale) es personalización de Mega Dulces** — Kepler base solo trae 30/35/40. Formas custom: `MD_req.kpl`, `MD_oc.kpl`, `Md_Ent.kpl`, `MD_OE.kpl`, `MD_AOE.kpl`.

**Compra a proveedor (género `X`) ≠ traspaso/surtido desde CEDIS (género `N`):**
- **Compra** = la cadena de arriba; hay proveedor (`c10`) y genera CxP (`X-A-20`).
- **Traspaso inter-sucursal** = género `N`, sin proveedor ni CxP: `N-D-6` "Salida Traspaso Sucursal" (origen, deb 114-006/hab 114-001) + `N-A-6` "Entrada Traspaso sucursal" (receptor). Ya lo captura `import-transfers-monthly.js`. **El reabasto desde CEDIS NO pasa por `X-A-3x`.** → base del Feature "origen sucursal vs proveedor" (RA.11).

**Compra mínima / fill rate en Kepler:**
- **Compra mínima por proveedor: NO existe.** `md.kdig` solo clave/nombre; `md.kdpv_prov_prod` trae `c4`=costo, `c8`=flete, `c9`=costo neto — sin cantidad mínima ni lead time. → **se captura manual en la plataforma** (RA.13a).
- **Fill rate (pedido vs recibido): derivable** cruzando qty `X-A-35` (OC) vs `X-A-40` (orden de entrada) por la cadena `c39`. Medición viva branch 03: 13,368 pares, 99.4% exactos. **⚠️ Caveat:** Mega Dulces captura toda la cadena de golpe (mismo minuto/usuario) → fill rate ~100% artificial. Solo tiene señal genuina en **OCs abiertas** (sin orden de entrada aguas abajo >1 día) = verdadero "en tránsito".

**Cómo se integra (solo lectura, patrón BULK, nunca write-back — ADR-016):**
- **OC en tránsito (RA.5):** OCs `X-A-35` **sin** orden de entrada `X-A-40` descendiente → `analytics.purchase_in_transit`.
- **Auto-"surtida":** una requisición está surtida cuando existe su `X-A-40` aguas abajo (seguir back-pointer `c39`).
- **Fill rate:** `sum(qty X-A-40) / sum(qty X-A-35)` por sku, matcheado por cadena (usar solo OCs abiertas por el caveat).
- Clonar `import-erp-shipments.js` (lee `kdm1`/`kdm2` por sucursal, filtro `c1`=sucursal propia por réplicas, staging temp + merge).

**Incógnitas menores** (no bloquean): unidad caja-vs-pieza en `X-A-40` (`kdm2.c11` vs `kdij`); prefijo `ORC-` en 12 OCs custom; mapear la cadena de traspaso `N` documento-a-documento (`MD_tras_suc.kpl`).

---

## 3. Modelo de datos

### 3.1 Grano y unidades (decisiones)
- **Grano de umbrales = producto × almacén.** En Kepler el reorden es por producto en el master de **cada sucursal** (no por almacén interno). En nuestro modelo cada sucursal Kepler ≈ un `commercial.warehouses` (ej. branch `03` → warehouse `KEPLER-03` / `8ESQ`). Guardamos umbral por `(warehouse_id, product_id)` para permitir override por almacén y computar existencia crítica contra `commercial.stock` (que es warehouse×product).
- **Unidad = base (piezas), consistente con `commercial.stock.quantity`.** El importer de stock ya usa `kdil` existencia en unidad base; `kdii.c33/34/35` están en la misma unidad. **RA.0 debe confirmarlo** (riesgo pieza vs caja, ver §10).

### 3.2 Tablas nuevas

**`commercial.reorder_policy`** — política de reorden por producto×almacén (slow-changing, separada del saldo).
```
id                uuid PK
tenant_id         uuid NOT NULL           -- RLS
warehouse_id      uuid NOT NULL           -- FK (tenant_id, warehouse_id) → commercial.warehouses
product_id        uuid NOT NULL           -- FK (tenant_id, product_id) → public.products
min_stock         numeric(14,3) NOT NULL default 0
reorder_point     numeric(14,3) NOT NULL default 0
max_stock         numeric(14,3) NOT NULL default 0
source            varchar(12) NOT NULL    -- 'kepler' | 'computed' | 'manual'
lead_time_days    integer                 -- usado por el cómputo; nullable
safety_stock      numeric(14,3)           -- componente del cómputo; nullable
computed_at       timestamptz             -- cuándo se computó/importó
updated_by        uuid
created_at, updated_at timestamptz NOT NULL default now()
UNIQUE (tenant_id, warehouse_id, product_id)
UNIQUE (tenant_id, id)
CHECK (min_stock <= reorder_point AND reorder_point <= max_stock)   -- coherencia (nota: permitir 0s)
-- RLS FORCE + policy tenant_isolation + GRANT app_runtime  (helper createTenantRls)
```

**`commercial.purchase_requisitions`** (RA.7) — requisición generada desde la bandeja (semilla de Compras).
```
id, tenant_id, warehouse_id, supplier_id (nullable), folio (RQ-YYYY-NNNNN),
estado varchar(16) CHECK ('draft','pending_approval','approved','ordered','cancelled') default 'pending_approval',
target_basis varchar(12) CHECK ('min','reorder','max'),  -- objetivo usado
total_lines int, total_units numeric, total_cost numeric,
created_by, approved_by, approved_at, notes, created_at, updated_at
UNIQUE (tenant_id, id) · RLS forzado
```
**`commercial.purchase_requisition_lines`**
```
id, tenant_id, requisition_id (FK compuesta), product_id, supplier_id (nullable),
on_hand numeric, in_transit numeric, min_stock, reorder_point, max_stock,
suggested_qty numeric, final_qty numeric,  -- editable por el comprador
unit_cost numeric, line_cost numeric, created_at
RLS forzado
```

**`analytics.purchase_in_transit`** (RA.5, opcional) — OC a recibir desde Kepler.
```
tenant_id, warehouse_id, product_id, qty_in_transit numeric, computed_at
PK (tenant_id, warehouse_id, product_id)   -- sin RLS (patrón analytics) → filtro tenant_id explícito
```

### 3.3 Columnas nuevas en tablas existentes
- `catalog.suppliers.lead_time_days integer` (default configurable; usado por el cómputo). Migración estilo `20260603200000_warehouses_truck_kind.js`.
- (Opcional) `catalog.suppliers.min_order_value numeric` para futuras reglas de compra mínima.

### 3.4 Reuso (NO se crean)
- `commercial.stock` (`quantity`, `reserved_quantity`) → existencia.
- `catalog.products` (`sku`, `supplier_id`, `cost_base`, `cost_with_tax`, `rotation_tier`, `sales_units_30d/90d`, `factor_purchase/sale`).
- `analytics.inventory_health` (`on_hand`, `avg_daily_units`, `days_cover`, `status`) → base del cómputo de reorden.
- `analytics.product_sales_stats` (`units_30d/90d/365d`, `abc_class`) → demanda + priorización ABC.
- `catalog.suppliers`, `commercial.warehouses`.

---

## 4. Arquitectura (flujo end-to-end)

```
                          ON-PREM (runner .249, Task Scheduler)
 Kepler md_00..md_05  ──►  import-reorder-policy.js  ──BULK──►  commercial.reorder_policy (source='kepler')
 (kdii.c33/34/35)          (platform_ro, por branch)                    ▲
                                                                        │  fallback compute (source='computed')
 analytics.inventory_health ─────────────────────────────────────────►─┘  reorder = ceil(avg_daily·lead) + safety
 Kepler compras (kdm2 X-A-35) ─► import-in-transit.js ─► analytics.purchase_in_transit   (RA.5)
                                                     │
                              (destino: DATABASE_URL_NEW = proxy Railway; guard proxy)
 ─────────────────────────────────────────────────────────────────────────────────────────
                          RAILWAY (API NestJS)
 commercial-replenishment.service
   critical-stock():  stock ⋈ reorder_policy ⋈ products ⋈ suppliers ⋈ in_transit
        → bucket (agotado/bajo_minimo/bajo_reorden/sano/sobrestock)
        → suggested_qty = max(0, objetivo − on_hand − in_transit)
   GET /commercial/replenishment/critical-stock         (COMPRAS_VER)
   POST /commercial/replenishment/requisitions          (COMPRAS_GESTIONAR)  → pending_approval
   POST /commercial/replenishment/requisitions/:id/approve|reject
   cron @nightly: recompute 'computed' + persist finding "bajo_reorden_critico"
 ─────────────────────────────────────────────────────────────────────────────────────────
                          FRONTEND (apps/view, Operations)
 /almacen/reabasto  → tabla densa (existencia | mín | reorden | máx | OC a recibir | sugerido | proveedor)
        filtros: almacén, bucket, proveedor, ABC · acción "Generar requisición" · bandeja de requisiciones
```

**Módulo nuevo:** `libs/commercial/src/lib/commercial-replenishment/` (service + controller + scanner + module). El reporte read-only podría vivir en `commercial-analytics`, pero por cohesión (report + sugerido + HITL + requisiciones) se agrupa en un módulo dedicado que **reusa** los facts de analytics.

---

## 5. Decisiones de diseño y preguntas abiertas

### Decisiones (proponer como ADR-030)
1. **Tabla dedicada `commercial.reorder_policy`** (no columnas en `commercial.stock`): separa config lenta del saldo caliente, permite `source`/lead_time/auditoría.
2. **Kepler es la verdad donde existe; cómputo cubre el resto.** `source` distingue el origen; `manual` gana sobre ambos (override humano no se pisa por el importer — patrón `ensureRules` de Maat: merge que preserva lo humano).
3. **HITL sobre requisición propia, nunca write a Kepler** (ADR-016/013). "Ejecutar" = generar requisición interna / export; el write-back a `comopecompras` es diferido.
4. **`commerce_signals` NO aplica**: esa tabla exige `customer_id NOT NULL` (es CRM). El reorden se surface por el reporte + `finding`, no por señal Thot.
5. **Motor determinista, LLM fuera.** El sugerido es aritmética auditable. (Un "explica por qué pedir X" con Thot/Maat es diferible y opcional.)
6. **UI = nuevo proyecto de primer nivel "Compras"** (`/compras`), tile propio en `/projects` + nav propio; no una página en Almacén. Backend en `commercial-replenishment` (si Compras crece → `libs/purchasing`).
7. **El importer de reorden reusa `STOCK_BRANCH_MAP`** (mismo `code`→almacén que el stock) → reorden y existencia siempre en el mismo `warehouse_id`, sin re-hardcodear el naming mixto.

### Respuestas de investigación (RA.0 — resuelto 2026-07-08)
- **Q1 — Unidad ✅ PIEZAS.** `kdii.c33/34/35` está en la **misma unidad que `commercial.stock`** (verificado: reorden 2844 vs existencia 3540 mismo orden; unidad `c11='PZA'`). Fuente idéntica (`kdil`) → **sin conversión de factor**. Excepción menor: SKUs de insumo con `c11='PAQ'` (ej. etiquetas) — mismo criterio (reorden en su unidad de stock).
- **Q2 — Mapeo branch→warehouse ⚠️ NO ES LIMPIO.** Los `commercial.warehouses.code` reales son mixtos: `KEPLER-03`(md_03, 3848 SKUs), `KEPLER-02`(md_02, 3270), `MD-10`(md_01/PH, 1918), `MD-CEDIS`(md_00, 158). `MD-30`(3680) y `MD-50`(3205) = branches 04/05 (cuál-es-cuál **TBD** desde el runner). **Decisión:** el importer de reorden **reusa el MISMO map que el stock** (`STOCK_BRANCH_MAP` del runner `C:\KeplerRunner\run-feeds.cmd`) → reorden y existencia caen siempre en el mismo almacén, sin re-hardcodear.
- **Q3 — Cobertura por sucursal ✅ VARÍA 0–18%.** `00/CEDIS=0` · `02=1010 (11%)` · `03=1699 (18%)` · `04=647 (7%)` · `05=600 (6%)` · `01=pendiente (VPN timeout)`. → **El cómputo (RA.3) es obligatorio, no opcional.** Crítico: **el CEDIS —el punto de compra central— tiene CERO config**, así que su reorden es 100% computado.
- **Q4 — lead_time ✅ NO existe en Kepler.** `kdig` (proveedores) solo tiene clave/nombre. → **default configurable** (ej. 7 días), refinable después empíricamente desde fechas de OC (`kdpord`).
- **Q5 — Objetivo del sugerido ✅.** Kepler arranca con **Punto de reorden** (`rPo=1` al init; fallback mínimo). **Decisión:** `target_basis` configurable por requisición; default recomendado **máximo** (restock real), pero se soporta reorden/mínimo para paridad con Kepler.
- **Q6 — UI ✅ NUEVO PROYECTO "Compras".** No vive en `/almacen`. Se agrega un proyecto de primer nivel `/compras` (tile en `/projects` + nav propio + guard), junto a Ventas/Almacén/Finanzas. Ver RA.6.

---

## 6. Fases detalladas

> Ruta crítica: **RA.0 → RA.1 → RA.2 → RA.4 → RA.6**. RA.3/RA.5/RA.7/RA.8 son incrementos de valor sobre esa base.

### RA.0 — Verificación & reconciliación de datos ✅ (mayormente resuelto 2026-07-08)
Cerrado en la investigación (ver §5 respuestas + §2.4 mapeo). Estado:
- [x] Unidad = **piezas** (sin conversión).
- [x] Cobertura 5/6 sucursales (0–18%); **cómputo obligatorio**; CEDIS=0.
- [x] lead_time = **no existe en Kepler** → default configurable.
- [x] Objetivo = `target_basis` configurable (default máximo).
- [x] Mapeo branch→warehouse confirmado para 00/01/02/03; **decisión: reusar `STOCK_BRANCH_MAP`**.
- [ ] **Pendiente menor**: confirmar branch **04/05 → MD-30/MD-50** (cuál-es-cuál) leyendo `STOCK_BRANCH_MAP` del runner `C:\KeplerRunner\run-feeds.cmd`.
- [ ] **Pendiente menor**: cobertura de **branch 01/PH** (dio timeout de VPN; reintentar on-prem).
- [ ] **Diferible a RA.5**: decode exacto de OC a recibir (`kdm2` X-A-35 vs `kdpord`) — no bloquea RA.1–RA.4.
- **Aceptación:** ✅ desbloquea RA.1. Los 2 pendientes menores no bloquean (se resuelven al configurar el runner en RA.2).

### RA.1 — Schema + permisos
**Archivos:** `database/migrations-newdb/2026XXXX_commercial_reorder_policy.js` (+ suppliers.lead_time_days), migración de permisos, seed de roles.
- [ ] Migración `commercial.reorder_policy` (tabla + índices + RLS FORCE + policy `tenant_isolation` + GRANT `app_runtime`), patrón `20260619140000_commercial_warehouse_aisles.js`. Guards `hasTable`/`hasColumn`.
- [ ] `catalog.suppliers.lead_time_days` (guard `hasColumn`, default NULL, `COMMENT`).
- [ ] Permisos nuevos `COMPRAS_VER`, `COMPRAS_GESTIONAR` (patrón `RECONCILIATION_VER/GESTIONAR`): enum backend + `ability.factory` mapping + `AppSubject` (gotcha: sin mapear = 403) + `permissionMeta` frontend.
- [ ] **Backfill de permisos a roles en prod** vía migración (`permissions -> 'KEY' IS NULL`) + seed de roles alineado (gotcha: permiso en seed NO llega a prod) + **re-login** requerido.
- **Aceptación:** `migrate:new` local OK; RLS probado (0 sin tenant / N con tenant / 0 con tenant falso).

### RA.2 — Importer Kepler de umbrales
**Archivo:** `database/importers/kepler/import-reorder-policy.js` (clonar patrón de `import-branch-stock-live.js`).
- [ ] Lee `md.kdii` (`c1=sku, c33=min, c34=reorden, c35=max`) por cada sucursal del map (reusar `STOCK_BRANCH_MAP` o env propio), rol `platform_ro:kepler123`.
- [ ] Filtra `c34 <> 0` (solo configurados) → mapea branch→warehouse (Q1) → join `kdii.c1 == public.products.sku` en tenant `00000000-0000-0000-0000-00000000d01c`.
- [ ] **BULK**: `CREATE TEMP TABLE stg_reorder ... ON COMMIT DROP` + `INSERT ... ON CONFLICT (tenant_id,warehouse_id,product_id) DO UPDATE` con `source='kepler'`, **preservando filas `source='manual'`** (WHERE en el merge).
- [ ] Dry-run por default (ROLLBACK), `--apply` (COMMIT), `--branch`, idempotente.
- [ ] Wire a `run-prod-feeds.js` (STEP en modo `nightly` o `catalog`), destino `DATABASE_URL_NEW` (guard proxy Railway), agendar en runner on-prem.
- **Aceptación:** dry-run muestra match/sin-match; `--apply` a local puebla reorder_policy con N=cobertura de RA.0; re-run idempotente.

### RA.3 — Cómputo de reorden (fallback demanda)
**Archivo:** `database/importers/kepler/import-computed-reorder.js` o método en scanner.
- [ ] Para productos **sin** `source='kepler'` con venta: `reorder_point = ceil(avg_daily_units × lead_time) + safety_stock`; `min = safety_stock`; `max = reorder_point + ciclo` (definir ciclo, ej. 14 días). `avg_daily_units` de `analytics.inventory_health` / `product_sales_stats.units_90d/90`.
- [ ] `safety_stock` por clase ABC (A más colchón) o z-score simple.
- [ ] UPSERT `source='computed'`, **nunca pisa `kepler` ni `manual`**.
- **Aceptación:** cobertura sube de ~18% a ~(productos con venta); valores sanos (no negativos, no absurdos).

### RA.4 — Backend: reporte Existencia Crítica + sugerido
**Archivos:** `libs/commercial/src/lib/commercial-replenishment/` (`*.service.ts`, `*.controller.ts`, `*.module.ts`), wire en `AppModule`.
- [ ] `criticalStock(query)`: `commercial.stock ⋈ reorder_policy ⋈ public.products ⋈ catalog.suppliers ⋈ analytics.purchase_in_transit`, dentro de `TenantKnexService.run()`.
- [ ] **Bucket**: `agotado` (on_hand≤0) · `bajo_minimo` (≤min) · `bajo_reorden` (≤reorden) · `sano` · `sobrestock` (>max).
- [ ] **suggested_qty** = `max(0, objetivo − (on_hand−reserved) − in_transit)`, `objetivo` por `target_basis` (default max).
- [ ] Endpoints `GET critical-stock?warehouse_id&bucket&supplier_id&abc&target_basis`, `GET critical-stock/summary` (KPIs por bucket). Gate `COMPRAS_VER`. Paginado (default 50, máx 500).
- **Aceptación:** contra data real, los buckets cuadran con el reporte de Kepler para una muestra de SKUs (spot-check documentado).

### RA.5 — OC a recibir (en tránsito) [incremento]
**Archivo:** `database/importers/kepler/import-in-transit.js` → `analytics.purchase_in_transit`.
- [ ] Leer compras pendientes de recibir (Q4: `kdm2` doctype X-A-35 o `kdpord` con estado) por sucursal, agregada por SKU×almacén, BULK a `analytics.purchase_in_transit`.
- [ ] Integrar en `criticalStock` (restar del sugerido) y mostrar columna "OC a recibir".
- **Aceptación:** el sugerido baja cuando hay compra en camino; columna visible.

### RA.6 — Frontend: **nuevo proyecto "Compras"** + página Existencia Crítica (Operations)
La UI es un **proyecto de primer nivel** (como Ventas/Almacén/Finanzas), no una página suelta. Wiring del proyecto (patrón confirmado en investigación):
- [ ] **Tile en `/projects`**: agregar `ProjectCard` a `allProjects` en `apps/view/src/app/modules/projects/projects/projects.component.ts` — `{ id:'compras', name:'Compras', description:'Reabastecimiento: existencia crítica, punto de reorden y sugerido de compra; requisiciones a proveedor.', icon:'pi pi-shopping-bag', route:'/compras', status:'Activo', anyOf:[Permission.COMPRAS_VER] }`.
- [ ] **Layout** `apps/view/src/app/modules/dashboard/layout/layout.component.ts`: agregar `'compras'` al union de `currentProject` (línea ~340) + `if (url.startsWith('/compras')) return 'compras'` + `comprasNavItems: NavItem[]` + wire en los getters de nav (switch ~435, sidebar groups ~462, título header ~405, bottom-nav ~563). Espeja el patrón `finanzas`.
- [ ] **Rutas** `apps/view/src/app/app.routes.ts`: bloque `/compras` (shell + hijos) con `canActivate:[permissionGuard(Permission.COMPRAS_VER)]`, lazy-loaded.
- [ ] **Módulo frontend** `apps/view/src/app/modules/compras/` (pages + `compras.service.ts`, patrón `comercial.service.ts`).

**Página "Existencia Crítica"** (`/compras/existencia-critica`, la principal):
- [ ] Standalone (patrón `almacen-cuadre.component.ts` / `comercial-egresos.component.ts`): signals + OnPush, `p-table` densa, filtros `p-select` (almacén, bucket, proveedor, ABC), KPIs por bucket, `p-tag` de severidad.
- [ ] Columnas: SKU · nombre · existencia · mín · reorden · máx · **OC a recibir** · **sugerido** · proveedor · costo · ABC. Números a la derecha; código+nombre siempre.
- [ ] Acción **"Generar requisición"** (multi-select → dialog `target_basis` + editar cantidades → POST requisición) → RA.7.
- [ ] **DESIGN.md Operations**: sin Fraunces, quiet-luxury (marca solo en CTA/activo), 1px, densidad Stripe, sin zebra, PrimeNG `p-table` (no HTML crudo), `:host{display:block}`.
- **Aceptación:** el tile "Compras" aparece según permiso; la página carga con data real; filtros reactivos (signals); design QA 1 línea por pantalla.

> **Nota de alcance del proyecto Compras:** arranca con Existencia Crítica + Requisiciones (bandeja). A futuro absorbe recepción/CxP/matching (hoy diferido, §12). El backend `commercial-replenishment` sirve a este proyecto; si Compras crece, se evalúa un `libs/purchasing` propio.

### RA.7 — HITL: requisiciones (bandeja aprobar/rechazar) [incremento]
**Archivos:** migración requisitions/lines (RA.1 o aquí), `commercial-replenishment.service` (`createRequisition/approve/reject/list`), controller, bandeja frontend.
- [ ] `createRequisition(dto)` → genera folio `RQ-YYYY-NNNNN` (patrón `order_sequences` UPSERT atómico), `estado='pending_approval'`, snapshot de líneas (on_hand, umbrales, suggested/final_qty, unit_cost).
- [ ] `approve(id)` / `reject(id)`: state machine (`pending_approval → approved|cancelled`), audit `approved_by/at`. Gate `COMPRAS_GESTIONAR`.
- [ ] Bandeja frontend (tab o página): lista requisiciones, estados con tag, detalle de líneas, aprobar/rechazar. Patrón `finance.proposed_actions` / `almacen-cuadre` descuadres.
- [ ] Export CSV de la requisición aprobada (para el comprador). Write-back Kepler = diferido.
- **Aceptación:** flujo E2E: crítico → requisición pending → approve → export; smoke.

### RA.8 — Nightly fact + hallazgos + alertas [incremento]
- [ ] Scanner `@Cron` (patrón `reconciliation-scanner`): loop tenants + `tenantCtx.run` → recompute RA.3 + persistir hallazgo `bajo_reorden_critico` (SKUs ABC-A agotados/bajo mínimo) en una bandeja de findings (reusar patrón `discrepancies`/`findings` o tabla propia).
- [ ] Alerta WS opcional (patrón `AlertsService.emitLowStock`) para agotados clase A.
- **Aceptación:** cron corre sin tenant leak; hallazgos idempotentes (`dedup_key`).

### RA.9 — Cierre
- [ ] Smoke E2E dedicado + alta en `database/run-all-tests.js` (regression suite).
- [ ] Actualizar `01_TRACKER_PROGRESO.md`, `03_LOG_REVISIONES.md`, `CHANGELOG.md`, `00_ROADMAP_GENERAL.md`.
- [ ] ADR-030 en `02_DECISIONES_ARQUITECTURA.md`.
- [ ] Runbook: agendar importers en runner on-prem; documentar en `RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md`.
- [ ] Redeploy api + view a Railway.

---

## 7. Permisos & multi-tenant (checklist transversal)
- [ ] `COMPRAS_VER` / `COMPRAS_GESTIONAR` en enum backend + frontend (sincronizados).
- [ ] `ability.factory` mapping + `AppSubject` (sin esto = 403 aunque el rol lo tenga).
- [ ] Seed de roles + **backfill migration** a prod (`KEY IS NULL`) + **re-login**.
- [ ] Todas las tablas nuevas: `tenant_id NOT NULL` + RLS `FORCE` + policy + GRANT `app_runtime`.
- [ ] Handlers usan `TenantKnexService.run()` (SET LOCAL app.tenant_id); crons usan `tenantCtx.run({tenantId})` por tenant.
- [ ] `analytics.purchase_in_transit` sin RLS → filtro `tenant_id` **explícito** en cada query.

## 8. Feed / runbook operacional
- [ ] Importers corren **on-prem** (runner `.249`, LAN Kepler); Railway no alcanza la LAN.
- [ ] Destino `DATABASE_URL_NEW` = proxy `trolley.proxy.rlwy.net`; guard de `run-prod-feeds.js` aborta si no matchea proxy/railway.
- [ ] Patrón **BULK obligatorio** (staging temp + merge server-side); nada per-fila contra Railway.
- [ ] Agendar en Task Scheduler: umbrales Kepler (nightly, cambian poco) + cómputo (nightly) + in-transit (cada 1–4 h si se implementa RA.5).
- [ ] Dependencias del runner: sesión iniciada + Docker (`pgvector-md`) + VPN a sucursales.

## 9. Testing & regression
- [ ] Smoke E2E `database/tests/http-replenishment-test.js`: import dry-run, critical-stock buckets, suggested_qty aritmética, requisición pending→approve, tenant isolation (2º tenant ve 0).
- [ ] Alta en `run-all-tests.js`.
- [ ] Spot-check documentado: buckets de N SKUs vs "Reporte de Existencia Crítica" de Kepler.

## 10. Gotchas & riesgos (bakeados)
- ⚠️ **Unidad pieza vs caja** (Q2): si `kdii.c33/34/35` está en unidad de compra y `commercial.stock` en pieza, el sugerido saldría ×factor equivocado. **Verificar en RA.0.**
- ⚠️ **kdii es por sucursal** (no por almacén interno): un branch con varios almacenes comparte umbral → mapear al almacén principal.
- ⚠️ **Réplicas en kdik/kdil**: las DBs Kepler arrastran filas de otras sucursales → filtrar `c1`/sucursal propia (infló el conteo "bajo reorden" en la investigación).
- ⚠️ **Bug existencia `kdil.c4=0`**: ~2–10% de SKUs con físico previo dan existencia negativa/0; `commercial.stock` ya usa `GREATEST(...,0)`. El sugerido para esos será impreciso hasta que Kepler recomponga el físico.
- ⚠️ **Cobertura parcial** (18% / 0 en CEDIS): el reporte debe manejar `reorder_point=0`/sin política (mostrar "sin política" en vez de "bajo reorden" falso).
- ⚠️ **Permiso no mapeado / no backfilleado** = 403 / invisible en prod. Ver §7.
- ⚠️ **CLS en cron**: sin `tenantCtx.run` el `TenantKnexService` lanza.
- ⚠️ **View `public.products` desactualizada** (creada con `SELECT *` antes de rotación): para leer `rotation_tier`/`sales_units_*` join directo a `catalog.products`.

## 11. Priorización / esfuerzo (estimación gruesa)
| Fase | Valor | Esfuerzo | Notas |
|---|---|---|---|
| RA.0 | 🔒 gate | S | verificación, sin código |
| RA.1 | alto | M | schema + permisos + backfill |
| RA.2 | alto | M | importer (clona existente) |
| RA.4 | alto | M | reporte + sugerido (el corazón) |
| RA.6 | alto | L | página Operations + acción |
| RA.3 | medio | M | cubre el 82% sin config |
| RA.5 | medio | M | requiere decode compras Kepler |
| RA.7 | medio | L | requisiciones + bandeja |
| RA.8 | bajo | M | cron + hallazgos + alertas |

**MVP mínimo demostrable = RA.0 + RA.1 + RA.2 + RA.4 + RA.6** (importar umbrales reales + ver Existencia Crítica + sugerido, sin cómputo ni HITL).

## 12. Diferidos / fuera de scope
- Write-back de orden de compra a Kepler (`comopecompras`).
- Módulo de Compras completo (recepción/CxP/matching factura).
- EOQ / pronóstico de demanda ML / multi-proveedor.
- Explicación LLM del sugerido (Thot/Maat) — opcional, no en el camino del dinero.
- Reorden por lote/caducidad (FEFO ya existe; no se altera).

## 13. Checklist maestro "no se nos pase nada"
- [ ] Datos: decode verificado ✅ · unidad ⛳ · cobertura 6 sucursales ⛳ · branch→warehouse ⛳ · in-transit ⛳ · lead_time ⛳
- [ ] Schema: reorder_policy · requisitions/lines · in_transit · suppliers.lead_time · RLS/GRANT en todas
- [ ] Permisos: enum×2 · ability.factory · seed · backfill prod · re-login
- [ ] Importers: umbrales · cómputo · in-transit · BULK · dry-run · idempotente · guard proxy · agendados
- [ ] Backend: módulo · critical-stock · suggested_qty · requisitions state-machine · TenantKnexService.run · throttle
- [ ] Frontend: página · nav · guard · design QA Operations · bandeja requisiciones
- [ ] Cron: tenantCtx.run · dedup · sin leak
- [ ] Tests: smoke · regression · tenant isolation · spot-check vs Kepler
- [ ] Docs: tracker · log · changelog · roadmap · ADR-030 · runbook
- [ ] Deploy: migraciones prod · redeploy api+view

---

## RA.10 — Reorden inteligente (forecast de demanda) 🔨 DISEÑADO 2026-07-09

Evoluciona el cómputo plano de RA.3 (`avg_daily × lead`) a un **forecast por demanda estacional**. Motor determinista (estadística); el LLM solo **explica**, nunca produce el número (ADR-016).

### Fórmula
Base robusta (estándar pedido por Edgar) + capas multiplicativas sobre la demanda del **mes objetivo**:
```
base_mensual = trimmed_mean( ventas mensuales SIN el mes mínimo ni el máximo )   -- por producto×almacén
demanda_proyectada = base_mensual × estacional × tendencia × evento × clima
Mínimo  = demanda_proyectada × 0.33     (multiplicadores configurables)
Reorden = demanda_proyectada × 0.66
Máximo  = demanda_proyectada × 0.99
Sugerido = max(0, Máximo − existencia − en_tránsito)
```

### Capas
| Capa | Cómo se mide | Fuente |
|---|---|---|
| **Base** | trimmed mean mensual (quita min y máx mes) | `analytics.product_sales_monthly` |
| **Estacional** | venta(mes calendario objetivo, multi-año) ÷ venta(promedio mes); fallback a categoría/marca si el SKU tiene poca historia | histórico multi-año |
| **Tendencia YoY** | venta(últ. 3m) ÷ venta(mismos 3m año anterior), clamp 0.5–2.0 | histórico multi-año |
| **Eventos MX** | uplift por categoría/marca si la ventana de cobertura cae en Reyes/S.Valentín/Día del Niño/Muertos/Navidad/regreso a clases/Semana Santa | tabla `commercial.demand_events` |
| **Clima** *(avanzado)* | temperatura pronosticada × sensibilidad de categoría (bebidas/paletas/chocolate) | API meteo externa (Open-Meteo) por ciudad de almacén |

### ⚠️ Bloqueante de datos
`analytics.product_sales_monthly` en prod hoy = **solo 7 meses (ene–jul 2026)**. Sin backfill NO hay estacionalidad ni YoY. Kepler SÍ tiene la historia (kdm1/kdm2 + particiones kdmx por año) → **RA.10.0 backfill multi-año es prerequisito**.

### Sprints
| Sprint | Qué | Bloqueante | Esf. |
|---|---|---|---|
| **RA.10.0** | Backfill multi-año (24–36 meses) del feed mensual desde Kepler; verificar profundidad real en kdmx | 🔒 | M |
| **RA.10.1** | Base robusta (trimmed mean) → `analytics.demand_forecast`; reemplaza `avg_daily×lead` | — | M |
| **RA.10.2** | Estacionalidad (índice por mes; fallback categoría/marca) | — | M |
| **RA.10.3** | Tendencia YoY | — | S |
| **RA.10.4** | Calendario de eventos MX (`commercial.demand_events` + uplift por categoría) — mayor impacto en dulcería | — | M |
| **RA.10.5** | Clima (Open-Meteo + correlación) — avanzado/opcional, solo categorías sensibles | — | L |
| **RA.10.6** | Ensamblado → umbrales `.33/.66/.99` → `reorder_policy` (`source='forecast'`, respeta `manual`) | — | M |
| **RA.10.7** | Explicación del sugerido (breakdown de factores; LLM narra, no calcula) | — | S |
| **RA.10.8** | UI: breakdown en la fila (base/estacional/tendencia/evento) + Origen "Forecast" | — | M |
| **RA.10.9** | Cron nocturno + cierre/docs | — | S |

**MVP con valor = RA.10.0 → .1 → .2 → .4 → .6.**

### Decisiones abiertas (pendientes de Edgar)
1. ¿Forecast reemplaza a Kepler donde ya hay config, o Kepler manda? (propuesto: forecast default; `manual` humano gana; Kepler solo referencia).
2. Multiplicadores `.33/.66/.99` — ¿ciclo mensual fijo o por proveedor (lead time)?
3. Clima — ¿fase 2 y solo bebidas/paletas/chocolate? (para dulces el calendario pesa más).
4. CEDIS — vende poco (surte). Su demanda real = **salidas/traspasos**, no ventas → ¿modelo aparte?
5. SKUs nuevos sin historia → fallback a promedio de categoría/marca.

### Caveats
- Sin RA.10.0 (backfill) no hay estacionalidad ni YoY — es el cimiento.
- Clima = API externa + correlación real: esfuerzo alto, valor incierto para dulces (no sobrevender).
- Sigue siendo motor determinista; el "deep research" con IA es capa de explicación/priorización, fuera del cálculo del pedido.

---

## RA.11 — Origen de surtido: proveedor vs sucursal (traspaso interno) 🔨 DISEÑADO 2026-07-09

**Motivación (Edgar):** la mayoría de las requisiciones son **a proveedor**, pero parte del reabasto se surte por **traspaso desde otra sucursal** (típicamente CEDIS). En Kepler son **dos cadenas distintas** (compra género `X` vs traspaso género `N`, ver §2.5) → nuestra requisición debe distinguirlas.

**Schema** (nueva migración, guard `hasColumn`):
- `commercial.purchase_requisitions` **y** `..._lines`:
  - `source_type varchar(8) NOT NULL DEFAULT 'supplier' CHECK (source_type IN ('supplier','branch'))`.
  - `source_warehouse_id uuid` (nullable; FK compuesta `(tenant_id, source_warehouse_id)→commercial.warehouses`, `ON DELETE RESTRICT`).
  - CHECK: `source_type='branch' ⇒ source_warehouse_id IS NOT NULL`.

**Backend** (`commercial-replenishment.service.ts`):
- DTOs `RequisitionLineDto`/`CreateRequisitionDto` (`:35-53`): `+ source_type?, source_warehouse_id?`.
- Insert header+líneas (`:228-245`): persistir ambos (misma validación UUID que el resto).
- Selects `getRequisition`/`list` (`:264-289`): incluir campos + join nombre del almacén origen.

**Frontend** (`compras-existencia-critica.component.ts`):
- Dialog (`:126-135`): por línea del draft, `p-select` **Origen** (Proveedor / Sucursal); si "Sucursal" → `p-select` de almacén origen (reusa `warehouseOpts()`). Ajustar `draft` signal (`:215`).
- Detalle (`compras-requisicion-detalle.component.ts:53-73`): columna **Origen**.

**Gotchas / alcance MVP:**
- Costo de línea para traspaso ≠ `cost_base` (es costo de transferencia interna); decidir si `total_cost` distingue. MVP: usar `cost_base` y marcarlo.
- No se valida existencia en el almacén origen (no hay lookup hoy) → MVP **solo clasifica** el origen; **no genera** la salida/entrada de traspaso real (diferido).
- FK `RESTRICT` (no `SET NULL`) para no perder trazabilidad del traspaso.

---

## RA.12 — Selector multi-sucursal (surtir varias a la vez) 🔨 DISEÑADO 2026-07-09

**Motivación (Edgar):** hoy se elige UN almacén; el comprador quiere elegir **varias sucursales** a surtir a la vez.

**Frontend** (`compras-existencia-critica.component.ts`):
- `fWarehouse: string` → `fWarehouses: string[]`; `p-select` (`:56`) → `p-multiSelect` (importar `MultiSelectModule`).
- Reemplazar `@if (fWarehouse)` / `@if (!fWarehouse)` (`:77,:95,:115`) por `.length` / `!.length`.
- **`key()` de selección = `product_id + '|' + warehouse_id`** (hoy solo `product_id`, `:269` → el MISMO SKU en 2 almacenes colisiona). Ajustar `allSelected`/`toggleAll` (`:276-282`).
- **Gotcha signals**: `canRequire` (`:221-224`) DEBE leer `selCount()` **incondicional primero** (short-circuit del `&&` mata la dependencia — ya documentado). `onChange` del multiSelect debe seguir llamando `reload()`.

**Backend:**
- Controller (`:21,:39`): aceptar `warehouse_ids` (CSV).
- Service `criticalStock`/`summary` (`:109,:174`): `andWhere(...)` → `whereIn('rp.warehouse_id', ids)`.
- Service frontend (`compras.service.ts:124-138`): serializar array (CSV).

**Creación (decisión de diseño):** un DTO = un `warehouse_id` + un folio. Con multi-sucursal, `create()` **agrupa el draft por `warehouse_id` y crea N requisiciones (una por almacén)** — más limpio para el comprador y para mapear a las cadenas Kepler (cada sucursal tiene su propio folio `X-A-3x`). *(Alternativa descartada: un DTO multi-almacén = cambio mayor en folio/estado.)*

---

## RA.13 — Compra segura (mínimo de pedido + fill rate) 🔨 DISEÑADO 2026-07-09

### 13a — Mínimo de pedido del proveedor (captura manual)
Kepler **no** guarda mínimo de pedido (§2.5) → se captura en la plataforma.
- **Schema:** `catalog.suppliers.min_order_value numeric(14,4)` (monto) y/o `min_order_units numeric` (piezas). Nueva migración, guard `hasColumn`. (El plan ya lo anticipaba en §3.3 como opcional.)
- **Backend:** exponer `min_order_value` en `filters()`/`critical-stock` (`:140-146,:198-203`); endpoint de edición de proveedor (no existe en este controller).
- **Frontend:** captura con `p-inputNumber` mode currency; al armar el draft, **sumar por proveedor y avisar/bloquear** si el total no alcanza el mínimo.

### 13b — Safe fill rate (pedido vs recibido → decidir pedir de más)
Cuánto pedimos vs cuánto llegó, para compensar faltantes crónicos del proveedor.
- **Registro interno:** `purchase_requisition_lines.received_qty` + `received_at` (ver RA.14) → `fill_rate = received_qty / final_qty`.
- **Fact histórico desde Kepler (RA.5):** qty `X-A-35` (OC) vs `X-A-40` (orden de entrada) por proveedor×sku → `analytics.supplier_fill_rate` (sin RLS → filtro `tenant_id` explícito). **⚠️ Caveat §2.5:** cadena capturada de golpe → usar solo **OCs abiertas** para señal real; documentar que el fill rate "cerrado" es ~100% artificial.
- **Uso:** "safety multiplier" **opt-in** sobre el sugerido cuando el fill rate histórico < 1 (pide de más para cubrir el faltante). MVP: **mostrar** el fill rate; el multiplicador automático es fase 2.

**Gotcha:** `numeric` de Postgres llega como string en JSON → `Number()` antes de dividir (patrón `money()` ya existente).

---

## RA.14 — Flujo post-aprobación (state machine espejo de la cadena Kepler) 🔨 DISEÑADO 2026-07-09

**Motivación (Edgar):** hoy `approve()` deja `approved` y **nada más**. Después de aprobar debe haber un flujo: ordenar → recibir. Espejamos la cadena real de Kepler (§2.5).

| Estado plataforma | Equivale en Kepler | Qué dispara |
|---|---|---|
| `pending_approval` | (requisición interna) | HITL — aprobar/rechazar |
| `approved` | Requisición `X-A-30` lista | el comprador puede ordenar |
| **`ordered`** | Orden de compra `X-A-35` emitida | export a proveedor (PDF/CSV) + queda "en tránsito" |
| **`received`** | Orden de entrada `X-A-40` (mercancía entró) | captura `received_qty` → fill rate; suma a `commercial.stock` (fase 2) |
| `cancelled` | — | — |

**Schema:** ampliar CHECK de `estado` con `'received'` (`'ordered'` ya existe) vía `DROP/ADD CONSTRAINT`; columnas `ordered_at/ordered_by`, `received_at/received_by` en header (hoy solo `approved_by/at`); `received_qty/received_at` en líneas.

**Backend** (`commercial-replenishment.service.ts`):
- `markOrdered` (`approved→ordered`) y `markReceived` (`ordered→received`, captura recibidos) reusando `setEstado` (`:294-306`). **Gotcha:** `setEstado` hoy solo agrega campos extra para `to==='approved'` → generalizar el `patch` para ordered/received o los timestamps no se guardan.
- Endpoints en controller junto a `:73-81`, gate `COMPRAS_GESTIONAR`.

**Frontend** (`compras-requisicion-detalle.component.ts:36-42`): botones por estado (`approved`→"Ordenar", `ordered`→"Recibir"); `RequisitionEstado` (`compras.service.ts:11`) suma `'received'` (labels/severidades ya existen para todos).

**Reconciliación automática con Kepler (lectura, RA.5+):** importer que cruza nuestras requisiciones `ordered` contra OC/órdenes de entrada de Kepler para auto-marcar `received` cuando aparezca el `X-A-40` (matcheo aproximado por sku+almacén+fecha — **no hay folio compartido** porque no hay write-back). Diferido; requiere heurística de matching.

### Decisiones RA.11–RA.14 (✅ cerradas por Edgar 2026-07-09)
1. **Multi-sucursal** → ✅ **N requisiciones separadas** (una por almacén).
2. **Traspaso interno** → ✅ **MVP solo clasifica el origen** (`source_type`/`source_warehouse_id`); NO genera la salida/entrada de traspaso real (diferido).
3. **Fill rate** → ✅ **solo mostrar** primero; multiplicador automático del sugerido = fase 2 (opt-in).
4. **Auto-received desde Kepler** → ✅ **matching heurístico** (sku+almacén+fecha) que cruza requisiciones `ordered` vs órdenes de entrada `X-A-40`; sin folio compartido (no hay write-back). Requiere importer nuevo (depende de RA.5 leyendo `kdm1/kdm2`).
5. **Mínimo de pedido** → ✅ **en CAJAS** (unidad de compra), NO en monto ni piezas. Schema: `catalog.suppliers.min_order_boxes numeric`. Se suma por proveedor: `Σ (final_qty_línea / factor_purchase_producto)` y **solo avisa** si no alcanza (no bloquea). `catalog.products.factor_purchase` = piezas por caja.

### Priorización RA.11–RA.14
| Sprint | Valor | Esfuerzo | Notas |
|---|---|---|---|
| RA.14 | alto | M | flujo ordered/received = cierra el ciclo del comprador |
| RA.11 | alto | M | origen proveedor/sucursal (schema + UI dialog) |
| RA.12 | medio | M | multi-sucursal (key de selección + N requisiciones) |
| RA.13a | medio | S | mínimo de pedido (1 columna + aviso) |
| RA.13b | medio | L | fill rate (requiere RA.5 + recepción) |

---

## Anexo — referencias de código a clonar
- Importer: `database/importers/kepler/import-branch-stock-live.js` (BULK multi-sucursal), orquestador `run-prod-feeds.js`.
- Schema/RLS: `database/migrations-newdb/20260619140000_commercial_warehouse_aisles.js` (tabla nueva + col a existente), `20260707170000_reconciliation_schema.js` (helper `createTenantRls`).
- HITL: `libs/finance/src/lib/maat/maat-actions.service.ts` (propose/approve/reject) + migración `20260707160000_finance_proposed_actions.js`.
- Bandeja/scanner: `libs/reconciliation/*` + `apps/view/.../almacen/pages/almacen-cuadre.component.ts`.
- Reporte análogo: `commercial-analytics.service.ts` `lowStock()`/`inventoryHealth()` + `import-inventory-health.js`.
- Existencia/sugerido de referencia (Kepler): `invconpanecrrep.kpl` (lógica de buckets + `cantidad = objetivo − existencia`).
