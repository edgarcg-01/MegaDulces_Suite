# Fase Thot — Motor de Inteligencia Comercial (multi-señal)

> **Thot** — dios egipcio de la sabiduría, la medida y la escritura; el escriba que registra y decide.
> Evoluciona el motor v1 (Fase M / ADR-016) de una lista `margen × rotación` plana a un motor
> multi-señal que entiende **qué se vende, dónde, con qué, y qué empujar**.
> Decisión: [ADR-018](../02_DECISIONES_ARQUITECTURA.md). Invariantes: [ADR-016](../02_DECISIONES_ARQUITECTURA.md).

**Estado:** ⬜ Diseño aprobado (2026-06-11). Build por rebanadas.

---

## 0. Invariantes (heredados de ADR-016, no negociables)

1. **El motor decide, el agente comunica.** El *qué* ofrecer lo decide un motor **determinista y explicable** (SQL + scoring). El agente LLM solo decide *cómo decirlo*.
2. **El LLM nunca toca el dinero.** Precio, stock y commit viven en `commercial-orders`. El agente *propone*; el motor *valida y ejecuta*.
3. **Honestidad de datos.** Thot no inventa señales sin datos (estacionalidad, personalización per-tienda quedan dormidas hasta tener historia). Se reporta lo que está apagado.
4. **Determinista primero, ML después, LLM al final.** Heurística/estadística da el 80% a costo ~0; el ML entra cuando haya datos; el LLM es interfaz, no decisor.

---

## 1. Feasibility de datos (sondeado 2026-06-11 sobre ERP `Mega_Dulces`)

| Señal | Fuente | Método | Veredicto |
|---|---|---|---|
| **Rotación** | `productos_activos` (Σ `alm{10,30,32,50}_actual_30_r`) | unidades 30d → tier por percentil | ✅ vivo (ya en `catalog.products.rotation_tier`) |
| **Margen real** | `catalogo_etiquetas.precio_*` + `costo_civa` | `(precio − costo_civa/(1+iva)) / precio` | ✅ vivo |
| **Ventas/volumen** | `ventas` (2.18M filas, Ene–Abr reales) | agregados por producto/zona | ✅ |
| **Zona-fit** | `ventas.zona` (La Piedad, Morelia, Zamora, Yurécuaro, Desc.) | índice de demanda producto×zona normalizado | ✅ |
| **Afinidad (market-basket)** | `ventas` agrupado por `(fecha, folio, tercero_id)` — **408,974 folios, 5.3 prod/folio, 70% multi** | reglas de asociación: `support`, `confidence`, `lift` | ✅✅ killer |
| **Momentum (tendencia corto)** | `ventas` últimas N semanas vs previas | crecimiento % por producto/zona | 🟡 ~4 meses (parcial) |
| **Whitespace** | `ventas` (top zona/ruta) − lo que la tienda lleva (`commercial.orders`/`vendor_sales`) | gap = top de su zona que NO compra | 🟡 crece con plataforma |
| **Estacionalidad** | `ventas` por mes | índice mensual por categoría/producto | ❌ **dormida** (necesita 1 año; hoy solo Ene–Abr) |
| **Propensión per-tienda** | historial per-tienda (`commercial.orders` + `vendor_sales` + `daily_captures.store_id`) | cadencia/RFM/uplift | ❌ **dormida** (beta sin volumen) |
| Compras de competidores (otras distribuidoras) | — | — | ❌ fuera de alcance (no existe la data) |

> **Nota clave:** `ventas` es **sell-in a rutas/CEDIS**, no sell-out por tienda. La afinidad y la demanda por zona son válidas a nivel catálogo/zona. La personalización per-tienda se construye con lo que **la plataforma** capture de aquí en adelante.

---

## 2. Arquitectura

### 2.1 Feature store `intelligence.*` (precomputado por cron, leído en runtime)

