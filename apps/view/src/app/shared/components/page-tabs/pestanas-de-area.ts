import type { Permission } from '../../../core/constants/permissions';
import type { PageTab } from './page-tabs.component';

/**
 * `[GX.80]` — **Un área con pestañas: una sola entrada en el menú, sus pantallas arriba.**
 *
 * La barra de pestañas (`app-page-tabs`) y la entrada del menú lateral miran la MISMA lista de
 * pestañas. Si cada una decidiera por su lado quién ve qué, el menú podría ofrecer una entrada
 * que lleva a una pantalla que la barra no muestra (o al revés). Por eso las tres preguntas
 * viven acá y las usan los dos.
 */

/** ¿Esta persona ve la pestaña? `anyOf` gana sobre `permission`; sin ninguno, la ve cualquiera. */
export function pestanaVisible(t: PageTab, tiene: (p: Permission) => boolean): boolean {
  if (t.anyOf?.length) return t.anyOf.some(tiene);
  return !t.permission || tiene(t.permission);
}

/**
 * A dónde lleva la entrada del menú: la PRIMERA pestaña que la persona ve, en el orden de la
 * barra. `null` = no ve ninguna, y entonces la entrada no se pinta.
 */
export function primeraPestanaVisible(
  tabs: readonly PageTab[],
  tiene: (p: Permission) => boolean,
): PageTab | null {
  return tabs.find((t) => pestanaVisible(t, tiene)) ?? null;
}

/**
 * ¿La URL es una de las pantallas del área? Por SEGMENTO: `/finanzas/expediente/123` sí,
 * `/finanzas/expediente-viejo` no. Cuenta también las rutas de `alsoActiveOn`.
 */
export function urlEnPestanas(url: string, tabs: readonly PageTab[]): boolean {
  const u = String(url ?? '').split(/[?#]/)[0];
  return tabs.some((t) => [t.route, ...(t.alsoActiveOn ?? [])].some((r) => u === r || u.startsWith(r + '/')));
}
