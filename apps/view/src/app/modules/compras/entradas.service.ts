import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * CC (extensión) — cliente de Comprobantes de Orden de Entrada (proyecto Compras).
 * Lista las órdenes de entrada de Kepler (X-A-40) y les adjunta la remisión/factura
 * del proveedor (imagen/PDF) con OCR. No escribe a Kepler. Backend en `libs/finance`
 * (las evidencias viven en el schema `finance`), ruta `/finance/goods-receipts`.
 */

export type ProofStatus = 'recibido' | 'validado' | 'rechazado';

export interface EntradaRow {
  sucursal: string;
  folio: string;
  receipt_date: string | null;
  proveedor_code: string | null;
  proveedor_nombre: string | null;
  proveedor_rfc: string | null;
  oc_folio: string | null;
  concepto: string | null;
  monto: number;
  deposits: number;
  deposit_id: string | null;
  deposit_status: ProofStatus | null;
  monto_match: boolean;
}

export interface EntradasReport {
  kpis: { entradas: number; con_comprobante: number; validados: number; monto_pendiente: number };
  rows: EntradaRow[];
}

/** Campos que devuelve el OCR de la remisión/factura (preview antes de guardar). */
export interface RemisionOcr {
  folio: string | null;
  fecha: string | null;
  proveedor: string | null;
  rfc: string | null;
  subtotal: number | null;
  iva: number | null;
  total: number | null;
  ocr_status: string;
}

export interface ProofFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface AttachReceipt {
  sucursal: string;
  folio: string;
  files: ProofFile[];
  ocr?: Partial<RemisionOcr>;
  comentarios?: string;
}

@Injectable({ providedIn: 'root' })
export class EntradasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/goods-receipts`;

  list(q: { estado?: string; from?: string; to?: string; search?: string } = {}): Observable<EntradasReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<EntradasReport>(this.base, { params });
  }
  /** Corre OCR sobre la remisión (data URI, imagen/PDF) — preview, no guarda. */
  ocr(file_base64: string): Observable<RemisionOcr> {
    return this.http.post<RemisionOcr>(`${this.base}/ocr`, { file_base64 });
  }
  /** Sube la remisión a Cloudinary y devuelve su referencia. */
  uploadFile(file_base64: string, role = 'remision'): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** Adjunta la evidencia a la entrada (archivos ya subidos + OCR). */
  attach(body: AttachReceipt): Observable<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean }> {
    return this.http.post<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean }>(`${this.base}/attach`, body);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
}
