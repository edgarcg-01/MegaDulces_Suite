import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Los reportes de venta GENERAL: los que no son del sub-módulo de Ruta Directa.
 *
 * Es la barra de la entrada «Reportes de venta» y la pintan sus páginas (Sell-Out, Análisis,
 * Salidas). Ruta Directa tiene la suya (`RUTA_DIRECTA_TABS`): no se mezclan (`[NAV.8.1]`, abajo).
 */
export const REPORTES_GENERALES_TABS: PageTab[] = [
  {
    label: 'Sell-Out por empresa',
    route: '/comercial/sell-out',
    icon: 'pi pi-file-excel',
    permission: Permission.COMMERCIAL_SELLOUT_VER,
  },
  {
    // BI — sub-modulo Analisis (Sell-Out BI). Misma venta que Sell-Out, forma de
    // interrogarla: explica el cambio, preguntale, radar. Permiso propio.
    label: 'Análisis',
    route: '/comercial/analisis',
    icon: 'pi pi-chart-bar',
    permission: Permission.COMMERCIAL_SELLOUT_ANALYSIS_VER,
  },
  {
    label: 'Salidas por producto',
    route: '/comercial/salidas',
    icon: 'pi pi-box',
    permission: Permission.COMMERCIAL_SALIDAS_VER,
  },
  // ⛔ `[NAV.8.2]` «Facturación TM» (`/comercial/documentos`) ya NO va acá. Su página pinta la barra
  // de Telemarketing (`TELEMARKETING_TABS`: Facturación TM · Expedientes, `[GT.3]`), así que entrar
  // por esta pestaña dejaba el sidebar en «Reportes de venta» y la barra en otro apartado. Ahora es
  // su propia entrada «Facturación» en el sidebar de Comercial, con la barra que su página pinta.
  // Traspasos vive en Logística y Egresos en Finanzas — fuera de los tabs de
  // reportes de VENTA (aquí solo la familia sell-out/salidas).
];

// ⛔ `[NAV.8.1]` (2026-10-27) Aquí vivía `REPORTS_TABS`: la tira COMBINADA (los tres de sell-out +
// las seis de Ruta Directa + Facturación TM = 10 pestañas). La pintaban Sell-Out, Análisis, Salidas,
// Ventas por ruta e Inventario de ruta, mientras Comisiones, Rentabilidad, Gasto y Flota RD pintaban
// sólo las de RD: la MISMA entrada del sidebar mostraba dos barras distintas según la pestaña, y en
// Ventas por ruta se mezclaban dos apartados («Reportes de venta» y «Ruta Directa»). Edgar lo marcó
// con una captura. Ahora cada página pinta la barra de SU entrada: ésta, o `RUTA_DIRECTA_TABS`.
