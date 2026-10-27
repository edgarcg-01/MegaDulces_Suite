import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Las pantallas del sub-módulo **Ruta Directa**, que cuelgan de «Ventas por ruta».
 *
 * ⛔ **Por qué viven en su propio archivo.** Estaban sueltas dentro de `REPORTS_TABS`, mezcladas
 * con Sell-Out, Análisis y Salidas, que son reportes de venta general. Al derivar el sidebar de
 * esa lista (`[SN.31]`) las siete cayeron aplanadas en el grupo «Reportes» — y no son reportes
 * sueltos: son **un sub-módulo**, la misma operación mirada por siete lados (lo que vendió, lo
 * que cargó, lo que cobra el chofer, su objetivo, su resultado, su gasto y su camioneta).
 * Aplanarlas las escondía entre cosas que no tienen que ver.
 *
 * ⭐ `[NAV.8.1]` (2026-10-27) Es la ÚNICA barra de sus pantallas. Hasta ese día Ventas por ruta e
 * Inventario de ruta pintaban además la tira combinada con Sell-Out (`REPORTS_TABS`, 11 pestañas)
 * mientras las otras cuatro pintaban ésta: la misma entrada mostraba dos barras distintas.
 */
/**
 * ⛔ `[AUD-A5]` **El conjunto se llama «Ruta Directa»; «Ventas por ruta» es UNA de sus siete.**
 *
 * Durante tres semanas el ítem del sidebar se llamó como su primera pestaña, y eso salía en la
 * migaja: estando en `/comercial/comisiones`, el eslabón con `aria-current="page"` decía
 * **«Ventas por ruta»** — nombraba otra pantalla. La causa es que `currentPageTitle()` del
 * layout resuelve por `isNavActive()` y devuelve la etiqueta del **ítem**, no la de la pestaña
 * activa; con un ítem bien nombrado la migaja dice la verdad sin tocar esa lógica.
 *
 * ⚠️ Si alguna vez hace falta que la migaja diga la **pestaña** y no el sub-módulo, el lugar es
 * `currentPageTitle()`, no esta lista. Renombrar la primera pestaña para «arreglar» la migaja
 * volvería a mezclar el nombre de la parte con el del todo.
 */
export const RUTA_DIRECTA_LABEL = 'Ruta Directa';

export const RUTA_DIRECTA_TABS: PageTab[] = [
  {
    label: 'Ventas por ruta',
    route: '/comercial/ventas-por-ruta',
    icon: 'pi pi-directions',
    permission: Permission.COMMERCIAL_ROUTE_SALES_VER,
  },
  {
    // RD.13 — la misma operacion del otro lado: lo que se le cargo al camion contra lo que
    // vendio. Mismo permiso que Ventas por ruta; no es nomina.
    label: 'Inventario de ruta',
    route: '/comercial/inventario-ruta',
    icon: 'pi pi-truck',
    permission: Permission.COMMERCIAL_ROUTE_SALES_VER,
  },
  {
    // RD.6 — la comision quincenal de Ruta Directa. Al lado de Ventas por ruta porque es la
    // misma venta, pero con permiso PROPIO: ver cuanto vendio una ruta y ver cuanto cobra su
    // chofer son cosas distintas, y lo segundo es nomina.
    label: 'Comisiones RD',
    route: '/comercial/comisiones',
    icon: 'pi pi-percentage',
    permission: Permission.COMMERCIAL_COMMISSIONS_VER,
  },
  // ⛔ `[AUD-A6]` Acá estaba «Objetivo RD» como pestaña propia, con este argumento:
  // *«configurar un bono y verificar una corrida de nómina son dos trabajos distintos»*.
  //
  // ⭐ Se retiró el 2026-10-20 por pedido de Edgar: **todo lo que es comisión de Ruta Directa
  // vive en una sola interfaz**. El argumento de arriba describía bien dos TAREAS, pero las
  // dos son el mismo número mirado por sus dos lados — el bono **entra a la quincena**, no es
  // un vecino. Hoy es la vista «Bono por objetivo» dentro de Comisiones RD.
  //
  // ⚠️ La ruta `/comercial/comisiones/objetivo` **sigue viva** y abre esa vista directamente,
  // así que los enlaces y favoritos que ya existen no se rompen: se retira la pestaña, no el
  // camino. Y ⛔ `/finanzas/comisiones-logistica` NO entró a la fusión: otro permiso, otra
  // población (choferes de embarque) y otro dominio.
  {
    // `[RD.57]` — la misma operacion mirada por el resultado: utilidad bruta, kilometros del
    // GPS y gasto del departamento. Permiso PROPIO y mas estrecho que Comisiones: publica el
    // gasto del area completo (nomina, SUA, comisiones), no lo que cobra cada persona.
    label: 'Rentabilidad RD',
    route: '/comercial/ruta-directa/rentabilidad',
    icon: 'pi pi-chart-line',
    permission: Permission.COMMERCIAL_ROUTE_PROFIT_VER,
  },
  {
    // [RD.60] el gasto renglon por renglon. Mismo permiso: es la misma superficie.
    label: 'Gasto RD',
    route: '/comercial/ruta-directa/gastos',
    icon: 'pi pi-receipt',
    permission: Permission.COMMERCIAL_ROUTE_PROFIT_VER,
  },
  {
    // [RD.60] la ficha de cada camioneta, con lo que falta capturar declarado.
    label: 'Flota RD',
    route: '/comercial/ruta-directa/flota',
    icon: 'pi pi-truck',
    permission: Permission.COMMERCIAL_ROUTE_PROFIT_VER,
  },
];
