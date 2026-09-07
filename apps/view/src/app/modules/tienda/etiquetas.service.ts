import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LabelModel } from './components/label.component';

export interface SearchHit { product_id: string; sku: string | null; name: string; barcode: string | null; }

/**
 * [OBS.6.2] Qué tan viejo es el precio que se está por imprimir.
 *
 * El 2026-09-02 el carril del ODS llevaba 6 días parado y esta pantalla imprimió precios de hace
 * una semana sin decir nada — uno de ellos 54% bajo costo. No bloquea: declara.
 *
 * [VP.2.1] El tipo estaba re-declarado a mano acá (copia del de `libs/commercial/.../freshness.ts`,
 * a tres días de que naciera). Ahora los dos lados importan la MISMA forma de
 * `@megadulces/contracts` → un cambio de shape es error de compilación en ambos, en vez de dos
 * definiciones que se separan en silencio.
 *
 * `status: 'unknown'` = no se pudo medir. Llega con `stale: true` a propósito: antes llegaba con
 * `stale: false` y la pantalla callaba, que es el silencio que la fase vino a matar.
 */
export type { Freshness, FreshnessInput, FreshnessStatus } from '@megadulces/contracts';
import type { Freshness } from '@megadulces/contracts';

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
