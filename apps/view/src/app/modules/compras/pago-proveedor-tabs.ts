import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.6]` **Pago a proveedor**: lo que Compras le entrega a Finanzas después de recibir, en el
 * orden en que se trabaja. Qué se entrega como deuda (Obligaciones), cuándo vence (Qué vence) y a
 * qué cuenta se paga (Cuentas de pago). El Calendario de pagos vive en Finanzas.
 *
 * Eran un grupo de tres renglones (`[NAV.4]`); se pliegan en una entrada para que el sidebar de
 * Compras quepa sin scroll. ⛔ La barra la pintan las TRES páginas (lección de `[NAV.2]`).
 *
 * ⚠️ Cada pestaña conserva el permiso que tenía su renglón, para que nadie gane ni pierda acceso.
 * La ruta de Obligaciones además deja entrar a Finanzas con `FINANCE_PAYMENTS_GESTIONAR`
 * (`[RE.32]`, confirmar entregas); eso no cambia, porque Finanzas llega desde su propio módulo.
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const PAGO_PROVEEDOR_LABEL = 'Pago a proveedor';

export const PAGO_PROVEEDOR_TABS: PageTab[] = [
  {
    label: 'Obligaciones',
    route: '/compras/obligaciones',
    icon: 'pi pi-calendar',
    permission: Permission.COMPRAS_OBLIGACIONES_VER,
  },
  {
    // RE.3 — el compromiso de pago que la orden de entrada ya traía y nadie veía.
    label: 'Qué vence',
    route: '/compras/vencimientos',
    icon: 'pi pi-calendar-clock',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
];

// `[PGP.20]` «Cuentas de pago» SALIÓ de aquí el 2026-10-27 y vive en Finanzas › Pagos, pegada al
// Calendario. El motivo es el orden del trabajo, no la categoría: sin la cuenta del proveedor no
// se prepara la transferencia, y quien prepara es Tesorería, no Compras.
// Conserva `COMPRAS_OBLIGACIONES_VER` para que nadie gane ni pierda acceso con la mudanza.
