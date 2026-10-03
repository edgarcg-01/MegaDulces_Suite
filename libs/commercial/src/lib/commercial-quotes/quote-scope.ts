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
