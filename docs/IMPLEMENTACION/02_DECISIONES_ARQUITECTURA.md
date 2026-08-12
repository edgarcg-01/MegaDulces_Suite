# Decisiones de Arquitectura (ADR Log)

> Cada decisión técnica importante se registra como ADR (Architecture Decision Record). Formato simplificado: contexto → decisión → consecuencias.
>
> Convención: ADRs son **inmutables**. Si una decisión cambia, se agrega un nuevo ADR que la supersede, NUNCA se edita el original. Solo se actualiza el estado del original a "Superseded by ADR-XXX".

---

## ADR-000 — Plantilla

**Estado:** Plantilla (usar como base, copiar y reemplazar XXX)

**Fecha:** YYYY-MM-DD

**Contexto:** Qué problema/situación lleva a tomar una decisión. 2-4 líneas.

**Decisión:** Qué se decidió. 1-2 líneas claras.

**Alternativas consideradas:** 2-3 opciones rechazadas y por qué.

**Consecuencias:**
- ✅ Positivas
- ⚠️ Negativas / trade-offs
- 🔄 Reversible? Sí/No/Difícil

---

## ADR-001 — Tracking via markdown en repo (no Linear/Jira)

**Estado:** Aceptado

**Fecha:** 2026-05-26

**Contexto:** Single dev necesita tracking de progreso del roadmap a 18-24 meses. Las herramientas SaaS (Linear, Jira, Notion) agregan overhead y costo recurrente para un solo usuario.

**Decisión:** Tracking en archivos `.md` versionados con el código en `docs/IMPLEMENTACION/`. Kanban simple en `01_TRACKER_PROGRESO.md`.

**Alternativas consideradas:**
- **Linear**: excelente UX pero $8/usuario/mes innecesario para 1 persona.
- **GitHub Projects**: gratis pero la UI no es para roadmaps largos.
- **Notion**: gratis para 1 usuario pero divide la documentación entre código y plataforma externa.

**Consecuencias:**
- ✅ Documentación viaja con el código. Cualquier futuro dev clona y tiene todo el historial.
- ✅ Cero costo, cero login extra.
- ✅ Diffs de cambios son revisables en PRs.
- ⚠️ Sin UI bonita: hay que abrir el archivo y leer.
- ⚠️ Sin dashboards automatizados (hay que escribir métricas a mano si querés).
- 🔄 Reversible: migrar a Linear más adelante toma 1-2 días.

---

## ADR-002 — Orden de fases (limitaciones primero)

**Estado:** Aceptado

**Fecha:** 2026-05-26

**Contexto:** El plan original tenía 4 fases temáticas (Sales Intelligence, Comercio, Conversacional, Fintech). Sin embargo, la base actual tiene limitaciones que las harían frágiles: sin observability, sin queue, sin staging, sin CI, sin multi-tenant decision.

**Decisión:** Anteponer una **Fase A — Fundaciones** que arregla las limitaciones técnicas antes de iniciar cualquier feature nueva. Mantener WS scaling y ML en la **Fase I** al final, como el usuario solicitó.

**Alternativas consideradas:**
- **Empezar features de inmediato**: rechazado porque cada feature mayor amplificaría las debilidades actuales (sin queue, sin tests).
- **Big-bang refactor + features en paralelo**: rechazado porque single dev no escala.

**Consecuencias:**
- ✅ Las fases posteriores son más rápidas porque la base aguanta.
- ✅ Cada item de Fase A reduce riesgo operacional.
- ⚠️ 6-8 semanas iniciales sin features visibles para stakeholders.
- 🔄 Reversible: en cualquier momento podés saltar a una fase de feature si surge urgencia.

---

## ADR-003 — Decisión: single-tenant vs multi-tenant (SUPERSEDED)

**Estado:** ❌ Superseded by ADR-010

**Fecha original:** 2026-05-26

**Razón del cambio:** Se decidió la opción multi-tenant explícitamente — ver ADR-010.

---

## ADR-010 — Multi-tenancy ACEPTADO con DB nueva limpia

**Estado:** ✅ Aceptado

**Fecha:** 2026-05-26

**Contexto:**
- La DB actual asume Mega Dulces como única organización (no tiene `tenant_id`).
- El audit reveló deuda técnica significativa en el schema actual (audit fields fragmentados, naming inconsistente de roles, migraciones no idempotentes, etc.).
- La visión de plataforma B2B integral (ver `PLAN_PLATAFORMA_B2B.md`) eventualmente sirvirá a múltiples distribuidoras como SaaS.
- Yom.ai (benchmark de referencia) opera multi-tenant sirviendo a 20+ marcas desde la misma plataforma.

**Decisión:**

1. **Crear una DB Postgres NUEVA** con schema multi-tenant desde el origen.
2. **Patrón de tenancy**: **shared DB + `tenant_id` en TODAS las tablas** (Opción 1 estándar SaaS).
3. **DB actual queda en paralelo** sirviendo a producción hasta que se complete la migración. Sin downtime hard.
4. **Mega Dulces es el primer tenant** (`tenant_id = 'mega_dulces'`, UUID estable).
5. **Migración de data**: scripts que copian de DB legacy → DB nueva con `tenant_id` poblado.
6. **Cuando la nueva DB esté lista y validada**, se hace cutover: el API apunta a la nueva DB, la vieja queda como backup read-only por 30 días.

**Alternativas consideradas y rechazadas:**

- **A. Single-tenant permanente**: descartada — cierra la puerta a vender el sistema como SaaS.
- **B. Multi-tenant in-place sobre la DB actual**: descartada — arrastra toda la deuda técnica del audit. Sería refactor más doloroso que empezar limpio.
- **C. Schema-per-tenant**: descartada — complejidad de gestión (50 schemas si llegan 50 tenants), problemas con migraciones, sin beneficio claro vs shared DB con `tenant_id`.
- **D. DB-per-tenant**: descartada — overhead operativo enorme, costo infra multiplicado, JOINs cross-tenant imposibles (que sí queremos para reportes agregados internos).

**Implicaciones técnicas:**

| Aspecto | Cómo se implementa |
|---|---|
| **Tabla `tenants`** | Nueva tabla con `id`, `slug` (unique, ej: 'mega_dulces'), `nombre`, `activo`, `plan`, `created_at`. |
| **`tenant_id` en cada tabla** | UUID FK a `tenants(id)`, NOT NULL, índice en cada tabla. |
| **JWT carga `tenant_id`** | Al login se identifica el tenant del usuario; el `tenant_id` viaja en cada request. |
| **Row-Level Security (RLS)** | Postgres RLS opcional para defense-in-depth — políticas que filtran automáticamente por `tenant_id` aunque el código tenga bugs. |
| **Middleware `TenantContextInterceptor`** | NestJS intercepta cada request, extrae `tenant_id` del JWT, lo inyecta en CLS/AsyncLocalStorage. Servicios Knex usan ese contexto automáticamente. |
| **Tests de aislamiento** | Tests obligatorios para verificar que un tenant NUNCA puede leer/escribir data de otro. |

**Consecuencias:**

- ✅ **Plataforma lista para SaaS** desde día 1. Onboarding de nuevo tenant = INSERT en `tenants` + crear usuarios.
- ✅ **Schema limpio** — sin arrastrar deuda técnica del legacy.
- ✅ **Audit fields consistentes** desde el inicio (todas las tablas tienen `created_at`, `updated_at`, `updated_by`, `deleted_at`, `deleted_by`, `tenant_id`).
- ✅ **Naming consistente** — snake_case en todo, sin `Jefe_M`.
- ⚠️ **Doble DB en paralelo** durante la transición (1-3 meses).
- ⚠️ **Plan de migración de data** debe ser cuidadoso — visitas históricas, fotos, scoring, todo debe migrar sin pérdida.
- ⚠️ **+20% trabajo inicial** vs single-tenant.
- 🔄 **Reversible**: si el approach falla, la DB legacy sigue ahí.

**Plan de implementación:**

Detallado en `FASES/FASE_A0bis_MULTITENANT_NEW_DB.md` (nuevo). Sprint **A.0-multitenant** se inserta antes del Sprint A.0bis del plan correctivo del audit, porque tiene más sentido aplicar las correcciones del audit directamente sobre el schema nuevo limpio que sobre el legacy.

**Acciones inmediatas:**

- [ ] Crear servicio Postgres nuevo en Railway para esta nueva DB.
- [ ] Definir schema multi-tenant inicial (migraciones desde cero).
- [ ] Diseñar mecanismo de `TenantContextInterceptor` para NestJS.
- [ ] Plan de migración de data legacy → nueva DB (script + validación).

---

## ADR-004 — Integración con ERP Kepler (SUPERSEDED)

**Estado:** ❌ Superseded by ADR-009

**Fecha original:** 2026-05-26

**Razón del cambio:** Se asumió que Kepler usaba SQL Server (común en su instalación típica). Mega Dulces confirmó que su Kepler usa **PostgreSQL**, lo que cambia significativamente la arquitectura de integración.

---

## ADR-009 — Integración con ERP Kepler (Postgres)

**Estado:** Aceptado

**Fecha:** 2026-05-26

**Contexto:** Mega Dulces usa Kepler ERP con backend **PostgreSQL** (no SQL Server como se asumió originalmente). Esto cambia el approach de integración significativamente para mejor.

**Decisión:**
1. **Conexión directa al Postgres de Kepler con usuario read-only**. Mismo driver `pg` que ya usamos (sin nuevo `mssql`).
2. **Evaluar `postgres_fdw`** (Foreign Data Wrapper) para queries cross-database. Permite hacer JOIN entre nuestra app y Kepler en SQL puro, sin copiar data.
3. **Mantener tablas espejo en schema `commercial.*` para data caliente** (catálogo, precios) que se consulta MUCHO. Sync con BullMQ.
4. **Stock real-time vía `postgres_fdw`**: queries pasan por foreign tables sin cache, garantizando precisión al checkout.
5. Si Kepler está en la misma instancia Postgres (consultar a TI): podemos usar **schemas separados** (`kepler.*` y `commercial.*` en una sola DB). Aún mejor performance.

**Alternativas consideradas:**
- **Replicación lógica** (Postgres logical replication): valioso si necesitamos data al-segundo de Kepler. Más complejo de setup pero superior a sync nocturno.
- **Sync nocturno puro** (idea original): suficiente para catálogo, frágil para stock.
- **Vista materialized en Postgres de Kepler**: requiere permisos de write en Kepler (típicamente bloqueado).

**Consecuencias:**
- ✅ **Stack único (Postgres)** → menos drivers, menos partes que fallan.
- ✅ **`postgres_fdw` permite stock real-time** sin sync delay.
- ✅ **Posibilidad de replicación lógica** futura para acercar a real-time.
- ✅ **Knex sigue siendo el query builder** (sin cambiar tecnología).
- ⚠️ Si Kepler cambia su schema en un upgrade, nos rompe. Mismo riesgo que MSSQL, pero mitigable con view layer en Kepler.
- ⚠️ Permiso de TI para conectar al Postgres de Kepler (mismo bloqueante que MSSQL hubiera tenido).
- 🔄 Reversible a sync puro si `postgres_fdw` da problemas de performance.

**Acciones para validar antes de Sprint B.0:**
- [ ] Confirmar versión de Postgres en Kepler.
- [x] ✅ **Confirmado 2026-05-26**: la nueva DB `postgres_platform` se crea en el **mismo servidor que Kepler** (host LAN `192.168.0.245:5432`). Esto habilita opciones premium:
  - **Si son la misma instancia Postgres**: usar schemas separados (`kepler.*` + `app.*`) sin overhead. Mejor performance posible.
  - **Si son instancias separadas en el mismo server**: `postgres_fdw` con latencia ~0 (loopback). Sin overhead de red.
- [ ] Validar si Kepler corre en la misma instancia Postgres o en una distinta dentro de `192.168.0.245`.
- [ ] Validar disponibilidad de extensión `postgres_fdw` (viene por default desde PG 9.3+).
- [ ] Obtener credenciales de usuario read-only con permisos en las tablas Kepler.

---

## ADR-005 — Stack mobile (Ionic actual vs React Native nuevo)

**Estado:** ✅ Aceptado (2026-05-26)

**Fecha:** 2026-05-26

**Contexto:** App mobile actual está embebida en `apps/view` vía Capacitor (Angular + PrimeNG + Dexie). Yom.ai (referencia) usa React Native. Al agregar el módulo "toma de pedidos" para fuerza de ventas (Sprint D.2), hay que decidir si extender lo actual o crear `apps/mobile-sales` separado en RN.

**Decisión:** **Extender `apps/view` con módulo `vendor/` y rutas `/vendor/*` mobile-first**. Sin app RN separada por ahora.

**Razonamiento:**
1. Capacitor + Dexie ya están configurados y funcionando para capturistas.
2. 1 sólo dev (Edgar) — agregar RN duplica stack a mantener (Angular + RN, dos toolchains de build, dos sistemas de assets).
3. PrimeNG ya tiene componentes mobile-friendly (Card/InputNumber/Table responsive).
4. Reuso de `PortalService`, `AuthService`, guards y `environment.ts` — sin duplicar API client.
5. Si en el futuro hace falta UX nativo profundo (cámara avanzada, geofencing, push background), se puede crear app RN entonces; el backend ya está listo y multi-tenant.

**Alternativas consideradas y rechazadas:**
- **B. Separar a `apps/mobile-capturistas` (Ionic) + `apps/mobile-sales` (RN nuevo)**: dos stacks, doble esfuerzo de mantenimiento, no justificable con 1 dev.
- **C. Extender a `apps/mobile-capturistas` (Ionic) + agregar "Sales" como módulo más en el mismo Ionic separado**: complejidad organizacional sin ganancia técnica vs A.

**Consecuencias:**
- ✅ Reuso de toda la infra (auth, environment, PrimeNG, Dexie, Capacitor build, deploy).
- ✅ El módulo `vendor/` con `vendor-shell` (sin sidebar, bottom-nav) ofrece UX mobile-first sin requerir framework nuevo.
- ✅ Web responsive + Capacitor en dispositivos → mismo código corre en navegador (desktop/mobile) y en APK Android.
- ⚠️ `apps/view` se vuelve más grande — mitigable con lazy-load de módulos (ya hecho).
- ⚠️ Performance Angular en mobile es buena pero no nativa — si surgen problemas, evaluar RN/Flutter en futuro.
- 🔄 Reversible: el backend NO depende del frontend. Migrar a RN futuro sólo requiere reimplementar UI consumiendo los mismos endpoints REST + WS.

---

## ADR-006 — WhatsApp BSP

**Estado:** ✅ Aceptado (2026-07-24) — **Meta Cloud API directo**

**Fecha:** 2026-07-24

**Contexto:** WhatsApp Business API requiere un canal. Opciones para LATAM: Meta Cloud API directo, 360dialog, Wati, Gupshup, Twilio.

**Decisión:** **Meta WhatsApp Cloud API directo** (sin BSP intermediario).

**Razonamiento:**
- **Costo mínimo:** solo la tarifa de conversación de Meta, sin markup por mensaje (Twilio/Wati cobran encima). Con el volumen esperado del piloto (bot arma / humano confirma, un número por sucursal) la diferencia es material.
- **Control total** del webhook y del emisor — encaja con el patrón de la app (todo in-house, monolito Nest, `libs/*` propios). No dependemos de la UI ni del rate-limit de un tercero.
- La app ya tiene `axios` (llamadas HTTP a Cloud API) e infra de webhooks/firma HMAC trivial de montar en un controller Nest.
- El único costo real es el onboarding (app de Meta + verificación de WhatsApp Business + número dedicado), que es un trámite de una sola vez.

