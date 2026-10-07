// [CH.1.10] Identidad en el wire — el vocabulario de una cuenta, compartido por backend y
// frontend (ADR-052 / ADR-056).
//
// ── POR QUÉ VIVE ACÁ Y NO EN UN DOMINIO ──────────────────────────────────────────────────
// Mismo patrón que cortó `provenance.contract.ts`: un primitivo correcto, inventado en una
// rebanada, que nunca sube a un lugar compartido y se re-declara en cada consumidor hasta que
// las copias se separan en silencio.
//
// Acá el caso está medido. `token_ttl_days` nació el 2026-09-08 (`[CH.1.1]`) y a los pocos días
// existía en 9 archivos: el primitivo (`libs/platform-core/.../token-ttl.ts`), la firma del
// login, la migración, un script de alta, el smoke y tres documentos. En **cero** de la capa que
// administra usuarios y **cero** de la pantalla. El hueco no era parcial: la columna existía y la
// aplicación no sabía nombrarla.
//
// Lo que vive acá es sólo la FORMA del wire. La LÓGICA se queda donde estaba y no se duplica:
//  · cuánto vive el token → `tokenSignOptions()` en `libs/platform-core/.../token-ttl.ts`,
//    junto con `MAX_TOKEN_TTL_DAYS`. **No se re-declara el techo acá**: ya hay tres copias del
//    3650 (el CHECK de la DB, el helper y el DTO que lo importa) y una cuarta sería la que
//    divergiría, porque nada las compara.
//  · quién puede emitir una sesión larga → la compuerta del `UsersService`.
//
// Sin zod, a diferencia de sus vecinos, y a propósito: nada parsea esta forma en un boundary.
// `USER_KINDS` lo consume `@IsIn(...)` de class-validator en el DTO del backend, y el frontend
// importa `UserKind` como tipo. Es exactamente lo que el barrel declara aceptar: tipos y
// constantes string.

/**
 * Los tipos de cuenta que la base admite. **Espejo exacto** del CHECK
 * `users_kind_valido` (`database/migrations-newdb/20260828120000_identity_user_roles.js:40`).
 * Si acá falta uno, el DTO rechaza un valor que la DB acepta; si acá sobra uno, el INSERT
 * revienta con un 23514 en vez de un 400 legible.
 *
 *  · `interno`   — empleado. **También las cuentas de kiosco**: `servicio` bloquea el login
 *                  interactivo (`[ID.17]`, `auth-mt.service.ts:175`) y a un checador o una
 *                  etiquetera alguien le teclea la contraseña en el piso, una vez.
 *  · `cliente`   — portal B2B.
 *  · `proveedor` — portal de proveedor.
 *  · `externo`   — contador / auditor externo (suele venir con `expires_at`).
 *  · `servicio`  — feed, cron, bot. Sin acceso interactivo.
 */
export const USER_KINDS = [
  'interno',
  'cliente',
  'proveedor',
  'externo',
  'servicio',
] as const;

export type UserKind = (typeof USER_KINDS)[number];

/**
 * Lo que hace que una credencial sea de DISPOSITIVO y no de persona.
 *
 * Una pantalla de kiosco (checador de asistencia, etiquetera, verificador de precios de
 * mostrador) se prende una vez y se queda prendida. Con el TTL global de 12 h alguien tiene que
 * ir a teclear la contraseña cada mañana, y el día que nadie va, la pantalla muestra el login en
 * lugar de su trabajo.
 *
 * ── Lo que un consumidor de este contrato NO debe deducir mal ────────────────────────────────
 * Bajar `token_ttl_days` **no corta un acceso ya emitido**: sólo aplica al próximo ingreso. Lo
 * que revoca en ≤30 s es `activo = false` — `[AUTHZ-HARD.2]` relee `identity.users` en cada
 * request. Ésa es la única razón por la que un token de un año es defendible, y es también por
 * qué va **una cuenta por dispositivo**: revocar es por cuenta, y apagar un kiosco comprometido
 * no puede implicar apagar los otros ocho.
 */
export interface DeviceSessionFields {
  /**
   * Vida del JWT de esta cuenta, en días. `null` = el default global (`JWT_EXPIRES_IN`, hoy 12 h).
   * Rango válido 1..`MAX_TOKEN_TTL_DAYS`; el CHECK `users_token_ttl_days_rango` lo sostiene del
   * lado de la base.
   */
  token_ttl_days?: number | null;
  /** Tipo de cuenta. Ver `USER_KINDS`. */
  kind?: UserKind | null;
}

// ── Por qué acá no hay un `isDeviceAccount()` ────────────────────────────────────────────────
// "Es un dispositivo" se deriva de `token_ttl_days != null`, y esa derivación la necesitan dos
// lados con propósitos distintos: el frontend para pintar y filtrar, el backend para decidir si
// la combinación que llega es admisible. Poner la función acá y además un helper en cada lado
// sería la duplicación que este paquete existe para evitar — así que este archivo se queda con
// la FORMA y cada lado define su verbo una sola vez: `device-session.ts` en la pantalla,
// `assertDeviceCredential()` en el servicio.
//
// El campo que de verdad describiría el mundo sería un `shared_credential boolean`, y sería
// mejor para auditar. Agregarlo es un `ALTER TABLE` sobre `identity.users` — la tabla del
// incidente de `[CH.1.6]`, 7 minutos de login encolado detrás del respaldo diario. No se paga
// una ventana de DDL en prod por un campo que `token_ttl_days` ya deja inferir. Queda anotado
// como el estado final deseable, no como deuda silenciosa.
