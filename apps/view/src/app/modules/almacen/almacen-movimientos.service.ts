import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * DM — Diario de movimientos (mejora del reporte Kepler). Cliente de
 * /commercial/movements. Agregación primero (summary/aggregate), drill por folio (lines).
 */

export type GroupBy = 'product' | 'doc_code' | 'day' | 'warehouse';
export type MovementKind = 'entrada' | 'salida';

export type TransferDocStatus = 'en_transito' | 'completado' | 'diferencia';

export interface MovementsFilters {
  warehouse_ids?: string[];
  from?: string;
  to?: string;
  doc_code?: string;
  movement_kind?: MovementKind | '';
  search?: string;
  estado?: TransferDocStatus | '';
  /** Traspasos cuyo ORIGEN o DESTINO (propio o contraparte) ∈ selección. Activa modo solo-traspasos. */
  transfer_wh_ids?: string[];
}

export interface MovementTotals {
  entradas: number; salidas: number; neto: number; valor: number;
  lineas: number; documentos: number;
}
export interface MovementByType {
  doc_code: string; movement_label: string; movement_kind: MovementKind;
  piezas: number; valor: number; lineas: number;
}
export interface MovementsSummary {
  range: { from: string; to: string };
  totals: MovementTotals;
  by_type: MovementByType[];
}

export interface AggregateRow {
  key: string; label: string; sku?: string; code?: string; movement_kind?: MovementKind;
  entradas: number; salidas: number; neto: number; valor: number | null;
  lineas: number; documentos: number;
}
export interface AggregateResponse {
  group_by: GroupBy; page: number; pageSize: number; total: number; rows: AggregateRow[];
}

export interface MovementLine {
  warehouse_id?: string;
  doc_date: string; folio: string; doc_code: string; movement_label: string;
  movement_kind: MovementKind; genero: string; naturaleza: string; doc_type: string;
  signed_qty: number; qty: number; unit_cost: number | null; amount: number | null;
  parent_group: string | null; parent_folio: string | null; source_branch: string;
  product_name: string | null; sku: string | null; warehouse_code: string | null;
}
/** Fila del drill de folios: un DOCUMENTO englobado (folio×tipo×serie×almacén), no una línea. */
export interface FolioRow {
  warehouse_id: string; folio: string; doc_code: string; doc_serie: string | null; movement_label: string;
  movement_kind: MovementKind; source_branch: string; warehouse_code: string | null; warehouse_name: string | null;
  doc_date: string; lineas: number; signed_qty: number; qty: number; amount: number | null;
  parent_group: string | null; parent_serie: string | null; parent_folio: string | null;
  audited: boolean; audited_by: string | null; audited_at: string | null;
  /** Solo docs de traspaso: en_transito | completado | diferencia. */
  transfer_status?: TransferDocStatus | null;
}
export interface LinesResponse { page: number; pageSize: number; total: number; rows: FolioRow[]; }

/** DM.3 — validación salida↔recepción de traspasos. origin_wh/dest_wh traen el NOMBRE del almacén (fallback código). */
export type TransferStatus = 'ok' | 'diferencia' | 'sin_recepcion' | 'sin_origen';
export interface TransferCheckRow {
  origin_wh_id: string | null; origin_wh: string | null; origin_folio: string | null;
  doc_serie: string | null; ship_date: string | null; qty_sent: number | null; amount: number | null; ship_lines: number | null;
  dest_wh_id: string | null; dest_wh: string | null; rcv_folio: string | null;
  rcv_date: string | null; qty_received: number | null; rcv_lines: number | null;
  status: TransferStatus; delta: number;
}
export interface TransfersCheckResponse {
  range: { from: string; to: string };
  totals: { ok: number; diferencia: number; sin_recepcion: number; sin_origen: number };
  rows: TransferCheckRow[];
}

export interface DocumentCounterpart {
  kind: 'recepcion' | 'origen';
  docs: { folio: string; warehouse_id: string; warehouse_code: string | null; warehouse_name: string | null; doc_code: string; doc_serie: string | null; doc_date: string; qty: number; lineas: number }[];
  qty: number; delta: number; status: 'ok' | 'diferencia' | 'sin_recepcion' | 'sin_origen';
}

