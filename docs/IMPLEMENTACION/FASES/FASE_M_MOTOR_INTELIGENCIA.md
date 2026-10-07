# Fase M — Motor de Inteligencia Comercial + Agente AI

**ADR base:** [ADR-016](../02_DECISIONES_ARQUITECTURA.md#adr-016--motor-de-inteligencia-comercial-el-motor-decide-el-agente-comunica-el-llm-fuera-del-camino-del-dinero)

**Duración estimada:** rebanada vertical V1 en 2-3 sprints; ensanche posterior por capas.

**Objetivo:** un **motor único** que entregue *la oferta correcta, al cliente correcto, en el momento correcto, por el canal correcto, con mínimo esfuerzo del vendedor* — en vez de 18 features sueltas. Es la respuesta a la comparativa vs yom.ai (2026-06-10).

> **Decisión 2026-06-10 (Edgar):** (1) arquitectura = **el motor decide, el agente comunica, el LLM fuera del camino del dinero** (ADR-016); (2) construir por **rebanada vertical**, no fundación horizontal; (3) entregable de planeación = este doc + ADR-016.

---

## La idea unificadora

Los ~18 puntos de la comparativa colapsan en una frase:

> **La oferta correcta, al cliente correcto, en el momento correcto, por el canal correcto — con mínimo esfuerzo del vendedor.**

Eso no es un feature: es **sistema de decisión + agente + canales + loop de feedback**. La regla de oro del usuario ("quitarle tiempo de toma-de-pedido al vendedor para liberar prospección de nuevos clientes") es la brújula del orden de construcción.

---

## Pre-requisitos

- ✅ `commercial.orders` / `order_lines` con histórico de pedidos (fuente de cadencia/RFM).
- ✅ `RecommendationsService` (4 categorías SQL) — semilla del Motor de Decisión.
- ✅ AI Order Builder con Claude Haiku 4.5 (`portal-ai-order`) — semilla del Agente.
- ✅ pgvector + 1278 SKUs embedded (Fase K) — RAG del catálogo para el agente.
- ✅ `AlertsScannerService` (cron @5min) — patrón de orquestación reutilizable.
- ✅ `analytics.*` MVs + refresh cron — sustrato del Customer 360.
- ✅ `commercial.promotions` (6 tipos, `applies_to: specific_customers`) — ejecución de ofertas dirigidas.
- ✅ `commercial-push` (Web Push VAPID) — **cableado pero sin usar**; se termina en M.3.
- ✅ TenantContext/RLS — seguridad multi-tenant del motor.
- ⬜ (para ensanche) lat/lng en `commercial.customers` — hoy solo las stores de TM tienen geo.
- ⬜ (para ensanche/WhatsApp) BSP + BullMQ — Fase F formal.

---

## Decisiones técnicas (ADRs)

- **ADR-016** — Motor decide / agente comunica / LLM fuera del dinero; rebanada vertical; heurístico antes que ML.
- **ADR-011 / ADR-012** — embeddings Voyage `voyage-3` + pgvector (reutilizados por el agente, ya en prod beta).
- **ADR-007** (pendiente formalizar) — LLM del agente = Claude Haiku 4.5; escala a Sonnet solo en copiloto de vendedor si hace falta.

---

## Arquitectura — 5 capas

```
┌─────────────────────────────────────────────────────────────┐
│  CAPA 3 — CANALES     WhatsApp · Push · Portal · Vendor · Tel │  entrega
├─────────────────────────────────────────────────────────────┤
│  CAPA 2 — AGENTE AI   Claude Haiku + RAG(pgvector) + tools    │  conversa / explica
├─────────────────────────────────────────────────────────────┤
│  CAPA 1 — MOTOR DE    NBA · canasta sugerida · promo óptima · │  DECIDE (determinista)
│           DECISIÓN     ruta óptima + prospectos · canal+timing │
├─────────────────────────────────────────────────────────────┤
│  CAPA 0 — CUSTOMER 360 RFM · cadencia · stage · afinidad ·    │  "telemetría" del cliente
│           (feature store) churn · geo · next-order-date        │
├─────────────────────────────────────────────────────────────┤
│  CAPA 4 — FEEDBACK    cada oferta → resultado → reajusta peso │  APRENDE
└─────────────────────────────────────────────────────────────┘
        ↑ todo dentro de TenantContext/RLS (TenantKnexService.run)
```

### Invariantes (ADR-016)
1. **El motor decide, el agente comunica.** El agente llama al motor como tools; nunca inventa data.
2. **El LLM nunca toca el dinero.** Precio/stock/commit = camino determinista de `commercial-orders`. El agente propone borrador; el motor valida y ejecuta.

### Tool-belt del agente (Capa 2)
`get_customer_360` · `get_next_best_action` · `get_suggested_basket` · `search_catalog`(pgvector) · `lookup_price` · `get_active_promos` · `create_draft_order` · `schedule_followup` — todos scoped por tenant vía `TenantKnexService.run()`.

---

## Rebanada vertical V1 — "Reorden inteligente"

Un caso end-to-end fino que toca las 5 capas. Valida la arquitectura completa con valor real antes de ensanchar.

```
Customer360(señal: cadencia + next_order_date)
  → Motor(NBA = "due_for_reorder" cuando hoy ≥ next_order_date)
  → Agente(arma canasta = último pedido + base, redacta mensaje)
  → Canal(push web + tarjeta "tu pedido habitual" en portal home + NBA en vendor home)
  → Feedback(¿abrió? ¿pidió? ¿ignoró? → log)
```

Ataca directo la regla de oro: el cliente/vendedor recibe el pedido recurrente **pre-armado**; deja de capturarse a mano.

---

## Sprints

### Sprint M.0 — Customer 360 v1 (feature store) 🧪 build verde (2026-06-10)

> Tabla/MV por cliente con las señales mínimas para la rebanada. Refresh nightly + on-demand. Prerequisito de todo lo proactivo.

| ID | Item | Estado |
|---|---|---|
| M.0.1 | Migración **`commercial.customer_360`** (tabla, NO `analytics.*` — RLS forzado + grants `app_runtime`, consistente con `recommended_baskets`): `(tenant_id, customer_id)` UNIQUE + `orders_count`, `first/last_order_at`, `recency_days`, `frequency_90d`, `monetary_90d`, `aov`, `cadence_days`, `next_order_estimate`, `lifecycle_stage` (CHECK new/active/at_risk/lost/reactivated), `computed_at`. Idempotente (`hasTable`). `20260610140000`. | 🧪 build verde (2026-06-10) |
| M.0.2 | `Customer360Service` — UPSERT **batch** por tenant (CTEs base→gaps→cadence→agg→metrics; cadencia = `percentile_cont(0.5)` sobre gaps; stage por recency vs cadencia). `computeForTenant()` + `computeForCustomer(id)` + `getForCustomer`/`getForMyCustomer` (recompute si stale >24h). `reactivated` reservado, no se emite en v1. | 🧪 build verde (2026-06-10) |
| M.0.3 | `Customer360RefreshService` `@Cron('0 0 8 * * *')` (2 AM MX) + scope CLS sintético (patrón `RecommendationsRefreshService`) + endpoint `POST /commercial/intelligence/customer-360/refresh`. | 🧪 build verde (2026-06-10) |
| M.0.4 | Endpoints lectura: `GET /commercial/intelligence/customer-360/:customer_id` + `/my` + `POST /:id/compute`. Permisos reusados (ORDERS_VER/CUSTOMERS_VER/GESTIONAR — sin permiso nuevo → sin tocar ability.factory). | 🧪 build verde (2026-06-10) |

### Sprint M.1 — Motor de Decisión v1 (NBA) 🧪 build verde (2026-06-10)

> Dado el Customer 360, decide qué toca hoy. Determinista, explicable.

| ID | Item | Estado |
|---|---|---|
| M.1.1 | `DecisionEngineService.nextBestAction(id)` → `{action, reason, urgency, days_overdue}`. Regla: `hoy ≥ next_order_estimate` y stage `active`/`at_risk` → `due_for_reorder`; urgency por días vencido (≤3 low / ≤10 medium / >10 high). | 🧪 build verde (2026-06-10) |
| M.1.2 | `DecisionEngineService.suggestedBasket(id)` — reusa categoría `base` de `RecommendationsService` (NO el LLM, precio ya viene snapshot). | 🧪 build verde (2026-06-10) |
| M.1.3 | Endpoint `GET /commercial/intelligence/nba` (lista due-for-reorder del tenant, urgentes primero) + `GET /nba/:id` + `GET /nba/:id/basket`. Scope `route` diferido (necesita join vendor_sales_routes). | 🧪 build verde (2026-06-10) |
| M.1.4 | Smoke E2E con data real (cliente cadencia ~Nd → NBA correcto, canasta no vacía). **Pendiente** — requiere migración aplicada + API up. | ⬜ |

> **Verificación M.0+M.1 (2026-06-10):** `nx build api` verde + revisión adversarial **9/9 items OK** (SQL batch UPSERT, binding order, RLS scoping, route ordering, DI, `.rowCount`). **RISK-1 corregido**: `next_order_estimate` y la comparación "vence hoy" ahora truncan en `AT TIME ZONE 'America/Mexico_City'` (antes UTC de sesión → jitter de 1 día). **Pendiente runtime**: aplicar migración (boot API) + smoke E2E (M.0.4 / M.1.4).

### Sprint M.2 — Agente v1 (commerce agent) 🧪 build verde (2026-06-10)

> v1 redacta el mensaje de reorden a partir del NBA + canasta del motor. NO toca dinero. Implementado **aditivo** (nuevo `CommerceAgentService`), NO refactorizando el `portal-ai-order` que ya funciona.

| ID | Item | Estado |
|---|---|---|
| M.2.1 | Refactor `portal-ai-order` → tool-belt unificado (`get_customer_360`, `lookup_price`, `create_draft_order`…). **Diferido** — riesgo de romper el AI Order Builder en uso. En su lugar M.2.2 aditivo. | ⬜ diferido |
| M.2.2 | `CommerceAgentService.composeReorderMessage(id)`: lee NBA + `suggestedBasket` del motor (hechos fijos), Claude Haiku **solo redacta** el mensaje WhatsApp; fallback a plantilla determinista sin API key o ante error. Endpoint `GET /commercial/intelligence/nba/:id/message`. | 🧪 build verde (2026-06-10) |
| M.2.3 | Invariante por diseño: el LLM solo reescribe un draft con los productos como hechos; nunca inventa producto/precio/cantidad y **NO crea pedido** (eso es camino determinista). Prompt prohíbe cambiar el set de productos. Test runtime pendiente. | 🧪 build verde (2026-06-10) |

### Sprint M.3 — Canal v1 (entrega) 🧪 build verde (superficies) (2026-06-10)

> Superficies in-app primero (vendor + portal). Push/scanner diferidos. Channel-agnostic: el mismo NBA alimenta todos. Las llamadas frontend son **best-effort** (caen a vacío si la migración no está aplicada → no rompen las pantallas).

| ID | Item | Estado |
|---|---|---|
| M.3.4 | **Vendor home** (`vendor-route-home`): banner "N por reordenar hoy" + chip "Reordenar" por cliente + toggle filtro. Intersecta `GET /commercial/intelligence/nba` con la cartera (`VendorService.nbaDue`, best-effort). | 🧪 build verde (2026-06-10) |
| M.3.3 | **Portal home** (`portal-home`): tarjeta "Tu pedido habitual" / "Ya va siendo hora" con productos base + CTA → `/portal/recommendations`. Usa `myCustomer360()` (cadencia/due) + `myRecommendations()` (base). | 🧪 build verde (2026-06-10) |
| M.3.1 | Terminar `commercial-push`: endpoint `POST /commercial/push/subscribe` + persistencia. **Diferido** (próximo sub-paso). | ⬜ |
| M.3.2 | `ReorderNudgeScanner` (`@Cron`): entrega push del NBA con **frequency capping**. **Diferido** (depende de M.3.1). | ⬜ |

### Sprint M.4 — Feedback loop v1 🧪 build verde (2026-06-10)

> Cierra la capa "aprende". Loguea ofertas/impresiones; la **conversión se DERIVA por join con orders** (sin write-back, sin acoplar orders → intelligence).

| ID | Item | Estado |
|---|---|---|
| M.4.1 | Migración **`commercial.commerce_signals`** (append-only: `tenant_id, customer_id, signal_type, channel, user_id?, context jsonb, created_at`; RLS forzado; `20260610150000`). NO `analytics.*` (consistencia con el resto del lib + RLS). | 🧪 build verde (2026-06-10) |
| M.4.2 | `FeedbackService`: `record` + `recordForMyCustomer` (resuelve customer del JWT) + `conversionSummary(days)` (ofertas → pedido confirmed/fulfilled del mismo customer dentro de 7 días). Endpoints `POST /signals`, `POST /signals/my`, `GET /signals/summary`. | 🧪 build verde (2026-06-10) |
| M.4.3 | Hooks: `composeReorderMessage` loguea `offer_message` (server-side). Frontend: vendor `openSheet` de cliente due → `offer_shown`; portal home tarjeta visible → `offer_shown` (`/my`). Todos best-effort. | 🧪 build verde (2026-06-10) |
| M.4.4 | Widget en Command Center: fila de 4 KPIs (Reorden hoy / Ofertas / Convertidas / Conversión %) reusando `.cell`, consume `signals/summary` + `nba`. Best-effort (se oculta si el motor no responde). | 🧪 build verde (2026-06-10) |

### Sprint M.5 — Verificación + cierre 🧪 smoke verde (2026-06-10)

> **2 fixes encontrados al bajar a runtime (smoke):**
> 1. **FK a `public.tenants` falla** — post-reorg (Fase L) `public.tenants` es una VISTA passthrough, no tabla. Las migraciones nuevas deben FK a `identity.tenants` (tabla real) o solo tenant_id+RLS. Corregido en ambas migraciones. (La `recommended_baskets` que se calcó se aplicó *antes* del reorg.)
> 2. **Cadencia degenerada = 0** — calcularla sobre gaps de *timestamps* da 0 cuando los pedidos están amontonados (testdata: 44 pedidos en 4 días). Corregido: cadencia = mediana de gaps entre **días-calendario distintos** (MX TZ). TST-PORTAL-001: 0.0019 → 1 día.
>
> **Observación de data:** el NBA sale vacío en la testdata original (pedidos amontonados → todos `lost`). NO es bug del motor — confirmado sembrando `NBA-DEMO-001` con pedidos espaciados (`seed-nba-demo.js`): el cliente aparece `due_for_reorder` con mensaje Claude correcto. En historial real de Mega Dulces (pedidos repartidos en semanas) el NBA se poblará solo.


| ID | Item | Estado |
|---|---|---|
| M.5.1 | Suite HTTP E2E `database/tests/http-intelligence-test.js` — **32/32 verde** (2026-06-10) contra Docker `localhost:5433` tras aplicar migraciones. Refresh: 2941 customers / 3 tenants / 0 errores / 153ms. NO agregada aún a `run-all-tests.js` (la agrega Edgar; requiere migraciones + API up). | ✅ smoke 32/32 (2026-06-10) |
| M.5.2 | **Happy-path verificado** vía `database/scripts/seed-nba-demo.js` (cliente `NBA-DEMO-001`, 6 pedidos espaciados 7d): Customer360 `cadence=7, stage=active, recency=10` → NBA `due_for_reorder` (urgency low, 3d overdue) → mensaje **Claude real** usando SOLO los 3 productos del motor (invariante ADR-016 OK en runtime) → NBA list `1 due`. | ✅ demo E2E (2026-06-10) |
| M.5.3 | Entry de cierre en `03_LOG_REVISIONES.md`: arquitectura final + lessons + métricas (latencia NBA, conversión inicial). | ⬜ |
| M.5.4 | Memory feedback si surge algo no obvio (umbral de cadencia, capping óptimo, etc.). | ⬜ |

---

## Mapa: 18 puntos de la comparativa → capas

| # Punto comparativa | Capa | En slice V1 | Ensanche |
|---|---|---|---|
| 3 Tomar pedidos básicos | — | ✅ ya existe | — |
| 8 Historial → pedidos repetidos | 0+1 | ✅ (reorden) | cadencia fina |
| 6 Ciclo de vida + telemetría | 0 | parcial (cadencia+stage) | RFM, churn, afinidad, geo |
| 16 Pedido AI recomendado por cliente | 1+2 | ✅ (canasta pre-armada) | proactivo multi-canal |
| 2/15 Reducir tiempo del vendedor | 1+3 | ✅ (NBA + 1 toque) | copiloto vendedor |
| 12/18 Auto-atención / e-commerce | 3 | ✅ (tarjeta portal) | empuje multi-canal |
| 14b Push | 3 | ✅ (se termina) | — |
| 7/9/10 Productos especializados / rotación / "lo que se compra" | 1 | parcial | gap de catálogo + rotación real |
| 11 Promos por fecha próxima a pedido | 1+4 | ⬜ ensanche | motor promos event-driven |
| 13 Promos exclusivas + campañas | 1+3 | ⬜ ensanche | campaign builder (Fase G) |
| 1/4 Ruta óptima / ordenamiento | 1 | ⬜ ensanche | geocode + nearest-neighbor+2-opt |
| 5 Tiendas potenciales | 1 | ⬜ ensanche | whitespace stores vs customers |
| 14a/17 WhatsApp + agente AI | 2+3 | ⬜ ensanche | Fase F (BSP + BullMQ) |
| 14c Teléfono / televenta | 3 | ✅ ya existe | copiloto agente |

---

## Ensanche post-slice (orden sugerido)

1. **Customer 360 completo** — RFM, churn score, afinidad de producto (vector), gap de catálogo, geo. Desbloquea #6/#9/#10.
2. **Ruta óptima + prospectos** — geocodificar `commercial.customers`, nearest-neighbor+2-opt con `haversine` existente; whitespace = stores TM auditadas que no compran. #1/#4/#5.
3. **Motor de promos event-driven** — reglas sobre cadencia/stage que auto-asignan `commercial.promotions` dirigidas. #11/#13.
4. **Canal WhatsApp + agente conversacional** — Fase F formal (BSP + BullMQ). El multiplicador; el motor ya es channel-agnostic. #14a/#17.
5. **Feedback → re-scoring** — los `commerce_signals` reajustan pesos de la canasta/NBA. Cierra el loop de aprendizaje.

---

## Evaluación: ¿el motor abarca la captura diaria de Trade? (2026-06-10)

> Pregunta de Edgar: "¿qué tanto abarcará este motor? ¿podemos usarlo de prueba hasta para la captura diaria de Trade — historial + productos más capturados para selección rápida?" Verificado por workflow (6 agentes) contra el código y la **DB real** `postgres_platform`.

### Hallazgo decisivo: la feature YA EXISTE (~70%)
No es greenfield. Hoy ya hay, end-to-end:
- Backend `findFrequentProducts(userId, {days, limit, storeId})` — `libs/trade/src/lib/daily-captures/daily-captures.service.ts:816-851` — `GROUP BY` sobre `jsonb_array_elements(exhibiciones)->'productosMarcados'`.
- Endpoint `GET /daily-captures/frequent-products`.
- UI: fila de chips **"Tus frecuentes"** arriba del search en el paso 5 del wizard, one-tap-to-add, accesible — `captures.component.html:1043-1064`.

### Realidad de datos (DB live, no asunciones)
- `trade.daily_captures`: **403 capturas, solo 36 con `store_id` (8.9%), 1 sola tienda con ≥2 capturas.**
- `productosMarcados` presente en 519/520 exhibiciones → el GROUP BY es sólido.
- **0 ocurrencias de `tiendaId`** en 520 exhibiciones. `valid_exhibition_combinations` existe pero está **vacía (0 filas)**.

### Bug real encontrado (silencioso)
`findFrequentProducts` filtra `AND ex->>'tiendaId' = ?` — clave que **no existe en ninguna exhibición** → cuando se pasa `storeId` devuelve **siempre `[]`**, y el front cae a `set([])` (best-effort). La promesa "frecuentes de esta tienda" **nunca dispara**. El scoping por tienda está muerto, y aunque se arregle (`dc.store_id`), solo 1 tienda tiene data suficiente.

### Decisión de scope (corregida tras revisión adversarial)
1. **NO construir un motor compartido (`platform-intelligence`) todavía.** Razones: (a) "más capturado" (presencia/auditoría) ≠ "más pedido" (compromiso económico) — unidades distintas, no promediar en un mismo `RankingRow`; (b) acoplar el ranker de captura con el `RecommendationsService` del camino-de-dinero es acoplamiento prematuro en la capa más sensible; (c) YAGNI hasta que haya un 3er consumidor real. **El slice comercial V1 y el piloto Trade quedan separados.**
2. **El piloto Trade vive 100% dentro de `libs/trade`** (`CapturesRecommendService`). Respeta la separación de proyectos (la superficie ya vive en el shell Trade `/dashboard`, sin sangrar a Comercial).
3. **Es un buen piloto de aprendizaje** (cero dinero, superficie ya existe, alta frecuencia diaria = feedback rápido, fuerza el músculo offline-first) — **pero es mayormente un fix + offline, no una feature nueva ni el mismo motor.**
4. **Framing honesto: "Tus productos habituales" (atajo de tecleo), NO "lo que hay en esta tienda".** El señal es circular (los chips sugeridos se vuelven marcas que retroalimentan el ranking). No relabelar "en esta tienda" con la data actual.

### Piloto Trade-Captura — items (shrunk)
| ID | Item | Estado |
|---|---|---|
| MT.1 | **Fix bug**: filtro `ex->>'tiendaId'` (matcheaba 0 filas) → `dc.store_id = ?` en `findFrequentProducts` (`daily-captures.service.ts:833`). | 🧪 build verde (2026-06-10) · requiere restart API |
| MT.2 | **Store-scope resuelto sin bloquear en población**: el frontend (`captures.component.ts:loadFrequentProducts`) ahora pide **user-global** ("tus habituales") sin `storeId` — el señal que sí tiene data (store_id solo 8.9%). El backend queda correcto y listo para re-activar store-scope cuando se arregle `detectarTiendaCercana` (radio 30m). **No relabelar "en esta tienda"** (señal circular). | 🧪 build verde (2026-06-10) |
| MT.3 | **Offline (el valor real)**: `tipo:'frecuentes'` en `CatalogoOffline` (Dexie, sin bump de schema); nuevo `getFrequentProductsOffline()` (`daily-capture.service.ts`) online→fetch+cache, sin red→cache (no `[]`). | 🧪 build verde (2026-06-10) · verificación visual pendiente |
| MT.4 | **(Diferido — solo si se arregla población de `store_id`)** tabla `trade.recommended_captures` + cron precompute. **Cuidado de conexión**: el service usa `KNEX_CONNECTION` (postgres, RLS bypass) no `KNEX_NEW_DB` (app_runtime) — no copiar `recommendations-refresh` verbatim; usar la misma conexión que escribe + verificar mismo DB post-cutover. | ⬜ |
| MT.x | **Diferido**: motor genérico compartido, tabla `intelligence_feedback` (de-bias del señal circular; sirve también al matcher Fase K que hoy no persiste telemetría), expected-assortment (combinaciones vacías). | ⬜ |

**Respuesta a "qué tanto abarca el motor":** conceptualmente el patrón (feature store → ranking → superficie → feedback) aplica a cualquier dominio, **pero en la práctica se mantienen adaptadores separados por dominio**; el núcleo compartido se extrae solo cuando un 3er consumidor lo justifique. El motor NO es una pieza monolítica que toca todo: es un patrón replicado con fronteras de proyecto respetadas.

---

## Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Customer 360 mal calculado contamina todo lo de arriba | Empezar con 1 señal (cadencia) bien validada antes de sumar RFM/churn. Smoke contra clientes reales. |
| Nudges degeneran en spam | Frequency capping es parte del MVP (M.3.2), no diferible. Respeta preferencia `notif.prefs`. |
| LLM se mete en el camino del dinero | Invariante test M.2.3: precios solo vía `lookup_price`, commit solo vía `create_draft_order`. |
| MV sin RLS filtra cross-tenant | Filtro `tenant_id` explícito en cada query (lección Fase C MVs). |
| Cron sin `TenantKnexService.run()` ve 0 rows | Scope CLS sintético por tenant en `computeAll()` (lección Fase E/feedback memory). |
| Cadencia ruidosa con pocos pedidos | Solo calcular NBA `due_for_reorder` para clientes con ≥3 pedidos fulfilled. |
| Ensanche WhatsApp depende de infra ausente (BullMQ) | Motor channel-agnostic; WhatsApp es aditivo (un canal más que consume el mismo NBA). |

---

## Archivos esperados a tocar/crear (rebanada V1)

### Nuevos
- `database/migrations-newdb/XXXX_analytics_customer_360.js`
- `database/migrations-newdb/XXXX_analytics_commerce_signals.js`
- `libs/commercial/src/lib/commercial-intelligence/customer-360.service.ts`
- `libs/commercial/src/lib/commercial-intelligence/decision-engine.service.ts`
- `libs/commercial/src/lib/commercial-intelligence/reorder-nudge-scanner.service.ts`
- `libs/commercial/src/lib/commercial-intelligence/commercial-intelligence.controller.ts`
- `database/http-intelligence-test.js`

### Modificados
- `libs/commercial/src/lib/portal-ai-order/*` → generalizar a `commerce-agent` con tool-belt.
- `libs/commercial/src/lib/commercial-push/*` → endpoint `subscribe`.
- `libs/commercial/src/lib/commercial-recommendations/*` → `suggestedBasket` reutilizado por el motor.
- `apps/view/.../portal/pages/portal-home*` → tarjeta "pedido habitual".
- `apps/view/.../vendor/pages/vendor-route-home*` → NBA por cliente.
- `apps/view/.../dashboard/command-center/*` → métrica de conversión de nudges.
- `database/run-all-tests.js` → suite M.

---

## Costo operativo estimado (rebanada V1)

| Concepto | Cálculo | Total mensual |
|---|---|---|
| Customer 360 nightly | SQL puro, $0 | ~$0 |
| Agente redacta mensaje reorden (Haiku) | ~nudges/día × $0.0002 | <$1/mes (Mega Dulces) |
| Web Push | infra propia VAPID, $0 | $0 |
| **Total** | | **≈ $1 USD/mes** |

El costo grande aparece solo con WhatsApp (Fase F): conversaciones BSP + más tokens de agente conversacional.
