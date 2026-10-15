import { type MonoTypeOperatorFunction, retry, throwError, timer } from 'rxjs';

/** Más de esto no se espera: si el servidor pide más, el bloque se declara sin medir. */
const ESPERA_MAX_S = 10;

/**
 * `[CGP-V.4]` Cuánto esperar antes de reintentar una LECTURA que cayó en el 429, o `null` si no
 * hay que reintentarla.
 *
 * El throttler de la API (`@nestjs/throttler` 6) manda `Retry-After-<tramo>` en segundos, uno por
 * tramo bloqueado (`short` 10/s, `medium` 60/10 s, `long` 200/min). Se toma el mayor. Sin
 * cabecera, un segundo por intento: el tramo `short` se vacía en uno.
 *
 * ⛔ Si el servidor pide más de 10 s (el tramo de un minuto), no se reintenta a ciegas: el bloque
 * dice que no se pudo medir y la persona decide.
 */
export function esperaDe429(e: unknown, intento: number): number | null {
  const err = e as { status?: number; headers?: { keys?(): string[]; get?(n: string): string | null } } | null;
  if (!err || err.status !== 429) return null;
  const nombres = err.headers?.keys?.() ?? [];
  const pedidos = nombres
    .filter((k) => /^retry-after/i.test(k))
    .map((k) => Number(err.headers?.get?.(k)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const seg = pedidos.length ? Math.max(...pedidos) : intento;
  return seg > ESPERA_MAX_S ? null : Math.ceil(seg) * 1000;
}

/**
 * Reintenta una LECTURA que cayó en el 429, hasta `veces` veces. Cualquier otro error pasa al
 * instante. ⛔ Sólo para GET: una escritura repetida en silencio no es decisión de esta capa.
 */
export function reintentarSi429<T>(veces = 2): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: veces,
    delay: (e, intento) => {
      const ms = esperaDe429(e, intento);
      return ms == null ? throwError(() => e) : timer(ms);
    },
  });
}
