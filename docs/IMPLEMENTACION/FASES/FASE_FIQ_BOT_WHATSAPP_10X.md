# Fase FIQ — Bot de WhatsApp 10x (comercio conversacional inteligente)

> Investigación profunda del repo (workflow 10 agentes, ~1.15M tokens, 8 subsistemas + síntesis + crítica adversarial) realizada 2026-07-25. Este doc es el plan de implementación.

## Estado de ejecución (2026-07-27)

| Sprint | Estado | Nota |
|---|---|---|
| **FIQ.0** identidad por teléfono | ✅ **HECHO** (local) | Smoke `test-newdb-fiq0` 22/22 + review adversarial (3 fixes). Migs 20260727120000/120500 aplicadas local. Build api+view OK. |
| **FIQ.2** existencia por buckets | ✅ **HECHO** (local) | `availability` (agotado/pocas/disponible) en el adapter; el bot no revela el total. Build OK. Validación runtime sim pendiente. |
| **FIQ.4** personalización | 🔨 **PARCIAL** (local) | Core `mi_historial` ("lo de siempre") ✅. Diferido: sugeridos IA + upsell + `promociones_activas` + `contact_profile` (memoria). |
| FIQ.1, FIQ.3, FIQ.5–FIQ.11 | ⬜ TODO | Ver plan abajo. |

**Pendiente de despliegue:** los commits FIQ.0/2/4 están **locales, sin push**. Para verlo en vivo: push a `origin/main` + Railway aplica migs al boot + redeploy. Runtime sim validation (FIQ.2/4) pendiente hasta que corra el API.

---

## Tesis (el hallazgo raíz)

El bot ya existe end-to-end (Fase F): `webhook Meta → cola → orquestador Claude Haiku tool-use → COMMERCE_CONVERSATION_PORT → catálogo → hilo en 'review' para que un humano cierre` (ADR-034).

**El 10x NO es infraestructura nueva: es CABLEADO e INTELIGENCIA sobre una base que ya tiene:** motor de precios/stock/factor autoritativo (ADR-016), catálogo semántico pgvector/Voyage, mayoreo por lista, reserva de stock transaccional, home-delivery con geofence 20m, analytics MVs, Customer360 (RFM/lifecycle/NBA), recomendaciones IA (canasta D.4), y **un segundo agente Claude MUCHO más avanzado (Thot: tiering Haiku→Sonnet, extended thinking, visión, few-shot, self-correction) listo para copiar.**

**La palanca raíz** es resolver `customer_id` por teléfono (hoy `thread.customer_id` queda `null` siempre). Eso desbloquea de golpe: mayoreo, historial, reorden, personalización y el ancla del trust-score.

**Reglas duras (heredadas):** el MOTOR decide dinero/stock/gate, el LLM solo comunica (ADR-016); multi-tenant con RLS + `tenant_id` en toda tabla nueva; el bot nunca cierra el dinero — humano confirma (ADR-034).

---

## Los 8 requisitos → cobertura

| # | Requisito del usuario | Sprints | Reúso vs nuevo |
|---|---|---|---|
| 1 | Respuestas súper avanzadas (razonamiento, multi-turno, persona, upsell, ambigüedad) | FIQ.1, FIQ.4, FIQ.9 | ~90% reúso (ThotChat, PortalThotTools, ThotService) |
| 2 | Análisis de mercado y de pedidos (tendencias, estacionalidad, insights) | FIQ.8, FIQ.10 | Reúso casi total (analytics MVs + Thot tools) |
| 3 | Ubicación de la persona para llevar el pedido (geoloc + geocoding + ETA) | FIQ.5 | Reúso MapboxService, geofence, route-solver |
| 4 | Detector de "solo juegan" / no-show / fraude → trust score | FIQ.7 | Reúso patrón FraudEngine/CommercialFindings + calibración L2 |
| 5 | Apartado de pedidos (reserva temporal con expiración) | FIQ.6 | Reúso patrón lead_reservations + OrderStockService |
| 6 | Precio a MAYOREO (por volumen / caja / lista del cliente) | FIQ.3 | Reúso resolvePriceForCustomer + volume_discount |
| 7 | Existencia SIN mencionar el total (buckets) | FIQ.2 | Reúso search/listAllProducts/getFacets |
| 8 | Personalización: reconocer por teléfono, historial, recomendaciones, reorden | FIQ.0, FIQ.4, FIQ.10 | Reúso Customer360, Recommendations, getMyHistory |

