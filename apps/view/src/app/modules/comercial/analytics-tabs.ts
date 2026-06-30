import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';

/** Navegación compartida de la sección de analytics comercial (venta real Kepler). */
export const ANALYTICS_TABS: PageTab[] = [
  { label: 'Pregúntale a Thot', route: '/comercial/thot-chat', icon: 'pi pi-comments' },
  { label: 'En vivo', route: '/comercial/command-center', icon: 'pi pi-bolt' },
  { label: 'Histórico ERP', route: '/comercial/historical', icon: 'pi pi-database' },
  { label: 'Stock muerto', route: '/comercial/dead-stock', icon: 'pi pi-exclamation-triangle' },
  { label: 'Salud inv.', route: '/comercial/inventory-health', icon: 'pi pi-heart' },
  { label: 'Clientes 360', route: '/comercial/customers-360', icon: 'pi pi-users' },
  { label: 'Promos', route: '/comercial/erp-promos', icon: 'pi pi-percentage' },
];
