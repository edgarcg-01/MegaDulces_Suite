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

export function filtrarDestinatarios(ids: readonly string[], t: TicketParaAvisos): { permitidos: string[]; descartados: string[] } {
  const permitidos: string[] = [];
  const descartados: string[] = [];
  for (const id of ids) {
    if (id === t.requesterId || (t.assignedTo !== null && id === t.assignedTo) || t.miembrosDeLaCola.has(id)) permitidos.push(id);
    else descartados.push(id);
  }
  return { permitidos, descartados };
}
