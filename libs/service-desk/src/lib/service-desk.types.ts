/**
 * `[MS.2.3]` Quién hace la llamada, ya resuelto a lo que la Mesa de Servicio necesita saber.
 *
 * El `RolesGuard` global deja en `request.user` los permisos y los roles FRESCOS (no los del token) sólo
 * en las rutas que declaran `@RequirePermissions`/`@RequireAnyPermission`. Todas las de este módulo lo
 * declaran, así que acá se puede confiar en ese mapa. El god-mode se resuelve por NOMBRE DE ROL
 * (`isPlatformAdminRole`), nunca por el mapa: `superadmin` no tiene sus claves en `role_permissions`
 * (ADR-054, medido en prod).
 */
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

export interface ActorCtx {
  userId: string;
  username: string;
  /** Nombre para mostrar; cae al `username` si la ficha no lo tiene. */
  nombre: string;
  /** Atiende tickets: `SERVICIO_ATENDER`, `SERVICIO_COORDINAR` o god-mode. */
  esAgente: boolean;
  /** Reasigna y cambia prioridades: `SERVICIO_COORDINAR` o god-mode. */
  esCoordinador: boolean;
}

export interface AuthedRequest {
  user?: {
    sub?: string;
    id?: string;
    username?: string;
    full_name?: string;
    nombre?: string;
    role_name?: string | null;
    roles_frescos?: string[];
    permissions?: Record<string, boolean> | null;
  };
}

export function actorDesdeRequest(req: AuthedRequest): ActorCtx {
  const u = req?.user;
  const userId = u?.sub ?? u?.id;
  if (!userId) throw new Error('actorDesdeRequest: la petición no trae un usuario autenticado');
  const roles = u?.roles_frescos?.length ? u.roles_frescos : u?.role_name ? [u.role_name] : [];
  const god = roles.some((r) => isPlatformAdminRole(r));
  const perms = u?.permissions ?? {};
  const coordina = god || perms[Permission.SERVICIO_COORDINAR] === true;
  const atiende = coordina || perms[Permission.SERVICIO_ATENDER] === true;
  return {
    userId,
    username: u?.username ?? '',
    nombre: u?.full_name || u?.nombre || u?.username || 'Usuario',
    esAgente: atiende,
    esCoordinador: coordina,
  };
}
