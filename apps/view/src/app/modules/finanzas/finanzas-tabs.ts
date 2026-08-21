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
    label: 'Caja General',
    route: '/finanzas/caja',
    icon: 'pi pi-calculator',
    permission: Permission.FINANCE_BANK_VER,
  },
  {
    label: 'Cobranza',
    route: '/finanzas/cobranza',
    icon: 'pi pi-money-bill',
    permission: Permission.FINANCE_COLLECTIONS_VER,
  },
  {
    label: 'Cartera',
    route: '/finanzas/cartera',
    icon: 'pi pi-address-book',
    permission: Permission.FINANCE_RECEIVABLES_VER,
  },
  {
    label: 'Pagos a proveedor',
    route: '/finanzas/pagos-comprobantes',
    icon: 'pi pi-send',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    label: 'Hallazgos',
    route: '/finanzas/hallazgos',
    icon: 'pi pi-flag',
    permission: Permission.FINANCE_AI_CHAT,
  },
  {
    label: 'Tareas de conciliación',
    route: '/finanzas/tareas',
    icon: 'pi pi-check-square',
    permission: Permission.FINANCE_BANK_VER,
  },
  {
    label: 'Solicitudes de gasto',
    route: '/finanzas/solicitudes',
    icon: 'pi pi-file-edit',
    permission: Permission.FINANCE_EXPENSES_VER,
  },
  {
    label: 'Capturar gasto',
    route: '/finanzas/capturar-gasto',
    icon: 'pi pi-upload',
    permission: Permission.FINANCE_EXPENSES_CAPTURAR,
  },
  {
    label: 'Pregúntale a Maat',
    route: '/finanzas/maat',
    icon: 'pi pi-sparkles',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
