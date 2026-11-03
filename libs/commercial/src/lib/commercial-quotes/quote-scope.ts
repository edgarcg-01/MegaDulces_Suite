// ⚠️ Sólo el TIPO: este archivo lo carga el motor de precios, y el replay
// (`scripts/kepler/replay-cotizacion/replay.js`) lo empaqueta con `platform-core` reemplazado por
// un stub. Un import de valor lo tumbaba al cargar (COT.7.0d, 2026-11-03).
import type { Permission } from '@megadulces/platform-core';

/**
 * `[COT.19]` — Con qué sucursales puede trabajar quien cotiza.
 *
 * Hasta acá el cotizador abría las 8 sucursales a cualquiera y arrancaba en la 01: un vendedor de
 * Morelia Abastos (su perfil dice `08`) cotizaba con precios de Padre Hidalgo sin enterarse, y el
 * servidor lo aceptaba porque ningún endpoint del módulo preguntaba (medido en prod 2026-10-03).
 *
 * El alcance NO se inventa acá: es el de ADR-050 (`identity.role_scopes` / `user_scopes`, dimensión
 * `warehouse`), el mismo que ya usan ~15 módulos.
 *   - vendedor / telemarketing → `own`: sólo la sucursal de su perfil (`users.warehouse_code`).
 *   - gerente o persona con varias → `listed`: las de su lista.
 *   - dirección / administración → `all`. `superadmin` siempre `all`.
 *   - `own` sin sucursal en el perfil → ninguna (fail-closed): se DECLARA en pantalla, no se abre todo.
 *
 * El área es el id del proyecto en `AUTHZ_TREE` (`televenta`), no el prefijo de la ruta (ZN.8).
 */
export const AREA_COTIZACIONES = 'televenta';

/**
 * `[COT.21]` — De quién son las cotizaciones que ve cada quien.
 *
 * La sucursal (COT.19) no alcanzaba: las cuatro telemarketistas de Padre Hidalgo veían y podían
 * cancelar las cotizaciones de las otras tres (medido en prod 2026-11-03). Regla de Edgar: cada
 * quien ve **sólo las suyas**; Dirección General ve todas. El alcance por sucursal sigue
 * aplicando encima: quien ve todas, ve todas *de sus sucursales*.
 *
 * Se decide por LLAVE (`COMMERCIAL_QUOTES_VER_ALL`, ADR-054), no por el modo de alcance: el modo
 * `all` lo tiene también `claudia_mata` (supervisor que cotiza) por una regla `'*'` puesta para
 * otros módulos, y habría seguido viendo las de todos. Los roles de plataforma pasan, como en
 * `RolesGuard`.
 */
export interface QuienCotiza {
  /** El mapa y los roles FRESCOS que `RolesGuard` deja en `request.user`. */
  permissions?: Record<string, boolean> | null;
  roles_frescos?: string[] | null;
  role_name?: string | null;
}

export const PERMISO_VER_TODAS_COTIZACIONES = 'COMMERCIAL_QUOTES_VER_ALL' satisfies `${Permission}`;

/**
 * `null` = ve las de todos; un id = sólo las que hizo ese usuario. Sin datos de quién pide, o
 * sin usuario, devuelve `''` (no casa con ninguna): fail-closed, nunca «todas» por omisión.
 */
export function autorVisible(
  quien: QuienCotiza | null | undefined,
  userId: string | null | undefined,
  esAdminDePlataforma: (rol?: string | null) => boolean,
): string | null {
  const roles = quien?.roles_frescos?.length ? quien.roles_frescos : [quien?.role_name ?? null];
  if (roles.some((r) => esAdminDePlataforma(r))) return null;
  // `=== true`: una clave en `false` (como quedan las nuevas al guardar el mapa desde
  // /admin/roles) no abre nada.
  if (quien?.permissions?.[PERMISO_VER_TODAS_COTIZACIONES] === true) return null;
  return userId ?? '';
}

export const MENSAJE_COTIZACION_AJENA =
  'Esta cotización la hizo otra persona. Cada quien ve y trabaja sólo las suyas; '
  + 'las de todos las ve Dirección.';
