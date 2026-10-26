import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.6]` **Costos de compra**: el mismo dinero cortado distinto (RE.20.5). Lo que cuesta cada
 * proveedor puesto en casa, el costo estándar que fija el precio, y los descuentos y apoyos que lo
 * bajan.
 *
 * Eran un grupo de tres renglones; se pliegan en una entrada para que el sidebar de Compras quepa
 * sin scroll. En 30 días las tres sumaron cero visitas (telemetría de la suite, 2026-10-26): se
 * consultan, no se operan, y por eso van al final. ⛔ La barra la pintan las TRES páginas.
 *
 * ⚠️ Se llama «Costos de compra» y no «Costos» a secas porque el Catálogo, en el mismo grupo, ya
 * tiene una pestaña «Costos» (costo estándar entre sucursales, `[CAT-COSTO.4]`). Dos cosas con el
 * mismo nombre una encima de la otra se confunden.
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const COSTOS_COMPRA_LABEL = 'Costos de compra';

export const COSTOS_COMPRA_TABS: PageTab[] = [
  {
    label: 'Costo por proveedor',
    route: '/compras/costo-neto',
    icon: 'pi pi-dollar',
    permission: Permission.COMPRAS_COSTO_NETO_VER,
  },
  {
    label: 'Costo estándar',
    route: '/compras/costo-estandar',
    icon: 'pi pi-book',
    permission: Permission.COMPRAS_COSTO_ESTANDAR_VER,
  },
  {
    label: 'Descuentos y apoyos',
    route: '/compras/descuentos',
    icon: 'pi pi-percentage',
    permission: Permission.COMPRAS_DESCUENTOS_VER,
  },
];
