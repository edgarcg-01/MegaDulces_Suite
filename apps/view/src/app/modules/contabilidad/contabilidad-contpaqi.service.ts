import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase CP (ADR-040) — cliente de la superficie ContPAQi en Contabilidad (`/contabilidad/contpaqi`).
 * Los endpoints reusan la lógica de Maat, que devuelve las filas en formato columnar `col()`
 * (`{columns, data}`) para token-diet del LLM → aquí las des-columnarizamos a objetos.
 */

type Col = { columns: string[]; data: any[][] };
function fromCol(c: Col | undefined): Record<string, any>[] {
  if (!c || !Array.isArray(c.columns) || !Array.isArray(c.data)) return [];
  return c.data.map((row) => Object.fromEntries(c.columns.map((k, i) => [k, row[i]])));
}

/** LC.21: `clave` = el valor crudo del grupo (cuenta, familia, mes o agrupador), para pedir lo de adentro. */
export interface BalanzaRow { key?: string; cuenta?: string; familia?: string; mes?: string; agrupador_sat?: string; clave?: string | null; cargos: number; abonos: number; neto: number; movs?: number; }
/** LC.21: `total_grupos` = cuántos hay en total (la página trae `limit` desde `offset`). */
export interface BalanzaResp { fuente: string; from_mes: string; to_mes: string; total_grupos?: number; offset?: number; limit?: number; rows: BalanzaRow[]; }
export interface BankRow { banco?: string; mes?: string; cuenta?: string | null; depositos: number; retiros: number; neto: number; movs: number; }
export interface BankResp { fuente: string; from_mes: string; to_mes: string; banco: string | null; total_grupos?: number; offset?: number; limit?: number; rows: BankRow[]; }
export interface EfosRow { rfc: string; nombre: string; lista: string; situacion: string; codigo: string; }
/** LC.21: `total` / `en_69b` son del universo completo; `rows` es una página. */
export interface EfosResp { total: number; en_69b: number; offset?: number; limit?: number; nota: string; rows: EfosRow[]; }

/** LC.21: los renglones de póliza de una cuenta, y lo que dice la balanza de esa cuenta. */
export interface BalanzaRenglones {
  cuenta: string; nombre: string | null; from_mes: string; to_mes: string; page: number; page_size: number;
  renglones: number; cargos: number; abonos: number; balanza: { cargos: number; abonos: number }; cuadra: boolean;
  filas: { anio_mes: string; tipo_pol: string; folio: string; num_movto: number; cargo_abono: string; importe: number; referencia: string | null; concepto: string | null; cfdi_uuid: string | null }[];
}
/** LC.21: los movimientos de una fila del auxiliar bancario. */
export interface BankMovimientos {
  cuenta: string | null; mes: string | null; flujo: 'deposito' | 'retiro' | null; from_mes: string; to_mes: string; page: number; page_size: number;
  movs: number; depositos: number; retiros: number;
  filas: { fecha: string | null; cuenta: string; banco: string; flujo: string; importe: number; concepto: string | null; referencia: string | null; poliza: string | null; conciliado: boolean }[];
}
/** LC.21: los CFDI de un proveedor en el periodo (los que cuenta su renglón de CFDI vs Contab.). */
export interface CfdisProveedor {
  period: string; rfc: string; num_cfdis: number; total: number;
  cfdis: { uuid: string; serie: string | null; folio: string | null; fecha: string | null; tipo: string; base: number; iva: number; total: number; metodo_pago: string | null; estatus_sat: string; tiene_xml: boolean }[];
}
export interface LibrosVsOpRow { mes: string; operacion_kepler: number; libros_contpaqi: number; delta: number; ratio_pct: number | null; }
export interface LibrosVsOpResp { concepto: string; from_mes: string; to_mes: string; operacion_kepler_total: number; libros_contpaqi_total: number; delta_total: number; ratio_pct: number | null; nota: string; rows: LibrosVsOpRow[]; }

export type BalanzaGroupBy = 'familia' | 'cuenta' | 'mes' | 'agrupador_sat';
export type BankGroupBy = 'banco' | 'mes';

export type CfdiRiesgo = 'efos' | 'lista69' | 'no_registrado' | 'ok';
export interface CfdiVsContabRow {
  rfc: string; nombre: string; num_cfdis: number; base: number; iva: number; total: number;
  en_contpaqi: boolean; codigo: string | null; sat_lista: string | null; sat_situacion: string | null; riesgo: CfdiRiesgo;
}
export interface CfdiVsContabResp {
  period: string;
  summary: {
    proveedores: number; cfdi_count: number; cfdi_total: number; registrados: number;
    no_registrados: number; no_registrados_monto: number;
    efos_count: number; efos_monto: number; lista69_count: number; lista69_monto: number;
  };
  rows: CfdiVsContabRow[];
}

