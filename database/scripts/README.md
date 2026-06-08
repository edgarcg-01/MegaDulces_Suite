# `database/scripts/` — Mapa de scripts ad-hoc

> Scripts utilitarios para migración, normalización, cutover, embeddings, debug.
> NO confundir con `database/migrations*/` (Knex migrations versionadas) ni con `database/tests/` (suite de regression) ni con `database/importers/` (CLI importer canónico).
>
> **Convención:** los nombres llevan un prefijo de familia (`brands-*`, `cutover-*`, `railway-*`, etc.) que indica scope. Casi todos requieren `DATABASE_URL` o `DATABASE_URL_NEW` (ver `.env.example`).
>
> **Estados:**
> - 🟢 **reusable** — Patrón canónico, re-correr cuando aplique.
> - 🟡 **operacional** — Útil para incidentes específicos (cutover, sync, debug).
> - 🔵 **histórico** — One-off ya ejecutado en prod. Conservar como referencia; no re-correr a ciegas.
> - ⚫ **artifact** — Snapshot ad-hoc (`.txt` con output de un comando). Safe to delete cuando ya no sirve.

---

## Familia `brands-*` — normalización de marcas

Set completo de dedup multi-tenant con cadena de remap (JSONB → prices → stock SUM → movements → order_lines → products → brands). UPPERCASE canónico, idempotente, dry-run default. Ver memoria `project_brand_normalization`.

| Script | Estado | Qué hace |
|---|---|---|
| `brands-explore.js` | 🟢 | Lista todas las brands del tenant + count de products por brand. |
| `brands-explore-detail.js` | 🟢 | Drill-down sobre un brand específico (FK refs en todas las tablas). |
| `brands-check-schemas.js` | 🟢 | Verifica que el schema commercial.brands esté como se espera. |
| `brands-fuzzy-scan.js` | 🟢 | Detecta duplicados aparentes (fuzzy match nombres). Read-only. |
| `brands-list-refs.js` | 🟢 | Lista todas las FK a un brand_id dado. Útil antes de remap. |
| `brands-normalize.js` | 🟢 | Aplica el remap. Default dry-run; pasar `--apply` para escribir. |
| `brands-verify-prod.js` | 🟢 | Smoke en prod post-normalize. |

---

## Familia `cutover-*` — migración legacy → nueva DB / Railway

Sprint A.0mt.5 — runbook de cutover. Requiere `LEGACY_DATABASE_URL` + `DATABASE_URL_NEW`. Ver `docs/IMPLEMENTACION/RUNBOOKS/CUTOVER_NEW_DB.md`.

| Script | Estado | Qué hace |
|---|---|---|
| `cutover-preflight.js` | 🟡 | Valida que la DB nueva tiene todos los rows esperados antes de cutover. Read-only. (npm: `cutover:preflight`) |
| `cutover-to-railway.js` | 🟡 | Push del schema + data multi-tenant a Railway. Destructive. |
| `cutover-smoke-test.js` | 🟡 | Smoke E2E post-cutover (auth + tenant isolation). (npm: `cutover:smoke`) |
| `cutover-rollback-check.js` | 🟡 | Verifica que la app legacy sigue funcionando en paralelo durante la ventana de cutover. |
| `migrate-legacy-to-newdb.js` | 🔵 | Sprint A.0mt.4 (2026-05-26). 1804/1830 rows migrados. Ya ejecutado; conservar como referencia. |
| `apply-session-migrations-to-245.js` | 🟡 | Aplica migraciones de una sesión específica al .245 (sync Docker pgvector ↔ remoto). |

---

## Familia `embed-*` / `*vector*` — Fase K (AI product match)

Bootstrap y mantenimiento del pgvector. ADR-011 (Voyage AI `voyage-3`, 1024 dims). Ver memoria `project_fase_k_ai_match`.

| Script | Estado | Qué hace |
|---|---|---|
| `init-vector-db.js` | 🟡 | Crea schema vector dedicado (extension + tabla `vector_products`). One-off por DB. |
| `load-vector-db.js` | 🟡 | Snapshot inicial del catálogo → vector DB (embedea todo). |
| `embed-active-products.js` | 🟢 | Embedea products `activo=true` que están `embedding IS NULL`. Idempotente. |
| `backfill-product-embeddings.js` | 🟢 | Backfill batched de embeddings con throttle. (npm: `embeddings:backfill`) |
| `sync-from-remote.js` | 🟢 | Sincroniza Docker pgvector ← `.245` (cuando se modifica catálogo en .245). (npm: `embeddings:sync`) |
| `sync-245-compatibility-shims.sql` | 🟡 | Aplica los 2 shims pendientes en .245 (Fase K-sync pendiente). |
| `railway-pgvector-minimal-migrate.js` | 🔵 | Migración minimal pgvector → Railway (deferred). |

