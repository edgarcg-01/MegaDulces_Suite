import { Injectable, computed, signal } from '@angular/core';
import { createMongoAbility, MongoAbility } from '@casl/ability';
import { Permission } from '../constants/permissions';

/**
 * Gating de UI por permiso.
 *
 * ── API vigente: `has()` / `hasAny()` / `isAdmin()` ─────────────────────────────────────────────
 * Trabaja sobre el MAPA DE PERMISOS (`Record<clave, boolean>`), la misma verdad que enforcea el
 * backend por clave exacta en `RolesGuard`. Es la API a usar en código nuevo.
 *
 * ── API en retiro: `can(action, subject)` ──────────────────────────────────────────────────────
 * Vive sobre reglas de CASL y se queda SÓLO hasta migrar los sitios que la usan. No usarla en
 * código nuevo. Dos razones concretas, ambas verificadas:
 *
 *  1. **Colapsa permisos que el negocio distingue.** Varias claves comparten subject, así que
 *     `can('read','commercial_orders')` es verdadero con cualquiera de las 5 de órdenes
 *     (VER/CREAR/CONFIRMAR/CANCELAR/FULFILL). El backend ya abandonó ese modelo justamente porque
 *     dejaba pasar de más; en la UI el síntoma es ofrecer botones que terminan en 403.
 *  2. **`can('manage', X)` casi nunca es lo que uno cree.** En CASL `manage` es comodín del lado
 *     de la REGLA, no de la consulta: contra reglas `['read','create','update','delete']` devuelve
 *     **false**. Eso tenía escondidos los controles de catálogos y de scoring para todo rol
 *     no-admin (verificado 2026-09-02, mismo bug que había en `catalogs.controller`).
 */
export type Action = 'manage' | 'read' | 'create' | 'update' | 'delete';
export type AppSubject =
  | 'all'
  | 'users'
  | 'users_passwords'
  | 'users_assign_route'
  | 'catalogs'
  | 'stores'
  | 'planograms'
  | 'roles_config'
  | 'scoring_config'
  | 'visits'
  | 'visits_audit'
  | 'reports_own'
  | 'reports_team'
  | 'reports_global'
  | 'reports_export'
  | 'reports_manage'
  | 'kpi_goals'
  | 'team_management'
  | 'seguimiento';

type AppAbility = MongoAbility<[Action, AppSubject]>;

/** Roles de plataforma con acceso total. Espejo de `isPlatformAdminRole` del backend. */
const PLATFORM_ADMIN_ROLES = new Set(['superadmin', 'admin']);

@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private ability = signal<AppAbility | null>(null);
  private readonly perms = signal<Record<string, boolean>>({});
  private readonly role = signal<string | null>(null);

  /** Carga el mapa de permisos + el rol. Es lo que alimenta `has()`/`isAdmin()`. */
  load(permissions: Record<string, boolean> | null | undefined, roleName?: string | null) {
    this.perms.set(permissions ?? {});
    this.role.set(roleName ?? null);
  }

  /** @deprecated Reglas de CASL — se va cuando no queden llamadas a `can()`. */
  loadRules(rules: any[]) {
    this.ability.set(createMongoAbility<AppAbility>(rules as any));
  }

  clear() {
    this.ability.set(null);
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

  /** @deprecated Usar `has()` / `hasAny()` / `isAdmin()`. Ver la nota de arriba. */
  can(action: Action, subject: AppSubject): boolean {
    return this.ability()?.can(action, subject) ?? false;
  }

  /** @deprecated Usar `has$()` / `hasAny$()`. */
  can$(action: Action, subject: AppSubject) {
    return computed(() => this.can(action, subject));
  }
}
