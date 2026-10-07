/**
 * `[MS.2.6]` Qué dice cada aviso. Función pura.
 *
 * El texto vive acá —y no repartido en los servicios— por dos razones: es lo único que el solicitante lee
 * de la mesa fuera de la pantalla (un correo, un WhatsApp), y tiene que poder probarse sin base de datos.
 *
 * Reglas del texto: sin jerga («resuelto», no «transición a estado 5»), con el folio siempre al frente
 * para poder buscarlo, y SIN el cuerpo de las notas internas: un aviso sale a un canal que no controlamos.
 */
import type { SdPriority } from '@megadulces/contracts';

export type SdEventoClave =
  | 'nuevo_prioritario'
  | 'levantada'
  | 'asignado'
  | 'comentario'
  | 'resuelto'
  | 'reabierto'
  | 'cancelado'
  | 'autocerrado'
  | 'sla_por_vencer'
  | 'sla_primera_respuesta_vencida'
  | 'sla_vencido';

export type SdSeveridad = 'info' | 'warn' | 'critical';

export interface EntradaAviso {
  event: SdEventoClave;
  folio: string;
  title: string;
  priority: SdPriority;
  /** Quien provocó el aviso (para «Ana te asignó…»). Vacío si lo hizo el sistema. */
  actor?: string | null;
  /** Sólo `comentario`: lo que escribió. Se recorta; nunca viaja una nota interna. */
  extracto?: string | null;
  /** Sólo `autocerrado`: a los cuántos días. */
  dias?: number | null;
  automatico?: boolean;
}

export interface Aviso {
  title: string;
  message: string;
  severity: SdSeveridad;
}

const PRIORIDAD: Record<SdPriority, string> = { baja: 'baja', media: 'media', alta: 'alta', urgente: 'URGENTE' };

function recortar(s: string | null | undefined, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function armarAviso(e: EntradaAviso): Aviso {
  const ref = `${e.folio} · ${recortar(e.title, 80)}`;
  const quien = e.actor ? recortar(e.actor, 40) : null;
  switch (e.event) {
    case 'nuevo_prioritario':
      return {
        title: `Solicitud ${PRIORIDAD[e.priority]} sin atender`,
        message: `${ref}${quien ? ` — la reportó ${quien}` : ''}.`,
        severity: e.priority === 'urgente' ? 'critical' : 'warn',
      };
    case 'levantada':
      // `[MS.3.11]` A quien NO la reportó se le avisa: de otro modo le llegarían los «resuelto» de algo que no sabía que existía.
      return { title: 'Se levantó una solicitud a tu nombre', message: `${ref}${quien ? ` — la levantó ${quien}` : ''}.`, severity: 'info' };
    case 'asignado':
      return {
        title: 'Te asignaron una solicitud',
        message: `${ref}${e.automatico ? ' — se te asignó automáticamente' : quien ? ` — la asignó ${quien}` : ''}.`,
        severity: e.priority === 'urgente' ? 'critical' : 'info',
      };
    case 'comentario':
      return { title: 'Nuevo mensaje en una solicitud', message: `${ref}${quien ? ` — ${quien}` : ''}: «${recortar(e.extracto, 140)}»`, severity: 'info' };
    case 'resuelto':
      return { title: 'Tu solicitud quedó resuelta', message: `${ref}. Confírmala si ya funciona, o reábrela si el problema sigue.`, severity: 'info' };
    case 'reabierto':
      return { title: 'Reabrieron una solicitud', message: `${ref}${quien ? ` — la reabrió ${quien}` : ''}.`, severity: 'warn' };
    case 'cancelado':
      return { title: 'Se canceló una solicitud', message: `${ref}${quien ? ` — la canceló ${quien}` : ''}.`, severity: 'info' };
    case 'autocerrado':
      return {
        title: 'Cerramos tu solicitud',
        message: `${ref}. Estaba resuelta${e.dias ? ` desde hace ${e.dias} días` : ''} y nadie la objetó. Si el problema sigue, repórtalo de nuevo.`,
        severity: 'info',
      };
    case 'sla_por_vencer':
      return { title: 'Una solicitud está por vencer', message: `${ref} — prioridad ${PRIORIDAD[e.priority]}, ya consumió casi todo su plazo.`, severity: 'warn' };
    case 'sla_primera_respuesta_vencida':
      return { title: 'Solicitud sin primera respuesta', message: `${ref} — prioridad ${PRIORIDAD[e.priority]}, venció el plazo de primera respuesta.`, severity: 'critical' };
    case 'sla_vencido':
      return { title: 'Solicitud fuera de plazo', message: `${ref} — prioridad ${PRIORIDAD[e.priority]}, venció el plazo de resolución.`, severity: 'critical' };
  }
}

/**
 * La llave que impide mandar dos veces lo mismo A LA MISMA PERSONA. Vence con el ticket, no con el día.
 *
 * ⛔ El DESTINATARIO es parte de la llave, y por eso es un parámetro obligatorio y no un detalle del llamador:
 * el índice único de `notification_log` es `(tenant, dedup_key, channel)` y no menciona al destinatario.
 * Sin él en la llave, el primer destinatario de un evento «gana» y los demás se toman por ya avisados — fue
 * exactamente el bug que el E2E destapó (un aviso a TODOS los agentes sólo le llegaba a uno).
 */
export function llaveDeAviso(event: SdEventoClave, requestId: string, destinatarioId: string, discriminador?: string | number | null): string {
  const base = `${event}:${requestId}:${destinatarioId}`;
  return discriminador !== undefined && discriminador !== null && discriminador !== '' ? `${base}:${discriminador}` : base;
}