@Injectable({ providedIn: 'root' })
export class ContabilidadContpaqiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/contabilidad/contpaqi`;

  private rows<T>(o: any): T { return { ...o, rows: fromCol(o?.rows) } as T; }

  balanza(q: { group_by: BalanzaGroupBy; from_mes?: string; to_mes?: string; familia?: string; cuenta?: string; agrupador_sat?: string; offset?: number; limit?: number }): Observable<BalanzaResp> {
    const p = new URLSearchParams({ group_by: q.group_by });
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    if (q.familia) p.set('familia', q.familia);
    if (q.cuenta) p.set('cuenta', q.cuenta);
    if (q.agrupador_sat) p.set('agrupador_sat', q.agrupador_sat);
    if (q.offset) p.set('offset', String(q.offset));
    if (q.limit) p.set('limit', String(q.limit));
    return this.http.get<any>(`${this.base}/balanza?${p}`).pipe(map((o) => this.rows<BalanzaResp>(o)));
  }

  /** LC.21: los renglones de póliza de una cuenta en el rango, con la suma de la balanza. */
  balanzaRenglones(q: { cuenta: string; from_mes?: string; to_mes?: string; page?: number }): Observable<BalanzaRenglones> {
    const p = new URLSearchParams({ cuenta: q.cuenta, page: String(q.page || 1) });
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    return this.http.get<BalanzaRenglones>(`${this.base}/balanza/renglones?${p}`);
  }

  bank(q: { group_by: BankGroupBy; banco?: string; from_mes?: string; to_mes?: string; offset?: number }): Observable<BankResp> {
    const p = new URLSearchParams({ group_by: q.group_by });
    if (q.banco) p.set('banco', q.banco);
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    if (q.offset) p.set('offset', String(q.offset));
    return this.http.get<any>(`${this.base}/bank?${p}`).pipe(map((o) => this.rows<BankResp>(o)));
  }

  /** LC.21: los movimientos de un banco (`cuenta`) o de un mes, opcionalmente sólo depósitos o retiros. */
  bankMovimientos(q: { cuenta?: string | null; mes?: string | null; flujo?: 'deposito' | 'retiro' | null; from_mes?: string; to_mes?: string; page?: number }): Observable<BankMovimientos> {
    const p = new URLSearchParams({ page: String(q.page || 1) });
    if (q.cuenta) p.set('cuenta', q.cuenta);
    if (q.mes) p.set('mes', q.mes);
    if (q.flujo) p.set('flujo', q.flujo);
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    return this.http.get<BankMovimientos>(`${this.base}/bank/movimientos?${p}`);
  }

  efos(q?: { solo_69b?: boolean; search?: string; offset?: number }): Observable<EfosResp> {
    const p = new URLSearchParams();
    if (q?.solo_69b) p.set('solo_69b', 'true');
    if (q?.search) p.set('search', q.search);
    if (q?.offset) p.set('offset', String(q.offset));
    const qs = p.toString();
    return this.http.get<any>(`${this.base}/efos${qs ? '?' + qs : ''}`).pipe(map((o) => this.rows<EfosResp>(o)));
  }

  librosVsOperacion(q?: { from_mes?: string; to_mes?: string }): Observable<LibrosVsOpResp> {
    const p = new URLSearchParams();
    if (q?.from_mes) p.set('from_mes', q.from_mes);
    if (q?.to_mes) p.set('to_mes', q.to_mes);
    const qs = p.toString();
    return this.http.get<any>(`${this.base}/libros-vs-operacion${qs ? '?' + qs : ''}`).pipe(map((o) => this.rows<LibrosVsOpResp>(o)));
  }

  // CP.8 — CFDI recibidos vs padrón de proveedores ContPAQi + lista SAT. Endpoint plano (no col()).
  cfdiVsContab(period: string): Observable<CfdiVsContabResp> {
    return this.http.get<CfdiVsContabResp>(`${environment.apiUrl}/contabilidad/cfdi-vs-contabilidad?period=${encodeURIComponent(period)}`);
  }

  /** LC.21: los CFDI de un proveedor en el periodo (mismo filtro que su renglón). */
  cfdisProveedor(period: string, rfc: string): Observable<CfdisProveedor> {
    const p = new URLSearchParams({ period, rfc });
    return this.http.get<CfdisProveedor>(`${environment.apiUrl}/contabilidad/cfdi-vs-contabilidad/cfdis?${p}`);
  }
}
