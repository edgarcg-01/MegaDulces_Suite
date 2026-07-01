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
];