---

## Familia `apply-*` (SQL) — migraciones ad-hoc aplicadas

Cambios de schema que NO pasaron por Knex migrations (típicamente fixes urgentes en prod). Conservar como referencia.

| Script | Estado | Qué hace |
|---|---|---|
| `apply-all-prod.sql` | 🔵 | Wrapper que aplica varios fix SQL en secuencia. |
| `apply-format-fixes.sql` | 🔵 | Normalización de formato (trim, uppercase) en columnas de catálogo. |
| `apply-normalize.sql` | 🔵 | Aplica `dry-run-normalize.sql` con writes. |
| `apply-typo-fixes.sql` / `apply-typo-fixes-batch2.sql` | 🔵 | Corrección de typos en nombres de productos. |
| `add_cloudinary_column.sql` | 🔵 | Migration ad-hoc: agregar columna cloudinary_url. |

---

## Familia `audit-*` / `check-*` / `verify-*` / `dry-run-*` / `preview-*`

Read-only (la mayoría). Útiles para diagnóstico antes de ejecutar un `apply-*` o `*-normalize`.

| Script | Estado | Qué hace |
|---|---|---|
| `audit-products.sql` / `audit-products-pass2.sql` / `audit-products-pass2b.sql` | 🟢 | Auditoría de quality del catálogo de productos. |
| `check-1199-overlap.sql` | 🔵 | Diagnóstico específico de un incidente. |
| `check-overlap-railway.sql` | 🔵 | Verifica overlaps de IDs entre local y Railway. |
| `check-customer-b2b-perms.js` | 🟢 | Smoke de permisos del rol `customer_b2b` (portal B2B). |
| `verify-prod-state.sql` | 🟢 | Estado consolidado de prod (counts por tabla crítica). |
| `dry-run-normalize.sql` | 🟢 | Vista previa de qué haría `apply-normalize.sql`. |
| `preview-format-fixes.sql` / `preview-normalize.sql` / `preview-prod-counts.sql` | 🟢 | Vista previa antes de aplicar cambios. |

---

## Familia `backfill-*` — backfills de columnas o vistas

| Script | Estado | Qué hace |
|---|---|---|
| `backfill-stats-puntuacion-total-historicas.sql` | 🔵 | Backfill de scores históricos cuando se agregó la columna. |
| `backfill-scoring-zero.js` | 🔵 | Marca como 0 stores sin captura en el rango (analytics). |
| `backfill-product-embeddings.js` | 🟢 | (ya listado en sección Embeddings) |

---

## Familia `diff-*` — comparaciones prod vs local

| Script | Estado | Qué hace |
|---|---|---|
| `diff-railway-vs-local.js` | 🟢 | Compara counts y schema entre Railway y local. Read-only. |
| `diff-columns.sql` / `diff-prod-vs-local.sql` | 🟢 | SQL queries para detectar drift entre ambientes. |

---

## Familia `railway-*` — bootstrap o carga de Railway

Carga inicial / reseteo de Railway. Destructivos. Usar con cuidado.

| Script | Estado | Qué hace |
|---|---|---|
| `railway-truncate.sql` / `railway-full-truncate.sql` | 🔵 | Trunca tablas del tenant. **Destructive.** |
| `railway-counts.sql` / `railway-full-counts.sql` | 🟢 | Read-only — counts pre/post carga. |
| `railway-load-{brands,categories,customers,inventory,logistics,price-lists,staff,warehouses}.sql` | 🔵 | Carga de cada dominio (orden importa). |
| `railway-sync-catalog-commercial.sql` | 🔵 | Sync catálogo → schema commercial. |
| `railway-convert-topsellers-to-table.sql` | 🔵 | Conversión one-off de view → tabla. |
| `railway-rollback-to-backup.sql` | 🔵 | Rollback a backup previo. **Destructive.** |
| `fix-railway-products-top-sellers-ids.sql` | 🔵 | Fix puntual de IDs en topsellers. |

---

## Familia `dedup-*` / `move-*` / `link-*` — limpieza de data one-off

