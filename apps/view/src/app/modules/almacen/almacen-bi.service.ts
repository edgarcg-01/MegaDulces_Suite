import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * WMS-BI.1 — Cliente de `/commercial/bi-almacen`. Ver el cabezal del service backend
 * (`commercial-bi-almacen.service.ts`) para las decisiones de fondo: el alcance por
 * almacén NO se manda como parámetro (el backend lo resuelve por sesión vía
 * `ScopeService`, ADR-050) — acá sólo van filtros de NEGOCIO (fechas, producto, tipo).
 */

export interface BiWarehouseOpt { id: string; code: string; name: string; zone_id: string | null; zone_name: string | null; has_movements_feed: boolean; }
export interface BiZoneGroup { zone_id: string | null; zone_name: string; warehouses: BiWarehouseOpt[]; }
export interface BiDocType { doc_code: string; movement_label: string; movement_kind: 'entrada' | 'salida' | 'info'; }
export interface BiFilters {
  zones: BiZoneGroup[];
  doc_types: BiDocType[];
  scope: { mode: string; resolvable: boolean; warehouse_count: number | null };
  movements_as_of: { max_doc_date: string | null; max_imported_at: string | null; total_rows: number };
  inventory_as_of: string;
}
export interface BiProductOpt { id: string; sku: string | null; name: string; brand_name: string | null; }
export interface BiPage<T> { page: number; pageSize: number; total: number; rows: T[]; }

export interface BiInventoryValuation {
  as_of: string; erp_cost_available: boolean; unavailable_reason: string | null;
  sku_en_scope: number | null; valor_catalogo: number | null; valor_erp_verificado: number | null;
  valor_catalogo_mismo_subset: number | null; diferencia: number | null; cobertura_testigo_pct: number | null;
}
export interface BiMovementCounts {
  covers_all_scope: boolean; entradas_lineas: number; salidas_lineas: number; productos_con_movimiento: number;
  daily_series: Array<{ date: string; entradas: number; salidas: number }>;
  top_salida_valor: Array<{ sku: string | null; product_name: string; valor: number }>;
}
export interface BiCostDeviationRow {
  warehouse_code: string; sku: string | null; product_name: string;
  costo_catalogo: number | null; costo_erp: number | null; diferencia: number | null; diferencia_pct: number | null;
}
export interface BiCostDeviation { available: boolean; unavailable_reason: string | null; rows: BiCostDeviationRow[]; }
export interface BiSummary {
  from: string; to: string;
  inventory: BiInventoryValuation; movements: BiMovementCounts; cost_deviation: BiCostDeviation;
}
export interface BiMovementRow {
  doc_date: string;
  hora: string | null;
  zone_name: string | null;
  warehouse_code: string; warehouse_name: string;
  almacen: 'Disponible';
  movement_kind: 'entrada' | 'salida' | 'info';
  tipo_operacion: 'Comercial' | 'Traspasos internos' | 'Ajuste de inventario';
  movement_label: string; doc_code: string; folio: string;
  vendedor: string | null;
  canal: 'Punto de Venta' | 'Mayoreo' | 'Venta al detalle' | null;
  sku: string | null; product_name: string;
  linea_producto: string | null; tipo_producto: string | null; grupo_producto: string | null;
  qty: number; signed_qty: number;
  unidad_operacion: string | null; unidad_base: string | null;
  cantidad_base: number | null; unidad_base_medible: boolean;
  unit_cost: number | null; amount: number | null;
  importe_costo: number | null; importe_venta: number | null;
  iva_valor: number | null; ieps_valor: number | null; venta_neta: number | null;
  cost_base_hoy: number | null; source_system: 'kepler';
}
/**
 * [WMS-BI.4.3] De dónde salió la columna "Unidad base" y de cuándo. `source: 'view'` es el camino
 * degradado (la MV `analytics.mv_unit_truth` no está aplicada en ese entorno): correcto pero ~8×
 * más lento, y se DECLARA en vez de disimularse.
 */
