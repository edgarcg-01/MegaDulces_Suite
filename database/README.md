# `database/` — migraciones, importers, tests

## Directorios de migración: CUATRO, cada uno para una DB DISTINTA

Hay 4 carpetas de migración y 5 knexfiles. **No son intercambiables**: cada una apunta a
una base diferente, con su propia tabla `knex_migrations`. Poner una migración en la
carpeta equivocada = corre contra la DB equivocada (o no corre). Mapa (medido 2026-09-09):

| carpeta | knexfile | DB destino | env | estado |
|---|---|---|---|---|
| **`migrations-newdb/`** | `knexfile-newdb.js` | `postgres_platform` (**PROD, plataforma multi-tenant**) | `DATABASE_URL_NEW` / `FLEET_DB_URL` | **🟢 ACTIVO — el principal.** Toda migración de la plataforma va ACÁ. |
| `migrations-hr/` | `knexfile-hr.js` | `hr` (checadores / asistencia) | `DATABASE_URL_HR` | 🟢 ACTIVO pero **DB aparte**. Sólo para trabajo de RH/checadores. No mezclar con la plataforma. |
| `migrations/` | `knexfile.js` | `megadulces_logistica` (app legacy single-tenant) | `DATABASE_URL` | 🟡 DORMIDO (última mig 2026-06-19). La app corre en la plataforma; esta DB quedó en paralelo. No agregar salvo que trabajes esa DB legacy. |
| `migrations-products/` | `knexfile-products.js` | `trade_marketing` | `DATABASE_URL` | 🔴 ABANDONADO (1 mig, 2026-04-29). |

### Reglas

- **Una migración nueva de la plataforma → SIEMPRE `migrations-newdb/`.** Es la de prod.
- **NUNCA borrar un archivo de migración YA APLICADO** (en cualquier carpeta): knex valida
  el filesystem contra `knex_migrations` y una baja produce *"directory corrupt" → crash
  loop* (vivido). Los archivos viejos se conservan aunque la carpeta esté dormida.
- **`migrations-newdb` en prod se aplica con cuidado** (ver `docs/GOTCHAS.md`): tablas
  grandes (`gl_poliza_lines` 480k/291MB, `sales_daily` 4.5M) → aplicar la mig sola con
  `lock_timeout`, NO el batch entero de `migrate:latest` en una sola transacción, para no
  sostener el lock exclusivo mientras otros carriles escriben.
- El runner on-prem escribe a prod: `run-prod-feeds.js` exige destino prod vía
  `assertProdTarget` (ver `libs/platform-core/.../provenance/target-guard.js`). Editar un
  importer bajo `importers/**` = deploy a prod en la próxima pasada.

> Detalle de la topología de conexión (prod vs copia local `.245`, cómo NO filtrar la
> credencial) en la memoria `reference_prod_db_connection_topology` y `docs/GOTCHAS.md`.
