/**
 * `[PQ.110]` Cancelar una OC de Kepler desde `/compras/oc-abiertas`.
 * `POST /commercial/replenishment/open-purchase-orders/:sucursal/:folio/cancelar`, llave `COMPRAS_OC_CANCELAR`.
 */

export interface OcCancelarInputDto {
  /** Por qué se cancela. Obligatorio, al menos 10 letras: queda en la Suite junto a la OC. */
  motivo: string;
}

export interface OcCancelacionDto {
  sucursal: string;
  folio: string;
  /**
   * `cancelada` = Kepler ya la tiene cancelada. `rechazada` = NO se escribió nada en Kepler; `rechazo`
   * dice por qué (la regla, el interruptor, un permiso o Kepler mismo).
   */
  estado: 'cancelada' | 'rechazada';
  rechazo: string | null;
  /** La requisición de Kepler que volvió a quedar abierta (Kepler hace lo mismo al cancelar). */
  requisicion_reabierta: string | null;
  cancelada_por: string | null;
  cancelada_en: string;
}

/**
 * `GET /commercial/replenishment/open-purchase-orders/:sucursal/:folio/cancelacion` — si la pantalla
 * puede OFRECER «Cancelar en Kepler» para esta OC, y si no, por qué. Existe para no mostrar un botón que
 * va a fallar (apagado en la sucursal, tope del día, ya cancelada, con vale vivo).
 *
 * ⚠️ La regla de Kepler se revisa aquí contra la RÉPLICA (`kepler_ods`), que puede ir atrasada; al
 * cancelar se vuelve a revisar contra Kepler vivo, dentro de su transacción. `disponible` es una
 * promesa de intentar, no de que Kepler acepte.
 */
export interface OcCancelacionDisponibleDto {
  sucursal: string;
  folio: string;
  disponible: boolean;
  /** Por qué no, en palabras para la persona. `null` si `disponible`. */
  porque: string | null;
  /** Si al cancelar Kepler reabriría una requisición, su folio (según la réplica). */
  reabriria_requisicion: string | null;
  /** El último intento registrado desde la Suite para esta OC (cancelada o rechazada), si lo hay. */
  ultima: OcCancelacionDto | null;
}
