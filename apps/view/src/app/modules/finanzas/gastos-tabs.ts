import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[GX.80]` — **Las cuatro pantallas de Gastos, en pestañas.**
 *
 * Pedido del usuario (2026-10-09): en el menú lateral eran cuatro renglones; ahora son UNA
 * entrada, «Gastos», y adentro se cambia de pantalla con pestañas horizontales. Es el patrón de
 * Almacén (`almacen-area-shell` + `app-page-tabs`).
 *
 * Esta lista la leen tres lugares y por eso vive una sola vez:
 *  · la barra de pestañas (`GastosAreaShellComponent`);
 *  · la entrada del menú (`layout.component.ts`): lleva a la PRIMERA pestaña que la persona ve
 *    y se marca activa en las cuatro;
 *  · el registro de pestañas de Finanzas (`FINANZAS_TABS`).
 *
 * Cada pestaña conserva el permiso de su ruta: la barra sólo muestra lo que la persona puede
 * abrir, y con una sola pestaña visible la barra no se pinta.
 */
export const GASTOS_TABS: readonly PageTab[] = [
  {
    // `[GX.17]` Dar luz verde: sólo quien puede firmar.
    label: 'Aprobación de gastos',
    route: '/finanzas/aprobacion-gastos',
    icon: 'pi pi-verified',
    permission: Permission.FINANCE_EXPENSES_COMPROBAR,
  },
  {
    // `[GX.33]` Lo que levantó uno mismo, con su estado. Para quien sólo captura.
    label: 'Mis gastos',
    route: '/finanzas/mis-gastos',
    icon: 'pi pi-wallet',
    anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR],
  },
  {
    // `[GX.59]` El trámite de TODAS las personas, agrupado por persona, con el veredicto del
    // protocolo. Es la pantalla que el usuario pidió «en lugar de historial».
    label: 'Expediente',
    route: '/finanzas/expediente',
    icon: 'pi pi-folder-open',
    permission: Permission.FINANCE_EXPENSES_COMPROBAR,
  },
  {
    // `[GX.33]` De todas las fechas y de toda la empresa: es para quien REVISA.
    // ⚠️ `[GX.59]` NO se retiró: 14 personas con `_VER` y sin `_COMPROBAR` se quedarían sin
    // ninguna vista de empresa. `[GX.71]` + HISTORIAL_TODOS (por persona), el mismo trío que la ruta.
    label: 'Historial',
    route: '/finanzas/gastos-historial',
    icon: 'pi pi-history',
    anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_COMPROBAR, Permission.FINANCE_EXPENSES_HISTORIAL_TODOS],
  },
];
