import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase AB — cliente de la **mesa de autoabasto** (`/commercial/autoabasto/*`).
 *
 * Los tres endpoints delegan en `CommercialReplenishmentService`, el MISMO motor que sirve
 * `/compras/existencia`. Por eso este servicio no interpreta ni recalcula nada: las formas de
 * abajo son las que ya devuelve ese motor, nombradas igual. **Dos audiencias, un solo número**
 * — si acá naciera un cálculo propio, el almacén y el comprador discutirían cifras distintas
 * del mismo hecho (ADR-056).
 */

/**
 * Qué hacer con la fila, resuelto por el motor (no por la pantalla):
 *  · `sobrante`         — acá sobra sobre el máximo; es candidato a SALIR a otra sucursal.
 *  · `traspaso`         — lo que falta se cubre ENTERO con sobrante de otra sucursal.
 *  · `traspaso_parcial` — se cubre una parte; el resto hay que comprarlo.
 *  · `comprar`          — no hay sobrante en la red: pasa al comprador.
 *  · `ok`               — dentro de política, no hay nada que hacer.
 *
 * El orden `traspaso` → `comprar` es la regla §5 del pedido: sucursal-sucursal antes que compra.
 */
export type AutoabastoAccion = 'sobrante' | 'traspaso' | 'traspaso_parcial' | 'comprar' | 'ok';

/** Posición contra la política de reorden de ESE almacén. */
export type AutoabastoBucket = 'agotado' | 'bajo_minimo' | 'bajo_reorden' | 'sano' | 'sobrestock';

export interface AutoabastoRow {
  product_id: string;
  sku: string;
  nombre: string;
  warehouse_id: string;
  warehouse_code: string;
  /** Cantidades en CAJAS — la única unidad que los dos ERPs declaran (ADR-055). */
  on_hand: number;
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  in_transit: number;
  /** Lo que falta para llegar al objetivo, ya NETO de lo que viene en camino. */
  suggested_qty: number;
  /** El residual que de verdad hay que COMPRAR, después de descontar lo traspasable. */
  buy_qty: number;
  /** Cuánto del faltante cubre el sobrante de otras sucursales. */
  transfer_in: number;
  /** Sobrante de ESTE almacén por encima de su máximo (lo que puede salir). */
  surplus_here: number;
  /** Sobrante del mismo producto en el RESTO de la red. */
  surplus_network: number;
  accion: AutoabastoAccion;
  bucket: AutoabastoBucket;
  abc_class: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  /**
   * `null` = **no se está midiendo**, no "cero pesos". El motor retiene el $ cuando el costo de
   * compra contradice el peldaño de unidades (U.2); la pantalla lo declara, no lo dibuja en 0.
   */
  suggested_cost: number | null;
  unit_cost: number | null;
  /** Veredicto del peldaño cuando el $ viene retenido (`x1_inflada` / `x2_deflactada`). */
  rung_veredicto: string | null;
  /** Rótulo de la unidad NATIVA del almacén (KG, PAQ, PZA…), tal como lo declara su ERP. */
  rung_base_label: string | null;
}

export interface AutoabastoMesaResponse {
  total: number;
  page: number;
  pageSize: number;
  target_basis: string;
  rows: AutoabastoRow[];
}

/** KPIs por bucket. Los `*_valor` pueden venir `null`: ninguna política valuable en el filtro. */
export interface AutoabastoResumen {
  agotado: number;
  bajo_minimo: number;
  bajo_reorden: number;
  sobrestock: number;
  total_policies: number;
  sugerido_costo: number | null;
  /** Cuánto del sugerido se resuelve moviendo mercancía que la empresa YA compró. */
  traspasable_valor: number | null;
  /** Cuánto hay que desembolsar de verdad. */
  compra_real_valor: number | null;
  existencia_valor: number | null;
  /** Políticas y SKUs cuyo $ quedó retenido por peldaño contradicho — se declaran en pantalla. */
  sin_valuar_politicas: number;
  sin_valuar_skus: number;
}

export interface AutoabastoWarehouseOpt {
  id: string;
  code: string;
  name: string;
  purchase_zone: string | null;
  is_purchase_hub: boolean;
}

export interface AutoabastoSupplierOpt {
  id: string;
  name: string;
  min_order_boxes: number | null;
}

export interface AutoabastoFiltros {
  warehouses: AutoabastoWarehouseOpt[];
  suppliers: AutoabastoSupplierOpt[];
}

export interface AutoabastoQuery {
  warehouse_id?: string;
  warehouse_ids?: string;
  supplier_id?: string;
  category_id?: string;
  abc?: string;
  bucket?: string;
  search?: string;
  target_basis?: string;
  sort_by?: string;
  sort_dir?: string;
  page?: number;
  pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class AutoabastoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/autoabasto`;

  /** Sólo manda los parámetros con valor: un `''` en el query cambia el filtro del backend. */
  private params(q: AutoabastoQuery): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    }
    return p;
  }

  mesa(q: AutoabastoQuery): Observable<AutoabastoMesaResponse> {
    return this.http.get<AutoabastoMesaResponse>(`${this.base}/mesa`, { params: this.params(q) });
  }

  resumen(q: AutoabastoQuery): Observable<AutoabastoResumen> {
    return this.http.get<AutoabastoResumen>(`${this.base}/mesa/resumen`, { params: this.params(q) });
  }

  filtros(): Observable<AutoabastoFiltros> {
    return this.http.get<AutoabastoFiltros>(`${this.base}/filtros`);
  }
}
