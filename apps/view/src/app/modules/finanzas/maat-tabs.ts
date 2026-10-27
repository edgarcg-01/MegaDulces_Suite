import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.7]` **Maat**, la inteligencia de Finanzas: lo que sus detectores encontraron (Hallazgos) y la
 * conversación para preguntarle (Pregúntale a Maat).
 *
 * Eran un grupo de dos renglones («Inteligencia»), con el mismo permiso (`FINANCE_AI_CHAT`) y 1 visita
 * cada uno en 30 días (telemetría de la suite, 2026-10-26). Se pliegan en una entrada para que el
 * sidebar quepa sin scroll. ⛔ La barra la pintan las DOS páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const MAAT_LABEL = 'Maat';

export const MAAT_TABS: PageTab[] = [
  {
    label: 'Hallazgos',
    route: '/finanzas/hallazgos',
    icon: 'pi pi-flag',
    permission: Permission.FINANCE_AI_CHAT,
  },
  {
    label: 'Pregúntale a Maat',
    route: '/finanzas/maat',
    icon: 'pi pi-sparkles',
    permission: Permission.FINANCE_AI_CHAT,
  },
];
