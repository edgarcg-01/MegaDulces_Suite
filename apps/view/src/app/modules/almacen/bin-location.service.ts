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

export interface PutAwayDto {
  warehouse_id: string;
  product_id: string;
  lot_code?: string;
  expiry_date?: string;
  bin_id?: string;
  bin_code?: string;
  quantity: number;
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
