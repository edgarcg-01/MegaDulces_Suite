import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.9 — cliente de contabilidad electrónica (XMLs SAT). /fiscal/contabilidad-electronica. */

/** FE.11 — fila del mapeo cuenta mayor → código agrupador SAT. */
export interface CodAgrupadorRow {
  cuenta_mayor: string;
  nombre: string | null;
  familia: string | null;
  cod_agrupador: string | null;
  natur: string | null;
  source: string | null;
  natur_default: 'D' | 'A';
}

@Injectable({ providedIn: 'root' })
export class ContabilidadService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/contabilidad-electronica`;

  balanza(period: string, rfc?: string, tipoEnvio: 'N' | 'C' = 'N'): Observable<string> {
    const p = new URLSearchParams({ period, tipoEnvio });
    if (rfc) p.set('rfc', rfc);
    return this.http.get(`${this.base}/balanza?${p.toString()}`, { responseType: 'text' });
  }
  catalogo(period: string, rfc?: string): Observable<string> {
    const p = new URLSearchParams({ period });
    if (rfc) p.set('rfc', rfc);
    return this.http.get(`${this.base}/catalogo?${p.toString()}`, { responseType: 'text' });
  }

  // ── FE.11: mapeo código agrupador SAT ──
  listCodAgrupador(): Observable<CodAgrupadorRow[]> {
    return this.http.get<CodAgrupadorRow[]>(`${this.base}/cod-agrupador`);
  }
  suggestCodAgrupador(): Observable<{ inserted: number }> {
    return this.http.post<{ inserted: number }>(`${this.base}/cod-agrupador/suggest`, {});
  }
  saveCodAgrupador(body: { cuenta_mayor: string; cod_agrupador: string; natur?: string | null }): Observable<CodAgrupadorRow> {
    return this.http.put<CodAgrupadorRow>(`${this.base}/cod-agrupador`, body);
  }
  deleteCodAgrupador(cuentaMayor: string): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`${this.base}/cod-agrupador?cuenta_mayor=${encodeURIComponent(cuentaMayor)}`);
  }
}
