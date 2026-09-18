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
    // CG.14 — la mitad que ESCRIBE. 'Caja General' (arriba) es la lectura del espejo del
    // Access y se retira en CG.16; las dos conviven durante el traslape a propósito.
    label: 'Caja (captura)',
    route: '/finanzas/caja-general',
    icon: 'pi pi-pencil',
    permission: Permission.FINANCE_CAJA_VER,
  },
  {
    label: 'Cancelados',
    route: '/finanzas/cancelados',
    icon: 'pi pi-ban',
    permission: Permission.FINANCE_BANK_VER,
  },
  {
    /**
     * UNA entrada para las dos mitades del mismo oficio: **Cartera** es lo que te deben
     * (saldo por cliente, aging, y las aplicaciones de cada factura — cobros, notas de
     * crédito, devoluciones) y **Cobranza** es lo que te pagaron (la ficha de depósito
     * adjunta a cada cobro de Kepler). Eran dos tabs sueltos entre los doce de Finanzas.
     * Adentro se cambia de vista con el selector (`app-cartera-segments`).
     *
     * `anyOf` por el mismo motivo que «Gastos» de más abajo: las dos vistas exigen
     * permisos DISTINTOS (`FINANCE_RECEIVABLES_VER` / `FINANCE_COLLECTIONS_VER`) y con
     * un permiso único uno de los dos públicos perdería el tab.
     *
     * ⚠️ Y por eso la ruta la protege `carteraEntryGuard`, no un `permissionGuard`: el
     * tab apunta a UNA url, así que a quien sólo tiene cobranza hay que LLEVARLO a su
     * mitad, no rebotarlo. Un tab visible que al abrirse manda a /sin-acceso es peor
     * que no tener tab.
     */
    label: 'Cartera',
    route: '/finanzas/cartera',
    icon: 'pi pi-address-book',
    anyOf: [Permission.FINANCE_RECEIVABLES_VER, Permission.FINANCE_COLLECTIONS_VER],
    alsoActiveOn: ['/finanzas/cobranza'],
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
  // Presupuesto se movió a su MÓDULO propio (`/presupuesto`, Fase PU) — ya no es tab de Finanzas.
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
