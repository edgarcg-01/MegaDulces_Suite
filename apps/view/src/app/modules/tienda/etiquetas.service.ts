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

  /**
   * `[NORM.3]` `sucursal` = la tienda para la que se imprime. El precio de Kepler es POR PLAZA
   * (1,039 SKUs con precio de pieza distinto entre plazas retail, 1,164 grupos de mayoreo de
   * paquete), y hasta ahora la etiqueta salía con la moda entre las ocho.
   *
   * Se manda la que tiene el usuario (`warehouse_code`). Si no tiene ninguna —un rol global— va
   * sin ella y el backend responde la forma consolidada de siempre: sin plaza no hay a qué
   * seguir, y **declararlo es mejor que elegir una tienda al azar**.
   */
  resolve(codes: string[], sucursal?: string | null): Observable<ResolveResult> {
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;
    return this.http.post<ResolveResult>(`${this.base}/resolve`, suc ? { codes, sucursal: suc } : { codes });
  }
}
