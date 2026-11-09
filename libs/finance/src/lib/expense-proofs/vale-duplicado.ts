/**
 * `[GX.91]` **El aviso de vale duplicado**, el que devuelve el 409 de `create()`.
 *
 * Dice QUÉ pasó y QUÉ hacer, en las palabras de quien captura: «ya mandaste uno» no es lo mismo
 * que «lo capturó otra persona» — en el primer caso la persona va a su vale, en el segundo pregunta.
 * Vive aparte para probarlo sin base.
 */

/** Cómo se nombra cada estado desde el lado de quien capturó (las mismas palabras de «Mis gastos»). */
const ESTADO_PARA_QUIEN_CAPTURA: Record<string, string> = {
  recibida: 'esperando «Revisado»',
  aprobada: 'aprobado',
  revision: 'en revisión',
  validada: 'revisado',
};

export function valeDuplicadoMensaje(folio: string, status: string, mio: boolean): string {
  const estado = ESTADO_PARA_QUIEN_CAPTURA[status] ?? status;
  return mio
    ? `Ya mandaste un vale de la solicitud ${folio} (${estado}). No se manda dos veces: ábrelo en «Mis gastos».`
    : `La solicitud ${folio} ya tiene un vale (${estado}) que capturó otra persona. Si crees que es un error, avisa a quien aprueba.`;
}
