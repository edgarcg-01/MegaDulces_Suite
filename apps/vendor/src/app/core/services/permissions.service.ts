import { Injectable, computed, signal } from '@angular/core';
import { Permission } from '../constants/permissions';

/**
 * Gating de UI por permiso: `has()` / `hasAny()` / `isAdmin()`.
 *
 * Trabaja sobre el MAPA DE PERMISOS (`Record<clave, boolean>`), la misma verdad que enforcea el
 * backend por clave exacta en `RolesGuard`.
 *
 * Antes esto envolvia una ability de CASL construida desde las reglas del JWT, y preguntaba
 * `can(action, subject)`. Se retiro porque el modelo subject/action MENTIA en las dos direcciones:
 *
 *  1. **Colapsaba permisos que el negocio distingue.** Varias claves compartian subject, asi que
 *     `can('read','commercial_orders')` era verdadero con cualquiera de las 5 de ordenes. El
 *     backend ya habia abandonado ese modelo por dejar pasar de mas; en la UI el sintoma era
 *     ofrecer botones que terminaban en 403.
 *  2. **`can('manage', X)` casi nunca era lo que uno creia.** En CASL `manage` es comodin del lado
 *     de la REGLA, no de la consulta, y de los ~114 permisos mapeados **solo `ROLES_CONFIGURAR`
 *     concedia 'manage'**: todos los demas `*_GESTIONAR` concedian ['read','create','update',
 *     'delete']. Resultado: tres pantallas tenian sus controles de gestion escondidos para todo rol
 *     no-admin (catalogos, usuarios, planogramas). Verificado 2026-09-02.
 *
 * Y la copia era incompleta por construccion: 51 de las 164 claves del enum no tenian subject.
 */

/** Roles de plataforma con acceso total. Espejo de `isPlatformAdminRole` del backend. */
const PLATFORM_ADMIN_ROLES = new Set(['superadmin', 'admin']);

@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly perms = signal<Record<string, boolean>>({});
  private readonly role = signal<string | null>(null);

  /** Carga el mapa de permisos + el rol. */
  load(permissions: Record<string, boolean> | null | undefined, roleName?: string | null) {
    this.perms.set(permissions ?? {});
    this.role.set(roleName ?? null);
  }

  clear() {
    this.perms.set({});
    this.role.set(null);
  }

  isAdmin(): boolean {
    const r = this.role();
    return !!r && PLATFORM_ADMIN_ROLES.has(r.toLowerCase());
  }

  /** ¿El usuario tiene esta clave exacta? Los roles de plataforma pasan siempre. */
  has(permission: Permission | string): boolean {
    if (this.isAdmin()) return true;
    return this.perms()[permission as string] === true;
  }

  hasAny(...permissions: Array<Permission | string>): boolean {
    if (this.isAdmin()) return true;
    const p = this.perms();
    return permissions.some((k) => p[k as string] === true);
  }

  has$(permission: Permission | string) {
    return computed(() => this.has(permission));
  }

  hasAny$(...permissions: Array<Permission | string>) {
    return computed(() => this.hasAny(...permissions));
  }
}
