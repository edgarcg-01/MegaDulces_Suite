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
  /** Σ de lotes declarados para este renglón (ADR-044). Puede llegar como string (numeric). */
  declared_qty?: number | string;
  /** Piezas retenidas por un rojo sin autorizar (no entraron a stock). */
  held_qty?: number | string;
  /** Cantidad de capturas en pending_authorization. */
  holds?: number;
  /** Unidad TAL CUAL la manda el vale del ERP (PAQ/PZA/KG/CJA/BTO…). Derivada, no copiada. */
  expected_unit?: string | null;
}

/** Ficha del vale del ERP — derivada del espejo al leer, no almacenada. */
export interface ErpVale {
  sucursal: string;
  folio: string;
  doc_prefix?: string | null;
  receipt_date?: string | null;
  proveedor_code?: string | null;
  proveedor_nombre?: string | null;
  proveedor_rfc?: string | null;
  oc_folio?: string | null;
  vale_folio?: string | null;
  concepto?: string | null;
  monto: number;
  tipo: 'compra' | 'traspaso';
  services?: { nombre?: string | null; cantidad?: number | string | null; importe?: number | string | null }[];
}

export interface ReceivingSessionProgress {
  lines: number;
  pending: number;
  ok: number;
  discrepancies: number;
  expected_units: number;
  received_units: number;
  /** ADR-044 — cuadre de trazabilidad de caducidad. */
  declared_units?: number;
  undeclared_units?: number;
  held_units?: number;
  holds?: number;
  /** Renglones recibidos cuyo SKU no está en el catálogo: no entran a inventario. */
  sin_catalogo?: number;
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
  /** Datos del vale del ERP (solo si source_kind='erp_receipt'). */
  erp?: ErpVale | null;
}

export interface ReceivingSessionListItem extends ReceivingSession {
  line_count: string | number;
  discrepancy_count: string | number;
}

export interface OpenSessionDto {
  /** Opcional desde el ERP: el backend lo deriva de la orden elegida (ADR-044). */
  warehouse_id?: string;
  supplier_code?: string;
  source_kind?: 'manual' | 'erp_receipt';
  erp_sucursal?: string;
  erp_folio?: string;
  notes?: string;
}

export interface ErpOrderLookup {
  sucursal: string;
  folio: string;
  proveedor_code?: string | null;
  proveedor_nombre?: string | null;
  monto: number;
  receipt_date?: string | null;
  line_count: number;
  tipo?: 'compra' | 'traspaso';
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
}

/**
 * Renglón esperando fecha de caducidad: mercancía que ya pasó la luz verde en
 * recepción y está en existencia sin fecha. Es la cola de trabajo del bodeguero.
 */
export interface PendingExpiryLine {
  line_id: string;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  received_qty: number;
  declared_qty: number;
  /** Capturado con fecha pero 🔴: espera autorización de un supervisor. */
  held_qty: number;
  pending_qty: number;
  session_id: string;
  vale_folio: string;
  source_ref: string | null;
  supplier_code: string | null;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  closed_at: string;
  dias_esperando: number;
}

export interface SucursalMapEntry {
  sucursal: string;
  warehouse_id: string;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
}

/** Una coincidencia de la búsqueda por folio: trae TODO lo que llena el vale. */
export interface ErpOrderMatch {
  sucursal: string;
  folio: string;
  receipt_date?: string | null;
  proveedor_code?: string | null;
  proveedor_nombre?: string | null;
  proveedor_rfc?: string | null;
  oc_folio?: string | null;
  vale_folio?: string | null;
  concepto?: string | null;
  monto: number;
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  line_count: number;
  service_count: number;
  tipo: 'compra' | 'traspaso';
}

@Injectable({ providedIn: 'root' })
export class ReceivingSessionService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/receiving/sessions`;

  open(dto: OpenSessionDto): Observable<ReceivingSession> {
    return this.http.post<ReceivingSession>(this.base, dto);
  }

  /** Busca órdenes del ERP SOLO por folio, en todas las sucursales (ADR-044). */
  searchErpOrders(folio: string): Observable<ErpOrderMatch[]> {
    const params = new HttpParams().set('folio', folio);
    return this.http.get<ErpOrderMatch[]>(`${this.base}/erp-search`, { params });
  }

  lookupErpOrder(sucursal: string, folio: string): Observable<ErpOrderLookup> {
    const params = new HttpParams().set('sucursal', sucursal).set('folio', folio);
    return this.http.get<ErpOrderLookup>(`${this.base}/erp-order`, { params });
  }

  getSucursalMap(): Observable<SucursalMapEntry[]> {
    return this.http.get<SucursalMapEntry[]>(`${this.base}/sucursal-map`);
  }

  setSucursalMap(sucursal: string, warehouse_id: string): Observable<{ sucursal: string; warehouse_id: string }> {
    return this.http.post<{ sucursal: string; warehouse_id: string }>(`${this.base}/sucursal-map`, { sucursal, warehouse_id });
  }

  list(filters: { status?: string; warehouse_id?: string; limit?: number } = {}): Observable<ReceivingSessionListItem[]> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<ReceivingSessionListItem[]>(this.base, { params });
  }

  /** Bandeja de Caducidades: lo aprobado en recepción que aún no tiene fecha. */
  pendingExpiry(filters: { warehouse_id?: string; limit?: number } = {}): Observable<PendingExpiryLine[]> {
    let params = new HttpParams();
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<PendingExpiryLine[]>(`${this.base}/pending-expiry`, { params });
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
