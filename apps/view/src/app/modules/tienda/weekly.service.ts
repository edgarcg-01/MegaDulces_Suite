import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Análisis semanal de Tienda. Pega a `/store/analytics/weekly` — scopeado por la
 * sucursal del usuario en el backend. Datos agregados on-the-fly (sin feeds nuevos).
 */
export interface WeeklyKpi { cur: number; prev: number; delta_pct: number | null; }
export interface WeeklySeriesPoint { week_start: string; label: string; revenue: number; margin: number; units: number; }
export interface WeeklyBranchRow {
  code: string; name: string; revenue: number; revenue_prev: number; revenue_delta_pct: number | null;
  margin: number; units: number; units_prev: number; units_delta_pct: number | null;
}
export interface WeeklyProductRow {
  product_id: string; sku: string; nombre: string; brand: string | null;
  revenue: number; revenue_prev: number; revenue_delta_pct: number | null; units: number;
}
export interface WeeklyReport {
  ref_week: { start: string; label: string };
  prev_week: { start: string; label: string };
  weeks: number;
  scoped_warehouse: string | null;
  series: WeeklySeriesPoint[];
  kpis: { revenue: WeeklyKpi; margin: WeeklyKpi; units: WeeklyKpi; units_official: WeeklyKpi };
  by_branch: WeeklyBranchRow[];
  by_product: WeeklyProductRow[];
}

/** ST.1 — Análisis por RANGO personalizado (métricas de operación de tienda). */
export interface RangeKpi { cur: number; prev: number; delta_pct: number | null; }
/**
 * Razón que el backend DECLARA no medida (`cur: null`) cuando le falta el denominador
 * —una sucursal/período sin cobertura de tickets, p. ej.— en vez de mandar 0.
 * En pantalla se pinta «—», no «$0».
 */
export interface RangeRatioKpi { cur: number | null; prev: number | null; delta_pct: number | null; }
export interface RangeSeriesPoint { date: string; revenue: number; margin: number; units: number; tickets: number; }
export interface RangeBranchRow { code: string; name: string; revenue: number; margin: number; units: number; tickets: number; avg_ticket: number; }
export interface RangeProductRow { product_id: string; sku: string; nombre: string; brand: string | null; revenue: number; margin: number; units: number; }
export interface RangeReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  scoped_warehouse: string | null;
  kpis: {
    revenue: RangeKpi; margin: RangeKpi; units: RangeKpi; units_official: RangeKpi;
    /** Margen como % de la venta (fuente única; `null` sólo si no hubo venta). */
    margin_pct: RangeRatioKpi;
    /** `basket` = PARTIDAS (renglones) por ticket. El nombre viejo se conserva; la etiqueta ya no. */
    tickets: RangeKpi; avg_ticket: RangeKpi; basket: RangeKpi;
    /** Descomposición del ticket: $/partida, unidades/ticket, $/unidad. */
    avg_line: RangeRatioKpi; units_per_ticket: RangeRatioKpi; avg_unit: RangeRatioKpi;
    /**
     * Clientes CON REGISTRO (excluye el mostrador anónimo `CONTADO` y la televenta)
     * y lo que compró cada uno en promedio. Universo distinto del resto: sale de la
     * facturación a nombre, no del fact de venta — no cuadra contra `revenue`.
     */
    customers: RangeKpi; revenue_per_customer: RangeRatioKpi;
  };
  /** Hasta qué día alcanza cada fuente dentro del período. `null` = no trajo nada. */
  as_of: { fact: string | null; customers: string | null };
  series: RangeSeriesPoint[];
  by_branch: RangeBranchRow[];
  by_product: RangeProductRow[];
}

/* ───────────────────── `[TDA.A1]` Cascada por período ─────────────────────
 * El MISMO rango de la fotografía, partido en buckets del grano elegido. Espejo de
 * `BreakdownReport` del backend (`weekly-analytics.service.ts`) — si cambia allá,
 * cambia acá.
 */
export type BreakdownGrain = 'week' | 'weekday' | 'month' | 'quarter' | 'year';
export type BreakdownChildGrain = 'day' | 'month' | 'quarter';

/**
 * Una fila de la cascada. **Toda razón puede venir `null`** = no se pudo medir en ESE
 * bucket, y se pinta «—». Un mes sin tickets no tiene un ticket promedio de $0.
 */
export interface BreakdownRow {
  key: string;
  label: string;
  sub: string;
  from: string;
  to: string;
  /** Días del bucket con venta (fact) y con tickets (POS): la cobertura, medida. */
  fact_days: number;
  pos_days: number;
  revenue: number;
  margin: number;
  margin_pct: number | null;
  units: number;
  tickets: number;
  avg_ticket: number | null;
  basket: number | null;
  avg_line: number | null;
  units_per_ticket: number | null;
  avg_unit: number | null;
  customers: number;
  revenue_per_customer: number | null;
  /** Participación en la venta de su nivel (padres: la ventana · hijos: su padre). */
  share_pct: number | null;
  /** Δ% de venta contra el bucket anterior. `null` en los padres de grano `weekday`. */
  delta_pct: number | null;
  children: BreakdownRow[];
}