**Aislamiento del riesgo de vendor:** la integración vive detrás de un puerto abstracto **`WhatsAppPort`** (`libs/whatsapp`). El adaptador Meta (`MetaCloudWhatsAppAdapter`) es una implementación; existe un **`SimulatorWhatsAppAdapter`** para construir y probar todo el flujo conversacional sin BSP. Cambiar a 360dialog/Twilio en el futuro = un adaptador nuevo, sin tocar el motor conversacional.

**Requisitos operativos (Edgar, fuera de código):** app en Meta for Developers + WhatsApp Business verificado + número dedicado + `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_ACCESS_TOKEN` (permanente), `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (para validar la firma). Plantillas de mensaje aprobadas para iniciar conversación fuera de la ventana de 24 h.

---

## ADR-007 — Selección de LLM para bot conversacional

**Estado:** ✅ Aceptado (2026-07-24) — **Anthropic Claude Haiku 4.5** (tool-use)

**Fecha:** 2026-07-24

**Contexto:** El bot conversacional necesita un LLM con tool calling en español. Opciones: Anthropic Claude, OpenAI GPT, Google Gemini, open-source.

**Decisión:** **Claude Haiku 4.5 con tool-use**, mismo modelo y patrón que ya usa el proyecto (`LlmExtractorService`, Thot Chat, Maat). Cero reinvención: reusa `ANTHROPIC_API_KEY`, el wrapper de `api.anthropic.com/v1/messages` y el fallback heurístico ya probados.

**Razonamiento:**
- **Consistencia:** ya es el estándar de facto (ADR-011/026/028). Un solo proveedor, un solo secreto, una sola forma de tool-use.
- **Costo/velocidad:** Haiku es barato y rápido, apto para conversación. Si un turno necesita más razonamiento (p. ej. resolver un pedido ambiguo), se puede escalar a Sonnet-think puntual como ya hace Maat.
- **El LLM NO toca el dinero (ADR-016):** el bot arma el carrito en lenguaje natural, pero **la resolución producto→SKU→precio y el total los calcula el motor determinista** (catalog-search + Match-AI de Fase K + pricing). El LLM solo orquesta la conversación y llama tools; nunca inventa precios ni confirma cobros.

---

## ADR-008 — Partner financiero para YomWallet

**Estado:** Pendiente — decidir en Fase D

**Fecha:** _(por completar)_

**Contexto:** Para wallet con depósitos a tendero se requiere partner regulado en México.

**Alternativas a evaluar:**
- **Conekta**: pasarela de pagos + dispersión, MX.
- **Mercado Pago Business**: cubre flow completo, costos por transacción.
- **BBVA API Business**: bancarización formal, requiere relación corporativa.
- **Clip**: enfoque comercios, menos enterprise.
- **Stripe Connect**: limitado en MX para algunos use cases.

---

## ADR-011 — Provider de embeddings: Voyage AI `voyage-3`

**Estado:** ✅ Aceptado

**Fecha:** 2026-05-27

**Contexto:**
- Fase K (AI product match en captures) necesita embeddings vectoriales del catálogo TM (`products.nombre`) para hacer similarity search semántica vía pgvector.
- Anthropic Claude **no genera embeddings** — hay que elegir provider externo o local.
- Catálogo Mega Dulces hoy ~1000 SKUs en español MX, crecerá a ~5k al onboardear más tenants.

**Decisión:** Voyage AI con modelo **`voyage-3`** (1024 dimensiones, multilingual, alignment recomendado por Anthropic).

**Alternativas consideradas:**
- **Voyage `voyage-3-lite`** (512 dims): más barato y rápido pero margen de calidad menor — descartado para evitar refactor cuando catálogo crezca.
- **OpenAI `text-embedding-3-small`** (1536 dims): calidad comparable, pero suma otro proveedor / cuenta / billing — innecesario teniendo Voyage alineado con Anthropic.
- **Local sentence-transformers** (Python sidecar): $0 ongoing pero complica infra Railway (Docker custom, healthcheck, scaling) — no escala para 1 dev.

**Consecuencias:**
- ✅ Mismo provider ecosystem que Anthropic (1 cuenta de billing + 1 API key adicional).
- ✅ Multilingual español MX excelente, maneja acentos / abreviaciones / typos del nombre de producto.
- ✅ Costo trivial: ~$0.02 backfill 1k SKUs; ~$0.0001 por query online.
- ✅ Index pgvector HNSW sobre 1024 dims es performante para escala ≤100k SKUs (no hace falta IVFFLAT).
- ⚠️ Dependencia externa: si Voyage cae, el feature degrada al search clásico (acceptable, no blocker).
- ⚠️ Necesita `VOYAGE_API_KEY` en `.env` + Railway secrets.
- 🔄 Reversible: el campo `embedding vector(1024)` se puede re-generar con otro provider si dimensión coincide (o se altera con `ALTER COLUMN TYPE vector(NEW_DIMS)` perdiendo data).

---

## ADR-012 — pgvector en DB legacy, portar con la tabla cuando se migre a multi-tenant

**Estado:** ✅ Aceptado

**Fecha:** 2026-05-27

**Contexto:**
- Catálogo TM (`brands` + `products`) vive hoy en DB legacy, NO en la DB multi-tenant nueva (`postgres_platform`). La migración Fase A.0mt solo movió `auth/users/roles`; las tablas TM siguen pendientes.
- Fase K (AI product match) necesita pgvector + columna `embedding` en `products`.
- Postergar Fase K hasta migrar TM a multi-tenant retrasa el feature ~2 semanas mínimo.

**Decisión:** Instalar `CREATE EXTENSION vector` y agregar `embedding` a `products` **en la DB legacy** ahora. Cuando se migre TM a la DB multi-tenant (sprint futuro tipo A.0mt.6), la columna `embedding` viaja con la tabla en el script de copia y se recrea el HNSW index del lado nuevo.

**Alternativas consideradas:**
- **Migrar TM a multi-tenant primero, luego pgvector**: bloquea Fase K 2 semanas mínimo, sin valor entregable. Rechazado.
- **Dual-write a ambas DBs ahora**: complejidad innecesaria, single source of truth se rompe.
- **No usar pgvector, hacer similarity search en JS**: O(N) por query sobre 1000+ SKUs en backend, latencia mata el UX mobile. Rechazado.

**Consecuencias:**
- ✅ Fase K arranca inmediatamente.
- ✅ El feature funciona contra DB legacy (que es donde hoy se hace todo TM en prod).
- ⚠️ Cuando migremos TM a multi-tenant: hay que extender el script de copia para mover la columna `embedding` (1 línea más en SELECT/INSERT) + recrear el HNSW index del lado destino. Trivial.
- ⚠️ La extensión `vector` debe estar en ambos servidores (legacy actual + DB nueva futura). Verificado: Railway Postgres + Postgres local 18.4 lo soportan.
- 🔄 Reversible: la columna `embedding` se puede dropear sin afectar el resto del catálogo (degradación a search clásico).

---

## ADR-013 — Estado intermedio `pending_approval` en state machine de orders (flujo B2B)

**Estado:** ✅ Aceptado

**Fecha:** 2026-06-02

**Contexto:**
- Pre-existente: `commercial.orders.status` solo tenía `draft → confirmed → fulfilled` (+ `cancelled` desde varios). El cliente B2B confirmaba y el order saltaba directo a `confirmed`, reservando stock sin que el vendedor revisara.
- Necesidad de negocio: el vendedor en Mega Dulces debe **revisar** cada pedido confirmado por el cliente antes de comprometer stock real para preparación. En especial debe poder **recortar** cantidades cuando el cliente pidió más de lo realista.
- El cambio aterrizó en commit `edff610` (migraciones `20260528100000_orders_add_pending_approval_status.js` + `20260529082000_*` + `20260529100000_order_lines_requested_quantity.js`) pero la regression suite no se actualizó al mismo tiempo — 7/19 suites quedaron rojas hasta el cierre 2026-06-02.

**Decisión:** Adoptar el state machine ampliado:

```
draft → pending_approval → confirmed → fulfilled
                                     ↘
                                       cancelled  (desde draft / pending_approval / confirmed)
