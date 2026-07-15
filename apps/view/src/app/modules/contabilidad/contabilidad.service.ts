import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.9 — cliente de contabilidad electrónica (XMLs SAT). /fiscal/contabilidad-electronica. */

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
}
