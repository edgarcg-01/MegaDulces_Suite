import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.8]` **Precios**: las listas que se cobran y el control de margen que decide moverlas.
 *
 * Eran dos renglones del sidebar de Comercial —«Listas de precios» y «Control de margen» (Motor ·
 * Competencia · Experimentos)— y contestan la misma pregunta en dos tiempos: *¿a cuánto vendo?* y
 * *¿a cuánto debería vender?*. En 30 días: Listas 7 visitas, Control de margen 2 (telemetría de la
 * suite, 2026-10-27). Se pliegan para que el sidebar de Comercial quepa sin scroll.
 *
 * Las tres de Control de margen vivían en `precios-tabs.ts` (`PRECIOS_TABS`); se mudaron acá
 * enteras, con su orden y sus permisos, porque ya no las usaba nadie más: `/comercial/precios`
 * despacha con `PRECIOS_LANDING` (`permission.guard.ts`), no con esta lista.
 *
 * `[PR.V2]` — Motor y Experimentos responden la misma pregunta en dos tiempos: el motor dice **qué
 * precio conviene mover**, y el experimento es **lo único que puede convertir esa acción de «efecto
 * no medido» a medida**. Separados, quien abría el motor no se enteraba de que el experimento existía.
 *
 * ⭐ `PageTabsComponent` ya ES el selector segmentado, ya navega por ruta y ya **filtra las
 * pestañas por permiso**; se esconde solo cuando queda una sola pestaña visible.
 *
 * ⚠️ **No hay componente shell.** Almacén tiene uno porque monta la barra para ~19 páginas; acá son
 * cuatro, y un padre anidado además rompería el parser de `landing-guards.spec`, que sólo lee rutas
 * hijas a un nivel.
 *
 * ⛔ La barra la pintan las CUATRO páginas (lección de `[NAV.2]`).
 */
/** ⛔ `[AUD-A5]` El conjunto no se llama como ninguna de sus pestañas: la migaja toma este nombre. */
export const PRECIOS_APARTADO_LABEL = 'Precios';

export const PRECIOS_APARTADO_TABS: PageTab[] = [
  {
    label: 'Listas de precios',
    route: '/comercial/pricing',
    icon: 'pi pi-tag',
    permission: Permission.COMMERCIAL_PRICING_VER,
  },
  {
    label: 'Motor',
    icon: 'pi pi-sliders-h',
    route: '/comercial/precios/motor',
    permission: Permission.COMMERCIAL_MARGIN_ENGINE_VER,
  },
  {
    // `[PR.M3]`+`[PR.M6]` — ⭐ Va en MEDIO, y no al final, porque responde la pregunta que
    // alguien se hace ENTRE ver qué mover y decidir medirlo: «¿y la competencia qué está
    // haciendo?». Mismo permiso que el motor: es la misma lectura, no un módulo aparte.
    label: 'Competencia',
    icon: 'pi pi-users',
    route: '/comercial/precios/competencia',
    permission: Permission.COMMERCIAL_MARGIN_ENGINE_VER,
  },
  {
    // ⚠️ `anyOf` en experimentos, no `permission`: hay roles con GESTIONAR y sin VER, y con un
    // permiso único perderían la pestaña aunque el guard de la ruta los dejara entrar.
    label: 'Experimentos',
    icon: 'pi pi-chart-scatter',
    route: '/comercial/precios/experimentos',
    anyOf: [
      Permission.COMMERCIAL_PRICE_EXPERIMENT_VER,
      Permission.COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR,
    ],
  },
];
