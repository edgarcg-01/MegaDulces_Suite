import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

export const REPORTS_TABS: PageTab[] = [
  {
    label: 'Sell-Out por empresa',
    route: '/comercial/sell-out',
    icon: 'pi pi-file-excel',
    permission: Permission.COMMERCIAL_ORDERS_VER,
  },
  {
    label: 'Salidas por producto',
    route: '/comercial/salidas',
    icon: 'pi pi-box',
    permission: Permission.COMMERCIAL_ORDERS_VER,
  },
  {
    label: 'Ventas por ruta',
    route: '/comercial/ventas-por-ruta',
    icon: 'pi pi-directions',
    permission: Permission.COMMERCIAL_ORDERS_VER,
  },
  {
    label: 'Traspasos (no venta)',
    route: '/logistica/traspasos',
    icon: 'pi pi-sync',
    permission: Permission.COMMERCIAL_ORDERS_VER,
  },
  {
    label: 'Egresos contables',
    route: '/comercial/egresos',
    icon: 'pi pi-wallet',
    permission: Permission.COMMERCIAL_ORDERS_VER,
  },
];
