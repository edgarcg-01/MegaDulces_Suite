# Plan de implementación — Fuente única de verdad

> Cómo pasar de "N feeds copian el mismo dato a N tablas y se desincronizan" a
> "una fuente → un escritor atómico → derivados que leen, no copian".
> **Piloto: PRODUCTO** (la implementación de referencia). Los demás (precio, costo,
> marca, existencia, cliente) calcan la misma plantilla.
> Basado en `docs/MODELO_CANONICO_DATOS.md` (verificado vs prod 2026-08-15, PG 18.6).

---

## 0. Decisión de arquitectura (aterrizada en el schema real)

La tentación era "convierte `catalog.products` en una vista sobre `kepler_ods.kdii`". **Está mal** por dos razones verificadas:

1. `catalog.products` tiene **RLS + tenant_id + columnas curadas de app** (image_url, embedding, rotation_tier, in_planogram, markup_pct…). `kepler_ods.kdii` es crudo, single-tenant, RLS off. Una vista sobre él pierde el aislamiento multi-tenant y las columnas de app.
2. `kepler_ods` es **UPSERT-only → no propaga bajas** (§7-R1). Una vista dejaría los SKUs descontinuados vivos para siempre.

**Por lo tanto, el patrón correcto en este stack:**

```
FUENTE (fresca, en prod)          ESCRITOR ÚNICO ATÓMICO            MAESTRA (tabla, RLS)         DERIVADOS (vistas security_invoker)
kepler_ods.kdii  ─┐                                                                              ┌─ inventory.products_active
kepler_ods.kdil   ├──►  sync-product-master.js  ──(1 snapshot, 1 trx)──►  catalog.products  ──┼─ catalog.products_active (ya es vista)
wincaja.articulos ─┘     (upsert + soft-delete reconcile)                  (tenant_id + RLS)     └─ (AI-corpus, imágenes, buscador leen de aquí)
```

- **La maestra sigue siendo tabla** (RLS, soft-delete, cols de app).
- **Un solo feed** la escribe, leyendo **un snapshot** en **una transacción**, con reconciliación que **sí expresa bajas** (soft-delete de lo ausente).
- **Los derivados son vistas `security_invoker`** sobre la maestra → heredan la RLS del que consulta (PG 15+), cero copia, imposible desincronizar.

---

## 1. El feed canónico — `sync-product-master.js`

Reemplaza a **`repoint-catalog-presence` + `repoint-catalog-names` + `import-catalog-bulk` + `mega_dulces_sync`(productos)**. Ubicación: `database/importers/kepler/sync-product-master.js`.

### 1.1 Snapshot de la fuente (un solo read, dedup determinista)

`kepler_ods.kdii` tiene una fila por `(sucursal, sku)` (catálogo compartido entre sucursales). Se colapsa a **una fila por SKU** con precedencia **documentada y en módulo compartido** (`database/importers/lib/kepler-dedup.js`):

```sql
-- Identidad canónica del producto (una fila por sku). Precedencia: CEDIS primero
-- (autoridad de catálogo), luego la más fresca. La MISMA regla la reusan todos los
-- feeds que derivan de kdii (precio, costo) → cero "dos reglas de dedup".
WITH src AS (
  SELECT DISTINCT ON (c1)
         c1  AS sku,
         btrim(c2)  AS nombre,
         nullif(btrim(c7),'') AS barcode,
         c3  AS linea_code,          -- → brand
         c4  AS department_code,     -- → categoría
         c5  AS product_line_code,
         c90 AS precio_pieza, c91 AS precio_pack, c92 AS precio_caja,
         c16 AS costo, c84 AS factor_caja,
         sucursal, _loaded_at
    FROM kepler_ods.kdii
   WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> ''  -- sin SKU/nombre vacío (ghost guard, §7-R8)
   ORDER BY c1, (sucursal = '00') DESC, _loaded_at DESC   -- CEDIS > resto, luego fresco
)
SELECT * FROM src;
```
+ **UNIÓN con `wincaja.articulos`** para SKUs POS-only (30/32/50) que no están en Kepler — con `source='wincaja'` y precedencia Kepler > Wincaja (§7-P1: multi-fuente disjunta legítima).

