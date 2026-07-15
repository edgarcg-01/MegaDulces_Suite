import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Tabs del proyecto Finanzas. Aquí crece lo contable (documentos, hallazgos,
 * cuentas por pagar) — NO en los tabs de reportes de venta.
 */
export const FINANZAS_TABS: PageTab[] = [
  {
    label: 'Egresos contables',
    route: '/finanzas/egresos',
    icon: 'pi pi-wallet',
    permission: Permission.FINANCE_EXPENSES_VER,
  },
  {
    label: 'Hallazgos',
    route: '/finanzas/hallazgos',
    icon: 'pi pi-flag',
    permission: Permission.FINANCE_AI_CHAT,
  },
  {
    label: 'Listas SAT',
    route: '/finanzas/listas-sat',
    icon: 'pi pi-shield',
    permission: Permission.FISCAL_LISTAS_VER,
  },
  {
    label: 'CFDI',
    route: '/finanzas/cfdi',
    icon: 'pi pi-file',
    permission: Permission.FISCAL_CFDI_VER,
  },
  {
    label: 'Conciliación',
    route: '/finanzas/conciliacion',
    icon: 'pi pi-check-square',
    permission: Permission.FISCAL_CONCILIACION_VER,
  },
  {
    label: 'DIOT / IVA',
    route: '/finanzas/diot',
    icon: 'pi pi-percentage',
    permission: Permission.FISCAL_DIOT_VER,
  },
  {
    label: 'Solicitudes de gasto',
    route: '/finanzas/solicitudes',
    icon: 'pi pi-file-edit',
    permission: Permission.FINANCE_EXPENSES_VER,
  },
  {
    label: 'Pregúntale a Maat',
    route: '/finanzas/maat',
    icon: 'pi pi-sparkles',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
