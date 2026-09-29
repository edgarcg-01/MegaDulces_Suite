import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../../environments/environment';

export interface DetalleKpi {
  cur: number;
  prev: number;
  delta_pct: number | null;
}

export interface DetalleRatioKpi {
  cur: number | null;
  prev: number | null;
  delta_pct: number | null;
}

export interface DetalleKpis {
  revenue: DetalleKpi;
  margin: DetalleKpi;
  margin_pct: DetalleRatioKpi;
  tickets: DetalleKpi;
  avg_ticket: DetalleKpi;
  basket: DetalleKpi;               // Partidas por ticket (renglones distintos)
  avg_line: DetalleRatioKpi;        // Valor por partida ($/renglón)
  units_per_ticket: DetalleRatioKpi;// Unidades por ticket
  avg_unit: DetalleRatioKpi;        // Valor unitario promedio ($/unidad)
  customers: DetalleKpi;            // Clientes activos en ruta
  revenue_per_customer: DetalleRatioKpi; // Venta por cliente
}

export interface DetalleSeriesPoint {
  date: string;
  label: string;
  revenue: number;
  margin: number;
  units: number;
  tickets: number;
}

export interface DetalleChannelSummary {
  canal: 'rd' | 'vecinal';
  label: string;
  badge: string;
  icon: string;
  revenue: number;
  share_pct: number;
  tickets: number;
  avg_ticket: number;
  units: number;
  margin: number;
  margin_pct: number;
  active_routes: number;
}

export interface DetalleRouteRow {
  route_code: string;
  route_no: string;
  name: string;
  canal: 'rd' | 'vecinal';
  canal_label: string;
  warehouse_code: string;
  warehouse_name: string;
  chofer_nombre?: string;
  supervisor_nombre?: string;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  tickets: number;
  avg_ticket: number;
  basket: number;
  units: number;
  margin: number;
  margin_pct: number;
  customers: number;
  share_pct: number;
}

export interface DetalleBranchRow {
  code: string;
  name: string;
  revenue: number;
  tickets: number;
  avg_ticket: number;
  margin: number;
  units: number;
  routes_count: number;
}

export interface DetalleTopProduct {
  sku: string;
  nombre: string;
  brand: string | null;
  canal_predominante: 'rd' | 'vecinal' | 'ambos';
  units: number;
  revenue: number;
  avg_price: number;
  share_pct: number;
  cum_share_pct: number;
}

export interface DetalleCustomerRow {
  cliente_code: string;
  cliente_nombre: string;
  route_code: string;
  tickets: number;
  revenue: number;
  avg_ticket: number;
  frecuencia: string;
}

export interface DetalleReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  kpis: DetalleKpis;
  series: DetalleSeriesPoint[];
  channels: {
    rd: DetalleChannelSummary;
    vecinal: DetalleChannelSummary;
  };
  by_route: DetalleRouteRow[];
  by_branch: DetalleBranchRow[];
  top_products: DetalleTopProduct[];
  customers: DetalleCustomerRow[];
  routes_catalog: DetalleRouteCatalogItem[];
  generated_at?: string;
}

export interface DetalleQueryParams {
  from: string;
  to: string;
  canal?: 'all' | 'rd' | 'vecinal';
  warehouse_code?: string;
  route_code?: string;
}

export interface DetalleRouteCatalogItem {
  value: string;
  label: string;
  warehouse_code?: string;
  warehouse_name?: string;
  route_code?: string;
  route_no?: string;
}

/**
 * Servicio que consolida el flujo analítico de Venta al Detalle (RD + Preventa Vecinal).
 * 100% de la información proviene de las fuentes reales generadas por Kepler
 * (mv_rd_route_daily_200d, v_route_sales_lines, v_kepler_chofer).
 */
@Injectable({ providedIn: 'root' })
export class DetalleHomeService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiUrl}/commercial/analytics/sales-by-route`;

  /** Obtiene el catálogo de rutas para filtros directamente de Kepler / Wincaja */
  loadRoutesCatalog(): Observable<DetalleRouteCatalogItem[]> {
    return this.http.get<any[]>(`${this.apiUrl}/routes`).pipe(
      map((routes) =>
        (routes || []).map((r) => ({
          value: r.value,
          label: r.label,
          warehouse_code: r.warehouse_code,
          warehouse_name: r.warehouse_name,
          route_code: r.route_code,
          route_no: r.route_no,
        }))
      )
    );
  }

  /**
   * Consulta los datos de Venta al Detalle para el rango y filtros especificados.
   * 100% de los datos se obtienen de Kepler a través del endpoint dedicado del backend.
   */
  getDetalleReport(params: DetalleQueryParams): Observable<DetalleReport> {
    let httpParams = new HttpParams()
      .set('from', params.from)
      .set('to', params.to);

    if (params.canal && params.canal !== 'all') {
      httpParams = httpParams.set('canal', params.canal);
    }
    if (params.warehouse_code) {
      httpParams = httpParams.set('warehouse_code', params.warehouse_code);
    }
    if (params.route_code) {
      httpParams = httpParams.set('route_code', params.route_code);
    }

    return this.http.get<DetalleReport>(`${this.apiUrl}/detalle-home`, { params: httpParams });
  }
}
