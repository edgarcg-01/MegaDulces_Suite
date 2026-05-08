import { Injectable, computed, signal } from '@angular/core';
import { createMongoAbility, MongoAbility } from '@casl/ability';

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
  | 'team_management';

type AppAbility = MongoAbility<[Action, AppSubject]>;

@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private ability = signal<AppAbility | null>(null);

  loadRules(rules: any[]) {
    this.ability.set(createMongoAbility<AppAbility>(rules as any));
  }

  clear() {
    this.ability.set(null);
  }

  can(action: Action, subject: AppSubject): boolean {
    return this.ability()?.can(action, subject) ?? false;
  }

  can$(action: Action, subject: AppSubject) {
    return computed(() => this.can(action, subject));
  }
}
