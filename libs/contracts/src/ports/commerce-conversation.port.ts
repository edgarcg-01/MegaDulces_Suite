// Port de inversión de dependencia (ADR-034, Fase F.2): el orquestador
// conversacional de WhatsApp (libs/whatsapp) resuelve productos del catálogo SIN
// importar el dominio commercial. El orquestador inyecta este token con
// @Optional() (el binding solo existe con ENABLE_MULTITENANT=true) y lo llama
// dentro del scope de tenant. El binding al servicio real (CatalogSearch) se hace
// en el composition root (app.module), único lugar que conoce ambos lados.
//
// INVARIANTE ADR-016: el precio lo decide el MOTOR (product_prices vía
// CatalogSearch), NUNCA el LLM. El bot solo pasa el product_id que ESTE puerto
// devolvió en una búsqueda previa; el precio se toma de aquí, no del texto del LLM.

export const COMMERCE_CONVERSATION_PORT = 'COMMERCE_CONVERSATION_PORT';

/**
 * Producto resuelto por el motor: id + nombre + precio + existencia + empaque.
 * Todo lo cuantitativo (precio/stock/factor) sale del motor, NUNCA del LLM (ADR-016).
 */
export interface ConversationProductHit {
  product_id: string;
  name: string;
  brand_name: string | null;
  /** Precio por PIEZA (unidad canónica del pedido). */
  unit_price: number;
  min_qty: number;
  /** Piezas disponibles en el almacén de surtido (quantity − reserved). */
  stock_pieces: number;
  /** Piezas por paquete/caja (factor_sale UXC). 1 = se vende suelto por pieza. */
  pieces_per_package: number;
}

/** Alta de un pedido a domicilio desde una conversación aprobada (F.3). */
export interface ConversationOrderDto {
  /** Cliente casual (alta rápida / dedupe por teléfono). */
  casual: { name: string; phone: string };
  delivery_address: {
    street: string;
    references?: string;
    recipient_name?: string;
    phone?: string;
  };
  lines: { product_id: string; quantity: number }[];
}

export interface ConversationOrderResult {
  order_id: string;
  code: string;
  total: number;
}

/**
 * Cliente reconocido por su teléfono (FIQ.0 / ADR-036). El bot lo usa para
 * saludar por nombre y, más adelante (FIQ.3/4), para su precio de mayoreo,
 * historial y recomendaciones. Resuelto por el MOTOR (motor decide, LLM narra).
 */
export interface ConversationCustomer {
  customer_id: string;
  name: string;
  /** true = alta rápida sin cartera formal (casual). */
  is_casual: boolean;
  /** Lista de precio del cliente (mayoreo). null = usa el default del tenant. */
  default_price_list_id: string | null;
}

export interface CommerceConversationPort {
  /**
   * Busca productos por lenguaje natural, scoped al price_list default del
   * tenant (cliente casual de WhatsApp sin cartera). Devuelve top-N con precio.
   * Debe ejecutarse dentro de un scope de tenant (CLS) ya establecido.
   */
  searchProducts(query: string, opts?: { limit?: number }): Promise<ConversationProductHit[]>;

  /**
   * Resuelve el cliente de cartera por su teléfono (FIQ.0 / ADR-036). Normaliza
   * a MSISDN canónico y busca por `customers.whatsapp` (y `phone` de fallback).
   * Devuelve null si no hay match (contacto casual/nuevo). Debe ejecutarse dentro
   * de un scope de tenant (CLS) ya establecido.
   */
  resolveCustomerByPhone(phone: string): Promise<ConversationCustomer | null>;

  /**
   * Crea el pedido a domicilio (canal whatsapp) cuando un HUMANO aprueba la
   * conversación desde la bandeja (F.3). Reusa el intake de última milla
   * (cliente casual + dirección + líneas), deja el pedido confirmado (stock
   * reservado) listo para `/reparto/asignar`. La aprobación humana ES la
   * confirmación (ADR-034: bot arma / humano confirma).
   */
  createHomeDeliveryOrder(dto: ConversationOrderDto): Promise<ConversationOrderResult>;
}
