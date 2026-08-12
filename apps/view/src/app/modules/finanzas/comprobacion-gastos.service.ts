import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * GX.8 — cliente de "Comprobación de Gastos" (2ª etapa). Captura la comprobación de
 * un gasto de Kepler (XA1001) + su archivo. No escribe a Kepler. Reusa el catálogo
 * de departamentos del módulo de reembolsos (mismo endpoint).
 */

export type ComprobacionStatus = 'recibida' | 'validada' | 'rechazada';
export type ComprobacionFileRole = 'comprobacion' | 'evidencia_1' | 'evidencia_2';
export interface ProofFile { role: ComprobacionFileRole | string; url: string; public_id?: string; kind?: string; name?: string; }
export interface Departamento { code: string; nombre: string; sucursal: string; }

/** Gasto de Kepler (XA1001) para el autocomplete del Folio del Gasto. */
export interface GastoSug {
  folio_gasto: string;
  fecha: string | null;
  proveedor: string | null;
  importe: number;
  solicitud_folio: string | null;
  sucursal: string | null;
  area: string | null;
}

export interface Comprobacion {
  id: string;
  solicitante: string;
  departamento: string;
  departamento_code: string | null;
  sucursal: string | null;
  folio_gasto: string;
  folio_solicitud: string | null;
  fecha_comprobacion: string | null;
  folio_comprobacion: string | null;
  proveedor: string;
  importe: number;
  files: ProofFile[];
  comentarios: string | null;
  status: ComprobacionStatus;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ComprobacionesReport {
  kpis: { total: number; recibidas: number; validadas: number; rechazadas: number };
  rows: Comprobacion[];
}

/** Un gasto de Kepler (XA1001) con el estado de su comprobación (vista por gasto). */
export interface GastoRow {
  sucursal: string | null;
  folio_gasto: string;
  fecha: string | null;
  proveedor: string | null;
  importe: number;
  solicitud_folio: string | null;
  area: string | null;
  comprobaciones: number;
  comprobacion_id: string | null;
  comprobacion_status: ComprobacionStatus | null;
  folio_comprobacion: string | null;
  files: ProofFile[];
}

export interface GastosReport {
  kpis: { gastos: number; comprobados: number; validados: number; monto_pendiente: number };
  rows: GastoRow[];
}

export interface CreateComprobacion {
  solicitante?: string;
  departamento?: string;
  departamento_code?: string;
  sucursal?: string;
  folio_gasto?: string;
  fecha_comprobacion?: string;
  folio_comprobacion?: string;
  proveedor?: string;
  importe?: number;
  comentarios?: string;
  files?: ProofFile[];
}

/** OCR del documento "Gastos" de Kepler (XA1001) → auto-rellena la captura. */
export interface KeplerGastosOcr {
  documento: string | null; folio: string | null; solicitante: string | null;
  proveedor_code: string | null; proveedor: string | null; a_nombre_de: string | null;
  autoriza: string | null; departamento: string | null; proyecto: string | null;
  cuenta: string | null; concepto: string | null; descripcion: string | null;
  moneda: string | null; fecha: string | null; fecha_pago: string | null;
  poliza: string | null; sucursal: string | null; comentarios: string | null;
  subtotal: number | null; iva: number | null; ieps: number | null;
  otro_impuesto: number | null; importe: number | null; anticipos: number | null;
  ocr_status: string;
}

@Injectable({ providedIn: 'root' })
export class ComprobacionGastosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses/comprobaciones`;
  private readonly proofsBase = `${environment.apiUrl}/finance/expenses/proofs`;

  list(q: { status?: string; folio_gasto?: string; search?: string; from?: string; to?: string } = {}): Observable<ComprobacionesReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<ComprobacionesReport>(this.base, { params });
  }
  /** Lista los gastos de Kepler (XA1001) + estado de su comprobación + KPIs (vista por gasto). */
  listGastos(q: { estado?: string; search?: string; from?: string; to?: string } = {}): Observable<GastosReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<GastosReport>(`${this.base}/gastos-list`, { params });
  }
  /** Autocomplete del Folio del Gasto (Kepler XA1001). */
  searchGastos(search: string): Observable<GastoSug[]> {
    return this.http.get<GastoSug[]>(`${this.base}/gastos`, { params: new HttpParams().set('search', search) });
  }
  uploadFile(file_base64: string, role: ComprobacionFileRole): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** OCR del documento "Gastos" de Kepler (XA1001) → campos para auto-rellenar. */
  ocr(file_base64: string): Observable<KeplerGastosOcr> {
    return this.http.post<KeplerGastosOcr>(`${this.base}/ocr`, { file_base64 });
  }
  create(body: CreateComprobacion): Observable<{ id: string; folio_gasto: string; folio_solicitud: string | null; status: string }> {
    return this.http.post<{ id: string; folio_gasto: string; folio_solicitud: string | null; status: string }>(this.base, body);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  /** Reusa el catálogo de departamentos del módulo de reembolsos. */
  departamentos(): Observable<Departamento[]> { return this.http.get<Departamento[]>(`${this.proofsBase}/departamentos`); }
  /** Mapa folio_solicitud → estado, para el overlay de comprobación en /finanzas/solicitudes. */
  statusBySolicitud(): Observable<Record<string, string>> { return this.http.get<Record<string, string>>(`${this.base}/status-by-solicitud`); }
}
