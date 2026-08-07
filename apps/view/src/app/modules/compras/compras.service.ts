import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** Fase RA (ADR-030) — cliente del proyecto Compras: existencia crítica + requisiciones. */

export type TargetBasis = 'min' | 'reorder' | 'max';
/** Base del pedido en el cockpit (incluye 'cadence', que criticalStock soporta pero la requisición no persiste). */
export type OrderBasis = 'cadence' | 'reorder' | 'max' | 'min';
export type Bucket = 'agotado' | 'bajo_minimo' | 'bajo_reorden' | 'sano' | 'sobrestock';
export type ReorderSource = 'kepler' | 'computed' | 'manual';
export type RequisitionEstado = 'draft' | 'pending_approval' | 'approved' | 'ordered' | 'received' | 'cancelled';
export type SourceType = 'supplier' | 'branch';

export interface CriticalStockRow {
  product_id: string;
  warehouse_id: string;
  warehouse_code: string;
  sku: string;
  nombre: string;
  on_hand: number;
  in_transit: number;
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  source: ReorderSource;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_min_boxes: number | null;  // RA.13a — pedido mínimo del proveedor en cajas
  supplier_min_amount: number | null; // RA-PRO.10 — pedido mínimo del proveedor en $
  factor_purchase: number | null;     // ⚠ roto (todo 1/null) — NO usar para cajas
  factor_sale: number | null;         // piezas/caja REAL (usar este); ver reference_box_factor_factor_sale
  box_size: number | null;            // Pz/Cja de la etiquetera CJA; MANDA si box_size=factor_sale×pack_size
  pack_size: number | null;           // RA-PRO.30 — Pz/Paq; prueba de consistencia de la etiqueta
  abc_class: string | null;
  // RA-PRO.1/2 — política profesional (safety stock por nivel de servicio + XYZ)
  xyz_class: string | null;          // X estable · Y variable · Z errático
  safety_stock: number | null;
  service_level: number | null;      // 0..1
  demand_cv: number | null;          // coeficiente de variación de demanda
  policy_method: string | null;      // 'service_level' | 'days_cover'
  lead_time_days: number | null;
  avg_daily_units: number | null;
  sales_rank: number | null;         // ranking de ventas en la sucursal (#1 = el que más vende)
  monthly_revenue: number | null;    // venta mensual estimada ($) = demanda × 30 × precio
  unit_cost: number | null;
  bucket: Bucket;
  suggested_qty: number;
  suggested_cost: number;
  // RA-PRO.16 — redistribución (cruce de red): traspaso vs compra real.
  surplus_here?: number;      // sobrante en ESTE almacén (existencia − máximo) → traspasar a otra
  surplus_network?: number;   // sobrante del producto en OTRAS sucursales (disponible para traspaso)
  transfer_in?: number;       // del sugerido, cuánto se cubre con traspaso (min(sugerido, sobrante_red))
  buy_qty?: number;           // compra REAL (sugerido − traspaso)
  buy_cost?: number;          // $ de la compra real
  accion?: 'sobrante' | 'traspaso' | 'traspaso_parcial' | 'comprar' | 'ok';
  // RA-PRO.9 — contexto de canal/ciclo (cómo se surte y cuándo toca)
  replenish_via?: 'purchase' | 'transfer' | null;
  cadence_days?: number | null;
  next_due_date?: string | null;
  cadence_band?: 'rapida' | 'promedio' | 'mal_abasto' | null;
  source_warehouse_code?: string | null;
  caja_factor?: number; // divisor por-almacén usado para mostrar en cajas (Wincaja=factor_venta, resto=c84)
}
// RA-PRO.17 — Compra sugerida anclada en el ritmo de compra REAL (entrada X-A-40).
export interface PurchaseSuggestionRow {
  product_id: string; warehouse_id: string; warehouse_code: string;
  sku: string; nombre: string; supplier_id: string | null; supplier_name: string | null;
  uxc: number; daily_rate: number; order_days: number; last_purchase: string | null;
  on_hand_pieces: number; on_hand_units: number; in_transit_units: number;
  unit_cost: number; target_units: number; suggested_units: number; suggested_pieces: number;
  base_units?: number;   // RA-PRO.27 — necesidad neta ANTES de inflar por fill rate
  fill_rate?: number;    // RA-PRO.27 — surtido histórico del proveedor (0..1); <1 infla el sugerido
  fill_source?: string;  // RA-PRO.27 — override | sku | supplier | default
  // RA-PRO.28 — verificación de unidad de venta
  stock_unit_factor?: number; // SUF: sub-unidades de demanda por unidad de stock (>1 = granel corregido)
  price_ratio?: number;       // ratio mayoreo $/u ÷ retail $/u (señal de unidad)
  unit_source?: string;       // manual | granel | revisar | catalog
  coverage_days_eff?: number; // RA-PRO.27 — cobertura aplicada (override del proveedor o global)
  coverage_source?: string;   // RA-PRO.27 — manual | auto | global
  safety_pct_eff?: number;    // RA-PRO.27 — colchón % aplicado
  safety_source?: string;     // RA-PRO.27 — manual | auto | none
  suggested_cost: number; days_cover: number | null;
  sell_daily_cajas: number; sell_month_cajas: number; // venta de la red (30d): la señal del reorden
  sell_month_mxn: number; // RA-PRO.18 — venta 30d en $
  sales_rank: number | null; // RA-PRO.18 — ranking por venta $ (red)
  abc_class: string | null;  // RA-PRO.18 — ABC de red (Pareto por venta $)
  bucket: string; // agotado | critico | bajo | sano | sobrestock (por cobertura)
}
export interface PurchaseSuggestionResponse {
  total: number; needed?: number; total_valor: number; total_revenue?: number; page: number; pageSize: number; coverage_days: number;
  rows: PurchaseSuggestionRow[];
}
export interface PurchaseSuggestionQuery {
  warehouse_id?: string; warehouse_ids?: string[]; supplier_id?: string; category_id?: string;
  search?: string; coverage_days?: number; bucket?: string; scope?: string; page?: number; pageSize?: number;
}

// RA-PRO.20 — traspaso preciso CEDIS→sucursal
export interface TransferSuggestionRow {
  product_id: string; sku: string; nombre: string;
  to_warehouse_id: string; to_code: string; to_name: string;
  from_warehouse_id: string; from_code: string;
  supplier_name: string | null; uxc: number;
  deficit_pieces: number; deficit_cajas: number;
  transfer_pieces: number; transfer_cajas: number; shortfall_pieces: number;
  unit_cost: number; transfer_value: number;
}
export interface TransferSuggestionResponse {
  total: number; total_valor: number; total_cajas: number; page: number; pageSize: number; coverage_days: number;
  rows: TransferSuggestionRow[];
}
export interface TransferSuggestionQuery {
  warehouse_id?: string; supplier_id?: string; category_id?: string; search?: string; coverage_days?: number; page?: number; pageSize?: number;
}

