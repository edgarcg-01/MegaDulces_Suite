import { ForbiddenException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

/**
 * Resuelve el tenant del requester. **LANZA si no hay** — nunca devuelve vacío.
 *
 * ## Por qué existe
 *
 * Había **15 copias** de este helper en `libs/trade`, todas con la firma
 * `string | undefined`:
 *
 * ```ts
 * private tenantId(user: any): string | undefined {
 *   return user?.tenant_id || this.tenantContext?.get()?.tenantId;
 * }
 * ```
 *
 * Y **58 call sites** que hacían `if (tenantId) q = q.where('tenant_id', tenantId)`.
 * Ese `if` es fail-**OPEN**: cuando el helper venía vacío, la query corría **sin
 * scope de tenant**.
 *
 * Lo que lo volvía peligroso y no meramente feo: esos services inyectan
 * `KNEX_CONNECTION`, que conecta como `postgres` (superuser). `FORCE ROW LEVEL
 * SECURITY` **no aplica a superusers ni a roles con `BYPASSRLS`**, así que en ese
 * camino no hay red debajo — el filtro manual era la ÚNICA defensa, y era
 * condicional. Y en `analytics.*` no hay RLS en absoluto (1 de 60 tablas), así que
 * tampoco la habría con el pool `app_runtime`.
 *
 * Con un solo tenant con datos en prod nunca se manifestó. Era un arma cargada
 * esperando al segundo tenant, no un bug latente inofensivo.
 *
 * ## Contrato
 *
 * Fail-CLOSED: si no se puede resolver el alcance, **no se consulta**. Un 403 es
 * un incidente visible; una lectura cross-tenant es silenciosa.
 *
 * ## Qué NO cubre
 *
 * El camino de **cron** no pasa por acá: los scanners (`execution-refresh`,
 * `missed-visit-engine`, …) iteran `public.tenants` y llaman los métodos
 * `*ForTenant(tenantId)` con el id explícito. Si algún cron llegara a llamar un
 * método de request, este throw lo delata en el log en vez de dejarlo leer todo.
 *
 * `alcance` ≠ `permiso`: esto sólo resuelve el tenant. El alcance por sucursal /
 * ruta / cliente vive en `ScopeService`.
 *
 * @param user  El `req.user` decodificado del JWT (trae `tenant_id`).
 * @param ctx   `TenantContextService` opcional — fallback al CLS del interceptor.
 */
export function requireTenantOf(user: any, ctx?: TenantContextService): string {
  const tenantId = user?.tenant_id || ctx?.get()?.tenantId;
  if (!tenantId) {
    throw new ForbiddenException(
      'Request sin tenant: no se puede resolver el alcance de los datos.',
    );
  }
  return String(tenantId);
}
