import { MongoAbility, createMongoAbility } from '@casl/ability';

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

export type AppAbility = MongoAbility<[Action, AppSubject]>;
