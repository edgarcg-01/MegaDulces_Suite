import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  CommandCenterService, NetworkOverviewResponse, SalesByBrandRow,
  NetworkTopProductRow, HistoricalMarginRow, HistoricalByZonaRow, NetworkDailyRow, TopCustomerRow,
} from '../dashboard/command-center/command-center.service';
import { DashboardSpec, VgFilters } from './ventas-generales/dashboard-spec';

/**
 * Fase VG — adaptador "Ventas Generales". Traduce (métrica × dimensión × rango) a los
 * endpoints de analítica YA PROBADOS (network/*, historical/*, top-*), normalizando la
 * respuesta a una forma común. NO ejecuta SQL nuevo ni calcula cifras: los números salen
 * tal cual de la DB. La flexibilidad total (long-tail) la dará el endpoint semántico en VG.1.
 * Contrato anti-invención (ADR-016): aquí solo se ENRUTA y se mapea, nunca se inventa.
 */
export type VgMetric = 'ventas' | 'margen' | 'unidades' | 'tickets' | 'ticket_promedio';
export type VgDimension = 'canal' | 'marca' | 'categoria' | 'sucursal' | 'producto' | 'cliente' | 'tiempo';

export interface VgRow { label: string; value: number; share?: number; meta?: string; }
export interface VgBreakdown { rows: VgRow[]; total: number; coverage?: number | null; note?: string; }
export interface VgSeriesPoint { day: string; value: number; }
/** Respuesta del endpoint semántico VG.1 (/analytics/query). */
export interface VgQueryResponse {
  metric: VgMetric; dimension: VgDimension; total: number; coverage_pct: number;
  totals: { revenue: number; cost: number; margin: number; units: number; tickets: number; avg_ticket: number };
  rows: { label: string; value: number; share: number; revenue: number; margin: number; units: number; tickets: number }[];
}
/** Opciones para la barra de filtros. */
export interface VgFilterOptions {
  channels: { value: string; label: string }[];
  warehouses: { value: string; label: string }[];
  brands: { value: string; label: string }[];
  categories: { value: string; label: string }[];
}
export interface VgKpis {
  revenue: number; margin: number; margin_pct: number; units: number; tickets: number;
  avg_ticket: number; unique_customers: number; coverage: number | null; updated_at: string | null;
}

/** Métricas soportadas por cada dimensión (según lo que el endpoint fuente realmente trae). */
const METRICS_BY_DIM: Record<VgDimension, VgMetric[]> = {
  canal:     ['ventas', 'margen', 'unidades', 'tickets', 'ticket_promedio'],
  marca:     ['ventas', 'margen', 'unidades'],
  categoria: ['ventas', 'margen', 'unidades'],
  sucursal:  ['ventas', 'unidades', 'tickets'],
  producto:  ['ventas', 'margen', 'unidades'],
  cliente:   ['ventas'],
  tiempo:    ['ventas', 'unidades', 'tickets'],
};

export const METRIC_LABEL: Record<VgMetric, string> = {
  ventas: 'Ventas', margen: 'Margen', unidades: 'Unidades', tickets: 'Tickets', ticket_promedio: 'Ticket promedio',
};
export const DIMENSION_LABEL: Record<VgDimension, string> = {
  canal: 'Canal', marca: 'Marca', categoria: 'Categoría', sucursal: 'Sucursal',
  producto: 'Producto', cliente: 'Cliente', tiempo: 'Tiempo',
};
/** Métrica que representa dinero (para formato + gate anti-leak del margen). */
export const MONEY_METRICS: VgMetric[] = ['ventas', 'margen', 'ticket_promedio'];

@Injectable({ providedIn: 'root' })
export class VentasGeneralesService {
  private readonly cc = inject(CommandCenterService);
  private readonly http = inject(HttpClient);

  metricsFor(dim: VgDimension): VgMetric[] { return METRICS_BY_DIM[dim]; }

  /** VG.2 — Thot compone el tablero desde lenguaje natural. Devuelve el `spec` (ya validado
   *  server-side contra el catálogo). Los datos los siguen poniendo los endpoints deterministas. */
  composeSalesView(question: string, history: { role: 'user' | 'assistant'; content: string }[] = []): Observable<{ spec: DashboardSpec; source: string }> {
    return this.http.post<{ spec: DashboardSpec; source: string }>(
      `${environment.apiUrl}/commercial/intelligence/thot/sales-view`, { question, history },
    );
  }

  /** VG.1 — endpoint semántico: (metric × dimension × rango × filtros) determinista. */
  query(metric: VgMetric, dimension: VgDimension, opts: { from?: string; to?: string; limit?: number; filters?: VgFilters } = {}): Observable<VgQueryResponse> {
    return this.http.post<VgQueryResponse>(`${environment.apiUrl}/commercial/analytics/query`, {
      metric, dimension, from: opts.from, to: opts.to, limit: opts.limit,
      channel: opts.filters?.channel || undefined,
      warehouse_id: opts.filters?.warehouse_id || undefined,
      brand_id: opts.filters?.brand_id || undefined,
      category_id: opts.filters?.category_id || undefined,
      sku: opts.filters?.sku || undefined,
      brand: opts.filters?.brand || undefined,
      category: opts.filters?.category || undefined,
    });
  }

  /** Opciones para la barra de filtros (canales/sucursales/marcas/categorías con venta). */
  filterOptions(): Observable<VgFilterOptions> {
    return this.http.get<VgFilterOptions>(`${environment.apiUrl}/commercial/analytics/query/filters`);
  }

