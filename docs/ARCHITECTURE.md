# Arquitectura — mapa del sistema

> El mapa mental del monorepo para devs nuevos: qué app hace qué, cómo se dividen los dominios en libs,
> qué DBs existen y cómo fluyen los datos del ERP. Para el detalle de Kepler ver [`ERP_KEPLER.md`](ERP_KEPLER.md);
> para términos ver [`GLOSSARY.md`](GLOSSARY.md).
>
> **Este doc = arquitectura de código (apps/libs/módulos).** Para la **arquitectura de DATOS** (schemas de prod,
> tablas, FKs, flujo origen→pantalla con diagramas mermaid) ver [`ARQUITECTURA_DATOS.md`](ARQUITECTURA_DATOS.md),
> que es la referencia detallada y grounded en introspección de prod. Reemplaza al viejo `ARCHITECTURE.md`
> (filosofía de bounded contexts) cuyos principios evergreen se conservan en §3.

---

## 1. Vista de pájaro

```
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTENDS (Angular standalone)                                      │
│  • apps/view    → admin / operaciones (dashboard, comercial,         │
│                    logística, finanzas, compras, vendor, televenta)  │
│  • apps/portal  → portal B2B del cliente (/portal/*)                 │
│  • apps/vendor  → app del vendedor de campo (deploy propio)          │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTP / WebSocket
┌───────────────────────────────▼─────────────────────────────────────┐
│  apps/api  (NestJS — composition root, delgado)                      │
│  Cablea los dominios (libs/*) vía puertos en src/composition/*       │
└───────────────────────────────┬─────────────────────────────────────┘
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌──────────────┐        ┌─────────────────┐      ┌──────────────────┐
│ DOMINIOS     │        │ platform-core   │      │ DBs (Postgres)   │
│ (libs/*)     │        │ (infra leaf)    │      │ legacy /         │
│ commercial   │        │ database, tenant│      │ postgres_platform│
│ finance      │        │ cache, queue,   │      │ (multi-tenant) / │
│ fiscal       │        │ ability/RBAC,   │      │ hr / vector /    │
│ logistics    │        │ AI, storage,    │      │ kepler_ods       │
│ trade        │        │ vector, neo4j   │      └────────▲─────────┘
│ reconciliation│       └─────────────────┘               │
│ whatsapp     │                                          │ feeds
└──────────────┘                                 ┌────────┴─────────┐
                                                 │ ERP Kepler (6    │
                                                 │ sucursales) +    │
                                                 │ Wincaja, ContPAQi│
                                                 │ checadores…      │
                                                 └──────────────────┘
```

**Stack:** NestJS 11 + Knex + PostgreSQL + Socket.IO · Angular standalone + PrimeNG + Tailwind + Spartan UI ·
Capacitor + Dexie (vendor mobile) · Nx monorepo · Docker + Railway.

---

## 2. Apps (`apps/`) — las 4 deployables

| App | Qué es | Notas |
|---|---|---|
| **`api`** | Backend NestJS (composition root). Empaqueta migraciones/seeds/templates. | Servicio backend principal. |
| **`view`** | Frontend Angular principal: admin + operaciones (comercial, logística, finanzas, compras, vendor, televenta). | El `:4200`. Build esbuild. |
| **`portal`** | Frontend B2B del cliente (`/portal/*`). | Contenedor nginx propio en Railway. |
| **`vendor`** | App del vendedor de campo (pedidos, ruta, captura offline). | Deploy independiente; su nginx proxya `/api`. |

---

## 3. Dominios (`libs/`)

El backend es **delgado en `apps/api`**: casi toda la lógica de negocio vive en librerías de dominio. `apps/api`
solo trae módulos de plataforma (`auth`, `auth-mt`, `cron`, `db-health`, `kepler-consolidado`, `store`,
`tenants-admin`) y cablea los dominios en `src/composition/*` (8 bindings de puertos: order-fulfillment,
finance-findings-sink, invoice-issuer, bank-capture, etc.).