// RA-PRO.19 — sobrestock / capital inmovilizado
export interface OverstockRow {
  product_id: string; sku: string; nombre: string;
  warehouse_id: string; warehouse_code: string; warehouse_name: string; is_hub: boolean;
  supplier_name: string | null; uxc: number;
  on_hand_pieces: number; on_hand_cajas: number;
  surplus_cajas: number; surplus_pieces: number; days_on_hand: number | null;
  unit_cost: number; immobilized_value: number;
}
export interface OverstockResponse {
  total: number; total_valor: number; total_cajas: number; page: number; pageSize: number; over_days: number;
  rows: OverstockRow[];
}
export interface OverstockQuery {
  warehouse_id?: string; supplier_id?: string; category_id?: string; search?: string; over_days?: number; page?: number; pageSize?: number;
}

// RA-PRO.32 — réplica del workbook del comprador (una fila por SKU, columnas por PUNTO DE COMPRA
// dinámico: la raíz de abasto resuelta por topología, sin hardcodear códigos de almacén).
export interface WorkbookTerritory { code: string; name: string; }
export interface WorkbookCell { vta: number; exis: number; ped: number; }
export interface WorkbookRow {
  product_id: string; sku: string; nombre: string; supplier_name: string | null;
  uxc: number; caja_cost: number;
  box_size: number | null;         // Pz/Caja (etiqueta) — normalmente = uxc
  pack_size: number | null;        // Pz/Paquete (solo multipacks)
  packs_per_box: number | null;    // box_size ÷ pack_size (solo si divide exacto)
  cells: Record<string, WorkbookCell>;   // keyed por código de territorio (raíz)
  xyz_class: string | null;        // clase XYZ de red (peor-caso entre sucursales)
  reorder_cajas: number | null;    // punto de reorden de red, en cajas
  max_cajas: number | null;        // máximo de red, en cajas
  suma_pedido_cajas: number; pedido_valor: number;
  valor_venta: number; valor_exis: number;
  // RA-PRO.36 — Índice de Aceleración de Demanda (señal −2..+2, por SKU)
  iad: number | null;
  iad_band: string | null;         // accel_extra|accel|accel_leve|estable|desacel_leve|desacel|desacel_extra
  iad_status: string | null;       // ok|insufficient_history|insufficient_sales|no_prior
  iad_z_short: number | null;      // Welch-Z 30v30 (tooltip)
  iad_z_seasonal: number | null;   // Welch-Z YoY (tooltip)
  iad_has_seasonal: boolean | null;
}
export interface WorkbookResponse {
  total: number; page: number; pageSize: number; coverage_days: number;
  territories: WorkbookTerritory[];       // puntos de compra presentes → columnas dinámicas
  totals: { pedido: number; venta: number; exis: number };
  rows: WorkbookRow[];
}
export interface WorkbookQuery {
  supplier_id?: string; category_id?: string; search?: string; coverage_days?: number; scope?: string;
  warehouse_ids?: string[]; group?: 'branch' | 'general'; page?: number; pageSize?: number;
  iad?: 'accel' | 'decel'; only_overstock?: boolean;   // RA-PRO.36.2 filtros server-side
}
// RA-PRO.32 — detalle drill-down de un SKU (desglose por almacén de los 4 puntos de compra).
export interface WorkbookDetailWarehouse {
  warehouse_id: string; warehouse_code: string; warehouse_name: string; territory: string | null;
  supplier_id: string | null; unit_cost: number;
  venta_cajas: number; existencia_cajas: number; transito_cajas: number; pedido_cajas: number; cover_days: number | null;
}
export interface WorkbookDetailProduct {
  sku: string; nombre: string; supplier_name: string | null;
  uxc: number; caja_cost: number; price_ratio: number | null; unit_source: string;
  buy_rate: number | null; last_purchase: string | null; order_days: number | null;
}
export interface WorkbookDetailResponse {
  product: WorkbookDetailProduct | null; coverage_days: number; rows: WorkbookDetailWarehouse[];
}

