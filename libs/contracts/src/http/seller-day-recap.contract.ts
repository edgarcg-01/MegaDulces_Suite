/**
 * `[MCP.19]` **Recuento del día** del vendedor: lo que levantó, qué pasó con eso al surtir, a quién
 * visitó y qué le quedó pendiente. Lo ven el vendedor (arriba de «Pedidos») y su supervisor
 * («Equipo › vendedor»), con la MISMA respuesta: los dos están al pendiente del mismo día.
 *
 * Todo se DERIVA al consultar (no hay tabla ni proceso al cierre):
 *  - los pedidos: `commercial.orders` de la persona creados ese día (hora de México). «Levantado» =
 *    ni borrador ni cancelado, el mismo universo que el «Levantado» del Monitoreo vecinal;
 *  - qué pasó al surtir y el cobro: el mismo armado que «Mis pedidos» (`[MCP.8]`);
 *  - las visitas y los clientes de su ruta: el monitoreo de visitas (`[MCP.3.7]`), que también decide
 *    a quién puede ver un supervisor (su equipo).
 *
 * ⚠️ «Finalizar ruta» cuenta sólo lo confirmado DENTRO de la ruta; aquí va el día entero. En prod
 * (oct–nov 2026) 19 de 386 pedidos se mandaron fuera de la ventana de la ruta.
 */
import type { PresaleChargeSource } from './presale-picking.contract';
import type { VisitMonitorStatus, VisitNoSaleReason } from './visit-monitor.contract';

/** Cómo va en el surtido un pedido levantado. `sin_dato` = no se pudo leer su avance (no es «sin surtir»). */
export type SellerDayPickState = 'sin_surtir' | 'surtiendo' | 'completo' | 'con_faltantes' | 'sin_dato';

/** Un pedido del día, para el desglose de cada número. */
export interface SellerDayOrder {
  order_id: string;
  code: string;
  customer_id: string | null;
  customer_name: string | null;
  /** Con lo que se levantó. */
  total: number;
  /** ISO 8601: cuándo se creó. */
  created_at: string;
  /** `confirmed` · `fulfilled` · `pending_approval` · `draft` · `cancelled`. */
  status: string;
  pick: SellerDayPickState;
  /** Cuánto bajó el pedido al surtir y en caja (levantado − cómo quedó); 0 si no bajó o no se ha surtido. */
  removed_total: number;
  /** `liga` = cobro confirmado; `detectado` = parece cobrado (lo confirma quien entrega). */
  charge: PresaleChargeSource | null;
  delivered: boolean;
  /** Sólo en cancelados: el motivo en palabras; `null` = sin motivo registrado. */
  reason: string | null;
}

/** Un cliente de su ruta que no visitó. */
export interface SellerDayMissedCustomer {
  customer_id: string;
  code: string;
  name: string;
  /** `no_paso`/`se_fue_sin_abrir` = falta; `pendiente` = la ruta sigue abierta; `sin_ubicacion`/`sin_gps` = no medido. */
  state: VisitMonitorStatus;
}

export interface SellerDayVisits {
  /** Clientes de su ruta ese día. 0 = sin ruta asignada (pero pudo visitar). */
  route_customers: number;
  routes: string[];
  /** Visitados en total (de su ruta y fuera de ella) = `visited_on_route + off_route`. */
  visited: number;
  /** De su ruta, cuántos visitó (contra `route_customers`). */
  visited_on_route: number;
  /** Visitados que no son de su ruta ese día. */
  off_route: number;
  with_order: number;
  without_order: number;
  /** Abrió al cliente y no cerró la visita. */
  open: number;
  /** El día ya se juzgó (ruta finalizada o fecha pasada) y no los visitó. */
  missed: number;
  /** La ruta sigue abierta: todavía no se juzga. */
  pending: number;
  /** `true` = el día ya se juzga. */
  closed: boolean;
  /** Los clientes de su ruta sin visita, en el orden en que los da el monitoreo. */
  not_visited: SellerDayMissedCustomer[];
  /** Por qué no hubo venta, cuántas veces cada motivo. Las visitas sin motivo van en `sin_motivo`. */
  no_sale_reasons: Array<{ reason: VisitNoSaleReason | 'sin_motivo'; count: number }>;
}

export interface SellerDayPicking {
  completo: number;
  con_faltantes: number;
  surtiendo: number;
  sin_surtir: number;
  /** No se pudo leer su avance: se dice, no se cuenta como «sin surtir». */
  sin_dato: number;
  /** Suma de lo que bajaron al surtir y en caja. */
  removed_total: number;
  /** Cobro confirmado (liga). */
  charged: number;
  /** Parece cobrado: lo confirma quien entrega. */
  charged_to_confirm: number;
  delivered: number;
}

export interface SellerDayRecap {
  /** `YYYY-MM-DD` del recuento (hora de México). */
  date: string;
  /** `YYYY-MM-DD` de hoy en el servidor (hora de México). */
  today: string;
  user_id: string;
  name: string | null;
  /** Pedidos levantados (ni borrador ni cancelado; uno por pedido aunque lo surtan dos sucursales) y su suma. */
  orders: { count: number; total: number };
  /** Cómo van en el surtido los levantados. `null` = no se pudo leer (`picking_unmeasured_reason`). */
  picking: SellerDayPicking | null;
  picking_unmeasured_reason: string | null;
  /** `null` = no se pudo medir o no tuvo ruta (`visits_unmeasured_reason`). */
  visits: SellerDayVisits | null;
  visits_unmeasured_reason: string | null;
  /** Lo que quedó por hacer, como está AHORA: borradores sin mandar y pedidos por aprobar. */
  pending: { drafts: SellerDayOrder[]; awaiting_approval: SellerDayOrder[] };
  /** Los que se cancelaron, con su motivo. */
  cancelled: SellerDayOrder[];
  /** Los levantados, para el desglose (suman `orders.total`). */
  orders_list: SellerDayOrder[];
}
