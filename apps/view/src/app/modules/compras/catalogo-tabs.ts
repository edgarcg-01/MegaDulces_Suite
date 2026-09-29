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
    route: '/compras/catalogo/costos',
    icon: 'pi pi-dollar',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
    // La pantalla existente de diferencias es contenido especializado de este apartado.
    alsoActiveOn: ['/compras/catalogo/precios'],
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