export interface CriticalStockResponse {
  total: number;
  page: number;
  pageSize: number;
  target_basis: TargetBasis;
  rows: CriticalStockRow[];
}
export interface DeadStockRow {
  product_id: string;
  warehouse_id: string;
  warehouse_code: string;
  sku: string;
  nombre: string;
  on_hand: number;           // 0 = descontinuado / nunca surtido en este almacén
  unit_cost: number;
  dead_value: number;        // existencia × costo = capital inmovilizado (0 si sin stock)
  last_activity: string | null; // última venta/movimiento en el almacén; null = nunca
  created_at: string;        // alta en catálogo (fallback del "desde cuándo")
  supplier_name: string | null;
}
export interface DeadStockResponse {
  total: number;
  page: number;
  pageSize: number;
  total_value: number;       // capital inmovilizado total (con los filtros activos)
  rows: DeadStockRow[];
}
export interface ReplenishmentSummary {
  agotado: number;
  bajo_minimo: number;
  bajo_reorden: number;
  sobrestock: number;
  total_policies: number;
  sugerido_costo: number | null;
  // RA-PRO.15 — VALOR del punto de abasto (Σ umbral × costo/caja) + existencia, según el filtro.
  min_valor: number | null;
  reorden_valor: number | null;
  max_valor: number | null;
  existencia_valor: number | null;
  min_cajas: number | null;
  reorden_cajas: number | null;
  max_cajas: number | null;
  existencia_cajas: number | null;
  // RA-PRO.16 — del sugerido: cuánto se cubre por traspaso (sobrante de red) vs compra real.
  traspasable_valor: number | null;
  compra_real_valor: number | null;
}
export interface ReplenishmentCategory { id: string; code: string | null; name: string; n_suppliers: number; n_products: number; }
export interface CategoryAdmin extends ReplenishmentCategory { is_duplicate: boolean; }
export interface ReplenishmentFilters {
  warehouses: { id: string; code: string; name: string }[];
  suppliers: { id: string; name: string; min_order_boxes: number | null }[];
  categories?: ReplenishmentCategory[]; // RA-PRO.12 — categorías de compra (sourcing)
}
export interface CriticalStockQuery {
  warehouse_id?: string;
  warehouse_ids?: string[]; // RA.12 — multi-sucursal
  supplier_id?: string;
  category_id?: string; // RA-PRO.12 — categoría de compra (sourcing)
  abc?: string;
  xyz?: string; // RA-PRO.2
  bucket?: string;
  source?: string;
  search?: string;
  target_basis?: string;
  scope?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface RequisitionRow {
  id: string;
  folio: string;
  estado: RequisitionEstado;
  target_basis: TargetBasis;
  total_lines: number;
  total_units: number;
  total_cost: number;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  supplier_name: string | null;
}
export interface RequisitionLine {
  id: string;
  product_id: string;
  sku: string;
  nombre: string;
  supplier_name: string | null;
  source_type: SourceType;
  source_warehouse_id: string | null;
  on_hand: number;
  in_transit: number;
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  suggested_qty: number;
  final_qty: number;
  received_qty: number | null;
  unit_cost: number;
  line_cost: number;
}
export interface RequisitionDetail extends RequisitionRow {
  lines: RequisitionLine[];
  purchase_order_id: string | null;   // RA.15 — OC generada desde esta requisición
  purchase_order_folio: string | null;
}
export interface CreateRequisitionLine {
  product_id: string;
  supplier_id?: string | null;
  source_type?: SourceType;
  source_warehouse_id?: string | null;
  on_hand?: number;
  in_transit?: number;
  min_stock?: number;
  reorder_point?: number;
  max_stock?: number;
  suggested_qty?: number;
  final_qty: number;
  unit_cost?: number;
}
export interface CreateRequisitionDto {
  warehouse_id: string;
  supplier_id?: string | null;
  source_type?: SourceType;
  source_warehouse_id?: string | null;
  target_basis?: TargetBasis;
  notes?: string;
  lines: CreateRequisitionLine[];
}
export interface ReceiveLine { line_id: string; received_qty: number; }

export interface NetworkNode {
  id: string;
  code: string;
  name: string;
  source_warehouse_id: string | null;
  source_code: string | null;
  is_cedis: boolean;
  // RA-PRO.25 — cadencia real de surtido del CEDIS (Wincaja Irapuato)
  supply_cadence_days: number | null;
  supply_shipments: number | null;
  supply_last: string | null;
  supply_avg_value: number | null;
}

export interface SupplierParam {
  id: string;
  name: string;
  lead_time_days: number | null;
  min_order_boxes: number | null;
  cadence_days_override: number | null; // RA-PRO.10 — ciclo de pedido manual (días)
  colchon_days: number | null;          // RA-PRO.10 — colchón en días de demanda
  min_order_amount: number | null;      // RA-PRO.10 — mínimo de compra en $
  fill_rate_override: number | null;    // RA-PRO.27 — fill rate manual (0..1) que gana sobre el histórico
  safety_pct: number | null;            // RA-PRO.27 — colchón adicional % sobre el sugerido
  coverage_days_override: number | null; // RA-PRO.27 — días de cobertura propios del proveedor
  product_count: number;
  // RA-PRO.27.2 — ANÁLISIS AUTOMÁTICO (valor vigente cuando no hay override manual)
  auto_coverage_days?: number | null;  // cadencia real de compra + lead time
  auto_safety_pct?: number | null;     // colchón por variabilidad de demanda
  fill_rate_auto?: number | null;      // fill rate por historia de recepciones (0..1)
  fill_receptions?: number;            // # recepciones en la ventana (confianza del dato)
  fill_pct?: number | null; // UI-only: fill_rate_override expresado en % (0..100)
}
export interface SupplierOrderParamsDto {
  cadence_days_override?: number | null;
  colchon_days?: number | null;
  min_order_amount?: number | null;
  min_order_boxes?: number | null;
  fill_rate_override?: number | null;   // RA-PRO.27
  safety_pct?: number | null;           // RA-PRO.27
  coverage_days_override?: number | null; // RA-PRO.27
}
// RA-PRO.27 — parámetros globales del pedido (fill rate + cobertura) por tenant.
export interface ReplenishmentSettings {
  fill_window_days: number;
  fill_min_lines: number;
  fill_max_inflate: number;
  default_coverage_days: number;
}
export interface SupplierOrderLine {
  warehouse_code: string; warehouse_id: string; product_id: string; sku: string; nombre: string;
  on_hand: number; avg_daily: number; uxc: number; unit_cost: number;
  suggested: number; final: number; cajas: number; piezas: number; line_cost: number;
}
export interface SupplierOrder {
  supplier: { id: string; name: string; cadence_days_override: number | null; colchon_days: number | null; min_order_boxes: number | null; min_order_amount: number | null };
  padded: boolean; // se subió al mínimo
  totals: { cajas: number; amount: number; lines: number; suggested_cajas: number; suggested_amount: number };
  lines: SupplierOrderLine[];
}

// ── RA.15 (ADR-031) — Orden de Compra (OC) + Orden de Entrada (OE) ──────
export type PurchaseOrderEstado = 'open' | 'partial' | 'received' | 'cancelled';
export interface PurchaseOrderRow {
  id: string;
  folio: string;
  estado: PurchaseOrderEstado;
  source_type: SourceType;
  expected_date: string | null;
  total_lines: number;
  total_units: number;
  received_units: number;
  total_cost: number;
  created_at: string;
  closed_at: string | null;
  warehouse_code: string | null;
  supplier_name: string | null;
  source_code: string | null;
}
export interface PurchaseOrderLine {
  id: string;
  product_id: string;
  sku: string;
  nombre: string;
  ordered_qty: number;
  received_qty: number;
  unit_cost: number;
  line_cost: number;
}
export interface PurchaseOrderReceipt {
  id: string;
  folio: string;
  total_units: number;
  total_cost: number;
  stock_applied: boolean;
  received_at: string;
  notes: string | null;
}
export interface PurchaseOrderDetail extends PurchaseOrderRow {
  warehouse_name: string | null;
  source_warehouse_id: string | null;
  requisition_id: string | null;
  requisition_folio: string | null;
  notes: string | null;
  lines: PurchaseOrderLine[];
  receipts: PurchaseOrderReceipt[];
}
export interface CreateReceiptLine { po_line_id: string; received_qty: number; unit_cost?: number; }

export type FindingKind = 'agotado_abc' | 'bajo_reorden' | 'cadencia_lenta';
export type FindingSeverity = 'critica' | 'alta' | 'media';
export interface ReplenishmentFinding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  status: 'open' | 'resolved';
  abc_class: string | null;
  on_hand: number;
  reorder_point: number;
  in_transit: number;
  suggested_qty: number;
  suggested_cost: number;
  first_seen_at: string;
  last_seen_at: string;
  sku: string;
  nombre: string;
  warehouse_code: string | null;
  supplier_name: string | null;
}

// ── RA-PRO.8 — Worklist "Qué toca" (ciclos de reabasto) ────────────────
export type ReplenishVia = 'purchase' | 'transfer';
export type CadenceBand = 'rapida' | 'promedio' | 'mal_abasto';
export interface WorklistRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string | null;
  supplier_id: string;
  supplier_name: string | null;
  via: ReplenishVia;
  source_warehouse_id: string | null;
  source_warehouse_code: string | null; // hub que surte (si via=transfer)
  cadence_days: number | null;
  health_band: CadenceBand | null;
  last_delivery_date: string | null;
  next_due_date: string | null;
  days_to_due: number | null;            // <0 vencido · 0 hoy · >0 futuro
  lead_time_days: number | null;
  n_skus: number;
  n_below: number;                       // SKUs ≤ punto de reorden
  suggested_qty: number;                 // piezas (horizonte = cadencia+lead+colchón)
  suggested_cost: number;
}
export interface WorklistResponse {
  total: number; vencidos: number; hoy: number; prox7: number;
  page: number; pageSize: number; rows: WorklistRow[];
}
export interface WorklistQuery {
  warehouse_ids?: string[]; warehouse_id?: string; via?: string; status?: string; search?: string; target_basis?: string; category_id?: string; page?: number; pageSize?: number;
}

