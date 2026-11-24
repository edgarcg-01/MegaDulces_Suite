/**
 * `[MCP.34]` «Pasar a venta»: las reglas puras para volver una cotización del vendedor un pedido de
 * preventa. Sin base ni HTTP (`cotizacion-a-pedido.engine.spec.ts`); el servicio lee, llama y escribe.
 *
 * Decisiones de David (2026-11-24): sólo las cotizaciones de la app del vendedor (`origin = route_visit`;
 * las de telemarketing van a Kepler por COT.7, que es otra puerta); un toque pide el día y manda el
 * pedido al surtidor; **el precio es el de HOY** (el pedido lo calcula con su motor, no se copia el de la
 * cotización). El esquema ya lo preveía: `commercial.quotes.order_id` es «linaje hacia el pedido en firme»
 * y el CHECK `commercial_quotes_order_only_when_accepted` sólo admite `order_id` con `status = 'accepted'`.
 */

/** Una cotización que no se puede pasar a venta: el servicio la vuelve 403/404/409 con este mensaje. */
export class NoSePasaAVenta extends Error {
  constructor(
    readonly http: 403 | 404 | 409 | 400,
    message: string,
  ) {
    super(message);
  }
}

/**
 * La vista previa (`dry_run`) arma el pedido y sale por aquí: la excepción hace que la transacción se deshaga
 * entera (pedido, renglones y folio) y quien llama devuelve lo que trae.
 */
export class VistaPreviaDeVenta<T = unknown> extends Error {
  constructor(readonly paso: T) {
    super('vista previa');
  }
}

export interface CotizacionParaVenta {
  id: string;
  code: string;
  status: string;
  origin: string;
  user_id: string | null;
  customer_id: string | null;
  warehouse_id: string | null;
  order_id: string | null;
}

export interface RenglonDeCotizacion {
  product_id: string | null;
  product_name: string | null;
  requested_text: string | null;
  quantity: number | string | null;
  qty_unit: string | null;
  qty_factor: number | string | null;
  /** No nulo = regalo que puso el motor de la cotización: el pedido calcula los suyos. */
  parent_line_number: number | null;
}

export interface RenglonParaPedido {
  product_id: string;
  quantity: number;
  qty_unit?: string;
  qty_factor?: number;
}

/**
 * ¿Se puede pasar a venta? `null` = sí. Una cotización que YA tiene pedido no es error: el servicio la
 * devuelve tal cual (un segundo toque, o la respuesta que se perdió sin señal, no duplica).
 */
export function motivoParaNoPasar(q: CotizacionParaVenta | null | undefined, userId: string): NoSePasaAVenta | null {
  if (!q) return new NoSePasaAVenta(404, 'No encontré esa cotización.');
  if (q.user_id !== userId) return new NoSePasaAVenta(403, 'Sólo quien hizo la cotización la puede pasar a venta.');
  if (q.origin !== 'route_visit') {
    return new NoSePasaAVenta(409, 'Esta cotización es de telemarketing: se vuelve pedido desde Telemarketing, no desde la app.');
  }
  if (q.order_id) return null;
  if (q.status !== 'draft' && q.status !== 'sent') {
    const que: Record<string, string> = { accepted: 'ya se aceptó', rejected: 'se cerró porque el cliente no compró', cancelled: 'se canceló', expired: 'venció' };
    return new NoSePasaAVenta(409, `Esta cotización ${que[q.status] ?? `está en «${q.status}»`}: ya no se puede pasar a venta.`);
  }
  if (!q.customer_id || !q.warehouse_id) {
    return new NoSePasaAVenta(409, 'La cotización no tiene cliente o sucursal de la Suite: no se puede armar el pedido.');
  }
  return null;
}

/**
 * Los renglones que pasan al pedido: los propios (no los regalos), con producto del catálogo y cantidad
 * mayor a cero, en la unidad cotizada. Lo que no tiene producto se nombra para decirlo, no se pierde.
 */
export function renglonesParaPedido(ls: readonly RenglonDeCotizacion[]): { renglones: RenglonParaPedido[]; sinProducto: string[] } {
  const renglones: RenglonParaPedido[] = [];
  const sinProducto: string[] = [];
  for (const l of ls) {
    if (l.parent_line_number != null) continue;
    const qty = Number(l.quantity);
    if (!(qty > 0)) continue;
    if (!l.product_id) {
      sinProducto.push((l.requested_text || l.product_name || 'renglón sin nombre').trim());
      continue;
    }
    const f = Number(l.qty_factor);
    const unidad = (l.qty_unit ?? '').trim();
    renglones.push(unidad && f > 0 ? { product_id: l.product_id, quantity: qty, qty_unit: unidad, qty_factor: f } : { product_id: l.product_id, quantity: qty });
  }
  return { renglones, sinProducto };
}
