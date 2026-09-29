import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/** Navegación del Centro de catálogo de Compras. */
export const CATALOGO_TABS: PageTab[] = [
  {
    label: 'Resumen',
    route: '/compras/catalogo/resumen',
    icon: 'pi pi-chart-bar',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Productos',
    route: '/compras/catalogo',
    icon: 'pi pi-shopping-bag',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Solicitudes',
    route: '/compras/catalogo/solicitudes',
    icon: 'pi pi-file-edit',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Incidencias',
    route: '/compras/catalogo/incidencias',
    icon: 'pi pi-exclamation-triangle',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Costos y precios',
    /**
     * El tab abre la pantalla que YA FUNCIONA (diferencias de precio), no el cascarón.
     *
     * `Precios distintos` era un tab propio y el comprador lo usa hoy. Si el tab apuntara
     * a `/catalogo/costos`, esa pantalla quedaría detrás de un «contenido por desarrollar»
     * y de un clic extra: una función que sirve no se degrada para hacerle lugar a una que
     * todavía no existe. Cuando `/catalogo/costos` tenga contenido se invierten `route` y
     * `alsoActiveOn`, y nadie pierde nada en el camino.
     */
    route: '/compras/catalogo/precios',
    icon: 'pi pi-dollar',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
    alsoActiveOn: ['/compras/catalogo/costos'],
  },
  {
    label: 'Listas de precios',
    route: '/compras/catalogo/listas-precios',
    icon: 'pi pi-list',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Códigos',
    route: '/compras/catalogo/codigos',
    icon: 'pi pi-qrcode',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Reportes',
    route: '/compras/catalogo/reporte',
    icon: 'pi pi-print',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
];