// ── RA-PRO — Histórico de compras al proveedor (tamaño típico de orden) ──
export interface OrderHistoryEntry { date: string; amount: number; pz: number; skus: number; }
export interface SupplierOrderHistory {
  supplier_id: string;
  warehouse_id: string | null;
  n_orders: number;
  last: OrderHistoryEntry | null;
  median_amount: number;
  typical_amount: number;   // promedio de las órdenes "reales" (≥ mediana), sin migajas de fill-in
  max_amount: number;
  since: string | null;
  until: string | null;
  recent: OrderHistoryEntry[];
}

// ── Export XLSX de un PEDIDO (cockpit/consolidado) ─────────────────────
/** Línea de un pedido exportable. Campos opcionales: el backend incluye la columna solo si
 * alguna línea la trae (así el cockpit sale rico y la requisición/OC salen limpias). */
export interface PedidoExportLine {
  warehouse_code?: string | null;
  supplier_name?: string | null;
  sku?: string | null;
  nombre?: string | null;
  abc_class?: string | null;
  xyz_class?: string | null;
  sales_rank?: number | null;
  monthly_revenue?: number | null;
  sell_daily?: number | null;
  days_cover?: number | null;
  deficit?: number | null;
  on_hand?: number | null;
  in_transit?: number | null;
  hub_on_hand?: number | null;
  reorder_point?: number | null;
  max_stock?: number | null;
  suggested_qty?: number | null;
  uxc?: number | null;
  cajas?: number | null;
  piezas?: number | null;
  received_qty?: number | null;
  unit_cost?: number | null;
  line_cost?: number | null;
  hub_short?: boolean;
}
export interface PedidoExportPayload {
  title?: string | null;
  supplier_name?: string | null;
  warehouse_label?: string | null;
  via?: 'purchase' | 'transfer' | null;
  basis?: string | null;
  source_warehouse_code?: string | null;
  folio?: string | null;
  estado?: string | null;
  multi_warehouse?: boolean;
  by_supplier?: boolean;   // una hoja por proveedor
  lines: PedidoExportLine[];
}

