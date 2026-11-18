---
name: capa-api
description: Capa C2 (API) de la suite — el endpoint NestJS que sirve y escribe datos. OBLIGATORIO antes de crear o cambiar un controller, un endpoint, un permiso, un guard, una consulta con RLS o cualquier escritura a base desde la API, y antes de afirmar que un endpoint "ya funciona". Cubre tenant_id + RLS (la trampa número 1), la transacción única por request y los savepoints, los 5 touch-points de un permiso (ADR-054), el reparto del permiso en prod (regla 20) y la prueba contra base real con el payload de la pantalla (regla 13). Se invoca con endpoint, API, controller, ruta, GET, POST, PUT, PATCH, DELETE, NestJS, permiso, 403, RLS, tenant, "devuelve vacío", "devuelve []", "200 pero no guarda", 500, DTO, validación, guard, cron.
---

# C2 · API — el endpoint que no miente

> Dos frases del método mandan aquí: **si el endpoint escribe, una prueba lo ejerció contra base
> real con el payload que manda la pantalla**, y **el permiso es una CLAVE** (ADR-054). Las
> trampas que más han costado están en [`docs/GOTCHAS.md`](../../../docs/GOTCHAS.md) §1–§5; esta
> skill es el orden en que se revisan. Si se contradicen, gana el documento.

## Las tres trampas que no avisan

1. **RLS sin contexto devuelve `[]` sin error** (`GOTCHAS.md` §1). Las tablas de `commercial.*`,
   `analytics.*` y `logistics.*` tienen `FORCE ROW LEVEL SECURITY`. Un endpoint que devuelve vacío
   es **lo primero** que se revisa aquí.
   - Controller HTTP → `TenantKnexService.run(async (trx) => …)`
     (`libs/platform-core/src/lib/database/tenant-knex.service.ts`).
   - Cron que cruza tenants → `KNEX_NEW_DB_ADMIN`, **nunca** expuesto a un controller.
   - Conexión legacy (`KNEX_CONNECTION`) **bypassa RLS**: ahí el `tenant_id` va explícito en cada
     consulta.
2. **Toda la request va en UNA transacción** (`GOTCHAS.md` §2). Un `try/catch` que se traga un
   error de base y sigue consultando produce `25P02`, o un **200 OK que no guardó nada**. Lo
   opcional va por **SAVEPOINT** (el patrón `trySavepoint`), con el `catch` **por fuera** del
   savepoint.
3. **El permiso que no está repartido no existe** (regla 20). Declararlo en el enum no le da
   acceso a nadie; superadmin pasa siempre y **esconde el bug**.

## Agregar un permiso: 5 touch-points (6 si es proyecto nuevo)

Receta completa en `GOTCHAS.md` §4. En corto:

| # | Dónde | Qué |
|---|---|---|
| 1 | `libs/contracts/src/authz/permissions.ts` | El valor en el enum **único** |
| 2 | El controller | `@RequirePermissions(Permission.X)` — o gate a nivel **campo** en el servicio si el endpoint es compartido |
| 3 | `app.routes.ts` de la app | `permissionGuard(Permission.X)` (+ el `*HomeGuard` si es el índice de un proyecto) |
| 4 | `permission-meta.ts` + `authz-tree.ts` | Etiqueta y casilla en `/admin/roles`; fuera del árbol es invisible |
| 5 | La pantalla | `perms.has(Permission.X)` del `PermissionsService`, nunca `auth.user()?.permissions` |
| 6 | `suite-map.ts` | Solo si es un **proyecto** nuevo (ADR-061) |

- El `RolesGuard` es **exact-key**: `COMPRAS_GESTIONAR` no hereda `COMPRAS_VALIDAR`.
- Los **lookups que llenan filtros** también necesitan permiso: uno compartido usa
  `@RequireAnyPermission(...)`. Nunca tragar el 403 de un lookup: se lee como «sin datos».
- Después de otorgar: **re-login** (el permiso vive en el JWT).
- ¿Quién debe tenerlo? Eso es de negocio: [`MATRIZ_ACCESOS.md`](../../../docs/MATRIZ_ACCESOS.md), y
  si no está ahí, decisión D*n* para Edgar.

## Construir el endpoint

- **El controller transporta, el servicio decide** (skill [`capa-dominio`](../capa-dominio/SKILL.md)).
  Sin reglas de negocio en el controller.
- DTO tipado de entrada y salida; sin `any` en líneas nuevas (`npm run lint:boundary`).
- **Lo que no se pudo medir viaja declarado** en la respuesta (`status`, `measured`, motivo), no
  como `0` ni `[]` (ADR-056). Un listado con tope dice que tiene tope («30 de 990»).
- Knex: nada de `?` dentro de literales en `knex.raw()`; JSONB con `->`, no con `?`
  (`GOTCHAS.md` §5).
- Dinero en `numeric`; el consumidor recibe string (`GOTCHAS.md` §6).
- Fechas y crons: la zona horaria está en `GOTCHAS.md` §7. Léela antes de un `cron` o de un
  filtro «de hoy».
- Escritura que crea filas en una tabla con `NOT NULL` nuevo: recorrer **todos** los caminos que
  insertan (regla 14).

## Probar — la parte que define «terminado»

⛔ **Nunca** la laptop contra prod, y **nunca** levantar el backend local (regla 3). Las pruebas
corren contra la réplica de desarrollo o el stack de pruebas, con destino verificado
(`assert-safe-target`), y las suites viven en `database/tests/` registradas en
`database/run-all-tests.js`.

Para un endpoint que **escribe**, la prueba tiene que:

1. Mandar **el mismo payload que manda la pantalla** — cópialo del servicio Angular, no lo
   inventes.
2. Leer **la fila escrita** desde la base después del 200, no confiar en la respuesta.
3. Probar con un **rol de permiso mínimo**, no con superadmin: 403 sin la clave, 2xx con la clave
   (y, si el gate es por campo, 2xx sin la clave para el request que no toca ese campo).
4. Incluir **un caso que debe fallar** (payload inválido, otro tenant, sin permiso).

> «Cero filas por defecto es indistinguible de cero filas por desuso» (método §5, DoD 3):
> antes de concluir que nadie usa algo, descarta que el endpoint no esté escribiendo.

## Verificado cuando

- [ ] La consulta corre dentro de `TenantKnexService.run()` (o lleva `tenant_id` explícito, con
      motivo).
- [ ] Ningún `try/catch` pelado dentro de la transacción de la request.
- [ ] Permiso con sus touch-points completos y **repartido** en prod a los roles que lo necesitan.
- [ ] Si escribe: prueba contra base real con el payload de la pantalla, leyendo la fila, con rol
      mínimo y con un caso rojo.
- [ ] Lo no medido viaja declarado en la respuesta.

## Lo que se reporta

```text
C2  <MÉTODO> /api/<ruta> — permiso <CLAVE> (repartido a: <roles> | ⛔ falta repartir)
    RLS: TenantKnexService.run · escribe: <tabla>
    prueba: database/tests/<archivo> — payload de <pantalla>, rol <mínimo>: 403/2xx ✓, fila leída ✓, caso rojo ✓
```
