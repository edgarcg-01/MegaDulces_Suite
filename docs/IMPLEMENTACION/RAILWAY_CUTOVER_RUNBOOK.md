# Runbook — Cutover a Railway (DB nueva multi-tenant)

> **Estrategia**: Opción A — DB nueva en paralelo. La DB legacy actual
> queda intacta como respaldo histórico hasta que se confirme que la app
> nueva funciona en prod.
>
> **Fecha del runbook**: 2026-05-27
> **Aplicable a**: cutover de schema A.0mt + Fase B + C + D + E + J + J.8 + J.9
> **Estado anterior**: 30 migraciones aplicadas en local, 0 en Railway nuevo

---

## ⚠️ Antes de empezar — checklist de pre-requisitos

- [ ] **Tener acceso al proyecto Railway** (`switchback.proxy.rlwy.net`).
- [ ] **Crear NUEVA DB Postgres** en Railway (paso 1 abajo).
- [ ] **Backup de la DB legacy** (snapshot manual desde Railway dashboard).
- [ ] **Confirmar que `.env` local tiene** `LEGACY_DATABASE_URL` apuntando a la DB legacy actual.
- [ ] **Build OK** local: `npx nx build api && npx nx build view`.

---

## Paso 1 — Crear DB nueva en Railway

Opciones:

### Opción 1A — Nuevo servicio Postgres en Railway (recomendado)
1. Ir al dashboard Railway → tu proyecto Trade Marketing.
2. Click "**+ New**" → "**Database**" → "**Add PostgreSQL**".
3. Railway crea un servicio Postgres nuevo con su propio dominio:
   `postgresql://postgres:<random_password>@<host>.proxy.rlwy.net:<port>/railway`
4. Copiar el **DATABASE_URL** del nuevo servicio (variables tab).

### Opción 1B — Nueva DB en el Postgres existente (si tu plan lo permite)
1. Conectarse al Postgres legacy via psql / pgAdmin.
2. `CREATE DATABASE postgres_platform;`
3. El URL será el mismo pero cambiando el nombre de la DB al final:
   `postgresql://postgres:GlUi...@switchback.proxy.rlwy.net:16885/postgres_platform`

> ⚠️ **Recomendamos Opción 1A** — separación física entre legacy y nueva.
> Si pasa algo malo en la nueva, la legacy queda blindada.

---

## Paso 2 — Aplicar las 30 migraciones + seeds + baseline

```bash
# Setear env var con el URL de la DB NUEVA
export DATABASE_URL_NEW="postgresql://postgres:NEW_PASSWORD@NEW_HOST.proxy.rlwy.net:NEW_PORT/railway"

# Correr el orquestador
node database/cutover-to-railway.js
```

El script automático hace:
1. ✅ Verifica conexión a la DB nueva
2. ✅ Verifica que está **vacía** (aborta si no, salvo `--force-not-empty`)
3. ✅ Aplica las **30 migraciones** (`migrations-newdb/`)
4. ✅ Aplica los **6 seeds**:
   - `01_first_tenant_mega_dulces` (UUID `00000000-...d01c`)
   - `02_mega_dulces_initial_roles` (superadmin + commercial_admin + tele_operator + customer_b2b + vendor + driver)
   - `03_mega_dulces_superoot_user` (login: `superoot` / `superoot`)
   - `04_mega_dulces_commercial_baseline` (warehouse MD-CENTRAL + price_list BASE-MXN + customer DEMO-001)
   - `05_mega_dulces_demo_customer_user` (cliente demo del Portal B2B)
   - `06_mega_dulces_logistics_baseline` (vehicle DEMO-001 + chofer demo + 1 ruta inicial)
5. ✅ Corre `logistics_baseline.js` importer (96 destinos + 26 períodos + 23 config)
6. ✅ Reporta status final: tablas creadas, schemas, tenants activos

Tiempo estimado: **~30-60 segundos** (depende de latencia Railway).

---

## Paso 3 — Migrar data legacy histórica

```bash
# Setear ambas env vars (legacy origen + nueva destino)
export LEGACY_DATABASE_URL="postgresql://postgres:GlUi...@switchback.proxy.rlwy.net:16885/railway"
export DATABASE_URL_NEW="postgresql://postgres:NEW_PASSWORD@NEW_HOST.proxy.rlwy.net:NEW_PORT/railway"

# Dry-run primero (cuenta rows que se migrarían sin escribir)
node database/migrate-legacy-to-newdb.js --dry-run

# Si el dry-run muestra los números esperados → correr real
node database/migrate-legacy-to-newdb.js
```

**Qué migra**: users + role_permissions + stores + zones + brands + products + catalogs + visits + daily_captures + exhibitions + exhibition_photos + scoring_config + daily_assignments.

