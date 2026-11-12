/**
 * `[MCP.21]` Modificar un pedido AGENDADO desde la tarjeta de «Pedidos» de la app de vendedores:
 * cambiar cantidades y quitar productos, con UN motivo, en una sola transacción (reabrir + cambiar +
 * volver a agendar). O se aplica todo o nada: el surtidor nunca ve un pedido a medias.
 *
 * Agregar un producto NUEVO no va aquí: se elige en la captura («Tomar pedido»), que es donde viven la
 * presentación, el precio y la existencia. Para eso, `keep_open: true` aplica los cambios y deja el
 * pedido abierto (borrador, mismo folio) para seguir en la captura.
 */

/** Un cambio a un renglón que ya existe. */
export interface OrderModifyChange {
  line_id: string;
  /** Quitar el renglón. Si viene, no se manda `quantity`. */
  remove?: boolean;
  /**
   * La cantidad nueva. Con `qty_unit` va EN ESA UNIDAD (2 = dos paquetes), igual que al tomar el pedido;
   * sin `qty_unit`, en la unidad base.
   */
  quantity?: number;
  qty_unit?: string | null;
  qty_factor?: number | null;
}

export interface OrderModifyRequest {
  /** El motivo (catálogo de «Corregir»): obligatorio, como en MCP.18. */
  reason_code: string;
  note?: string | null;
  changes: OrderModifyChange[];
  /** Dejarlo abierto para agregar productos en la captura (no se vuelve a agendar). */
  keep_open?: boolean;
}

/** Los renglones que se pueden cambiar a la vez (un pedido real tiene decenas, no cientos). */
export const MAX_CAMBIOS_PEDIDO = 200;
