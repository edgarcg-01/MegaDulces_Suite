import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * CG.13/CG.17 — Cliente del libro de caja (ADR-070).
 *
 * Distinto de `caja.service.ts` (CG.1-CG.7), que lee el ESPEJO del Access `Control`. Éste
 * habla con el lado que ESCRIBE: la plataforma como fuente principal del efectivo.
 */

export type TipoMovimiento = 'ingreso' | 'gasto' | 'deposito';

export interface ConceptoKepler {
  sucursal: string;
  cuenta: string;
  concepto: string;
  concepto_nombre: string;
  cuenta_mayor: string;
}

export interface MovimientoCaja {
  id: string;
  folio: string;
  tipo: TipoMovimiento;
  fecha: string;
  hora: string | null;
  sucursal: string;
  centro_costo: string | null;
  kepler_cuenta: string;
  kepler_concepto: string;
  kepler_cuenta_nombre: string | null;
  kepler_concepto_nombre: string | null;
  glosa: string;
  beneficiario: string | null;
  monto: number;
  morralla: number;
  origen_tipo: string | null;
  origen_ref: string | null;
  estado: string;
  created_by_username: string | null;
  created_at: string;
  /** Procedencia de lo que autorrellenó el motor. Ausente = lo tecleó una persona. */
  autofill: Record<string, unknown> | null;
}

export interface LibroResponse {
  rows: MovimientoCaja[];
  kpi: { movimientos: number; ingresos: number; gastos: number; depositos: number };
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CoberturaResponse {
  catalogo: Array<{ sucursal: string; filas_origen: number; usables: number; sin_subcuenta: number; sin_codigo: number; sin_nombre: number }>;
  mapa: Array<{ source_caja: string; cuentas: number; con_propuesta: number; sin_propuesta: number; confirmadas: number; por_confirmar: number }>;
}

export interface Propuesta<T = unknown> {
  value: T | null;
  source: string | null;
  confidence: number | null;
  support?: number;
  supportRatio?: number;
  reason?: string;
}

export interface AutofillResponse {
  concepto: Propuesta<{ kepler_cuenta: string; kepler_concepto: string }>;
  documento: Propuesta<Record<string, unknown>>;
  provenance: Record<string, unknown>;
  /** Un nivel `sin_fuente` NO es "no propuso": es que no se pudo consultar. */
  niveles: Record<string, 'consultado' | 'sin_fuente'>;
}

@Injectable({ providedIn: 'root' })
export class CashLedgerService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/finance/cash-ledger`;

  libro(f: { from?: string; to?: string; tipo?: string; sucursal?: string; cuenta?: string; search?: string; limit?: number; offset?: number }): Observable<LibroResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<LibroResponse>(this.base, { params: p });
  }

  conceptos(sucursal?: string, search?: string, limit = 50): Observable<{ rows: ConceptoKepler[]; limit: number }> {
    let p = new HttpParams().set('limit', String(limit));
    if (sucursal) p = p.set('sucursal', sucursal);
    if (search) p = p.set('search', search);
    return this.http.get<{ rows: ConceptoKepler[]; limit: number }>(`${this.base}/conceptos`, { params: p });
  }

  cobertura(): Observable<CoberturaResponse> {
    return this.http.get<CoberturaResponse>(`${this.base}/cobertura`);
  }

  /** PROPONE. No guarda nada. Lo que no puede proponer vuelve en null con su motivo. */
  autofill(input: { tipo?: string; sucursal?: string; glosa?: string; beneficiario?: string; beneficiario_rfc?: string; legacy_cuenta?: string }): Observable<AutofillResponse> {
    return this.http.post<AutofillResponse>(`${this.base}/autofill`, input);
  }

  crear(body: Record<string, unknown>): Observable<MovimientoCaja> {
    return this.http.post<MovimientoCaja>(this.base, body);
  }

  detalle(id: string): Observable<MovimientoCaja & { denominaciones: Array<{ denominacion: number; piezas: number }>; arqueo: { desglosado: number; diferencia: number } | null }> {
    return this.http.get<any>(`${this.base}/${id}`);
  }
}
