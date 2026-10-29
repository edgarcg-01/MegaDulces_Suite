/**
 * `[MS.AVISO]` Qué avisos de la Mesa de Servicio se anuncian con una ventana emergente, y a dónde llevan.
 *
 * Función pura, sin Angular: el toast y el aviso del escritorio comparten esta decisión, y así se prueba sin montar nada.
 *
 * Sólo se anuncia lo que alguien tiene que ATENDER y todavía no atendió: una solicitud nueva (`nueva_solicitud`) o una
 * prioritaria (`nuevo_prioritario`). El resto de los avisos de la mesa (comentarios, asignaciones, resueltos…) sigue
 * llegando a la campana como hasta hoy: una ventana por cada comentario sería ruido, y el ruido se ignora.
 */

export const EVENTOS_QUE_SE_ANUNCIAN = ['nueva_solicitud', 'nuevo_prioritario'] as const;

export interface AvisoAnunciable {
  title: string;
  message: string;
  /** Una prioritaria no se cierra sola: quien atiende tiene que verla. */
  urgente: boolean;
  /** `/servicio/bandeja?id=…` para ver el detalle sin buscarla. */
  route: string;
}

interface AlertaDeLaMesa {
  type: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  data?: { event?: unknown; request_id?: unknown } | null;
}

/** `null` si la alerta no es una de las que se anuncian (otro tipo, o un aviso de la mesa que sólo va a la campana). */
export function avisoAnunciable(a: AlertaDeLaMesa): AvisoAnunciable | null {
  if (a.type !== 'service_desk') return null;
  const evento = String(a.data?.event ?? '');
  if (!(EVENTOS_QUE_SE_ANUNCIAN as readonly string[]).includes(evento)) return null;
  const id = typeof a.data?.request_id === 'string' && a.data.request_id ? a.data.request_id : null;
  return {
    title: a.title,
    message: a.message,
    urgente: evento === 'nuevo_prioritario' && a.severity === 'critical',
    route: id ? `/servicio/bandeja?id=${encodeURIComponent(id)}` : '/servicio/bandeja',
  };
}
