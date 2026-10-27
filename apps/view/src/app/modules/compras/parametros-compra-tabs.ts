import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.5]` Las pantallas que **configuran el motor del pedido**, en un solo apartado.
 *
 * Eran tres renglones sueltos del sidebar de Compras —Proveedores y Categorías en «Catálogo»,
 * Red de abasto en «Planeación»— y las tres contestan lo mismo: *¿con qué parámetros planea el
 * motor?* Proveedores = tiempo de entrega, ciclo, mínimo y fill rate por proveedor; Categorías =
 * la clasificación que alimenta los filtros de Pedido y Existencia; Red de abasto = de qué
 * almacén se surte cada sucursal. Ninguna se opera a diario: en 30 días las tres juntas sumaron
 * **cero** visitas (telemetría de la suite, 2026-10-26), así que ocupaban tres renglones de un
 * menú cuyo uso real está en Pedido, Control de entradas y Catálogo.
 *
 * ⛔ **La barra la pintan las TRES páginas** (`<app-page-tabs [tabs]="tabs" />`). Es la lección
 * de `[NAV.2]`: un `tabs:` en el sidebar no crea la barra, sólo apunta a ella; plegar el menú
 * sin que la página la pinte deja pantallas sin camino. `check-sidebar-tabs.js` lo vigila.
 *
 * Cada pestaña conserva SU permiso: la entrada del sidebar se ve si la persona ve al menos una,
 * y lleva a la primera que puede ver. Nadie gana ni pierde acceso.
 */
/**
 * ⛔ `[AUD-A5]` **El conjunto se llama «Parámetros de compra»; ninguna de sus pestañas se llama
 * así.** La migaja toma la etiqueta del ítem del sidebar: si el conjunto se llamara como una de
 * sus partes, estando en otra pestaña la migaja nombraría la pantalla equivocada. Por eso la
 * página de Proveedores, que se titulaba «Parámetros de compra», pasa a «Parámetros por
 * proveedor».
 */
export const PARAMETROS_COMPRA_LABEL = 'Parámetros de compra';

export const PARAMETROS_COMPRA_TABS: PageTab[] = [
  {
    // RA-PRO.3/10 — lead time, ciclo (cadencia + colchón), mínimo de compra y fill rate.
    label: 'Proveedores',
    route: '/compras/proveedores',
    icon: 'pi pi-truck',
    permission: Permission.COMPRAS_PROVEEDORES_VER,
  },
  {
    // RA-PRO.12 — normalización de categorías de compra (plaza/sourcing).
    label: 'Categorías',
    route: '/compras/categorias',
    icon: 'pi pi-tags',
    permission: Permission.COMPRAS_CATEGORIAS_VER,
  },
  {
    // RA-PRO.6 — el árbol CEDIS → sucursal del DRP.
    label: 'Red de abasto',
    route: '/compras/red',
    icon: 'pi pi-sitemap',
    permission: Permission.COMPRAS_RED_VER,
  },
];
