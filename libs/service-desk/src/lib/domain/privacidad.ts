/**
 * `[PRV.2]` El consentimiento del aviso de privacidad: ¿se puede crear este ticket? Función pura.
 *
 * Una cola puede exigir un aviso de privacidad (`queues.privacy_notice_code`); hoy sólo RH. Antes de crear un ticket en una cola así hay que
 * haber ACEPTADO la versión VIGENTE del aviso: lo pide el servidor, no sólo la pantalla (quien llame a la API sin el formulario también
 * está sujeto). Las reglas, todas con su negativa en el spec:
 *
 *  · **Fail-closed:** si la cola exige aviso y NO hay una versión vigente publicada, no se crea nada (sería un consentimiento a un texto que
 *    no existe). Un descuido de configuración bloquea la cola, no la deja abierta sin aviso.
 *  · **El consentimiento es de QUIEN ES TITULAR de los datos.** Cuando alguien que atiende levanta el ticket A NOMBRE de otra persona, su
 *    casilla NO consiente por ella: la persona debe haber aceptado ya esa versión (o el ticket no se puede crear a su nombre).
 *  · Quien ya aceptó la versión vigente no la vuelve a aceptar en cada ticket; si el aviso cambia de versión, vuelve a aceptar.
 *  · Aceptar una versión VIEJA (la pantalla estaba abierta cuando se publicó otra) no vale: se pide leer la nueva.
 */
export interface AvisoVigente {
  id: string;
  version: number;
}

export interface EntradaConsentimiento {
  /** La cola del ticket tiene `privacy_notice_code`. */
  colaExigeAviso: boolean;
  /** La versión vigente del aviso de esa cola (`null` = no hay ninguna publicada). */
  avisoVigente: AvisoVigente | null;
  /** El `privacy_notice_id` que mandó el cliente al marcar la casilla (si lo marcó). */
  idAceptado: string | null | undefined;
  /** La persona TITULAR (quien será el solicitante) ya aceptó la versión vigente. */
  yaAcepto: boolean;
  /** El ticket se levanta a nombre de otra persona. */
  aNombreDeOtro: boolean;
}

export type CodigoRechazo = 'sin_aviso_publicado' | 'falta_aceptar' | 'aviso_desactualizado' | 'requiere_aceptacion_previa';

export type DecisionConsentimiento = { ok: true; registrar: boolean } | { ok: false; codigo: CodigoRechazo; status: 400 | 409; mensaje: string };

export const MENSAJES_PRIVACIDAD: Readonly<Record<CodigoRechazo, string>> = {
  sin_aviso_publicado: 'El aviso de privacidad de esta área aún no está publicado: por ahora no se pueden levantar solicitudes en ella',
  falta_aceptar: 'Para levantar una solicitud en esta área debes leer y aceptar el aviso de privacidad',
  aviso_desactualizado: 'El aviso de privacidad cambió mientras llenabas la solicitud: léelo de nuevo y acéptalo',
  requiere_aceptacion_previa: 'Esta persona aún no ha aceptado el aviso de privacidad de esta área: debe aceptarlo ella misma antes de que se levante una solicitud a su nombre',
};

const no = (codigo: CodigoRechazo, status: 400 | 409): DecisionConsentimiento => ({ ok: false, codigo, status, mensaje: MENSAJES_PRIVACIDAD[codigo] });

export function decidirConsentimiento(e: EntradaConsentimiento): DecisionConsentimiento {
  if (!e.colaExigeAviso) return { ok: true, registrar: false };
  if (!e.avisoVigente) return no('sin_aviso_publicado', 409);
  // La casilla de quien atiende NO consiente por otra persona: sólo vale que la titular ya haya aceptado.
  if (e.aNombreDeOtro) return e.yaAcepto ? { ok: true, registrar: false } : no('requiere_aceptacion_previa', 409);
  if (e.idAceptado && e.idAceptado !== e.avisoVigente.id) return no('aviso_desactualizado', 400);
  if (e.yaAcepto) return { ok: true, registrar: false };
  if (e.idAceptado === e.avisoVigente.id) return { ok: true, registrar: true };
  return no('falta_aceptar', 400);
}
