import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** PV.3 (Fase PV) — cliente del Auditor de Pólizas. /contabilidad/polizas. */

export interface PolizaSummary {
  total: number; descuadradas: number; monto_descuadre: number;
  contpaqi: number; kepler: number; ultimo_mes: string | null;
}
export interface PolizaRow {
  source: string; sucursal: string; ejercicio: number; periodo: number;
  tipo_pol: string; folio: string; anio_mes: string; fecha: string | null;
  concepto: string | null; cargos: number; abonos: number; neto: number;
  num_lines: number; guid: string | null; cuadra: boolean;
}
export interface PolizaList { page: number; page_size: number; total: number; rows: PolizaRow[]; }
export interface PolizaLine {
  num_movto: number; cuenta: string; cuenta_nombre: string | null; cuenta_afectable: boolean | null;
  cargo_abono: string; importe: number; referencia: string | null; cfdi_uuid: string | null; sat_agrupador: string | null;
}
export interface PolizaFinding { rule_key: string; severity: string; titulo: string; resumen: string; importe: number; status: string; }
export interface PolizaDetail { header: PolizaRow | null; lines: PolizaLine[]; findings: PolizaFinding[]; }

@Injectable({ providedIn: 'root' })
export class PolizasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/contabilidad/polizas`;

  summary(source?: string): Observable<PolizaSummary> {
    const p = new URLSearchParams(); if (source) p.set('source', source);
    return this.http.get<PolizaSummary>(`${this.base}/summary?${p.toString()}`);
  }
  list(opts: { source?: string; anio_mes?: string; only_descuadre?: boolean; q?: string; page?: number; page_size?: number }): Observable<PolizaList> {
    const p = new URLSearchParams();
    if (opts.source) p.set('source', opts.source);
    if (opts.anio_mes) p.set('anio_mes', opts.anio_mes);
    if (opts.only_descuadre) p.set('only_descuadre', 'true');
    if (opts.q) p.set('q', opts.q);
    p.set('page', String(opts.page || 1)); p.set('page_size', String(opts.page_size || 50));
    return this.http.get<PolizaList>(`${this.base}?${p.toString()}`);
  }
  detail(r: PolizaRow): Observable<PolizaDetail> {
    const p = new URLSearchParams({
      source: r.source, ejercicio: String(r.ejercicio), periodo: String(r.periodo),
      tipo_pol: r.tipo_pol, folio: r.folio, sucursal: r.sucursal,
    });
    return this.http.get<PolizaDetail>(`${this.base}/detail?${p.toString()}`);
  }
  scan(): Observable<{ nuevos: number; reglas: number }> {
    return this.http.post<{ nuevos: number; reglas: number }>(`${this.base}/scan`, {});
  }
}