```

Reglas:
- `POST /commercial/orders/:id/confirm` (cliente, permiso `COMMERCIAL_ORDERS_CREAR`) → `draft → pending_approval`. **Reserva stock** en este punto (no en confirmed). Líneas snapshot `quantity` en `requested_quantity`.
- `POST /commercial/orders/:id/approve` (vendedor, permiso `COMMERCIAL_ORDERS_CONFIRMAR`) → `pending_approval → confirmed`. **No mueve inventario** (ya reservado).
- En `pending_approval` el vendedor solo puede **recortar** cantidades (≤ `requested_quantity`), nunca aumentar. Editar la línea ajusta la reserva atómicamente.
- `fulfill()` sigue siendo `confirmed → fulfilled` y consume stock (vía hook desde `LogisticsShipmentsService.close()` cuando es la última shipment del order).
- `cancel()` libera reservas si el order estaba en `pending_approval` **o** `confirmed`.

**Alternativas consideradas:**
- **Mantener 3 estados + flag `needs_review` boolean**: split de truth source → bugs de consistencia. Rechazado.
- **Reservar stock solo al `approve()`**: ventana donde cliente confirma pero stock no está protegido → otro cliente puede comprar lo mismo. Rechazado.
- **Notificar al vendedor con alerts WS y dejar `confirmed` como antes**: no impide stock comprometido a pedidos no revisados. Rechazado.

**Consecuencias:**
- ✅ Vendedor tiene cola explícita `WHERE status='pending_approval'` para revisar.
- ✅ `requested_quantity` audita cuánto pidió el cliente vs. cuánto se aprobó.
- ✅ Alerts WS: `emitLargeOrder` dispara en `confirm()`; `emitOrderConfirmed` dispara en `approve()`; `emitOrderFulfilled` igual que antes.
- ⚠️ Frontend `portal/` y `vendor/` deben mostrar el nuevo estado intermedio (validación visual pendiente).
- ⚠️ Tests (B.1, B.3.2, J.6.1, J.8, C.4, D.1, D.4) ajustados para llamar `/approve` entre `/confirm` y `/fulfill`. Regression 19/19 verde al cierre.
- 🔄 Reversible: la migración `up` tiene `down` que UPDATEa cualquier order `pending_approval → confirmed` antes de quitar el valor del CHECK constraint. Data preservada.

**Bug colateral detectado y corregido en el mismo cierre:** `apps/api/src/shared/ability/ability.factory.ts` **nunca tuvo** mappings para los Permission `COMMERCIAL_*` ni `LOGISTICS_*`. El `RolesGuard` chequea `permissionToSubject[perm]` y devuelve `false` si el mapping no existe → 403 silencioso para CUALQUIER role no-admin sobre endpoints comerciales/logística. `superoot` pasaba sólo porque su permiso `REPORTES_VER_GLOBAL` activa `can('manage', 'all')`. Fix: agregados 28 mappings (subjects nuevos: `commercial_customers`, `commercial_warehouses`, `commercial_pricing`, `commercial_inventory`, `commercial_orders`, `commercial_payments`, `commercial_promotions`, `commercial_televenta`, `logistics_fleet`, `logistics_shipments`, `logistics_guides`, `logistics_expenses`, `logistics_payroll`, `logistics_config`) en `ability.types.ts` + `ability.factory.ts`. Verificado E2E con `cliente_demo` (rol `customer_b2b`) en portal.

---

## ADR-014 — App del Portal B2B: Capacitor (Android primero), no Ionic; extraer a `apps/b2b-portal`

**Estado:** ✅ Aceptado (2026-06-03)

**Fecha:** 2026-06-03

**Contexto:** El Portal B2B hoy es una web Angular responsive (standalone + PrimeNG + Tailwind) embebida en `apps/view` bajo `/portal/*`, online-only, ya mobile-first (shell propio con bottom-nav + FAB). Se evalúa convertirlo en app descargable con 3 drivers: **presencia en tiendas**, **push notifications** y **funcionar offline**. Se consideró Ionic, React Native y Flutter.

**Decisión:** **App nativa con Capacitor reusando el portal Angular — NO Ionic ni RN/Flutter.** Refinamientos elegidos:
- **Extraer el portal a `apps/b2b-portal`** (build propio, core compartido vía `libs/`) en vez de envolver `apps/view`. Razón: el binario nativo empaqueta TODO el bundle web on-device; envolver `apps/view` metería el panel admin dentro del celular del cliente (peso + UI interna expuesta).
- **Android primero** (compila en Windows, Play Store). iOS diferido (requiere macOS/Xcode o cloud build; dev está en Windows).
- **Offline = catálogo de solo lectura** (cachear productos/precios/cliente con Dexie para navegar sin señal); el pedido se envía online. El offline-ordering completo (outbox + resolución de conflictos precio/stock + idempotencia) queda diferido por costo (~semanas).

**Razonamiento:**
1. Capacitor ya está en el stack; Ionic solo agregaría una librería UI que obligaría a reescribir la UI PrimeNG/Tailwind ya funcional — semanas tiradas a la basura por ~0 ganancia (el shell ya se siente nativo).
2. 1 solo dev — minimizar stacks (consistente con ADR-005).
3. Reuso ~100% del portal Angular y del backend REST `commercial/*` multi-tenant (auth-mt, ownership por `customer_b2b`).
4. La infra Dexie/offline ya existe (la usa Trade Marketing); el catálogo de solo lectura reusa esos patrones con bajo costo.

**Alternativas rechazadas:**
- **Ionic (rewrite UI):** reescribir todo en componentes Ionic; alto costo, reuso ~30%, sin beneficio real sobre Capacitor que ya se tiene.
- **React Native / Flutter:** segundo stack, reuso 0, insostenible con 1 dev.
- **Envolver `apps/view`:** rápido para piloto pero empaqueta el admin en el binario del cliente.
- **Offline-ordering completo en v1:** costo desproporcionado (conflictos de precio/stock + idempotencia) para el MVP.

**Consecuencias:**
- ✅ App Android en Play Store reusando el portal; iOS reactivable cuando haya Mac/cloud build (backend ya listo).
- ✅ Push vía Capacitor Push + FCM; backend suma registro de device tokens + hooks en ciclo de pedido (complementa `AlertsGateway`/WS).
- ✅ Catálogo navegable offline; pedido online.
- ⚠️ Extraer a `apps/b2b-portal` exige mover core (`AuthService`, `ThemeService`, `HapticService`, `PermissionsService`, interceptor, `environment`) a `libs/` — ~1 semana de setup.
- ⚠️ Push masivo y sync futuro se beneficiarían de Redis/colas (ligado a la decisión de no-Redis-hasta-Fase-F).
- 🔄 Reversible: el backend no depende del frontend; el portal puede seguir viviendo como ruta web en paralelo a la app.

**Roadmap propuesto (fases):**
1. Extraer `apps/b2b-portal` (core → `libs/`, Nx app nueva, build web verde).
2. Capacitor Android + íconos/splash + Play Store (cuenta dev, privacy policy, screenshots).
3. Push FCM (plugin + endpoint registro de tokens + envío + hooks confirm/approve/fulfill/promos).
4. Offline catálogo solo-lectura (cache Dexie de productos/precios/cliente + estrategia de refresh).
5. (Diferido) iOS · offline-ordering completo.

---

## ADR-016 — Motor de Inteligencia Comercial: el motor decide, el agente comunica, el LLM fuera del camino del dinero

**Estado:** ✅ Aceptado (2026-06-10)

**Fecha:** 2026-06-10

**Contexto:**
- Comparativa vs yom.ai (2026-06-10): ~18 capacidades pedidas (optimización de ruta, prospección, ciclo de vida del cliente, recomendación/pedido sugerido, promos por cadencia, canales WhatsApp/push/teléfono, auto-atención, agente AI). Auditoría del código mostró que ~60% del sustrato ya existe disperso (RecommendationsService, AI Order Builder con Haiku, pgvector con 1278 SKUs, analytics MVs, AlertsScanner cron, Socket.IO+Redis, commercial.promotions, TenantContext/RLS).
- Riesgo: construir las 18 como features sueltas produce 18 cosas que no se hablan entre sí. yom.ai no es 18 features; es **un motor de decisión + un agente que lo conversa + canales que lo entregan + un loop de feedback**.
- La regla de oro del usuario: **quitarle tiempo de toma-de-pedido al vendedor para liberar tiempo de prospección/nuevos clientes.** Eso es un problema de decisión automatizada, no de UI.

**Decisión:** Construir **un Motor de Inteligencia Comercial** en 5 capas, con dos invariantes duros:

1. **El motor decide, el agente comunica.** La decisión de *qué* ofrecer / *qué* promo / *qué* ruta / *qué* cliente atender hoy la toma un **motor determinista** (SQL + scoring explicable), no el LLM. El **agente AI** (Claude Haiku) decide *cómo decirlo* y maneja la conversación abierta; llama al motor vía tools (function calling) y **nunca inventa data**.
2. **El LLM nunca toca el dinero.** Precios, stock y commit de pedidos viven en el camino determinista existente (`commercial-orders`). El agente *propone* un borrador; el motor *valida y ejecuta*. El LLM jamás computa un precio ni compromete inventario.

Capas:

| Capa | Qué hace | Determinista / AI |
|---|---|---|
| 0 — Customer 360 (feature store) | Estado por cliente: RFM, cadencia, próxima compra estimada, stage, afinidad, churn, geo. Refresh nightly + incremental. | Determinista |
| 1 — Motor de Decisión | Next-Best-Action, canasta sugerida, promo óptima, ruta óptima + prospectos, canal+timing. | Determinista (scoring) |
| 2 — Agente AI | Pedido conversacional, explicación de recomendaciones, copiloto de vendedor/televenta. Tool-belt compartido + RAG pgvector. | AI (Claude Haiku) |
| 3 — Canales / Orquestación | Entrega el NBA por WhatsApp/push/portal/vendor/televenta. Frequency capping anti-spam. | Determinista + cron/colas |
| 4 — Feedback loop | Cada oferta → resultado (abrió/pidió/ignoró) → reajusta pesos del scoring. | Determinista (estadística) |

3. **Build por rebanada vertical, no fundación horizontal.** Primer entregable = un caso end-to-end fino que toca las 5 capas (reorden inteligente por cadencia → pedido pre-armado → push/portal → feedback). Se ensancha después. Razón: validar la arquitectura completa con valor real en 1-2 sprints en vez de sobre-construir capas que nadie usa todavía.

4. **Empezar heurístico/estadístico, NO ML entrenado.** Cadencia = mediana de gaps entre pedidos; stage = reglas sobre recency vs cadencia; churn = score estadístico. El ML real ya está planeado en Fase I (credit risk) cuando exista data histórica suficiente. El motor v1 no entrena modelos.

**Alternativas consideradas:**
- **Construir las 18 capacidades como features independientes:** rechazado — silos que no comparten estado del cliente ni feedback; imposible orquestar "oferta correcta / canal correcto / momento correcto".
- **Agente AI mega-autónomo que decide y ejecuta (LLM en el camino del dinero):** rechazado — no auditable, riesgo de alucinar precios/stock, caro a volumen, frágil para multi-tenant. El LLM como interfaz (no como decisor) es más barato, explicable y seguro.
- **Fundación horizontal (Customer 360 + Motor completos antes de tocar canales):** rechazado por el usuario — valor tarda 4-5 sprints, riesgo de sobre-construir. Se eligió rebanada vertical.
- **Entrenar modelos ML desde v1:** rechazado — no hay suficiente data histórica limpia aún; heurísticas estadísticas dan el 80% del valor a costo ~0.

**Consecuencias:**
- ✅ Una sola fuente de verdad del cliente (Customer 360) de la que leen recomendación, promos, ruta, alertas y agente.
- ✅ Reuso de ~60% del sustrato existente (Haiku, pgvector, RecommendationsService, AlertsScanner, promotions, MVs).
- ✅ LLM barato y auditable; el camino del dinero queda determinista (sin regresión de confianza).
- ✅ Ataca directo la regla de oro: el motor pre-arma el pedido recurrente → el vendedor deja de capturarlo a mano.
- ⚠️ Customer 360 es prerequisito de casi todo lo proactivo; si se hace mal, contamina todas las capas de arriba.
- ⚠️ El feedback loop sin frequency capping puede degenerar en spam — el capping es parte del MVP, no diferible.
- ⚠️ WhatsApp (canal de mayor retorno) sigue dependiendo de la Fase F formal (BSP + BullMQ); el motor se diseña channel-agnostic para que enchufar WhatsApp sea aditivo.
- 🔄 Reversible: cada capa es un servicio independiente; se puede apagar el agente y dejar el motor sirviendo NBA crudo, o apagar un canal sin tocar el motor.

**Plan de implementación:** Detallado en [`FASES/FASE_M_MOTOR_INTELIGENCIA.md`](FASES/FASE_M_MOTOR_INTELIGENCIA.md). Rebanada vertical V1 = "Reorden inteligente".

---

## ADR-017 — Autodetección de llegada del vendedor: geo en customers + detección por lista + doble anti-traslape

**Estado:** ✅ Aceptado (2026-06-10)

**Fecha:** 2026-06-10

**Contexto:**
- Modo Vendedor v2 (`/vendor`) ya muestra la cartera en orden de visita y los pedidos pendientes por cliente (cross-canal, con `is_preventa`). Falta cerrar el loop de campo: que al **llegar físicamente** a un cliente se autodetecte (como `/capture` detecta la tienda por GPS) y se le avise si **ya hay un pedido pendiente** (preventa del portal o de campo) para **no duplicarlo**.
- Hallazgo: `commercial.customers` **no tenía** lat/lng (solo address JSONB). `commercial.vendor_visits` ya tenía columnas geo (nullable, sin usar). El check-in backend ya aceptaba coords pero el frontend no las mandaba. El patrón GPS+Haversine de `/capture` (radio 30 m, online `/stores/nearby` + fallback offline) es reutilizable.

**Decisión:**
1. **`commercial.customers` gana `latitude`/`longitude`** (DECIMAL 9,6, igual que `vendor_visits`), nullable. Poblado **capture-on-visit**: el GPS del vendedor al hacer check-in backfilea las coords canónicas del cliente (decisión del usuario: bootstrap orgánico, sin geocodificar ~2944 clientes a mano). Índice parcial `WHERE lat/lng NOT NULL`.
2. **Detección por lista rankeada, no por punto único.** `GET /vendor-routes/nearby?lat&lng&radius` devuelve los clientes de la **cartera** (scoped por `vendor_sales_routes`) con coords, ordenados por distancia (Haversine en SQL), filtrados por radio. Radio default **80 m** (clientes más dispersos que tiendas + drift GPS + estacionar). Si hay varios dentro del radio, la UI desambigua (mismo patrón que `nearbyStores`).
3. **Doble anti-traslape** (el detalle crítico que pidió el usuario):
   - **De coordenadas:** al backfillear/setear coords, guard Haversine contra los OTROS clientes; si cae a < **25 m** de uno distinto → NO guarda, devuelve `conflict` para que el vendedor desambigüe (o `force` para confirmar). Mantiene la detección no ambigua.
   - **De pedidos:** el take-order detecta los pendientes del cliente (`pending_approval`/`confirmed`, cualquier canal) y **avisa + reusa** — no bloquea (un 2do pedido con otra fecha es legítimo). Default = abrir el existente.
4. **`GeolocationService` compartido** (GPS one-shot) extraído a `core/services`, reusado por `/vendor` y disponible para `/capture` — una sola implementación, sin drift.
5. **Online-first** (decisión del usuario): el cache offline de coords de cartera + cola de backfill se difiere, consistente con D.2.3 ya diferido.

**Alternativas consideradas:**
- **Reusar `/stores/nearby` (tiendas trade) para el vendedor:** rechazado — la cartera del vendedor es `commercial.customers`, no `trade.stores`; entidades distintas con distinto scoping (rutas de venta vs zonas).
- **Geocodificar el maestro de clientes de entrada (manual/importer):** rechazado para v1 — ~2944 clientes; el capture-on-visit puebla solo lo que el vendedor realmente visita. (Edición manual en admin queda como ensanche.)
- **Bloqueo duro de pedido duplicado:** rechazado — impediría un 2do pedido legítimo (otra fecha); se eligió avisar + reusar.
- **Detección por cliente más cercano único:** rechazado — GPS drift + clientes contiguos hacen ambigua la asignación; lista rankeada + guard de separación lo resuelven.

**Consecuencias:**
- ✅ Cierra el loop de campo: llegada → autodetección → ve pendiente → no duplica → toma/edita el correcto.
- ✅ Reusa el patrón GPS+Haversine de `/capture` y las columnas geo ya existentes en `vendor_visits`.
- ✅ La detección mejora sola con el uso (cada visita puebla coords); no requiere un proyecto de geocodificación.
- ⚠️ Hasta que las coords se pueblen, el banner de llegada no dispara para ese cliente (chicken-and-egg resuelto por el primer check-in con GPS).
- ⚠️ Precisión sujeta al GPS del dispositivo; radio 80 m y separación 25 m son tunables.
- 🔄 Reversible: feature aditiva; sin GPS/permiso, home y take-order funcionan igual que antes (degradación elegante).

**Plan/estado:** Backend (migración `20260610160000` + `nearby`/`set-location`/backfill en `commercial-vendor-routes`) + frontend (`GeolocationService`, banner de llegada en home, aviso anti-duplicado en take-order) en código. Build api+view verde, SQL Haversine validado en DB. Smoke `database/tests/http-vendor-geo-test.js` en la suite (requiere reinicio de API con el código V.6).

---

## ADR-018 — **Thot**: motor de inteligencia comercial multi-señal (evoluciona ADR-016)

**Estado:** ✅ Aceptado (2026-06-11)

**Fecha:** 2026-06-11

**Contexto:**
- El motor v1 (ADR-016 / Fase M) recomienda **producto-first** con `margen × rotación`: una lista plana, **igual para cualquier cliente**, sin tendencias, zona ni afinidad. El usuario pide un motor "digno de tener un nombre": que analice **tendencias, época del año, zona, ventas, rotación, compras de pares**, y que se pueda **ir entrenando un agente como motor**.
- **Sondeo de datos reales (ERP `Mega_Dulces`, 2026-06-11)** define qué es señal y qué es humo:

  | Señal | Data | Veredicto |
  |---|---|---|
  | Rotación | `productos_activos` (30d/almacén) | ✅ fuerte |
  | Ventas/volumen | `ventas` 2.18M filas | ✅ fuerte |
  | Margen real | `catalogo_etiquetas` + `costo_civa` | ✅ fuerte |
  | **Zona** | `ventas.zona` (5 zonas, demanda muy distinta: La Piedad $107M vs Yurécuaro $1.8M) | ✅ fuerte |
  | **Afinidad / market-basket** | **408,974 folios · 5.3 prod/folio · 70% multi-producto** | ✅✅ **el hallazgo grande** |
  | Tendencia corto plazo | solo Ene–Abr con volumen | 🟡 parcial |
  | **Estacionalidad** | solo ~4 meses reales (May–Dic = futuro vacío) | ❌ **no aún** (necesita 1 año+) |
  | Per-tienda (cadencia) | `ventas` es por **ruta/CEDIS, no por tienda** | ❌ no del ERP; crece con la plataforma |
  | Compras de competidores (otras distribuidoras) | — | ❌ no la tenemos |
  | Peer "tiendas como la tuya" | ruta-level ahora; per-tienda crece | 🟡 parcial → crece |

**Decisión:**
1. **El motor se llama `Thot`** (dios egipcio de la sabiduría, la medida y la escritura — el que registra y decide). Identidad propia; superficie de marca ("Thot sugiere…", "según Thot").
2. **Score en dos capas, determinista y explicable**, precomputado en un *feature store* `intelligence.*`:
   - **Demanda** = Σ de 6 señales vivas (rotación, margen, **afinidad**, **zona-fit**, momentum, whitespace) + 2 futuras (estacionalidad, propensión per-tienda) que "encienden" al acumular datos.
   - **Estrategia** (empuje dirigido) = `score = demanda · (1 + boost_estrategia)`. El **negocio** define qué empujar (marca foco, lanzamiento, overstock, promo) vía `intelligence.push_directives`; Thot lo **amplifica** sin empujar lo que no se vende. Es lo que lo hace un motor de *trade marketing* (push a menudo financiado por proveedor), no un mero ranker de demanda.
   - Reemplaza el `margen × rotación` plano del v1; cada reco expone su razón.
3. **Inteligencia en 3 escalones** (extiende los invariantes de ADR-016 — *el motor decide, el agente comunica, el LLM nunca toca el dinero*):
   - **Heurístico/estadístico (ahora):** reglas de asociación (market-basket → lift/confidence), índice de demanda por zona, momentum. 80% del valor, cero ML entrenado.
   - **ML (con 3–6 meses de plataforma + histórico ERP):** forecast de demanda, association mining a escala, propensión/uplift per-tienda. El ML **informa** el score; no decide ni toca el dinero.
   - **Agente LLM (Claude):** usa el motor vía *tools* (function-calling), explica el "por qué te sugiero esto", arma el pedido conversando. **Jamás calcula precio ni compromete stock.**
4. **El feedback loop ES el entrenamiento.** `commerce_signals` (oferta→resultado) reajusta los **pesos de las señales** (bandit / online-learning). Así Thot aprende del negocio: qué señal predice conversión por zona/segmento. "Entrenar el agente" = cerrar este loop, no fine-tunear un LLM.
5. **Honestidad de datos como invariante:** Thot **no inventa estacionalidad ni personalización per-tienda** mientras no haya datos; se construye el pipeline para que enciendan solas. Lo "competidores" realista = **afinidad de pares** (market-basket ruta→per-tienda), no datos de otras distribuidoras (no existen).
6. **Build por rebanadas verticales** (T.1 afinidad+zona → … → agente), cada una con valor en take-order.

**Alternativas consideradas:**
- **Seguir con `margen × rotación` plano:** rechazado — no usa zona ni afinidad (los datos más ricos), no personaliza, no aprende.
- **LLM que decide qué/precio:** rechazado por ADR-016 (no auditable, alucina precio/stock, caro a volumen).
- **ML desde el día 1:** rechazado — solo ~4 meses de historia; las heurísticas estadísticas (asociación, zona, momentum) dan el grueso del valor a costo ~0. El ML entra cuando la plataforma acumule pedidos.
- **Prometer estacionalidad/personalización ya:** rechazado — sin datos sería humo; se difiere con pipeline listo.

**Consecuencias:**
- ✅ Salto real de inteligencia con **datos que ya tenemos** (afinidad de canasta + demanda por zona), no promesas.
- ✅ "Completá la canasta" real ("pusiste Canels → agregá Mazapán", lift alto) + recomendaciones que cambian por zona.
- ✅ Una identidad (Thot) y un *feature store* del que leen take-order, portal, televenta y el futuro agente WhatsApp.
- ✅ El motor **mejora solo** con el uso (feedback loop reajusta pesos; el histórico per-tienda crece).
- ⚠️ Estacionalidad y propensión per-tienda quedan **dormidas** hasta tener 1 año / volumen de pedidos — explícito, no oculto.
- ⚠️ La afinidad del ERP es **ruta-level** (no per-tienda); es válida para "qué va con qué" pero la personalización fina llega con datos de plataforma.
- ⚠️ El feedback loop sin *frequency capping* degenera en spam — el capping es parte del MVP.
- 🔄 Reversible/aditivo: cada señal es un sub-score apagable; sin feature store, Thot cae al `margen × rotación` v1.

**Plan de implementación:** Detallado en [`FASES/FASE_THOT_MOTOR.md`](FASES/FASE_THOT_MOTOR.md). Rebanada 1 = **afinidad (market-basket) + zona-fit** en el score del take-order.

---

## ADR-020 — **Horus**: Supervisor AI de ejecución en campo (Trade)

**Estado:** ✅ Aceptado (2026-06-16)

**Fecha:** 2026-06-16

**Contexto:**
- El proyecto Trade es **auditoría de ejecución en PdV**: capturas de exhibiciones, scoring, cobertura de ruta, GPS. Hoy hay panel para supervisores (`/seguimiento`, `/routes`, `/commercial-map`, `/reports`) pero **el supervisor escanea todo a mano**; no hay diagnóstico, priorización ni alertas accionables automáticas.
- Un supervisor humano no escala tres tareas: revisar el **100% de las fotos**, correlacionar el **GPS de toda la flotilla**, y dar **coaching consistente y diario**. El usuario pide un AI que haga "tareas de un supervisor de ventas o hasta más".
- Ya existe infra AI reutilizable (Fase K): Claude Haiku 4.5 + visión ([LlmExtractorService](FASES/../../../libs/platform-core/src/lib/ai/llm-extractor.service.ts)), Voyage-3 + pgvector, throttling. Y un patrón de motor probado (Thot/ADR-016).
- **ADR-016/FASE_M (línea 217)** ya decidió **no compartir motor** entre Trade y Comercial: "más capturado" ≠ "más pedido". Mezclar el ranker de auditoría con el camino-de-dinero es acoplamiento prematuro.

**Decisión:**
1. **El supervisor AI se llama `Horus`** (el halcón egipcio, el ojo que todo lo vigila — supervisión/ejecución). Motor hermano de Thot, mismo panteón, **frontera de proyecto respetada**: vive en `libs/trade`, reusa solo las primitivas AI de `platform-core`, **no importa `commercial-intelligence`**.
2. **Hereda los invariantes de ADR-016:** el motor decide (determinista, explicable), el agente comunica (Claude redacta parte/coaching/conversa), **el LLM nunca toca el camino laboral crítico** (sancionar/reasignar/acusar de fraude = acción humana).
3. **Nivel de autonomía = co-piloto (decisión Edgar 2026-06-16):** el AI no solo recomienda, **prepara la acción concreta** (reasignar ruta, abrir alerta, enviar coaching, marcar para revisión) y la deja en `pending_approval`; el supervisor **aprueba/rechaza con un clic**. Reusa el patrón de estado `pending_approval` de ADR-013.
4. **Alcance = 3 capacidades:** (a) **parte diario** (motor de cobertura/score/idle/share + agente que redacta y prioriza), (b) **auditoría visual** (Claude vision audita el 100% de fotos vs concepto), (c) **detección de fraude/anomalías** (GPS↔tienda, tiempos imposibles, fotos recicladas). Visión y fraude producen *findings revisables*, no veredictos.
5. **Feature store propio** `trade.execution_360` (ejes collaborator/route/store), refresco nocturno + on-demand (patrón Customer360Refresh, `TenantKnexService.run` + scope sintético). El motor lee de ahí; el agente lo consume vía tools.
6. **Honestidad de datos como invariante** (igual que Thot): V1 se para en señales 🟢 (score, idle, foto); cobertura (`store_id` ~9% poblado), share (`perteneceMegaDulces` con `null`) y GPS quedan parciales y mejoran con la data. Foto reciclada usa **pHash (Cloudinary), no Voyage** (Voyage es texto).
7. **Build por rebanadas verticales** (Horus.0 feature store → .1 motor findings → .2 agente parte diario → .3 pantalla → .4 co-piloto → .5 visión → .6 fraude → .7 feedback).

**Alternativas consideradas:**
- **Compartir el motor Thot:** rechazado — viola ADR-016/FASE_M (unidades distintas, acoplamiento prematuro al camino-de-dinero).
- **Autónomo (AI ejecuta solo):** rechazado por riesgo laboral/operativo — reasignar o acusar sin humano es inaceptable; co-piloto da la velocidad sin el riesgo.
- **Solo recomienda (asistente puro):** descartado por el usuario — quiere que prepare la acción, no solo el diagnóstico.
- **LLM que calcula cobertura/score:** rechazado — debe ser determinista y auditable; el LLM solo redacta.

**Consecuencias:**
- ✅ Valor inmediato con datos 🟢 (parte diario) + tres capacidades que un humano no escala (visión 100%, GPS de flotilla, coaching diario).
- ✅ Reusa infra AI ya en prod beta (Haiku, visión, throttling); el costo nuevo es el feature store + reglas + pantalla.
- ✅ Co-piloto = velocidad con humano en el lazo; cero acciones laborales automáticas.
- ⚠️ La métrica estrella (cobertura) no es confiable hasta reforzar `store_id`; explícito, no oculto.
- ⚠️ La visión es el costo LLM real (1 llamada/foto) → encuadrar con muestreo/priorización; estimar volumen antes de Horus.5.
- 🔄 Aditivo y reversible: cada finding/acción es apagable; sin feature store no rompe Trade existente.

**Plan de implementación:** Detallado en [`FASES/FASE_HORUS_SUPERVISOR_AI.md`](FASES/FASE_HORUS_SUPERVISOR_AI.md).

---

## ADR-021 — **Aprendizaje de Horus**: motor que aprende, no LLM que decide (track Horus.L)

**Estado:** ✅ Aceptado (2026-06-17)

**Fecha:** 2026-06-17

**Contexto:**
- Horus (ADR-020) hoy es **100% heurístico/determinista**: pesos del score constantes a mano, reglas de findings/fraude/oportunidad fijas. El "feedback loop" existente (`reviewFinding`) solo **propaga** la decisión humana (descartar un hallazgo soft-borra su nota), **no aprende** de ella. El usuario pide que Horus "aprenda todo sobre Trade".
- Las **3 señales** que un lazo de aprendizaje necesita **ya se recolectan**: juicio del supervisor (`supervisor_findings.status` = confirmed/dismissed), acuse del campo (`coaching_notes.acknowledged_at`, `supervisor_tasks` status), y el **substrato histórico** (`execution_360_snapshots`, append-only diario — Batch 1). El lazo está **abierto**: nada se realimenta al motor.
- **Muro de datos (audit 2026-06-17), invariante:** `user_id`~100% (colaborador ✅), `store_id`~33% (tienda parcial), `route_id`~0% (ruta nula — no diseñar), `score_final_pct`/`hora_fin`/`nivelEjecucion` confiables, **ventas demo-only (1 vendedor/2 tiendas)**. No se diseñan reglas sobre data que no existe.

**Decisión:**
1. **El motor aprende, el LLM sigue fuera.** El aprendizaje ajusta **umbrales, supresión, pesos y prioridad** — todo numérico, auditable y **overridable por el humano**. Nunca decide sancionar/reasignar. Hereda ADR-016/ADR-020 (el motor decide, el agente comunica, el LLM fuera del camino laboral).
2. **Taxonomía de "aprender" en orden de dependencia y factibilidad:** **L0** memoria (snapshots, ✅ hecho) → **L1** baselines por sujeto (lo "normal") → **L2** auto-calibración (precisión de las propias reglas) → **L3** efectividad/atribución (¿la acción movió el resultado?) → **L4** pesos adaptativos por tenant → **L5/L6** predictivo/relacional (diferidos por el muro de datos).
3. **Ship the collector before the learner.** La mayoría del aprendizaje está gateada por **calendario**, no por código: L3/L4 no producen salida hasta acumular semanas de snapshots. Por eso primero se envían los colectores baratos (arrancar el reloj) y cada learner "prende" cuando su data madura. *Pushear el snapshot (Batch 1) a prod = arrancar el reloj.*
4. **Un solo hogar por tenant para lo aprendido** (tablas `execution_*` en `commercial.*`, patrón Horus: idempotentes, RLS forzado, FK `identity.tenants`, grant `app_runtime`, acceso vía `KNEX_CONNECTION` + tenant explícito). Los motores **leen** esos params y modulan; el panel L7 los hace visibles + ofrece override.
5. **Piso de observaciones en todo learner** (cold-start): por debajo del piso cae al default global y se etiqueta "aprendiendo". Aprender de 3 muestras es ruido.
6. **Honestidad del objetivo:** sin ventas reales, Horus aprende a optimizar **calidad de ejecución** (su mandato), **no** "qué dispara ventas". Explícito, no oculto.

**Alternativas consideradas:**
- **LLM que aprende/decide (fine-tune, agente autónomo):** rechazado — viola ADR-016; el aprendizaje debe ser determinista/auditable, no una caja negra en el camino laboral.
- **Saltar directo a ML (L4/L5):** rechazado — no hay volumen ni ventas; sería ajustar sobre ruido. Heurístico→estadístico→ML, gateado por data (ADR-018).
- **Atribución pre/post ingenua (L3 sin control):** rechazado — la regresión a la media sobre-acredita (accionás sobre el peor, rebota solo). L3 obliga a **diff-in-diff** contra un control.

**Consecuencias:**
- ✅ Primer "aprende" real factible **ya** = **L2** (Horus sabe cuáles de sus hallazgos sirven y suprime los ruidosos) — ataca la credibilidad del supervisor.
- ✅ Aditivo/reversible: cada param se recomputa; si la precisión se recupera, des-suprime; el humano siempre puede fijar (override).
- ⚠️ **Auto-bloqueo:** una regla suprimida deja de emitir → no genera nuevos juicios → precisión congelada; la salida es el override humano (diseño aceptado: una regla descartada >80% DEBE callar).
- ⚠️ L3/L4 **calendario-gated**: no producen valor hasta semanas/meses de snapshots; L4 pleno espera ventas reales.
- 🚫 L5/L6 **diferidos** hasta que caiga el muro de datos (store_id ≫33%, route_id ≫0%, venta real).

**Plan de implementación:** Track "Aprendizaje (Horus.L)" en [`FASES/FASE_HORUS_SUPERVISOR_AI.md`](FASES/FASE_HORUS_SUPERVISOR_AI.md). L2 = ✅ en código (2026-06-17).

---

## ADR-022 — Caducidad / lote / FEFO: sub-ledger de lotes **aditivo**, FEFO en el consumo, rollout por fases

**Estado:** 🟢 Aceptado (2026-06-18) — P2.0–P2.2b + P2.2d en código (ver [`FASES/FASE_FEFO_CADUCIDAD.md`](FASES/FASE_FEFO_CADUCIDAD.md)). Pivot clave: el invariante lo mantiene un **trigger** (no un helper por writer).

**Fecha:** 2026-06-18

**Contexto:**
- Mega Dulces es **distribuidora de dulces**: el producto **caduca**. Vender vencido = merma + riesgo regulatorio (alimentos MX). **FEFO** (First Expired First Out) es la práctica estándar y reduce merma **30–50%** (benchmark industria, gap-analysis Fase I.5).
- Modelo actual: `commercial.stock` por `(tenant, warehouse, product)` = **una cantidad por SKU/almacén, SIN lote ni caducidad**. Los pedidos reservan/consumen contra ese total (sin conciencia de lote). El conteo físico (Fase I) es por `(warehouse, product)`.
- **Dos mundos de stock** (ver análisis Fase I): `commercial.stock` (operacional, UUID — lo usan pedidos/portal/vendedor/analytics) + `inventory.warehouse_stock` (mundo Kepler por SKU, fuente del snapshot de conteo físico).
- **Incógnita bloqueante:** ¿el ERP Kepler / `productos_activos` provee **lote + fecha de caducidad**? Define si los lotes se **sincronizan** del ERP o se **capturan** en recepción. Pendiente inspeccionar el esquema (ver [[reference_erp_kepler_schema]] / productos_activos).
- Single dev; `commercial.stock` es **heavily-used** (order flow confirmado/verificado). Un big-bang rewrite es alto riesgo.

**Decisión (a validar):**
1. **Sub-ledger de lotes ADITIVO, no rewrite.** Nueva tabla `commercial.stock_lots`: `(tenant, warehouse, product, lot_code, expiry_date) → quantity, reserved_quantity`. `commercial.stock` **sigue siendo el total autoritativo**, con invariante `SUM(stock_lots.quantity) por (wh,product) = stock.quantity`. El order flow / conteo / portal existentes **no se reescriben**; FEFO se capa encima.
2. **FEFO en el CONSUMO (fase 1), no en la reserva.** Al `consume` (fulfill) se decrementan lotes por **caducidad ascendente** (el que vence primero, sale primero). La reserva sigue contra el total; la asignación de lote se resuelve al consumir. (Reserva-por-lote = fase posterior.)
3. **Caducidad como gate + alerta.** (a) Alertas de **próximos a vencer** (cron estilo low-stock) + dashboard; (b) gate opcional **bloquear venta/consumo de lotes vencidos** (configurable por tenant).
4. **Captura del lote dual-source:** si el ERP trae lote+caducidad → **sync** (importer); si no → **capturar** en `recordMovement('in')` (recepción) con `lot_code`+`expiry_date`. Diseñar para ambos; arrancar con captura + sync cuando se confirme el ERP.
5. **Mundo `inventory` (Kepler SKU) fuera de fase 1.** FEFO aplica a `commercial.stock` (lo operacional). Conteo físico por lote = fase posterior.
6. **Patrón del proyecto:** `stock_lots` con `tenant_id`, RLS forzado, FK compuesta, grant `app_runtime`, idempotente. Helper único que mantenga `stock` ↔ `stock_lots` en la misma trx.

**Alternativas consideradas:**
- **Caducidad ligera (solo fecha en `stock` + alertas, sin cantidad por lote):** rechazada como destino — no permite FEFO real (no sabés qué unidades son de qué lote) ni trazabilidad por lote (regulatorio). Sirve solo como stopgap; el sub-ledger la subsume.
- **Rewrite de `commercial.stock` a PK `(wh, product, lot)`:** rechazada — big-bang sobre el order flow heavily-used; rompe conteo/portal de golpe; alto riesgo para single-dev. El sub-ledger aditivo logra lo mismo incrementalmente.
- **Lote sin caducidad (solo trazabilidad):** insuficiente — el driver es la caducidad (FEFO), no solo el rastreo.

**Consecuencias:**
- ✅ Aditivo/reversible: order flow y Fase I siguen igual mientras se construyen los lotes; el invariante suma-lotes=total mantiene consistencia.
- ✅ Valor incremental: las **alertas de vencimiento** (P2.2) entregan el "no vender vencido" **antes** que el FEFO completo.
- ⚠️ **Doble escritura:** cada movimiento ahora mantiene `stock` Y `stock_lots` consistentes en la misma trx (mismo patrón que hoy `stock`↔ledger; mitigar con helper único, no escribir uno sin el otro).
- ⚠️ **Productos sin lote/caducidad** (no perecederos o sin dato): necesitan un lote `default/NA` para sostener el invariante. Diseñar el caso explícitamente.
- ⚠️ **Conteo físico vs lotes:** hasta el conteo-por-lote, reconciliar el total puede desbalancear lotes → regla de reconciliación (ajustar el lote que vence primero, o exigir desglose).
- 🚫 Diferidos: reserva-por-lote, conteo-por-lote, FEFO en el picking del vendedor/portal.

**Plan de implementación:** Fases P2.0–P2.5 en [`FASES/FASE_FEFO_CADUCIDAD.md`](FASES/FASE_FEFO_CADUCIDAD.md). **Gate de P2.0:** confirmar si el ERP provee lote+caducidad (define sync vs captura).

**Addendum 2026-06-18 (P2.1a — invariante por trigger):** se rechazó "helper único por writer" (punto 6) a favor de un **trigger** `AFTER UPDATE OF quantity ON commercial.stock` que rebalancea `stock_lots` para **todos** los writers — cero cambios al order flow. El lote `NA` (caducidad NULL) es el balanceador.

**Addendum 2026-06-18 (P2.2d — política de vencidos = WARN, no block):** sobre el punto 3(b), la decisión es **avisar, NO bloquear**. Bloquear exigiría excluir lo vencido del "disponible" dentro de `OrderStockService.reserve` — es decir, **meter el motor en el camino del dinero** (contra ADR-016). En su lugar: (1) el trigger FEFO consume **no-vencido primero** (toca vencido solo si no queda bueno) y (2) `OrdersService.fulfill` emite aviso `sold_expired` (severity `warn`) cuando un despacho se vio forzado a tomar lote vencido. Reversible a un block configurable-por-tenant si el negocio lo pide. Verificado: `database/scripts/verify-fefo-expired-last.js` + J.6.1 19/0.

---

## ADR-023 — **Autonomía acotada de Thot** (L3): el motor auto-ejecuta dentro de límites, el LLM sigue fuera del dinero

**Estado:** 🟢 Aceptado (2026-06-19) — motor de autonomía en código (`default OFF`); ver track Thot.

**Fecha:** 2026-06-19

**Contexto:**
- Thot llegó a paridad con Horus en razonamiento (T.R0 detección → T.R1 diagnóstico → T.R2 co-piloto con confianza/impacto-$ → T.R3 explicación → T.L2 calibración). Hasta acá Thot era **co-piloto** (ADR-016/020): propone, el humano aprueba **todo**.
- El usuario pide **más autoridad**: que Thot **decida y actúe** en los apartados donde su opinión ayuda, no solo sugiera.
- Riesgo: "autónomo sobre el dinero" sin bordes = caja negra decidiendo sobre precios/catálogo. ADR-016 lo prohibía explícitamente.

**Decisión:**
1. **Se cambia UNA parte de ADR-016 y se conserva la otra.** Cambia: "el humano aprueba todo" → el **motor determinista** puede **auto-ejecutar dentro de límites**. Se conserva: **el LLM sigue fuera del camino del dinero** (quien auto-decide es el motor determinista/auditable, no un modelo de lenguaje). El agente sigue solo comunicando.
2. **Autoridad GANADA, no en bloque.** Dial por `action_type` (`commercial.autonomy_policies`): `mode` (off/dry_run/auto) + `min_confidence` + `daily_cap` + `value_cap_mxn`. Una acción auto-ejecuta **solo si**: kill-switch global en `auto` **∧** su política en `auto` **∧** confianza ≥ `min_confidence` (la confianza la da **L2** → solo auto lo que la calibración probó que acierta) **∧** impacto ≤ `value_cap` **∧** bajo el `daily_cap`. Cualquier gate que falle → vuelve a co-piloto.
3. **Default OFF + kill-switch maestro.** Sin filas de política = todo co-piloto. Fila `__global__` = interruptor maestro. Shippear el motor **no cambia comportamiento** hasta que un humano flipee el dial.
4. **Reversible primero.** `push_product` auto-ejecuta creando un `push_directive` real (el recomendador lo consume → lazo cerrado, reversible). El resto (`review_price`/`review_delist`/`reorder_outreach`) solo escribe **nota interna**: el efecto sensible (cambio de precio/catálogo, envío al cliente) sigue **diferido** (ADR-020) → auto es seguro aun en consecuentes, porque lo irreversible no está cableado.
5. **Auditoría post-hoc + deshacer.** `commercial_actions.auto_executed` marca lo que Thot hizo solo → panel "Thot actuó solo" + base para revertir. `approved_by` queda null en auto.

**Alternativas consideradas:**
- **Autonomía plena (L4, decide y ejecuta sin límites):** rechazada — caja negra sobre el dinero; ningún gate de confianza/cap.
- **Quedarse en co-piloto (L1) solo ampliando alcance:** descartada por el usuario — quería autoridad real, no solo más presencia.
- **Autonomía por env-flag global on/off:** insuficiente — sin granularidad por tipo ni gate por confianza; o todo o nada.

**Consecuencias:**
- ✅ La autonomía se **gana con la calibración** (L2): mientras una regla no acumule precisión, su confianza (cold-start 0.6) no supera umbrales altos → no auto-ejecuta. El humano sube el umbral para exigir más evidencia.
- ✅ Reversible/auditable: `default OFF`, kill-switch, caps, panel de lo auto-hecho.
- ⚠️ Cuando se cablee un ejecutor **irreversible** (cambio de precio real, envío a cliente), los gates `value_cap`/`min_confidence` pasan a ser **críticos** y deben arrancar conservadores. Hoy son seguros porque el ejecutor de los consecuentes es diferido.
- ⚠️ Cron auto-ejecuta en cada corrida si el dial está en `auto` — el `daily_cap` acota el volumen.

**Plan de implementación:** track Thot (autonomy.service + commercial.autonomy_policies + runAutonomy). Smoke §10 (OFF no actúa / dial auto sí / gate de confianza). Rollout de apartados (toma de pedido, precios+promos, inventario, cartera+command center) encima de este motor.

---

## ADR-024 — Conteo zonificado: pasillos 2D + equipos (1 supervisor/pasillo, contadores proporcionales)

**Estado:** 🟢 Aceptado (2026-06-19) — diseño confirmado con el usuario; PA.0 en código. Plan en [`FASES/FASE_PASILLOS_EQUIPOS.md`](FASES/FASE_PASILLOS_EQUIPOS.md).

**Fecha:** 2026-06-19

**Contexto:**
- El conteo físico (Fase I) asigna una **lista plana** de contadores/supervisores por folio (`inventory_count_assignments`), sin noción de **dónde** cuenta cada quién.
- La práctica de cycle/physical counting zonifica el almacén (zona → líder → equipo) y **balancea el staffing por carga** para que el conteo cierre parejo.
- **No hay data espacial usable:** `catalog.products.location` = `Z000` en los 11,109 productos (el ERP no la trae). El concepto de pasillo hay que **crearlo y poblarlo a mano**.

**Decisión:**
1. **Pasillo como capa de LAYOUT permanente** (`commercial.warehouse_aisles`) con **posición 2D en grilla** (`grid_row/col` + `span`), reusable entre conteos. Mapeo SKU→pasillo en `commercial.stock.aisle_id` (grano `warehouse×product`).
2. **Asignación como capa de TABLERO por folio** (extender `inventory_count_assignments` con `aisle_id`): supervisor + contadores **por pasillo, por conteo** — el supervisor NO se hornea en el pasillo porque la gente cambia cada conteo.
3. **1 supervisor por pasillo**; si hay menos supervisores que pasillos → **clustering balanceado** (no bloquear).
4. **Equipos proporcionales a unidades físicas** (`Σ stock.quantity`), con la carga como **fórmula tuneable**.
5. **UI: editor 2D en grilla** (CSS grid, sin librería de mapas) + **asignación bulk** SKU→pasillo + **híbrido** (auto-generar proporcional + ajuste manual).
6. FK de `aisle_id` **de columna simple** a `warehouse_aisles.id` para permitir `ON DELETE SET NULL` (un FK compuesto con `tenant_id` NOT NULL no puede nullear). RLS sostiene el aislamiento.

**Alternativas consideradas:**
- **Lienzo libre 2D** (rectángulos arrastrables): más fiel a un plano real, mucha más UI — rechazado para MVP a favor de grilla.
- **Derivar pasillos del ERP (`location`):** imposible hoy (todo `Z000`); reactivar si el ERP puebla la ubicación real.
- **Proxy automático (ABC/marca/rango) como pasillo:** rechazado como modelo (no es espacial real); se reutiliza solo como **herramienta de asignación bulk** dentro del alta manual.
- **Hornear supervisor en el pasillo:** rechazado — la gente cambia por conteo; el supervisor es del folio.

**Consecuencias:**
- ✅ Aditivo: `aisle_id` nullable en stock/items/assignments; el order flow lo ignora; folios sin pasillos siguen como hoy (lista plana).
- ✅ Encaja con el folio cíclico (ABC): un folio acotado se particiona por pasillo igual.
- ⚠️ **El valor/riesgo está en el alta de data** (poblar pasillos + mapear 11k SKUs), no en el algoritmo (~50 líneas). La asignación bulk es obligatoria.
- ⚠️ Carga = unidades puede sobre-staffear pasillos de poco surtido y mucho volumen → tuneable.
- 🚫 Diferido: mundo `inventory.warehouse_stock`, lienzo libre, asignación por zona contigua avanzada.

**Plan:** Fases PA.0–PA.4 en [`FASES/FASE_PASILLOS_EQUIPOS.md`](FASES/FASE_PASILLOS_EQUIPOS.md).

**Addendum 2026-06-19 (reparto PAREJO, no proporcional):** sobre el punto 4 — el reparto de contadores es **parejo** (contadores ÷ pasillos, resto de a 1; equipos difieren máx. 1), NO proporcional-a-unidades. Se construyó el proporcional (PA.2) y luego se **eliminó** por decisión del usuario (simplicidad > optimización de carga). El generador vive en el tablero por folio (`generate-teams`). Reintroducir proporcional como `mode` si el negocio lo pide.

---

## ADR-025 — INEGI DENUE como fuente primaria de prospección de PdV

**Fecha:** 2026-06-24 · **Estado:** Aceptado

**Contexto:** El mapa comercial solo muestra PdV ya registrados. Para descubrir "tiendas de oportunidad" (PdV reales que aún no son clientes) hace falta una fuente externa de POIs. Opciones para México: Mapbox Search, Google Places, OSM/Overpass, **INEGI DENUE**.

**Decisión:** **DENUE como fuente primaria.** Razones: (1) mejor cobertura de tienditas mexicanas (directorio oficial con lat/lng + clase SCIAN), (2) gratis, (3) **dato abierto → almacenamiento permitido con atribución**, a diferencia de Mapbox/Google cuyos ToS prohíben persistir resultados. El dedup contra `stores` + `commercial.customers` se hace en **JS** (haversine + Dice bigrams) para no depender de extensiones Postgres (pg_trgm/earthdistance/PostGIS no garantizadas en prod).

**Alternativas:**
- Mapbox Search / Google Places — rechazadas como fuente persistente por ToS (no almacenamiento permanente).
- OSM/Overpass — viable como fuente **secundaria** para huecos de DENUE (diferido).

**Consecuencias:**
- ✅ Aditivo: capa conmutable en el mapa, cero impacto en el flujo existente.
- ✅ Cosecha infrecuente (DENUE se actualiza ~2×/año) + on-demand; dedup nocturno barato.
- ⚠️ El valor real está en el **dedup** (sin él, el mapa se llena de "oportunidades" que ya son clientes).
- ⚠️ Requiere `DENUE_TOKEN` (gratuito). Sin token, la capa funciona pero no cosecha.
- ⚠️ Clustering de marcadores pendiente (crítico al cosechar municipios completos).

**Plan:** [`FASES/FASE_DENUE_PROSPECCION.md`](FASES/FASE_DENUE_PROSPECCION.md).

---

## ADR-026 — **Thot Chat**: analítica conversacional por tool-use, no RAG sobre la DB

**Fecha:** 2026-06-30 · **Estado:** Aceptado

**Contexto:** Con la data de Kepler ya explotada (Fase KV: `analytics.sales_daily`, `product_sales_stats`, `inventory_health`, `erp_customers`, `customer_product_sales`, `erp_promotions`, márgenes) queremos que Thot conteste preguntas complejas de ventas en lenguaje natural. Tentación inicial: "volver la base un RAG". Se investigó cómo lo resuelven Uber (QueryGPT), LinkedIn (SQL Bot), Snowflake (Cortex Analyst), Databricks (Genie) y las guías de Anthropic.

**Decisión:** **Capa conversacional sobre el motor existente vía tool-use de Claude — NO RAG sobre las tablas de hechos.** El LLM orquesta tools deterministas (los métodos de `CommercialAnalyticsService` + `ThotService`, ya tenant-scoped) y narra; nunca calcula ni genera SQL. RAG se usa **solo** para resolución de entidades difusas (`resolve_entity`). Para el long-tail, una tool `flexible_aggregate` parametrizada (whitelist de métricas/dimensiones sobre `analytics.sales_daily`), sin SQL libre. Hereda ADR-016/018: el motor decide y calcula, el agente comunica, el LLM fuera del camino del dinero. Read-only en v1.

**Por qué NO RAG sobre datos:** embeddings no suman ni agregan — "¿cuánto vendí de Kinder en mayo?" es `SUM(...) WHERE`, no similitud. RAG sobre filas de hechos da números mal. Convergencia de toda la industria: capa semántica curada (no schema crudo) + RAG sobre metadata/ejemplos + evals. Snowflake/Databricks/LinkedIn lo confirman.

**Alternativas:**
- RAG sobre `sales_daily` (422k filas) — rechazada: incorrecta para agregación + cara de re-embeber + riesgo multi-tenant.
- Text-to-SQL libre (estilo Uber/LinkedIn) — diferida (TC.6): a escala beta los tools curados son más simples y seguros; `flexible_aggregate` cubre el hueco.

**Consecuencias:**
- ✅ Multi-tenant gratis (RLS por `TenantKnexService`), respuestas auditables (log de tool calls).
- ✅ Reusa infra existente (fetch Claude Haiku, `ANTHROPIC_API_KEY`); cero infra nueva.
- ✅ Números siempre correctos (salen del motor determinista).
- ⚠️ La precisión depende de la capa semántica (glosario ES) y de las evals golden-questions (gate de TC.1).

**Plan:** [`FASES/FASE_TC_THOT_CHAT.md`](FASES/FASE_TC_THOT_CHAT.md).

---

## ADR-027 — **Última milla** (entrega a domicilio local): orquestación, no módulo nuevo

**Fecha:** 2026-07-02 · **Estado:** Propuesto

**Contexto:** El SOP "Servicio de Entrega a Domicilio Local" de Mega Dulces describe una operación distinta al vendedor de ruta: el cliente pide por tel/WhatsApp/redes, un repartidor en moto entrega a su casa, cobra y liquida. Toca 3 dominios (pedido, entrega, dinero). Auditoría de código: la capa de entrega YA existe casi completa en `logistics.*` (`shipments` + `delivery_guides` + `guide_recipients` con POD, GPS vivo, ETA, checklists, fotos, costos, ROI); el pedido/stock/folios ya existen en `commercial.orders`; `commercial.payments` existe pero está **vacía y nunca usada** (cash-only, "deferred post-beta" desde Fase B).

**Decisión:** **No construir un módulo nuevo — orquestar los existentes.** El pedido a domicilio ES un `commercial.orders` con `delivery_type='home_delivery'`; la entrega ES un `logistics.delivery_guides`+`guide_recipients` (1 parada = 1 domicilio, la moto es un `logistics.vehicles`). Lo único genuinamente nuevo es **el dinero**: un `PaymentsService` sobre la tabla `payments` (extendida a multi-método) + un **corte de caja por repartidor-día** (`commercial.rider_liquidations`, con arqueo por denominación) distinto de la nómina de logística. Se quita el CHECK cash-only global (cierra la deuda de Fase B). Firma del cliente obligatoria en el POD (validación dura en backend). Incidencias tipificadas replicando el patrón de 6-outcomes de `commercial.call_logs`.

**Alternativas:**
- Módulo de delivery desde cero — rechazada: duplicaría guías/POD/GPS/ETA/costos que ya existen y están probados.
- Reusar el flujo de vendedor de ruta (preventa/autoventa) — rechazada: modela visita-a-tienda, no última-milla-a-domicilio (dirección ad-hoc, cliente casual, cobro+arqueo por repartidor).

**Consecuencias:**
- ✅ Reuso alto, riesgo bajo; el grueso del trabajo se concentra en Payments + intake + incidencias.
- ✅ `PaymentsService` (LM.1) es shippeable solo y habilita cobro en TODO el comercial, no solo domicilio.
- ✅ Hereda ADR-016/020: el estado decide, el cobro/liquidación/firma son actos humanos auditados; el LLM (OCR, sugerencias) nunca toca el camino del dinero.
- ⚠️ Quitar cash-only toca `orders`/`payments` a nivel global de la plataforma (era restricción beta intencional) — requiere confirmación de negocio.
- ⚠️ Cliente casual puede ensuciar analytics/Thot → flag `is_casual` + exclusión de MVs de cartera.
- ⚠️ Satisfacción del cliente (KPI SOP ≥95%) sin fuente de datos → diferido (encuesta post-entrega, posible Fase F).

**Plan:** [`FASES/FASE_LM_ULTIMA_MILLA.md`](FASES/FASE_LM_ULTIMA_MILLA.md).

---

## ADR-028 — **Maat**: AI de Finanzas (conocimiento + chat + patrones), sin fine-tuning

**Fecha:** 2026-07-06 · **Estado:** Aceptado (OK de Edgar 2026-07-06, incluye postura de privacidad igual a Thot/OCR)

**Contexto:** Pedido de Edgar: "una AI entrenada con toda la información de finanzas, con chat, que vaya aprendiendo cómo funciona para encontrar patrones buenos y malos". La Fase GX ya construyó la base de datos financiera (expense_entries/documents/lines, ap_provider, findings v1 con $26M+ en anomalías detectadas a mano) y el modelo contable Kepler está descifrado y documentado en `KEPLER_CONTABILIDAD_MODELO.md`.

**Decisión:** **NO fine-tunear un LLM** (caro, alucina cifras, inauditable, congela el conocimiento). "Entrenamiento" = 4 mecanismos auditables: (1) conocimiento curado (`finance.knowledge`, seed del modelo contable descifrado), (2) acceso total en vivo vía tools parametrizadas read-only (patrón Thot Chat/ADR-026 — cero números del LLM), (3) motor de patrones determinista (~14 detectores estadísticos → `finance.findings` con evidencia reproducible; clases riesgo/error_captura/oportunidad), (4) feedback loop con taxonomía Horus (ADR-021): L0 memorias validadas → L1 baselines nocturnos → L2 auto-supresión de reglas ruidosas por precisión. Colector de feedback shipea antes que el learner. Vive en **`libs/finance`** (nueva lib, frontera limpia — no importa de commercial ni trade), endpoints `/finance/maat/*`. Hereda ADR-016: el motor detecta, el agente explica, el LLM fuera del camino del dinero.

**Alternativas:**
- Fine-tuning / RAG sobre dumps contables — rechazada: números alucinados e historial congelado; en finanzas es descalificante.
- Extender Thot con tools financieras — rechazada: Finanzas y Ventas son proyectos separados (decisión previa de Edgar); dominios, permisos y usuarios distintos.

**Consecuencias:**
- ✅ Números siempre correctos (salen de SQL determinista); cada respuesta trae su evidencia (tool calls logueadas en `finance.chat_messages`).
- ✅ Reusa infra probada: patrón chat TC, learning Horus L, feeds GX, `ANTHROPIC_API_KEY` Fase K.
- ✅ El conocimiento crece sin deploys (tabla knowledge + umbrales en `rule_registry.params`).
- ⚠️ Filas financieras viajan a la API de Anthropic en cada turno de chat (misma postura que Thot/OCR ya en prod) — requiere OK explícito de negocio.
- ⚠️ Requiere 2 feeds nuevos: balanza completa `analytics.ledger_monthly` (familias 1-9) + cadena de aprovisionamiento `analytics.expense_doc_chain` (lineage kdm1 c39 descifrado 2026-07-06; absorbe GX.4.3b).

**Plan:** [`FASES/FASE_MAAT_FINANZAS_AI.md`](FASES/FASE_MAAT_FINANZAS_AI.md).

---

## ADR-029 — **Supervisor de Movimientos** (cuadre / reconciliación caja-inventario)

**Fecha:** 2026-07-07 · **Estado:** Aceptado (OK de Edgar 2026-07-07)

**Contexto:** Pedido de Edgar: "un supervisor que analice los movimientos de cajas (ventas de tienda), movimientos de CEDIS, etc., y que todo cuadre en base al inventario". El almacén ya es maduro en operación (conteo físico, IRA, ABC, FEFO) pero todo es **descriptivo/reactivo** — no hay un motor que cruce las identidades de cuadre y detecte descuadres (merma, robo, error de captura, faltantes de caja). Hallazgo clave 2026-07-07: el **arqueo de caja de tienda SÍ existe** en Kepler `md.kdpv_folio_caja` (esperado/contado/diferencia ya calculados) y el **kardex transaccional** en `md.kdij` — ambos habilitan cuadre a nivel transacción, no solo agregado.

**Decisión:** Motor determinista de reconciliación en 3 planos — **inventario** (Σ movimientos = Δ existencia vs conteo), **caja** (esperado vs arqueo por caja/cajero), **cruce** (venta↔inventario↔caja) — que escribe descuadres a `reconciliation.discrepancies` con evidencia + dedup_key, bandeja HITL (confirmar + asignar causa) y aprendizaje L2 (precisión por regla → auto-supresión). Vive en **`libs/reconciliation`** (nueva lib, frontera limpia). Hereda ADR-016/028: el motor calcula el cuadre, el humano confirma la causa, el LLM fuera del cálculo. Reusa andamiaje de Maat.2 (detector + findings + scanner + cron + L2) y `FINANCE_NOTIFIER_PORT` para alertas críticas.

**Alternativas:**
- Capturar arqueo de tienda desde cero — rechazada: ya existe en `kdpv_folio_caja`, es un importer más.
- Neo4j / grafo — rechazada: el cuadre es estadístico/series de tiempo, no de redes.
- Meterlo en `libs/commercial` — evaluado; lib propia por ser supervisor cross-cutting (hermano de Maat/Horus).

**Consecuencias:**
- ✅ 2 de 3 planos construibles YA sin captura nueva (caja de `kdpv_folio_caja`, inventario de `kdij`+conteos).
- ✅ Señal de prevención de pérdida inmediata (md_02: 90 cortes con descuadre ≥$50, faltante de $10k detectado).
- ✅ Reusa patrón Maat.2 completo (motor/bandeja/HITL/L2/cron).
- ⚠️ Bug `kdil.c4=0` → existencia teórica del kardex; conteo físico = verdad periódica.
- ⚠️ Feeds corren on-prem (LAN Kepler); umbral de caja para no ahogarse en centavos.

**Plan:** [`FASES/FASE_SM_SUPERVISOR_MOVIMIENTOS.md`](FASES/FASE_SM_SUPERVISOR_MOVIMIENTOS.md).

---

## ADR-030 — **Compras / Reabastecimiento** (punto de reorden · existencia crítica · sugerido de compra)

**Fecha:** 2026-07-08 · **Estado:** Aceptado (OK de Edgar 2026-07-08) · **Implementado (local)**

**Contexto:** La plataforma no sabía cuándo ni cuánto pedir — el low-stock era un umbral hardcodeado (10/50/20). Mega Dulces YA opera el reabastecimiento en Kepler (reporte "Existencia Crítica" → orden de compra sugerida). Decode verificado 2026-07-08 contra el form `invcatprdpag.kpl` + datos vivos: `kdii.c33`=mínimo, `c34`=punto de reorden, `c35`=máximo (piezas, NO precios; la doc del repo estaba mal → corregida). Cobertura por sucursal 0–18% (CEDIS=0), unidad = piezas, Kepler sin lead time.

**Decisión:** Portar el reabastecimiento como **proyecto propio "Compras"** (no una página en Almacén). Motor determinista (aritmética auditable), humano aprueba la requisición, LLM fuera del dinero (hereda ADR-016). Tabla dedicada `commercial.reorder_policy` (grano producto×almacén, `source` kepler/computed/manual — el `manual` nunca lo pisa el importer). Kepler manda donde existe; el cómputo por demanda (`analytics.inventory_health`) cubre el ~82% restante. `sugerido = max(0, objetivo − existencia − en_tránsito)`, objetivo configurable (min/reorder/max). Requisiciones = HITL sobre tablas propias (`purchase_requisitions`), **nunca write-back a Kepler** (diferido). El importer reusa el mismo `STOCK_BRANCH_MAP` que el stock → reorden y existencia en el mismo almacén.

**Alternativas:**
- Columnas de reorden en `commercial.stock` — rechazada: mezcla config lenta con saldo caliente; tabla dedicada trackea `source`/lead_time/auditoría.
- UI en `/almacen` — rechazada por Edgar: Compras es proyecto de primer nivel (semilla del futuro módulo de Compras: recepción/CxP).
- Usar `commerce_signals` para la señal de reorden — descartada: esa tabla exige `customer_id` (es CRM); el reorden se surface por reporte + finding.

**Consecuencias:**
- ✅ Umbrales reales del negocio reemplazan el hardcode; existencia crítica + sugerido operativos.
- ✅ CEDIS (compra central) sin config Kepler → el cómputo (RA.3) es crítico, no opcional.
- ⚠️ Naming de almacenes mixto (KEPLER-0X/MD-XX) → el importer reusa `STOCK_BRANCH_MAP`, no hardcodea.
- ⚠️ Bug `kdil.c4=0` afecta la existencia de ~2–10% de SKUs (ya `GREATEST(...,0)` en stock).
- ⏸️ Diferido: OC a recibir (RA.5), cron nightly + hallazgos + alertas (RA.8), write-back a Kepler.

**Plan:** [`FASES/FASE_RA_REABASTECIMIENTO.md`](FASES/FASE_RA_REABASTECIMIENTO.md).

---

## ADR-031 — **Cadena de compra real** (RA.15): Requisición → Orden de Compra → Orden de Entrada (la OE mueve stock)

**Fecha:** 2026-07-10 · **Estado:** Aceptado (OK de Edgar 2026-07-10) · **Implementado (local)** · Extiende ADR-030.

**Contexto:** El flujo de compras aplastaba toda la cadena en flags de estado sobre una sola tabla (`purchase_requisitions.estado`: approved→ordered→received) — "cada paso sólo cambiaba un botón". Re-verificación contra Kepler vivo (`md_03`, 2026-07-10) confirmó que la compra son **documentos distintos** con folio/fecha/líneas/costo propios: `X-A-30` requisición (opcional; 504/781 OCs nacen directas) → `X-A-35` OC → `X-A-37` vale → `X-A-40` orden de entrada (**única que toca el kardex `kdij`**) → `X-A-20` aplica/CxP. La mercancía entra al inventario **sólo en la orden de entrada**.

**Decisión:** Modelar los 2 eslabones con valor operativo propio, sobre tablas nuevas en `commercial.*` (nunca write-back a Kepler): **OC** (`purchase_orders` + `_lines`, folio `OC-YYYY-NNNNN`, lo que se manda al proveedor, estado `open→partial→received`) y **OE** (`goods_receipts` + `_lines`, folio `OE-YYYY-NNNNN`, recepción que admite **parciales** — varias OE contra una OC — con costo real por línea). La requisición (RQ) sigue siendo la necesidad + aprobación HITL (nuestro valor; Kepler ni la exige). Al aprobar se genera la OC (RQ→ordered); al completar la recepción, RQ→received (traza). **La OE mueve `commercial.stock`** vía un movimiento `in` (mismo contrato que `CommercialInventoryService`, lock pesimista) al almacén destino; traspaso (branch) además descuenta el origen best-effort (clamp a disponible).

**Reconciliación (clave):** el feed de stock de Kepler es un **snapshot absoluto** (`ON CONFLICT DO UPDATE SET quantity=EXCLUDED.quantity`, nightly). La OE es un **overlay optimista**: sube existencia al instante para visibilidad; el snapshot nocturno re-sincroniza a la verdad de Kepler (que ya trae su `X-A-40` porque MD captura la cadena "de golpe"). Auto-sanante, sin doble-conteo permanente → Kepler = verdad del inventario, nosotros = planeación + recepción.

**Alternativas:**
- OC/OE sin mover stock (sólo trazar) — rechazada por Edgar: quería el movimiento real.
- Reservar `commercial.stock` como WMS autoritativo (feed aditivo, no snapshot) — rechazada: rompe la simplicidad del feed y duplica la verdad; Kepler ya es el WMS.
- Seguir con flags sobre `purchase_requisitions` — rechazada: es el problema que originó el ADR (poco valor por paso).

**Consecuencias:**
- ✅ Cada paso es un documento con datos propios (folio, costo real, parciales, fill rate real por línea).
- ✅ Recepción visible al instante en existencia; se auto-reconcilia con Kepler cada noche.
- ⚠️ Ventana intra-día de posible sobre-conteo si Kepler ya procesó el `X-A-40` el mismo día → se corrige en el snapshot nocturno (aceptado para herramienta de planeación).
- ⚠️ Traspaso (género `N`) es cadena distinta en Kepler; MVP mueve +destino/−origen en nuestras tablas sin espejar `N-D-6`/`N-A-6` documento-a-documento (diferido).
- ⏸️ Diferido: `X-A-37` vale + `X-A-20` CxP (PaymentsService, Fase LM); auto-received por matching heurístico contra `X-A-40` de Kepler.

**Plan:** [`FASES/FASE_RA_REABASTECIMIENTO.md`](FASES/FASE_RA_REABASTECIMIENTO.md) §RA.15.

---

## ADR-031 — Wincaja (POS Access 97): landing schema separado `wincaja.*` + crosswalk, NO merge

**Fecha:** 2026-07-13 · **Estado:** Aceptado (OK de Edgar 2026-07-13) · **En curso (Fase W)** · Hereda ADR-010 (multi-tenant) y el patrón landing/reconciliación de ADR-029 (SM).

**Contexto:** Sucursales de Mega Dulces corren un POS distinto a Kepler: **Wincaja**, en **Access 97 (Jet 3.5)**, un `.mdb` por sucursal. Copias "Concentrada" viven en `.245` en `D:\Salidas\Bases\Concentradas` (accesibles desde el hub como `Z:\...`). 70 tablas con nombres limpios en español (`Articulos`, `Clientes`, `MovimientoClientes`, `MaestroMovAlmacen`/`DetallesMovAlmacen`, `PagosDia`, `Arqueos`, …) — esquema totalmente distinto al ofuscado `kd**/cN` de Kepler → **son dos software distintos**, no dos vistas del mismo.

Feasibilidad verificada (2026-07-13): ACE 12/16 rechazan el formato 97 ("base creada con versión anterior"); **`Microsoft.Jet.OLEDB.4.0` en proceso 32-bit** (`C:\Windows\SysWOW64\WindowsPowerShell`) abre los 4 `.mdb` reales read-only sin instalar nada. Sucursales: `10 PHIDALGO`, `30 MORELIA ABASTOS`, `32 MORELIA MADERO`, `50 CANINDO` (las de 2 MB son stubs inactivos).

**Hecho decisivo:** son las **mismas sucursales físicas** que Kepler (`10 PHIDALGO`=`md_01`=`MD-10`="Padre Hidalgo"), pero con **relación asimétrica**: Kepler es el sistema primario y Wincaja queda atrás **excepto `30 MORELIA ABASTOS` y `50 CANINDO`, que HOY siguen operando en Wincaja** (movimientos hasta 30/06/2026; `10 PHIDALGO` congelada en 31/05/2026 = ya migró a Kepler). O sea: para 30/50 Wincaja es la **fuente viva y única** — esas sucursales hoy están **ciegas** en la plataforma (no aparecen en Command Center/Maat/RA porque Kepler no las ve).

**Decisión:** Ingerir Wincaja a un **landing schema separado `wincaja.*`** (espejo 1:1 de las tablas relevantes, cada fila con `tenant_id` + `source_branch` + `imported_at`, RLS forzado, grants `app_runtime`). **Nunca** mezclar en `commercial.*`/`analytics.*` (Kepler) → cada fuente es dueña de sus filas → cero conflicto de duplicidad. Recarga **full por sucursal** (DELETE+INSERT en trx; los `.mdb` son snapshots mensuales "Concentrada", no incrementales) → idempotente por construcción sin depender de PKs naturales perfectas.

Relacionar = **capa de mapeo, no fusión física**: tabla `wincaja.branches` (crosswalk `source_branch` ↔ `kepler_code` ↔ `warehouse_code` + `status`) + crosswalk de artículo/cliente por `CodigoBarras`/`RFC`/código. Sobre eso:
- **30/50 (vivas en Wincaja):** un "bridge" alimenta las tablas canónicas que consume la plataforma → esas sucursales dejan de estar ciegas. NO hay duplicación (Kepler no las tiene).
- **10/32 (ya en Kepler):** import histórico/legacy; el solapamiento se vuelve **conciliación de fuentes** (¿cuadra Wincaja vs Kepler?), materia prima para SM (ADR-029) y Maat (ADR-028).

Extracción en **2 etapas** (desacopla la dependencia Jet del load PG): (A) PowerShell 32-bit Jet 4.0 → dump JSONL por tabla; (B) loader Node → UPSERT a `postgres_platform` (mismo patrón que `database/importers/`). Corre en `.245` (disco local, sin leer el `.mdb` vivo sobre SMB).

**Alternativas:**
- Merge en tablas Kepler (`commercial.*`) — rechazada: corrompe la verdad, imposible saber qué fuente escribió cada fila.
- Modelo canónico único con columna `source` ahora — rechazada: prematuro, todavía no está probado que "existencia" signifique lo mismo en ambos sistemas.
- `node-adodb` in-process — evitado: frágil (spawnea cscript 32-bit igual); el dump PS 32-bit ya está probado y deja artefacto auditable.

**Consecuencias:**
- ✅ 30/50 se vuelven visibles en la plataforma sin tocar Kepler.
- ✅ Lineage limpio; el solapamiento 10/32 es feature (cuadre), no bug.
- ⚠️ Cadencia: las "Concentrada" parecen refrescar mensual y van ~2 semanas atrás (max 30/06 al 13/07). Confirmar si hay un `.mdb` "Actual" más fresco para el importer permanente de 30/50.
- ⚠️ `PagosDia.Hora` es time-only (epoch 1899) → la fecha se resuelve por join a `Cortes`, no directo.
- ⏸️ Diferido: bridge a canónico para 30/50; conciliación Wincaja↔Kepler para 10/32; write-back Kepler (nunca).

**Plan:** [`FASES/FASE_W_WINCAJA.md`](FASES/FASE_W_WINCAJA.md).

---

## ADR-033 — **Conciliación bancaria** (Fase CB): reemplazar el workbook Excel por interfaz + catálogo limpio

**Fecha:** 2026-07-22 · **Estado:** Aceptado (OK de Edgar 2026-07-22) · Hereda ADR-010 (multi-tenant), ADR-028 (Maat: motor decide / hallazgos) y el patrón de conciliación de ADR-029 (SM).

**Contexto:** Finanzas concilia los bancos en un **workbook Excel manual** ("CUENTAS LUIS FRANCISCO"): **19 cuentas de banco + CAJA GENERAL + FACTORAJE**, ~**4,865 movimientos/mes** clasificados a mano con dos códigos por línea — `M` (tipo: I/G/C/TE/TI/CF/PF/DS/ID) y `C` (cuenta: 102/510/612/613/610/147…) — y una hoja CONCENTRADO que auto-suma por banco y calcula saldos + diferencias (factoraje, DEV SPEI). Verificado 2026-07-22 contra enero 2026: mi parse cuadra al peso con el CONCENTRADO (Compra $43,534,807 · Gasto $6,584,511 · Ingresos $52.95M · TI=TE $25.4M).

**Hallazgo decisivo:** los códigos `C` del Excel están **sobrecargados** — `612` mezcla SUA/IMSS ($1.05M) + comisión bancaria + pago de capital + arrendamiento + traslado de valores; `613` mezcla caja de ahorro + compra de vehículo + pagos a personas; hay `$1.6M` en `(vacío)` y códigos-typo (`/`, `50`, `i`). Además **no empatan con Kepler** (`612`=ROBO en `kdco`, `147` no existe, `510` vs `511`). → el Excel no es auditable ni conciliable de forma determinista.

**Decisión:**
1. **Interfaz en el proyecto Finanzas (`/finanzas/bancos`)** que reemplaza el Excel: subir estado de cuenta → clasificar con catálogo controlado → conciliar contra Kepler → bandeja de diferencias.
2. **Catálogo LIMPIO** (`finance.movement_categories`, 18 categorías) **alineado a cuentas Kepler** (comisión→`611-003`, IVA→`122`, compra→`511`, nómina→`601`, …), NO los códigos del Excel. El importer traduce `(código Excel + patrón de concepto)` → categoría limpia; lo ambiguo cae en `sin_clasificar` para resolver en la UI. (Decisión de Edgar: rediseñar, no migrar tal cual.)
3. **Ingesta por subida del XLSX** actual (parser exceljs) en F1; evoluciona a parser de estado de cuenta por banco después.
4. Schema `finance.bank_*` (RLS forzado, patrón A.0mt): `bank_accounts`, `movement_categories`, `bank_statements`, `bank_movements`, `bank_recon_matches`. UPSERT por `client_uuid` (no DELETE, regla de red Railway).
5. **Motor de conciliación determinista** (ADR-016/028): cruza banco ↔ posting Kepler por fecha+monto+contraparte (reusa patrón `expense_doc_chain`); las diferencias se vuelven hallazgos Maat (`finance.findings`, clase conciliación). El LLM fuera del cuadre.

**Alternativas:**
- Migrar los códigos del Excel tal cual — rechazada: perpetúa la ambigüedad y no concilia con Kepler.
- Seguir en Excel con macros — rechazada: no multiusuario, no auditable, no integrable con Maat.

**Consecuencias:**
- ✅ Cero doble tecleo, catálogo controlado (mata el `$1.6M` sin clasificar y los typos).
- ✅ Conciliación banco↔libro determinista + diferencias como hallazgos.
- ✅ La interfaz da el detalle por banco que Kepler colapsa en el `102` único.
- ⚠️ El equipo cambia de hábito (códigos nuevos) — mitigado con mapeo automático en el import.
- ⚠️ `kepler_link` por banco (mapear el 102 consolidado a cada cuenta) queda para F4 (el banco en Kepler vive en `c7` texto libre).

**Plan:** [`FASES/FASE_CB_CONCILIACION_BANCARIA.md`](FASES/FASE_CB_CONCILIACION_BANCARIA.md).

---

## ADR-034 — **Comercio conversacional por WhatsApp** (Fase F): el bot arma, el humano confirma, el pedido cae en la cadena de Reparto ya construida

**Fecha:** 2026-07-24 · **Estado:** Aceptado (decisiones de Edgar 2026-07-24) · Hereda ADR-006 (Meta Cloud API), ADR-007 (Claude Haiku tool-use), ADR-016 (motor decide / LLM fuera del dinero) y ADR-027 (última milla = orquestación).

**Contexto:** Los clientes deben poder pedir por WhatsApp con un chat conversacional y que esos pedidos se conviertan en **repartos** a domicilio. La "mitad de atrás" **ya existe y está en beta**: `CommercialHomeDeliveryService.createIntake()` recibe un pedido (cliente de cartera o **casual** dedupe por teléfono) con `delivery_channel='whatsapp'` y lo arma vía `createDraft → replaceLines → place`; de ahí `/reparto/asignar` lo despacha a un repartidor (rol `repartidor`), que cobra contra-entrega (COD, firma + geocerca) y liquida (`rider_liquidations`). Lo único que falta es la **capa conversacional de entrada**.

**Decisión:**
1. **Canal:** Meta WhatsApp Cloud API directo detrás de un puerto abstracto `WhatsAppPort` (ADR-006). Adaptador Meta + adaptador simulador para desarrollo/pruebas sin BSP.
2. **Nivel de autonomía = "bot arma / humano confirma"** (elección de Edgar). El bot entiende el pedido por lenguaje natural, resuelve productos y arma el carrito, captura domicilio, y crea la orden en estado **`pending_approval`** (ADR-013 ya lo soporta). El pedido cae en una **bandeja de revisión** (`/reparto/pedidos-whatsapp`, patrón televenta): un operador la revisa, la confirma (dispara `place`/reserva de stock) y de ahí sigue el flujo normal de `/reparto/asignar`. **El bot nunca confirma ni cobra solo** en el piloto.
3. **El LLM fuera del camino del dinero (ADR-016):** Claude Haiku orquesta la conversación por tool-use (`buscar_producto`, `agregar_al_carrito`, `capturar_domicilio`, `confirmar`), pero **producto→SKU→precio→total los calcula el motor determinista** (catalog-search + Match-AI Fase K + pricing). El LLM no inventa precios.
4. **Infra:** sumar **Redis + BullMQ** (elección de Edgar) para colas `whatsapp-in`/`whatsapp-out` (idempotencia por `message_id`, reintentos, absorbe picos). Desbloquea también G (event bus), H (idempotencia fintech), I (WS scaling). Degradación grácil: sin `REDIS_URL` procesa in-process (mismo patrón que `CacheModule`).
5. **Estado de conversación:** tabla `whatsapp.conversation_threads` (o `commercial.*`) por número de teléfono, con carrito en curso + estado del diálogo + `handoff` a operador cuando el bot no entiende.
6. **Reuso máximo, módulo nuevo mínimo:** `libs/whatsapp` solo contiene canal + orquestador + hilos + bandeja. Clientes, catálogo, pedido, reparto, cobro y liquidación se reusan tal cual.

**Alternativas:**
- Bot 100% autónomo que cierra y cobra solo — **diferido**: más riesgo para el piloto; la bandeja humana es el freno de seguridad. Se puede subir la autonomía por monto/cliente después (híbrido) sin rehacer nada.
- BSP con UI (Wati/Twilio) — rechazada (ADR-006): markup por mensaje + menos control.
- RAG sobre catálogo para el bot — innecesario: catalog-search + Match-AI ya resuelven producto por nombre mejor y de forma determinista (mismo criterio que ADR-026).

**Consecuencias:**
- ✅ Time-to-value bajo: la cadena pedido→reparto ya está; el trabajo se concentra en canal + conversación + bandeja.
- ✅ Aislamiento de vendor (puerto) + degradación sin Redis + simulador → se construye y prueba sin depender de trámites de Meta.
- ✅ Freno humano en el piloto; sube a autónomo cuando haya confianza.
- ⚠️ Requisitos operativos de Meta (app verificada, número, plantillas 24h) son bloqueantes para producción real (no para desarrollo con simulador).
- ⚠️ `createIntake` hoy hace `place` y deja `confirmed`; hay que dejarlo en `pending_approval` cuando el origen es el bot (cambio pequeño y localizado, F.3).

**Plan:** [`FASES/FASE_F_WHATSAPP_BOT.md`](FASES/FASE_F_WHATSAPP_BOT.md).

---

## ADR-035 — **Bot WhatsApp avanzado** (Fase FIQ): model-tiering + candados de canal público, el motor sigue poniendo los números

**Fecha:** 2026-07-27 · **Estado:** Aceptado · Implementado (local) · Hereda ADR-007 (Claude tool-use), ADR-016 (motor decide dinero) y ADR-034 (bot arma / humano confirma).

**Decisión:** subir la inteligencia del bot SIN mover el dinero al LLM. (1) **Model-tiering** Haiku→Sonnet por heurística barata (mensaje largo, hilo extenso, ambigüedad/comparación/negociación/mayoreo/factura) — Haiku conduce el grueso, Sonnet los turnos difíciles. (2) **Auditoría por turno** `whatsapp.bot_chat_log` (modelo/tools/iteraciones/latencia + feedback ±1) = observabilidad + fuente del throttle + futura few-shot. (3) **Throttle/budget-guard** (`WHATSAPP_DAILY_TURN_CAP`, def 50 turnos/24h por teléfono → handoff + template, sin LLM): un canal público sin techo es vector de gasto/DoS. (4) **Opt-out (BAJA/STOP) antes del orquestador** (ya existía, ADR-034/F.8): compliance Meta = ban si se ignora. El loop vive en `libs/whatsapp`; los datos entran por `COMMERCE_CONVERSATION_PORT` (sin acoplar a commercial). Las tools de mercado (FIQ.8: `top_productos`/`tendencias_mercado`, prueba social sobre demanda real, tenant explícito) heredan este ADR.

**Consecuencias:** ✅ mejores respuestas donde pagan + techo de costo/abuso + trazabilidad. ⚠️ `claude-sonnet-5` debe existir para la cuenta (configurable `WHATSAPP_SONNET_MODEL`; si falla, el turno degrada a handoff). Diferido: few-shot por similitud, captura de 👍/👎, extended thinking.

---

## ADR-036 — **Identidad del contacto por E.164 canónico** (Fase FIQ, raíz del 10x)

**Fecha:** 2026-07-27 · **Estado:** Aceptado · Implementado (local) · Hereda ADR-010 (multi-tenant).

**Decisión:** resolver `customer_id` por teléfono NORMALIZADO (`52XXXXXXXXXX`) contra `customers.whatsapp` (índice funcional `mx_normalize_phone`), no por `phone` legacy ni match exacto. Un solo formato en todo el pipeline (inbound `521…`, envío `52…`, storage `+52…`) vía util compartido `mx-phone` + fn SQL espejo. Enrutamiento inbound multi-tenant por `whatsapp.phone_number_tenant_map` (deprecar `WHATSAPP_TENANT_ID` hardcodeado). Es la **palanca raíz**: sin esto, mayoreo/historial/trust/personalización/reorden quedan vacíos en silencio → el backfill+normalización de `customers.whatsapp` es definición-de-done, no pendiente.

**Consecuencias:** ✅ desbloquea FIQ.3/4/7/10 de golpe; casual reconocido la próxima. ⚠️ cobertura del backfill de `whatsapp` es la métrica crítica.

---

## ADR-037 — **Trust-score determinista + gate** (Fase FIQ): el motor decide, el LLM comunica y nunca acusa

**Fecha:** 2026-07-27 · **Estado:** Aceptado · Implementado (local) · Hereda ADR-016 y ADR-020/021 (Horus: motor decide / feedback L2).

**Decisión:** detectar contactos que "solo juegan" (charlan y nunca compran) o "no reciben pedidos" (no-show/rechazo real) con un motor **CERO LLM** (`ContactTrustEngineService`) que agrega señales reales por teléfono (cancelaciones, entregas fallidas, conversaciones-sin-pedido, apartados vencidos, deuda) → tier `neutral/allow/require_deposit/block` con umbrales por tenant (`commercial.trust_thresholds`) + guard `min_observations` (cold-start neutro, no penaliza nuevos). El gate vive en `confirmar_pedido`: `block`→handoff humano, `require_deposit`→pedir anticipo/transferencia. El LLM comunica con calidez y **NUNCA** revela el score, acusa, ni menciona historial. `require_deposit` **NO es cobro online** (no hay pasarela; Fase H diferida; orders cash-only por CHECK): se resuelve como transferencia verificada por humano o handoff; el gate no toca el CHECK cash-only.

**Consecuencias:** ✅ filtra abuso sin bloquear clientes buenos ni nuevos; auditable/overridable (feature store `commercial.contact_trust_features`). ⚠️ emisión a `commercial.commercial_findings` (bandeja ops) diferida para no chocar el resolve-stale del cron de customer_360 (usar `source` distinto).

---

## ADR-038 — **Apartado con TTL** (Fase FIQ): reserva temporal de stock, el motor reserva y un cron libera

**Fecha:** 2026-07-27 · **Estado:** Aceptado · Implementado (local) · Hereda ADR-016 y clona el patrón `lead_reservations` (Fase E).

**Decisión:** "apártame esto" = reserva de stock con TTL, anclada al teléfono (aun sin `customer_id`). `commercial.stock_reservations`/`_lines` + folio `AP-YYYY-NNNNN` (`reservation_sequences`). El apartado **incrementa `reserved_quantity`** reusando `OrderStockService.reserve` (con `referenceType='reservation'` + guard anti-congelamiento de inventario físico) — atómico todo-o-nada. Un cron `@Cron('30 */5')` con `KNEX_NEW_DB_ADMIN` libera vencidos (keyed por `tenant_id` propio, bypass RLS) y devuelve el stock. Apartar vacía el carrito de trabajo → no doble-reserva si luego confirma. NO crea orden ni cobra (ADR-034).

**Consecuencias:** ✅ evita sobreventa del producto apartado; auditable (movimientos `reserve`/`release`). ⚠️ conversión apartado→orden es manual (humano libera y coloca); cron no expuesto por HTTP.

---

## ADR-039 — **Geolocalización del pedido** (Fase FIQ): captura de pin en `delivery_address`, ETA/geocode diferido a GEO_PORT

**Fecha:** 2026-07-27 · **Estado:** Aceptado (core) · Implementado (local) · Hereda ADR-027 (última milla).

**Decisión:** aceptar el pin de ubicación de WhatsApp (`type=location`): el adapter de Meta extrae `lat/lng` a `InboundMessage.location`, el ingest lo pasa al orquestador y éste mete las coords en `delivery_address` (`{lat,lng,street}`) — que el **geofence de última milla ya lee** (`parseCoords`, validación de entrega a 20 m). Sin tabla ni columna nuevas (reúso del JSONB de dirección). El **ETA** (`route_eta_min`) y el **geocode de texto** se difieren a un **GEO_PORT** (promover `MapboxService` a puerto inyectable) porque (a) requieren `MAPBOX_TOKEN` y (b) el ETA "post-dispatch" no es computable al momento del pedido sin auto-asignación de repartidor (dispatch manual hoy). Notas de voz (STT) diferidas con ADR explícito.

**Consecuencias:** ✅ el repartidor llega por GPS aunque el cliente no sepa su calle; cero dependencia externa para el core. ⚠️ un pin sin dirección deja `street` placeholder → el prompt pide calle/referencia igual.

> **Nota FIQ.10 (outbound reorden):** no requiere ADR propio — hereda ADR-016 (el motor decide a quién/qué) y ADR-034/F.8 (envío por plantilla Meta aprobada + opt-in). El envío está gated por `WHATSAPP_REORDER_TEMPLATE`.

---

## ADR-040 — **Conector ContPAQi** (Fase CP): ContPAQi = SoR contable externo, la plataforma = engagement

**Fecha:** 2026-07-27 · **Estado:** Aceptado · CP.0–CP.4 implementados (local) · Hereda ADR-016/028.

**Decisión:** NO construir "nuestro ContPAQi" (contabilidad electrónica / DIOT / estados financieros = commodity regulado, moving-target del SAT, cero diferenciación — el mismo núcleo que Maat decidió no tocar). En su lugar, **integrar**: ContPAQi es el **system of record contable/fiscal**; la plataforma es el **system of engagement** (lee del SoR, agrega Maat + CB + analytics, y —a futuro— empuja pólizas por importación de archivo). **Jamás escritura directa a la DB de ContPAQi** (la corrompe); el push va por el import soportado (TXT/Excel) con HITL (contador importa). Conexión decodificada: **SQL Server 2022, instancia `COMPAC` en `192.168.0.35`** (servidor `SERVCONTABILIDA`), 1 empresa de Contabilidad (`ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ`, persona física), driver `mssql` con `instanceName`, login read-only `platform_ro`.

**Alternativas:** (a) construir contabilidad propia → rechazada (regulada, sin moat); (b) SDK COM two-way → diferido (CP.7, solo si el file-import no basta); (c) API cloud ContPAQi → limitada.

**Consecuencias:** ✅ Maat lee los **libros fiscales reales** (balanza consolidada `analytics.contpaqi_ledger_monthly`) sin reconstruir desde Kepler; ✅ conciliación bancaria anclada en la contabilidad real (auxiliar por banco, resuelve "los 17 bancos comparten el 102"); ✅ riesgo fiscal EFOS sobre los proveedores de los libros (109 en listas SAT, 6 EFOS → bandeja de hallazgos). ⚠️ segmentación por sucursal NO confiable (~2% de movimientos con segmento) → ContPAQi es la verdad fiscal **consolidada**, el detalle por sucursal se queda en Kepler; el gap fiscal-vs-operación (~$12M/mes) es estructural (IVA/alcance de la entidad), no error. Diferidos: CP.5 push de pólizas (necesita spec del formato de importación), materialidad CFDI↔póliza, CP.6 puerto genérico, CP.7 SDK. Plan en [`FASES/FASE_CP_CONTPAQI.md`](FASES/FASE_CP_CONTPAQI.md).

---

## ADR-041 — **Validación y Cuadre de Pólizas** (Fase PV): partida doble completa desde el SoR + detectores deterministas

**Fecha:** 2026-07-31 · **Estado:** Aceptado · PV.0–PV.4 en código (local) · Hereda ADR-016/028/040.

**Contexto:** el área de contabilidad necesita saber "¿esta póliza se subió mal?" a nivel individual. No se podía: ninguna tabla nuestra guardaba la **partida doble completa por póliza** — `analytics.expense_entries` solo tiene la pata de cargo de 511/6xx, y `analytics.ledger_monthly` es SUM mensual por cuenta. El único cuadre existente era el caso puntual XD5501.

**Decisión:** persistir el detalle completo (ambas patas) en `analytics.gl_polizas` (header) + `gl_poliza_lines` (asientos), desde **ambas fuentes**: **ContPAQi** (verdad fiscal — `Polizas`/`MovimientosPoliza`/`AsocCFDIs` traen Cargos/Abonos totalizados + el **UUID del CFDI** que Kepler no guarda) y **Kepler** (`kdc2YYMM`, detalle por sucursal). Sobre esto corren 6 detectores deterministas en `MaatPolizaService` (el motor decide, Maat narra, LLM fuera): `poliza_no_cuadra`, `cuenta_no_afectable`, `periodo_sospechoso`, `poliza_duplicada_exacta`, `cfdi_importe_no_coincide` (cruce EXACTO por UUID), `kepler_vs_contpaqi_descuadre` (familia×mes). UI "Auditor de pólizas" (`/contabilidad/polizas`) + tool `maat_poliza_cuadre`.

**Alternativas:** (a) solo Kepler → rechazada (catálogo sucio, sin UUID → cruce CFDI solo heurístico); (b) solo ContPAQi → pierde el detalle por sucursal; (c) reconciliar por folio Kepler↔ContPAQi → las numeraciones no son 1:1, se hace a **familia×mes** sobre las balanzas mensuales que ya existen.

**Consecuencias:** ✅ por primera vez se puede señalar una póliza concreta descuadrada / con cuenta equivocada / periodo equivocado; ✅ cruce póliza↔CFDI exacto por UUID (imposible con Kepler); ✅ los duplicados que antes se borraban en silencio al importar ahora se reportan. ⚠️ el cuadre fino por póliza es ContPAQi (Kepler agrega las de diario sin folio); la reconciliación Kepler↔ContPAQi es a nivel familia (catálogos distintos). Solo detecta — la corrección la hace el contador en el SoR. **Pendiente:** correr importers en la máquina de feeds (`CONTPAQI_SQL_PASSWORD` + Kepler LAN) + aplicar mig `20260731130000` a Railway + verificar el join real de `AsocCFDIs`. Plan en [`FASES/FASE_PV_VALIDACION_POLIZAS.md`](FASES/FASE_PV_VALIDACION_POLIZAS.md).

---

## ADR-042 — **Captura bancaria por WhatsApp** (Fase CBW): la foto es comprobante en staging, nunca asiento directo

**Fecha:** 2026-08-06 · **Estado:** Aceptado · CBW.0–CBW.4 en diseño · Hereda ADR-016/033/034.

**Contexto:** los encargados de plaza depositan las ventas diarias y hoy mandan la ficha/captura de transferencia por WhatsApp a un número existente, donde se teclea a mano al libro de bancos (Excel/`finance.bank_*`). Se quiere que esa foto entre "sola" al libro, con OCR, atribuida a quién la envió + cuenta + importe. Verificado sobre `01 ENERO 2026.xlsx`: los depósitos son 2,906/mes, 99.8% código `102`, conceptos `VENTAS <plaza>`/tarjeta/efectivo, organizados por sucursal.

**Decisión:** la foto de WhatsApp entra a una **bandeja de captura (staging)** con la evidencia + OCR; **nunca se auto-asienta al llegar**. Al **validar** (gate humano), la captura **se materializa como renglón de depósito en el libro** (`finance.bank_movements`: ingreso `M=I` / código `102` / cobranza, encuentra o crea el estado de cuenta del mes de la cuenta y actualiza sus totales) — sin teclear nada. Es el modelo *go-forward* de CB (de agosto 2026 en adelante el libro se lleva por la interfaz, no por Excel), así que el depósito de WhatsApp es un movimiento más entrado por la interfaz. Dos controles antes de tocar el libro (CBW.5 — número **solo para depósitos internos**, sin SÍ/NO): (1) **allowlist de remitentes** (`finance.bank_capture_senders`) da identidad al teléfono (persona + sucursal + cuenta por defecto) y filtra quién puede postear; **cada foto entra directa a la bandeja como "por validar"** (`status='confirmado'`) — el acto de enviarla es la intención, no hay confirmación por chat (elimina la ambigüedad del "sí" en lote cuando manda varios seguidos); el bot solo acusa recibo ("Recibí tu depósito de $X"); un autorizado que manda texto sin foto recibe un recordatorio, NO cae en el bot comercial; (2) **validación humana en la UI** (`/finanzas/bancos › Capturas WhatsApp`) = **único gate**: escribe el renglón (`client_uuid = whatsapp:<captureId>`, idempotente) y lo liga (`bank_movement_id`). El motor pone los números (OCR + cuenta + statement), el LLM/bot solo comunica. Cada foto = una captura independiente (sin importar 1 min o 10 días entre una y otra; nada se pierde — todas llegan a la bandeja). La conciliación contra Kepler/ContPAQi sigue igual (el renglón nace `recon_status='pending'`).

**Alternativas:** (a) alta directa de un `bank_movement` "capturado por WhatsApp" → rechazada (rompe el modelo statement-based: sin saldo corrido ni cuenta resuelta, contamina el cuadre de CB, viola ADR-016); (b) número dedicado nuevo → innecesario (el ruteo por allowlist separa el flujo bancario del comercial en el mismo número); (c) auto-registrar sin confirmar → rechazada (canal de dinero exige doble control humano).

**Consecuencias:** ✅ reúsa ~85% (canal Meta+webhook de Fase F, OCR `extractDepositSlip` de CC, libro `finance.bank_*` de CB, Cloudinary, identidad E.164); lo nuevo es solo cableado + 2 tablas. ✅ el comprobante queda ligado a persona/sucursal/cuenta sin teclear. ⚠️ requiere el media-download de Meta (FIQ.9, único pendiente del bot) = CBW.0; ⚠️ arranca vacío hasta sembrar el registro de remitentes (teléfono→nombre→sucursal→cuenta). Diferido: cuadre automático captura↔estado de cuenta (CBW.5), notas de voz (STT). Plan en [`FASES/FASE_CBW_BANCOS_WHATSAPP.md`](FASES/FASE_CBW_BANCOS_WHATSAPP.md).

---

## ADR-043 — **Endurecimiento de infra + worker-tier** (Fase INFRA): activar/separar, no re-arquitecturar

**Estado:** Aceptado

**Fecha:** 2026-08-12

**Contexto:** Todo corre en **un solo proceso NestJS** (REST + 6 gateways WS + ~40 `@Cron` + IA de minutos + refresh de MVs) desplegado como **1 servicio Railway**. Esto ya causó **OOM → ECONNRESET/502**, clava el API a 1 instancia (con N instancias los 40 crons se dispararían N veces), pone el trabajo LLM/visión en el request-path sin límite de concurrencia, y el `nightly` es un tren de ~55 importers en serie. Además: secretos en `.env` (incidente de creds expuestos pendiente de rotar), observabilidad = solo Sentry (errores), media por Cloudinary con egress caro (~200GB/mes). El proyecto NO necesita microservicios por dominio (los `libs/*` ya dan modularidad); necesita **activar tecnología ya presente** (Redis/BullMQ dormidos, `@aws-sdk/client-s3` instalado, `ops/observability/` diseñado) y **separar procesos** que comparten código+DB.

**Decisión:** Adoptar el patrón **monolito modular + worker-tier + broker de colas**, sin romper el dominio en servicios de red. Se aplica el top-5 en orden: (1) **secretos → bóveda** (Infisical/Doppler), (2) **observabilidad** (nestjs-pino JSON + OpenTelemetry + Grafana/Loki/Prometheus), (3) **worker-tier con `pg-boss`** (cola sobre el propio Postgres, cero Redis nuevo; proceso `WORKER=true` con el mismo código Nx y toggle estilo `ENABLE_MULTITENANT`), (4) **media → Cloudflare R2** (S3-compatible, egress $0), (5) **CI extendido** (`nx affected` + `run-all-tests` en el gate). Cada pieza entra por toggle, default OFF, prod intacto hasta validar.

**Alternativas consideradas:**
- **Microservicios por bounded-context** (finance/commercial/logistics como servicios separados): rechazado — a 1 dev el costo de red + despliegues + consistencia distribuida no se paga; los `libs/*` ya aíslan.
- **Redis + BullMQ como cola** (en vez de pg-boss): diferido — ya está instalado pero exige un servicio Redis nuevo; `pg-boss` reusa el Postgres existente y encaja con "NO Redis hasta Fase F". Se reactiva Redis cuando el volumen (WhatsApp Fase F, Socket.IO multi-instancia) lo justifique.
- **Kubernetes / Kafka / RabbitMQ / gRPC / Terraform**: rechazado — sobre-ingeniería para la escala actual; Railway + config-as-code (`railway.json`) + pg-boss cubren todo.
- **Fastify en vez de Express**: evaluado, diferido — gana RAM/throughput pero la migración (multer, adapter socket.io) es no trivial; se revisita si el OOM persiste tras el worker-tier.

**Consecuencias:**
- ✅ Desbloquea escalar el API horizontal (crons salen del proceso web) y aísla IA/ETL/MV del tráfico → ataca el OOM de raíz.
- ✅ Reusa lo ya presente (pg-boss sobre Postgres, aws-sdk, ops/observability); mínima tecnología nueva de operar.
- ✅ Cierra el incidente de secretos y da visibilidad (traces/métricas) para diagnosticar caídas.
- ⚠️ Introduce un 2º proceso desplegable (worker) y un gestor de secretos externo → más superficie operativa para 1 dev; mitigado con toggles y default OFF.
- ⚠️ pg-boss carga trabajo de cola sobre el mismo Postgres (aceptable a este volumen; migrable a Redis después).
- 🔄 Reversible: cada toggle apaga su pieza; el worker es el mismo binario del API.

Plan en [`FASES/FASE_INFRA_WORKER_TIER.md`](FASES/FASE_INFRA_WORKER_TIER.md). Hereda ADR-016 (motor decide / LLM fuera del camino) y complementa ADR-035 (`feeds-ingest`, el primer worker aislado).

---

## Cómo agregar un ADR nuevo

1. Copiar `ADR-000` (la plantilla) renombrando al siguiente número correlativo.
2. Completar contexto, decisión, alternativas, consecuencias.
3. Estado inicial: **"Propuesto"**. Después de discutir/validar: **"Aceptado"**.
4. Si una decisión vieja se reemplaza: marcar la vieja como "Superseded by ADR-XXX" y crear la nueva.
