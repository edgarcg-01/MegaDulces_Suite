/**
 * `[MCP.34]` «Pasar a venta»: la cotización del vendedor se vuelve un pedido de preventa confirmado.
 * `POST /api/commercial/orders/from-quote/:quoteId` con {@link PasoAVentaBody}.
 */
export interface PasoAVentaBody {
  /** Día de entrega `YYYY-MM-DD`, desde hoy (hora de México). Obligatorio. */
  requested_delivery_date: string;
  /** `true` = arma el pedido y lo deshace: sólo para enseñar el total de hoy antes de confirmar. */
  dry_run?: boolean;
}

export interface PasoAVenta {
  quote_id: string;
  quote_code: string;
  /** Lo que decía la cotización. */
  quote_total: number;
  order_id: string;
  order_code: string | null;
  /** Lo que cobra el pedido con los precios de HOY. `null` sólo si el pedido ligado ya no se encontró. */
  order_total: number | null;
  requested_delivery_date: string | null;
  /** Renglones de la cotización sin producto del catálogo: no pasaron al pedido. */
  sin_producto: string[];
  /** La cotización ya tenía pedido: se devolvió ése, no se hizo otro. */
  ya_existia: boolean;
  /** Vista previa: nada se guardó. */
  dry_run: boolean;
}
