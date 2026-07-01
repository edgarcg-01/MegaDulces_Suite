import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Navegación compartida del sub-módulo de Inventario. Antes estaba duplicada
 * inline en cada pantalla; ahora es un solo origen. Incluye las analíticas de
 * inventario (Stock muerto, Salud) que antes vivían por error en la barra de
 * analítica de ventas.
 */
export const INVENTORY_TABS: PageTab[] = [
  { label: 'Existencias', route: '/comercial/inventory', icon: 'pi pi-box', permission: Permission.COMMERCIAL_INVENTORY_VER },
  { label: 'Folios', route: '/comercial/inventory/sessions', icon: 'pi pi-clipboard', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
  { label: 'Por vencer', route: '/comercial/inventory/expiring', icon: 'pi pi-calendar-times', permission: Permission.COMMERCIAL_INVENTORY_VER },
  { label: 'Cíclico', route: '/comercial/inventory/abc', icon: 'pi pi-sync', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
  { label: 'Pasillos', route: '/comercial/inventory/aisles', icon: 'pi pi-th-large', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR },
  { label: 'Stock muerto', route: '/comercial/dead-stock', icon: 'pi pi-exclamation-triangle', permission: Permission.COMMERCIAL_INVENTORY_VER },
  { label: 'Salud inv.', route: '/comercial/inventory-health', icon: 'pi pi-heart', permission: Permission.COMMERCIAL_INVENTORY_VER },
];