| Lib | Dominio | Módulos (aprox.) |
|---|---|---|
| **`commercial`** | Core comercial: clientes, almacenes, pricing, inventario, órdenes, analytics, promos, productos, televenta, portal AI, OCR de tickets, **Thot** (inteligencia). | ~36 |
| **`finance`** | Finanzas (**Maat**): conocimiento, motor de patrones, hallazgos, chat AI, bancos, caja, comprobaciones, pólizas. | ~15 |
| **`fiscal`** | Fiscal: CFDI, cumplimiento SAT, EFOS 69-B, DIOT, contabilidad, vault. | ~12 |
| **`logistics`** | Logística: embarques, flotilla, guías, costos, nómina, checklists, POD, carta porte, tracking. | ~13 |
| **`trade`** | Trade marketing: visitas/capturas PdV, scoring, planogramas, reports realtime, stores, **Horus** (supervisor AI). | ~14 |
| **`reconciliation`** | Supervisor de movimientos (cuadre caja/inventario, bandeja de descuadres HITL). | 1 |
| **`whatsapp`** | Comercio conversacional (puerto Meta Cloud API / simulador, cola degradable). | 1 |
| **`platform-core`** | Infra compartida (leaf, no depende de dominios): database, tenant, cache, queue, cloudinary, storage, ability/RBAC, AI, neo4j, vector-db. | ~11 |
| **`contracts`** | Tipos de eventos cross-domain + DTOs + interfaces Port. Solo tipos, sin runtime. | — |
| **`shared-auth` / `shared-scoring`** | Auth y scoring compartidos (core + ui). | — |
| **`design-tokens`** | Solo `tokens.css` (no es proyecto Nx). Archivo único para las 3 apps. | — |

**Regla de dependencias:** los dominios dependen de `platform-core` + `contracts`, **nunca entre sí directamente**
— se comunican por puertos cableados en el composition root.

### Principios evergreen (heredados de la filosofía original)

- **Bounded contexts / silos.** Un módulo (ej. `captures`) **jamás** importa modelos o servicios de otro dominio
  (ej. `auth`) directamente. La comunicación va por puertos/eventos.
- **El JWT es el puente.** Las relaciones de negocio (¿quién mandó este Daily Capture?) se resuelven con las
  *claims* del JWT (`user_id`, `username`, `tenant_id`, rol), no con JOINs cross-dominio.
- **`captured_by_username` es inmutable por diseño.** Se snapshotea el nombre al momento de la captura para
  subsanar JOINs faltantes si el usuario cambia en Auth. **No borrar esa columna.** (Ver [`GOTCHAS.md`](GOTCHAS.md) §11.)

---

## 4. Bases de datos

| DB lógica | Knexfile | Env | Para qué |
|---|---|---|---|
| **legacy** `megadulces_logistica` | `knexfile.js` | `DATABASE_URL` | DB principal actual (en transición al cutover). |
| **`postgres_platform`** (multi-tenant) | `knexfile-newdb.js` | `DATABASE_URL_NEW` (migraciones, rol superuser) · `DATABASE_URL_NEW_RUNTIME` (runtime, rol `app_runtime` que respeta RLS) | La nueva DB multi-tenant. **La app en runtime usa el string RUNTIME** o bypassa RLS. |
| **`hr`** | `knexfile-hr.js` | `DATABASE_URL_HR` | Asistencia/RRHH on-prem (checadores). |
| **`trade_marketing`** (productos) | `knexfile-products.js` | `DATABASE_URL` | Migraciones de catálogo/precios. |
| **vector** (pgvector) | — | `VECTOR_DATABASE_URL` | RAG / matcher de productos con embeddings. |
| **kepler consolidado** | — | `DATABASE_URL_KEPLER_CONSOLIDADO` | Consolidación Kepler para Sell-Out. |
| **Neo4j** (grafo) | — | `NEO4J_URI` | Grafo (colusión de proveedores, etc.). |

