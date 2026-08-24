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
