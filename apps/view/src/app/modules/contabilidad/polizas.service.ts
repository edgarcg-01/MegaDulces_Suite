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

/* ---- PV.4: auditor del TIPO de poliza (D/E/I) ---- */

/**
 * ADR-056: el estado de medicion viaja con el dato. `not_measured` NO es cero:
 * es que el control no pudo correr, y la pantalla tiene que decirlo con todas
 * sus letras en vez de pintar un verde.
 */
export type MeasureState = 'measured' | 'not_measured';

export interface DoctypeVerdict {
  doc: string; descripcion: string; tipo_declarado: string; tipo_esperado: string;
  cargo: string | null; abono: string | null; veredicto: string;
  docs: number; importe: number;
}
export interface TipoCatalogoBlock {
  state: MeasureState; reason: string | null;
  data: {
    incongruentes: DoctypeVerdict[];
    no_juzgables: { doctypes: number; docs: number; importe: number };
    ok: number; total: number;
  };
}
export interface CrossGapRow {
  anio_mes: string; tipo_pol: string;
  kepler_polizas: number; kepler_monto: number;
  contpaqi_polizas: number; contpaqi_monto: number; brecha: number;
}
export interface TipoCruceBlock { state: MeasureState; reason: string | null; data: CrossGapRow[]; }
export interface TiposSummary {
  catalogo: {
    state: MeasureState; reason: string | null;
    incongruentes: number; incongruentes_vivos: number; importe_en_riesgo: number;
    no_juzgables: { doctypes: number; docs: number; importe: number };
    ok: number; total: number;
  };
  cruce: { state: MeasureState; reason: string | null; periodos: number; brecha_total: number };
}

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

  /* ---- PV.4 ---- */
  tiposSummary(anio?: number): Observable<TiposSummary> {
    const p = new URLSearchParams(); if (anio) p.set('anio', String(anio));
    return this.http.get<TiposSummary>(`${this.base}/tipos/summary?${p.toString()}`);
  }
  tiposCatalogo(anio?: number): Observable<TipoCatalogoBlock> {
    const p = new URLSearchParams(); if (anio) p.set('anio', String(anio));
    return this.http.get<TipoCatalogoBlock>(`${this.base}/tipos/catalogo?${p.toString()}`);
  }
  tiposCruce(meses = 6): Observable<TipoCruceBlock> {
    return this.http.get<TipoCruceBlock>(`${this.base}/tipos/cruce?meses=${meses}`);
  }
  tiposSync(): Observable<{ pushed: number; inserted: number; skipped: number }> {
    return this.http.post<{ pushed: number; inserted: number; skipped: number }>(`${this.base}/tipos/sync`, {});
  }
}
