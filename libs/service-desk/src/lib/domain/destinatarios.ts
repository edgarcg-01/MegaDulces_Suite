/**
 * `[MS.7.13]` ¿Quién PUEDE recibir un aviso de un ticket? Función pura.
 *
 * Quien arma un evento ya calcula sus destinatarios por cola (MS.7.6: `agents.listIn(cola)`, el barrido del SLA por cola). Esto es la
 * segunda llave, en el punto único de ENTREGA: aunque un cálculo futuro se equivoque, un aviso de un ticket de Mantenimiento no sale
 * hacia alguien que no es de Mantenimiento. «Nadie fuera de la cola recibe el aviso.»
 *
 * Puede recibirlo, y sólo:
 *  · **quien reportó** el ticket (los avisos de resuelto/comentario/cancelado son para esa persona, sea de la cola o no);
 *  · **quien lo tiene asignado** (aunque entre por god-mode sin ser miembro: es suyo, y perder el aviso de su comentario sería peor);
 *  · **un miembro ACTIVO de la cola del ticket** (el aviso a quien atiende el área).
 *
 * Lo demás se DESCARTA (y se devuelve aparte, para dejar rastro: un descarte es un cálculo de destinatarios que falló).
 */
export interface TicketParaAvisos {
  requesterId: string;
  assignedTo: string | null;
  /** Los miembros ACTIVOS de la cola a la que pertenece el ticket AHORA (tras un traslado, la destino). */
  miembrosDeLaCola: ReadonlySet<string>;
}

/**
 * `[MSH.2]` H9 — la Bitácora de Sistemas NO se entera de un ticket confidencial. El puerto hoy no hace nada, pero la unificación está preparada y
 * su día llegaría con el contenido adentro: el filtro se pone ANTES, para que cuando el puerto haga algo no haya que acordarse.
 */
export function sinConfidenciales<T extends { requestId: string }>(eventos: readonly T[], confidenciales: ReadonlySet<string>): T[] {
  return eventos.filter((e) => !confidenciales.has(e.requestId));
}

/**
 * `[MSH.2]` H3 — un aviso de un ticket CONFIDENCIAL sale NEUTRO: el título del ticket y el texto de un comentario viajan a la campana, al
 * correo y al WhatsApp (canales que la Mesa no controla) y se copian a `notification_log.payload`. Por eso se neutraliza **al escribir**, no al
 * mostrar: lo que no se escribió no se puede filtrar después.
 */
export const TITULO_CONFIDENCIAL = 'Solicitud confidencial';

export function contenidoDeAviso(
  confidencial: boolean,
  t: { title: string; extracto?: string | null },
): { title: string; extracto: string | null } {
  return confidencial ? { title: TITULO_CONFIDENCIAL, extracto: null } : { title: t.title, extracto: t.extracto ?? null };
}

/** `[MSH.2]` H4 — vida (segundos) de la URL prefirmada de un adjunto: 10 min de siempre; 60 s en un ticket confidencial. Una URL reenviada vale eso, no más. */
export const VIDA_URL_NORMAL_S = 600;
export const VIDA_URL_CONFIDENCIAL_S = 60;
export const vidaDeUrlAdjunto = (confidencial: boolean): number => (confidencial ? VIDA_URL_CONFIDENCIAL_S : VIDA_URL_NORMAL_S);

export function filtrarDestinatarios(ids: readonly string[], t: TicketParaAvisos): { permitidos: string[]; descartados: string[] } {
  const permitidos: string[] = [];
  const descartados: string[] = [];
  for (const id of ids) {
    if (id === t.requesterId || (t.assignedTo !== null && id === t.assignedTo) || t.miembrosDeLaCola.has(id)) permitidos.push(id);
    else descartados.push(id);
  }
  return { permitidos, descartados };
}
