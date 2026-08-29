import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';

export type MarginWindow = '30d' | '90d' | '365d';
export type MarginLevel = 'supplier' | 'brand' | 'category' | 'sku' | 'warehouse' | 'channel';
export type MarginBand = 'negativo' | 'critico' | 'bajo' | 'meta' | 'alto';

export interface MarginBandRow {
  key: MarginBand;
  label: string;
  tone: 'bad' | 'warn' | 'ok';
  skus: number;
  revenue: number;
  margin_amount: number;
}

export interface MarginLever {
  key: string;
  label: string;
  owner: string;
  source: string;
  /** Lo negociado en bruto, ganado sobre COMPRAS. */
  amount: number;
  docs: number;
  /** Tasa sobre compras: lo comparable entre proveedores. */
  rate: number | null;
  /** La parte de eso que ya se convirtio en margen (lo vendido). */
  margin_effect: number;
  pp: number | null;
}

export interface NonMarginBlock {
  amount: number;
  docs: number;
  note: string;
}

export interface ProfitabilityOverview {
  window: MarginWindow;
  target: number;
  /** Hasta qué día llega el fact de venta. */
  data_as_of: string | null;
  /** La venta que trae costo: el denominador del margen. */
  revenue: number;
  cost: number;
  margin_amount: number;
  margin_pct: number | null;
  /** Margen tras incorporar las palancas negociadas con el proveedor. */
  margin_negotiated_amount: number;
  margin_negotiated_pct: number | null;
  gap_pp: number | null;
  gap_amount: number | null;
  /** Brecha que queda DESPUÉS de las palancas: lo que de verdad falta resolver. */
  gap_pp_negotiated: number | null;
  units: number;
  skus: number;
  inventory_value: number;
  inventory_days: number | null;
  /** Partido para que el KPI cuadre con la suma de la tabla. */
  inventory: { total: number; in_scope: number; no_sales: number; unverified: number };
  /** Costo de catálogo que contradice al del PdV: no se valúa a ciegas. */
  cost_quality: { conflict_skus: number; conflict_revenue: number; note: string };
  bands: MarginBandRow[];
  /** Base de los descuentos: lo comprado en la ventana. */
  purchases: number;
  levers: MarginLever[];
  /** La fuente de ajustes está vacía: la cascada es ciega, no cero. */
  levers_source_empty: boolean;
  levers_amount_total: number;
  levers_margin_effect: number;
  non_margin: { operacional: NonMarginBlock; error_captura: NonMarginBlock };
  /** `benefit` crudo: la unidad NO está confirmada, no se publica como %. */
  promotions: { skus_con_promo: number; avg_benefit: number | null; benefit_unit: 'unconfirmed' };
  /** Sobre qué parte del universo se calculó el margen. El número honesto. */
  coverage: {
    revenue_with_cost: number;
    revenue_total: number;
    revenue_pct: number | null;
    channels: { channel: string; revenue: number }[];
    skus_with_cost: number;
    skus_total: number;
  };
}

export interface ProfitabilityRow {
  id: string;
  name: string;
  sku: string | null;
  brand_name: string | null;
  supplier_name: string | null;
  abc_class: string | null;
  revenue: number;
  /** La parte de la venta que trae costo: el denominador del margen. */
  revenue_costed: number;
  coverage_pct: number | null;
  cost: number;
  margin_amount: number;
  margin_pct: number | null;
  gap_pp: number | null;
  gap_amount: number | null;
  units: number;
  skus: number;
  /** Null por canal: el inventario no es de un canal, y un $0 se leería como "sin stock". */
  inventory_value: number | null;
  inventory_days: number | null;
  /** SKUs del renglón valuados con un costo que el PdV contradice. */
  cost_conflict_skus: number;
  annual_contribution: number | null;
  /** Null cuando el costo de valuación no es confiable: no se inventa. */
  gmroi: number | null;
  /** Beneficio de promoción vigente (kdpv_descuxq), CRUDO. Unidad sin confirmar. */
  promo_benefit: number | null;

  // ── Margen unitario: sólo a nivel producto, nulo en los agregados ──────────
  /** `weight` se cobra por kilo; `piece`, por la unidad en que factura el PdV. */
  unit_kind: 'piece' | 'weight' | null;
  price_unit: number | null;
  cost_unit: number | null;
  /** Lo que deja UNA unidad vendida. */
  margin_unit: number | null;
  margin_unit_pct: number | null;
  /** Sólo cuando el factor canónico es confiable (no granel dudoso). */
  box_factor: number | null;
  margin_box: number | null;
}

