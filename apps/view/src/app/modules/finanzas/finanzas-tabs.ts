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
    label: 'Ingresos contables',
    route: '/finanzas/ingresos',
    icon: 'pi pi-arrow-down-left',
    permission: Permission.FINANCE_INCOME_VER,
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
    // CS.2 — Reporte de la caja fuerte de efectivo (CAOS). Sólo lectura, permiso propio.
    label: 'Caja Fuerte',
    route: '/finanzas/caos',
    icon: 'pi pi-lock',
    permission: Permission.FINANCE_CAOS_VER,
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
    label: 'Crédito',
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
    label: 'Levantamiento de gasto',
    route: '/finanzas/gastos',
    icon: 'pi pi-file-edit',
    // `[GX.17]` SIN permiso: la ruta es `canActivate: []`. El `anyOf` que traía escondía
    // el tab a 66 de los 166 activos que la ruta sí deja entrar.
  },
  {
    // `[GX.17]` La otra mitad del trámite. Mismo orden que el sidebar, a propósito.
    label: 'Aprobación de gastos',
    route: '/finanzas/aprobacion-gastos',
    icon: 'pi pi-verified',
    permission: Permission.FINANCE_EXPENSES_COMPROBAR,
  },
  {
    // `[GX.33]` Lo que levantó uno mismo, con su estado. Para quien sólo captura.
    label: 'Mis gastos',
    route: '/finanzas/mis-gastos',
    icon: 'pi pi-wallet',
    anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR],
  },
  {
    // `[GX.33]` De todas las fechas y de toda la empresa: es para quien REVISA.
    label: 'Historial',
    route: '/finanzas/gastos-historial',
    icon: 'pi pi-history',
    anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_COMPROBAR],
  },
  // `[GX.18]` La pestaña del tablero salió por pedido del usuario. La ruta sigue viva.
  {
    label: 'Pregúntale a Maat',
    route: '/finanzas/maat',
    icon: 'pi pi-sparkles',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