| Script | Estado | Qué hace |
|---|---|---|
| `dedup-canels.js` / `dedup-larosa.js` | 🔵 | Dedup específico por brand. Histórico. |
| `add-canels-4s.js` | 🔵 | Inserta Canel's 4S (marca específica). |
| `move-canels-from-tira.js` | 🔵 | Re-clasifica products entre brands. |
| `link-customers-to-stores.js` | 🔵 | Linkea customers ↔ stores por nombre (commit a38ffa0). |
| `bootstrap-planogram-aliases.js` | 🔵 | Bootstrap inicial de `trade.catalog_aliases` (ver memoria `project_catalog_aliases`). |
| `products-explore-dups.js` | 🟢 | Read-only — explora products duplicados (similar a brands-fuzzy-scan). |
| `products-normalize.js` | 🟢 | Aplica normalización a products (similar a brands-normalize). |

---

## Familia `fix-*` (SQL) — fixes puntuales aplicados

| Script | Estado | Qué hace |
|---|---|---|
| `fix-daily-captures-mt-shim.sql` | 🔵 | Shim aplicado para que el service legacy de daily_captures funcione en schema MT. Ver memoria `feedback_daily_captures_mt_shim`. |
| `fix-sin-exhibidor-scoring-weight.sql` | 🔵 | Fix de peso de scoring "sin exhibidor". |

---

## Familia `images-*` / `upload-*` — pipeline de imágenes de producto

| Script | Estado | Qué hace |
|---|---|---|
| `import-product-images-ml.js` | 🔵 | Importa imágenes desde MercadoLibre (búsqueda automática). |
| `import-product-images-off.js` | 🔵 | Importa desde OpenFoodFacts. |
| `remove-bg-product-images.js` | 🟡 | Remueve fondo de imágenes (uso `@imgly/background-removal-node`). |
| `upload-product-images-to-cloudinary.js` | 🟢 | Sube imágenes locales → Cloudinary. |

---

## Schema exploration / snapshot

| Script | Estado | Qué hace |
|---|---|---|
| `columns-snapshot.sql` | 🟢 | Dump de schema de columnas a un text. |
| `indexes-snapshot.sql` | 🟢 | Dump de índices. |
| `inventory-trade-tables.sql` | 🟢 | Lista tablas Trade schema. |
| `fk-chains-trade.sql` | 🟢 | Cadenas de FK en Trade schema. |
| `local-import-from-railway.sql` | 🟡 | Trae datos de Railway → local (para reproducir bugs). |
| `local-shrink-to-prod.sql` | 🟡 | Reduce local DB a un subset prod-like. |
| `debug-portal-local.sql` | 🟡 | Queries de diagnóstico para flow del portal B2B. |
| `debug-catalog.js` | 🟡 | Debug de catálogo (queries diversas). |
| `find-superoot.js` | 🟡 | Encuentra el user superoot del tenant. |

---

## Setup / one-offs operacionales

| Script | Estado | Qué hace |
|---|---|---|
| `setup-runtime-role.js` | 🟡 | Recrea el rol postgres `app_runtime` (con grants correctos). Necesario tras `SET SCHEMA` que rompa el rol. |
| `recalc-today-scores.js` | 🟢 | Recalcula scores del día (workaround si el cron falla). |
| `run-seed-91.js` | 🔵 | Wrapper para correr el seed 91 específicamente. |

---

## Artifacts (⚫ safe to delete cuando no sirvan)

Snapshots de columnas/constraints/objetos generados por comandos `psql -c "\d" > foo.txt`. Útiles puntualmente; no son fuente de verdad.

| Archivo | Origen |
|---|---|
| `cols-local.txt` / `cols-railway.txt` | Snapshot de columnas local vs Railway. |
| `constraints-local.txt` / `constraints-railway.txt` | Snapshot de constraints. |
| `objects-local.txt` / `objects-railway.txt` | Snapshot de objetos (tablas, vistas, secuencias). |
| `local-ids.txt` / `railway-ids.txt` | Snapshot de IDs. |

---

## Reglas

1. **Antes de re-correr un 🔵 histórico:** entender por qué se aplicó originalmente (ver `git log` del archivo). Pueden generar conflictos si el state ya cambió.
2. **Antes de re-correr un 🟡 operacional:** verificar pre-requisitos (env vars, branch, estado de la DB).
3. **Scripts nuevos:** seguir convención de prefijo de familia. Si es operativo recurrente, considerar moverlo a `database/importers/` (con README y argv parsing serio).
4. **Antes de borrar un ⚫ artifact:** verificar que no se referencie desde un runbook en `docs/IMPLEMENTACION/RUNBOOKS/`.
5. **TenantKnexService obligatorio para queries con RLS:** scripts nuevos que conecten como `app_runtime` deben envolver queries en `SET LOCAL app.tenant_id`. Ver memoria `feedback_tenant_knex_rls`.
