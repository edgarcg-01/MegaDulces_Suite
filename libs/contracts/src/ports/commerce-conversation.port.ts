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

/** Producto resuelto por el motor: id + nombre + precio autoritativo. */
export interface ConversationProductHit {
  product_id: string;
  name: string;
  brand_name: string | null;
  unit_price: number;
  min_qty: number;
}

export interface CommerceConversationPort {
  /**
   * Busca productos por lenguaje natural, scoped al price_list default del
   * tenant (cliente casual de WhatsApp sin cartera). Devuelve top-N con precio.
   * Debe ejecutarse dentro de un scope de tenant (CLS) ya establecido.
   */
  searchProducts(query: string, opts?: { limit?: number }): Promise<ConversationProductHit[]>;
}
