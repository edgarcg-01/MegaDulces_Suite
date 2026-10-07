# Fase F — Comercio Conversacional por WhatsApp

> **Reescrito 2026-07-24** tras resolver ADR-006 (Meta Cloud API directo), ADR-007 (Claude Haiku tool-use) y ADR-034 (arquitectura). Deja atrás el stub original.

**Objetivo:** que un cliente pida por WhatsApp con un **chat conversacional** y ese pedido se convierta en un **reparto** a domicilio. El bot entiende lenguaje natural, arma el carrito y captura el domicilio; **un humano confirma** desde una bandeja de revisión; de ahí el pedido entra en la cadena de Reparto **que ya está construida** (`/reparto/asignar` → repartidor → COD → liquidación).

---

## Tesis (lo que hace corta esta fase)

La "mitad de atrás" ya existe y está en beta (Fase LM / ADR-027):

- `CommercialHomeDeliveryService.createIntake()` — recibe un pedido con `delivery_channel='whatsapp'`, resuelve cliente (cartera o **casual** dedupe por teléfono, alta rápida `CAS-<10díg>`) y lo arma vía `createDraft → replaceLines → place`.
- `/reparto/asignar` ([home-delivery-dispatch.component.ts](../../../apps/view/src/app/modules/reparto/pages/home-delivery-dispatch.component.ts)) — despacho a repartidor + moto.
- `recordDeliveryOutcome()` — firma obligatoria + geocerca 20 m + cobro COD atómico (`deliverAndCollect`).
- `rider_liquidations` — corte de caja / arqueo del repartidor.

**Lo único nuevo es la capa conversacional de entrada.** El bot termina llamando a `createIntake()` (en `pending_approval`) y el pedido aparece en una bandeja de revisión, luego en `/reparto/asignar`.

---

## Decisiones (ADR-006 / 007 / 034)

| Decisión | Elección | Razón |
|---|---|---|
| Canal (BSP) | **Meta Cloud API directo** detrás de `WhatsAppPort` | Sin markup por mensaje, control total. Simulador para dev sin Meta. |
| LLM | **Claude Haiku 4.5** tool-use | Ya es el estándar (Thot/Maat/extractor). Reusa `ANTHROPIC_API_KEY`. |
| Autonomía | **Bot arma / humano confirma** | Freno de seguridad en el piloto. Sube a híbrido/autónomo después sin rehacer. |
| Cola | **Redis + BullMQ** | Idempotencia + reintentos + picos. Desbloquea G/H/I. Degrada in-process sin `REDIS_URL`. |
| Motor vs LLM | **Motor decide el dinero** (ADR-016) | producto→SKU→precio→total = determinista (catalog-search + Match-AI K + pricing). |

---

## Arquitectura

```
Cliente WhatsApp
      │ mensaje entrante
      ▼
GET/POST /webhooks/whatsapp        (verify token GET · firma HMAC POST · dedup por message_id)
      │ encola
      ▼
BullMQ "whatsapp-in"  ──► worker: ConversationOrchestrator
      │                        │
      │                        ├─ whatsapp.conversation_threads (estado + carrito por teléfono)
      │                        ├─ Claude Haiku (tool-use):
      │                        │     buscar_producto     → CommercialCatalogSearchService + Match-AI (K)
      │                        │     agregar_al_carrito   → resuelve SKU + precio (pricing determinista)
      │                        │     ver_carrito / quitar
      │                        │     capturar_domicilio   → geocode Mapbox (reports/geocode)
      │                        │     confirmar_pedido     → createIntake(status='pending_approval')
      │                        │     handoff_humano       → marca el hilo para operador
      │                        └─ responde vía WhatsAppPort (encola "whatsapp-out")
      ▼
BullMQ "whatsapp-out" ──► MetaCloudWhatsAppAdapter.send()  (o SimulatorAdapter en dev)
      ▼
Bandeja  /reparto/pedidos-whatsapp   (patrón televenta: revisar → confirmar)
      │ operador confirma
      ▼
/reparto/asignar  ──► repartidor ──► COD ──► liquidación     ◄── YA EXISTE
```

**Puerto abstracto** `WhatsAppPort` (`libs/whatsapp`):

```ts
interface WhatsAppPort {
  sendText(to: string, body: string): Promise<{ message_id: string }>;
  sendInteractive(to: string, msg: InteractiveMessage): Promise<{ message_id: string }>;
  verifyWebhook(mode: string, token: string, challenge: string): string | null;
  parseInbound(body: unknown, signature?: string): InboundMessage[]; // valida HMAC
}
```

- `MetaCloudWhatsAppAdapter` — habla con `graph.facebook.com/v21.0/{phone_number_id}/messages`, valida `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`.
- `SimulatorWhatsAppAdapter` — no envía nada real; expone un endpoint de dev (`POST /webhooks/whatsapp/sim`) para inyectar mensajes y ver las respuestas en un log/WS. Permite construir y probar TODO el flujo sin Meta.

