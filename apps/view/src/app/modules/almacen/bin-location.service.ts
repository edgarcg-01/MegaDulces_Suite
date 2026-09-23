import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level, ADR-044).
 * Consume `/commercial/inventory/{bins,put-away,locations,unlocated,pick-suggestion}`.
 */

export interface WarehouseBin {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  /** Sólo lo trae `lookupBin` (el escaneo, que puede cruzar almacenes). */
  warehouse_name?: string | null;
  aisle_id?: string | null;
  code: string;
  label?: string | null;
  active: boolean;
  units?: string | number;
}

export interface LotLocation {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  product_id: string;
  sku?: string | null;
  product_name?: string | null;
  lot_code: string;
  expiry_date: string | null;
  bin_id: string;
  bin_code?: string | null;
  bin_label?: string | null;
  quantity: number;
  days_to_expiry?: number | null;
}

export interface UnlocatedLot {
  warehouse_id: string;
  warehouse_code?: string;
  product_id: string;
  sku?: string | null;
  product_name?: string | null;
  lot_code: string;
  expiry_date: string | null;
  lot_qty: string | number;
  located: string | number;
  to_locate: string | number;
}

export interface PickSuggestion {
  bin_id: string;
  bin_code?: string | null;
  bin_label?: string | null;
  lot_code: string;
  expiry_date: string | null;
  quantity: number;
  days_to_expiry?: number | null;
}

/**
 * Lo que devuelve escanear el cartel de un rack.
 *
 * `match: null` con `candidates: []` **no es un error**: es "ese código no
 * existe todavía", que es una respuesta legítima (y la puerta para crearlo).
 * `candidates` con más de uno = el mismo código existe en dos almacenes y lo
 * desempata la persona, no el sistema.
 */
export interface BinLookup {
  /** El código ya normalizado por el servidor (mayúsculas, sin espacios). */
  code: string;
  match: WarehouseBin | null;
  candidates: WarehouseBin[];
  contents: LotLocation[];
  totals: {
    lineas: number;
    productos: number;
    unidades: number;
    vencidos: number;
    por_vencer: number;
    sin_fecha: number;
  } | null;
}

export interface PutAwayDto {
  warehouse_id: string;
  product_id: string;
  lot_code?: string;
  expiry_date?: string;
  bin_id?: string;
  bin_code?: string;
  quantity: number;
}

/**
 * Mover mercancia YA acomodada de un rack a otro. El origen y el destino se
 * pueden dar por codigo escaneado: quien mueve tiene la pistola, no los UUID.
 */
export interface MoveLotDto {
  warehouse_id: string;
  product_id: string;
  lot_code?: string;
  expiry_date?: string;
  from_bin_id?: string;
  from_bin_code?: string;
  to_bin_id?: string;
  to_bin_code?: string;
  quantity: number;
}

export interface MoveLotResult {
  moved: boolean;
  from_bin_id: string;
  to_bin_id: string;
  lot_code: string;
  quantity: number;
  /** Lo que queda del lote en el rack de origen despues del movimiento. */
  queda_en_origen: number;
}

/**
 * Si el almacen acepta movimientos ahora mismo. `frozen: false` con `folio: null`
 * es la respuesta normal; el campo se declara siempre para poder distinguir
 * "no esta congelado" de "no se pudo averiguar".
 */
export interface WarehouseFreeze {
  warehouse_id: string;
  frozen: boolean;
  folio: string | null;
  count_id: string | null;
  status: string | null;
}

@Injectable({ providedIn: 'root' })
export class BinLocationService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/inventory`;

  listBins(warehouseId?: string): Observable<WarehouseBin[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<WarehouseBin[]>(`${this.base}/bins`, { params });
  }

  createBin(dto: { warehouse_id: string; aisle_id?: string; code: string; label?: string }): Observable<WarehouseBin> {
    return this.http.post<WarehouseBin>(`${this.base}/bins`, dto);
  }

  deleteBin(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/bins/${id}`);
  }

  binContents(id: string): Observable<LotLocation[]> {
    return this.http.get<LotLocation[]>(`${this.base}/bins/${id}/contents`);
  }

  /**
   * Escaneá el cartel del rack → la ubicación y lo que tiene adentro, en una
   * sola llamada. El almacén es **opcional** a propósito: quien llega con la
   * pistola no eligió ninguno, y es justo el paso que el escaneo evita.
   */
  lookupBin(code: string, warehouseId?: string): Observable<BinLookup> {
    let params = new HttpParams().set('code', code);
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<BinLookup>(`${this.base}/bins/lookup`, { params });
  }

  /**
   * Saber si un almacen esta congelado por un inventario fisico, ANTES de dejar
   * capturar. No reemplaza a los guards del servidor: los adelanta.
   */
  warehouseFreeze(warehouseId: string): Observable<WarehouseFreeze> {
    const params = new HttpParams().set('warehouse_id', warehouseId);
    return this.http.get<WarehouseFreeze>(`${this.base}/warehouse-freeze`, { params });
  }

  /**
   * Mover un lote de una ubicacion a otra. **No mueve existencia**: el total del
   * almacen no cambia, cambia donde esta.
   */
  moveLot(dto: MoveLotDto): Observable<MoveLotResult> {
    return this.http.post<MoveLotResult>(`${this.base}/move-lot`, dto);
  }

  putAway(dto: PutAwayDto): Observable<{ located: boolean; bin_id: string; lot_code: string; quantity: number }> {
    return this.http.post<{ located: boolean; bin_id: string; lot_code: string; quantity: number }>(`${this.base}/put-away`, dto);
  }

  locations(warehouseId?: string, productId?: string): Observable<LotLocation[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    if (productId) params = params.set('product_id', productId);
    return this.http.get<LotLocation[]>(`${this.base}/locations`, { params });
  }

  unlocated(warehouseId?: string, productId?: string): Observable<UnlocatedLot[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    if (productId) params = params.set('product_id', productId);
    return this.http.get<UnlocatedLot[]>(`${this.base}/unlocated`, { params });
  }

  pickSuggestion(warehouseId: string, productId: string): Observable<PickSuggestion[]> {
    const params = new HttpParams().set('warehouse_id', warehouseId).set('product_id', productId);
    return this.http.get<PickSuggestion[]>(`${this.base}/pick-suggestion`, { params });
  }
}