**`kepler_ods`** no es una DB aparte: es un **schema/capa ODS dentro de `postgres_platform`**, alimentado por los
feeds Kepler, y es la **fuente canónica** para todo dato del ERP. Ver [`ERP_KEPLER.md`](ERP_KEPLER.md) §4.

> ⚠️ Nunca conectar la app como superuser en runtime → bypassa RLS y expone data cross-tenant. Usar el string RUNTIME.

---

## 5. Feeds / importers (`database/importers/`)

Ingesta de sistemas externos hacia las DBs de la plataforma. Casi todos **idempotentes** y en **dry-run por
default** (necesitan `--apply`).

| Carpeta | Qué ingesta |
|---|---|
| `kepler/` | Núcleo ERP Kepler → ODS (stock, precios, box-factor, cortes de caja, bancos, cobros, cartera, reorden, **CDC/WAL** `replicate-ods-live.js`/`ods-cdc-*`). |
| `wincaja/` | Punto de venta Wincaja (SQL Server): stock, tickets, ventas, rutas. |
| `checadores/` | Relojes ZK de asistencia (LAN) → DB `hr`. |
| `contpaqi/` | ContPAQi (SQL Server): movimientos bancarios, ledger, pólizas, proveedores. |
| `finance/` | Programa de pagos, pagos a proveedores, políticas de descuento. |
| `movimientos-caja/` | Caja general desde Access MDB. |
| `orchestrator/` | Orquestador de feeds (PM2). |
| `lib/` | Utilidades compartidas (adaptadores Access, sink, warehouse-id, kepler-branches, watchdog). |
| `testdata/`, `examples/` | JSON de prueba y de formato de feed. |

---

## 6. Servicios externos

| Servicio | Uso | Env |
|---|---|---|
| **Anthropic (Claude)** | Vision/LLM: OCR de tickets/comprobantes, portal AI order, WhatsApp, chat Thot/Maat. | `ANTHROPIC_API_KEY` |
| **Voyage AI** | Embeddings para el matcher de productos / RAG. | `VOYAGE_API_KEY` |
| **Groq (Whisper)** | Dictado por voz → texto (pedido por voz del vendedor). | `GROQ_API_KEY` |
| **Mapbox** | Map-matching / adherencia a ruta. | `MAPBOX_TOKEN` |
| **Cloudinary → S3/Tigris** | Storage de imágenes/PDF (migración en curso a bucket S3-compatible de Railway). | `CLOUDINARY_*`, `S3_*` |
| **Sentry** | Observabilidad de errores (Angular + NestJS). | (SDK) |
| **Socket.IO + Redis** | WebSockets realtime + adapter Redis para escalar horizontal. | `REDIS_URL` |
| **BullMQ / pg-boss** | Colas de jobs (degradables a in-process). | `REDIS_URL` / `DATABASE_URL_NEW` |
| **web-push** | Notificaciones push (VAPID) al frontend. | (VAPID keys) |
| **MSSQL** | Origen de Wincaja y ContPAQi. | (en importers) |
| **Neo4j** | Grafo. | `NEO4J_*` |

> **Twilio** aparece citado como BSP alternativo de WhatsApp pero **no está integrado**.

---

## 7. Cómo se conecta todo (flujo típico de un request)

1. El frontend (`view`/`portal`/`vendor`) llama a `apps/api` con un JWT.
2. `auth-mt` valida el JWT; el `TenantContextInterceptor` puebla el contexto de tenant (AsyncLocalStorage).
3. El controller del dominio (en `libs/*`) usa `TenantKnexService.run()` → abre trx + `SET LOCAL app.tenant_id`
   → RLS devuelve solo la data del tenant.
4. Para dato del ERP, el dominio lee de `kepler_ods` (o vistas `analytics.*` derivadas de él), que los feeds
   mantienen frescos en near-real-time.
5. Eventos cross-domain viajan por puertos cableados en `apps/api/src/composition/*`.

**Trampas críticas de este flujo** (RLS vacío, transacción abortada, permisos): [`GOTCHAS.md`](GOTCHAS.md).
