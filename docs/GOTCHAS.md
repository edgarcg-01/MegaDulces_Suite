# GOTCHAS y lecciones — conocimiento tribal del proyecto

> Cada entrada nació de un bug ya vivido (varios tumbaron producción). Léelo antes de tocar
> DB, permisos, migraciones o dinero. Si te pegas con algo nuevo no listado, **agrégalo aquí**
> en el mismo PR — este archivo es la memoria compartida del equipo.
>
> Fuente: consolidado de la memoria de trabajo con Claude (antes vivía solo en la máquina del lead).
> Los file:line pueden estar desactualizados — verificá contra el código actual antes de asumir.

---

## 1. Multi-tenant / RLS (la trampa #1 del proyecto)

Las tablas de `commercial.*`, `analytics.*` y `logistics.*` tienen **`FORCE ROW LEVEL SECURITY`** con policy
`USING (tenant_id = current_tenant_id())`. Sin el contexto de tenant seteado, `current_tenant_id()` es `NULL`
→ la policy devuelve **0 rows sin error**. Es invisible en logs: no hay excepción, solo un result set vacío.

**Síntoma:** un endpoint devuelve `[]` cuando debería tener data → **lo primero que hay que revisar.**

**Regla:**
- **Request handlers (controllers HTTP):** inyectar `TenantKnexService` y envolver cada operación en
  `.run(async (trx) => { ... })`. Eso abre transacción + `SET LOCAL app.tenant_id` (leído del
  AsyncLocalStorage que puebla el `TenantContextInterceptor`).
- **Cron cross-tenant** (sin contexto HTTP): inyectar `KNEX_NEW_DB_ADMIN` (corre como `postgres`, **bypassa RLS**).
  Solo para jobs internos que tocan a todos los tenants. **Nunca** exponerlo a un controller.
- **Cron scoped por tenant:** enumerar tenants con el admin y por cada uno abrir trx con `SET LOCAL app.tenant_id`.
- **Nunca** inyectar `KNEX_NEW_DB` (sin admin) en un controller sin `TenantKnexService.run()`.

**Conexión legacy (`KNEX_CONNECTION`, user `postgres`) bypassa RLS** → ahí el aislamiento por tenant
**no** viene de la policy: hay que filtrar `tenant_id` **explícito** en cada query. Cualquier query a
`role_permissions` (read o write) DEBE llevar `tenant_id`; un `.first()` sin él devuelve una fila arbitraria
de otro tenant.

---

## 2. Transacciones — el request entero va en UNA trx

Con `ENABLE_MULTITENANT=true`, el interceptor envuelve **toda request autenticada en una sola transacción**.
En Postgres, un error en cualquier statement **aborta la transacción entera**.

**Consecuencia:** un `try/catch` que **traga** un error de DB (23505, 42P01, etc.) y **sigue queryeando** en la
misma request tira `25P02` ("current transaction is aborted"). Y si no hay query posterior, el COMMIT hace
**rollback silencioso**: el usuario recibe 200 OK pero **nada se persiste**.

**Regla:** todo query opcional / best-effort dentro de una request va por **SAVEPOINT** (`trySavepoint` →
`ROLLBACK TO SAVEPOINT` sin abortar la trx), **nunca** `try/catch` pelado. Para audit logs que deben sobrevivir
al rollback: conexión separada con su propio `SET LOCAL app.tenant_id`.

**Relacionado:** recrear una vista que la app consulta en caliente (`DROP+CREATE`, o incluso `CREATE OR REPLACE`)
invalida los planes cacheados de las conexiones vivas → `0A000 'cached plan must not change result type'` → si un
catch lo traga, `25P02`. Es transitorio (se cura al reciclar el pool) pero rompe operaciones en vuelo. Protegé el
dbWork con SAVEPOINT.

---

## 3. Migraciones Knex — la trampa que tumba el deploy

- **Nunca borrar / renombrar una migración ya aplicada.** El start de prod corre `knex migrate:latest`, que
  valida `knex_migrations` (registros) vs los archivos de la imagen. Un registro sin archivo →
  `"The migration directory is corrupt, the following files are missing: X"` → **crash loop → prod caída.**
