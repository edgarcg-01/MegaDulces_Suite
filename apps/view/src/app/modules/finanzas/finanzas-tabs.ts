import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Tabs del proyecto Finanzas. Aquí crece lo contable (documentos, hallazgos,
 * cuentas por pagar) — NO en los tabs de reportes de venta. Lo fiscal/cumplimiento
 * SAT vive en el proyecto Contabilidad (`contabilidad-tabs.ts`).
 */
export const FINANZAS_TABS: PageTab[] = [
  {
    label: 'Egresos contables',
    route: '/finanzas/egresos',
    icon: 'pi pi-wallet',
    permission: Permission.FINANCE_EXPENSES_VER,
  },
  {
    label: 'Bancos',
    route: '/finanzas/bancos',
    icon: 'pi pi-building-columns',
    permission: Permission.FINANCE_BANK_VER,
  },
  {
    label: 'Hallazgos',
    route: '/finanzas/hallazgos',
    icon: 'pi pi-flag',
    permission: Permission.FINANCE_AI_CHAT,
  },
  {
    label: 'Solicitudes de gasto',
    route: '/finanzas/solicitudes',
    icon: 'pi pi-file-edit',
    permission: Permission.FINANCE_EXPENSES_VER,
  },
  {
    label: 'Reembolsos',
    route: '/finanzas/comprobaciones',
    icon: 'pi pi-receipt',
    permission: Permission.FINANCE_EXPENSES_VER,
  },
  {
    label: 'Pregúntale a Maat',
    route: '/finanzas/maat',
    icon: 'pi pi-sparkles',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
