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

**Estado:** Pendiente — decidir en Sprint A.0.4 (al iniciar trámite)

**Fecha:** _(por completar)_

**Contexto:** WhatsApp Business API requiere un BSP (Business Solution Provider). Opciones principales para LATAM: 360dialog, Wati, Gupshup, Twilio.

**Decisión:** _(pendiente)_

**Alternativas a evaluar:**
- **360dialog**: economías de escala, especializado en WhatsApp puro, $50-100/mes base.
- **Wati**: UI completa de gestión + API, $40-100/mes, popular en LATAM.
- **Gupshup**: foco India pero opera global, agresivo en precios.
- **Twilio**: brand reconocido, API más rica, más caro.
- **Meta directo**: máximo control, pero proceso de aprobación es brutal.

**Criterios de decisión:** precio por conversación, soporte en español, integración con Node.js, calidad de docs, tiempo de verificación.

---

## ADR-007 — Selección de LLM para bot conversacional

**Estado:** Pendiente — decidir en Sprint F (Fase F)

**Fecha:** _(por completar)_

**Contexto:** El bot conversacional necesita LLM con tool calling. Opciones: Anthropic Claude, OpenAI GPT, Google Gemini, modelos open-source via Replicate/Together.

**Decisión:** _(pendiente)_

**Recomendación preliminar:** Anthropic Claude Haiku 4.5 — balance precio/calidad/velocidad para tool calling en español. Costo aproximado: $0.80/1M tokens input.

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

## Cómo agregar un ADR nuevo

1. Copiar `ADR-000` (la plantilla) renombrando al siguiente número correlativo.
2. Completar contexto, decisión, alternativas, consecuencias.
3. Estado inicial: **"Propuesto"**. Después de discutir/validar: **"Aceptado"**.
4. Si una decisión vieja se reemplaza: marcar la vieja como "Superseded by ADR-XXX" y crear la nueva.
