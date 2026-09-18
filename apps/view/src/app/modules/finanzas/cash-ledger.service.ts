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

  // ── CG.15 · corte, saldo y cancelación ───────────────────────────────────────────────

  /** `saldo: null` + `sin_corte_abierto` NO es cero: la caja no tiene punto de partida. */
  saldo(sucursal: string): Observable<SaldoResponse> {
    return this.http.get<SaldoResponse>(`${this.base}/saldo/${encodeURIComponent(sucursal)}`);
  }

  cortes(f: { from?: string; to?: string; sucursal?: string; estado?: string; limit?: number } = {}): Observable<{ rows: CorteCaja[]; limit: number }> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<{ rows: CorteCaja[]; limit: number }>(`${this.base}/cortes`, { params: p });
  }

  abrirCorte(body: { fecha: string; sucursal: string; fondo_inicial?: number; nota?: string }): Observable<CorteCaja> {
    return this.http.post<CorteCaja>(`${this.base}/cortes`, body);
  }

  /** La MISMA cuenta que se congela al cerrar: el capturista ve la diferencia mientras cuenta. */
  previaCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla = 0): Observable<{ corte: CorteCaja; totales: TotalesCorte }> {
    return this.http.post<{ corte: CorteCaja; totales: TotalesCorte }>(`${this.base}/cortes/${id}/previa`, { conteo, morralla });
  }

  cerrarCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla = 0, nota?: string): Observable<CorteCaja & { totales: TotalesCorte }> {
    return this.http.post<CorteCaja & { totales: TotalesCorte }>(`${this.base}/cortes/${id}/cerrar`, { conteo, morralla, nota });
  }

  /** Devuelve 403 si lo intenta quien cerró: la doble llave está en la DB, no acá. */
  autorizarCorte(id: string): Observable<CorteCaja> {
    return this.http.post<CorteCaja>(`${this.base}/cortes/${id}/autorizar`, {});
  }

  cancelar(id: string, motivo: string): Observable<MovimientoCaja> {
    return this.http.post<MovimientoCaja>(`${this.base}/${id}/cancelar`, { motivo });
  }
}

export interface CorteCaja {
  id: string;
  folio: string;
  fecha: string;
  sucursal: string;
  estado: 'borrador' | 'cerrado' | 'autorizado';
  fondo_inicial: number;
  total_ingresos: number | null;
  total_gastos: number | null;
  total_depositos: number | null;
  esperado: number | null;
  contado: number | null;
  diferencia: number | null;
  closed_by: string | null;
  closed_by_username: string | null;
  authorized_by_username: string | null;
  nota: string | null;
}

export interface TotalesCorte {
  ingresos: number; gastos: number; depositos: number;
  esperado: number; contado: number; diferencia: number;
  veredicto: 'cuadra' | 'sobra' | 'falta' | 'sin_contar';
  movimientos: number; cancelados: number;
}

export interface SaldoResponse {
  sucursal: string;
  corte_abierto: { id: string; folio: string; fondo_inicial: number } | null;
  saldo: number | null;
  sin_corte_abierto: boolean;
  movimientos_sueltos: number;
  totales: TotalesCorte;
}