- **Nunca insertar filas en `knex_migrations` a mano.** Mismo resultado si el archivo no está en el deploy.
  Para que una tabla exista en prod ya: correr solo `mig.up(knex)` (sin registrar). Cuando el archivo llegue a
  `main`, `migrate:latest` lo corre y el guard idempotente lo vuelve no-op.
- **Toda migración lleva guard idempotente al inicio:** `if (await knex.schema.hasColumn(...)) return;` /
  `hasTable`. Siempre.
- Si prod ya crasheó por un registro huérfano: `DELETE FROM knex_migrations WHERE name='<archivo>.js'`
  (borra el registro, **no** la tabla ni el archivo).
- **3 devs = timestamps que chocan.** Coordiná el nombre/timestamp de migraciones nuevas; no reordenar.

---

## 4. Permisos / authz — agregar un permiso son 6 touch-points

Al agregar un valor al enum `Permission`, si no lo mapeás en todos lados el endpoint tira
`403 "No tienes los permisos dinámicos necesarios"` para todo rol sin `manage:all` (superadmin pasa siempre).

1. **Backend enum** `libs/platform-core/.../constants/permissions.ts`.
2. **Backend `ability.factory.ts`** — AMBOS mapas: `permissionToSubject` + `permissionToAction`. (Y el union
   `AppSubject` en `ability.types.ts` si es un subject nuevo.)
3. **Gate del endpoint** con `@RequirePermissions(Permission.X)`.
4. **Frontend enum** `apps/view/.../core/constants/permissions.ts` (copia separada, mantener en sync).
5. **Frontend** `permission-meta.ts` (label/description/category) + `authz-tree.ts` (para que aparezca como
   checkbox en `/admin/roles`).
6. **Frontend gating del botón:** `perms.can('manage','all') || auth.user()?.permissions?.[Permission.X] === true`
   — el `manage:all` es **obligatorio** o los admin pierden el botón (su JSONB no enumera la clave nueva).

**El `RolesGuard` es EXACT-KEY** (`permissions[perm] === true`): un sub-permiso restrictivo (`COMPRAS_VALIDAR`)
NO lo hereda quien tiene el hermano amplio (`COMPRAS_GESTIONAR`). Eso permite separar "validar" de "gestionar".

