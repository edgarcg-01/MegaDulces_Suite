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

    // Gate por CLAVE EXACTA. El paso viejo por `subjectMap` + can('read', subject) era mas
    // permisivo: varias claves comparten subject, asi que abria rutas que el API 403ea.
    if (!perms.has(requiredPermission)) {
      // En la app de vendedor standalone NO existen /dashboard ni /captures.
      // El usuario ya pasó vendorGuard (es vendedor válido): si le falta este
      // permiso puntual, lo mandamos a su home /vendor — nunca a rutas de otra
      // app, que con el catch-all '**' provocarían un loop infinito.
      router.navigate(['/vendor']);
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

  const canAccessFullDashboard = perms.hasAny(Permission.REPORTES_VER_EQUIPO, Permission.REPORTES_VER_GLOBAL);
  const legacyPerms = authService.user()?.permissions;
  const hasFallback = legacyPerms ? (legacyPerms[Permission.REPORTES_VER_EQUIPO] === true || legacyPerms[Permission.REPORTES_VER_GLOBAL] === true) : false;

  if (!canAccessFullDashboard && !hasFallback) {
    // El vendedor (CAPTURE_TICKET_USE) usa "Captura de vendedor", NO la diaria:
    // su set permitido excluye /captures y su home es /vendor-capture. El
    // colaborador sin esa capacidad mantiene /captures como captura y home.
    const isVendor = legacyPerms ? legacyPerms[Permission.CAPTURE_TICKET_USE] === true : false;
    const allowed = isVendor
      ? ['/dashboard/vendor-capture', '/dashboard/route-tickets']
      : ['/dashboard/captures', '/dashboard/route-tickets', '/dashboard/vendor-capture'];
    if (allowed.some((p) => state.url.startsWith(p))) {
      return true;
    }
    router.navigate([isVendor ? '/dashboard/vendor-capture' : '/dashboard/captures']);
    return false;
  }

  return true;
};