export interface BreakdownReport {
  period: { from: string; to: string; days: number };
  grain: BreakdownGrain;
  child_grain: BreakdownChildGrain;
  totals: { revenue: number; margin: number; units: number; tickets: number | null };
  rows: BreakdownRow[];
  as_of: { fact: string | null; customers: string | null };
  /**
   * `[TDA.A2]`/`[TDA.A3]` A qué está acotada la cascada (una línea o un producto), o
   * `null` = toda la tienda. Cuando viene, tickets/partidas/ticket promedio/$-partida/
   * uds-ticket/clientes llegan `null` **porque no son atribuibles** (un ticket lleva
   * varios productos y varias líneas), y la tabla esconde esas columnas.
   */
  scope: { kind: 'linea' | 'producto'; code: string; name: string } | null;
}

/* ─────────── `[TDA.A3]` Productos TOP: Pareto + Línea · Tipo · Grupo ───────────
 * Tipo y Grupo salen de `analytics.v_product_taxonomy` (derivada del ODS, decodificada con
 * el SKU 70001 como sonda). ⚠️ NO son jerarquía: 86 de 241 grupos aparecen bajo más de un
 * tipo, así que son dos filtros independientes y nunca un árbol.
 */
export interface TopProductRow {
  rank: number;
  product_id: string;
  sku: string;
  nombre: string;
  brand: string | null;
  linea_code: string | null;
  linea: string | null;
  tipo: string | null;
  grupo: string | null;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  margin: number;
  margin_pct: number | null;
  units: number;
  avg_unit: number | null;
  /** Días del período en que ESTE producto vendió: todos los días vs un pico no son lo mismo. */
  sale_days: number;
  share_pct: number | null;
  /** Acumulado hasta esta fila. Es la lectura de Pareto. */
  cum_pct: number | null;
}

export interface TopFacet { code: string; name: string; revenue: number; skus: number; }

/* ───────── `[TDA.A4]` Clientes: la cartera y su techo ─────────
 * La ficha del ERP (Grupo · Zona · Vendedor · Límite · Plazo) sale de
 * `analytics.v_customer_master`, derivada del ODS. ⚠️ La llave es (sucursal, clave): 141 de
 * 1,574 claves son un cliente distinto según la plaza, así que **no se suman clientes entre
 * plazas**.
 */
export type CustomerEstado = 'nuevo' | 'activo' | 'dormido';

export interface CustomerRow {
  sucursal: string;
  cliente_code: string;
  nombre: string;
  grupo: string | null;
  zona: string | null;
  vendedor: string | null;
  limite_credito: number | null;
  plazo_dias: number | null;
  es_interno: boolean;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  docs: number;
  ticket_prom: number | null;
  primera_compra: string | null;
  ultima_compra: string | null;
  dias_sin_comprar: number | null;
  estado: CustomerEstado;
  share_pct: number | null;
}

export interface CustomerGrupoRow {
  code: string; name: string; es_interno: boolean; clientes: number; revenue: number; share_pct: number | null;
}

export interface CustomersReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  /** El techo: qué parte de la venta REAL de la tienda está a nombre de alguien. */
  techo: {
    venta_fact: number;
    venta_facturada: number;
    venta_interna: number;
    venta_clientes: number;
    pct_identificado: number | null;
  };
  grupos: CustomerGrupoRow[];
  totals: { revenue: number; clientes: number };
  rows: CustomerRow[];
  resumen: {
    nuevos: number; activos: number; dormidos: number;
    /** Desde cuándo hay facturación en absoluto. */
    historia_desde: string | null;
    /** false = el período arranca donde arranca la historia, así que «nuevo» no se puede distinguir de «no sabemos». */
    nuevos_confiable: boolean;
  };
  as_of: { facturacion: string | null };
}

export interface TopProductsReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  /** El universo COMPLETO que cumple los filtros, no lo que se devolvió. */
  universo: { productos: number; venta: number };
  pareto: { para_50: number | null; para_80: number | null; para_95: number | null };
  mode: 'pareto' | 'all';
  mostrados: number;
  topado: boolean;
  rows: TopProductRow[];
  facets: { tipos: TopFacet[]; grupos: TopFacet[]; lineas: TopFacet[] };
  as_of: { fact: string | null };
}

/* ──────────── `[TDA.A2]` Línea = el proveedor del catálogo ────────────
 * Medido contra prod (12 meses de tienda): cubre el 100.0 % de la venta, es 1:1 y coincide
 * con Kepler en 99.77 %. 11 líneas explican la mitad de la venta.
 */
