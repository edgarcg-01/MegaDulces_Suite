/**
 * `[MCP.3]` + `[MCP.8]` Surtido de preventa por pedido y avance para la vendedora.
 *
 * El surtidor de la sucursal recibe en su bandeja los pedidos de preventa de SU almacén, separados
 * por día de entrega; registra quién empieza a surtir y a qué hora, marca lo que hubo por renglón y
 * cierra. Lo que no hubo se QUITA del pedido y el total se recalcula (decisión de David,
 * 2026-10-14); la vendedora recibe el reporte.
 *
 * La vendedora ve, por pedido: agendado → lo tomó el surtidor → surtido → cobrado en Kepler →
 * entregado. "Cobrado" puede venir de la liga confirmada (la hace una persona, D2/D6 de la Fase MCP)
 * o de una DETECCIÓN: un solo ticket del cliente, posterior al surtido, con los mismos productos.
 * La detección se muestra como tal; no escribe la liga.
 *
 * `[MCP.10.1]` Después del surtido, la caja revisa el pedido y puede cambiarlo (completar lo que faltó,
 * quitar lo que no hubo). La vendedora y el surtidor ven ese resultado (`review`/`reviewed`), no sólo el
 * reporte del surtido: el reporte cuenta lo que pasó al surtir; la revisión, cómo quedó.
 */

import type { PresaleReviewResult } from './presale-review.contract';
import type { StockState } from './stock-state.contract';
import type { OrderJustification } from './order-justification.contract';

/** Pestañas de la bandeja. `hoy` incluye lo vencido: lo atrasado también se surte hoy. */
export type PresalePickBucket = 'hoy' | 'manana' | 'proximos';

/** Estado del surtido de un pedido. `en_recorrido` = ya va en una ola de la consola de surtido. */
export type PresalePickState = 'nuevo' | 'surtiendo' | 'completo' | 'con_faltantes' | 'en_recorrido';

export interface PresalePickPerson {
  user_id: string;
  name: string;
  /** ISO 8601. */
  at: string;
}

export interface PresalePickInboxRow {
  order_id: string;
  code: string;
  customer_name: string | null;
  seller_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  /** `YYYY-MM-DD`. */
  requested_delivery_date: string;
  bucket: PresalePickBucket;
  /** Días de atraso contra la fecha prometida (sólo en `hoy`; 0 = es de hoy). */
  days_late: number;
  /** ISO 8601: cuándo llegó a la sucursal (confirmación). Ordena dentro del día (D5: orden de llegada). */
  arrived_at: string;
  lines: number;
  total: number;
  state: PresalePickState;
  started: PresalePickPerson | null;
  finished: PresalePickPerson | null;
  /** Aviso de la sucursal sin acuse. */
  unseen: boolean;
  /** `[MCP.10.1]` Quién lo revisó en caja y cuándo; `null` = sin revisar. Opcional por compatibilidad. */
  reviewed?: PresalePickPerson | null;
  /**
   * `[MCP.3.13]` Pedido agrupado: folio del pedido PRINCIPAL del grupo (el del vendedor; si este
   * renglón es el principal, su propio folio). `null` = pedido suelto. Opcional por compatibilidad.
   */
  group_code?: string | null;
  /** Partes vivas del grupo (no canceladas), contando ésta. `null` = pedido suelto. */
  group_parts?: number | null;
  /** Etiqueta corta (`warehouses.short_label`, si no el nombre) de las sucursales de las OTRAS partes. `[]` = suelto. */
  group_other_warehouses?: string[];
  /**
   * `[MCP.3.15]` Indicaciones del vendedor para el surtidor (un solo texto por pedido; `orders.notes`).
   * `null` = sin indicaciones. Opcional por compatibilidad.
   */
  instructions?: string | null;
}

export interface PresalePickInboxResponse {
  /** `YYYY-MM-DD` en hora de México. */
  today: string;
  counts: Record<PresalePickBucket, number>;
  data: PresalePickInboxRow[];
  /** `ninguno` = el usuario no tiene almacén en su alcance; se dice, no se muestra vacío mudo. */
  scope: 'todos' | 'propios' | 'ninguno';
}

export interface PresalePickLine {
  line_id: string;
  product_id: string;
  sku: string | null;
  /** `[MCP.3.1]` Código de barras del catálogo: el surtidor escanea la etiqueta para encontrar el renglón. */
  barcode?: string | null;
  product_name: string;
  /** Cantidad pedida en la unidad en que se capturó (`qty_unit`); si no hay sello, en unidad base. */
  qty: number;
  unit: string;
  /** Piezas de unidad base por unidad mostrada (1 si no hay sello). */
  factor: number;
  /**
   * Lo que se marcó al surtir (en la unidad mostrada). `null` = el pedido no se ha cerrado.
   * `[MCP.10.1]` Es lo que surtió el SURTIDOR, aunque después la caja lo haya completado.
   */
  picked: number | null;
  /** `[MCP.10.1]` Cómo quedó en el pedido tras la revisión en caja; `null`/ausente = sin revisar. */
  final?: number | null;
  /** `[MCP.13]` Este renglón lo puso el surtidor EN LUGAR de otro que no hubo; ausente = no es sustituto. */
  substitutes?: { product_name: string; sku: string | null } | null;
}

