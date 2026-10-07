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

export interface BalanzaRow { key?: string; cuenta?: string; familia?: string; mes?: string; agrupador_sat?: string; cargos: number; abonos: number; neto: number; movs?: number; }
export interface BalanzaResp { fuente: string; from_mes: string; to_mes: string; rows: BalanzaRow[]; }
export interface BankRow { banco?: string; mes?: string; depositos: number; retiros: number; neto: number; movs: number; }
export interface BankResp { fuente: string; from_mes: string; to_mes: string; banco: string | null; rows: BankRow[]; }
export interface EfosRow { rfc: string; nombre: string; lista: string; situacion: string; codigo: string; }
export interface EfosResp { total: number; en_69b: number; nota: string; rows: EfosRow[]; }
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

  balanza(q: { group_by: BalanzaGroupBy; from_mes?: string; to_mes?: string; familia?: string; cuenta?: string }): Observable<BalanzaResp> {
    const p = new URLSearchParams({ group_by: q.group_by });
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    if (q.familia) p.set('familia', q.familia);
    if (q.cuenta) p.set('cuenta', q.cuenta);
    return this.http.get<any>(`${this.base}/balanza?${p}`).pipe(map((o) => this.rows<BalanzaResp>(o)));
  }

  bank(q: { group_by: BankGroupBy; banco?: string; from_mes?: string; to_mes?: string }): Observable<BankResp> {
    const p = new URLSearchParams({ group_by: q.group_by });
    if (q.banco) p.set('banco', q.banco);
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    return this.http.get<any>(`${this.base}/bank?${p}`).pipe(map((o) => this.rows<BankResp>(o)));
  }

  efos(q?: { solo_69b?: boolean; search?: string }): Observable<EfosResp> {
    const p = new URLSearchParams();
    if (q?.solo_69b) p.set('solo_69b', 'true');
    if (q?.search) p.set('search', q.search);
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
}
