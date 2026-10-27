import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.8]` **Vendedores**: la cartera que se le asigna a cada vendedor de campo, el cierre de su
 * ruta y lo que vendió.
 *
 * Eran tres renglones del grupo «Ruta y vendedores». En 30 días sumaron **1 visita** entre los tres
 * (Cartera 0, Cierre de ruta 1, Ventas de vendedor 0 — telemetría de la suite, 2026-10-27), al lado
 * de Ruta Directa con 100. Se pliegan para que el sidebar de Comercial quepa sin scroll.
 *
 * Cada pestaña conserva EXACTAMENTE el permiso que tenía su renglón (Cartera pide
 * `USUARIOS_ASIGNAR_RUTA` en el sidebar aunque su ruta pida `COMMERCIAL_CARTERA_VER`: se calca el
 * del sidebar para que nadie gane ni pierda la entrada).
 * ⛔ La barra la pintan las TRES páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const VENDEDORES_LABEL = 'Vendedores';

export const VENDEDORES_TABS: PageTab[] = [
  {
    label: 'Cartera de ventas',
    route: '/comercial/cartera',
    icon: 'pi pi-sitemap',
    permission: Permission.USUARIOS_ASIGNAR_RUTA,
  },
  {
    label: 'Cierre de ruta',
    route: '/comercial/route-tickets',
    icon: 'pi pi-receipt',
    permission: Permission.ROUTE_CONTROL_VER,
  },
  {
    label: 'Ventas de vendedor',
    route: '/comercial/vendor-sales',
    icon: 'pi pi-money-bill',
    permission: Permission.COMMERCIAL_VENDOR_SALES_VER,
  },
];
