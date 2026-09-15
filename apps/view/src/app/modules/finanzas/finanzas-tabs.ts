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
    label: 'Cancelados',
    route: '/finanzas/cancelados',
    icon: 'pi pi-ban',
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
    label: 'Calendario de pagos',
    route: '/finanzas/calendario-pagos',
    icon: 'pi pi-calendar',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    label: 'Presupuesto',
    route: '/finanzas/presupuesto',
    icon: 'pi pi-chart-pie',
    permission: Permission.PRESUPUESTOS_VER,
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
    /**
     * GX.10 — UNA entrada para todo el ciclo del gasto. Antes eran tres tabs
     * («Solicitudes de gasto» · «Capturas de campo» · «Capturar gasto») que
     * resolvían el mismo trámite en tres lugares.
     *
     * No se fundieron en una pantalla sola porque son DOS públicos, medido:
     * 11 roles (75 usuarios activos — 32 cajeros, 19 promotores de ruta…) pueden
     * capturar pero NO ver el tablero; y otros 5 pueden ver sin capturar. Una
     * pantalla que exigiera `FINANCE_EXPENSES_VER` habría dejado afuera justo a
     * quienes capturan. Así que la ruta es única y **el contenido se adapta a
     * quién entra** (ver `FinanzasGastosComponent`).
     *
     * Por eso `anyOf`: con un permiso único, uno de los dos grupos perdía
     * el tab aunque el guard lo dejara pasar.
     */
    label: 'Gastos',
    route: '/finanzas/gastos',
    icon: 'pi pi-file-edit',
    anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR],
  },
  {
    label: 'Pregúntale a Maat',
    route: '/finanzas/maat',
    icon: 'pi pi-sparkles',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