/** Llave del cajón «sin línea asignada». Espejo de `SIN_LINEA` del backend. */
export const SIN_LINEA = '__SIN_LINEA__';

export interface SupplierRow {
  code: string;
  name: string;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  margin: number;
  margin_pct: number | null;
  units: number;
  /** SKUs de la línea CON VENTA en el período, no los que tiene en el catálogo. */
  skus: number;
  share_pct: number | null;
}

export interface SupplierReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  totals: { revenue: number; margin: number; units: number };
  rows: SupplierRow[];
  /** Cuántas líneas explican la mitad y el 80 % de la venta. Medido, no supuesto. */
  concentracion: { lineas: number; para_50: number | null; para_80: number | null };
  as_of: { fact: string | null };
}

export interface SupplierProductRow {
  product_id: string;
  sku: string;
  nombre: string;
  brand: string | null;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  margin: number;
  margin_pct: number | null;
  units: number;
  /** Participación DENTRO de su línea, no de la tienda. */
  share_pct: number | null;
}

export interface SupplierProductsReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  supplier: { code: string; name: string };
  totals: { revenue: number; margin: number; units: number };
  rows: SupplierProductRow[];
}

@Injectable({ providedIn: 'root' })
export class WeeklyService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/analytics`;

  weekly(q?: { week?: string; weeks?: number; warehouse_code?: string }): Observable<WeeklyReport> {
    const p = new URLSearchParams();
    if (q?.week) p.set('week', q.week);
    if (q?.weeks) p.set('weeks', String(q.weeks));
    if (q?.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    const qs = p.toString();
    return this.http.get<WeeklyReport>(`${this.base}/weekly${qs ? '?' + qs : ''}`);
  }

  /**
   * `with_products: false` omite el top de productos — la consulta cara del endpoint.
   * La sección Tráfico ya no lo dibuja (se mudó a su pestaña), y con rangos de hasta
   * 2 años pagarlo para nada se nota.
   */
  range(q: { from: string; to: string; warehouse_code?: string; with_products?: boolean }): Observable<RangeReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    if (q.with_products === false) p.set('with_products', '0');
    return this.http.get<RangeReport>(`${this.base}/range?${p.toString()}`);
  }

  /**
   * `[TDA.A1]` Cascada: el mismo rango partido en buckets del grano pedido.
   * `[TDA.A2]` Con `supplier_code` se acota a una línea (y la respuesta trae menos
   * columnas a propósito — ver `BreakdownReport.supplier_scope`).
   */
  breakdown(q: {
    from: string; to: string; grain: BreakdownGrain;
    warehouse_code?: string; supplier_code?: string; product_id?: string;
  }): Observable<BreakdownReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to); p.set('grain', q.grain);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    if (q.supplier_code) p.set('supplier_code', q.supplier_code);
    if (q.product_id) p.set('product_id', q.product_id);
    return this.http.get<BreakdownReport>(`${this.base}/breakdown?${p.toString()}`);
  }

  /** `[TDA.A4]` Cartera de clientes con su ficha del ERP + el techo de cobertura. */
  customers(q: { from: string; to: string; warehouse_code?: string; segmento?: string; q?: string }): Observable<CustomersReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    if (q.segmento) p.set('segmento', q.segmento);
    if (q.q) p.set('q', q.q);
    return this.http.get<CustomersReport>(`${this.base}/customers?${p.toString()}`);
  }

  /** `[TDA.A3]` Productos TOP con Línea · Tipo · Grupo y el acumulado de Pareto. */
  topProducts(q: {
    from: string; to: string; warehouse_code?: string;
    tipo?: string; grupo?: string; supplier_code?: string; q?: string; mode?: 'pareto' | 'all';
  }): Observable<TopProductsReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    if (q.tipo) p.set('tipo', q.tipo);
    if (q.grupo) p.set('grupo', q.grupo);
    if (q.supplier_code) p.set('supplier_code', q.supplier_code);
    if (q.q) p.set('q', q.q);
    if (q.mode) p.set('mode', q.mode);
    return this.http.get<TopProductsReport>(`${this.base}/top-products?${p.toString()}`);
  }

  /** `[TDA.A2]` La venta repartida por LÍNEA (proveedor del catálogo). */
  suppliers(q: { from: string; to: string; warehouse_code?: string }): Observable<SupplierReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    return this.http.get<SupplierReport>(`${this.base}/suppliers?${p.toString()}`);
  }

  /** `[TDA.A2]` Los productos de UNA línea (el detalle del maestro-detalle). */
  supplierProducts(q: { from: string; to: string; supplier_code: string; warehouse_code?: string }): Observable<SupplierProductsReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to); p.set('supplier_code', q.supplier_code);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    return this.http.get<SupplierProductsReport>(`${this.base}/supplier-products?${p.toString()}`);
  }
}
