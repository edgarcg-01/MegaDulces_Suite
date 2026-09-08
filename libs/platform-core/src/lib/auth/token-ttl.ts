/**
 * `[CH.1.3]` — Cuánto vive el JWT de UNA cuenta.
 *
 * ── El problema ──────────────────────────────────────────────────────────────
 * Un kiosco (checador de asistencia, verificador de precios de mostrador) es una
 * pantalla que se prende una vez y se queda prendida. Con el TTL global de 12 h
 * (`JWT_EXPIRES_IN`, `tenant.module.ts`) alguien tiene que ir a teclear la contraseña
 * cada mañana, y el día que nadie va, la pantalla muestra el login en lugar de su
 * trabajo. Subir el TTL global no es la respuesta: le alargaría el token a TODOS,
 * incluidos los admin, que son justo donde un token largo duele más.
 *
 * La excepción se declara en la fila de la cuenta que la necesita
 * (`identity.users.token_ttl_days`), donde se puede ver, auditar y quitar con un
 * UPDATE. `NULL` = el default global.
 *
 * ── Por qué esto no es un token irrevocable ──────────────────────────────────
 * Dos mecanismos que YA existen sostienen la vida larga, y no hay que aflojarlos:
 *  · `[AUTHZ-HARD.2]` (`jwt-auth.guard`) relee `identity.users` en cada request con
 *    cache de 30 s → `activo = false` mata el token en ≤30 s, sin esperar su `exp`.
 *  · `PermissionsCacheService` relee los permisos de la DB por request → un token
 *    viejo NO conserva privilegios viejos del lado del servidor; el mapa que viaja
 *    en el JWT sólo gatea la UI.
 * De ahí que vaya UNA cuenta por dispositivo: revocar es por cuenta, y apagar un
 * kiosco comprometido no puede implicar apagar los otros ocho.
 *
 * Lo que NO cubre, dicho de frente: un token filtrado sirve hasta que alguien
 * desactiva esa cuenta. No hay revocación por token ni rotación — eso pide una tabla
 * de tokens de dispositivo o un candado `iat < password_changed_at` (la columna ya
 * existe y nadie la lee todavía).
 *
 * Vive en `libs/` a propósito (ADR-056): el primitivo lo va a querer cualquier
 * superficie de kiosco, y un helper copiado a mano en dos servicios se desincroniza.
 */

/** Techo duro, igual al CHECK de `identity.users.token_ttl_days` (1..3650 días). */
export const MAX_TOKEN_TTL_DAYS = 3650;

/**
 * Opciones de firma para la cuenta, listas para `jwtService.signAsync(payload, opts)`.
 *
 * - `{}` → **el default global manda**. Es a propósito un objeto vacío y no
 *   `{ expiresIn: undefined }`: Nest mergea `{ ...moduleSignOptions, ...options }`, así
 *   que pasar la clave en `undefined` la BORRARÍA del merge y emitiría un token **sin
 *   expiración para todo el mundo** — el modo de falla exacto que esta función existe
 *   para evitar.
 * - `{ expiresIn: <segundos> }` → la vida declarada por la cuenta. En segundos porque
 *   un número es inequívoco: `expiresIn` como string exige un literal de tipo `ms`
 *   (`${number}d`) y depende de su parser.
 *
 * Un valor inválido (0, negativo, texto, NaN) **cae al default global**, nunca a un
 * token sin expiración ni a uno ya expirado. La DB además lo impide con un CHECK; esto
 * es la segunda llave, para el día que un INSERT entre por otro camino.
 */
export function tokenSignOptions(tokenTtlDays: unknown): { expiresIn?: number } {
  const dias = Number(tokenTtlDays);
  if (!Number.isFinite(dias) || dias < 1) return {};
  const acotado = Math.min(Math.trunc(dias), MAX_TOKEN_TTL_DAYS);
  return { expiresIn: acotado * 24 * 60 * 60 };
}
