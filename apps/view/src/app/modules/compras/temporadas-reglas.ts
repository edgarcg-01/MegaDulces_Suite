import type { FechasTemporada } from '@megadulces/contracts';

/**
 * `[PQ.94]` Reglas puras de la pantalla Compras › Temporadas (sin Angular, para probarlas solas).
 */

/**
 * La temporada-año que importa HOY: la que está en venta; si no, la próxima por iniciar (la más cercana);
 * si no, la más reciente.
 */
export function fechaRelevante(fechas: readonly FechasTemporada[]): FechasTemporada | null {
  const enVenta = fechas.find((f) => f.momento === 'en_venta');
  if (enVenta) return enVenta;
  const proxima = fechas.filter((f) => f.momento === 'por_iniciar').sort((a, b) => a.sale_from.localeCompare(b.sale_from))[0];
  if (proxima) return proxima;
  return [...fechas].sort((a, b) => b.year - a.year || b.sale_from.localeCompare(a.sale_from))[0] ?? null;
}

/**
 * Por qué falló, en español y sin jerga de Nest. Mapeo LOCAL a propósito: `motivoHttp` (almacén/shared)
 * habla de la bodega, del permiso de inventario y del WiFi, y en esta pantalla esos textos mentirían.
 * El mensaje del servidor manda cuando existe y está en español; los genéricos de Nest en inglés
 * («Internal server error», «Forbidden resource», «Validation failed (uuid is expected)») no se muestran.
 */
export function motivoTemporadas(e: unknown, accion: string): string {
  const err = e as { status?: number; error?: { message?: string | string[] } | string | null } | null | undefined;
  const status = Number(err?.status ?? 0);
  const cuerpo = err?.error;
  const crudo = typeof cuerpo === 'string'
    ? (cuerpo.trim().startsWith('<') ? '' : cuerpo)
    : Array.isArray(cuerpo?.message) ? cuerpo.message.join(' · ') : (cuerpo?.message ?? '');
  const msg = String(crudo).trim().slice(0, 300);
  const enIngles = /^(internal server error|forbidden|unauthorized|not found|bad request|validation failed|cannot (get|post|put|patch|delete))/i.test(msg);
  const delServidor = msg && !enIngles ? msg : '';

  if (!status) return `No hubo respuesta del servidor al ${accion}: revisa tu conexión y vuelve a intentarlo.`;
  if (status === 400 && /uuid is expected/i.test(msg)) return 'El enlace de esta temporada no es válido: ábrela desde el calendario.';
  switch (status) {
    case 400:
    case 422:
      return delServidor || `Algún dato no es válido para ${accion}.`;
    case 401:
      return 'Tu sesión venció: vuelve a entrar.';
    case 403:
      return 'No tienes permiso para esto.';
    case 404:
      return 'No encontramos esa temporada.';
    case 503:
      return delServidor || `El servicio no está disponible para ${accion}: vuelve a intentarlo en un momento.`;
    default:
      return `No se pudo completar: vuelve a intentarlo (error ${status}).`;
  }
}
