import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * EXISTENCIA — cliente del endpoint de la matriz producto × almacén.
 *
 * Vive en `modules/almacen/` porque Almacén es el dueño del censo; Compras importa el mismo
 * componente por path relativo (el precedente es `/dashboard` importando de `logistica/`).
 */

/** Una celda del pivot = un (producto, almacén). Las claves viajan CORTAS: son 9 por fila. */
export interface ExistenciaCell {
  /** Cantidad en CAJAS. Ausente cuando el peldaño está contradicho: entonces no existe cifra en cajas. */
  q?: number;
  /** Valuado a costo. Ausente por la misma razón — y `null` jamás se dibuja como $0. */
  val?: number;
  /** Cantidad en la unidad NATIVA del almacén. Sólo viaja cuando `rung` viaja. */
  nat?: number;
  /** Rótulo de esa unidad, tal como lo declara el ERP dueño del almacén (KG, PAQ, PZA…). */
  natu?: string;
  /** 'x1_inflada' | 'x2_deflactada'. Presente SÓLO cuando el costo contradice el divisor. */
  rung?: string;
  /** Bucket contra la política de reorden de ESE almacén. Ausente si el producto no tiene política. */
  b?: 'agotado' | 'bajo_minimo' | 'bajo_reorden' | 'sano' | 'sobrestock';
}

export interface ExistenciaRow {
  product_id: string;
  sku: string;
  nombre: string;
  /** Σ del valor de las celdas MEDIBLES. `null` = ninguna se pudo valuar. */
  valor: number | null;
  /** Σ en cajas, sólo de las celdas medibles: es la única unidad comparable entre los dos ERPs. */
  total_cajas: number | null;
  n_almacenes: number;
  /** Cuántas celdas de este SKU quedaron sin valuar por peldaño contradicho. */
  sin_valuar: number;
  /** Lo que el costo pagado SÍ afirma de lo retenido. REFERENCIA para revisar, no publicable. */
  arbitrado: number | null;
  buckets: string[] | null;
  cells: Record<string, ExistenciaCell> | null;
}

export interface ExistenciaColumn { code: string; name: string; es_hub: boolean; }

/** Edad del dato POR RAMA del ODS. Una sola cifra promediaría feeds de ritmos muy distintos. */
export interface ExistenciaFreshness { rama: string; label: string; dato_al: string; minutos: number; }

export interface ExistenciaTotals {
  skus: number;
  valor: number | null;
  celdas_sin_valuar: number;
  skus_sin_valuar: number;
  arbitrado: number | null;
  per_warehouse: { code: string; valor: number | null; cajas: number | null; sin_valuar: number; skus_con_existencia: number }[];
}

export interface ExistenciaResponse {
  rows: ExistenciaRow[];
  columns: ExistenciaColumn[];
  totals: ExistenciaTotals;
  freshness: ExistenciaFreshness[];
  page: number; pageSize: number; total: number;
}

export interface ExistenciaDetailRow {
  warehouse_code: string; warehouse_name: string;
  nat: number; base_label: string | null; box_label: string | null;
  erp: string | null; factor_source: string | null; is_weight: boolean | null;
  dbf: number; dbf_esperado: number | null;
  rung_veredicto: string | null; arbitrado: number | null; caja_cost: number | null;
  min_stock: number | null; reorder_point: number | null; max_stock: number | null;
  safety_stock: number | null; xyz_class: string | null;
}

export interface ExistenciaQuery {
  warehouse_ids?: string[];
  supplier_id?: string; brand_id?: string; category_id?: string;
  search?: string; bucket?: string;
  only_unverified?: boolean; hide_zero?: boolean;
  sort_by?: string; sort_dir?: string;
  page?: number; pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class ExistenciaApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/inventory/existencia`;

  list(q: ExistenciaQuery): Observable<ExistenciaResponse> {
    let p = new HttpParams();
    if (q.warehouse_ids?.length) p = p.set('warehouse_ids', q.warehouse_ids.join(','));
    if (q.supplier_id) p = p.set('supplier_id', q.supplier_id);
    if (q.brand_id) p = p.set('brand_id', q.brand_id);
    if (q.category_id) p = p.set('category_id', q.category_id);
    if (q.search?.trim()) p = p.set('search', q.search.trim());
    if (q.bucket) p = p.set('bucket', q.bucket);
    if (q.only_unverified) p = p.set('only_unverified', '1');
    if (q.hide_zero) p = p.set('hide_zero', '1');
    if (q.sort_by) p = p.set('sort_by', q.sort_by);
    if (q.sort_dir) p = p.set('sort_dir', q.sort_dir);
    p = p.set('page', String(q.page || 1)).set('pageSize', String(q.pageSize || 50));
    return this.http.get<ExistenciaResponse>(this.base, { params: p });
  }

  detail(productId: string): Observable<{ product: any; rows: ExistenciaDetailRow[] }> {
    return this.http.get<{ product: any; rows: ExistenciaDetailRow[] }>(`${this.base}/${productId}`);
  }
}
