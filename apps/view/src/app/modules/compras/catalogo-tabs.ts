import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[CAT.1]` — pestañas de **Catálogo** (proyecto Compras).
 *
 * El catálogo de productos vivía en Ventas (`/comercial/products`), pero quien lo mantiene es el
 * comprador: él da de alta el producto, negocia el costo y captura el precio en Kepler. Se muda a
 * Compras y de paso deja de ser una pantalla suelta.
 *
 * Las tres contestan una pregunta distinta:
 *   1. **Catálogo** — la ficha: nombre, SKU, marca, proveedor, categoría, ubicación, costo,
 *      unidad y el precio al cliente.
 *   2. **Códigos repetidos** — ¿qué código de barras está dado de alta en más de un producto? Al
 *      escanear, la caja tiene dos altas para el mismo código y cobra la que le toque. Es un
 *      defecto **local** —pasa en un mostrador aunque todas las sucursales estén alineadas— y la
 *      pregunta no es en qué sucursal, sino **cuál alta se queda**.
 *
 * Las tres piden `COMMERCIAL_PRODUCTS_VER`: es el mismo catálogo mirado de dos formas, no dos
 * módulos. Así la mudanza no necesita repartir ningún permiso nuevo y nadie pierde acceso.
 */
export const CATALOGO_TABS: PageTab[] = [
  {
    label: 'Catálogo',
    route: '/compras/catalogo',
    icon: 'pi pi-shopping-bag',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    label: 'Códigos repetidos',
    route: '/compras/catalogo/codigos',
    icon: 'pi pi-qrcode',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  {
    // [CAT.3] El mismo producto a distinto precio segun la plaza. Casi siempre es un cambio que
    // no se replico, no una decision comercial.
    label: 'Precios distintos',
    route: '/compras/catalogo/precios',
    icon: 'pi pi-sliders-h',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
];
