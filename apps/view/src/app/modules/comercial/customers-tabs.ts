import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/** Sub-módulo Clientes: la lista transaccional + la ficha analítica 360 (venta real ERP). */
export const CUSTOMERS_TABS: PageTab[] = [
  { label: 'Clientes', route: '/comercial/customers', icon: 'pi pi-users', permission: Permission.COMMERCIAL_CUSTOMERS_VER },
  { label: 'Clientes 360', route: '/comercial/customers-360', icon: 'pi pi-id-card', permission: Permission.COMMERCIAL_CUSTOMERS_VER },
];