| Tabla | Contenido | Refresh |
|---|---|---|
| `intelligence.product_affinity` | `(product_a, product_b, support, confidence, lift)` — reglas de canasta del ERP (folios) | nightly |
| `intelligence.zone_demand` | `(zona, product_id, units, revenue, demand_index)` — demanda normalizada por zona | nightly |
| `intelligence.product_trend` | `(product_id, zona, units_recent, units_prev, momentum)` | semanal |
| `intelligence.push_directives` | `(directive_type, target_kind, target_id, boost, reason, sponsor, valid_from/to)` — **empuje dirigido del negocio** (§2.6) | manual + auto |
| `intelligence.signal_weights` | `(context, signal, weight)` — pesos del score, ajustados por feedback | continuo (loop) |
| `commercial.customer_360` *(existe, Fase M)* | RFM, cadencia, lifecycle per-tienda | nightly (enciende con datos) |
| `commercial.commerce_signals` *(existe, Fase M)* | oferta→resultado (append-only) | runtime |

Tablas nuevas siguen el estándar: `tenant_id` + RLS forzado + grants `app_runtime`. Los crons cross-tenant usan `KNEX_NEW_DB_ADMIN` ([[feedback_tenant_knex_rls]]).

### 2.2 El score (determinista, explicable)

Para un producto `p` en contexto `ctx` (cliente, zona, carrito actual). El score tiene **dos capas**: la **demanda** (qué se vende / deja) y la **estrategia** (qué quiere empujar el negocio). La estrategia **amplifica** la demanda — no empuja basura, pero sube lo que conviene:

```
demanda(p)  = Σ_i  weight[ctx][i] · signal_i(p, ctx)        # qué se vende / deja
score(p)    = demanda(p) · (1 + boost_estrategia(p))         # × lo que el negocio quiere empujar
```

con cada `signal_i ∈ [0,1]`:

| Señal | Definición |
|---|---|
| `rotacion` | tier/percentil de unidades 30d |
| `margen` | margen real normalizado |
| `afinidad` | max lift de `p` vs los productos ya en el carrito / habituales de la tienda |
| `zona_fit` | demand_index de `p` en la zona de la tienda |
| `momentum` | crecimiento reciente de `p` (clamp) |
| `whitespace` | `p` es top de su zona y la tienda NO lo lleva |
| **`estrategia`** | `boost_estrategia(p)` = Σ de las directrices de empuje activas que aplican a `p` (§2.6) |

Los `weight` arrancan fijos (config) y los **reajusta el feedback loop** (§2.4). Cada recomendación expone su **razón** (la señal/directriz dominante) → UI: "🔥 alta rotación", "💰 margen", "🧺 va con lo que llevas", "📍 se vende en tu zona", "⭐ marca del mes", "🆕 nuevo", "📦 liquidar".

### 2.3 Next-Best-Actions por contexto

| Contexto | Qué prioriza |
|---|---|
| **Abrir pedido** (take-order vacío) | top zona + margen + rotación + whitespace |
| **Completar canasta** (hay carrito) | **afinidad** con lo que ya está + margen |
| **Reactivación** | lo que su zona pide y la tienda dejó de llevar |
| **Reorden** *(futuro)* | cadencia per-tienda (Customer 360) cuando encienda |

### 2.4 Feedback loop = entrenamiento

`commerce_signals` registra cada oferta y si convirtió (pedido en ventana). Un proceso periódico ajusta `intelligence.signal_weights` por contexto (bandit / regresión simple sobre conversión). Así Thot **aprende qué señal vende** en cada zona/segmento — sin fine-tunear ningún LLM. Requiere **frequency capping** (anti-spam) desde el MVP.

### 2.5 Camino del agente (escalón 3)

Agente Claude con *tool-belt* sobre el motor: `getNBA`, `getAffinity`, `getCatalog`, `draftOrder` (que llama al camino determinista). Explica recomendaciones, arma pedido conversando (vendedor copiloto / WhatsApp). RAG sobre catálogo (pgvector ya existe, Fase K). **Nunca** computa precio ni compromete stock.

### 2.6 Empuje dirigido — el objetivo del negocio (alma del trade marketing)

