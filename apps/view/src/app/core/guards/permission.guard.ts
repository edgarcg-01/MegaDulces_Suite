import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { PermissionsService } from '../services/permissions.service';
import { Permission } from '../constants/permissions';

const subjectMap: Record<string, string> = {
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
  [Permission.TIENDAS_CREAR]: 'stores_create',
  [Permission.PLANOGRAMAS_GESTIONAR]: 'planograms',
  [Permission.ROLES_CONFIGURAR]: 'roles_config',
  [Permission.SCORING_CONFIG_VER]: 'scoring_config',
  [Permission.SCORING_CONFIG_GESTIONAR]: 'scoring_config',
  [Permission.VER_SEGUIMIENTO]: 'seguimiento',
};

export const permissionGuard = (requiredPermission: Permission): CanActivateFn => {
  return () => {
    const authService = inject(AuthService);
    const perms = inject(PermissionsService);
    const router = inject(Router);

    if (!authService.isAuthenticated) {
      router.navigate(['/login']);
      return false;
    }

    const subject = subjectMap[requiredPermission];
    const hasAccess = subject ? perms.can('read', subject as any) : false;
    const legacyPerms = authService.user()?.permissions;
    const hasFallback = legacyPerms ? legacyPerms[requiredPermission] === true : false;

    if (!hasAccess && !hasFallback) {
      const legacyScope = legacyPerms ? (legacyPerms[Permission.REPORTES_VER_EQUIPO] === true || legacyPerms[Permission.REPORTES_VER_GLOBAL] === true) : false;
      if (legacyScope || perms.can('read', 'reports_team') || perms.can('read', 'reports_global')) {
        router.navigate(['/dashboard']);
      } else {
        router.navigate(['/dashboard/captures']);
      }
      return false;
    }

    return true;
  };
};

export const colaboradorGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const perms = inject(PermissionsService);
  const router = inject(Router);

  if (!authService.isAuthenticated) {
    router.navigate(['/login']);
    return false;
  }

  const canAccessFullDashboard = perms.can('read', 'reports_team') || perms.can('read', 'reports_global');
  const legacyPerms = authService.user()?.permissions;
  const hasFallback = legacyPerms ? (legacyPerms[Permission.REPORTES_VER_EQUIPO] === true || legacyPerms[Permission.REPORTES_VER_GLOBAL] === true) : false;

  if (!canAccessFullDashboard && !hasFallback) {
    const currentRoute = state.url;
    if (currentRoute.startsWith('/dashboard/captures')) {
      return true;
    }
    if (currentRoute.startsWith('/dashboard/seguimiento') && perms.can('read', 'seguimiento')) {
      return true;
    }
    const legacyPerms = authService.user()?.permissions;
    if (currentRoute.startsWith('/dashboard/seguimiento') && legacyPerms?.[Permission.VER_SEGUIMIENTO] === true) {
      return true;
    }
    router.navigate(['/dashboard/captures']);
    return false;
  }

  return true;
};
