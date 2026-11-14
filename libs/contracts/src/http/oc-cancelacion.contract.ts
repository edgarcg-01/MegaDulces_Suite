/**
 * `[PQ.110]` Cancelar una OC de Kepler desde `/compras/oc-abiertas`.
 * `POST /commercial/replenishment/open-purchase-orders/:sucursal/:folio/cancelar`, llave `COMPRAS_OC_CANCELAR`.
 */

/** Mínimo de letras del motivo. Lo usan el servidor (`motivoValido`) y la pantalla: la misma regla. */
export const OC_CANCELAR_MOTIVO_MIN = 10;

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

/**
 * `[KR.7]` Cancelar en Kepler una requisición de compra (`X-A-30`) desde su ficha
 * (`/compras/requisiciones/:id`). Llave `COMPRAS_REQUISICION_CANCELAR`. Mismo cuerpo que la OC
 * (`OcCancelarInputDto`: `{ motivo }`, mínimo `OC_CANCELAR_MOTIVO_MIN` letras).
 *
 * `POST /commercial/replenishment/requisitions/:id/kepler-cancellation` cancela;
 * `GET` del mismo camino dice si se puede ofrecer el botón.
 */
export interface RequisicionCancelacionDto {
  /** La requisición de la Suite. */
  requisition_id: string;
  /** Sucursal y folio de la requisición EN KEPLER. */
  sucursal: string;
  folio: string;
  /** `cancelada` = Kepler ya la tiene cancelada. `rechazada` = NO se escribió nada en Kepler; `rechazo` dice por qué. */
  estado: 'cancelada' | 'rechazada';
  rechazo: string | null;
  /**
   * D43: si la requisición de la Suite quedó cancelada con este acto. `false` = ya estaba cancelada aquí, o
   * Kepler la canceló pero la Suite no lo pudo registrar (queda en el log). `null` = no se sabe (un intento
   * anterior, leído de la bitácora).
   */
  suite_cancelada: boolean | null;
  cancelada_por: string | null;
  cancelada_en: string;
}

/**
 * `GET /commercial/replenishment/requisitions/:id/kepler-cancellation` — si la ficha puede OFRECER
 * «Cancelar en Kepler», y si no, por qué (no se mandó a Kepler, apagado en la sucursal, tope del día, ya
 * cancelada, con una OC viva).
 *
 * ⚠️ Como en la OC: la regla de Kepler se revisa aquí contra la RÉPLICA, que puede ir atrasada; al cancelar
 * se revisa otra vez contra Kepler vivo. `disponible` es una promesa de intentar, no de que Kepler acepte.
 */
export interface RequisicionCancelacionDisponibleDto {
  requisition_id: string;
  /** `null` si la requisición nunca llegó a Kepler. */
  sucursal: string | null;
  folio: string | null;
  disponible: boolean;
  porque: string | null;
  /** El último intento registrado desde la Suite para esta requisición (cancelada o rechazada), si lo hay. */
  ultima: RequisicionCancelacionDto | null;
}
