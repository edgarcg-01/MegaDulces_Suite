import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Sub-módulo Inventario en 3 clusters coherentes (cada uno con su barra de tabs):
 *  - Existencias: stock maestro.
 *  - Conteo: flujo de inventario físico.
 *  - Analítica: lecturas de salud/riesgo del inventario.
 * Permisos alineados al guard de cada ruta (PageTabs filtra por permiso).
 */
export const INV_STOCK_TABS: PageTab[] = [
  { label: 'Existencias', route: '/almacen/inventory', icon: 'pi pi-box', permission: Permission.COMMERCIAL_INVENTORY_VER },
  { label: 'Almacenes', route: '/almacen/warehouses', icon: 'pi pi-warehouse', permission: Permission.COMMERCIAL_WAREHOUSES_VER },
];

export const INV_COUNT_TABS: PageTab[] = [
  { label: 'Conteo físico', route: '/almacen/inventory/count', icon: 'pi pi-qrcode', permission: Permission.COMMERCIAL_INVENTORY_CONTAR },
  { label: 'Folios', route: '/almacen/inventory/sessions', icon: 'pi pi-clipboard', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
  { label: 'Cíclico', route: '/almacen/inventory/abc', icon: 'pi pi-sync', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
  { label: 'Pasillos', route: '/almacen/inventory/aisles', icon: 'pi pi-th-large', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR },
  { label: 'Exactitud (IRA)', route: '/almacen/inventory/ira', icon: 'pi pi-verified', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
];

export const INV_ANALYTICS_TABS: PageTab[] = [
  { label: 'Por vencer', route: '/almacen/inventory/expiring', icon: 'pi pi-calendar-times', permission: Permission.COMMERCIAL_INVENTORY_VER },
  { label: 'Stock muerto', route: '/almacen/dead-stock', icon: 'pi pi-exclamation-triangle', permission: Permission.COMMERCIAL_ORDERS_VER },
  { label: 'Salud inv.', route: '/almacen/inventory-health', icon: 'pi pi-heart', permission: Permission.COMMERCIAL_ORDERS_VER },
  { label: 'Cuadre', route: '/almacen/cuadre', icon: 'pi pi-check-square', permission: Permission.RECONCILIATION_VER },
];
