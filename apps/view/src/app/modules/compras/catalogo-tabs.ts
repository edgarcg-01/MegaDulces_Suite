import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Navegación del Centro de catálogo de Compras.
 *
 * `[PF.12.1]` **Productos va PRIMERA y las cuatro pantallas vacías no son pestañas.** El menú lateral manda a
 * la primera pestaña que la persona ve (`conDestino()` en el layout) y la primera era «Resumen», un marcador
 * vacío («Estructura preparada · Contenido por desarrollar»): medido en prod el 2026-10-29, todo el que
 * entraba a Compras › Catálogo caía ahí y no veía la lista de productos. Resumen, Solicitudes, Incidencias
 * y Listas de precios salen de las pestañas; sus RUTAS siguen en `app.routes.ts`. Esta lista es la única
 * fuente: la leen el menú lateral, la barra de pestañas y el menú «Ver» del catálogo.
 * Cuando una de esas pantallas tenga contenido, se vuelve a agregar su pestaña aquí.
 */
export const CATALOGO_TABS: PageTab[] = [
  {
    label: 'Productos',
    route: '/compras/catalogo',
    icon: 'pi pi-shopping-bag',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  /**
   * `[NP.22]` «Productos nuevos» YA NO es pestaña: vive dentro de Productos como «Mostrar › Productos nuevos»
   * (decisión de David, 2026-11-04: una sola pantalla, menos ventanas). `/compras/catalogo/nuevos` redirige a
   * `/compras/catalogo?mostrar=nuevos` (`app.routes.ts`). No la vuelvas a agregar aquí: `catalogo-tabs.spec.ts` se pone rojo.
   */
  /**
   * `[NP.7.L.3b]` Catálogo digital: lo que levanta el personal desde el celular, por revisar. Su propia clave:
   * no la ve quien sólo consulta el catálogo.
   */
  {
    label: 'Catálogo digital',
    route: '/compras/catalogo/digital',
    icon: 'pi pi-camera',
    permission: Permission.CATALOGO_FICHAS_REVISAR,
  },
  /**
   * `[MOS.2]` No registrados: lo que se escaneó en el mostrador y Kepler no tiene en esa sucursal.
   * Mismo permiso que su endpoint (`GET /commercial/floor-stockouts/no-registrados`).
   */
  {
    label: 'No registrados',
    route: '/compras/catalogo/no-registrados',
    icon: 'pi pi-question-circle',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  /**
   * `[CAT-PRECIO.1]`/`[CAT-PRECIO.5]` Mantenimiento: todo lo que le falta o está mal a la ficha de
   * Kepler — lo que no coincide entre sucursales y lo que está sin clasificar (línea, tipo, grupo).
   * Pedido de Compras (2026-10-16): Precios es el catálogo de precios; lo que hay que CORREGIR vive aquí.
   */
  {
    label: 'Mantenimiento',
    route: '/compras/catalogo/mantenimiento',
    icon: 'pi pi-wrench',
    permission: Permission.COMMERCIAL_PRODUCTS_VER,
  },
  /**
   * `[CAT-COSTO.0]` Costos y Precios son dos tabs, no uno.
   *
   * Eran un solo tab que abría Precios (la pantalla que ya funcionaba) y dejaba Costos
   * detrás del mismo botón. Se separan porque el costo es el tema que se va a profundizar:
   * lo negocia el comprador con el proveedor, mientras que el precio se fija en Kepler a
   * partir de él. Cada uno abre SU pantalla, así que Precios no pierde nada al separarse.
   */
  {
    label: 'Costos',
    route: '/compras/catalogo/costos',
    icon: 'pi pi-wallet',
    // [CAT-COSTO.4] El costo es dato sensible: el tab sólo lo ve quien tiene el permiso del
    // costo estándar, el mismo que guarda la ruta. Un tab visible que rebota es peor que ninguno.
    permission: Permission.COMPRAS_COSTO_ESTANDAR_VER,
  },
  {
    label: 'Precios',
    route: '/compras/catalogo/precios',
    icon: 'pi pi-dollar',
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
