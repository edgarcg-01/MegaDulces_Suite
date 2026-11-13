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
