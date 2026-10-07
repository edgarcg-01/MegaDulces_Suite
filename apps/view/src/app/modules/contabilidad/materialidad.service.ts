import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.10.1 — cliente del expediente de materialidad. /fiscal/materialidad. */

export interface MaterialidadDossier {
  rfc: string;
  beneficiario: string | null;
  operaciones: number;
  monto_total: number;
  periodo: { desde: string | null; hasta: string | null };
  listas_negras: { lista: string; situacion: string; nombre: string | null; doc_count: number; importe_total: number; estado: string }[];
  en_lista_riesgo: boolean;
  cfdis: { total: number; cancelados: number; monto: number };
  cadena_suministro: { cadenas: number; con_orden: number; con_recepcion: number; con_pago: number; recepcion_pct: number };
  veredicto: { nivel: string; mensaje: string };
}

/** MAT.2 — una fila por factura de compra con sus documentos relacionados. */
export interface MaterialidadChain {
  key: string;
  sucursal: string;
  factura_folio: string; factura_fecha: string | null;
  orden_folio: string | null; orden_fecha: string | null;
  recepcion_folio: string | null; recepcion_fecha: string | null;
  pago_folio: string | null; pago_fecha: string | null;
  total: number;
  lead_days: number | null; pago_days: number | null;
  match_confidence: string | null;
  completa: boolean;
}

/** MAT.1 — un CFDI recibido con su asignación confirmada o la operación sugerida. */
export interface MatReconcileRow {
  cfdi_id: string; uuid: string; serie: string | null; folio: string | null; fecha: string | null;
  total: number; tipo_comprobante: string | null; metodo_pago: string | null; estatus_sat: string; has_xml: boolean;
  status: 'confirmed' | 'suggested' | 'unmatched';
  assignment: { id: string; sucursal: string; doc_tipo: string; doc_folio: string; importe_operacion: number | null; diff_importe: number | null; diff_days: number | null; by: string | null; at: string | null } | null;
  suggestion: { sucursal: string; doc_tipo: string; doc_folio: string; importe: number | null; fecha: string | null; diff_importe: number | null; diff_days: number | null; beneficiario: string | null; strength: 'strong' | 'weak' } | null;
}
export interface MatAssignInput { cfdi_id: string; sucursal: string; doc_tipo?: string; doc_folio: string; note?: string; }

/** MAT — fila del índice de descubrimiento de proveedores (rankeado por riesgo). */
export interface MatProvider {
  rfc: string; beneficiario: string | null; ops: number; monto: number;
  desde: string | null; hasta: string | null;
  cadenas: number; con_recepcion: number; recepcion_pct: number | null;
  en_lista: boolean; en_riesgo: boolean;
}

@Injectable({ providedIn: 'root' })
export class MaterialidadService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/materialidad`;

  /** MAT — descubrimiento: índice de proveedores para explorar sin teclear el RFC. */
  providers(q: { search?: string; riesgo?: string; limit?: number } = {}): Observable<MatProvider[]> {
    const p = new URLSearchParams();
    if (q.search) p.set('search', q.search);
    if (q.riesgo) p.set('riesgo', q.riesgo);
    if (q.limit != null) p.set('limit', String(q.limit));
    const s = p.toString();
    return this.http.get<MatProvider[]>(`${this.base}${s ? '?' + s : ''}`);
  }

  dossier(rfc: string): Observable<MaterialidadDossier> { return this.http.get<MaterialidadDossier>(`${this.base}/${encodeURIComponent(rfc)}`); }
  /** MAT.2 — desglose de documentos de la cadena de suministro del RFC. */
  chains(rfc: string): Observable<MaterialidadChain[]> { return this.http.get<MaterialidadChain[]>(`${this.base}/${encodeURIComponent(rfc)}/chains`); }
  /** MAT.1 — conciliación CFDI↔operación del proveedor (asignación confirmada o sugerida). */
  reconcile(rfc: string): Observable<MatReconcileRow[]> { return this.http.get<MatReconcileRow[]>(`${this.base}/${encodeURIComponent(rfc)}/reconcile`); }
  confirmAssign(b: MatAssignInput): Observable<unknown> { return this.http.post(`${this.base}/assignments/confirm`, b); }
  rejectAssign(b: MatAssignInput): Observable<unknown> { return this.http.post(`${this.base}/assignments/reject`, b); }
  unassign(id: string): Observable<unknown> { return this.http.delete(`${this.base}/assignments/${encodeURIComponent(id)}`); }
}
