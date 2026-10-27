import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.7]` **Bancos y conciliación**: los movimientos del banco, lo que falta conciliar y los
 * documentos cancelados que la conciliación tiene que excluir.
 *
 * Eran tres renglones del sidebar de Finanzas. Las tres pantallas comparten permiso
 * (`FINANCE_BANK_VER`) y público (Tesorería). En 30 días: Bancos 88 visitas, Cancelados 2, Tareas de
 * conciliación 1 (telemetría de la suite, 2026-10-26). Se pliegan para que el sidebar quepa sin scroll.
 * ⛔ La barra la pintan las TRES páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const BANCOS_CONCILIACION_LABEL = 'Bancos y conciliación';

export const BANCOS_CONCILIACION_TABS: PageTab[] = [
  {
    label: 'Bancos',
    route: '/finanzas/bancos',
    icon: 'pi pi-building-columns',
    permission: Permission.FINANCE_BANK_VER,
  },
  {
    label: 'Tareas de conciliación',
    route: '/finanzas/tareas',
    icon: 'pi pi-check-square',
    permission: Permission.FINANCE_BANK_VER,
  },
  {
    label: 'Cancelados',
    route: '/finanzas/cancelados',
    icon: 'pi pi-ban',
    permission: Permission.FINANCE_BANK_VER,
  },
];
