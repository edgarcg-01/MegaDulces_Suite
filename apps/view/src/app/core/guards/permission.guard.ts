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

/**
 * Landing de un proyecto (índice): redirige a la primera superficie que el rol
 * puede ver, en orden de prioridad. Antes los índices redirigían SIEMPRE a una
 * página fija (command-center/inventory/dashboard) que exige un permiso — un rol
 * acotado a un solo reporte quedaba rebotado y sin forma de llegar a su página.
 * Devuelve un UrlTree (redirección) siempre; el componente nunca se renderiza.
 */
export const landingRedirectGuard = (
  candidates: { perm: Permission; url: string }[],
  fallbackUrl: string,
): CanActivateFn => () => {
  const authService = inject(AuthService);
  const perms = inject(PermissionsService);
  const router = inject(Router);

  if (!authService.isAuthenticated) return router.parseUrl('/login');

  const p = authService.user()?.permissions || {};
  const god = perms.can('manage', 'all');
  for (const c of candidates) {
    if (god || p[c.perm] === true) return router.parseUrl(c.url);
  }
  return router.parseUrl(fallbackUrl);
};

/** Landing de `/comercial`. */
export const comercialHomeGuard: CanActivateFn = landingRedirectGuard(
  [
    { perm: Permission.COMMERCIAL_ANALYTICS_VER, url: '/comercial/command-center' },
    { perm: Permission.COMMERCIAL_ORDERS_VER, url: '/comercial/orders' },
    { perm: Permission.COMMERCIAL_CUSTOMERS_VER, url: '/comercial/customers' },
    { perm: Permission.COMMERCIAL_PRICING_VER, url: '/comercial/pricing' },
    { perm: Permission.COMMERCIAL_SELLOUT_VER, url: '/comercial/sell-out' },
    { perm: Permission.COMMERCIAL_SALIDAS_VER, url: '/comercial/salidas' },
    { perm: Permission.COMMERCIAL_ROUTE_SALES_VER, url: '/comercial/ventas-por-ruta' },
    { perm: Permission.COMMERCIAL_CUSTOMERS360_VER, url: '/comercial/customers-360' },
    { perm: Permission.COMMERCIAL_HISTORICAL_VER, url: '/comercial/historical' },
    { perm: Permission.COMMERCIAL_ERP_PROMOS_VER, url: '/comercial/erp-promos' },
    { perm: Permission.COMMERCIAL_VENDOR_SALES_VER, url: '/comercial/vendor-sales' },
  ],
  '/comercial/command-center',
);

/** Landing de `/almacen`. */
export const almacenHomeGuard: CanActivateFn = landingRedirectGuard(
  [
    { perm: Permission.COMMERCIAL_INVENTORY_VER, url: '/almacen/inventory' },
    { perm: Permission.COMMERCIAL_WAREHOUSES_VER, url: '/almacen/warehouses' },
    { perm: Permission.COMMERCIAL_DEADSTOCK_VER, url: '/almacen/dead-stock' },
    { perm: Permission.COMMERCIAL_INVHEALTH_VER, url: '/almacen/inventory-health' },
    // Rol de prevención (solo RECONCILIATION_VER): su landing es el Cuadre.
    { perm: Permission.RECONCILIATION_VER, url: '/almacen/cuadre' },
  ],
  '/almacen/inventory',
);

/** Landing de `/logistica`. */
export const logisticaHomeGuard: CanActivateFn = landingRedirectGuard(
  [
    { perm: Permission.LOGISTICS_SHIPMENTS_VER, url: '/logistica/dashboard' },
    { perm: Permission.LOGISTICS_FLEET_VER, url: '/logistica/dashboard' },
    { perm: Permission.LOGISTICS_PAYROLL_VER, url: '/logistica/dashboard' },
    { perm: Permission.LOGISTICS_EXPENSES_VER, url: '/logistica/dashboard' },
    { perm: Permission.LOGISTICS_TRANSFERS_VER, url: '/logistica/traspasos' },
  ],
  '/logistica/dashboard',
);

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
