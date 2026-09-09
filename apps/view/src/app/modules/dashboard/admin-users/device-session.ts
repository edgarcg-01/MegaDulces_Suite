import type { DeviceSessionFields } from '@megadulces/contracts';

/**
 * `[CH.1.11]` — Lo que la pantalla de usuarios necesita saber sobre una cuenta de
 * DISPOSITIVO (kiosco): checador de asistencia, etiquetera, verificador de precios.
 *
 * Funciones puras, sin Angular, para que se puedan probar sin `TestBed`. La FORMA del
 * wire vive en `@megadulces/contracts`; acá vive lo que hace la pantalla con ella.
 */

/**
 * `true` si la cuenta declara su propia duración de sesión.
 *
 * Se deriva de `token_ttl_days` y no de una columna aparte: el campo que de verdad
 * describiría el mundo sería un `shared_credential boolean`, pero agregarlo es un
 * `ALTER TABLE` sobre `identity.users` — la tabla del incidente de `[CH.1.6]`, 7
 * minutos de login encolado detrás del respaldo diario.
 */
export function isDeviceAccount(u: Pick<DeviceSessionFields, 'token_ttl_days'>): boolean {
  return u.token_ttl_days != null;
}

/**
 * Las duraciones que la pantalla ofrece. **Presets y no un campo numérico libre**: la
 * única razón para tipear un número es tipear el equivocado. Como efecto secundario, el
 * techo de 3650 días (`MAX_TOKEN_TTL_DAYS`) no es alcanzable desde la UI y no hace falta
 * duplicarlo acá — la validación del rango es del DTO y del CHECK de la base.
 */
export const SESSION_PRESETS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: 'Sesión normal (12 h)', value: null },
  { label: '30 días', value: 30 },
  { label: '180 días', value: 180 },
  { label: '1 año (365 días)', value: 365 },
];

/** Cómo se lee la duración de una cuenta en la tabla. */
export function sessionLabel(ttl?: number | null): string {
  if (ttl == null) return 'Sesión normal';
  if (ttl === 365) return 'Sesión 1 año';
  return `Sesión ${ttl} d`;
}

/**
 * Alfabeto SIN caracteres ambiguos: no hay `0`/`O`, ni `1`/`l`/`I`.
 *
 * No es cosmético. Esta contraseña se teclea una sola vez, en el kiosco, muchas veces
 * leyéndola de un papel escrito a mano — y un `O` que se lee `0` es una llamada a
 * soporte. Es el mismo criterio que traía el script de alta que esta pantalla reemplaza.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const LARGO = 14;

/**
 * Genera la contraseña de un dispositivo.
 *
 * **Del lado del cliente a propósito.** Un generador en el backend tendría que devolver
 * la contraseña en claro en una respuesta HTTP, y ahí queda en los logs del server y de
 * cualquier proxy en el camino. Acá nunca sale del navegador salvo en el mismo POST que
 * la guarda hasheada.
 *
 * Rechazo de resto en vez de `% ALFABETO.length`: el módulo sobre un byte de 256 le da
 * más probabilidad a los primeros caracteres del alfabeto. Es un sesgo chico y es
 * gratis no tenerlo.
 */
export function generateDevicePassword(): string {
  const n = ALFABETO.length;
  const techo = Math.floor(256 / n) * n; // 224 para 56: descarta 225..255
  const out: string[] = [];
  const buf = new Uint8Array(LARGO * 2);
  while (out.length < LARGO) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= techo) continue;
      out.push(ALFABETO[b % n]);
      if (out.length === LARGO) break;
    }
  }
  return out.join('');
}
