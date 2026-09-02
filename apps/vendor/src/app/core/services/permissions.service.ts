import { Injectable, computed, signal } from '@angular/core';
import { createMongoAbility, MongoAbility } from '@casl/ability';
import { Permission } from '../constants/permissions';

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

  loadRules(rules: any[]) {
    this.ability.set(createMongoAbility<AppAbility>(rules as any));
  }

  clear() {
    this.ability.set(null);
    this.perms.set({});
    this.role.set(null);
  }

  can(action: Action, subject: AppSubject): boolean {
    return this.ability()?.can(action, subject) ?? false;
  }

  can$(action: Action, subject: AppSubject) {
    return computed(() => this.can(action, subject));
  }
}
