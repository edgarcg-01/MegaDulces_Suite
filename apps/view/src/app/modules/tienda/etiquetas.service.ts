import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LabelModel } from './components/label.component';

export interface SearchHit { product_id: string; sku: string | null; name: string; barcode: string | null; }

/** [OBS.6.2] Un eslabón de la cadena que produce el precio, con su edad y su veredicto. */
export interface FreshnessInput {
  key: string;
  label: string;
  at: string | null;
  age_human: string | null;
  stale: boolean;
}

/**
 * [OBS.6.2] Qué tan viejo es el precio que se está por imprimir.
 *
 * El 2026-09-02 el carril del ODS llevaba 6 días parado y esta pantalla imprimió precios de hace
 * una semana sin decir nada — uno de ellos 54% bajo costo. No bloquea: declara.
 *
 * `inputs` vacío = no se pudo medir. Eso NO es "está fresco": se muestra como desconocido.
 */
export interface Freshness {
  data_as_of: string | null;
  stale: boolean;
  age_human: string | null;
  inputs: FreshnessInput[];
}

export interface ResolveResult { labels: LabelModel[]; not_found: string[]; freshness?: Freshness; }

@Injectable({ providedIn: 'root' })
export class EtiquetasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/labels`;

  search(q: string): Observable<SearchHit[]> {
    return this.http.get<SearchHit[]>(`${this.base}/search`, { params: { q } });
  }

  resolve(codes: string[]): Observable<ResolveResult> {
    return this.http.post<ResolveResult>(`${this.base}/resolve`, { codes });
  }
}