/** Dispara la descarga de un XLSX recibido como blob (respeta el filename del Content-Disposition). */
export function saveXlsxResponse(resp: HttpResponse<Blob>, fallback = 'reporte.xlsx'): void {
  const blob = resp.body!;
  const cd = resp.headers.get('content-disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : fallback);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ── Fase RE.10 — Ajustes de compra (X-D-40 "Devolución" / X-D-55 "Nota crédito") ──
export type AdjustmentDoctype = 'XD40' | 'XD55';
export type AdjustmentGrupo = 'comercial' | 'operacional' | 'error' | 'sin_clasificar';
export interface AdjustmentsBucket { key: string; n: number; monto: number; }
export interface AdjustmentsSummary {
  total: { n: number; monto: number };
  by_grupo: AdjustmentsBucket[];
  by_doctype: AdjustmentsBucket[];
  by_categoria: AdjustmentsBucket[];
}
export interface AdjustmentRow {
  doctype: AdjustmentDoctype; folio: string; adjustment_date: string | null;
  proveedor_code: string | null; proveedor_nombre: string | null; proveedor_rfc: string | null;
  factura_ref: string | null; entrada_folio: string | null;
  monto: number; iva: number; motivo: string | null; categoria: string | null; grupo: AdjustmentGrupo;
}
export interface AdjustmentsListResponse { total: number; page: number; pageSize: number; rows: AdjustmentRow[]; }
export interface AdjustmentsSupplierRow { proveedor_code: string | null; proveedor_nombre: string | null; n: number; monto: number; }
export interface AdjustmentsQuery {
  doctype?: string; categoria?: string; grupo?: string; search?: string;
  date_from?: string; date_to?: string; page?: number; pageSize?: number;
}
export interface DuplicateGroup {
  proveedor_code: string | null; proveedor_nombre: string | null; monto: number;
  veces: number; copias_extra: number; monto_riesgo: number;
  desde: string; hasta: string; span_dias: number; folios: string[]; sucursales: string[];
}
export interface DuplicatesResponse { window_days: number; groups: number; total_riesgo: number; rows: DuplicateGroup[]; }

/** RE.2 — ajustes (X-D-40/55) que EXPLICAN el descuadre de una entrada. */
export type AdjustmentMatch = 'exacto' | 'proveedor+fecha';
export interface AdjustmentForEntradaRow extends AdjustmentRow { match: AdjustmentMatch; }
export interface AdjustmentsForEntradaResponse { rows: AdjustmentForEntradaRow[]; total_monto: number; }

/** RE.10 — reconciliación de los 2 canales de descuento de proveedor (pago c84 vs nota X-D-55). */
export type DiscountCanal = 'pago' | 'nota' | 'ambos';
export interface DiscountReconRow {
  proveedor_code: string | null; proveedor_nombre: string | null;
  desc_pago: number; desc_nota: number; total_desc: number; compras: number;
  pct_vs_compras: number | null; canal: DiscountCanal; n_pagos_desc: number; n_notas: number;
}
export interface DiscountReconResponse {
  summary: { total_desc_pago: number; total_desc_nota: number; total_desc: number; suppliers: number; suppliers_ambos: number };
  rows: DiscountReconRow[];
}
/** RE.10 — "descuento no capturado" (pronto pago dejado en la mesa). */
export interface DiscountLeakageRow {
  proveedor_code: string | null; proveedor_nombre: string | null;
  rate: number; n_total: number; n_captured: number; n_uncaptured: number; monto_uncaptured: number; lost: number;
}
export interface DiscountLeakageResponse { summary: { total_lost: number; suppliers: number }; rows: DiscountLeakageRow[]; }

@Injectable({ providedIn: 'root' })
export class ComprasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/replenishment`;

  /** TOT-C — asistente conversacional de compras (arma requisiciones). Endpoint del motor de intelligence. */
  comprasChat(history: { role: 'user' | 'assistant'; content: string }[], think = false): Observable<{ answer: string; tools_used?: { name: string; result?: any }[]; source?: string; log_id?: string }> {
    return this.http.post<{ answer: string; tools_used?: { name: string; result?: any }[]; source?: string; log_id?: string }>(
      `${environment.apiUrl}/commercial/intelligence/compras/thot/chat`, { history, think });
  }

  criticalStock(q: CriticalStockQuery): Observable<CriticalStockResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.abc) p.set('abc', q.abc);
    if (q.xyz) p.set('xyz', q.xyz);
    if (q.bucket) p.set('bucket', q.bucket);
    if (q.source) p.set('source', q.source);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.scope) p.set('scope', q.scope);
    if (q.sort_by) p.set('sort_by', q.sort_by);
    if (q.sort_dir) p.set('sort_dir', q.sort_dir);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<CriticalStockResponse>(`${this.base}/critical-stock${qs ? '?' + qs : ''}`);
  }

  /** RA-PRO.17 — Compra sugerida anclada en el ritmo de compra REAL (entrada X-A-40). */
  purchaseSuggestion(q: PurchaseSuggestionQuery): Observable<PurchaseSuggestionResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.search) p.set('search', q.search);
    if (q.coverage_days) p.set('coverage_days', String(q.coverage_days));
    if (q.bucket) p.set('bucket', q.bucket);
    if (q.scope) p.set('scope', q.scope);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<PurchaseSuggestionResponse>(`${this.base}/purchase-suggestion${qs ? '?' + qs : ''}`);
  }

  /** RA-PRO.32 — réplica del workbook del comprador (fila por SKU, columnas por punto de compra). */
  workbook(q: WorkbookQuery): Observable<WorkbookResponse> {
    const p = new URLSearchParams();
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.search) p.set('search', q.search);
    if (q.coverage_days) p.set('coverage_days', String(q.coverage_days));
    if (q.scope) p.set('scope', q.scope);
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    if (q.group) p.set('group', q.group);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    if (q.iad) p.set('iad', q.iad);
    if (q.only_overstock) p.set('only_overstock', 'true');
    const qs = p.toString();
    return this.http.get<WorkbookResponse>(`${this.base}/workbook${qs ? '?' + qs : ''}`);
  }

  /** RA-PRO.32 — detalle drill-down de un SKU (desglose por almacén + economía). */
  workbookDetail(productId: string, coverageDays?: number): Observable<WorkbookDetailResponse> {
    const qs = coverageDays ? `?coverage_days=${coverageDays}` : '';
    return this.http.get<WorkbookDetailResponse>(`${this.base}/workbook/${productId}${qs}`);
  }

  /**
   * RA-PRO.32.5 — Workbook del comprador a XLSX con LOS MISMOS filtros que la tabla en
   * pantalla (incluye group=desglosar/englobar + iad + sobrestock). `flat=true` → una sola
   * hoja (plano); default → una hoja por proveedor. Exporta TODO sin paginar.
   */
  exportWorkbookXlsx(q: WorkbookQuery, flat = false) {
    const p = new URLSearchParams();
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.search) p.set('search', q.search);
    if (q.coverage_days) p.set('coverage_days', String(q.coverage_days));
    if (q.scope) p.set('scope', q.scope);
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    if (q.group) p.set('group', q.group);
    if (q.iad) p.set('iad', q.iad);
    if (q.only_overstock) p.set('only_overstock', 'true');
    if (flat) p.set('flat', 'true');
    const qs = p.toString();
    return this.http.get(`${this.base}/workbook.xlsx${qs ? '?' + qs : ''}`, { responseType: 'blob', observe: 'response' });
  }

  /** RA-PRO.20 — traspaso preciso CEDIS→sucursal (topología). */
  transferSuggestion(q: TransferSuggestionQuery): Observable<TransferSuggestionResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.search) p.set('search', q.search);
    if (q.coverage_days) p.set('coverage_days', String(q.coverage_days));
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<TransferSuggestionResponse>(`${this.base}/transfer-suggestion${qs ? '?' + qs : ''}`);
  }

  /** RA-PRO.19 — sobrestock (capital inmovilizado) topología-aware. */
  overstock(q: OverstockQuery): Observable<OverstockResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.search) p.set('search', q.search);
    if (q.over_days) p.set('over_days', String(q.over_days));
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<OverstockResponse>(`${this.base}/overstock${qs ? '?' + qs : ''}`);
  }

  /** Export XLSX con diseño (mismos filtros; exporta TODO el filtro, sin paginar). */
  criticalStockXlsx(q: CriticalStockQuery) {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.abc) p.set('abc', q.abc);
    if (q.xyz) p.set('xyz', q.xyz);
    if (q.bucket) p.set('bucket', q.bucket);
    if (q.source) p.set('source', q.source);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.scope) p.set('scope', q.scope);
    if (q.sort_by) p.set('sort_by', q.sort_by);
    if (q.sort_dir) p.set('sort_dir', q.sort_dir);
    const qs = p.toString();
    return this.http.get(`${this.base}/critical-stock.xlsx${qs ? '?' + qs : ''}`, {
      responseType: 'blob',
      observe: 'response',
    });
  }

  /** Export XLSX con diseño de un PEDIDO armado en el cliente (cockpit / consolidado). */
  exportPedidoXlsx(payload: PedidoExportPayload) {
    return this.http.post(`${this.base}/pedido.xlsx`, payload, { responseType: 'blob', observe: 'response' });
  }
  /** Export XLSX con diseño de una requisición ya creada (por id). */
  exportRequisitionXlsx(id: string) {
    return this.http.get(`${this.base}/requisitions/${id}/export.xlsx`, { responseType: 'blob', observe: 'response' });
  }

  deadStock(q: { warehouse_ids?: string[]; warehouse_id?: string; supplier_id?: string; search?: string; page?: number; pageSize?: number }): Observable<DeadStockResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.search) p.set('search', q.search);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<DeadStockResponse>(`${this.base}/dead-stock${qs ? '?' + qs : ''}`);
  }

  summary(q: { warehouse_id?: string; warehouse_ids?: string[]; supplier_id?: string; search?: string; category_id?: string; target_basis?: string }): Observable<ReplenishmentSummary> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.search) p.set('search', q.search);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    const qs = p.toString();
    return this.http.get<ReplenishmentSummary>(`${this.base}/critical-stock/summary${qs ? '?' + qs : ''}`);
  }

  filters(): Observable<ReplenishmentFilters> {
    return this.http.get<ReplenishmentFilters>(`${this.base}/filters`);
  }

  /** RA-PRO.12 — categorías de compra (normalización). */
  listCategories(search?: string): Observable<CategoryAdmin[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.http.get<CategoryAdmin[]>(`${this.base}/categories${qs}`);
  }
  renameCategory(id: string, name: string): Observable<{ id: string; name: string }> {
    return this.http.post<{ id: string; name: string }>(`${this.base}/categories/${id}/rename`, { name });
  }
  mergeCategories(into_id: string, from_ids: string[]): Observable<{ into: string; merged: number; products_repointed: number }> {
    return this.http.post<{ into: string; merged: number; products_repointed: number }>(`${this.base}/categories/merge`, { into_id, from_ids });
  }
  autoDedupCategories(): Observable<{ groups: number; merged: number; products_repointed: number }> {
    return this.http.post<{ groups: number; merged: number; products_repointed: number }>(`${this.base}/categories/auto-dedup`, {});
  }

  listRequisitions(q?: { estado?: string; warehouse_id?: string; page?: number; pageSize?: number }): Observable<{ total: number; page: number; pageSize: number; rows: RequisitionRow[] }> {
    const p = new URLSearchParams();
    if (q?.estado) p.set('estado', q.estado);
    if (q?.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q?.page) p.set('page', String(q.page));
    if (q?.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<{ total: number; page: number; pageSize: number; rows: RequisitionRow[] }>(`${this.base}/requisitions${qs ? '?' + qs : ''}`);
  }

  getRequisition(id: string): Observable<RequisitionDetail> {
    return this.http.get<RequisitionDetail>(`${this.base}/requisitions/${id}`);
  }
  createRequisition(dto: CreateRequisitionDto): Observable<{ id: string; folio: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; folio: string; estado: RequisitionEstado }>(`${this.base}/requisitions`, dto);
  }
  approve(id: string): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/approve`, {});
  }
  reject(id: string): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/reject`, {});
  }
  /** RA.14 — approved → ordered (OC emitida / en tránsito). */
  markOrdered(id: string): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/order`, {});
  }
  /** RA.14 — ordered → received (+ cantidades recibidas por línea). */
  markReceived(id: string, lines?: ReceiveLine[]): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/receive`, { lines });
  }
  /** RA.13a — captura del pedido mínimo del proveedor en cajas. */
  setSupplierMinBoxes(supplierId: string, boxes: number | null): Observable<{ id: string; min_order_boxes: number | null }> {
    return this.http.post<{ id: string; min_order_boxes: number | null }>(`${this.base}/suppliers/${supplierId}/min-boxes`, { boxes });
  }

  /** RA-PRO.3 — parámetros de compra por proveedor. */
  listSuppliers(search?: string): Observable<SupplierParam[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.http.get<SupplierParam[]>(`${this.base}/suppliers${qs}`);
  }
  setSupplierLeadTime(supplierId: string, days: number | null): Observable<{ id: string; lead_time_days: number | null }> {
    return this.http.post<{ id: string; lead_time_days: number | null }>(`${this.base}/suppliers/${supplierId}/lead-time`, { days });
  }
  /** RA-PRO.10/27 — parámetros de pedido (cadencia/colchón/mínimo + fill rate/colchón%/cobertura). */
  setSupplierOrderParams(supplierId: string, patch: SupplierOrderParamsDto): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/suppliers/${supplierId}/order-params`, patch);
  }
  /** RA-PRO.28 — override manual de unidad de venta (SUF/BF). Ambos null = vuelve a auto. */
  setProductUnitOverride(productId: string, patch: { pieces_per_unit?: number | null; box_factor?: number | null; sold_as?: string | null; note?: string | null }): Observable<{ product_id: string }> {
    return this.http.post<{ product_id: string }>(`${this.base}/products/${productId}/unit-override`, patch);
  }
  /** RA-PRO.27 — parámetros globales del pedido (fill rate + cobertura). */
  getReplenishmentSettings(): Observable<ReplenishmentSettings> {
    return this.http.get<ReplenishmentSettings>(`${this.base}/settings`);
  }
  updateReplenishmentSettings(patch: Partial<ReplenishmentSettings>): Observable<ReplenishmentSettings> {
    return this.http.post<ReplenishmentSettings>(`${this.base}/settings`, patch);
  }
  /** RA-PRO.10 — pedido consolidado al proveedor (cadencia+colchón, subido al mínimo). */
  supplierOrder(supplierId: string): Observable<SupplierOrder> {
    return this.http.get<SupplierOrder>(`${this.base}/suppliers/${supplierId}/order`);
  }

  /** RA-PRO.6 — topología de red de abasto (DRP CEDIS→sucursal). */
  networkTopology(): Observable<NetworkNode[]> {
    return this.http.get<NetworkNode[]>(`${this.base}/network`);
  }
  setWarehouseSource(warehouseId: string, sourceId: string | null): Observable<{ id: string; source_warehouse_id: string | null }> {
    return this.http.post<{ id: string; source_warehouse_id: string | null }>(`${this.base}/warehouses/${warehouseId}/source`, { source_warehouse_id: sourceId });
  }

  /** RA.8 — bandeja de hallazgos de reabastecimiento. */
  findings(q?: { status?: string; kind?: string; warehouse_id?: string; page?: number; pageSize?: number }): Observable<{ total: number; page: number; pageSize: number; status: string; rows: ReplenishmentFinding[] }> {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.kind) p.set('kind', q.kind);
    if (q?.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q?.page) p.set('page', String(q.page));
    if (q?.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<{ total: number; page: number; pageSize: number; status: string; rows: ReplenishmentFinding[] }>(`${this.base}/findings${qs ? '?' + qs : ''}`);
  }
  scanNow(): Observable<{ findings: number }> {
    return this.http.post<{ findings: number }>(`${this.base}/scan-now`, {});
  }

  /** RA-PRO.8 — worklist "qué toca": ciclos de reabasto por almacén×proveedor. */
  worklist(q: WorklistQuery): Observable<WorklistResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.via) p.set('via', q.via);
    if (q.status) p.set('status', q.status);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<WorklistResponse>(`${this.base}/worklist${qs ? '?' + qs : ''}`);
  }

  /** RA-PRO — histórico de compras al proveedor (tamaño típico de orden). warehouse_id opcional (el de compra; para traspasos, el hub). */
  supplierOrderHistory(supplierId: string, warehouseId?: string): Observable<SupplierOrderHistory> {
    const qs = warehouseId ? `?warehouse_id=${encodeURIComponent(warehouseId)}` : '';
    return this.http.get<SupplierOrderHistory>(`${this.base}/suppliers/${supplierId}/order-history${qs}`);
  }

  // ── RA.15 (ADR-031) — Órdenes de compra (OC) + recepción (OE) ─────────
  private readonly poBase = `${environment.apiUrl}/commercial/purchase-orders`;

  listPurchaseOrders(q?: { estado?: string; supplier_id?: string; warehouse_id?: string; page?: number; pageSize?: number }): Observable<{ total: number; page: number; pageSize: number; rows: PurchaseOrderRow[] }> {
    const p = new URLSearchParams();
    if (q?.estado) p.set('estado', q.estado);
    if (q?.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q?.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q?.page) p.set('page', String(q.page));
    if (q?.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<{ total: number; page: number; pageSize: number; rows: PurchaseOrderRow[] }>(`${this.poBase}${qs ? '?' + qs : ''}`);
  }
  getPurchaseOrder(id: string): Observable<PurchaseOrderDetail> {
    return this.http.get<PurchaseOrderDetail>(`${this.poBase}/${id}`);
  }
  /** Export XLSX con diseño de una orden de compra (por id). */
  exportPurchaseOrderXlsx(id: string) {
    return this.http.get(`${this.poBase}/${id}/export.xlsx`, { responseType: 'blob', observe: 'response' });
  }
  /** Genera la OC desde una requisición aprobada. */
  createPOFromRequisition(requisitionId: string, body?: { expected_date?: string | null; notes?: string }): Observable<{ id: string; folio: string; estado: PurchaseOrderEstado; requisition_folio: string }> {
    return this.http.post<{ id: string; folio: string; estado: PurchaseOrderEstado; requisition_folio: string }>(`${this.poBase}/from-requisition/${requisitionId}`, body ?? {});
  }
  cancelPurchaseOrder(id: string): Observable<{ id: string; estado: PurchaseOrderEstado }> {
    return this.http.post<{ id: string; estado: PurchaseOrderEstado }>(`${this.poBase}/${id}/cancel`, {});
  }
  /** OE — registra una recepción (parcial permitido); mueve stock. */
  createReceipt(poId: string, dto: { lines: CreateReceiptLine[]; notes?: string; received_at?: string | null }): Observable<{ id: string; folio: string; po_estado: PurchaseOrderEstado; total_units: number; total_cost: number; stock_applied: boolean }> {
    return this.http.post<{ id: string; folio: string; po_estado: PurchaseOrderEstado; total_units: number; total_cost: number; stock_applied: boolean }>(`${this.poBase}/${poId}/receipts`, dto);
  }

  // ── Fase RE.10 — ajustes de compra (descuentos/apoyos + facturas duplicadas) ──
  private readonly adjBase = `${environment.apiUrl}/commercial/purchase-adjustments`;
  private adjParams(q: AdjustmentsQuery): string {
    const p = new URLSearchParams();
    if (q.doctype) p.set('doctype', q.doctype);
    if (q.categoria) p.set('categoria', q.categoria);
    if (q.grupo) p.set('grupo', q.grupo);
    if (q.search) p.set('search', q.search);
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return qs ? '?' + qs : '';
  }
  adjustmentsSummary(q: AdjustmentsQuery = {}): Observable<AdjustmentsSummary> {
    return this.http.get<AdjustmentsSummary>(`${this.adjBase}/summary${this.adjParams(q)}`);
  }
  adjustments(q: AdjustmentsQuery = {}): Observable<AdjustmentsListResponse> {
    return this.http.get<AdjustmentsListResponse>(`${this.adjBase}${this.adjParams(q)}`);
  }
  adjustmentsBySupplier(q: AdjustmentsQuery = {}): Observable<AdjustmentsSupplierRow[]> {
    return this.http.get<AdjustmentsSupplierRow[]>(`${this.adjBase}/by-supplier${this.adjParams(q)}`);
  }
  /** RE.10 — posibles facturas duplicadas (mismo proveedor + monto exacto en ≤N días). */
  adjustmentsDuplicates(windowDays?: number): Observable<DuplicatesResponse> {
    const qs = windowDays ? `?window_days=${windowDays}` : '';
    return this.http.get<DuplicatesResponse>(`${this.adjBase}/duplicates${qs}`);
  }
  /**
   * RE.2 — ajustes (X-D-40/55) que EXPLICAN el descuadre de una entrada: por
   * `entrada_folio` exacto cuando existe, si no por proveedor + ventana de fecha.
   */
  adjustmentsForEntrada(p: { proveedor_code?: string | null; entrada_folio?: string | null; date?: string | null; window_days?: number }): Observable<AdjustmentsForEntradaResponse> {
    const q = new URLSearchParams();
    if (p.proveedor_code) q.set('proveedor_code', p.proveedor_code);
    if (p.entrada_folio) q.set('entrada_folio', p.entrada_folio);
    if (p.date) q.set('date', p.date);
    if (p.window_days) q.set('window_days', String(p.window_days));
    const qs = q.toString();
    return this.http.get<AdjustmentsForEntradaResponse>(`${this.adjBase}/for-entrada${qs ? '?' + qs : ''}`);
  }
  /** RE.10 — reconciliación descuento pago (c84) vs nota (X-D-55) por proveedor. */
  adjustmentsDiscountReconciliation(q: { date_from?: string; date_to?: string; search?: string } = {}): Observable<DiscountReconResponse> {
    const p = new URLSearchParams();
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    if (q.search) p.set('search', q.search);
    const qs = p.toString();
    return this.http.get<DiscountReconResponse>(`${this.adjBase}/discount-reconciliation${qs ? '?' + qs : ''}`);
  }
  /** RE.10 — descuento no capturado (pronto pago perdido) por proveedor. */
  adjustmentsDiscountLeakage(search?: string): Observable<DiscountLeakageResponse> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.http.get<DiscountLeakageResponse>(`${this.adjBase}/discount-leakage${qs}`);
  }

  /** CXP.4 — Costo neto (landed cost) por proveedor: compras − descuento efectivo. */
  landedCost(q: { min_compras?: number; search?: string; date_from?: string; date_to?: string; only_anomalo?: boolean } = {}): Observable<LandedCostResponse> {
    const p = new URLSearchParams();
    if (q.min_compras) p.set('min_compras', String(q.min_compras));
    if (q.search) p.set('search', q.search);
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    if (q.only_anomalo) p.set('only_anomalo', '1');
    const qs = p.toString();
    return this.http.get<LandedCostResponse>(`${this.adjBase}/landed-cost${qs ? '?' + qs : ''}`);
  }

  /** CXP.3 — "Compras 360" (el Excel): recepciones/facturas + OC + ajuste ligado exacto + neto. */
  compras360(q: Compras360Query = {}): Observable<Compras360Response> {
    const p = new URLSearchParams();
    if (q.search) p.set('search', q.search);
    if (q.sucursal) p.set('sucursal', q.sucursal);
    if (q.proveedor_code) p.set('proveedor_code', q.proveedor_code);
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    if (q.ajuste) p.set('ajuste', q.ajuste);
    if (q.con_oc) p.set('con_oc', q.con_oc);
    if (q.monto_min != null) p.set('monto_min', String(q.monto_min));
    if (q.monto_max != null) p.set('monto_max', String(q.monto_max));
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    if (q.all) p.set('all', '1');
    const qs = p.toString();
    return this.http.get<Compras360Response>(`${this.adjBase}/compras-360${qs ? '?' + qs : ''}`);
  }

  /** CXP.3 — catálogo de filtros de Compras 360 (sucursales con conteo + monto máximo). */
  compras360Filters(): Observable<Compras360Filters> {
    return this.http.get<Compras360Filters>(`${this.adjBase}/compras-360/filters`);
  }

  /** CXP.6 — póliza contable (Kepler) de una recepción/factura: ¿cuadra? + patas. */
  polizaForReceipt(q: { sucursal: string; folio: string; tipo_pol?: string }): Observable<PolizaForReceipt> {
    const p = new URLSearchParams();
    p.set('sucursal', q.sucursal); p.set('folio', q.folio);
    if (q.tipo_pol) p.set('tipo_pol', q.tipo_pol);
    return this.http.get<PolizaForReceipt>(`${this.adjBase}/poliza-for-receipt?${p.toString()}`);
  }

  /** CXP.7 — cuadre contable por proveedor (estado de cuenta 201 de Kepler). */
  supplierLedger(q: { date_from?: string; date_to?: string; search?: string } = {}): Observable<SupplierLedgerResponse> {
    const p = new URLSearchParams();
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    if (q.search) p.set('search', q.search);
    const qs = p.toString();
    return this.http.get<SupplierLedgerResponse>(`${this.adjBase}/supplier-ledger${qs ? '?' + qs : ''}`);
  }

  /** CXP.7 — desglose (auxiliar 201) de un proveedor: movimientos con folio/fecha/importe/saldo. */
  supplierLedgerDetail(q: { proveedor?: string; date_from?: string; date_to?: string }): Observable<SupplierLedgerDetailResponse> {
    const p = new URLSearchParams();
    if (q.proveedor) p.set('proveedor', q.proveedor);
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    const qs = p.toString();
    return this.http.get<SupplierLedgerDetailResponse>(`${this.adjBase}/supplier-ledger/detail${qs ? '?' + qs : ''}`);
  }

  /** CXP.8 — cuadre POR FACTURA de un proveedor: entradas reales con estado de pago FIFO + cross-check vs 201. */
  supplierInvoiceLedger(q: { proveedor_code?: string; proveedor?: string }): Observable<SupplierInvoiceLedgerResponse> {
    const p = new URLSearchParams();
    if (q.proveedor_code) p.set('proveedor_code', q.proveedor_code);
    if (q.proveedor) p.set('proveedor', q.proveedor);
    const qs = p.toString();
    return this.http.get<SupplierInvoiceLedgerResponse>(`${this.adjBase}/supplier-invoice-ledger${qs ? '?' + qs : ''}`);
  }

  /** CXP.9 — tercera lente: FISCAL (ContPAQi) — proveedor en los 3 libros + evolución mensual ContPAQi. */
  supplierFiscalLedger(q: { proveedor?: string }): Observable<SupplierFiscalLedgerResponse> {
    const p = new URLSearchParams();
    if (q.proveedor) p.set('proveedor', q.proveedor);
    const qs = p.toString();
    return this.http.get<SupplierFiscalLedgerResponse>(`${this.adjBase}/supplier-fiscal-ledger${qs ? '?' + qs : ''}`);
  }

  /** CXP.10 — "Lo que se debe" a proveedores según ContPAQi (saldo real de la 2120, balanza). */
  contpaqiPayables(q: { search?: string; only_stale?: boolean } = {}): Observable<ContpaqiPayablesResponse> {
    const p = new URLSearchParams();
    if (q.search) p.set('search', q.search);
    if (q.only_stale) p.set('only_stale', '1');
    const qs = p.toString();
    return this.http.get<ContpaqiPayablesResponse>(`${this.adjBase}/contpaqi-payables${qs ? '?' + qs : ''}`);
  }
}

