import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { PermissionsService } from '../services/permissions.service';
import { Permission } from '../constants/permissions';
import { findProject } from '../constants/suite-map';

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
    //
    // `[ID.30]` Lee `PermissionsService`, no `authService.user()?.permissions`.
    // Los tres guards leían el mapa **decodificado del JWT** y usaban el
    // servicio sólo para `isAdmin()`, así que había dos fuentes para la misma
    // pregunta. Hoy da igual —el servicio se llena con ese mismo mapa— pero es
    // la condición para que sacar el permiso del token sea cambiar UNA carga y
    // no cazar tres lecturas repartidas.
    if (!perms.has(requiredPermission)) {
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

    // `[ID.30]` Una sola fuente: `hasAny` ya resuelve god-mode + clave exacta.
    if (!perms.hasAny(...requiredPermissions)) {
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
export interface LandingCandidate {
  perm: Permission;
  url: string;
}

/**
 * `[SN.4]` — Candidatos de un landing: los ESCRITOS A MANO primero (llevan el orden que el
 * negocio decidió: "el trabajo del almacén empieza en el censo", "Pedido antes de Existencia")
 * y, detrás, TODOS los permisos de los módulos con ruta del proyecto en `AUTHZ_TREE` que la lista
 * a mano no cubra, apuntando a la ruta de su módulo.
 *
 * Por qué: la landing (`/projects`, ADR-061) abre un proyecto a quien tenga CUALQUIER clave de
 * sus módulos. Si el guard del índice sólo conoce una lista corta, la puerta que la landing abre
 * rebota en `denied()` — medido en prod (2026-09-10): 32 cajeros con sólo
 * `FINANCE_EXPENSES_CAPTURAR` habrían caído en `/sin-acceso` porque `/finanzas` mandaba fijo a
 * `egresos`. Con el relleno derivado, la cobertura es por construcción: cada clave que abre el
 * proyecto tiene un candidato. Lo que el relleno NO garantiza es que la ruta del módulo acepte
 * esa clave (el árbol y los guards de ruta pueden discrepar) — eso lo vigila
 * `landing-guards.spec.ts`, con la deuda declarada por nombre.
 */
export function withTreeCandidates(projectId: string, hand: LandingCandidate[]): LandingCandidate[] {
  const seen = new Set<Permission>(hand.map((c) => c.perm));
  const out = [...hand];
  for (const mod of findProject(projectId)?.modules ?? []) {
    if (!mod.route) continue;
    for (const perm of [...mod.view, ...mod.manage]) {
      if (seen.has(perm)) continue;
      seen.add(perm);
      out.push({ perm, url: mod.route });
    }
  }
  return out;
}

export const landingRedirectGuard = (
  candidates: LandingCandidate[],
  fallbackUrl: string,
): CanActivateFn => (_route, state) => {
  const authService = inject(AuthService);
  const perms = inject(PermissionsService);
  const router = inject(Router);

  if (!authService.isAuthenticated) return router.parseUrl('/login');

  // `[ID.30]` Misma fuente única que los otros dos guards.
  for (const c of candidates) {
    if (perms.has(c.perm)) return router.parseUrl(c.url);
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

/**
 * `[SN.4]` — Candidatos por proyecto, EXPORTADOS para que `landing-guards.spec.ts` pueda
 * comprobar dos cosas que un guard encerrado en un closure no deja ver: que cada clave que abre
 * el proyecto desde la landing tiene un candidato, y que la ruta del candidato acepta esa clave.
 */
export const COMERCIAL_LANDING: LandingCandidate[] = withTreeCandidates('comercial', [
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
  // `[SN.4]` Medido en prod: `contabilidad` (2 usuarios) entra a Ventas sólo por COMISIONES, y
  // ninguna de las 12 de arriba la cubría → `denied()`.
  { perm: Permission.COMMERCIAL_COMMISSIONS_VER, url: '/comercial/comisiones' },
  { perm: Permission.COMMERCIAL_SELLOUT_ANALYSIS_VER, url: '/comercial/analisis' },
  { perm: Permission.COMMERCIAL_CARTERA_VER, url: '/comercial/cartera' },
  { perm: Permission.COMMERCIAL_PROMOTIONS_VER, url: '/comercial/promotions' },
  { perm: Permission.COMMERCIAL_PRODUCTS_VER, url: '/comercial/products' },
  { perm: Permission.COMMERCIAL_THOT_VER, url: '/comercial/thot-chat' },
  { perm: Permission.ROUTE_CONTROL_VER, url: '/comercial/route-tickets' },
]);

/** Landing de `/comercial`. */
export const comercialHomeGuard: CanActivateFn = landingRedirectGuard(COMERCIAL_LANDING, '/comercial/command-center');

export const ALMACEN_LANDING: LandingCandidate[] = withTreeCandidates('almacen', [
  // El trabajo del almacén empieza en el CENSO, así que Existencia va primera.
  { perm: Permission.EXISTENCIA_VER, url: '/almacen/inventory/existencia' },
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
  // `[SN.4]` Decía `/almacen/inventory/sessions`, que exige SUPERVISAR: el contador (sólo CONTAR)
  // rebotaba en el índice. Su pantalla es la del handheld. Lo destapó `landing-guards.spec.ts`.
  { perm: Permission.COMMERCIAL_INVENTORY_CONTAR, url: '/almacen/inventory/count' },
  { perm: Permission.COMMERCIAL_EXPIRY_VER, url: '/almacen/inventory/caducidades' },
  { perm: Permission.COMMERCIAL_MOVEMENTS_VER, url: '/almacen/movimientos' },
  { perm: Permission.COMMERCIAL_PREVENTION_VER, url: '/almacen/prevencion' },
]);

/** Landing de `/almacen`. */
export const almacenHomeGuard: CanActivateFn = landingRedirectGuard(ALMACEN_LANDING, '/almacen/inventory');

export const COMPRAS_LANDING: LandingCandidate[] = withTreeCandidates('compras', [
  { perm: Permission.COMPRAS_PEDIDO_VER, url: '/compras/pedido' },
  // Acá va DESPUÉS de Pedido a propósito: el trabajo del comprador empieza en el pedido, y
  // moverlo cambiaría dónde aterriza todo el equipo de compras sin que nadie lo pidiera.
  { perm: Permission.EXISTENCIA_VER, url: '/compras/existencia' },
  { perm: Permission.COMPRAS_REQUISICIONES_VER, url: '/compras/requisiciones' },
  { perm: Permission.COMPRAS_ORDENES_VER, url: '/compras/ordenes' },
  // `[SN.4]` `/compras/entradas` (la bandeja de PDFs) exige GESTIONAR desde RE.17: quien sólo
  // LEE entradas aterriza en el control, que es la vista de lectura. Lo destapó el spec.
  { perm: Permission.COMPRAS_ENTRADAS_GESTIONAR, url: '/compras/entradas' },
  { perm: Permission.COMPRAS_ENTRADAS_VER, url: '/compras/entradas/control' },
  { perm: Permission.COMPRAS_RED_VER, url: '/compras/red' },
  { perm: Permission.COMPRAS_HALLAZGOS_VER, url: '/compras/hallazgos' },
  // `/compras/compras-360` es un redirect (RE.20.1); el destino real es costo-por-compra.
  { perm: Permission.COMPRAS_360_VER, url: '/compras/costo-por-compra' },
  { perm: Permission.COMPRAS_COSTO_NETO_VER, url: '/compras/costo-neto' },
  { perm: Permission.COMPRAS_DESCUENTOS_VER, url: '/compras/descuentos' },
  { perm: Permission.COMPRAS_PROVEEDORES_VER, url: '/compras/proveedores' },
  { perm: Permission.COMPRAS_CATEGORIAS_VER, url: '/compras/categorias' },
]);

/** Landing de `/compras`: manda a la primera vista accesible del rol (no fijo a Pedido).
 * Un rol con permisos granulares que NO incluya COMPRAS_PEDIDO_VER (p.ej. solo Entradas)
 * antes caía en /compras → /compras/pedido → rebote al home. Ahora aterriza en su submódulo. */
export const comprasHomeGuard: CanActivateFn = landingRedirectGuard(COMPRAS_LANDING, '/compras/pedido');

export const LOGISTICA_LANDING: LandingCandidate[] = withTreeCandidates('logistica', [
  { perm: Permission.LOGISTICS_SHIPMENTS_VER, url: '/logistica/dashboard' },
  { perm: Permission.LOGISTICS_FLEET_VER, url: '/logistica/fleet' },
  { perm: Permission.LOGISTICS_PAYROLL_VER, url: '/logistica/payroll' },
  { perm: Permission.LOGISTICS_EXPENSES_VER, url: '/logistica/costs' },
  { perm: Permission.LOGISTICS_TRANSFERS_VER, url: '/logistica/traspasos' },
  // `[SN.4]` Faltaban: un rol con sólo Guías o sólo Gasto de flota rebotaba en el índice.
  { perm: Permission.LOGISTICS_GUIDES_VER, url: '/logistica/guides' },
  { perm: Permission.LOGISTICS_ROUTE_EXPENSES_VER, url: '/logistica/gasto-ruta' },
]);

/** Landing de `/logistica`. */
export const logisticaHomeGuard: CanActivateFn = landingRedirectGuard(LOGISTICA_LANDING, '/logistica/dashboard');

/**
 * `[SN.4]` Landing de `/finanzas`. Antes: `redirectTo: 'egresos'` FIJO, que exige
 * FINANCE_EXPENSES_VER. Medido en prod: 32 cajeros + 19 promotores de ruta tienen SOLO
 * FINANCE_EXPENSES_CAPTURAR (capturan comprobantes de gasto) → la landing les abre Finanzas y el
 * índice los mandaba a `/sin-acceso`. Egresos sigue primero para no moverle el aterrizaje a
 * nadie que ya entraba.
 */
export const FINANZAS_LANDING: LandingCandidate[] = withTreeCandidates('finanzas', [
  { perm: Permission.FINANCE_EXPENSES_VER, url: '/finanzas/egresos' },
  { perm: Permission.FINANCE_BANK_VER, url: '/finanzas/bancos' },
  { perm: Permission.FINANCE_COLLECTIONS_VER, url: '/finanzas/cobranza' },
  { perm: Permission.FINANCE_RECEIVABLES_VER, url: '/finanzas/cartera' },
  { perm: Permission.FINANCE_PAYMENTS_VER, url: '/finanzas/pagos-comprobantes' },
  { perm: Permission.FINANCE_AI_CHAT, url: '/finanzas/hallazgos' },
  { perm: Permission.FINANCE_EXPENSES_CAPTURAR, url: '/finanzas/capturar-gasto' },
]);
export const finanzasHomeGuard: CanActivateFn = landingRedirectGuard(FINANZAS_LANDING, '/finanzas/egresos');

/** `[SN.4]` Landing de `/contabilidad`. Antes: `redirectTo: 'listas-sat'` fijo (exige FISCAL_LISTAS_VER). */
export const CONTABILIDAD_LANDING: LandingCandidate[] = withTreeCandidates('contabilidad', [
  { perm: Permission.FISCAL_LISTAS_VER, url: '/contabilidad/listas-sat' },
  { perm: Permission.FISCAL_CFDI_VER, url: '/contabilidad/cfdi' },
  { perm: Permission.FISCAL_PURCHASE_BOOK_VER, url: '/contabilidad/movimientos-no-asociados' },
  { perm: Permission.FISCAL_FACTURAR_VER, url: '/contabilidad/facturar' },
  { perm: Permission.FISCAL_CONCILIACION_VER, url: '/contabilidad/conciliacion' },
  { perm: Permission.FISCAL_DIOT_VER, url: '/contabilidad/diot' },
  { perm: Permission.FISCAL_DESCARGA_VER, url: '/contabilidad/descarga' },
  { perm: Permission.FISCAL_CONTAB_VER, url: '/contabilidad/contabilidad' },
  { perm: Permission.FISCAL_CREDENCIALES_GESTIONAR, url: '/contabilidad/credenciales' },
]);
export const contabilidadHomeGuard: CanActivateFn = landingRedirectGuard(CONTABILIDAD_LANDING, '/contabilidad/listas-sat');

/**
 * `[SN.4]` Landing de `/admin` ("Configuración de la suite"). Antes: `redirectTo: 'users'` fijo,
 * que exige USUARIOS_GESTIONAR. `direccion` y `encargado_tienda` (10 usuarios) tienen ROLES_VER sin
 * GESTIONAR: podían abrir `/admin/roles` y el índice los rebotaba. USUARIOS_VER y USUARIOS_PASSWORDS
 * no abren ninguna pantalla — por eso el mapa de la landing ni los ofrece (gate explícito).
 */
export const ADMIN_LANDING: LandingCandidate[] = [
  { perm: Permission.USUARIOS_GESTIONAR, url: '/admin/users' },
  { perm: Permission.ROLES_VER, url: '/admin/roles' },
  { perm: Permission.ROLES_CONFIGURAR, url: '/admin/roles' },
];
export const adminHomeGuard: CanActivateFn = landingRedirectGuard(ADMIN_LANDING, '/admin/users');

/** Todos los landings dinámicos, por id de proyecto del árbol — para el spec de cobertura. */
export const LANDINGS_BY_PROJECT: Readonly<Record<string, LandingCandidate[]>> = {
  comercial: COMERCIAL_LANDING,
  almacen: ALMACEN_LANDING,
  compras: COMPRAS_LANDING,
  logistica: LOGISTICA_LANDING,
  finanzas: FINANZAS_LANDING,
  contabilidad: CONTABILIDAD_LANDING,
  admin: ADMIN_LANDING,
};

export const colaboradorGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const perms = inject(PermissionsService);
  const router = inject(Router);

  if (!authService.isAuthenticated) {
    router.navigate(['/login']);
    return false;
  }

  // `[ID.30]` Una sola fuente: `hasAny` ya cubre lo que hacía el fallback al
  // mapa del JWT — el servicio se carga con ese mismo mapa.
  if (!perms.hasAny(Permission.REPORTES_VER_EQUIPO, Permission.REPORTES_VER_GLOBAL)) {
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
