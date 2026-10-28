import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * GT.3 — tabs del área de **Telemarketing** (facturación + sus reportes).
 *
 * Antes esta pantalla montaba `REPORTS_TABS`, la tira de los reportes de venta (Sell-Out,
 * Análisis, Salidas, Ventas por ruta, Comisiones RD). Telemarketing es un área con dueño
 * propio y lo que se hace acá —facturar, imprimir el anexo, armar la guía de cobranza— no
 * tiene nada que ver con esos tableros: la tira vieja ofrecía cinco salidas y ninguna
 * entrada a lo que sigue.
 *
 * `[NAV.8.2]` Esta misma barra es la de la entrada «Facturación» del sidebar de Comercial: la
 * página es una sola y pinta una sola barra, así que las dos entradas (Telemarketing y Comercial)
 * llevan a lo mismo. Antes Facturación TM colgaba de la barra de Reportes de venta y al abrirla
 * la barra cambiaba de apartado.
 */
export const TELEMARKETING_TABS: PageTab[] = [
  {
    label: 'Facturación TM',
    route: '/comercial/documentos',
    icon: 'pi pi-file',
    permission: Permission.COMMERCIAL_SALES_DOCS_VER,
  },
  {
    // GT.12 — el archivo: historial por vendedor de las guías emitidas. La guía se GENERA en
    // Facturación TM (ahí están las facturas que se palomean); acá sólo se consulta y reimprime.
    label: 'Expedientes',
    route: '/comercial/documentos/expedientes',
    icon: 'pi pi-folder-open',
    permission: Permission.COMMERCIAL_SALES_DOCS_VER,
  },
];
