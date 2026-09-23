/**
 * Lo que pasa en una ventana llega a las otras.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * Medido en 'apps/view' el 2026-09-22: **cero** listeners de 'storage' en las 534
 * clases. O sea que hoy la Suite abierta en dos ventanas son dos apps que no se
 * hablan: cerrás sesión en una y la otra sigue pintando una pantalla viva con un
 * token muerto hasta que su próxima petición dé 401. Con multitarea de verdad eso
 * deja de ser una rareza y pasa a ser lo normal (ADR-078).
 *
 * ── Cómo funciona, que es lo que se olvida ────────────────────────────────────
 * El evento 'storage' dispara **sólo en los OTROS documentos** del mismo origen,
 * nunca en el que escribió. Eso es justo lo que se quiere (el que escribe ya se
 * enteró) pero hace que la primera prueba que uno escribe no funcione: escribís y
 * esperás tu propio evento, que no llega.
 *
 * Tampoco dispara si el valor no CAMBIÓ. Escribir dos veces lo mismo avisa una
 * sola vez, así que nada de usarlo como campana ("el valor es siempre 'ping'").
 */

/** Deja de escuchar. */
export type DejarDeEscuchar = () => void;

/**
 * Avisa cuando OTRA ventana escribe esta clave.
 *
 * El callback recibe el valor nuevo, o 'null' si la clave se borró (que es lo que
 * pasa con el token al cerrar sesión: 'removeItem' también dispara 'storage').
 */
export function alCambiarEnOtraVentana(
  clave: string,
  cb: (valor: string | null) => void,
): DejarDeEscuchar {
  if (typeof window === 'undefined') return () => undefined;
  const oyente = (e: StorageEvent) => {
    // 'e.key' viene null cuando alguien hizo 'localStorage.clear()'. Ahí no se
    // puede saber qué cambió, así que se avisa como borrado.
    if (e.key !== null && e.key !== clave) return;
    if (e.storageArea && e.storageArea !== localStorage) return;
    cb(e.key === null ? null : e.newValue);
  };
  window.addEventListener('storage', oyente);
  return () => window.removeEventListener('storage', oyente);
}

/**
 * Escribe una preferencia. Las otras ventanas se enteran por 'storage'.
 *
 * Envuelto en try/catch porque en modo privado o con el almacenamiento bloqueado
 * 'setItem' TIRA, y una preferencia que no se pudo guardar no puede tumbar la
 * pantalla: se pierde al recargar y ya.
 */
export function guardarPreferencia(clave: string, valor: string): void {
  try {
    localStorage.setItem(clave, valor);
  } catch {
    /* sin persistencia; la preferencia vive lo que viva esta ventana */
  }
}

/** Lee una preferencia. Devuelve null si no está o si no se puede leer. */
export function leerPreferencia(clave: string): string | null {
  try {
    return localStorage.getItem(clave);
  } catch {
    return null;
  }
}
