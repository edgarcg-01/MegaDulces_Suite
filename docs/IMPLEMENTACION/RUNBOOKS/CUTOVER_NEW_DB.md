# Runbook: Cutover Railway → nueva DB multi-tenant

> Sprint A.0mt.5.3-7. Ejecutar SOLO cuando Fases A+B+C+D estén ✅ y A.0mt.4 local haya validado migración 98.6%.

---

## Cutover kit (scripts automatizados — 2026-05-26)

Estos 3 scripts orquestan el cutover. Todos requieren las env vars de Railway en local.

| Script | Cuándo | Qué hace |
|---|---|---|
| `database/cutover-preflight.js` | Fase 1 (T-24h) | Valida 8 categorías: env, conectividad legacy/new, schema, RLS forced, tenant seed, isolation, conteos legacy↔new, migraciones |
| `database/migrate-legacy-to-newdb.js` | Fase 2 (T-2h) y Fase 3 (T-0) | Migra/sincroniza data. Idempotente (`--dry-run` para preview) |
| `database/cutover-smoke-test.js` | Fase 4 (T+5min) | Valida API post-switch: auth-mt, commercial, analytics, portal, isolation, latencia |
| `database/cutover-rollback-check.js` | Fase rollback (si falla 4) | Valida legacy responde correcto post-revert |

---

## Pre-flight checklist (NO empezar sin esto)

- [ ] **Fases A+B+C+D ✅** (12/12 suites verde local — `node database/run-all-tests.js`).
- [ ] **A.0mt.4 ✅** (migración local 98.6%).
- [ ] **A.0mt.5.1 ✅** runbook revisado (este archivo).
- [ ] **A.0mt.5.2 ✅** `ENABLE_MULTITENANT=true` toggle probado local.
- [ ] **Backup completo de DB legacy Railway** (snapshot Railway dashboard + `pg_dump` local).
- [ ] **Ventana de mantenimiento comunicada** a Mega Dulces (~30 min total).
- [ ] **Plan de rollback documentado** y entendido.

---

## Variables env de Railway necesarias en local

Crear archivo `.env.cutover` (gitignored) con:

```bash
# Legacy actual prod
LEGACY_DATABASE_URL=postgres://postgres:****@switchback.proxy.rlw...:5432/railway

# Nueva DB Railway (postgres superuser para migrate + REFRESH owner)
DATABASE_URL_NEW=postgres://postgres:****@<host-newdb>.railway.app:5432/railway

# Nueva DB Railway (app_runtime user para validar RLS desde runtime)
DATABASE_URL_NEW_RUNTIME=postgres://app_runtime:****@<host-newdb>.railway.app:5432/railway

# Para la app en Railway (a setear ahí también)
APP_RUNTIME_PASSWORD=<password seguro generado>
JWT_SECRET=<secret nuevo prod>
```

Cargar con: `export $(cat .env.cutover | xargs)` (Linux/Mac) o `Get-Content .env.cutover | foreach { ... }` (PowerShell).

---

## Fase 1 — Preparación (sin downtime, T-24h)

### 1.1 Crear servicio Postgres nuevo en Railway
- Dashboard Railway → New → Postgres → nombre `postgres-platform`.
- Anotar host, puerto, password generados por Railway.

### 1.2 Setear envs en el servicio API existente
En Railway settings del servicio API, agregar:
```
DATABASE_URL_NEW=postgres://postgres:****@<railway_new_host>:5432/railway
DATABASE_URL_NEW_RUNTIME=postgres://app_runtime:****@<railway_new_host>:5432/railway
APP_RUNTIME_PASSWORD=<password seguro>
JWT_SECRET=<secret prod>
ENABLE_MULTITENANT=true
```

> **No tocar `DATABASE_URL` todavía** — sigue apuntando al legacy. El switch es Fase 3.10.

### 1.3 Aplicar migraciones a la nueva DB Railway
Desde local con `.env.cutover` cargado:
```bash
# Crear app_runtime + grants
NODE_ENV=production DATABASE_URL_NEW=$DATABASE_URL_NEW \
  npx knex migrate:latest --knexfile database/knexfile-newdb.js

# Seeds canónicos (tenants, role_permissions, demo customer, etc.)
NODE_ENV=production DATABASE_URL_NEW=$DATABASE_URL_NEW \
  npx knex seed:run --knexfile database/knexfile-newdb.js
```

### 1.4 Pre-flight automatizado
```bash
node database/cutover-preflight.js
```
**Esperado**: exit 0, todos los checks OK. Si rojo → resolver antes de continuar.

---

## Fase 2 — Migración data legacy → nueva DB Railway (T-2h)

### 2.1 Dry-run (NO escribe nada, solo cuenta)
```bash
node database/migrate-legacy-to-newdb.js --dry-run
```
**Esperado**: report de cuántas rows se intentarían migrar por tabla. Comparar con conteos esperados.

### 2.2 Migración real
```bash
node database/migrate-legacy-to-newdb.js
```
**Esperado**: 98%+ match en data core. Skips por FK huérfanas en legacy son normales (~1-2%).

### 2.3 Re-correr preflight con conteos actualizados
```bash
node database/cutover-preflight.js
```
Ahora los conteos legacy↔new deben matchear ≥95%.

---

## Fase 3 — Ventana de mantenimiento (T-0, downtime ~5 min)

