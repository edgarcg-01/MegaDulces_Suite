import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { PermissionsService } from '../services/permissions.service';
import { Permission } from '../constants/permissions';

/**
 * Redirección a la pantalla de 403 con el contexto necesario para explicarla.
 *
 * Antes cada denegación mandaba MUDO a /dashboard o /dashboard/captures: el
 * usuario hacía clic, aparecía en otro lado, y no sabía si le faltaba permiso,
 * si la sección se había movido o si le había errado. Se lleva `from` (a dónde
 * iba) y `perm` (qué permiso faltó) para que la pantalla lo diga en castellano.
 */
const denied = (router: Router, url: string, perm?: Permission) =>
  router.createUrlTree(['/sin-acceso'], {
    queryParams: { from: url, perm: perm ?? null },
  });

export const permissionGuard = (requiredPermission: Permission): CanActivateFn => {
  return (_route, state) => {
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
    const hasAccess = perms.isAdmin();

    if (!hasAccess && !hasFallback) {
      return denied(router, state.url, requiredPermission);
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
  return (_route, state) => {
    const authService = inject(AuthService);
    const perms = inject(PermissionsService);
    const router = inject(Router);

    if (!authService.isAuthenticated) {
      router.navigate(['/login']);
      return false;
    }

    const legacyPerms = authService.user()?.permissions;
    const ok =
      perms.isAdmin() ||
      requiredPermissions.some((p) => (legacyPerms ? legacyPerms[p] === true : false));

    if (!ok) {
      // Se nombra el primero: con varios permisos alternativos, cualquiera
      // alcanza, y pedir uno concreto es más accionable que listarlos todos.
      return denied(router, state.url, requiredPermissions[0]);
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
): CanActivateFn => (_route, state) => {
  const authService = inject(AuthService);
  const perms = inject(PermissionsService);
  const router = inject(Router);

  if (!authService.isAuthenticated) return router.parseUrl('/login');

  const p = authService.user()?.permissions || {};
  const god = perms.isAdmin();
  for (const c of candidates) {
    if (god || p[c.perm] === true) return router.parseUrl(c.url);
  }

  /**
   * `[AUTHZ.6]` Sin candidato: el fallback es una página FIJA que a su vez exige un permiso, así
   * que mandar ahí a quien no empató produce un segundo rebote y termina en un lugar que no
   * explica nada. Le pasó al `almacenista`: `/almacen` → fallback `/almacen/inventory` →
   * `permissionGuard(COMMERCIAL_INVENTORY_VER)` → fuera.
   *
   * El fallback se reserva para quien SÍ puede abrirlo (god-mode ya salió arriba por el primer
   * candidato; esto cubre el caso de un proyecto cuyos candidatos todavía no están declarados).
   * Al resto se le dice qué le falta, nombrando el primer candidato — que es la puerta principal
   * del proyecto y la respuesta accionable a "¿por qué no puedo entrar?".
   */
  const puedeElFallback = candidates.length === 0;
  if (puedeElFallback) return router.parseUrl(fallbackUrl);
  return denied(router, state.url, candidates[0].perm);
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
    { perm: Permission.COMMERCIAL_SALES_DOCS_VER, url: '/comercial/documentos' },
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
    // `[AUTHZ.6]` El piso de almacén. Ninguno de estos era candidato, así que el `almacenista`
    // caía al fallback `/almacen/inventory` — que exige `_INVENTORY_VER`, el permiso que NO tiene
    // — y de ahí a `/sin-acceso`. Su landing es el trabajo del día: los vales por recibir.
    { perm: Permission.COMMERCIAL_INVENTORY_RECIBIR, url: '/almacen/inventory/recepcion-sesiones' },
    { perm: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, url: '/almacen/inventory/sessions' },
    { perm: Permission.COMMERCIAL_INVENTORY_CONTAR, url: '/almacen/inventory/sessions' },
    { perm: Permission.COMMERCIAL_EXPIRY_VER, url: '/almacen/inventory/caducidades' },
    { perm: Permission.COMMERCIAL_MOVEMENTS_VER, url: '/almacen/movimientos' },
    { perm: Permission.COMMERCIAL_PREVENTION_VER, url: '/almacen/prevencion' },
  ],
  '/almacen/inventory',
);

/** Landing de `/compras`: manda a la primera vista accesible del rol (no fijo a Pedido).
 * Un rol con permisos granulares que NO incluya COMPRAS_PEDIDO_VER (p.ej. solo Entradas)
 * antes caía en /compras → /compras/pedido → rebote al home. Ahora aterriza en su submódulo. */
export const comprasHomeGuard: CanActivateFn = landingRedirectGuard(
  [
    { perm: Permission.COMPRAS_PEDIDO_VER, url: '/compras/pedido' },
    { perm: Permission.COMPRAS_REQUISICIONES_VER, url: '/compras/requisiciones' },
    { perm: Permission.COMPRAS_ORDENES_VER, url: '/compras/ordenes' },
    { perm: Permission.COMPRAS_ENTRADAS_VER, url: '/compras/entradas' },
    { perm: Permission.COMPRAS_RED_VER, url: '/compras/red' },
    { perm: Permission.COMPRAS_HALLAZGOS_VER, url: '/compras/hallazgos' },
    { perm: Permission.COMPRAS_360_VER, url: '/compras/compras-360' },
    { perm: Permission.COMPRAS_COSTO_NETO_VER, url: '/compras/costo-neto' },
    { perm: Permission.COMPRAS_DESCUENTOS_VER, url: '/compras/descuentos' },
    { perm: Permission.COMPRAS_PROVEEDORES_VER, url: '/compras/proveedores' },
    { perm: Permission.COMPRAS_CATEGORIAS_VER, url: '/compras/categorias' },
  ],
  '/compras/pedido',
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

  const canAccessFullDashboard = perms.hasAny(Permission.REPORTES_VER_EQUIPO, Permission.REPORTES_VER_GLOBAL);
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
