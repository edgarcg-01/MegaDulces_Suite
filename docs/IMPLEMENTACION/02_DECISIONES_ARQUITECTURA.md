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

## Cómo agregar un ADR nuevo

1. Copiar `ADR-000` (la plantilla) renombrando al siguiente número correlativo.
2. Completar contexto, decisión, alternativas, consecuencias.
3. Estado inicial: **"Propuesto"**. Después de discutir/validar: **"Aceptado"**.
4. Si una decisión vieja se reemplaza: marcar la vieja como "Superseded by ADR-XXX" y crear la nueva.
