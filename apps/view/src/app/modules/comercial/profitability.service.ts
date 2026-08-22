import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';

export type MarginWindow = '30d' | '90d' | '365d';
export type MarginLevel = 'supplier' | 'brand' | 'category' | 'sku';
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
  bands: MarginBandRow[];
  /** Base de los descuentos: lo comprado en la ventana. */
  purchases: number;
  levers: MarginLever[];
  levers_amount_total: number;
  levers_margin_effect: number;
  non_margin: { operacional: NonMarginBlock; error_captura: NonMarginBlock };
  promotions: { skus_con_promo: number; avg_benefit_pct: number | null };
  /** Sobre qué parte del universo se calculó el margen. El número honesto. */
  coverage: {
    revenue_with_cost: number;
    revenue_total: number;
    revenue_pct: number | null;
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
  cost: number;
  margin_amount: number;
  margin_pct: number | null;
  gap_pp: number | null;
  gap_amount: number | null;
  units: number;
  skus: number;
  inventory_value: number;
  inventory_days: number | null;
  annual_contribution: number | null;
  gmroi: number | null;
  /** Promoción vigente del SKU (kdpv_descuxq), en %. */
  promo_pct: number | null;
}

export interface ProfitabilityBreakdown {
  level: MarginLevel;
  window: MarginWindow;
  target: number;
  data: ProfitabilityRow[];
  totals: { revenue: number; margin_amount: number; margin_pct: number | null; gap_amount: number | null };
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
  promotions: {
    skus_con_promo: number;
    avg_benefit_pct: number | null;
    max_benefit_pct: number | null;
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
 * Motor de Rentabilidad (Fase MR). La venta sale del sell-out real, no de
 * `commercial.orders` — ver ADR-046.
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