**Tenant asignado a toda la data**: Mega Dulces (`00000000-0000-0000-0000-00000000d01c`).

**Resultado esperado** (basado en sub-sprint A.0mt.4): ~1804/1830 rows migradas (98.6%). Los 26 skips son FKs huérfanas conocidas en data legacy (registros con `created_by` apuntando a usuarios que ya no existen).

---

## Paso 4 — Verificar diff post-migración

```bash
# Re-correr el diff para confirmar que ahora ambas DBs están sincronizadas
DATABASE_URL_NEW="<URL nueva>" node database/diff-railway-vs-local.js
```

Esperado:
- Schemas faltantes: 0
- Tablas faltantes: 0 (o pocas tablas legacy `public.products_backup_*` que no se migran)
- Migraciones faltan aplicar: 0

---

## Paso 5 — Configurar env vars de la API en Railway

Ir al **servicio API** en Railway → **Variables** → agregar/editar:

```bash
# ──────────────────────────────────────────────────────────────
# CONEXIONES A LA NUEVA DB — REQUIERE 2 URLs (postgres + app_runtime)
# ──────────────────────────────────────────────────────────────

# 1) Admin pool (rol postgres) — usado SOLO por:
#    - migraciones (knex migrate:latest en start.sh)
#    - REFRESH MATERIALIZED VIEW (cron analytics)
DATABASE_URL_NEW=postgresql://postgres:NEW_PASSWORD@NEW_HOST.proxy.rlwy.net:NEW_PORT/railway

# 2) Runtime pool (rol app_runtime) — usado por TODOS los endpoints multi-tenant.
#    CRÍTICO: sin esta var, KNEX_NEW_DB cae al fallback LAN .245
#    y todos los endpoints multi-tenant fallan en producción.
#
#    Construcción manual del URL después del Paso 2 (migraciones aplicadas):
#    Reemplazar 'postgres' por 'app_runtime' y usar APP_RUNTIME_PASSWORD.
DATABASE_URL_NEW_RUNTIME=postgresql://app_runtime:APP_RUNTIME_PASSWORD@NEW_HOST.proxy.rlwy.net:NEW_PORT/railway

# 3) Password del rol app_runtime — leído por la migración 003.
#    Si NO se setea antes de correr migraciones, el rol queda con password
#    default 'app_runtime' (inseguro). En prod siempre setear.
APP_RUNTIME_PASSWORD=<password_fuerte_aqui>

# ──────────────────────────────────────────────────────────────
# TOGGLES Y SECRETOS
# ──────────────────────────────────────────────────────────────

# Toggle: activa todos los módulos multi-tenant + JwtAuthGuard global
ENABLE_MULTITENANT=true

# JWT secret REAL (NO usar el default 'super_secret_dev_key_change_in_prod')
# Generar uno fuerte: openssl rand -base64 32
JWT_SECRET=<TU_SECRET_REAL_AQUI>

# Cloudinary (si vas a usar fotos de logística)
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# Opcional: Voyage AI para K (AI product match)
VOYAGE_API_KEY=...

# Opcional: Anthropic API para K (AI extraction)
ANTHROPIC_API_KEY=...
```

⚠️ **DEJAR la `DATABASE_URL` antigua intacta** si la legacy aún sirve algún tráfico. Si vas full cutover, podés eliminarla.

### Verificar que la API arranque con las 2 conexiones

En el log de boot deberías ver:

```
[DatabaseModule] Connecting to legacy DB via DATABASE_URL (env=production)
[NewDatabaseModule] Connecting to new multi-tenant DB at <from DATABASE_URL_NEW_RUNTIME>
[NewDatabaseModule:Admin] Admin (postgres) Knex connection lista para mantenimiento
```

Si ves:
- `Connecting to new multi-tenant DB at 192.168.0.245:5432/postgres_platform (fallback)` → **DATABASE_URL_NEW_RUNTIME no está seteado**, fix antes de seguir.
- `DATABASE_URL_NEW no seteado` → cron analytics no podrá refrescar MVs (no crítico para boot).

---

## Paso 6 — Restart del servicio API

Railway → servicio API → **Deployments** → **Redeploy** (o automático si está conectado a git).

Verificar logs:
- `[Nest] Application successfully started`
- Sin errores de `current_tenant_id is not a function` (eso indicaría que la DB nueva no aplicó la migración 1)

---

## Paso 7 — Smoke test contra Railway prod

```bash
# 1. Login
curl -X POST https://<api>.up.railway.app/api/auth-mt/login \
  -H "Content-Type: application/json" \
  -d '{"tenant_slug":"mega_dulces","username":"superoot","password":"superoot"}'

# Debería devolver:
# {"access_token":"eyJ...","user":{"username":"superoot","role_name":"superadmin",...}}

# 2. Con el token, probar un endpoint multi-tenant
TOKEN="<el access_token de arriba>"
curl https://<api>.up.railway.app/api/commercial/customers \
  -H "Authorization: Bearer $TOKEN"

# Debería devolver lista de customers (incluye DEMO-001 del seed + cualquiera migrado del legacy)
```

