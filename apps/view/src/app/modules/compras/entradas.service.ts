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
  source_branch: string | null; // md_* = Kepler, wincaja_* = Wincaja (define el set de docs requeridos)
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

/** Un archivo ya subido a una entrada (o su duplicado) — para reportar dónde ya vive. */
export interface DuplicateHit { reason: 'file' | 'folio'; sucursal: string; folio: string; proveedor?: string | null; }

/** RE.11.0 — un renglón de producto extraído de la remisión (materia prima del match por línea). */
export interface RemisionLine {
  descripcion: string | null;
  cantidad: number | null;
  unidad: string | null;
  sku_proveedor: string | null;
  codigo_barras: string | null;
  precio_unitario: number | null;
  importe: number | null;
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
  sha256?: string;               // hash del contenido (anti-hoja-duplicada)
  duplicate?: DuplicateHit | null; // ya subida antes (misma hoja o folio)
  // RE (#4/pkt.1) — documentos detectados en el archivo, anclados a evidencia (página + prueba).
  documents_present?: DocPresence[];
  // RE.11.0 — renglones extraídos (para conciliación por línea).
  lines?: RemisionLine[];
}

/** RE.11.2 — un renglón conciliado: remisión ↔ línea Kepler ↔ SKU resuelto. */
export interface ReconciledLine {
  idx: number;
  remision: RemisionLine;
  kepler: { linea: string; sku: string | null; nombre: string | null; unidad: string | null; cantidad: number; costo_unitario: number; importe: number } | null;
  resolved_sku: string | null;
  resolved_nombre: string | null;
  method: 'alias' | 'barcode' | 'descripcion' | 'sin_match';
  score: number;
  box_factor: number;
  qty_remision_pz: number | null;
  qty_kepler: number | null;
  qty_match: boolean | null;
  price_match: boolean | null;
  status: 'cuadra' | 'difiere_cantidad' | 'difiere_precio' | 'revisar' | 'sin_match';
  alias_hit: boolean;
}

export interface ReconcileResult {
  sucursal: string;
  folio: string;
  proveedor_rfc: string | null;
  proveedor_nombre: string | null;
  lines: ReconciledLine[];
  kepler_orphans: { linea: string; sku: string | null; nombre: string | null; unidad: string | null; cantidad: number; costo_unitario: number; importe: number }[];
  totals: { lineas_remision: number; lineas_kepler: number; cuadran: number; difieren: number; sin_match: number; revisar: number; kepler_orphans: number };
}

/** RE.pkt.1 — un documento detectado dentro del paquete, con su página y prueba. */
export interface DocPresence {
  type: string;              // aplica_orden_entrada|factura|remision|ticket|orden_recepcion|vale|otro
  page: number | null;       // página 1-based (null si imagen suelta)
  evidence: string | null;   // folio/título/línea distintiva que lo identifica
}

export interface ProofFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string;
  sha256?: string; ocr_folio?: string | null; ocr_total?: number | null; ocr_fecha?: string | null; ocr_rfc?: string | null;
}

/** Línea de detalle de una orden de entrada (kdm2) para auditar renglón por renglón. */
export interface EntradaLinea {
  linea: string;
  sku: string | null;
  nombre: string | null;
  unidad: string | null;
  cantidad: number;
  costo_unitario: number;
  importe: number;
}

/** Una remisión/factura adjunta (archivos + OCR + estado) — devuelta por detail(). */
export interface ReceiptDeposit {
  id: string;
  files: ProofFile[];
  ocr_folio: string | null;
  ocr_fecha: string | null;
  ocr_proveedor: string | null;
  ocr_rfc: string | null;
  ocr_subtotal: number | null;
  ocr_iva: number | null;
  ocr_monto: number | null;
  ocr_status: string;
  ocr_lines?: RemisionLine[];        // RE.11.0 — renglones OCR persistidos (para conciliar)
  monto_match: boolean | null;
  discrepancy_kind: string | null;   // RE.2 — cuadra/iva/typo/otro (clasificación del descuadre)
  discrepancy_amount: number | null; // RE.2 — |factura − entrada|
  status: ProofStatus;
  comentarios: string | null;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface EntradaDetail {
  entrada: {
    sucursal: string; folio: string; receipt_date: string | null;
    proveedor_code: string | null; proveedor_nombre: string | null; proveedor_rfc: string | null;
    oc_folio: string | null; vale_folio: string | null; concepto: string | null; monto: number;
  };
  lineas: EntradaLinea[];
  deposits: ReceiptDeposit[];
  // RE.12 — copia(s) CEDIS ('00') espejo de esta canónica (misma recepción, otra póliza).
  cedis_twins?: { sucursal: string; folio: string; receipt_date: string | null; oc_folio: string | null; vale_folio: string | null; monto: number }[];
}

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
  /** Detalle de la entrada + sus líneas (kdm2) para auditar renglón por renglón. */
  detail(sucursal: string, folio: string): Observable<EntradaDetail> {
    return this.http.get<EntradaDetail>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}`);
  }
  /** Corre OCR sobre una hoja (data URI, imagen/PDF) — preview, no guarda. Devuelve
   *  también el hash + si es duplicada (misma hoja o folio ya subido). `role` afina el dedup. */
  ocr(file_base64: string, role?: string): Observable<RemisionOcr> {
    return this.http.post<RemisionOcr>(`${this.base}/ocr`, { file_base64, role });
  }
  /** FOTO-PRIMERO: enlaza por OCR de la Aplica Orden Entrada (folio/total) o busca manual. */
  matchByOcr(q: { folio?: string; total?: number; fecha?: string; search?: string }): Observable<{ entradas: EntradaRow[] }> {
    let p = new HttpParams();
    if (q.folio) p = p.set('folio', q.folio);
    if (q.total != null) p = p.set('total', String(q.total));
    if (q.fecha) p = p.set('fecha', q.fecha);
    if (q.search) p = p.set('search', q.search);
    return this.http.get<{ entradas: EntradaRow[] }>(`${this.base}/match`, { params: p });
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
  /** RE.11.2 — concilia los renglones de la remisión contra las líneas Kepler de la entrada. */
  reconcile(sucursal: string, folio: string, lines: RemisionLine[]): Observable<ReconcileResult> {
    return this.http.post<ReconcileResult>(`${this.base}/reconcile`, { sucursal, folio, lines });
  }
  /** RE.11.4 — aprende un match: descripción del proveedor → SKU interno. */
  confirmLine(body: { proveedor_rfc: string; descripcion: string; sku: string; nombre_interno?: string; unidad_proveedor?: string; box_factor?: number }): Observable<{ id: string; sku: string; veces_confirmado: number; confianza: number }> {
    return this.http.post<{ id: string; sku: string; veces_confirmado: number; confianza: number }>(`${this.base}/confirm-line`, body);
  }
}
