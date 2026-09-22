/**
 * **Por qué falló, en palabras de bodega.**
 *
 * Nace de un caso real: al crear una ubicación desde el Andén la pantalla decía
 * *"No se pudo crear"* y abajo *"Error al crear la ubicación"*. Con eso nadie —ni
 * el operario, ni quien reporta, ni quien lo va a arreglar— puede saber si fue un
 * permiso, un código repetido, la sesión vencida, la red, o el servidor caído. La
 * falla se volvió imposible de diagnosticar **porque el mensaje no distinguía**.
 *
 * El manejador que había sólo trataba el `403` aparte y metía todo lo demás en
 * `e?.error?.message || 'Error'` — y justamente los casos que más importan (un
 * `500`, o una petición que ni salió) llegan **sin** `error.message`, así que
 * caían todos en la misma línea muda.
 *
 * Reglas:
 *  - **Nunca devolver "Error"**. Si no se sabe qué pasó, se dice que no se sabe
 *    y se da el número de estado, que es lo que sirve para reportarlo.
 *  - **El mensaje del servidor manda** cuando existe: lo escribió quien conoce la
 *    regla (código repetido, código muy largo, almacén inexistente).
 *  - **El estado 0 no es "error del servidor"**: es que la petición no llegó.
 *    Confundirlos manda a revisar el log equivocado.
 *
 * Vive en `shared/` y no dentro de una pantalla porque lo usan las dos superficies
 * que dan de alta ubicaciones —el Andén y Ubicaciones— y el reporte del operario
 * tiene que decir lo mismo desde las dos (ADR-056: al segundo uso, se extrae).
 */

/** Lo mínimo que se necesita de un `HttpErrorResponse`, sin atarse a Angular. */
export interface ErrorHttpLike {
  status?: number;
  error?: { message?: string | string[] } | string | null;
  message?: string;
}

/** El texto que mandó el backend, si mandó alguno utilizable. */
function mensajeDelServidor(e: ErrorHttpLike | null | undefined): string {
  const err = e?.error;
  if (!err) return '';
  if (typeof err === 'string') {
    // Un cuerpo HTML (una página de error del proxy) no es un mensaje para
    // mostrarle a nadie: se descarta en vez de escupir `<!DOCTYPE html>`.
    const t = err.trim();
    return t.startsWith('<') ? '' : t.slice(0, 300);
  }
  const m = err.message;
  if (Array.isArray(m)) return m.join(' · ').slice(0, 300);
  return (m || '').slice(0, 300);
}

/**
 * @param e      el error de la petición
 * @param accion qué se intentaba, en infinitivo y en minúsculas: "crear la
 *               ubicación", "acomodar la mercancía", "borrar la ubicación".
 *               Se usa tal cual dentro de la frase.
 */
export function motivoHttp(e: ErrorHttpLike | null | undefined, accion: string): string {
  const status = Number(e?.status ?? 0);
  const msg = mensajeDelServidor(e);

  // Sin respuesta: la petición no llegó o no volvió. NO es un error del servidor.
  if (!status) {
    return `No hubo respuesta del servidor al ${accion}. Revisá la conexión o el WiFi de la bodega y volvé a intentar.`;
  }

  switch (status) {
    case 400:
    case 422:
      // El backend explica la regla que se rompió; si no, al menos se dice que
      // el dato es el problema y no el permiso.
      return msg || `Algún dato del formulario no es válido para ${accion}.`;
    case 401:
      return 'Tu sesión venció. Volvé a entrar y repetí la operación.';
    case 403:
      return (
        `Tu usuario no tiene permiso para ${accion}. ` +
        'Pedile a un administrador el permiso de inventario que corresponde (asignar layout o recibir).'
      );
    case 404:
      return msg || `No se encontró lo necesario para ${accion} (almacén o ubicación).`;
    case 409:
      return msg || 'Ya existe algo con esos datos.';
    case 413:
      return `Lo que se envió es demasiado grande para ${accion}.`;
    case 429:
      return 'Fueron demasiados intentos seguidos. Esperá unos segundos y volvé a probar.';
    default:
      break;
  }

  if (status >= 500) {
    // Un 500 de Nest llega como "Internal server error": repetirlo tal cual no
    // informa. Lo que sirve para reportarlo es el número y lo que se intentaba.
    const detalle = msg && !/internal server error/i.test(msg) ? ` (${msg})` : '';
    return (
      `El servidor falló al ${accion} — error ${status}${detalle}. ` +
      'No es algo que puedas corregir desde acá: avisá a sistemas con este mensaje.'
    );
  }

  return msg || `No se pudo ${accion} (estado ${status}).`;
}