---

## Paso 8 — Frontend deploy

El frontend (apps/view) se sirve desde el mismo servicio API (vía `ServeStaticModule`). El build incluye:
- Bundle con `/logistica/*`, `/comercial/*`, `/televenta/*`, `/portal/*`, `/vendor/*`
- Apunta a `environment.apiUrl` (debe ser el dominio de la API en Railway)

Verificar:
- `apps/view/src/environments/environment.prod.ts` tiene `apiUrl: 'https://<api>.up.railway.app/api'`
- Si no, editá + commitéa + push → Railway redeploya.

---

## 🚨 Rollback (si algo falla)

La estrategia con DB nueva en paralelo permite rollback trivial:

1. En Railway → servicio API → Variables:
   - Quitar `ENABLE_MULTITENANT=true` (o ponerlo en `false`)
   - Quitar `DATABASE_URL_NEW`
2. Redeploy.
3. La API vuelve al modo legacy single-tenant usando la DB legacy original (intacta).

La DB nueva queda en standby. Para limpiarla:
```bash
# Solo si querés borrar completamente la DB nueva para empezar de cero
DROP DATABASE postgres_platform;
```

---

## Post-cutover — mantenimiento

| Item | Cuándo |
|---|---|
| Confirmar que la app legacy sigue OK durante 1 semana | Continuo |
| Migrar visitas / captures nuevas que se generen en legacy mientras estuvo en transición | Si aplicable |
| Eliminar DB legacy (`DROP DATABASE railway;`) | Después de 1 mes de estabilidad |
| Limpiar env var `LEGACY_DATABASE_URL` | Cuando se elimine la DB legacy |
| Renombrar `knexfile-newdb.js` → `knexfile.js` y archivar el viejo | Sprint dedicado de cleanup |

---

## Troubleshooting

### Error: `relation "public.tenants" does not exist`
La migración 1 (`20260526000001_init_tenants_and_extensions.js`) no se aplicó.
Re-correr: `npx knex migrate:latest --knexfile database/knexfile-newdb.js --env production`.

### Error 401 con `'Falta header Authorization: Bearer <token>'`
El JwtAuthGuard global está activo. Asegurate que el frontend está mandando el Bearer en todas las requests (excepto `/auth-mt/login` que está marcado `@Public()`).

### Error 500 con `'current_tenant_id() is not setup'`
La función `current_tenant_id()` no se creó. La migración 1 la crea. Verificar:
```sql
SELECT proname FROM pg_proc WHERE proname = 'current_tenant_id';
```
Si no devuelve nada, re-correr la migración.

### Error: `app_runtime role does not exist`
La migración 3 (`20260526000003_create_app_runtime_role.js`) no se aplicó. Re-correr migraciones.

### El cron de alerts/recommendations no corre
Son `@Cron('*/5')` y `@Cron('0 0 9 * * *')`. Verificar logs del API en Railway. Si no aparecen, falta `ScheduleModule.forRoot()` en AppModule (ya está agregado pero verificar).

---

## Resumen de comandos (cheat-sheet)

```bash
# Setup (local — para correr migraciones contra Railway)
export DATABASE_URL_NEW="postgresql://postgres:NEW@NEW_HOST:NEW_PORT/railway"
export APP_RUNTIME_PASSWORD="<password_fuerte>"
export LEGACY_DATABASE_URL="postgresql://postgres:GlUi...@switchback.proxy.rlwy.net:16885/railway"

# Cutover automático (aplica migraciones + crea rol app_runtime con APP_RUNTIME_PASSWORD)
node database/cutover-to-railway.js

# Migrar data legacy
node database/migrate-legacy-to-newdb.js --dry-run
node database/migrate-legacy-to-newdb.js

# Verificar
node database/diff-railway-vs-local.js
```

### Env vars que van en el servicio Railway de la API

```
DATABASE_URL=<URL_legacy_railway>                         # legacy (se mantiene)
DATABASE_URL_NEW=postgresql://postgres:...@HOST:PORT/db   # admin pool (cron)
DATABASE_URL_NEW_RUNTIME=postgresql://app_runtime:APP_RUNTIME_PASSWORD@HOST:PORT/db
APP_RUNTIME_PASSWORD=<password_fuerte>                    # del paso de migraciones
ENABLE_MULTITENANT=true
JWT_SECRET=<generado_con_openssl>
```

⚠️ Sin `DATABASE_URL_NEW_RUNTIME` la app arranca pero **todos los endpoints multi-tenant fallan** (auth-mt/login, /commercial/*, /logistica/*).
