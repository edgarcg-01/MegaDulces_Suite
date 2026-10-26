import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.7]` **Cortes y arqueos**: el efectivo de las cajas de sucursal, del corte al conteo.
 *
 * - **Cortes / Sucursales** (`[CSU]`): el corte de caja POS (`U-D-23`) → el cobro que lo salda → el
 *   arqueo del turno.
 * - **Cuadre de movimientos** (`[SM.9]`): el arqueo ciego contra el corte de caja (ADR-029).
 *
 * Eran dos renglones del sidebar de Finanzas (uno en «Ingresos» y otro en «Egresos y bancos»); los dos
 * miran la misma caja de sucursal. Se pliegan en uno para que el sidebar quepa sin scroll.
 * ⛔ La barra la pintan las DOS páginas (lección de `[NAV.2]`). Cada pestaña conserva su permiso.
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const CORTES_ARQUEOS_LABEL = 'Cortes y arqueos';

export const CORTES_ARQUEOS_TABS: PageTab[] = [
  {
    label: 'Cortes / Sucursales',
    route: '/finanzas/cortes-sucursales',
    icon: 'pi pi-shop',
    permission: Permission.FINANCE_CORTES_VER,
  },
  {
    label: 'Cuadre de movimientos',
    route: '/finanzas/cuadre',
    icon: 'pi pi-sliders-h',
    permission: Permission.RECONCILIATION_VER,
  },
];
