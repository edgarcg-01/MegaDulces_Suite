import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.8]` **Ventas y rentabilidad**: cuánto vende la red y cuánto deja.
 *
 * Eran tres renglones del grupo «Reportes». En 30 días: Rentabilidad 15 visitas (Dirección),
 * Ventas generales 1, Sucursales Wincaja 0 (telemetría de la suite, 2026-10-27). Rentabilidad va
 * primero porque es la que se abre: la entrada lleva a la primera pestaña visible.
 *
 * ⚠️ No se metieron en «Reportes de venta»: esa barra (`REPORTS_TABS`) ya trae 11 pestañas
 * (Sell-Out, Ruta Directa, Facturación TM) y la pintan sus páginas; con dos más no cabría.
 * ⛔ La barra la pintan las TRES páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const VENTAS_RENTABILIDAD_LABEL = 'Ventas y rentabilidad';

export const VENTAS_RENTABILIDAD_TABS: PageTab[] = [
  {
    label: 'Rentabilidad',
    route: '/comercial/rentabilidad',
    icon: 'pi pi-percentage',
    permission: Permission.COMMERCIAL_PROFITABILITY_VER,
  },
  {
    label: 'Ventas generales',
    route: '/comercial/ventas-generales',
    icon: 'pi pi-sparkles',
    permission: Permission.COMMERCIAL_ANALYTICS_VER,
  },
  {
    label: 'Sucursales Wincaja',
    route: '/comercial/wincaja',
    icon: 'pi pi-building',
    permission: Permission.COMMERCIAL_ANALYTICS_VER,
  },
];
