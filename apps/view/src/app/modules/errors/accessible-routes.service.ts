import { Injectable, computed, inject } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { AUTHZ_TREE } from '../../core/constants/authz-tree';
import { Permission } from '../../core/constants/permissions';
import { RouteLink } from './route-links.component';

/**
 * Rutas de la plataforma web que ESTE usuario puede abrir.
 *
 * Sale de `AUTHZ_TREE` porque es lo único que junta ruta + etiqueta + proyecto +
 * permisos. Las pantallas de error la usan para ofrecer salidas, y el filtro por
 * permiso es la razón de ser del servicio: ofrecer una ruta que el guard va a
 * rebotar convierte la ayuda en otro callejón sin salida.
 *
 * Alcance conocido: el árbol lleva una ruta REPRESENTATIVA por módulo, no el
 * índice completo de `app.routes.ts` (~85 de ~135). Lo que no está acá
 * simplemente no se ofrece; nunca se ofrece de más.
 */
@Injectable({ providedIn: 'root' })
export class AccessibleRoutesService {
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** Todas las rutas del árbol, con los permisos que las abren. */
  private readonly catalog: (RouteLink & { perms: Permission[] })[] =
    (AUTHZ_TREE.find((a) => a.id === 'view')?.projects ?? []).flatMap((p) =>
      p.modules
        .filter((m) => !!m.route)
        .map((m) => ({
          label: m.label,
          route: m.route as string,
          project: p.label,
          icon: p.icon,
          perms: [...m.view, ...m.manage],
        })),
    );

  /** Las que el usuario puede abrir hoy. */
  readonly accessible = computed<RouteLink[]>(() => {
    const godMode = this.perms.isAdmin();
    const mine = this.auth.user()?.permissions ?? {};
    return this.catalog
      .filter((t) => godMode || t.perms.some((p) => !!mine[p]))
      .map(({ perms, ...link }) => link);
  });

  /**
   * Accesibles dentro de un proyecto (`/comercial`, `/finanzas`…). Para un 403
   * es más útil ofrecer lo cercano que un menú entero: el usuario ya sabía a qué
   * proyecto iba.
   */
  inProject(prefix: string, limit = 4): RouteLink[] {
    const p = '/' + prefix.split('/').filter(Boolean)[0];
    return this.accessible().filter((r) => r.route.startsWith(p + '/')).slice(0, limit);
  }
}
