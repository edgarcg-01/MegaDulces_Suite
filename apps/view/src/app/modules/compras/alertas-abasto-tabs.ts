import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.6]` **Alertas de abasto**: las dos señales de demanda que alimentan el pedido.
 *
 * - **Hallazgos**: el barrido nocturno deja los agotados clase A y lo que quedó bajo el punto de
 *   reorden.
 * - **Faltantes de piso** (`[FLT.14]`): lo que el mostrador reportó que un cliente pidió y no había.
 *   Es la demanda que ningún feed ve, porque una venta que no ocurrió no deja rastro en el ERP.
 *
 * Eran dos renglones del sidebar; van en uno, ANTES de Pedido, porque se miran para decidir.
 * Las dos usan el mismo permiso (`COMPRAS_HALLAZGOS_VER`): las trabaja el mismo comprador.
 * ⛔ La barra la pintan las DOS páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const ALERTAS_ABASTO_LABEL = 'Alertas de abasto';

export const ALERTAS_ABASTO_TABS: PageTab[] = [
  {
    label: 'Hallazgos',
    route: '/compras/hallazgos',
    icon: 'pi pi-flag',
    permission: Permission.COMPRAS_HALLAZGOS_VER,
  },
  {
    label: 'Faltantes de piso',
    route: '/compras/faltantes',
    icon: 'pi pi-megaphone',
    permission: Permission.COMPRAS_HALLAZGOS_VER,
  },
];
