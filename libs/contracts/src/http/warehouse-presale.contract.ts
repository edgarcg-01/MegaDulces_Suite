/**
 * `[MCP.1]` / `[MCP.4]` La FORMA del wire de la Mesa de Control de Preventa (Fase MCP, ADR-089).
 *
 * El pedido de preventa (`PD-`) se levanta y se surte en la Suite (`commercial.orders`), se cobra
 * en Kepler (ticket `U-D-10` a nombre del cliente) y se entrega de conformidad en la Suite. La mesa
 * junta las dos mitades: el documento de Kepler se LEE del ODS (`analytics.erp_sale_tickets`), y
 * sólo la liga pedido↔documento es dato propio (`commercial.order_kepler_documents`).
 *
 * La lógica (etapa derivada, semáforo, orden de candidatos) vive en
 * `libs/commercial/src/lib/presale-control/presale-control.engine.ts`; acá sólo la forma.
 */

/**
 * Etapa del pedido, DERIVADA (no hay columna "etapa"): `orders.status` + ola de surtido + liga.
 *
 *  · `esperando_alta`  confirmado, el cliente no tiene clave de Kepler: no se le puede emitir
 *                      documento, así que no se surte (D7).
 *  · `por_surtir`      confirmado, sin ola.
 *  · `en_surtido`      en una ola viva.
 *  · `en_caja`         surtido (`listo_embarque`), todavía sin documento ligado.
 *  · `cobrado`         con documento de Kepler ligado, sin entrega registrada.
 *  · `en_ruta`         `[MCP.5]` va cargado en una guía de carga ya IMPRESA (el repartidor la firmó).
 *  · `entregado`       `fulfilled` (flujo anterior a la mesa; la entrega de conformidad llega en MCP.6).
 *  · `cancelado`
 */
/**
 * `[MCP]` Cuántas veces puede SALIR OTRA VEZ un pedido que no se entregó, con el mismo documento,
 * antes de ir a devolución y nota de crédito en Kepler (I2, Francisco 2026-10-08: "sólo 2 entregas
 * más, se empieza a maltratar la mercancía"). Sale 1 vez + 2 reintentos = 3 intentos. Vive aquí para
 * que el motor y las pantallas lean el mismo número.
 */
export const PRESALE_MAX_REINTENTOS = 2;

export const PRESALE_STAGES = [
  'esperando_alta',
  'por_surtir',
  'en_surtido',
  'en_caja',
  'cobrado',
  'en_ruta',
  'entregado',
  'cancelado',
] as const;
export type PresaleStage = (typeof PRESALE_STAGES)[number];

/** Contra la fecha de entrega prometida. `null` = pedido cerrado (entregado o cancelado). */
export type PresaleDue = 'a_tiempo' | 'hoy' | 'vencido' | null;

/**
 * Por qué NO se pueden buscar documentos de Kepler para el pedido. `null` = sí se puede.
 *
 *  · `cliente_sin_clave`         el cliente no existe en Kepler (alta en campo, código `V-…`).
 *  · `cliente_de_otra_sucursal`  la clave del cliente es de OTRA sucursal: las claves de Kepler son
 *                                por sucursal, y buscar con ella traería a otro cliente.
 *  · `sucursal_sin_documentos`   la sucursal del pedido no publica tickets de Kepler en el ODS
 *                                (p. ej. Morelia Madero, que corre Wincaja).
 */
export type PresaleLinkBlock = 'cliente_sin_clave' | 'cliente_de_otra_sucursal' | 'sucursal_sin_documentos';

export interface PresaleDocumentRef {
  /** `04UD1003-0002097`: la llave de `analytics.erp_sale_tickets.folio_digital`. */
  folio_digital: string;
  sucursal: string;
  /** `YYYY-MM-DD`. `null` si el documento ligado ya no aparece en el ODS (no se dibuja una fecha). */
  fecha: string | null;
  caja: number | null;
  /**
   * Total del documento con impuestos (`kdm1.c16`). `null` si el documento no aparece en el ODS.
   * ⚠️ Si Kepler trae `c16` vacío, la vista lo publica como 0 (`coalesce`): ese 0 viene de la fuente.
   */
  total: number | null;
}

export interface PresaleLink extends PresaleDocumentRef {
  link_source: 'mesa' | 'celular';
  linked_at: string;
  linked_by_name: string | null;
}

