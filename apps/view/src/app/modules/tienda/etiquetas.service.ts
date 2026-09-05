import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LabelModel } from './components/label.component';

export interface SearchHit { product_id: string; sku: string | null; name: string; barcode: string | null; }

/**
 * [VP.0.1] El veredicto, espejo de `libs/commercial/src/lib/shared/freshness.ts`.
 * `unknown` = no se pudo medir, que NO es lo mismo que estar al día.
 */
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

/** [OBS.6.2] Un eslabón de la cadena que produce el precio, con su edad y su veredicto. */
export interface FreshnessInput {
  key: string;
  label: string;
  at: string | null;
  age_human: string | null;
  status: FreshnessStatus;
  stale: boolean;
}

/**
 * [OBS.6.2] Qué tan viejo es el precio que se está por imprimir.
 *
 * El 2026-09-02 el carril del ODS llevaba 6 días parado y esta pantalla imprimió precios de hace
 * una semana sin decir nada — uno de ellos 54% bajo costo. No bloquea: declara.
 *
 * [VP.0.1] `inputs` vacío = no se pudo medir, y eso llega como `status: 'unknown'` + `stale: true`.
 * Antes llegaba como `stale: false` y la pantalla callaba: el mismo silencio que la fase vino a
 * matar. La vista tiene que distinguir los dos casos — "viejo" tiene edad, "desconocido" no.
 */
export interface Freshness {
  data_as_of: string | null;
  status: FreshnessStatus;
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
