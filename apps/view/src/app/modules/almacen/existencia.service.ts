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
  /**
   * `[W1.0/W1.3]` La cifra en cajas de ESTA celda se apoya en un divisor SIN fuente. Presente sólo
   * cuando aplica, así que su ausencia significa "el factor tiene origen verificado".
   *   · `'sin_factor'` — ninguna de las cuatro fuentes declaró factor → el divisor vale 1 y la
   *     cantidad nativa se está publicando como si 1 unidad fuera 1 caja. Nadie lo verificó.
   *   · `'peso'` — el producto se mide en kilos y el divisor cuenta PIEZAS por caja.
   * La cifra NO se oculta (eso borraría entre 24% y 58% del total de cada almacén, medido en prod
   * el 2026-09-07, y es decisión de negocio): se DECLARA.
   */
  nf?: 'sin_factor' | 'peso';
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
  /** `[W1.0/W1.3]` Cuántas celdas de este SKU SÍ suman al total con un divisor sin fuente. */
  sin_factor: number;
  /** Lo que el costo pagado SÍ afirma de lo retenido. REFERENCIA para revisar, no publicable. */
  arbitrado: number | null;
  buckets: string[] | null;
  cells: Record<string, ExistenciaCell> | null;
}

/**
 * `label` = el rótulo corto con el que se nombra el almacén en piso (PH, MA, MM, 8ES, LPA, YU,
 * CAN, DAMASO, CEDIS). Viene de `commercial.warehouses.short_label` con caída al `code`, así que
 * un almacén nuevo aparece con su código y nadie tiene que tocar el front.
 * El ORDEN del array ya viene resuelto del backend (`display_order`): no reordenar acá.
 */
export interface ExistenciaColumn { code: string; name: string; label: string; es_hub: boolean; }

/** Edad del dato POR RAMA del ODS. Una sola cifra promediaría feeds de ritmos muy distintos. */
export interface ExistenciaFreshness { rama: string; label: string; dato_al: string; minutos: number; }

export interface ExistenciaTotals {
  skus: number;
  valor: number | null;
  celdas_sin_valuar: number;
  skus_sin_valuar: number;
  /** `[W1.0/W1.3]` Celdas que SÍ suman al total de cajas con un divisor sin fuente. */
  celdas_sin_factor: number;
  skus_sin_factor: number;
  /**
   * `KE.2` Celdas cuyo costo salió del CATÁLOGO y no del ERP. El backend la devolvía desde el
   * 2026-09-08 y la pantalla no la mostraba: declararlo en el response no es declararlo al
   * usuario.
   */
  celdas_sin_costo_erp: number;
  /**
   * `KX` Con qué se valuó. `erp_promedio_ponderado_historico` = `kdik.c16` (`c8/c5`, con `c5` =
   * entradas acumuladas): un promedio de toda la historia de compras, **no** costo de reposición
   * — mediana 2% por debajo del último costo conocido.
   */
  metodo_valuacion?: string;
  /** `KX` Celdas donde el catálogo trae sus dos columnas de costo en unidades distintas. */
  celdas_costo_invertido: number;
  arbitrado: number | null;
  per_warehouse: { code: string; valor: number | null; cajas: number | null; sin_valuar: number; sin_factor: number; skus_con_existencia: number }[];
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
