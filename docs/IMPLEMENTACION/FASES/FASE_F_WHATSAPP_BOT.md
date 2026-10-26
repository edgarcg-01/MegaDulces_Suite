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

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> **Aquí la interfaz principal es la conversación**: cada mensaje del bot es una afirmación ante el
> cliente y se juzga con las mismas capas (no afirma lo que no es, declara lo que no sabe, no pide ni
> cobra dos veces, tuteo mexicano).

**La pregunta que contesta (prueba de la frase, §4.0b):**

- Conversación: *«¿Qué quieres pedir y a dónde te lo llevamos?»* — una tarea con dos datos. Bien.
- Bandeja `/reparto/pedidos-whatsapp`: *«¿Qué pedidos entendió bien el bot y puedo mandar a
  reparto?»* — una pregunta; pero el pedido confirmado se despacha en otra pantalla
  (`/reparto/asignar`). Ver F.UI.8.
- Panel de conversaciones (F.4): *«¿Dónde se atora el bot?»* — una pregunta. Bien.

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** bandeja: primario = **el pedido propuesto, con los
renglones dudosos marcados** · secundario = lo que escribió el cliente, junto a cada renglón ·
terciario = teléfono, hora, hilo. Mensaje de resumen al cliente: primario = **total y forma de
pago** · secundario = renglones con presentación · terciario = domicilio.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| F.UI.1 | 🔴 | **«Pedido confirmado» que nadie ha confirmado.** `confirmar_pedido` crea el pedido en `pending_approval`; una persona lo confirma después en la bandeja. Si el bot responde «¡Listo, tu pedido va en camino!», le miente a cada cliente que pide. Y el plan no tiene ningún mensaje de salida cuando la persona confirma, corrige o rechaza: el cliente se queda sin saber si su pedido existe. | DESIGN §X.1 (nunca «listo, ya lo hice» como primer contacto) · §1.1 | El bot responde «Recibimos tu pedido por $[X]. Una persona de la tienda lo revisa y te escribe para confirmártelo; todavía no sale.». Confirmar, corregir o rechazar en la bandeja le manda su mensaje al cliente (dentro de la ventana de 24 h o con plantilla aprobada). Ninguna hora de llegada antes de la confirmación humana. |
| F.UI.2 | 🔴 | **El carrito no tiene unidad.** `cart` guarda `{product_id, sku, name, qty, unit_price}`: «mándame 2 de mazapanes» puede ser 2 piezas, 2 paquetes o 2 cajas, y el precio cambia por el factor de la caja. Si el bot elige, adivina el significado y se cobra en la puerta. | §1.6 · DESIGN Postel (liberal en la forma, nunca en el significado) · DESIGN §X.6 | Todo renglón del resumen dice la presentación y su contenido: «2 cajas de [producto] ([N] pzas c/u) × $[X] = $[Y]». Si la presentación es ambigua, el bot pregunta con botones (`sendInteractive`) antes de agregar. |
| F.UI.3 | 🔴 | **Cifras escritas por el modelo.** La respuesta sale de Haiku; si el modelo escribe un precio o el total en su texto, el cliente acepta una cifra que no salió del motor (ADR-016: el motor decide el dinero), y es la que el repartidor cobrará contra otra. | DESIGN §X (cero cifras del LLM en pantalla) | El resumen del carrito y el total son una plantilla fija armada desde `cart`. El texto libre del modelo no lleva importes (prueba que rechaza o reemplaza una respuesta con dinero escrito por el modelo). |
| F.UI.4 | 🔴 | **Un «sí» de más crea otro pedido.** El webhook deduplica por `message_id`, pero el cliente puede escribir «sí» dos veces o «confirmar» otra vez minutos después; el plan no dice qué hace el hilo en `done`. Dos `createIntake` = dos repartos y dos cobros contra entrega. | DESIGN Idempotencia visual · §5 | Un hilo en `done` no crea otro pedido: «Tu pedido [folio] ya está registrado. ¿Quieres agregar algo?». La bandeja marca dos pedidos del mismo teléfono en menos de [N] minutos. Prueba: dos «confirmar» seguidos = un pedido. |
| F.UI.5 | 🟠 | **«No lo tenemos» contra el catálogo equivocado.** El plan apoya el producto por lenguaje natural en Match-AI (Fase K), cuyo corpus filtra `in_planogram = true` ([GOTCHAS §83](../../GOTCHAS.md)): el catálogo de exhibición, no lo vendible con precio. El bot no encontraría productos que la tienda sí vende. | §1.1 · §1.5 · cruce con Fase K | Decidir el corpus del bot (el vendible por SKU, o `CommercialCatalogSearchService` como primario) y medirlo con 20 pedidos reales. El bot nunca dice «no lo tenemos»: «No lo encontré en el catálogo; te comunico con la tienda». |
| F.UI.6 | 🟠 | **Lo que el bot no tiene cómo saber.** Costo de envío, hora de llegada, existencia en la sucursal, si el repartidor acepta tarjeta (en LM la tarjeta es «sólo registro» con terminal externa) y si el domicilio está en zona: el piloto de LM cubre sólo Padre Hidalgo, La Piedad Abastos y 8 Esquinas, y el número por sucursal o central está sin decidir. Sin herramienta para eso, el modelo lo inventa o lo calla. | DESIGN §X.6 · §1.3 | Pregunta sin herramienta → «Eso te lo confirma la tienda» + `handoff_humano`. Cobertura verificada antes de armar el carrito: «Por ahora llevamos a domicilio desde Padre Hidalgo, La Piedad Abastos y 8 Esquinas». Sucursal siempre por su nombre, nunca su código. |
| F.UI.7 | 🟠 | **Pasar a una persona sin decir cuándo.** «No entendí» → handoff; fuera de horario nadie contesta, la ventana de 24 h de Meta se cierra y la respuesta del operador ya no llega sin plantilla. | DESIGN §X.6 (escalar con a quién y cuándo) · §5 | El mensaje dice cuándo: «Te comunico con una persona de la tienda. Atendemos de [hora] a [hora]; te escribimos en cuanto lo vea.». La bandeja muestra por hilo el tiempo que queda de la ventana («quedan [N] h para responder sin plantilla»). |
| F.UI.8 | 🟠 | **La bandeja no dice qué ve el operador, y es una segunda puerta.** «Revisar → confirmar» sin la frase original del cliente junto al producto elegido obliga a releer el chat entero. Y el pedido confirmado se despacha en `/reparto/asignar`: dos pantallas para una sola cola de pedidos a domicilio (más `/comercial/domicilio` de LM). | DESIGN §X.3 · §X.4 · §3.3 · §4.0 A | Cada renglón muestra «"[lo que escribió]" → [producto]», con la confianza del match en palabras y en ember lo que propuso el motor; los dudosos primero. Conflicto para Edgar: la bandeja como sección «Por confirmar (WhatsApp)» de `/reparto/asignar`, no como pantalla aparte. |
| F.UI.9 | 🟠 | **El cliente no sabe que habla con un programa, ni en qué registro.** Nada en el plan hace que el bot se presente como automático; Haiku cambia de registro (usted, voseo) según el mensaje que recibe. | DESIGN §X (que se vea que lo propone un motor) · idioma (español de México, tuteo) | Primer mensaje: «Soy el asistente automático de Mega Dulces. Puedo tomar tu pedido; una persona de la tienda lo confirma.». Prompt y plantillas en tuteo mexicano; una prueba con 20 conversaciones del simulador busca voseo y «usted». |

**Lo que esta revisión no cubre:** las plantillas que apruebe Meta (su texto exacto se valida con la
tienda), el panel de conversaciones de F.4 (sólo nombrado en el plan) y la bandeja en nivel A. Dos
cifras chocan con la Fase LM y hay que fijarlas antes de que el bot las prometa: la geocerca (20 m
aquí, 40 m en LM.11) y «firma obligatoria» (LM acepta firma, foto o WhatsApp; ver LM.UI.8).
