import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[RE.16]` — pestañas del **Centro de control** de facturas de entrada.
 *
 * Antes eran cinco items de sidebar sueltos (pendientes · lote · revisión · todas · gemelas) y
 * se leían como cinco módulos distintos. Son un solo proceso con tres oficios, así que el
 * sidebar queda en tres items —uno por rol— y lo que el administrador *observa* (no opera) se
 * agrupa acá.
 *
 * Las cuatro contestan una pregunta distinta, y en ese orden:
 *   1. **Por sucursal** — ¿quién no está subiendo, y hay alguien que pueda?
 *   2. **Órdenes** — la lista completa, para buscar una en particular.
 *   3. **Capturadas dos veces** — ¿qué dinero se cuenta doble por falta de dictamen?
 *   4. **Ajustes** — los parámetros del proceso (hasta ahora sólo se movían con SQL a mano).
 *
 * `PageTabs` esconde la barra si queda una sola visible, así que un usuario sin `_VALIDAR` ve
 * el centro sin la pestaña de Ajustes y sin rastro de que existe.
 */
export const ENTRADAS_CONTROL_TABS: PageTab[] = [
  {
    label: 'Por sucursal',
    route: '/compras/entradas/control',
    icon: 'pi pi-sitemap',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
  {
    // RE.19 — se llamaba "Órdenes" y chocaba con "Órdenes de compra" del sidebar, que es otra
    // cosa (lo que pedimos, no lo que llegó). Acá son órdenes de ENTRADA, y el nombre lo dice.
    label: 'Todas las entradas',
    route: '/compras/entradas/control/ordenes',
    icon: 'pi pi-inbox',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
  {
    label: 'Capturadas dos veces',
    route: '/compras/entradas/control/gemelas',
    icon: 'pi pi-clone',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
  {
    label: 'Ajustes',
    route: '/compras/entradas/control/ajustes',
    icon: 'pi pi-sliders-h',
    // Mover la fecha de arranque cambia el % de cobertura de toda la red: mismo permiso que
    // dictaminar, no el de mirar.
    permission: Permission.COMPRAS_ENTRADAS_VALIDAR,
  },
];