export interface ProfitabilityBreakdown {
  level: MarginLevel;
  window: MarginWindow;
  target: number;
  data: ProfitabilityRow[];
  totals: {
    revenue: number;
    revenue_costed: number;
    margin_amount: number;
    margin_pct: number | null;
    gap_amount: number | null;
    inventory_value: number | null;
  };
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

export interface SupplierLevers {
  supplier: { id: string; code: string; name: string; credit_days: number | null; lead_time_days: number | null };
  window: MarginWindow;
  target: number;
  revenue: number;
  skus: number;
  margin_gross_amount: number;
  margin_gross_pct: number | null;
  margin_negotiated_amount: number;
  margin_negotiated_pct: number | null;
  gap_pp: number | null;
  purchases: number;
  levers: MarginLever[];
  levers_amount_total: number;
  levers_margin_effect: number;
  non_margin: { operacional: NonMarginBlock; error_captura: NonMarginBlock };
  /** Pronto pago por nota Y por pago: puede ser el mismo descuento contado dos veces. */
  overlap_warning: boolean;
  /** La fuente de ajustes está vacía: la cascada es ciega, no cero. */
  levers_source_empty: boolean;
  promotions: {
    skus_con_promo: number;
    avg_benefit: number | null;
    max_benefit: number | null;
    benefit_unit: 'unconfirmed';
    note: string;
  };
  policy: {
    expected_discount_rate: number | null;
    discount_days: number | null;
    discount_type: string | null;
    source: string | null;
    expected_amount: number | null;
    /** Lo efectivamente cobrado, para contrastar con lo pactado. */
    taken_amount: number;
  } | null;
  not_attributed: { key: string; reason: string }[];
}

/**
 * Motor de Rentabilidad (Fase MR). La venta Y el costo salen del sell-out real
 * (`analytics.sales_daily`), no de `commercial.orders` — ver ADR-046. El costo
 * es el que registró el PdV en la transacción, en la misma unidad en que cobró:
 * `catalog.products.cost_base` viene por caja en buena parte del catálogo y
 * mezclaba unidades.
 */
@Injectable({ providedIn: 'root' })
export class ProfitabilityService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/profitability`;

  overview(opts: { window?: MarginWindow; target?: number } = {}) {
    let params = new HttpParams();
    if (opts.window) params = params.set('window', opts.window);
    if (opts.target != null) params = params.set('target', opts.target);
    return this.http.get<ProfitabilityOverview>(`${this.base}/overview`, { params });
  }

  breakdown(opts: {
    window?: MarginWindow;
    level?: MarginLevel;
    target?: number;
    search?: string;
    band?: MarginBand | null;
    supplier_id?: string | null;
    brand_id?: string | null;
    category_id?: string | null;
    warehouse_id?: string | null;
    channel?: string | null;
    page?: number;
    pageSize?: number;
    sort?: string;
    dir?: 'asc' | 'desc';
  } = {}) {
    let params = new HttpParams();
    if (opts.window) params = params.set('window', opts.window);
    if (opts.level) params = params.set('level', opts.level);
    if (opts.target != null) params = params.set('target', opts.target);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());
    if (opts.band) params = params.set('band', opts.band);
    if (opts.supplier_id) params = params.set('supplier_id', opts.supplier_id);
    if (opts.brand_id) params = params.set('brand_id', opts.brand_id);
    if (opts.category_id) params = params.set('category_id', opts.category_id);
    if (opts.warehouse_id) params = params.set('warehouse_id', opts.warehouse_id);
    if (opts.channel) params = params.set('channel', opts.channel);
    if (opts.page != null) params = params.set('page', opts.page);
    if (opts.pageSize != null) params = params.set('pageSize', opts.pageSize);
    if (opts.sort) params = params.set('sort', opts.sort).set('dir', opts.dir ?? 'desc');
    return this.http.get<ProfitabilityBreakdown>(`${this.base}/breakdown`, { params });
  }

  supplierLevers(id: string, opts: { window?: MarginWindow; target?: number } = {}) {
    let params = new HttpParams();
    if (opts.window) params = params.set('window', opts.window);
    if (opts.target != null) params = params.set('target', opts.target);
    return this.http.get<SupplierLevers>(`${this.base}/supplier/${id}/levers`, { params });
  }
}