export interface SupplierLedgerMove { fecha: string | null; anio_mes: string; tipo_pol: string; tipo_label: string; folio: string; sucursal: string; cargo_abono: 'C' | 'A'; importe: number; signed: number; saldo: number; categoria: string; concepto: string | null }
export interface SupplierLedgerDetailResponse { proveedor: string | null; total: number; saldo_final: number; rows: SupplierLedgerMove[] }

export interface SupplierLedgerRow { proveedor: string | null; facturado: number; pagado: number; notas: number; devoluciones: number; otros: number; delta: number; n: number }
export interface SupplierLedgerResponse { source: string; total: number; totals: { facturado: number; pagado: number; notas: number; devoluciones: number; otros: number; delta: number }; rows: SupplierLedgerRow[] }

export type InvoiceEstado = 'pagada' | 'parcial' | 'pendiente';
export interface SupplierInvoiceRow { folio: string; sucursal: string; oc_folio: string | null; concepto: string | null; fecha: string | null; bruto: number; ajuste: number; neto: number; pagado: number; pendiente: number; estado: InvoiceEstado }
export interface SupplierInvoiceTotals {
  facturado: number; pagado: number; saldo: number; anticipo: number;
  n_facturas: number; n_pagadas: number; n_parciales: number; n_pendientes: number; pendiente_total: number; n_pagos: number;
  contable: { facturado: number; pagado: number; saldo: number } | null;
}
export interface SupplierInvoiceLedgerResponse { found: boolean; proveedor_code: string | null; proveedor_nombre: string | null; totals: SupplierInvoiceTotals | null; rows: SupplierInvoiceRow[] }

