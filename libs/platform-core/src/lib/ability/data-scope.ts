import { Permission } from '../constants/permissions';
import { isPlatformAdminRole } from './ability.factory';

/**
 * Alcance de datos del requester: `own` (sólo lo suyo) · `team` (su equipo) · `all` (la red).
 *
 * Se resuelve contra el MAPA DE PERMISOS, no contra reglas de CASL. Antes esto reconstruía una
 * ability desde `user.rules` (las reglas serializadas en el JWT) para preguntarle
 * `can('read','reports_global')` — un viaje de ida y vuelta por una librería para leer un booleano
 * que el guard ya tiene fresco en `req.user.permissions`. Equivalencias verificadas 1:1 en
 * `ability.factory`: `REPORTES_VER_GLOBAL` → `read:reports_global` y `REPORTES_VER_EQUIPO` →
 * `read:reports_team`, así que el resultado no cambia.
 *
 * Además `permissions` es MEJOR fuente que `rules`: el guard lo relee del cache en cada request
 * (anti-escalation), mientras que `rules` viaja en el token y queda congelado hasta el próximo
 * login. Un permiso revocado se respeta al instante; antes no.
 *
 * Fail-CLOSED por diseño: sin `permissions` devuelve `own`. Es el mismo comportamiento que tenía
 * con `rules` vacías, y el lado seguro si un caller olvida propagar el usuario completo.
 *
 * ⚠️ `alcance` NO es `permiso`. Esto sólo resuelve el eje jerárquico de REPORTES. El alcance por
 * sucursal / ruta / cliente vive en `ScopeService` (`scope.service.ts`) y no se mezcla acá.
 */
export interface DataScopeUser {
  sub: string;
  permissions?: Record<string, boolean> | null;
  role_name?: string | null;
}

export function getDataScope(user: DataScopeUser): {
  type: 'own' | 'team' | 'all';
  userId: string;
} {
  const userId = user.sub;

  // God-mode de plataforma. Antes salía por `manage:all` de la ability; ahora es explícito y no
  // depende de que la ability se haya construido.
  if (isPlatformAdminRole(user.role_name)) return { type: 'all', userId };

  const perms = user.permissions;
  if (!perms) return { type: 'own', userId };

  if (perms[Permission.REPORTES_VER_GLOBAL] === true) return { type: 'all', userId };
  if (perms[Permission.REPORTES_VER_EQUIPO] === true) return { type: 'team', userId };
  return { type: 'own', userId };
}
