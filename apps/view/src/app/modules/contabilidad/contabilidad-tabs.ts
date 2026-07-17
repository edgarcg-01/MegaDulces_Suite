import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Tabs del proyecto Contabilidad (cumplimiento SAT / CFDI). Separado de Finanzas:
 * aquí vive lo fiscal (listas SAT, CFDI, conciliación, DIOT, descarga masiva,
 * materialidad, contabilidad electrónica, impuestos provisionales, e.firma).
 */
export const CONTABILIDAD_TABS: PageTab[] = [
  { label: 'Listas SAT', route: '/contabilidad/listas-sat', icon: 'pi pi-shield', permission: Permission.FISCAL_LISTAS_VER },
  { label: 'CFDI', route: '/contabilidad/cfdi', icon: 'pi pi-file', permission: Permission.FISCAL_CFDI_VER },
  { label: 'Facturar', route: '/contabilidad/facturar', icon: 'pi pi-file-edit', permission: Permission.FISCAL_FACTURAR_VER },
  { label: 'Diagnóstico', route: '/contabilidad/diagnostico', icon: 'pi pi-wrench', permission: Permission.FISCAL_FACTURAR_VER },
  { label: 'Conciliación', route: '/contabilidad/conciliacion', icon: 'pi pi-check-square', permission: Permission.FISCAL_CONCILIACION_VER },
  { label: 'DIOT / IVA', route: '/contabilidad/diot', icon: 'pi pi-percentage', permission: Permission.FISCAL_DIOT_VER },
  { label: 'Descarga CFDI', route: '/contabilidad/descarga', icon: 'pi pi-cloud-download', permission: Permission.FISCAL_DESCARGA_VER },
  { label: 'Materialidad', route: '/contabilidad/materialidad', icon: 'pi pi-folder-open', permission: Permission.FISCAL_LISTAS_VER },
  { label: 'Contabilidad e.', route: '/contabilidad/contabilidad', icon: 'pi pi-book', permission: Permission.FISCAL_CONTAB_VER },
  { label: 'Provisionales', route: '/contabilidad/impuestos', icon: 'pi pi-calculator', permission: Permission.FISCAL_DIOT_VER },
  { label: 'e.firma', route: '/contabilidad/credenciales', icon: 'pi pi-key', permission: Permission.FISCAL_CREDENCIALES_GESTIONAR },
];