export interface FiscalBook { facturado: number; pagado: number; saldo: number }
export interface FiscalContpaqi extends FiscalBook { matched: boolean; cuentas: string[]; cuenta_nombre: string | null; saldo_ini: number; ejercicio: number | null; n: number }
export interface FiscalMonth { anio_mes: string; abonos: number; cargos: number; saldo: number }
export interface SupplierFiscalLedgerResponse { proveedor: string | null; contpaqi: FiscalContpaqi; operativo: (FiscalBook & { proveedor_code: string }) | null; contable: FiscalBook | null; rows: FiscalMonth[] }

export interface ContpaqiPayableRow { cuenta: string; proveedor: string | null; proveedor_kepler: string | null; saldo: number; hasta: string; stale: boolean }
export interface ContpaqiPayablesResponse { as_of: string; total_debe: number; total_favor: number; neto: number; n: number; n_stale: number; rows: ContpaqiPayableRow[] }

export interface PolizaHeader { ejercicio: number; periodo: number; anio_mes: string; fecha: string | null; concepto: string | null; cargos: number; abonos: number; neto: number; num_lines: number }
export interface PolizaLine { ejercicio: number; periodo: number; num_movto: number; cuenta: string; cuenta_nombre: string | null; cuenta_afectable: boolean | null; cargo_abono: 'C' | 'A'; importe: number }
export interface PolizaForReceipt { found: boolean; cuadra: boolean; polizas: PolizaHeader[]; lines: PolizaLine[] }

