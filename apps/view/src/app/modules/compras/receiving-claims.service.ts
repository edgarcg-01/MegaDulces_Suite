import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * WMS-REC.8 (ADR-053) — cliente de la bandeja de **reclamos de recepción**.
 *
 * Vive en `modules/compras` porque el que la abre todos los días es el comprador, pero
 * pega contra `commercial/receiving/*` (el dominio es la recepción, no el reabasto), así
 * que va aparte de `ComprasService` en vez de forzarle otra base URL.
 */

export type ClaimKind = 'faltante' | 'dañado' | 'producto_incorrecto';
export type ClaimStatus = 'open' | 'claimed' | 'accepted' | 'discarded' | 'written_off';
export type ClaimResponsibleKind = 'supplier' | 'branch';

export interface ReceivingClaim {
  id: string;
  folio: string;                 // vale VE-YYYY-NNNNN
  source_ref: string | null;     // sucursal/folio del documento del ERP
  kind: ClaimKind;
  status: ClaimStatus;
  sku: string | null;
  product_name: string | null;
  product_id: string | null;
  expected_qty: number;
  received_qty: number;
  /** null = falta capturarla (dañado / producto incorrecto). */
  qty_claimed: number | null;
  /** Unidad DEL DOCUMENTO (PZA/PAQ/CJA…) o 'ambigua'. Nunca se asume pieza. */
  qty_unit: string | null;
  unit_cost: number | null;
  /** Estimación para priorizar. null = sin costo en el documento (NO es $0). */
  amount: number | null;
  amount_source: 'erp_line' | 'sin_dato';
  responsible_kind: ClaimResponsibleKind;
  responsible_code: string | null;
  /** Nombre tal cual lo trae el documento. Nunca una sucursal deducida. */
  responsible_label: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  responsible_warehouse_id: string | null;
  responsible_warehouse_code: string | null;
  responsible_warehouse_name: string | null;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  opened_at: string;
  claimed_at: string | null;
  claimed_by_username: string | null;
  claim_channel: string | null;
  resolved_at: string | null;
  resolved_by_username: string | null;
  resolution_note: string | null;
  notes: string | null;
  age_days: number;
  vale_closed_at?: string | null;
  vale_status?: string | null;
}

export interface ReceivingClaimKpis {
  open_count: number;
  open_amount: number;
  open_without_amount: number;
  oldest_days: number;
  suppliers_open: number;
  transfer_open: number;
  transfer_without_owner: number;
  needs_qty: number;
}

export interface ReceivingClaimsPage {
  data: ReceivingClaim[];
  total: number;
  page: number;
  pageSize: number;
  kpis: ReceivingClaimKpis;
}

export interface TransferOriginMapped {
  code: string;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  note: string | null;
  updated_at: string;
}
export interface TransferOriginPending {
  code: string;
  doc_label: string | null;
  claims: number;
}

export interface ClaimsQuery {
  status?: string;                        // 'abiertos' | open | claimed | accepted | discarded | written_off
  responsible_kind?: ClaimResponsibleKind;
  kind?: ClaimKind;
  supplier_id?: string;
  warehouse_id?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class ReceivingClaimsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/receiving/claims`;

  list(q: ClaimsQuery = {}): Observable<ReceivingClaimsPage> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<ReceivingClaimsPage>(`${this.base}${qs ? '?' + qs : ''}`);
  }

  detail(id: string): Observable<ReceivingClaim> {
    return this.http.get<ReceivingClaim>(`${this.base}/${id}`);
  }

  /** Lo pasó al responsable (canal + nota). */
  markClaimed(id: string, body: { channel?: string; note?: string }): Observable<ReceivingClaim> {
    return this.http.post<ReceivingClaim>(`${this.base}/${id}/claim`, body);
  }

  /** Cantidad de un dañado / producto incorrecto (el andén no la tiene). */
  setQty(id: string, qty: number): Observable<ReceivingClaim> {
    return this.http.post<ReceivingClaim>(`${this.base}/${id}/qty`, { qty_claimed: qty });
  }

  resolve(id: string, body: { resolution: 'accepted' | 'discarded' | 'written_off'; note?: string }): Observable<ReceivingClaim> {
    return this.http.post<ReceivingClaim>(`${this.base}/${id}/resolve`, body);
  }

  transferOrigins(): Observable<{ mapped: TransferOriginMapped[]; pending: TransferOriginPending[] }> {
    return this.http.get<{ mapped: TransferOriginMapped[]; pending: TransferOriginPending[] }>(`${this.base}/transfer-origins`);
  }

  /** Captura del dueño de un traspaso: decisión humana, el ERP no la puede deducir. */
  setTransferOrigin(code: string, warehouseId: string, note?: string): Observable<{ code: string; warehouse_id: string; claims_reassigned: number }> {
    return this.http.post<{ code: string; warehouse_id: string; claims_reassigned: number }>(
      `${this.base}/transfer-origins`, { code, warehouse_id: warehouseId, note });
  }
}
