import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase WMS-REC (Pieza 1 — Modo recepción por escaneo / Vale vivo, ADR-044).
 * Consume `/commercial/receiving/sessions/*`.
 */

export type DiscrepancyKind = 'pending' | 'ok' | 'faltante' | 'sobrante' | 'producto_incorrecto' | 'dañado';

export interface ReceivingLine {
  id: string;
  product_id: string | null;
  sku?: string | null;
  product_name?: string | null;
  expected_sku?: string | null;
  expected_name?: string | null;
  expected_qty: number;
  received_qty: number;
  barcode_scanned?: string | null;
  discrepancy_kind: DiscrepancyKind;
  notes?: string | null;
}

export interface ReceivingSessionProgress {
  lines: number;
  pending: number;
  ok: number;
  discrepancies: number;
  expected_units: number;
  received_units: number;
}

export interface ReceivingSession {
  id: string;
  folio: string;
  warehouse_id: string;
  warehouse_code?: string;
  warehouse_name?: string;
  supplier_code?: string | null;
  source_kind: 'manual' | 'erp_receipt';
  source_ref?: string | null;
  status: 'open' | 'validating' | 'closed' | 'cancelled';
  notes?: string | null;
  created_at?: string;
  closed_at?: string | null;
  lines?: ReceivingLine[];
  progress?: ReceivingSessionProgress;
}

export interface ReceivingSessionListItem extends ReceivingSession {
  line_count: string | number;
  discrepancy_count: string | number;
}

export interface OpenSessionDto {
  warehouse_id: string;
  supplier_code?: string;
  source_kind?: 'manual' | 'erp_receipt';
  erp_sucursal?: string;
  erp_folio?: string;
  notes?: string;
}

@Injectable({ providedIn: 'root' })
export class ReceivingSessionService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/receiving/sessions`;

  open(dto: OpenSessionDto): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(this.base, dto);
  }

  list(filters: { status?: string; warehouse_id?: string; limit?: number } = {}): Observable<ReceivingSessionListItem[]> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<ReceivingSessionListItem[]>(this.base, { params });
  }

  detail(id: string): Observable<ReceivingSession> {
    return this.http.get<ReceivingSession>(`${this.base}/${id}`);
  }

  scan(id: string, dto: { barcode?: string; product_id?: string; qty?: number }): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(`${this.base}/${id}/scan`, dto);
  }

  setLine(id: string, lineId: string, patch: { received_qty?: number; discrepancy_kind?: DiscrepancyKind; notes?: string }): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(`${this.base}/${id}/lines/${lineId}`, patch);
  }

  addLine(id: string, dto: { product_id?: string; barcode?: string; expected_qty?: number }): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(`${this.base}/${id}/add-line`, dto);
  }

  close(id: string): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(`${this.base}/${id}/close`, {});
  }

  cancel(id: string): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(`${this.base}/${id}/cancel`, {});
  }
}
