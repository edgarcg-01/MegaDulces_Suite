import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[RE.16]` — pestañas de **Control de entradas**.
 *
 * Antes eran cinco items de sidebar sueltos (pendientes · lote · revisión · todas · gemelas) y
 * se leían como cinco módulos distintos. Son un solo proceso con tres oficios, así que el
 * sidebar queda en tres items —uno por rol— y lo que el administrador *observa* (no opera) se
 * agrupa acá.
 *
 * `[RE.20.0]` — nombres formalizados. Las cuatro contestan una pregunta distinta, y en ese orden:
 *   1. **Cobertura por sucursal** — ¿quién no está subiendo, y hay alguien que pueda?
 *   2. **Listado** — todas las entradas, para buscar una en particular.
 *   3. **Capturas duplicadas** — ¿qué dinero se cuenta doble por falta de dictamen?
 *   4. **Parámetros** — la configuración del proceso (antes sólo se movía con SQL a mano).
 *
 * `PageTabs` esconde la barra si queda una sola visible, así que un usuario sin `_VALIDAR` ve
 * el control sin la pestaña de Parámetros y sin rastro de que existe.
 */
export const ENTRADAS_CONTROL_TABS: PageTab[] = [
  {
    // Dice qué MIDE, no cómo agrupa.
    label: 'Cobertura por sucursal',
    route: '/compras/entradas/control',
    icon: 'pi pi-sitemap',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
  {
    // RE.20.0 — se llamaba "Órdenes" y chocaba con "Órdenes de compra" del sidebar, que es lo
    // que pedimos y no lo que llegó. Adentro de "Control de entradas" no hace falta repetir
    // "entradas": es el listado de esta pantalla.
    label: 'Listado',
    route: '/compras/entradas/control/ordenes',
    icon: 'pi pi-inbox',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
  {
    label: 'Capturas duplicadas',
    route: '/compras/entradas/control/gemelas',
    icon: 'pi pi-clone',
    permission: Permission.COMPRAS_ENTRADAS_VER,
  },
  {
    // RE.20.0 — "Ajustes" chocaba con los **ajustes de compra** (notas de crédito X-D-55 y
    // devoluciones X-D-40), que son otra cosa y viven en /compras/descuentos.
    label: 'Parámetros',
    route: '/compras/entradas/control/ajustes',
    icon: 'pi pi-sliders-h',
    // Mover la fecha de arranque cambia el % de cobertura de toda la red: mismo permiso que
    // dictaminar, no el de mirar.
    permission: Permission.COMPRAS_ENTRADAS_VALIDAR,
  },
];
