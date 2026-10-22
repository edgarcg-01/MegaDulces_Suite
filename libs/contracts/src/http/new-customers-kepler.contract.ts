/**
 * `[MCP.3.8]` Cliente nuevo: alta en la Suite y liga con Kepler.
 *
 * El vendedor da de alta al cliente en la app (código provisional `V-`); se le puede levantar y
 * surtir el pedido, pero sin clave de Kepler no se cobra en Kepler ni entra en guía. La caja o el
 * surtidor de la sucursal lo dan de alta en Kepler y aquí LIGAN esa clave: la misma fila de
 * `commercial.customers` (pedidos y visitas se conservan) toma los datos de Kepler.
 */

/** Un cliente de la misma sucursal cuyo nombre se parece al que se va a dar de alta. */
export interface SimilarCustomer {
  id: string;
  name: string;
  /** Domicilio legible (estructurado o la referencia que capturó el vendedor). */
  address: string | null;
  phone: string | null;
  /** Ruta de venta de la Suite, si tiene. */
  sales_route: string | null;
  /** true = ya está ligado a una clave de Kepler. */
  kepler: boolean;
  /** 0–1: qué tanto se parece el nombre (1 = igual). */
  score: number;
}

export interface SimilarCustomersResponse {
  /**
   * Dónde se buscó. `sucursal` = la del vendedor (por su ruta); `todas` = no se pudo saber su
   * sucursal y se buscó en todo el catálogo (se declara, no se finge).
   */
  scope: 'sucursal' | 'todas';
  warehouse_name: string | null;
  matches: SimilarCustomer[];
}

/** Un pedido pendiente (por aprobar o confirmado) de un cliente nuevo. */
export interface NewCustomerOrder {
  order_id: string;
  code: string;
  status: string;
  total: number;
  requested_delivery_date: string | null;
}

/** Un cliente nuevo de la sucursal que todavía no tiene clave de Kepler. */
export interface NewCustomerRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  sales_route: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  /** Código de sucursal Kepler (`'02'`) donde se busca la clave. null = no se sabe de qué sucursal es. */
  branch: string | null;
  created_at: string;
  /** Quién lo dio de alta. null = el alta es anterior a que se registrara (se declara). */
  created_by_name: string | null;
  orders: NewCustomerOrder[];
}

export interface NewCustomersInboxResponse {
  /** `todos` = alcance de todas las sucursales; `propios` = las del usuario; `ninguno` = sin sucursal. */
  scope: 'todos' | 'propios' | 'ninguno';
  data: NewCustomerRow[];
  /** true si la lista se topó en el límite (no se esconde: se avisa). */
  truncated: boolean;
}

/** Para el aviso de la pantalla Surtir: cuántos faltan y qué pedidos son de un cliente sin clave. */
export interface NewCustomersSummary {
  scope: 'todos' | 'propios' | 'ninguno';
  customers: number;
  /** Pedidos pendientes de clientes sin clave de Kepler (para marcarlos en la lista). */
  order_ids: string[];
}

/** Lo que tiene Kepler con esa clave en la sucursal del cliente. */
export interface KeplerCustomerLookup {
  branch: string;
  code: string;
  /** false = esa clave no existe en Kepler de esa sucursal. */
  found: boolean;
  name: string | null;
  address: string | null;
  /** true = es una cuenta interna (la propia tienda o un vendedor), no un cliente. */
  internal: boolean;
  /** Si esa clave ya está ligada a otro cliente de la Suite (duplicado). */
  linked_to: { id: string; name: string } | null;
}

export interface LinkKeplerRequest {
  erp_customer_code: string;
}

export interface LinkKeplerResponse {
  id: string;
  /** Nombre que quedó: el de Kepler. */
  name: string;
  previous_name: string;
  code: string;
  branch: string;
  erp_customer_code: string;
  /** Pedidos pendientes que conservó (misma fila de cliente). */
  pending_orders: number;
}