export interface DocumentHeader {
  folio: string; doc_code: string; doc_serie: string | null; movement_label: string; movement_kind: MovementKind;
  doc_date: string; genero: string; naturaleza: string; doc_type: string;
  warehouse_id: string; warehouse_code: string | null; warehouse_name: string | null; source_branch: string;
  parent_group: string | null; parent_folio: string | null;
  audited: boolean; audited_by: string | null; audited_at: string | null;
}
export interface DocumentResponse {
  header: DocumentHeader | null;
  lines: MovementLine[];
  totals: { qty: number; amount: number; lineas: number };
  counterpart: DocumentCounterpart | null;
}

export interface MovementsFilterOpts {
  warehouses: { id: string; code: string; name: string }[];
  doc_types: { doc_code: string; movement_label: string; movement_kind: MovementKind }[];
}

@Injectable({ providedIn: 'root' })
export class AlmacenMovimientosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/movements`;

  private params(f: MovementsFilters, extra: Record<string, string | number | undefined> = {}): HttpParams {
    let p = new HttpParams();
    if (f.warehouse_ids?.length) p = p.set('warehouse_ids', f.warehouse_ids.join(','));
    if (f.from) p = p.set('from', f.from);
    if (f.to) p = p.set('to', f.to);
    if (f.doc_code) p = p.set('doc_code', f.doc_code);
    if (f.movement_kind) p = p.set('movement_kind', f.movement_kind);
    if (f.search) p = p.set('search', f.search);
    if (f.estado) p = p.set('estado', f.estado);
    if (f.transfer_wh_ids?.length) p = p.set('transfer_wh_ids', f.transfer_wh_ids.join(','));
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p = p.set(k, String(v));
    return p;
  }

  summary(f: MovementsFilters): Observable<MovementsSummary> {
    return this.http.get<MovementsSummary>(`${this.base}/summary`, { params: this.params(f) });
  }
  aggregate(f: MovementsFilters, group_by: GroupBy, page: number, pageSize: number): Observable<AggregateResponse> {
    return this.http.get<AggregateResponse>(`${this.base}/aggregate`, { params: this.params(f, { group_by, page, pageSize }) });
  }
  lines(f: MovementsFilters, extra: { product_id?: string; page?: number; pageSize?: number }): Observable<LinesResponse> {
    return this.http.get<LinesResponse>(`${this.base}/lines`, { params: this.params(f, extra) });
  }
  document(folio: string, warehouse_id?: string, doc_code?: string, doc_serie?: string | null): Observable<DocumentResponse> {
    let p = new HttpParams().set('folio', folio);
    if (warehouse_id) p = p.set('warehouse_id', warehouse_id);
    if (doc_code) p = p.set('doc_code', doc_code);
    if (doc_serie) p = p.set('doc_serie', doc_serie);
    return this.http.get<DocumentResponse>(`${this.base}/document`, { params: p });
  }
  transfersCheck(f: MovementsFilters): Observable<TransfersCheckResponse> {
    return this.http.get<TransfersCheckResponse>(`${this.base}/transfers-check`, { params: this.params(f) });
  }
  setAudit(dto: { warehouse_id: string; doc_code: string; doc_serie?: string | null; folio: string; audited: boolean; note?: string | null }): Observable<{ audited: boolean; audited_by?: string | null }> {
    return this.http.post<{ audited: boolean; audited_by?: string | null }>(`${this.base}/audit`, dto);
  }
  filters(): Observable<MovementsFilterOpts> {
    return this.http.get<MovementsFilterOpts>(`${this.base}/filters`);
  }
  /** DM.6 — descarga XLSX/PDF del diario con los filtros actuales. */
  downloadExport(f: MovementsFilters, format: 'xlsx' | 'pdf') {
    return this.http.get(`${this.base}/export.${format}`, {
      params: this.params(f), responseType: 'blob', observe: 'response',
    });
  }
}
