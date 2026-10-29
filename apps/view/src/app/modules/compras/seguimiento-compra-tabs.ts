import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.6]` **Seguimiento de compra**: lo que pasa con el pedido después de armarlo, en el orden
 * en que avanza el documento. El pedido genera la requisición, la requisición se vuelve orden, y
 * la orden que no cierra queda abierta en Kepler.
 *
 * Eran tres renglones del sidebar. Se pliegan en uno para que el sidebar de Compras quepa sin
 * scroll, y la entrada va JUSTO DEBAJO de Pedido: el paso siguiente del pedido queda a un clic y
 * aterriza en Requisiciones, que es la pestaña que más se abre (51 visitas en 30 días, contra 21
 * de Órdenes y 17 de Abiertas; telemetría de la suite, 2026-10-26).
 *
 * ⛔ La barra la pintan las TRES páginas (lección de `[NAV.2]`). Cada pestaña conserva su permiso.
 * El detalle de una requisición o de una orden (`/compras/requisiciones/:id`) sigue marcando esta
 * entrada como activa: el layout compara por prefijo.
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const SEGUIMIENTO_COMPRA_LABEL = 'Seguimiento de compra';

export const SEGUIMIENTO_COMPRA_TABS: PageTab[] = [
  {
    // `[PQ.16]` D21 (2026-10-26): la orden de compra ES la de Kepler (X-A-35). Esta pestaña sube al
    // segundo lugar y toma el nombre del documento; la lista interna baja a «histórico».
    // RA-PRO.45 — las OCs de Kepler que quedaron abiertas: lo que hay que cerrar o cancelar para
    // que dejen de tapar el pedido. Mismo permiso que Pedido (es la otra cara del dato).
    label: 'Órdenes de compra (Kepler)',
    route: '/compras/oc-abiertas',
    icon: 'pi pi-shopping-cart',
    permission: Permission.COMPRAS_PEDIDO_VER,
  },
  {
    // `[PQ.20]` El interruptor de la escritura a Kepler, sin desplegar. Verlo = ver requisiciones;
    // cambiarlo pide `COMPRAS_KEPLER_ESCRITURA` (lo gatea la página y el endpoint).
    label: 'Escritura a Kepler',
    route: '/compras/kepler-escritura',
    icon: 'pi pi-power-off',
    permission: Permission.COMPRAS_REQUISICIONES_VER,
  },
  {
    // `[PQ.28]` D3 (Edgar, 2026-10-29): Requisiciones deja de ser lugar de trabajo. Se genera, se
    // aprueba y se sigue desde Pedido (ventana «Lo pedido»); acá queda al final, como consulta.
    label: 'Requisiciones (consulta)',
    route: '/compras/requisiciones',
    icon: 'pi pi-file-edit',
    permission: Permission.COMPRAS_REQUISICIONES_VER,
  },
];