export interface BiUnitProvenance { source: 'mv' | 'view'; refreshed_at: string | null; }
export interface BiMovementPage extends BiPage<BiMovementRow> { unit_provenance: BiUnitProvenance; }
export interface BiField { key: string; label: string; group: string; available: boolean; reason?: string; }
export interface BiMovementDetail {
  header: Record<string, unknown> | null; lines: Array<Record<string, unknown>>;
  totals: { qty: number; amount: number; lineas: number }; counterpart: Record<string, unknown> | null;
  dest_redacted: boolean;
}

export interface BiFilterParams {
  from?: string; to?: string; doc_code?: string; movement_kind?: 'entrada' | 'salida' | ''; product_id?: string; folio?: string;
  /**
   * Almacenes elegidos A MANO en el filtro (uuid o código — `ScopeService.readParam` traduce
   * cualquiera de los dos a la llave canónica). Vacío = no recortar más allá del alcance del
   * usuario. El backend SIEMPRE intersecta esto contra el alcance real (ADR-050): pedir de más
   * no cuela, se recorta en silencio.
   */
  warehouse_ids?: string[];
}

@Injectable({ providedIn: 'root' })
export class AlmacenBiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/bi-almacen`;

  private params(f: BiFilterParams = {}, extra: Record<string, string | number | undefined> = {}): HttpParams {
    let p = new HttpParams();
    if (f.from) p = p.set('from', f.from);
    if (f.to) p = p.set('to', f.to);
    if (f.doc_code) p = p.set('doc_code', f.doc_code);
    if (f.movement_kind) p = p.set('movement_kind', f.movement_kind);
    if (f.product_id) p = p.set('product_id', f.product_id);
    if (f.folio) p = p.set('folio', f.folio);
    // Nombre canónico que `ScopeService.readParam` ya reconoce (ADR-050) — el backend lo
    // intersecta contra el alcance real, nunca lo honra a ciegas.
    if (f.warehouse_ids?.length) p = p.set('warehouse_codes', f.warehouse_ids.join(','));
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p = p.set(k, String(v));
    return p;
  }

  filters(): Observable<BiFilters> {
    return this.http.get<BiFilters>(`${this.base}/filters`);
  }

  productSearch(q: string, page = 1, pageSize = 20): Observable<BiPage<BiProductOpt>> {
    return this.http.get<BiPage<BiProductOpt>>(`${this.base}/products/search`, {
      params: new HttpParams().set('q', q || '').set('page', page).set('pageSize', pageSize),
    });
  }

  summary(f: BiFilterParams): Observable<BiSummary> {
    return this.http.get<BiSummary>(`${this.base}/summary`, { params: this.params(f) });
  }

  movements(f: BiFilterParams, page: number, pageSize: number, sort?: string, dir?: 'asc' | 'desc'): Observable<BiMovementPage> {
    return this.http.get<BiMovementPage>(`${this.base}/movements`, {
      params: this.params(f, { page, pageSize, sort, dir }),
    });
  }

  movementDetail(warehouseId: string, folio: string, docCode?: string, docSerie?: string | null): Observable<BiMovementDetail> {
    let p = new HttpParams().set('warehouse_id', warehouseId).set('folio', folio);
    if (docCode) p = p.set('doc_code', docCode);
    if (docSerie) p = p.set('doc_serie', docSerie);
    return this.http.get<BiMovementDetail>(`${this.base}/movements/detail`, { params: p });
  }

  fields(): Observable<BiField[]> {
    return this.http.get<BiField[]>(`${this.base}/fields`);
  }

  explore(f: BiFilterParams, fields: string[], page: number, pageSize: number): Observable<BiPage<Record<string, unknown>>> {
    return this.http.get<BiPage<Record<string, unknown>>>(`${this.base}/explore`, {
      params: this.params(f, { fields: fields.join(','), page, pageSize }),
    });
  }
}