Selección del adaptador por env: `WHATSAPP_PROVIDER=meta|simulator` (default `simulator`).

---

## Sprints

| Sprint | Tema | Entregable | Estado |
|---|---|---|---|
| **F.0** | Fundación | `libs/whatsapp` + `WhatsAppPort` + `SimulatorAdapter` + BullMQ (degradable) + migración `conversation_threads` + permisos `WHATSAPP_*` | ⬜ |
| **F.1** | Canal Meta | `MetaCloudWhatsAppAdapter` + `POST/GET /webhooks/whatsapp` (verify + HMAC + dedup) + emisor + config env | ⬜ |
| **F.2** | Orquestador | `ConversationOrchestrator` (Haiku tool-use) + tools (buscar/carrito/domicilio/confirmar/handoff) + fallback heurístico | ⬜ |
| **F.3** | Pedido → bandeja | `createIntake(pending_approval)` desde bot + `/reparto/pedidos-whatsapp` (revisar → confirmar → dispatch) | ⬜ |
| **F.4** | Handoff + panel | Handoff a operador ("no entendí"/palabra clave) + dashboard de conversaciones (admin) | ⬜ |

> Regla del proyecto: cada sprint cierra con smoke test (agregar suite a `database/run-all-tests.js`) + entrada en tracker + build OK.

---

## Modelo de datos (F.0)

`whatsapp.conversation_threads` (RLS forzado, patrón A.0mt · `tenant_id` NOT NULL + audit):

| Columna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | RLS |
| `phone` | varchar | E.164, número del cliente |
| `wa_id` | varchar | id de WhatsApp del contacto |
| `customer_id` | uuid NULL | FK `commercial.customers` si se resuelve |
| `state` | varchar | `greeting`/`shopping`/`address`/`review`/`handoff`/`done` |
| `cart` | jsonb | `[{ product_id, sku, name, qty, unit_price }]` en curso |
| `delivery_address` | jsonb NULL | domicilio capturado |
| `last_message_at` | timestamptz | ventana 24 h de Meta |
| `handoff_at` | timestamptz NULL | derivado a humano |
| `order_id` | uuid NULL | orden creada al confirmar |

`whatsapp.messages` (auditoría de mensajes in/out, idempotencia por `wa_message_id UNIQUE`):
`id, tenant_id, thread_id, direction (in|out), wa_message_id, type, body, payload jsonb, created_at`.

Permisos nuevos (`platform-core/constants/permissions.ts` + backfill migration + re-login):

- `WHATSAPP_BOT_VER` — ver conversaciones + bandeja de pedidos WhatsApp.
- `WHATSAPP_BOT_GESTIONAR` — confirmar pedidos de la bandeja, tomar handoff, responder manual.

---

## Requisitos operativos (Edgar, fuera de código)

Bloquean **producción real**, NO el desarrollo con simulador:

1. App en [Meta for Developers](https://developers.facebook.com) + producto WhatsApp.
2. WhatsApp Business verificado + número dedicado (uno por sucursal o uno central).
3. Tokens en Railway: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_ACCESS_TOKEN` (permanente), `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.
4. `WHATSAPP_PROVIDER=meta` + webhook público apuntando a `https://<api>/webhooks/whatsapp`.
5. Plantillas de mensaje aprobadas por Meta (para abrir conversación fuera de la ventana de 24 h).
6. `ANTHROPIC_API_KEY` (ya requerido por Maat/Thot).
7. Redis en Railway (~$5/mes) para BullMQ, o dejar `REDIS_URL` vacío para modo in-process.

---

## Métricas

- % de pedidos WhatsApp confirmados sin intervención adicional del operador.
- Tiempo bot→bandeja y bandeja→despacho.
- Costo por conversación (tokens Haiku + tarifa Meta).
- Tasa de handoff (bot no entendió).

## Reuso directo (ya en el repo)

- Pedido/casual/domicilio/reparto/COD/liquidación — Fase LM (`commercial-home-delivery`, `reparto`).
- Producto por lenguaje natural — `CommercialCatalogSearchService` + Match-AI (Fase K, pgvector).
- Wrapper Claude Haiku tool-use + fallback — `LlmExtractorService`, Thot Chat, Maat.
- Bandeja de revisión — patrón de la cola de Televenta (Fase E).
- Redis client + Keyv + `@socket.io/redis-adapter` — ya instalados.

## Referencias

- ADR-006 / ADR-007 / ADR-034 en [`02_DECISIONES_ARQUITECTURA.md`](../02_DECISIONES_ARQUITECTURA.md).
- [`ANALISIS_COMUNICACIONES.md`](../ANALISIS_COMUNICACIONES.md) — por qué Redis+BullMQ ahora.
- [`FASE_LM_ULTIMA_MILLA.md`](FASE_LM_ULTIMA_MILLA.md) — la cadena de reparto que consume esta fase.