export interface PresalePickDetail {
  order: PresalePickInboxRow;
  lines: PresalePickLine[];
  /** `[MCP.18]` Por qué cambió el pedido (vendedora, surtidor, caja), con su motivo. Ausente = servidor anterior. */
  justifications?: OrderJustification[];
}

export interface PresalePickFinishRequest {
  /**
   * Una entrada por cada renglón del pedido: lo que sí hubo, en la unidad mostrada.
   * `[MCP.18]` `reason` (clave de `MOTIVOS_SURTIDO`) y `reason_note`: por qué faltó. Sólo cuenta en un
   * renglón con faltante; ausente = sin motivo registrado (una pantalla anterior no lo manda).
   */
  lines: Array<{ line_id: string; picked: number; substitute?: PresalePickSubstituteChoice | null; reason?: string | null; reason_note?: string | null }>;
}

/**
 * `[MCP.13]` Lo que el surtidor puso en lugar de lo que faltó de un renglón: otro producto, en una
 * de sus unidades (PZA, PAQ, CJA…). Se cobra a SU precio de Kepler en la sucursal del pedido.
 */
export interface PresalePickSubstituteChoice {
  product_id: string;
  /** En la unidad `unit` del sustituto. */
  quantity: number;
  /** Rótulo de una unidad del sustituto (de `PresaleSubstituteCandidate.units`). */
  unit: string;
}

/** `[MCP.13]` Un cambio de producto hecho al surtir, como queda en el reporte. */
export interface PresalePickSubstitution {
  /** El renglón nuevo del pedido (el sustituto). */
  line_id: string;
  /** El renglón que faltó. En `removed` ya no existe; en `adjusted` sigue con lo que sí hubo. */
  for_line_id: string;
  for_product_name: string;
  for_sku: string | null;
  product_id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  unit: string;
  line_total: number;
  /** `[MCP.17]` Es el MISMO producto en otra unidad (no hubo la caja completa); ausente = otro producto. */
  same_product?: boolean;
}

/** `[MCP.13]` Una unidad en que se puede surtir el sustituto, con su precio de lista (IVA incluido). */
export interface PresaleSubstituteUnit {
  unit: string;
  /** Piezas de unidad base por unidad. */
  factor: number;
  price: number | null;
}

/** `[MCP.13]` Un producto que se puede poner en lugar del que faltó. */
export interface PresaleSubstituteCandidate {
  product_id: string;
  sku: string | null;
  product_name: string;
  units: PresaleSubstituteUnit[];
  /** Existencia en la sucursal del pedido, en unidad base. `null` = sin dato (no se pudo medir). */
  stock_qty: number | null;
  stock_state: StockState;
  /** Por qué se sugiere: comparte palabras del nombre, es del mismo proveedor, o lo buscó el surtidor. */
  match: 'nombre' | 'nombre_y_proveedor' | 'proveedor' | 'busqueda';
}

/**
 * `[MCP.17]` Las presentaciones más CHICAS del mismo producto de un renglón, para surtir en otra unidad lo
 * que faltó: pidieron 1 CJA, no hubo caja completa y van 8 PAQ. El sistema cuenta piezas, no cajas
 * cerradas: sólo el surtidor sabe si la caja está completa.
 */
export interface PresaleOtherUnitsResponse {
  for_line_id: string;
  product_id: string;
  product_name: string;
  /** Lo pedido, en la unidad del renglón (la que ve el surtidor). */
  ordered: number;
  unit: string;
  /** Piezas base por cada unidad del renglón (1 CJA = 24). */
  factor: number;
  /** Más chicas que la del renglón y con precio en la sucursal. Vacío = no hay otra presentación. */
  units: PresaleSubstituteUnit[];
}

/**
 * `[MCP.17]` Cuántas de `unidad` caben en lo que faltó (en piezas base): hacia abajo, porque no se surte
 * más de lo que faltó; en peso no se redondea. La usan la pantalla (el tope del campo) y el servidor (el 400),
 * para que «cabe» signifique lo mismo en los dos lados.
 */
export function topeEnUnidad(faltoBase: number, unidad: { unit: string; factor: number }): number {
  const t = Number(faltoBase) / Number(unidad.factor);
  if (!(t > 0) || !Number.isFinite(t)) return 0;
  return /^(KG|GR|LT|LTS|L|ML)$/i.test(unidad.unit) ? Math.round(t * 1000) / 1000 : Math.floor(t + 1e-9);
}

