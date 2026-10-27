import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.7]` **Libros contables**: los dos lados del libro, el gasto y la venta por cuenta contable.
 *
 * Eran dos renglones del sidebar de Finanzas, uno en cada grupo. Cada pestaña conserva SU permiso:
 * `[IG.2]` le dio permiso propio a Ingresos porque hay roles que ven la venta y no el gasto.
 * Egresos contables es la pantalla de inicio de `/finanzas` y el eje del módulo: en 30 días se abrió
 * en la misma visita que Gastos 26 veces, que Control 24, que Caja 20 y que Cortes 16 (telemetría de
 * la suite, 2026-10-26). ⛔ La barra la pintan las DOS páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const LIBROS_CONTABLES_LABEL = 'Libros contables';

export const LIBROS_CONTABLES_TABS: PageTab[] = [
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
];
