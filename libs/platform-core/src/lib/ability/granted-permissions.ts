/**
 * `[ID.29]` — Al token sólo viajan las claves CONCEDIDAS.
 *
 * ── El problema, medido en prod (2026-09-09) ─────────────────────────────────
 * `/admin/roles` guarda el JSONB **completo**: el front itera todo el enum y
 * escribe las 175 claves, la mayoría en `false`. Ese mapa viaja en el JWT, o
 * sea en el header `Authorization` de **cada request**. Resultado por rol:
 *
 *   almacenista         170 claves →   2 concedidas →  7,746 B  →   618 B (12.5×)
 *   etiquetas_anaquel   161 claves →   1 concedida  →  7,334 B  →   558 B (13.1×)
 *   promotor_ruta       169 claves →  21 concedidas →  7,675 B  → 1,324 B ( 5.8×)
 *
 * ── Los `false` no cargan información en NINGÚN nivel ────────────────────────
 * Verificado los tres consumidores antes de escribir esto:
 *   · el guard del front compara `mapa[clave] === true` → una clave ausente se
 *     comporta EXACTAMENTE igual que una en `false`;
 *   · `PermissionsService.has()` compara `=== true`, idem;
 *   · `RolesGuard` del backend **ni siquiera mira el mapa del token**: relee de
 *     DB en cada request y sobreescribe `request.user.permissions`.
 * Y quitar de verdad no se hace con un `false` en el rol: se hace en
 * `identity.user_permissions` con `allow = false`, que es otra tabla y otro
 * camino. Un grep de `=== false` sobre permisos en los 3 frontends y en los
 * guards del backend no devuelve un solo consumidor.
 *
 * ── Por qué acá y no copiado en los dos logins ───────────────────────────────
 * Hay DOS caminos de login (`/auth/login` legacy y `/auth-mt/login`) y los dos
 * arman el payload. Un helper copiado a mano en dos servicios se desincroniza
 * (ADR-056: un primitivo no cierra la fase hasta vivir en `libs/`).
 *
 * ⚠️ Lo que esto NO hace: sacar el permiso del token. Eso es la segunda mitad
 * de la etapa y exige que el front resuelva el mapa contra
 * `GET /users/me/access` **antes** de la primera navegación — hoy los tres
 * guards de ruta leen `authService.user()?.permissions`, o sea el mapa
 * decodificado del JWT, y quitarlo sin eso rebota a todo no-admin a
 * `/sin-acceso`. Esto es el paso que se puede dar solo, sin ventana de riesgo.
 */

/**
 * Devuelve sólo las claves con valor `true`.
 *
 * Tolera `null`/`undefined` devolviendo `{}` — el llamador de un login nunca
 * debería recibir un mapa nulo, pero fallar el login por eso sería peor que
 * emitir un token sin permisos que el backend igual va a resolver contra DB.
 */
export function soloConcedidos(
  mapa: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  if (!mapa) return {};
  const out: Record<string, boolean> = {};
  for (const [clave, valor] of Object.entries(mapa)) {
    if (valor === true) out[clave] = true;
  }
  return out;
}