**Rollout restrictivo** (que NO todos tengan): no lo pongas en el preset ni en seed → sin migración; se asigna a
mano en `/admin/roles`. **Rollout por-default a un rol existente:** backfill idempotente con
`permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB — knex no lo escapa). Correr solo el UPDATE contra
prod, sin registrar en `knex_migrations` (§3).

**Siempre después de otorgar un permiso: RE-LOGIN.** El permiso vive en el JWT armado al login; las sesiones
abiertas no lo ven hasta cerrar y volver a entrar. (El backend sí lo lee fresco vía permsCache TTL ~30s.)

**Regla dura de vistas:** cada vista debe ser 100% funcional con SUS permisos — incluidos los endpoints que
**llenan sus filtros** (lookups de sucursal, marca, proveedor…). Un lookup compartido entre varias vistas usa
`@RequireAnyPermission(...)`, no el permiso de una sola. Probar con un **rol de permiso mínimo**, no con admin
(`manage:all` oculta el bug). **Nunca** tragar el 403 de un lookup con `error: () => undefined` → parece "sin
datos" cuando es "sin permiso".

---

## 5. Knex — gotchas de sintaxis

- **`?` literal dentro de `knex.raw()`** se interpreta como placeholder de binding, aunque esté entre comillas SQL
  → `42P18: could not determine data type of parameter $1` → 500. Ej: `raw("COALESCE(x,'?')")` revienta.
  No pongas `?` en literales; los bindings reales van como `raw('col ILIKE ?', [val])`.
- **Validá los queries de knex ejecutándolos VÍA KNEX**, no con `pg` directo: el bug del `?` solo aparece por knex.
- Operador `?` de JSONB en knex.raw → mismo problema; usá `permissions -> 'KEY' IS NULL`.

---

## 6. Dinero

Los `numeric` de Postgres llegan como **STRING** por JSON. `String.prototype.toLocaleString('es-MX',
{ style:'currency' })` **ignora** las opciones de currency → sale sin `$` ni comas. Un `Number` sí las respeta.

**Regla:** todo helper de dinero coerciona primero:
`(Number(v ?? 0) || 0).toLocaleString('es-MX', { style:'currency', currency:'MXN', maximumFractionDigits:0 })`.
Nunca `(v || 0).toLocaleString(currency)` con `v: number` declarado — el tipo miente, en runtime es string.
Cantidades / piezas NO son dinero → `| number` sin `$`.

---

## 7. Cron / timezone

El contenedor de prod corre en **`TZ=America/Mexico_City`** (no UTC). Un `@Cron('0 0 3 * * *')` **sin** `timeZone`
usa la hora local del proceso = MX. Los crons viejos escritos asumiendo UTC (`'0 0 9' = 3AM MX`) disparan a las
**9 AM MX** — 6h tarde, en hora pico, y llegaron a tumbar la API (pool saturado → 504/502).

**Regla:** todo `@Cron` con hora fija lleva `{ timeZone: 'America/Mexico_City' }` y la hora en wall-clock MX.
Los intervalos (`*/5`, `*/15`) no dependen de TZ. Escaloná los batches pesados de madrugada.

---

## 8. Verificar builds y tests (no te mientas a vos mismo)

- **Nunca pipear `nx build` a `tail`/`grep`.** El exit code que ves es el del pipe (tail/grep casi siempre
  salen 0), NO el de nx. Un build FALLIDO reporta "exited with code 0" → commiteás código roto. (Pasó:
  commit `553d1704` shippeó con `NG8002`/`TS2339` reales.) Corré `npx nx build <proj> --skip-nx-cache` **sin
  pipe** y leé el output buscando `Successfully ran target build` y que no haya `NG8002`/`error TS`/`ERROR in`.
  (`NG8113 ... is not used` son warnings inofensivos.)
- **La regression suite es la fuente de verdad de "cerrado", no las notas.** Antes de declarar una fase verde,
  corré `npm run regression`. Docs/tracker de >3 días atrás no son confiables (una vez reportaban 19/19 y al
  re-correr salieron 12/19).
- El happy-path con `superoot` (`manage:all`) oculta bugs de permisos. Probá con un rol de permiso mínimo.

---

## 9. Git / workflow

- **Nunca `git add -A` / `git add .`** en este repo: el working tree suele tener trabajo concurrente sin
  commitear + dumps SQL grandes sueltos → barrés archivos ajenos y binarios gigantes a tu commit. Stageá
  **paths explícitos**.
- Deshacer un commit con archivos de más: `git reset --mixed HEAD~1` → re-stagear solo lo tuyo → re-commitear.
- Commiteá tu trabajo verde **de inmediato** con paths explícitos, aunque sea a mitad de tarea. (El entorno tiene
  automatización de git que a veces **revierte** lo no commiteado.)
- Flujo de equipo: rama por feature + PR + review + CI verde. `main` protegida. Ver [ONBOARDING.md](../ONBOARDING.md) §8.

---

## 10. Arrancar la API en Windows

`nx serve api` (`npm run api`) falla en Windows con `spawn ENAMETOOLONG` (la línea de comando excede el límite).
Usar:
```
npx nx build api && node dist\apps\api\main.js
```
Boot OK cuando loguea `Nest application successfully started`. El puerto es **3334 fijo** (ignora `PORT=`).
Un proceso viejo del API queda **stale** (no recarga código nuevo) → endpoints nuevos dan 404 aunque el build
esté verde → reiniciá el proceso. `npm run api:dev` (node --watch) también evita el ENAMETOOLONG con auto-recarga.

---

## 11. Soft-delete — columna `activo` GENERATED

En el schema multi-tenant, 12 tablas de `public.*` (`catalogs`, `zones`, `visits`, `daily_captures`,
`role_permissions`, `scoring_*`, `exhibitions`, `exhibition_photos`, `rubric_levels`, `daily_assignments`)
tienen `activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED`. **Solo se puede LEER, no escribir.**
Un `insert/update({ activo: ... })` tira error → bug silencioso.

- Soft-delete: `.update({ deleted_at: knex.fn.now() })`.
- Reactivar: `.update({ deleted_at: null })`.
- Filtrar activos: `.whereNull('deleted_at')`.

Las tablas con `activo` **real** (no GENERATED) — `users`, `stores`, `tenants`, `brands`, `products`, todas las
`commercial.*` y `logistics.*` — usan el write tradicional `.update({ activo: false })`.

---

## 12. TypeScript — `typescript` sigue en 6.0.3 aunque el latest sea 7.x

TypeScript 7 es el compilador reescrito en **Go**. **No se puede** subir el `typescript` del workspace:
el paquete `typescript@7` ya no exporta la API JS del compilador (sus `exports` son `.` → `lib/version.cjs`
y `./unstable/*`), y **Angular AOT, `ts-jest` y el lint tipado consumen esa API**. Los peers lo bloquean
explícitamente:

| Paquete | peer `typescript` |
|---|---|
| `@angular/compiler-cli` 22.x | `>=6.0 <6.1` |
| `ts-jest` 29.x | `>=4.3 <7` |
| `typescript-eslint` 8.x | `>=4.8.4 <6.1.0` |

`6.0.3` es el último de la línea 6.x — no hay nada que bumpear. Se reevalúa cuando Angular libere soporte.

**Lo que sí corre hoy:** `npm run typecheck:fast` = `tsgo` (mismo compilador Go, paquete
`@typescript/native-preview`, bin `tsgo` → **no choca** con el bin `tsc` de TS 6) sobre
[`tsconfig.ts7.json`](../tsconfig.ts7.json). Cubre api + libs de backend (3,524 archivos): **~15 s vs ~35 s**
del `tsc` actual, 0 errores, exit code correcto (1 si hay error) → usable en CI. **No participa de ningún build.**

`tsconfig.ts7.json` es standalone a propósito: TS 7 **removió `baseUrl`** (`TS5102`) y exige `paths`
relativos (`./libs/...`, si no `TS5090`), así que no puede extender `tsconfig.base.json`. Si cambian los
`paths` de la base, replicarlos ahí.

---

## 13. Feeds on-prem — "tarea Running" NO significa que el feed corra

Los loops del CDC del ODS (`\Tienda\OdsLiveLoop`, `\Tienda\OdsFullMirror`) son un `.cmd` con `:loop` que
relanza `node` cada iteración. Si el `node` se cuelga, **la tarea sigue en `Running` y el proceso sigue
vivo** — se ve todo sano y no se está replicando nada. Pasó: 2 días congelado (24-ago 05:18 → 26-ago),
con `kepler_ods` viejo en prod y con él **toda la capa derive-no-copy** que cuelga de ahí.

**La señal real es el `mtime` del log, no el estado de la tarea ni el proceso:**

```bash
ls -l --time-style=+%Y-%m-%d_%H:%M /c/KeplerRunner/logs/*.log     # ¿cuál se quedó atrás?
```

Confirmación: si el proceso lleva minutos vivo con ~0s de CPU, está colgado, no trabajando.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'replicate-ods-live' } |
  ForEach-Object { "pid={0} arrancado={1:HH:mm} cpu_s={2}" -f $_.ProcessId, $_.CreationDate, [math]::Round($_.UserModeTime/1e7) }
```

**Arreglo:** matar el `node`. El `:loop` del `.cmd` sigue vivo esperándolo → arranca pasada nueva solo.
No hace falta reiniciar la tarea.

**Frescura del lado destino** (lo que hay que mirar para saber si prod está al día):

```sql
SELECT count(*) FROM kepler_ods._sync_status WHERE last_push_at > now() - interval '10 min';
```

Ojo con dos cosas al diagnosticar:
- El `FeedGuardian` **no** cubre estos loops (vigila los modos de `run-feeds.cmd`), así que nadie avisa.
- `{"code":404,"message":"Application not found"}` es el **edge de Railway**, no `feeds-ingest` (la app
  responde `{"error":"not found"}`). Para saber si la app está viva: `POST /ingest/raw-upsert` sin key
  debe dar **401**; un 404 ahí sí es la app caída.

## 14. Espejo de feeds a la réplica de pruebas (`FEEDS_MIRROR_URL`)

`lib/sink.js` puede aplicar cada changeset a una **segunda** DB además del destino primario (una lectura
del origen local → dos destinos). Hoy: `192.168.0.245:5432/platform_test` (estructura de prod, sin data).

- Se prende con `FEEDS_MIRROR_URL` en `.env` (cubre los loops del ODS, que sí cargan dotenv) y en
  `C:\KeplerRunner\run-feeds.cmd` (para `import-branch-stock-live` / `-goods-receipts` / `-purchase-docs`,
  que **no** cargan dotenv — y así debe quedar: con dotenv, una corrida manual apuntaría a la copia stale
  de `localhost:5433` en vez de fallar).
- Es **best-effort**: si el espejo falla, el feed primario sigue igual. Quitar la env = rollback total.
- Al agregar un `Client` de pg de larga vida a un importer, **`unref()` el socket** o el proceso no termina
  nunca (los importers cierran con `process.exitCode`, no `process.exit()`) → ver gotcha #13.
- Solo replica **hacia adelante**: el watermark ya viene avanzado, la réplica no tiene historia.
- Smoke: `node database/importers/_smoke-sink-mirror.js` (7 aserciones, no toca prod).

## 15. `run-prod-feeds.js` — un step `[ruta, ...flags]` puede matar el modo entero

Una entrada de `STEPS` puede ser una ruta **o** `[ruta, ...flags]`. El archivo tiene `pathOf(entry)`
para eso, pero cualquier función que use la entrada cruda con `path.basename()` tira
`ERR_INVALID_ARG_TYPE` **antes de correr el primer paso** → el modo completo muere al arrancar.

Ya pasó: el commit que agregó el primer step-array (24-ago-2026) dejó el **`nightly` de prod sin
correr el 25 y el 26** — dos noches sin `sales_daily`, `import-margin`, `sales_monthly`,
`inventory-health`, `reorder-policy` ni DRP. Nadie se enteró: el runner sale con código ≠ 0 pero
**nada mira el resultado del nightly**.

Al tocar `STEPS` o cualquier helper que lo recorra: **siempre `pathOf(s)`**, nunca la entrada cruda.
Y para verificar que un modo arranca, alcanza el dry-run (sin `--apply`):

```bash
node database/importers/kepler/run-prod-feeds.js <modo> | head -3
```

## 16. Trampas chicas de los feeds on-prem (ya vividas)

- **`psql.exe` escribe CRLF.** Un `psql -tAc "select relname …" > lista.txt` deja `\r` pegado a cada
  nombre; después `pg_dump -t` "no encuentra tablas" y el `TRUNCATE` dice "no existe la relación".
  Pasar siempre por `tr -d '\r'`.
- **El réplica lógico de la sucursal 03 se llama `kepler_pilot`** (nombre del piloto, rename
  diferido), no `kepler_md_03`. Existe además un `md_03` que es un **sobrante congelado en junio**:
  usarlo da data vieja sin ningún error. La resolución canónica está en `localDbName()` de
  `replicate-ods-live.js`.
- **`sslmode=no-verify` no existe en libpq.** Es cosa de node-postgres. Para `psql`/`pg_dump` contra
  el proxy de Railway va `sslmode=require`.
- **Editar un `.cmd` que está corriendo** corre el offset de lectura de `cmd.exe` y puede hacerle
  ejecutar un fragmento partido. Si el cambio es un reemplazo de **igual largo** (p. ej. rotar una
  key por otra del mismo tamaño) no se mueve ningún byte y es inofensivo. Si cambia el tamaño:
  detener la tarea, editar, arrancar.
- **`session_replication_role = replica`** (como superuser) apaga triggers y chequeo de FK — sirve
  para cargas masivas sin pelear el orden entre tablas. Lo que **no** apaga son los índices UNIQUE.

## 17. `DATABASE_URL_NEW` tiene DOS roles — y moverla calla el CDC

Esa var significa dos cosas distintas según quién la lee:

| Quién | Para qué la usa |
|---|---|
| API (`new-database.module.ts`) | conexión **admin** (`KNEX_NEW_DB_ADMIN`, REFRESH de MVs) |
| `knexfile-newdb.js` | destino de las **migraciones** |
| `replicate-ods-live.js` / `ods-cdc-wal.js` | **BASE de la FUENTE**: de ahí derivan `kepler_md_XX` (los replicas lógicos del contenedor `:5433`) |

Ese tercer uso es la trampa. Si dev mueve `DATABASE_URL_NEW` para apuntar la app a otra base
(p. ej. la réplica de pruebas en `.245`), el CDC se va a buscar los replicas al server equivocado
y **se calla**: loguea `no conecta — skip` por rama y la pasada termina "bien" sin shipear nada.
`kepler_ods` en prod se congela en silencio y con él toda la capa derive-no-copy.

**Desde 2026-08-26 la fuente tiene env propia: `ODS_SOURCE_BASE`** (fallback a `DATABASE_URL_NEW`
por compatibilidad). Está fijada explícitamente en `run-ods-live-loop.cmd`,
`run-ods-full-mirror.cmd`, `run-ods-loop.cmd` y en `ecosystem.cdc.config.js` — ahí **sin** fallback
a `DATABASE_URL_NEW`, porque heredarla reintroduce la trampa.

Al mover la app a otra base, mover **las dos**:

- `DATABASE_URL_NEW_RUNTIME` → rol **`app_runtime`** (con RLS). NUNCA `postgres`: el runtime tiene
  que ejercitar RLS o los bugs de aislamiento entre tenants no aparecen en dev.
- `DATABASE_URL_NEW` → rol `postgres` (admin: migraciones + REFRESH MV).

Y verificar que el rol `app_runtime` existe **con la contraseña correcta** en el server destino: en
`.245` existía con una contraseña vieja del snapshot de junio y ninguna credencial de la máquina
servía. Sin eso el API no arranca contra esa base.

## 18. Rotar `FEEDS_INGEST_KEY` deja ciegos a los consumidores WAL (y su alerta también)

Los 7 `cdc-wal-XX` de PM2 heredaban la key **del shell del operador** al momento de
`pm2 start`. Al rotarla (Railway + los `.cmd` de KeplerRunner) esos procesos siguen con la
vieja en memoria → **`HTTP 401` en cada flush, cada 3 segundos**, con `pm2 ls` diciendo
`online`. Vivido el 2026-08-26.

Lo que lo vuelve traicionero: **el latido de esos consumidores viaja por el MISMO sink**. Si el
sink no autoriza, tampoco late — el dead-man's switch de Salud BD (`cdc_wal_00..06`) se queda
mudo exactamente cuando hace falta. Un sensor que depende del canal que vigila no sirve.

**Al rotar la key, la lista completa es:**

1. Railway (`railway variables -s feeds-ingest --set …`).
2. Los `.cmd` de `C:\KeplerRunner` (6 archivos). Generá la key nueva **del mismo largo** que la
   vieja: el reemplazo no mueve bytes y editar un `.cmd` en ejecución deja de ser riesgoso.
3. `.env` del repo (`FEEDS_INGEST_KEY`) — de ahí la lee `ecosystem.cdc.config.js`.
4. **`pm2 restart cdc-wal-00 … cdc-wal-06 --update-env`** + `pm2 save` (si no, un reboot
   resucita con la vieja).
5. Verificar: que los `*-error.log` de PM2 dejen de crecer **y** que `analytics.cron_runs`
   muestre `cdc_wal_0*` con `updated_at` fresco. Lo primero solo no alcanza.

`ecosystem.cdc.config.js` ahora carga el `.env` del repo y **lanza** si la key falta: fallar al
arrancar es mucho mejor que 7 procesos logueando 401 en silencio.
