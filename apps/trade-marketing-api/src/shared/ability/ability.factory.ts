import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Permission } from '../constants/permissions';
import type { Action, AppAbility, AppSubject } from './ability.types';

const permissionToSubject: Record<string, AppSubject> = {
  [Permission.USUARIOS_VER]: 'users',
  [Permission.USUARIOS_GESTIONAR]: 'users',
  [Permission.USUARIOS_PASSWORDS]: 'users_passwords',
  [Permission.USUARIOS_ASIGNAR_RUTA]: 'users_assign_route',
  [Permission.REPORTES_VER_PROPIO]: 'reports_own',
  [Permission.REPORTES_VER_EQUIPO]: 'reports_team',
  [Permission.REPORTES_VER_GLOBAL]: 'reports_global',
  [Permission.REPORTES_EXPORTAR]: 'reports_export',
  [Permission.REPORTES_GESTIONAR]: 'reports_manage',
  [Permission.VISITAS_REGISTRAR]: 'visits',
  [Permission.VISITAS_VER]: 'visits',
  [Permission.VISITAS_AUDITAR]: 'visits_audit',
  [Permission.CATALOGO_GESTIONAR]: 'catalogs',
  [Permission.TIENDAS_VER]: 'stores',
  [Permission.PLANOGRAMAS_GESTIONAR]: 'planograms',
  [Permission.ROLES_CONFIGURAR]: 'roles_config',
  [Permission.SCORING_CONFIG_VER]: 'scoring_config',
  [Permission.SCORING_CONFIG_GESTIONAR]: 'scoring_config',
  [Permission.VER_SEGUIMIENTO]: 'seguimiento',
};

const permissionToAction: Record<string, Action | Action[]> = {
  [Permission.USUARIOS_VER]: 'read',
  [Permission.USUARIOS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.USUARIOS_PASSWORDS]: ['read', 'update'],
  [Permission.USUARIOS_ASIGNAR_RUTA]: ['read', 'update'],
  [Permission.REPORTES_VER_PROPIO]: 'read',
  [Permission.REPORTES_VER_EQUIPO]: 'read',
  [Permission.REPORTES_VER_GLOBAL]: 'read',
  [Permission.REPORTES_EXPORTAR]: 'read',
  [Permission.REPORTES_GESTIONAR]: ['read', 'delete'],
  [Permission.VISITAS_REGISTRAR]: 'create',
  [Permission.VISITAS_VER]: 'read',
  [Permission.VISITAS_AUDITAR]: ['read', 'update'],
  [Permission.CATALOGO_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.TIENDAS_VER]: 'read',
  [Permission.PLANOGRAMAS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.ROLES_CONFIGURAR]: 'manage',
  [Permission.SCORING_CONFIG_VER]: 'read',
  [Permission.SCORING_CONFIG_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.VER_SEGUIMIENTO]: 'read',
};

export function buildAbility(permissions: Record<string, boolean>): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  for (const [permKey, allowed] of Object.entries(permissions)) {
    if (!allowed) continue;
    const subject = permissionToSubject[permKey];
    const actions = permissionToAction[permKey];
    if (!subject || !actions) continue;
    can(actions, subject);
  }

  if (permissions[Permission.REPORTES_VER_EQUIPO] || permissions[Permission.REPORTES_VER_GLOBAL]) {
    can('manage', 'team_management');
    can('manage', 'kpi_goals');
  }

  if (permissions[Permission.REPORTES_VER_GLOBAL]) {
    can('manage', 'all');
  }

  return build();
}