---

## Sprints (vertical slices)

### FIQ.0 — Identidad del contacto por teléfono (RAÍZ del 10x) · esfuerzo M
Resolver `customer_id` por teléfono, que es lo que desbloquea todo lo demás.
- **Deliverable:** util E.164 MX canónico compartido (`libs/platform-core/.../mx-phone.ts`) que normaliza `521/52/+52/10díg` a UN formato, usado en inbound/outbound/lookup/optin/dedup; `resolveCustomerByPhone` en `COMMERCE_CONVERSATION_PORT` que busca por `commercial.customers.whatsapp` normalizado y setea `thread.customer_id`; **dedup de casual migrado de `phone` (match exacto) → `whatsapp` normalizado**; tabla `whatsapp.phone_number_tenant_map` + `resolveTenantId` real.
- **⚠️ Must-fix (crítica gap #4 — fallo silencioso):** el backfill+normalización de `commercial.customers.whatsapp` es **deliverable duro con definición de done**, no pendiente operacional: migración/script E.164 + test round-trip + assert de cobertura (% customers con whatsapp normalizado). Si esto queda a medias, `resolveCustomerByPhone` devuelve `null` en silencio y FIQ.3/4/7/10 quedan vacíos aunque se marquen "completos".
- **Depende de:** nada. **Es la raíz.**

### FIQ.1 — Cerebro avanzado (tiering + thinking + few-shot + persona) · M
- **Deliverable:** orquestador con model-tiering Haiku(router)→Sonnet(`think` con budget_tokens) para consultas complejas; ventana de contexto y `maxIters` ampliados; few-shot por similitud desde `whatsapp.bot_chat_log`; `buildWhatsAppSystemPrompt` (venta cálida + manejo de ambigüedad/aclaraciones); self-correction; log auditable + feedback 👍/👎. El loop vive en `libs/whatsapp`; los datos entran por el puerto (no acopla a commercial).
- **⚠️ Must-fix (crítica gap #6, #7, #15):** throttle por número/tenant + budget-guard (cap mensajes/día por contacto, degradar a Haiku/plantilla al exceder) — canal público sin techo de costo es vector de gasto/DoS; **garantizar que opt-out (BAJA/STOP) y ventana 24h se procesan ANTES del orquestador** (compliance Meta = ban del número si se ignora); decisión de durabilidad de cola (BullMQ+REDIS antes de subir latencia, o persistir inbound crudo).
- **Reúso:** patrón ThotChatService 1:1. **Nuevo:** `whatsapp.bot_chat_log` + persona WhatsApp.

### FIQ.2 — Existencia por buckets + browse por categoría · S (quick win)
- **Deliverable:** bucketización de stock **en el adapter del puerto** (`agotado / quedan pocas / disponible`) ANTES de exponer al LLM, manteniendo `stock_pieces` interno para el cap de `agregar_al_carrito`; filtro por `department/product_line` + facets de categoría; tool `browse_categoria`; prompt ajustado a no revelar números.
- **⚠️ Must-fix (crítica gap #3, #14):** **política de almacén del canal** — hoy el adapter elige UN almacén (`LATERAL LIMIT 1 is_default DESC`); hay que fijar el almacén de surtido del canal (patrón `PH_FULFILLMENT_WAREHOUSE='MD-10'`) o **agregar existencia across-warehouses** antes de bucketizar, si no el bot dirá "agotado" habiendo stock en otro almacén. Auditar **TODAS** las salidas al LLM (search, carrito, cotización, apartado) para que ninguna filtre el número exacto (test de no-disclosure).
- **Depende de:** nada. Se puede adelantar.

### FIQ.3 — Mayoreo: precio por lista + por caja + por volumen · M
- **Deliverable:** `searchProducts` pasa el `customerId` resuelto (FIQ.0) → precio de SU lista + `min_qty`; campo derivado `price_per_package = unit_price × factor_sale`; `resolvePriceForQty(productId, customerId, qty)` que elige el quiebre por volumen (extrae la lógica de `volume_discount` de `recalcOrderTotals` a método puro dry-run, o `commercial.price_tiers`); tool `cotizar_mayoreo` ("si llevás una caja de 40 te sale a $X c/u"). El motor pone todos los números.
- **⚠️ Must-fix (crítica gap #2, #10, #11):** **camino de negocio para el casual** — cómo un contacto nuevo de WhatsApp obtiene mayoreo (auto-alta de customer con lista MAYOREO al 1er pedido, o cotización sobre la lista mayoreo del tenant aun sin customer resuelto — NO caer a BASE-MXN de menudeo); **fijar cuál es la `is_default` correcta por entorno** con assert (importer marca MAYOREO, seed 04 marca BASE-MXN); **fix `applies_to_customer_ids`** (hoy se asumen `all_customers`) y **validar/incrementar `usage_limit`** de promos — si el bot cotiza/promociona sobre lógica con bugs, cobra de más/menos (viola ADR-016).
- **Depende de:** FIQ.0.

### FIQ.4 — Personalización, reorden y upsell inteligente · M
- **Deliverable:** tools `mi_historial` / `lo_de_siempre` / `sugeridos_para_ti` / `recomendar_upsell` / `promociones_activas`; overloads que aceptan `customerId` (hoy `getMyHistory/getMySuggested` devuelven `[]` sin JWT); perfil persistente cross-sesión `whatsapp.contact_profile` (preferencias, marcas, dirección habitual). El LLM narra, el motor pone precio/stock y **oculta margen al cliente**.
- **⚠️ Must-fix (crítica gap #12):** definir **quién y cuándo genera el `summary`** (hook al pasar el hilo a 'done', Haiku resume; determinista para preferencias/marcas) y **cargar `contact_profile` explícitamente en el prompt** al abrir cada hilo — si no, la "memoria" queda vacía. `commercial.orders` casi vacío en beta → usar `analytics.customer_product_sales` por `erp_code` (Customer360 ya combina app+ERP; normalización `erp_code` lpad5).
- **Depende de:** FIQ.0, FIQ.1.

### FIQ.5 — Geolocalización, geocoding y ETA de entrega · L
- **Deliverable:** ingest acepta `type=location` (y prepara `image`); adapter extrae `lat/lng` de `m.location`; `InboundMessage` extendido; **GEO_PORT** (promover `MapboxService` de `libs/trade` a puerto compartido inyectable, patrón COMMERCE_CONVERSATION_PORT); tool `capturar_ubicacion` (pin o geocode de texto) que persiste `lat/lng` en `delivery_address` + `contact_profile` + `customers.latitude/longitude`; wiring de `route_eta_min` vía `MapboxService.directions`; tool `calcular_eta`.
- **⚠️ Must-fix (crítica gap #5, #8):** **acotar el ETA como post-dispatch** — no hay auto-asignación de repartidor (dispatch 100% manual), así que "llega en ~X min" NO es computable al momento del pedido; o agregar auto-asignación mínima (o diferirla con ADR explícito). **Audio/voice notes:** declararlo diferido con ADR (alto volumen en MX) o mini-sprint STT — no dejarlo en silencio.
- **Depende de:** FIQ.0. **Gotcha:** `MAPBOX_TOKEN` en Railway; `optimize` Mapbox ≤12 puntos.

### FIQ.6 — Apartado de pedidos con TTL y auto-liberación · M
- **Deliverable:** `commercial.stock_reservations` (UNIQUE parcial `WHERE released_at IS NULL` + idx `expires_at`) + folio `AP-YYYY-NNNNN`; `StockReservationService.apartar/liberar` reusando `OrderStockService.reserve/release`; cron `@Cron('0 */5 * * * *')` con `KNEX_NEW_DB_ADMIN` (bypass RLS, sin ctx) que libera vencidos + avisa por WhatsApp (clona `TeleventaCronService`, con pre-liberación defensiva en el INSERT); tools `apartar_pedido` / `consultar_apartado`; **reserva defensiva al entrar a 'review'** para cerrar la ventana de sobreventa hasta la aprobación humana.
- **⚠️ Must-fix (crítica gap #13):** cerrar decisiones abiertas — ¿apartado siempre reserva (o excepción de preventa `requested_delivery_date`)? + atomicidad de `createIntake` (limpieza de drafts huérfanos ante fallo tardío).
- **Depende de:** FIQ.0. **Cron NO expuesto por HTTP.**

### FIQ.7 — Trust-score del contacto + gate determinista · L
- **Deliverable:** `commercial.contact_trust_features` (feature store) + `commercial.trust_thresholds` (config por tenant); `ContactTrustEngineService` (clona FraudEngine/CommercialFindings, **CERO LLM**) que agrega por contacto: ratio confirmados/creados y cancelaciones (`orders`/`order_status_history`), time-waster telefónico (`call_logs`), **no-show/rechazo real (`logistics.guide_recipients.incident_type` — la señal más fuerte de "no recibe pedidos")**, conversaciones sin pedido (`threads`/`commerce_signals`), deuda (`customers.balance`), apartados expirados; emite a `commercial.commercial_findings` (`subject_type='contact'`) con calibración L2; refresh en el cron de `customer_360`; tool interna `trust_check` + gate en `confirmar_pedido` donde el **MOTOR** decide `allow / require_deposit% / block / handoff` con umbrales, el LLM solo comunica (ADR-016/020). Guard `min_observations` anti-falsos-positivos (cold-start neutro).
- **⚠️ Must-fix (crítica gap #1):** `require_deposit` **NO es cobro online** (no hay pasarela — Fase H diferida, y `orders/payments` es cash-only por CHECK). Resolver como (a) transferencia con verificación manual (`verifyTransfer`) o (b) handoff humano. Documentar en ADR-037 que el gate solo emite hasta handoff mientras Fase H no exista; no tocar el CHECK cash-only sin autorización.
- **Depende de:** FIQ.0 (ancla por teléfono) + señales de FIQ.6.

### FIQ.8 — Análisis de mercado y de pedidos como tools · M
- **Deliverable:** tools read-only `tendencias_mercado` / `top_productos` / `que_se_vende_en_tu_zona` sobre `CommercialAnalyticsService` y `ThotToolsService` (whitelist metric×dim, share% determinista); MV/derivación `analytics.product_seasonality`; insights accionables para el negocio y frases para el cliente ("lo más pedido esta temporada en tu zona").
- **⚠️ Must-fix (crítica gap #9, #12b):** `analytics.*` **NO tiene RLS** → filtrar `tenant_id` EXPLÍCITO en cada tool (superficie de leak cross-tenant alta con varias tools); **validar profundidad histórica** de `sales_daily` antes de prometer estacionalidad (si <12 meses, degradar a "tendencia 30/90d"); definir la **superficie para el negocio** (dashboard/reporte del bot: conversión, ofertas mostradas vs convertidas) o diferir con ADR — hoy solo hay tools de cara al cliente. FDW ERP no alcanzable desde Railway → usar tablas `analytics.*` empujadas on-prem.
- **Depende de:** FIQ.1.

### FIQ.9 — Visión de imágenes de producto entrantes · M
- **Deliverable:** descarga de media de Meta (Graph media API) + habilitar `type=image`; pasar la imagen al modelo como bloque base64 en el último turno (patrón thot-chat vision) para reconocer producto/etiqueta y disparar `buscar_producto`. El motor sigue poniendo precio/stock.
- **Depende de:** FIQ.1. **Gotcha:** costo/latencia de visión, limitar a 1 uso por turno; descarga de media requiere token Graph.

### FIQ.10 — Outbound proactivo (reorden/promos) + feedback loop · M
- **Deliverable:** campaña de reorden NBA: `DecisionEngine.listDueForReorder` → `CommerceAgent.composeReorderMessage` (motor decide productos/precio, Haiku solo reescribe, fallback plantilla) → `WhatsAppCampaignService` con plantillas Meta aprobadas, respetando `marketing_optin` y ventana 24h; nudge de apartado por vencer; `FeedbackService.record(offer_shown, channel='whatsapp')` + atribución oferta→pedido para afinar el upsell.
- **Depende de:** FIQ.4. **Gotcha:** fuera de 24h solo plantillas aprobadas; opt-out ANTES del orquestador.

### FIQ.11 — Regresión E2E + verificación + docs/ADRs · M
- **Deliverable:** suite smoke del bot avanzado (reconocimiento por teléfono, mayoreo/por caja, buckets sin número exacto, apartado TTL con expiración por cron, trust gate block/deposit/handoff, geoloc+ETA, personalización/reorden, visión) + aislamiento entre tenants; integrar a `database/run-all-tests.js`; doc + tracker + ADRs 035-039.
- **Depende de:** FIQ.0–FIQ.10.

---

## Cambios de schema (tablas nuevas)

| Tabla | Propósito | RLS |
|---|---|---|
| `whatsapp.phone_number_tenant_map` | Meta `phone_number_id` → `tenant_id` (se consulta antes del scope → sin RLS, admin-managed) | ❌ |
| `whatsapp.bot_chat_log` | Auditoría por turno + few-shot + feedback (réplica de `thot_chat_log`) | ✅ |
| `whatsapp.contact_profile` | Memoria cross-sesión (preferencias, marcas, últimas coords) por E.164 + customer_id nullable | ✅ |
| `commercial.stock_reservations` | Apartado con TTL (UNIQUE parcial + idx expires_at) | ✅ |
| `commercial.reservation_sequences` | Folio atómico `AP-YYYY-NNNNN` | ✅ |
| `commercial.contact_trust_features` | Feature store del trust-score por contacto | ✅ |
| `commercial.trust_thresholds` | Config del gate por tenant (sin hardcode) | ✅ |
| `analytics.product_seasonality` | Estacionalidad/tendencia por producto (deriva de sales_daily) | ❌ (filtrar tenant_id explícito) |
| `commercial.price_tiers` *(opcional, decisión ADR)* | Mayoreo escalonado `qty_from → price` (alt: reusar `promotions.volume_discount`) | ✅ |
| `commercial.commercial_findings` *(REÚSO, no nueva)* | Hallazgos de trust con `subject_type='contact'` | ✅ |

---

## ADRs propuestos

- **ADR-035** — Bot conversacional avanzado: model-tiering Haiku→Sonnet + few-shot (`bot_chat_log`) + visión + persona cálida. Hereda ADR-016 (motor decide dinero) y ADR-034 (bot no cierra dinero). Loop en `libs/whatsapp`, datos por el puerto.
- **ADR-036** — Identidad del contacto por E.164 canónico: resolver por `customers.whatsapp` normalizado (no `phone` legacy ni match exacto). Trust/perfil anclados por teléfono aun sin `customer_id`. Incluye `phone_number_tenant_map` (deprecar `WHATSAPP_TENANT_ID` hardcodeado).
- **ADR-037** — Trust-score determinista: clona FraudEngine/CommercialFindings (CERO LLM, UPSERT idempotente, calibración L2, guard `min_observations`). El motor decide el gate; el LLM comunica y nunca acusa. `require_deposit` = transferencia verificada o handoff (no cobro online mientras Fase H no exista).
- **ADR-038** — Apartado con TTL: `stock_reservations` + cron @5min (`KNEX_NEW_DB_ADMIN`), clonando `lead_reservations`. La reserva incrementa `reserved_quantity`. Cron no expuesto por HTTP.
- **ADR-039** — GEO_PORT: promover `MapboxService` a puerto compartido inyectable desde whatsapp/commercial (evita importar `libs/trade`). Degrada a null sin `MAPBOX_TOKEN`.
- **Decisión abierta (mayoreo escalonado):** `commercial.price_tiers` (quiebres transversales) vs reusar `promotions.volume_discount` (por SKU). Recomendación: extraer `volume_discount` a método puro para cotización dry-run; evaluar `price_tiers` solo si el ERP trae quiebres por caja no modelables como promo.
- **ADR abierto (audio):** transcripción STT de notas de voz — diferir explícitamente o mini-sprint.
- **ADR abierto (outbound multi-tenant):** FIQ.0 resuelve enrutamiento inbound; el envío multi-tenant (token Meta por tenant) queda diferido hasta un 2º tenant real.

---

## Secuenciación / ruta crítica

```
FIQ.0 (identidad) ──┬─→ FIQ.3 (mayoreo)
   [RAÍZ]           ├─→ FIQ.4 (personalización) ──→ FIQ.10 (outbound)
                    ├─→ FIQ.6 (apartado) ──┐
                    └─→ FIQ.7 (trust) ←────┘ (usa señales de apartado)
FIQ.1 (cerebro) ─── paralelo, mejora con FIQ.0 ──→ FIQ.8 (analytics), FIQ.9 (visión)
FIQ.2 (buckets) ─── quick win independiente, adelantable
FIQ.5 (geoloc) ──── semi-independiente (depende FIQ.0)
FIQ.11 (regresión) ─ cierra todo
```

- **Quick wins tempranos (valor visible en días):** FIQ.2 (buckets, S) + FIQ.0 (identidad, M) → con solo esos dos el bot ya reconoce al cliente y comunica existencia correctamente.
- **Camino largo (mayor valor):** FIQ.0 → FIQ.4 → FIQ.7 → FIQ.10 (personalización → confianza → proactividad).

## Riesgos transversales (de la crítica)

1. **Fallo silencioso en cascada:** si FIQ.0 no normaliza+backfilla `customers.whatsapp`, todo lo que cuelga (mayoreo/personalización/trust/reorden) queda vacío sin error. → backfill es definición-de-done de FIQ.0.
2. **Gate inejecutable:** `require_deposit` sin riel de cobro. → resolver como transferencia/handoff.
3. **Costo LLM sin techo** en canal público. → throttle + budget-guard en FIQ.1.
4. **Buckets incorrectos por almacén único.** → política de surtido en FIQ.2.
5. **Fiabilidad de cola** (in-process pierde jobs al subir latencia). → BullMQ o persistir inbound.
6. **Cuello de botella humano** (todo funnelea a 'review' + outbound sube volumen). → dimensionar SLA de bandeja.
7. **`analytics.*` sin RLS** → filtro `tenant_id` explícito en cada tool.

## Pendientes operacionales (cross-sprint)
- Setear en Railway: `MAPBOX_TOKEN`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`.
- Poblar `whatsapp.phone_number_tenant_map`.
- Backfill/normalización de `commercial.customers.whatsapp` (parte dura de FIQ.0).
- Agendar el cron de `stock_reservations`.
- Fijar la `price_list` `is_default` correcta en cada entorno.