### 1.2 Guardas ANTES de escribir (evitan corromper prod con un read malo)

```js
// (a) Frescura per-sucursal (§7-R2/R3): si el ODS está stale o una sucursal congelada, ABORTAR.
const fresh = await q(`SELECT max(last_push_at) FROM kepler_ods._sync_status WHERE table_name='kdii'`);
if (ageMinutes(fresh) > 30) abort('kdii stale — no reconciliar sobre dato viejo');

// (b) Guard anti-vaciado: si el snapshot trae <90% de las filas de la última corrida, ABORTAR.
//     Protege contra el modo "una sucursal inalcanzable → snapshot parcial → soft-delete masivo".
if (snapshot.length < lastRunCount * 0.9) abort(`snapshot sospechosamente chico: ${snapshot.length} vs ${lastRunCount}`);
```

### 1.3 La transacción atómica (upsert + reconcile + SIN gates)

```js
await db.transaction(async (trx) => {
  // 1) UPSERT en lote (chunks 500, como el fix de kardex). UPDATE SIEMPRE QUE DIFIERA
  //    — SIN el gate "solo si el nombre cambió" que dejaba 1685 barcodes rotos.
  //    Escribe: sku, nombre, barcode, brand_id (via mapa code→brand publicado por el feed
  //    de marca que corre ANTES), reactiva (activo=true, deleted_at=null) si estaba borrado.
  for (const batch of chunk(snapshot, 500)) {
    await trx.raw(`
      INSERT INTO catalog.products (tenant_id, sku, nombre, barcode, brand_id, activo, updated_at, ...)
      VALUES ${values}
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        nombre   = EXCLUDED.nombre,
        barcode  = EXCLUDED.barcode,           -- ← se corrige SIEMPRE (fix de los 1685)
        brand_id = COALESCE(EXCLUDED.brand_id, catalog.products.brand_id),
        activo   = true, deleted_at = NULL,     -- ← reactiva borrados-vivos
        updated_at = now()
      WHERE  catalog.products.nombre  IS DISTINCT FROM EXCLUDED.nombre
          OR catalog.products.barcode IS DISTINCT FROM EXCLUDED.barcode
          OR catalog.products.brand_id IS DISTINCT FROM EXCLUDED.brand_id
          OR catalog.products.activo = false`);   -- WHERE = churn-free (no bumpea updated_at si nada cambió)
  }

  // 2) RECONCILE de BAJAS (§7-R1): soft-delete de SKUs kepler que YA NO están en el snapshot.
  //    Esto es lo que una vista sobre kepler_ods NO puede hacer. Solo toca source='kepler'
  //    (no borra los POS-only de Wincaja ni los curados a mano).
  await trx.raw(`
    UPDATE catalog.products p SET activo=false, deleted_at=now(), updated_at=now()
    WHERE p.tenant_id=$1 AND p.activo=true AND p.source='kepler'
      AND NOT EXISTS (SELECT 1 FROM snapshot_temp s WHERE s.sku=p.sku)`, [TENANT]);
});
```

Notas:
- **Piso anti-promo (§7-R7):** al derivar precio (feed hermano), filtrar `c90 > 0.05` para no meter promos $0.01 a pedidos.
- **`source` column:** agregar `catalog.products.source` (`kepler`/`wincaja`/`manual`) si no existe — necesaria para que el reconcile solo borre lo suyo.
- **Heartbeat:** `hb.begin/end('sync_product_master', …)` → dead-man switch en `/admin/db-health`.
- **Cadencia:** cada 10 min (same-DB, barato). Reemplaza el nightly.

---

## 2. Los derivados como vistas `security_invoker` (PG 18)

Cero copia. La RLS de `catalog.products` se evalúa como el rol que consulta.

```sql
-- inventory.products_active: hoy es una TABLA congelada (2 meses). Pasa a VISTA.
DROP TABLE IF EXISTS inventory.products_active;   -- (tras verificar consumidores, §5)
CREATE VIEW inventory.products_active WITH (security_invoker = true) AS
  SELECT p.tenant_id, p.sku, p.barcode AS codigo_barras, p.nombre, p.description AS descripcion,
         p.cost_base, p.cost_with_tax, p.image_url, p.embedding
    FROM catalog.products p
   WHERE p.activo;   -- identidad + imágenes + corpus AI SIEMPRE frescos, imposible desincronizar
```

