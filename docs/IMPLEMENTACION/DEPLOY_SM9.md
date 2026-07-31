# Runbook de deploy — SM.9 (arqueo↔cuadre + usuarios cajera + reglas de retiro)

> Paquete de la sesión 2026-07-30/31. Deploy a Railway prod (newdb `postgres_platform`). Mecanismo: push a `origin/main` → Railway build → `preDeployCommand: sh ./migrate.sh` aplica migraciones pendientes a la newdb (`ENABLE_MULTITENANT=true`) → redeploy api. Si una migración falla, el deploy queda **FAILED** y el deploy anterior **sigue sirviendo** (sin downtime).

## 1. Qué se despliega

**Migraciones nuevas (`database/migrations-newdb/`)** — se aplican solas vía `migrate.sh`:
| Archivo | Qué hace | Riesgo |
|---|---|---|
| `20260730120000_blind_counts_incidencia.js` | `+ incidencia_tipo` en `reconciliation.blind_counts` (CHECK) | bajo (ADD COLUMN idempotente) |
| `20260730130000_users_view_warehouse_code.js` | recrea vista `public.users` exponiendo `warehouse_code` | **ALTO — toca auth** (ver precond. 1) |
| `20260730140000_role_cajera.js` | rol `cajera` (STORE_ARQUEO_*) por tenant activo | bajo (INSERT NOT EXISTS) |

**Código (redeploy api + view)** — sin migración:
- 2 reglas motor SM (`barrido_diferencia_multiple`, `retiro_conteo_mismatch`) — se auto-registran vía `ensureRules` en el primer `scan`.
- Lazo arqueo↔cuadre (autolineado + WS `recon_bad_cut` + `RECON_NOTIFIER_PORT`).
- Frontend: tab Cortes columna "Arqueo ciego", `/tienda/arqueo` (selector incidencia + autofill cajero), causa labels.

**Seed manual (post-migración):** 28 usuarios `cajera` (`seed-cajera-users.js`).

## 2. Precondiciones — verificar en Railway ANTES de deploy

```sql
-- 1. CRÍTICA: la vista users falla si la tabla base no tiene la columna.
SELECT 1 FROM information_schema.columns
 WHERE table_schema='identity' AND table_name='users' AND column_name='warehouse_code';
-- Debe devolver 1 fila. (La agregó mig 20260702200000; verificar que esté aplicada en Railway.)

-- 2. El seed lee cortes: analytics.cash_cuts debe estar poblada en prod.
SELECT COUNT(*) FROM analytics.cash_cuts;   -- > 0

-- 3. Las 2 reglas leen Wincaja: si vacías NO fallan (0 hallazgos), pero no habrá señal.
SELECT COUNT(*) FROM wincaja.retiros;        -- ideal > 0
SELECT COUNT(*) FROM wincaja.arqueos;        -- ideal > 0 (30/32/50)
```

Si (1) devuelve 0 filas → **NO deployar** hasta aplicar/confirmar `20260702200000_users_warehouse_code.js` en Railway (o el deploy fallará al recrear la vista).

## 3. Secuencia de deploy

1. **Reconciliar git** — la rama local está `ahead 12, behind 4` y hay cambios sin commitear de otro thread (`apps/api/src/main.ts`, `.claude/settings.json`). Revisar `git log origin/main..HEAD` y `git status` antes; hacer `git pull --rebase` y resolver, cuidando no arrastrar cambios ajenos.
2. **Push a `origin/main`** → dispara build Railway → `migrate.sh` aplica las 3 migs (y cualquier otra pendiente) → redeploy api.
3. **Verificar deploy** healthy (`/api/health`) y migraciones aplicadas:
   ```sql
   SELECT name FROM knex_migrations WHERE name LIKE '2026073013%' OR name LIKE '2026073012%' OR name LIKE '2026073014%';
   -- deben aparecer las 3.
   ```
4. **Redeploy view** (frontend) si es servicio aparte.
5. **Seed de cajeras** (desde máquina con acceso al proxy Railway o la de feeds LAN):
   ```sh
   DATABASE_URL_NEW='postgres://…rlwy.net…?sslmode=no-verify' node database/scripts/seed-cajera-users.js          # dry-run
   DATABASE_URL_NEW='…' node database/scripts/seed-cajera-users.js --apply                                        # crea 28 usuarios
   ```
   Usuario = contraseña = código de caja en minúsculas (ej. `10c01`).
6. **Poblar hallazgos:** `POST /reconciliation/scan` (botón "Escanear ahora" en `/almacen/cuadre`) o esperar el cron 3:15 AM. Registra las reglas nuevas + genera los ~184 barrido + ~93 retiro_conteo.
7. **Re-login** de usuarios de tienda — el `warehouse_code` viaja en el JWT; sin re-login el scoping de sucursal no toma efecto.

## 4. Verificación post-deploy

- Login `10c01` / `10c01` → entra como `cajera`, `/tienda/arqueo` muestra sucursal fija + cajero autocompletado.
- `/almacen/cuadre` → **Descuadres** → aparecen hallazgos `barrido_diferencia_multiple` y `retiro_conteo_mismatch`.
- Capturar un arqueo ciego divergente sobre un corte existente → aparece descuadre al instante + toast WS al supervisor.
- Tab **Cortes** → columna "Arqueo ciego" muestra "corte malo / cuadra ciego / sin arqueo".

## 5. Rollback

- `incidencia` / `rol cajera`: `down` disponible (drop column / delete role). Seguro.
- **Vista users**: el `down` restaura la vista SIN `warehouse_code` — pero eso vuelve a romper el scoping de sucursal (bug que este deploy arregla). Solo revertir en emergencia real de auth.
- Reglas SM: sin migración → revert del commit de código + redeploy. Los hallazgos ya insertados quedan (triables/borrables por el supervisor).
- Usuarios cajera: `UPDATE identity.users SET deleted_at=now() WHERE role_name='cajera'` (soft-delete) si hay que deshacerlos.

## 6. Riesgos y notas

- La vista `users` es auth-crítica: un fallo marca el deploy FAILED pero **prod anterior sigue** (sin downtime). Por eso la precond. 1 es bloqueante.
- El seed crea **28 credenciales de empleadas** con user=pass=código — comunicar y idealmente forzar cambio después.
- `migrate.sh` aplica **todas** las migraciones pendientes, no solo estas 3 — revisar que las demás pendientes (de otros commits en la rama) también sean prod-safe antes de pushear.
- Reglas de retiro: solo requieren redeploy api + un `scan`. No dependen de las migraciones.

## Commits del paquete

`84947899` (lazo) · `e747b625` (usuarios cajera) · `bc584a68` (barrido) · `102c468f` (retiro_conteo) · docs `39e76c9e`/`52b77514`/`e5bf54d9`.
