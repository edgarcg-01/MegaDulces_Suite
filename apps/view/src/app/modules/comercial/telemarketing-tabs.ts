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
 * `REPORTS_TABS` **no se toca**: desde Sell-Out se sigue llegando a Facturación TM, que es
 * como se entra al área.
 */
export const TELEMARKETING_TABS: PageTab[] = [
  {
    label: 'Facturación TM',
    route: '/comercial/documentos',
    icon: 'pi pi-file',
    permission: Permission.COMMERCIAL_SALES_DOCS_VER,
  },
  {
    // GT.2 — selección de facturas → Guía de Cobranza imprimible.
    label: 'Reportes',
    route: '/comercial/documentos/reportes',
    icon: 'pi pi-print',
    permission: Permission.COMMERCIAL_SALES_DOCS_VER,
  },
];