  /** ¿El bloque tiene rango explícito o algún filtro → debe usar el endpoint semántico? */
  hasScope(opts: { from?: string; to?: string; filters?: VgFilters }): boolean {
    const f = opts.filters;
    return !!(opts.from || opts.to || f?.channel || f?.warehouse_id || f?.brand_id || f?.category_id || f?.sku || f?.brand || f?.category);
  }

  /** KPIs globales de la red (venta real 30d móvil). Fuente: network/overview. */
  kpis(): Observable<VgKpis> {
    return this.cc.networkOverview().pipe(map((o: NetworkOverviewResponse) => ({
      revenue: o.revenue.gross, margin: o.revenue.margin, margin_pct: o.revenue.margin_pct,
      units: o.units, tickets: o.tickets, avg_ticket: o.avg_ticket, unique_customers: o.unique_customers,
      coverage: o.cost_coverage_pct ?? null, updated_at: o.updated_at,
    })));
  }

  /** Desglose por dimensión para la métrica pedida. Cada dimensión → su endpoint probado. */
  breakdown(metric: VgMetric, dim: VgDimension, limit = 20): Observable<VgBreakdown> {
    switch (dim) {
      case 'canal':
        return this.cc.networkOverview().pipe(map((o) => this.finish(
          o.by_channel.map((c) => ({ label: this.channelLabel(c.channel), value: this.pickChannel(c, metric) })),
          o.cost_coverage_pct ?? null,
        )));
      case 'marca':
        return this.cc.networkSalesByBrand().pipe(map((rows: SalesByBrandRow[]) => this.finish(
          rows.map((r) => ({ label: r.brand_name || '—', value: this.pickBrand(r, metric) })), null,
        )));
      case 'categoria':
        return this.cc.historicalMarginByCategory({ limit }).pipe(map((rows: HistoricalMarginRow[]) => this.finish(
          rows.map((r) => ({ label: r.category || '—', value: this.pickCategory(r, metric), meta: r.margin_pct != null ? `${(r.margin_pct).toFixed(1)}% mg` : undefined })), null,
        )));
      case 'sucursal':
        return this.cc.historicalByZona().pipe(map((rows: HistoricalByZonaRow[]) => this.finish(
          rows.map((r) => ({ label: `${r.zona || ''} ${r.almacen || ''}`.trim() || '—', value: this.pickZona(r, metric) })), null,
        )));
      case 'producto':
        return this.cc.networkTopProducts(limit).pipe(map((rows: NetworkTopProductRow[]) => this.finish(
          rows.map((r) => ({ label: r.product_name || '—', value: this.pickProduct(r, metric), meta: r.abc_class ? `ABC ${r.abc_class}` : undefined })), null,
        )));
      case 'cliente':
        return this.cc.topCustomers(limit).pipe(map((rows: TopCustomerRow[]) => this.finish(
          rows.map((r) => ({ label: r.name || r.code || '—', value: r.revenue, meta: `${r.orders_count} pedidos` })), null,
        )));
      default:
        return this.cc.networkOverview().pipe(map(() => this.finish([], null)));
    }
  }

  /** Serie temporal (histórico). Fuente: network/daily-series (revenue/units/tickets). */
  series(metric: VgMetric, from?: string, to?: string): Observable<VgSeriesPoint[]> {
    return this.cc.networkDailySeries(from, to).pipe(map((rows: NetworkDailyRow[]) =>
      rows.map((r) => ({ day: r.day, value: metric === 'unidades' ? r.units : metric === 'tickets' ? r.tickets : r.revenue })),
    ));
  }

  // ── mapeo métrica → columna por fuente ──
  private pickChannel(c: NetworkOverviewResponse['by_channel'][number], m: VgMetric): number {
    if (m === 'margen') return c.margin ?? 0;
    if (m === 'unidades') return c.units;
    if (m === 'tickets') return c.tickets;
    if (m === 'ticket_promedio') return c.tickets ? c.revenue / c.tickets : 0;
    return c.revenue;
  }
  private pickBrand(r: SalesByBrandRow, m: VgMetric): number {
    if (m === 'margen') return r.margin ?? 0;
    if (m === 'unidades') return r.units;
    return r.revenue;
  }
  private pickCategory(r: HistoricalMarginRow, m: VgMetric): number {
    if (m === 'margen') return r.margin;
    if (m === 'unidades') return r.units;
    return r.revenue;
  }
  private pickZona(r: HistoricalByZonaRow, m: VgMetric): number {
    if (m === 'unidades') return r.units;
    if (m === 'tickets') return r.tickets;
    return r.revenue;
  }
  private pickProduct(r: NetworkTopProductRow, m: VgMetric): number {
    if (m === 'margen') return r.margin ?? 0;
    if (m === 'unidades') return r.units_sold;
    return r.revenue;
  }

  /** Ordena desc, calcula share sobre el total y arma el breakdown. */
  private finish(rows: VgRow[], coverage: number | null): VgBreakdown {
    const clean = rows.filter((r) => Number.isFinite(r.value));
    clean.sort((a, b) => b.value - a.value);
    const total = clean.reduce((s, r) => s + (r.value || 0), 0);
    for (const r of clean) r.share = total ? (r.value / total) * 100 : 0;
    return { rows: clean, total, coverage };
  }

  /** Etiqueta legible de canal (feed trae claves cortas). */
  private channelLabel(k: string): string {
    const map: Record<string, string> = {
      mostrador: 'Mostrador', preventa: 'Preventa', ruta: 'Ruta', credito: 'Mayoreo (crédito)',
      mayoreo: 'Mayoreo', otro: 'Otro',
    };
    return map[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '—');
  }
}
