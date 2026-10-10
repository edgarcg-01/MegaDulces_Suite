import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';
import { RUTA_DIRECTA_TABS } from './ruta-directa-tabs';

/**
 * Los reportes de venta GENERAL: los que no son del sub-módulo de Ruta Directa.
 *
 * ⛔ Existe aparte de `REPORTS_TABS` por una razón concreta: el sidebar agrupa Ruta Directa por
 * su lado, y si el grupo «Reportes» se derivara de la tira COMPLETA, las siete de RD saldrían
 * **dos veces** — `dedupeByRoute` dedupe dentro de un grupo, no entre grupos.
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

/**
 * La tira completa de la superficie de reportes de venta. **No cambia de orden ni de contenido**
 * respecto de cómo estaba: los tres de sell-out, las siete de Ruta Directa, y Facturación TM al
 * final. Lo único que cambió es que ahora el conjunto de RD tiene nombre propio, así que las dos
 * superficies que lo necesitan —esta tira y el grupo del sidebar— salen de la MISMA lista.
 */
export const REPORTS_TABS: PageTab[] = [
  ...REPORTES_GENERALES_TABS.slice(0, 3),
  ...RUTA_DIRECTA_TABS,
  // Facturación TM va al final, como estaba.
  ...REPORTES_GENERALES_TABS.slice(3),
];