export interface PresaleOrderRow {
  id: string;
  code: string;
  status: string;
  stage: PresaleStage;
  customer_id: string;
  customer_name: string | null;
  /** Clave del cliente en Kepler; `null` si no existe allá. */
  customer_erp_code: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  /** Sucursal en la llave canónica de 2 dígitos (`branchKeySql`). */
  branch: string | null;
  sales_route: string | null;
  seller_name: string | null;
  /** `YYYY-MM-DD`. */
  requested_delivery_date: string;
  due: PresaleDue;
  /** Días desde la fecha prometida (positivo = vencido). `null` si el pedido está cerrado. */
  days_late: number | null;
  total: number;
  lines: number;
  created_at: string;
  link: PresaleLink | null;
  link_block: PresaleLinkBlock | null;
  /**
   * Documentos de Kepler del cliente que PODRÍAN ser el cobro de este pedido (sin liga, misma
   * sucursal, desde la captura). `null` = no se buscó (pedido ligado, cerrado o bloqueado).
   * ⚠️ Es un indicio, no un cobro: el cliente también compra en mostrador.
   */
  possible_documents: number | null;
  /** `[MCP.5]` La guía de carga en la que va cargado, o `null` si nadie lo ha pescado. */
  load_guide: { id: string; folio: string; status: 'abierta' | 'impresa' | 'liquidada'; rider_name: string | null } | null;
  /** `[MCP.6]` La entrega de conformidad registrada en el celular, o `null` si no se ha entregado. */
  delivery: PresaleDelivery | null;
  /** `[MCP.7]` Veces que salió y volvió sin entregarse (`regreso` + `no_entregado`). */
  failed_attempts: number;
  /**
   * `[MCP.7]` Agotó los reintentos (D10/I2): ya no sale otra vez; va a devolución y nota de crédito en
   * Kepler. Cerrarlo cuando la devolución aparezca en el ODS depende de I1 (aún sin decodificar).
   */
  return_required: boolean;
}

/** `[MCP.6]` Entrega de conformidad (en el renglón de la guía, NO en `orders.status`). */
export interface PresaleDelivery {
  /** ISO. */
  delivered_at: string;
  delivered_by_name: string | null;
  outcome: 'completo' | 'con_diferencia';
  note: string | null;
  cash_amount: number;
  transfer_amount: number;
  transfer_ref: string | null;
  guide_folio: string;
  /** El documento de Kepler que se entregó (el cobro es de ése). */
  folio_digital: string;
}

export interface PresaleListResponse {
  data: PresaleOrderRow[];
  count: number;
  /** `true` si se alcanzó el tope de filas: hay más pedidos de los que se devuelven. */
  truncated: boolean;
  /** Conteo por etapa sobre las MISMAS filas que se devuelven. */
  by_stage: Record<PresaleStage, number>;
  overdue: number;
  /** `todos` = sin recorte de sucursal; `recortado` = sólo las del alcance; `ninguno` = alcance vacío. */
  scope: 'todos' | 'recortado' | 'ninguno';
  /** Fecha de hoy en hora de México con la que se calculó el semáforo. */
  today: string;
}

export interface PresaleLineCompare {
  product_id: string | null;
  sku: string | null;
  description: string | null;
  /** Lo pedido, en unidad base. `null` si el renglón sólo está en el documento. */
  ordered_qty: number | null;
  /** Precio unitario del pedido SIN impuesto. */
  ordered_price: number | null;
  /** Lo cobrado (`kdm2.c9`, unidad base `c11`). `null` si el renglón sólo está en el pedido. */
  charged_qty: number | null;
  charged_unit: string | null;
  /** Precio unitario cobrado SIN impuesto. */
  charged_price: number | null;
  /**
   * ⚠️ Se compara cantidad y precio, NO importes: el total del renglón del pedido trae impuesto y
   * el importe del renglón del ticket no.
   */
  match: 'igual' | 'cantidad' | 'precio' | 'cantidad_y_precio' | 'solo_pedido' | 'solo_documento';
}

export interface PresaleCandidate extends PresaleDocumentRef {
  cashier_name: string | null;
  /** Cuántos productos del pedido aparecen en el documento. Ordena la lista; no decide sola. */
  shared_products: number;
  order_products: number;
  /** Ya ligado a otro pedido: se muestra, no se puede elegir. */
  linked_to_order_code: string | null;
}

export interface PresaleCandidatesResponse {
  order_id: string;
  link_block: PresaleLinkBlock | null;
  /** Desde qué fecha se buscó (la de captura del pedido) y hasta cuándo. */
  from: string;
  to: string;
  data: PresaleCandidate[];
}

export interface PresaleDetail {
  order: PresaleOrderRow;
  history: Array<{ from_status: string | null; to_status: string; changed_at: string; reason: string | null; changed_by_username: string | null }>;
  /** Comparación por renglón contra el documento ligado. Vacía si no hay liga. */
  compare: PresaleLineCompare[];
  /** Historial de ligas, incluidas las desligadas. */
  links: Array<PresaleLink & { unlinked_at: string | null; unlink_reason: string | null }>;
}

export interface PresaleLinkRequest {
  folio_digital: string;
}

export interface PresaleUnlinkRequest {
  reason: string;
}

export interface PresaleLinkResponse {
  ok: true;
  order_id: string;
  /** El documento ligado; ausente al desligar. */
  folio_digital?: string;
}