### 3.1 Modo mantenimiento en frontend
Opciones:
- Banner global "Actualización en curso" desde un feature flag (preferido).
- O detener temporalmente el deploy del view en Railway.

### 3.2 Sync delta final (data nueva creada entre Fase 2 y ahora)
```bash
node database/migrate-legacy-to-newdb.js
```
Idempotente (onConflict ignore), solo agrega lo nuevo. Generalmente <50 rows si la ventana fue corta.

### 3.3 Switch DATABASE_URL en Railway
En Railway settings del servicio API:
- Variable `DATABASE_URL` → cambiar al string de la **nueva DB**.
- Mantener `ENABLE_MULTITENANT=true` (ya seteado en Fase 1).

### 3.4 Railway auto-redeploy
El container reinicia solo al cambiar la env. Esperar ~30-60s hasta que `railway logs` muestre `Nest application successfully started`.

---

## Fase 4 — Validación post-cutover (T+5 min)

### 4.1 Smoke test automatizado
```bash
API_BASE=https://<tu-api>.up.railway.app/api \
  node database/cutover-smoke-test.js
```
**Esperado**: exit 0, ~20 checks OK. Si falla **cualquier check crítico** → ROLLBACK inmediato.

### 4.2 Smoke manual desde browser
- [ ] Login portal (`/portal/login` con `cliente_demo`).
- [ ] Catálogo carga con productos del cliente.
- [ ] Crear pedido demo.
- [ ] Login admin (`/login` con tu cuenta real).
- [ ] Reportes/captures cargan data legacy migrada.

### 4.3 Monitoreo Railway (primeros 15 min)
- [ ] Memoria estable (no >80% sostenido).
- [ ] Sin restarts del container.
- [ ] `railway logs` sin errores 5xx repetitivos.

### 4.4 Quitar modo mantenimiento
- Banner OFF / view re-deploy si aplicó.

---

## Fase 5 — Cleanup (T+24h hasta T+30d)

- [ ] **T+1h**: bandera DB legacy en `read-only` (vía SQL):
  ```sql
  ALTER DATABASE legacy SET default_transaction_read_only = true;
  ```
- [ ] **T+24h**: revisar Sentry / Railway logs sin spike de errores.
- [ ] **T+7d**: snapshot adicional + cleanup data obsoleta.
- [ ] **T+30d** sin issues: eliminar servicio Postgres legacy en Railway.

---

## Plan de rollback (si falla en Fase 4)

### Quick rollback (~3 min)
1. En Railway settings, **revertir `DATABASE_URL`** al string del legacy.
2. Railway auto-redeploy. Esperar ~60s.
3. Correr validador:
   ```bash
   API_BASE=https://<tu-api>.up.railway.app/api \
   ROLLBACK_TEST_USER=<capturista_test> \
   ROLLBACK_TEST_PASS=<password> \
     node database/cutover-rollback-check.js
   ```
4. **Si OK**: confirmar smoke manual (login + reportes). Quitar mantenimiento.
5. **Postmortem** documentado en `03_LOG_REVISIONES.md` con causa raíz.

### Importante
- NO descartar la nueva DB tras rollback — la data ya migrada queda intacta.
- Investigar la causa, fixear, y reintentar el cutover en otra ventana.
- La data nueva creada DESPUÉS del rollback queda en legacy. Próximo cutover deberá re-sync delta otra vez.

---

## Criterios de éxito

- ✅ Downtime ≤ 5 min real.
- ✅ Smoke test pasa exit 0.
- ✅ Sin pérdida de data (conteos match post-migración).
- ✅ Performance similar o mejor (login <2s, endpoints <1s).
- ✅ 24h sin restarts ni spike de errores.

---

## Comandos útiles durante el cutover

```bash
# Logs Railway en vivo
railway logs --service api

# Conectar a DB nueva
psql $DATABASE_URL_NEW

# Validar tenant data
SELECT slug, nombre, activo FROM tenants;
SELECT COUNT(*) FROM users; -- sin contexto = 0 (RLS); con SET app.tenant_id = X = N

# Validar RLS forced en todas las tablas
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relkind='r' AND relnamespace IN ('public'::regnamespace, 'commercial'::regnamespace);

# Validar runtime user
SELECT current_user; -- debe ser app_runtime
SELECT * FROM pg_roles WHERE rolname='app_runtime';
```

---

## Notas críticas para el dev

- **Rol `app_runtime` es CRÍTICO**. Si el API se conecta como `postgres`, **RLS no aplica** y data cross-tenant queda expuesta. `cutover-preflight.js` lo valida explícitamente.
- **Migraciones nuevas** deben correrse como `postgres` (necesitan CREATE/ALTER); el runtime del API SIEMPRE como `app_runtime` (via `DATABASE_URL_NEW_RUNTIME`).
- **Si aparece "permission denied" en runtime post-migración**: falta GRANT en tabla nueva. Re-correr `20260526000003_create_app_runtime_role.js` (idempotente).
- **Webpack hoisting trap**: cualquier env var leída a top-level de un módulo se evalúa antes de `dotenv.config()`. Siempre leer `process.env` dentro de funciones / `useFactory` lazy. Bug vivido 2026-05-26 con `database.module.ts`.
- **JWT secret**: en local default es `super_secret_dev_key_change_in_prod`. En Railway **OBLIGATORIO** un secret distinto (rotación).
