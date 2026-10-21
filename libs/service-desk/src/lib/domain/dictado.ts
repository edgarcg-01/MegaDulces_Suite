/**
 * `[MS.DICTADO]` ¿Se puede dictar la descripción de una solicitud en esta área?
 *
 * La transcripción la hace un proveedor externo (Groq Whisper): el audio SALE de la empresa. Por eso no se
 * ofrece en un área confidencial (RH): lo que se cuenta ahí —una queja, un acoso, un dato de salud— no debe
 * viajar a un tercero sin que legal lo haya aprobado como encargado del tratamiento (ver
 * `FASE_MSH_PRIVACIDAD_Y_RETENCION`). La pantalla esconde el micrófono; **esta regla es la que manda**, porque
 * la pantalla es un cliente entre varios.
 *
 * Fail-closed: sin área, o con un área que no existe, no se transcribe.
 */
export type DecisionDictado = { ok: true } | { ok: false; status: 400 | 403 | 404; mensaje: string };

export function decidirDictado(queueId: string | undefined, cola: { confidential: boolean } | null | undefined): DecisionDictado {
  if (!queueId || typeof queueId !== 'string') return { ok: false, status: 400, mensaje: 'Indica en qué área levantas la solicitud para poder dictar.' };
  if (!cola) return { ok: false, status: 404, mensaje: 'El área no existe.' };
  if (cola.confidential) {
    return { ok: false, status: 403, mensaje: 'En un área confidencial no se dicta: el audio lo procesa un servicio externo. Escribe tu mensaje.' };
  }
  return { ok: true };
}
