import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 * Consume `/commercial/receiving/*`.
 */

export interface ExpiryOcrResult {
  lot_code: string | null;
  expiry_date: string | null;
  confidence: number | null;
}

export interface ReceivingCapture {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  warehouse_name?: string;
  product_id: string;
  sku?: string | null;
  product_name?: string | null;
  supplier_code?: string | null;
  source_ref?: string | null;
  quantity: number;
  confirmed_lot: string;
  confirmed_expiry: string | null;
  existing_min_expiry: string | null;
  days_of_life: number | null;
  ocr_lot?: string | null;
  ocr_expiry?: string | null;
  ocr_confidence?: number | null;
  photo_url?: string;
  verdict: 'green' | 'yellow' | 'red';
  rule_broken: string | null;
  status: 'accepted' | 'pending_authorization' | 'authorized' | 'rejected';
  authorized_by?: string | null;
  authorized_at?: string | null;
  resolution_notes?: string | null;
  created_at: string;
}

export interface EvaluatePayload {
  warehouse_id: string;
  product_id: string;
  supplier_code?: string;
  source_ref?: string;
  /** Renglón del vale al que pertenece este lote (ADR-044). */
  receiving_line_id?: string;
  quantity: number;
  confirmed_lot?: string;
  confirmed_expiry?: string;
  ocr_lot?: string;
  ocr_expiry?: string;
  ocr_confidence?: number;
  photo_data_uri?: string;
}

export interface SupplierScore {
  supplier_code: string;
  receptions: string | number;
  nonconformities: string | number;
  reds: string | number;
  rejected: string | number;
  nc_rate_pct: string | number | null;
}

export interface ReceivingPolicy {
  id: string;
  product_id?: string | null;
  sku?: string | null;
  product_name?: string | null;
  category?: string | null;
  supplier_code?: string | null;
  min_shelf_life_days?: number | null;
  allow_older_than_existing: boolean;
  source?: string;
  notes?: string | null;
  updated_at?: string;
}

/** Lo mínimo para fechar algo: identidad del producto con su UUID. */
export interface ProductoFechable {
  product_id: string;
  sku: string | null;
  product_name: string | null;
  barcode: string | null;
}

@Injectable({ providedIn: 'root' })
export class ReceivingAuditorService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/receiving`;

  ocr(photoDataUri: string): Observable<ExpiryOcrResult> {
    return this.http.post<ExpiryOcrResult>(`${this.base}/lot-capture`, { photo_data_uri: photoDataUri });
  }

  /**
   * Código escaneado → producto **fechable** (con `product_id` real).
   *
   * No se reusa el `resolve` de Conteo: aquél devuelve `product_id: null` cuando
   * el producto viene del catálogo de almacén, y `evaluate()` exige un UUID — el
   * escaneo se vería bien y el guardado fallaría después.
   */
  resolveForDating(code: string): Observable<ProductoFechable> {
    return this.http.get<ProductoFechable>(`${this.base}/resolve`, {
      params: new HttpParams().set('code', code),
    });
  }

  evaluate(payload: EvaluatePayload): Observable<ReceivingCapture> {
    return this.http.post<ReceivingCapture>(`${this.base}/evaluate`, payload);
  }

  listCaptures(filters: { warehouse_id?: string; supplier_code?: string; verdict?: string; status?: string; receiving_line_id?: string; session_id?: string; limit?: number } = {}): Observable<ReceivingCapture[]> {
    let params = new HttpParams();
    if (filters.receiving_line_id) params = params.set('receiving_line_id', filters.receiving_line_id);
    if (filters.session_id) params = params.set('session_id', filters.session_id);
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.supplier_code) params = params.set('supplier_code', filters.supplier_code);
    if (filters.verdict) params = params.set('verdict', filters.verdict);
    if (filters.status) params = params.set('status', filters.status);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<ReceivingCapture[]>(`${this.base}/captures`, { params });
  }

  scorecard(): Observable<SupplierScore[]> {
    return this.http.get<SupplierScore[]>(`${this.base}/scorecard`);
  }

  authorize(id: string, notes?: string): Observable<ReceivingCapture> {
    return this.http.post<ReceivingCapture>(`${this.base}/captures/${id}/authorize`, { notes });
  }

  reject(id: string, notes?: string): Observable<ReceivingCapture> {
    return this.http.post<ReceivingCapture>(`${this.base}/captures/${id}/reject`, { notes });
  }

  listPolicies(): Observable<ReceivingPolicy[]> {
    return this.http.get<ReceivingPolicy[]>(`${this.base}/policy`);
  }

  upsertPolicy(dto: Partial<ReceivingPolicy>): Observable<ReceivingPolicy> {
    return this.http.post<ReceivingPolicy>(`${this.base}/policy`, dto);
  }

  deletePolicy(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/policy/${id}`);
  }
}