export interface LandedCostRow { proveedor_code: string | null; proveedor_nombre: string | null; compras: number; desc_pago: number; desc_nota: number; descuento: number; rate: number; costo_neto: number; anomalo: boolean }
export interface LandedCostResponse { summary: { compras: number; descuento: number; costo_neto: number; rate: number; suppliers: number }; rows: LandedCostRow[] }

export type Compras360AjusteMode = 'con' | 'sin';
export type Compras360OcMode = 'con' | 'sin';
export interface Compras360Query { search?: string; sucursal?: string; proveedor_code?: string; date_from?: string; date_to?: string; ajuste?: Compras360AjusteMode; con_oc?: Compras360OcMode; monto_min?: number; monto_max?: number; page?: number; pageSize?: number; all?: boolean }
export interface Compras360Row { sucursal: string; folio: string; receipt_date: string; proveedor_code: string; proveedor_nombre: string; oc_folio: string | null; vale_folio: string | null; factura: number; ajuste: number; n_ajuste: number; neto: number }
export interface Compras360Response { total: number; page: number; pageSize: number; totals: { factura: number; ajuste: number; neto: number }; rows: Compras360Row[] }
export interface Compras360Filters { sucursales: { code: string; n: number }[]; proveedores: { code: string; nombre: string | null; n: number }[]; monto_max: number }