Regla: **si el derivado no tiene columnas propias que la maestra no tenga → es vista.** Si tiene columnas curadas (ej. `product_label_prices` con `barcode_format`, `content`, `sold_by_kg`) → se escribe en la **misma transacción** del feed atómico (fan-out), no por un feed aparte.

---

## 3. Kill-list (retirar del orquestador, mover a `_legacy/`)

Orden importa — **no borrar hasta que el reemplazo esté verde**:

| Retirar | Reemplazado por | Cuándo |
|---|---|---|
| `repoint-catalog-presence.js` | `sync-product-master.js` | tras shadow-diff OK |
| `repoint-catalog-names.js` | `sync-product-master.js` | idem |
| `import-catalog-bulk.js` (identidad) | `sync-product-master.js` | idem |
| `mega_dulces_sync.js` (productos) | `sync-product-master.js` | ⚠️ **NO** antes de dar reemplazo a **categoría** (§7-R6) |
| `import-kepler-warehouse-stock/stock/prices`, `railway-product-prices-by-sku` | feeds atómicos de sus entidades | fase respectiva |

**Guardrail (§4e):** una vez cortados, `REVOKE UPDATE (barcode, nombre) ON catalog.products FROM app_runtime` salvo el rol del feed → nadie reintroduce identidad stale por accidente. (Evaluar contra el boot de Railway, §7-P5.)

---

## 4. Migraciones necesarias

1. `add_products_source_column.js` — `catalog.products.source text DEFAULT 'kepler'` (idempotente, `hasColumn`). Backfill: `wincaja`-only SKUs → 'wincaja'; los editados a mano → 'manual'.
2. `products_active_to_view.js` — dropea la tabla `inventory.products_active` y crea la vista `security_invoker` (con `down()` real que recrea la tabla vacía + guard).
3. Índice: `catalog.products (tenant_id, sku)` único ya debe existir (es el conflict target) — verificar.

> Regla del proyecto: **DDL en migraciones, el backfill/reconcile va en el feed** (no en la migración, §audit).

---

## 5. Rollout blue/green + verificación

**No cortar en seco.** Correr el feed nuevo en **sombra** y comparar antes de cortar el viejo:

1. **Shadow run:** correr `sync-product-master.js --dry-run --diff` → reporta cuántas filas cambiaría (INSERT/UPDATE/soft-delete) sin escribir. Revisar que los números sean sanos (ej. ~635 inserts, ~1685 barcode-updates, soft-deletes razonables).
2. **Pre-flight (§7):** correr las 7 verificaciones — sobre todo:
   - `SELECT table_name, sucursal, last_push_at FROM kepler_ods._sync_status` (lag real per-sucursal).
   - los 635 SKUs faltantes NO son ghost: `SELECT count(*) FROM snapshot s WHERE s.sku NOT IN (SELECT sku FROM catalog.products) AND s.sku IN (SELECT sku FROM inventory.products_active)`.
   - consumidores de `inventory.products_active` (grep) antes de convertirla en vista.
3. **Apply + medir desync (los checks que van a `/admin/db-health`):**
   ```sql
   -- deben tender a 0 tras la corrida:
   barcode_diff : count(*) FROM catalog.products p JOIN kepler_ods_dedup k USING(sku) WHERE p.barcode IS DISTINCT FROM k.barcode AND p.activo
   missing_sku  : count(*) FROM kepler_ods_dedup k WHERE NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.sku=k.sku)
   name_diff    : count(*) ... p.nombre <> k.nombre
   ```
4. **Cortar el viejo:** retirar los feeds de la kill-list del orquestador. Observar 24-48h.

**Rollback:** los feeds viejos siguen en `_legacy/` (no borrados). Rollback = re-agendar el viejo + `pm2 restart` / re-enable task. La maestra no se destruyó; solo cambió quién la escribe.

---

## 6. La plantilla generalizada (los demás entidades calcan esto)

Cada entidad = **1 feed atómico** que lee `kepler_ods.*` (∪ wincaja) con **la misma regla de dedup del módulo compartido** y escribe **1 maestra** + fan-out a sus derivados en 1 trx:

| Entidad | Feed atómico | Fuente (kepler_ods) | Maestra | Derivados → vista |
|---|---|---|---|---|
| **PRODUCTO** | `sync-product-master` | kdii (c1/c2/c7) ∪ wincaja.articulos | `catalog.products` | inventory.products_active, products_top_sellers |
| **PRECIO** | `sync-price-master` | kdii (c90/91/92) + kdpv_prod_util (tiers) | `commercial.product_prices` | product_label_prices, product_box_price |
| **COSTO** | (rama de product-master) | kdik.c16 (net) | `catalog.products.cost_base/with_tax` | sales_daily.cost es COGS ≠ costo (no tocar) |
| **MARCA** | `sync-brand-master` (corre ANTES de producto) | kdig (c1) | `catalog.brands` | publica mapa `linea_code→brand_id` |
| **EXISTENCIA** | `sync-stock-master` | kdil (c4+c8−c9) ∪ wincaja.v_stock | `commercial.stock` | inventory.warehouse_stock, inventory_health.on_hand |
| **CLIENTE** | `sync-customer-master` | kdud (falta replicar a ODS, §7-P3) ∪ wincaja.clientes | `commercial.customers` (+erp_code crosswalk) | erp_customers |
| **VENTAS** | (ya existe) import-sales-fact | mart.ventas / kdm1+kdm2 | `analytics.sales_daily` | product_sales_* → rollup **anclado a REVENUE, no units** (§7-R4) |

**Orden de dependencia en la corrida:** `sync-brand-master` → `sync-product-master` → `sync-price-master`/`sync-cost` (mismo ciclo, publican mapas que el siguiente consume → cero ventana entre "crear marca" y "asignar producto").

---

## 7. Secuencia recomendada (qué construir primero)

1. **Semana 1 — piloto PRODUCTO.** Construir `sync-product-master.js` + `kepler-dedup.js` + migración `source`. Shadow-diff. Aplicar. Convertir `inventory.products_active` en vista. Retirar los 3 feeds viejos de identidad. → **Cierra 1685 barcodes + 635 SKUs + la race @02:00.** Prueba el patrón end-to-end.
2. **Semana 2 — PRECIO + MARCA** (calcan el piloto). → Cierra el split-brain de precio + los 206 "SIN LINEA". Retirar `import-prices-bulk`, `import-catalog-bulk`, `mega_dulces_sync` (dar reemplazo a categoría primero).
3. **Semana 3 — COSTO + EXISTENCIA.** → Cierra 939 SKUs de costo + `warehouse_stock` congelada.
4. **Semana 4 — CLIENTE** (requiere replicar `kdud` a `kepler_ods` + crosswalk `erp_code`).
5. **Continuo — Gobierno:** los checks de desync (§5.3) en `/admin/db-health` por entidad + todos los feeds en el dead-man switch. Esto **detecta** cualquier reincidencia antes de que llegue a una pantalla.

---

## 8. Pre-flight obligatorio (antes de tocar el primer feed)

Correr y confirmar (de §7 del modelo canónico):
1. Lag real per-tabla/per-sucursal en `kepler_ods._sync_status`.
2. `kepler_ods` NO expresa bajas → confirmado, por eso el reconcile va en el feed (§1.3-2).
3. Los 635 "faltantes" no son ghost (cruzar contra `products_activos`).
4. `median_ratio kdik vs cost_base` en las 6 sucursales (no solo 1-2).
5. Consumidores de `inventory.products_active` y `warehouse_stock` (grep) antes de convertir a vista.
6. Columnas que SOLO `mega_dulces_sync` escribe (categoría confirmado — dar reemplazo antes de retirarlo).
7. `security_invoker` respeta RLS como se espera: probar con un 2º tenant que la vista NO le muestre filas del 1º.

> **Principio rector de todo el plan:** una entidad tiene **un escritor por (entidad, partición)**, lee la fuente **más fresca ya en prod** (`kepler_ods.*`), escribe **una maestra** con reconcile de bajas, y **todo lo demás es una vista**. Si un atributo puede aparecer distinto en dos tablas al mismo tiempo, hay un desync latente — el gobierno del §5.3 lo caza.
