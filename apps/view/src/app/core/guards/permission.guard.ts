import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { PermissionsService } from '../services/permissions.service';
import { Permission } from '../constants/permissions';

export const permissionGuard = (requiredPermission: Permission): CanActivateFn => {
  return () => {
    const authService = inject(AuthService);
    const perms = inject(PermissionsService);
    const router = inject(Router);

    if (!authService.isAuthenticated) {
      router.navigate(['/login']);
      return false;
    }

    // Gate por CLAVE EXACTA del permiso (espeja al backend, que ya no colapsa
    // Permission→subject) o god-mode de plataforma. Antes aceptaba
    // `can('read', subject)`, lo que mostraba nav que el API ahora 403ea.
    const legacyPerms = authService.user()?.permissions;
    const hasFallback = legacyPerms ? legacyPerms[requiredPermission] === true : false;
    const hasAccess = perms.can('manage', 'all');

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

/**
 * Variante OR: deja pasar si el usuario tiene CUALQUIERA de los permisos.
 * Útil para superficies que sirven a dos roles (ej. Mapa de Campo: tracking
 * con RUTAS_VER o inteligencia comercial con COMMERCIAL_MAP_VER).
 */
export const anyPermissionGuard = (...requiredPermissions: Permission[]): CanActivateFn => {
  return () => {
    const authService = inject(AuthService);
    const perms = inject(PermissionsService);
    const router = inject(Router);

    if (!authService.isAuthenticated) {
      router.navigate(['/login']);
      return false;
    }

    const legacyPerms = authService.user()?.permissions;
    const ok =
      perms.can('manage', 'all') ||
      requiredPermissions.some((p) => (legacyPerms ? legacyPerms[p] === true : false));

    if (!ok) {
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
    // Colaborador restringido (sin reportes de equipo/global): su única vista es
    // la captura diaria. El vendedor usa su app dedicada (apps/vendor), no Trade.
    if (state.url.startsWith('/dashboard/captures')) {
      return true;
    }
    router.navigate(['/dashboard/captures']);
    return false;
  }

  return true;
};