Thot no es solo un optimizador de datos: el negocio decide **qué empujar** y Thot lo amplifica. Esto es lo que lo hace un motor de *trade marketing* (a menudo el push lo financia el proveedor) y no un mero ranker de demanda. Las **directrices** viven en `intelligence.push_directives` y producen `boost_estrategia(p)`:

| Tipo | Cómo se setea | Fuente | Razón UI |
|---|---|---|---|
| `focus_brand` / `manual_product` | **manual** (admin/supervisor: "este mes empujá La Rosa") | config | ⭐ Marca del mes |
| `new_launch` | **auto** | `catalog.products.created_at` reciente (boost decae) | 🆕 Nuevo |
| `overstock_clear` | **auto** | `commercial.stock` alto + rotación baja/declinante | 📦 Liquidar |
| `promo` | **auto** | `commercial.promotions` activa | 🏷️ Promo |

`push_directives`: `directive_type · target_kind(brand/category/product) · target_id · boost · reason · sponsor(quién financia) · valid_from/to · active`. Tenant + RLS + audit. El boost se **suma** entre directrices que apliquen a un producto y se **clampa** (un producto estratégico sube, pero la demanda sigue mandando — no se empuja lo que no se vende ni lo agotado).

**Invariante ADR-016:** la estrategia la define el **negocio** (config determinista), no el LLM. El agente la **comunica** ("te recomiendo X porque es la marca del mes + se vende en tu zona"). Surface admin para las directrices manuales (CRUD gateado por permiso).

---

## 3. Roadmap por rebanadas

| ID | Rebanada | Entrega | Estado |
|---|---|---|---|
| **T.1** | **Afinidad + Zona-fit** | `intelligence.product_affinity` (48.6k) + `zone_demand` (17.6k) + `ThotService.suggest` (score demanda·(1+afinidad+zona)) + endpoint `/commercial/intelligence/thot/suggest/:id?cart=` + take-order "completá la canasta". Build verde, verificado en DB. | 🧪 código listo · pend. reinicio API |
| **T.2** | **Empuje dirigido (estrategia)** | `intelligence.push_directives` (mig `20260611120000`) + `PushDirectivesService` CRUD + `boost_estrategia` ADITIVO en el score (`+0.45·boost`, garantiza visibilidad de lo dirigido) + reason='estrategia' + surface admin `/comercial/empuje` (marca foco). **Manual hecho**; auto (promo/lanzamiento/overstock) → T.2.1. Verificado: BARCEL "Marca del mes" encabeza take-order. | 🧪 código listo · pend. reinicio API |
| T.3 | Momentum + Whitespace | tendencia corto plazo + "top de tu zona que no llevas" | ⬜ |
| T.4 | Feedback weights | loop oferta→resultado reajusta `signal_weights` + frequency capping | ⬜ |
| T.5 | ML informa | forecast de demanda + association mining a escala (cuando haya datos) | ⬜ |
| T.6 | Agente Thot | LLM con tools sobre el motor (copiloto vendedor / WhatsApp Fase F) | ⬜ |
| T.x | *Enciende solo* | estacionalidad (1 año) · propensión/cadencia per-tienda (volumen plataforma) | ⏳ datos |

Cada rebanada: ADR si hay decisión nueva, smoke en `run-all-tests.js`, doc de cierre.

---

## 4. Lo que NO hace (explícito)

- **No** modela estacionalidad ni "época del año" todavía (solo ~4 meses de historia).
- **No** personaliza por tienda hasta acumular pedidos en la plataforma (el ERP es ruta-level).
- **No** usa compras de competidores (otras distribuidoras) — no existe esa data; lo más cercano es afinidad de pares.
- **No** pone al LLM a decidir precio/stock/commit.

---

## 5. Relación con lo existente

- **Sustrato (Fase M):** `customer_360`, `commerce_signals`, `decision-engine`, `recommendations` — Thot los absorbe/eleva.
- **Take-order:** hoy usa `score = margen × rotación` client-side ([[project_take_order_margin_rotation]]); T.1 lo reemplaza por el score multi-señal (idealmente server-side, reusable por portal/televenta/agente).
- **Catálogo:** `catalog.products` (cost/rotation ya sincronizados del ERP); precios vía P1 default.
