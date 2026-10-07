import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/** Sub-módulo Promociones: las promos de la app + las vigentes en el ERP Kepler. */
export const PROMOS_TABS: PageTab[] = [
  { label: 'Promociones', route: '/mkt/promotions', icon: 'pi pi-gift', permission: Permission.COMMERCIAL_PROMOTIONS_VER },
  { label: 'Promos ERP', route: '/mkt/erp-promos', icon: 'pi pi-percentage', permission: Permission.COMMERCIAL_PROMOTIONS_VER },
  // `[MKT.1]` La pestaña la ven las DOS audiencias: Mercadotecnia y la gente de plaza que sube
  // su evidencia. Por eso el permiso de la pestaña es el de evidencia y no el de gestión —
  // `PageTabs` la apagaría justo para quien más la necesita.
  { label: 'Acuerdos', route: '/mkt/acuerdos', icon: 'pi pi-file-edit', permission: Permission.MKT_AGREEMENT_EVIDENCE_SUBIR },
  // `[MKT.6]` El resultado. Mismo permiso que Acuerdos, por el mismo motivo: la plaza que sube
  // la evidencia tiene derecho a ver si su exhibición vendió.
  { label: 'Resultado', route: '/mkt/resultado', icon: 'pi pi-chart-line', permission: Permission.MKT_AGREEMENT_EVIDENCE_SUBIR },
];
