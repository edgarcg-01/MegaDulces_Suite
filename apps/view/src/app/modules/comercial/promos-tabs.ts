import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/** Sub-módulo Promociones: las promos de la app + las vigentes en el ERP Kepler. */
export const PROMOS_TABS: PageTab[] = [
  { label: 'Promociones', route: '/comercial/promotions', icon: 'pi pi-gift', permission: Permission.COMMERCIAL_PROMOTIONS_VER },
  { label: 'Promos ERP', route: '/comercial/erp-promos', icon: 'pi pi-percentage', permission: Permission.COMMERCIAL_PROMOTIONS_VER },
];
