import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.7]` **Deuda con proveedores**: cuánto se debe, documento por documento y por proveedor.
 *
 * - **Estado de cuenta acreedores** (`[ECA]`): la deuda de Kepler (`kdxe`/`kdxf`) por documento y para
 *   todo tipo de acreedor.
 * - **Cuadre y deuda** (`[CXP.7]`): el movimiento del periodo por proveedor, pólizas de la cuenta 201.
 * - **Cuentas por pagar**: el tablero de control de pagos.
 *
 * ⛔ **NO entran a `PAGOS_TABS`, a propósito.** `[PGP.7]` (2026-10-24) dejó «Pagos» con las dos
 * pantallas del ciclo vivo —hacer el pago y comprobarlo— para que hacer un pago no cueste tres
 * pantallas, y `finanzas-tabs.spec.ts` lo fija. Esto es la deuda que se mira ANTES de pagar: va
 * en su propio apartado, junto a Pagos.
 *
 * En 30 días: Estado de cuenta 35 visitas, Cuadre y deuda 2, Cuentas por pagar 0 (telemetría de la
 * suite, 2026-10-26). ⛔ La barra la pintan las TRES páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const DEUDA_PROVEEDORES_LABEL = 'Deuda con proveedores';

export const DEUDA_PROVEEDORES_TABS: PageTab[] = [
  {
    label: 'Estado de cuenta acreedores',
    route: '/finanzas/estado-cuenta-acreedores',
    icon: 'pi pi-book',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    label: 'Cuadre y deuda',
    route: '/finanzas/cuadre-proveedor',
    icon: 'pi pi-wallet',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    label: 'Cuentas por pagar',
    route: '/finanzas/pagos-control',
    icon: 'pi pi-chart-bar',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
