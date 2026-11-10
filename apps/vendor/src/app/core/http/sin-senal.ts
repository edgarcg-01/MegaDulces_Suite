/**
 * `[VTK.16]` ¿La petición NO LLEGÓ al servidor (sin señal), en vez de que el servidor la rechazara?
 *
 * Medido el 2026-11-09 (David, en el navegador del celular, quitando la señal con el pedido abierto): la
 * app decía «El servidor no lo aceptó. Intenta de nuevo o avisa a oficina.». No era el servidor: en el
 * navegador, el service worker de Angular contesta una petición que no pudo salir con un **504 «Gateway
 * Timeout» sin cuerpo** (`safeFetch` de `ngsw-worker.js`), y las pantallas sólo reconocían el `status 0`.
 *
 * Se considera «sin señal»:
 *  · el teléfono dice que no tiene red (`navigator.onLine === false`);
 *  · `status 0` (el navegador no pudo hacer la petición; así llega en la app instalada);
 *  · `504` sin mensaje del servidor (el del service worker, o un proxy que no alcanzó al servidor).
 * Un 504 CON mensaje de Nest sí viene del servidor y se muestra tal cual.
 */
export function esSinSenal(err: unknown, enLinea: boolean = typeof navigator === 'undefined' || navigator.onLine !== false): boolean {
  if (!enLinea) return true;
  const e = err as { status?: number; error?: unknown } | null;
  if (e?.status === 0) return true;
  if (e?.status === 504) {
    const m = (e.error as { message?: unknown } | null | undefined)?.message;
    const conMensaje = (typeof m === 'string' && !!m.trim()) || (Array.isArray(m) && m.length > 0);
    return !conMensaje;
  }
  return false;
}

/** Lo que se le dice al vendedor: qué pasó y qué hacer, sin culpar al servidor ni mandarlo a oficina. */
export const TEXTO_SIN_SENAL = 'Sin señal: no se guardó. Inténtalo cuando vuelva la señal.';