export interface PresaleSubstituteResponse {
  for_line_id: string;
  for_product_name: string;
  /** Lo que faltó, en la unidad del renglón original. */
  missing: number;
  unit: string;
  data: PresaleSubstituteCandidate[];
}

export interface PresalePickReportLine {
  product_name: string;
  unit: string;
  ordered: number;
  picked: number;
  /**
   * `[MCP.10]` El renglón del pedido. Opcional: los reportes de antes del 2026-10-29 no lo traen.
   * En `adjusted` sigue existiendo en `order_lines`; en `removed` ya se borró (queda `restore`).
   */
  line_id?: string;
  /**
   * `[MCP.10]` Sólo en `removed`: lo necesario para devolver al pedido el renglón borrado si la caja
   * lo completa con el surtidor. Sin esto (reportes viejos) la caja no puede completarlo.
   */
  restore?: PresalePickRestore;
  /** `[MCP.18]` Por qué faltó: clave de `MOTIVOS_SURTIDO`. Ausente = sin motivo registrado (reportes de antes). */
  reason?: string;
  /** `[MCP.18]` Nota del motivo (obligatoria con «Otro motivo»). */
  reason_note?: string;
}

/** `[MCP.10]` Copia del renglón borrado al surtir, para poder reponerlo. Cantidad en unidad BASE. */
export interface PresalePickRestore {
  product_id: string;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
  qty_factor_source: string | null;
  discount_percent: number;
  unit_price: number;
  tax_rate: number;
  source_warehouse_id: string | null;
  line_number: number | null;
  notes: string | null;
}

export interface PresalePickReport {
  /** Renglones que se quitaron del pedido (no hubo nada). */
  removed: PresalePickReportLine[];
  /** Renglones que se ajustaron a lo que hubo. */
  adjusted: PresalePickReportLine[];
  /** `[MCP.13]` Lo que el surtidor cambió por otro producto. Ausente en reportes de antes del cambio. */
  substituted?: PresalePickSubstitution[];
  /** `[MCP.13.1]` No hubo nada de ningún producto: el pedido se canceló al terminar de surtir. */
  order_cancelled?: boolean;
  total_before: number;
  total_after: number;
}

export interface PresalePickFinishResponse {
  order_id: string;
  outcome: 'completo' | 'con_faltantes';
  report: PresalePickReport | null;
}

/** Cómo se sabe que Kepler cobró el pedido. */
export type PresaleChargeSource = 'liga' | 'detectado';

export interface PresaleSellerCharge {
  source: PresaleChargeSource;
  folio_digital: string;
  fecha: string | null;
  total: number | null;
  /** Productos del pedido que aparecen en el ticket / productos del pedido. */
  shared_products: number;
  order_products: number;
}

export interface PresaleSellerOrder {
  order_id: string;
  code: string;
  /** `[MCP.21]` Para «Corregir» desde la tarjeta (abre la captura de ese cliente). Ausente en servidores de antes. */
  customer_id?: string | null;
  customer_name: string | null;
  requested_delivery_date: string;
  total: number;
  lines: number;
  status: string;
  /** ISO 8601. */
  scheduled_at: string | null;
  warehouse_name: string | null;
  started: PresalePickPerson | null;
  finished: (PresalePickPerson & { outcome: 'completo' | 'con_faltantes' }) | null;
  report: PresalePickReport | null;
  /** `[MCP.10.1]` La revisión en caja (cómo quedó cada producto y el total final); `null` = sin revisar. */
  review?: PresaleReviewResult | null;
  reviewed?: PresalePickPerson | null;
  charge: PresaleSellerCharge | null;
  /** ISO 8601 de la entrega de conformidad, o `null`. */
  delivered_at: string | null;
  /** El reporte de surtido todavía no lo ha visto la vendedora. */
  report_unseen: boolean;
  /** `[MCP.18]` Por qué cambió el pedido (quién, cuándo, motivo). Ausente = servidor anterior. */
  justifications?: OrderJustification[];
}

export interface PresaleSellerStatusResponse {
  today: string;
  data: PresaleSellerOrder[];
  unseen_reports: number;
  /**
   * `[MCP.20]` Con `?date=YYYY-MM-DD`: el día pedido, y `data` = los pedidos que la vendedora
   * LEVANTÓ ese día (fecha de captura en México, el mismo universo que el recuento del día).
   * Sin `date` (apps de antes): ausente, y `data` = los agendados de cualquier día + los recientes.
   */
  date?: string;
  /** `[MCP.20]` Días (`YYYY-MM-DD`, de captura) con un reporte de surtido que la vendedora no ha visto. */
  unseen_days?: string[];
}
