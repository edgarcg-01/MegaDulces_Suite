import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Navegación de la analítica COMERCIAL (venta real Kepler + IA). Solo lo que es
 * analítica de ventas/clientes. Las analíticas de inventario (Stock muerto, Salud)
 * viven en INVENTORY_TABS; Curaduría (ML-ops) queda gateada a admin.
 */
export const ANALYTICS_TABS: PageTab[] = [
  { label: 'Pregúntale a Thot', route: '/comercial/thot-chat', icon: 'pi pi-comments', permission: Permission.COMMERCIAL_ORDERS_VER },
  { label: 'En vivo', route: '/comercial/command-center', icon: 'pi pi-bolt', permission: Permission.COMMERCIAL_ORDERS_VER },
  { label: 'Histórico ERP', route: '/comercial/historical', icon: 'pi pi-database', permission: Permission.COMMERCIAL_ORDERS_VER },
];
