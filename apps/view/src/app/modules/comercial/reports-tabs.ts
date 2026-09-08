import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

export const REPORTS_TABS: PageTab[] = [
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
  {
    label: 'Ventas por ruta',
    route: '/comercial/ventas-por-ruta',
    icon: 'pi pi-directions',
    permission: Permission.COMMERCIAL_ROUTE_SALES_VER,
  },
  {
    // RD.6 — la comision quincenal de Ruta Directa. Al lado de Ventas por ruta porque es la
    // misma venta, pero con permiso PROPIO: ver cuanto vendio una ruta y ver cuanto cobra su
    // chofer son cosas distintas, y lo segundo es nomina.
    label: 'Comisiones RD',
    route: '/comercial/comisiones',
    icon: 'pi pi-percentage',
    permission: Permission.COMMERCIAL_COMMISSIONS_VER,
  },
  {
    // AX.2 — el documento que se le entrega al cliente (anexo imprimible + pagaré).
    // AX.9: se llamaba "Documentos", más ancho de lo que muestra — la pantalla trae SÓLO
    // facturas de telemarketing (U/D/8, canal TELEMARK en el 100%). El tab va corto por el
    // ancho de la tira; el nombre completo vive en el encabezado de la página.
    label: 'Facturación TM',
    route: '/comercial/documentos',
    icon: 'pi pi-file',
    permission: Permission.COMMERCIAL_SALES_DOCS_VER,
  },
  // Traspasos vive en Logística y Egresos en Finanzas — fuera de los tabs de
  // reportes de VENTA (aquí solo la familia sell-out/salidas/ruta).
];
