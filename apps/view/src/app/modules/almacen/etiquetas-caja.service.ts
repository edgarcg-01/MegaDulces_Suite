import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type {
  BoxLabelCatalogDefect,
  BoxLabelOrdersResponse,
  BoxLabelPrintRequest,
  BoxLabelPrintResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[RE.ETQ.3.x]` La API de etiquetas de caja (`commercial/receiving/box-labels`). */
@Injectable({ providedIn: 'root' })
export class EtiquetasCajaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/receiving/box-labels`;

  ordenes(rango: { date_from: string; date_to: string }): Observable<BoxLabelOrdersResponse> {
    const p = new HttpParams().set('date_from', rango.date_from).set('date_to', rango.date_to);
    return this.http.get<BoxLabelOrdersResponse>(`${this.base}/orders`, { params: p });
  }

  defectos(rango: { date_from: string; date_to: string }): Observable<{ defectos: BoxLabelCatalogDefect[]; date_from: string; date_to: string }> {
    const p = new HttpParams().set('date_from', rango.date_from).set('date_to', rango.date_to);
    return this.http.get<{ defectos: BoxLabelCatalogDefect[]; date_from: string; date_to: string }>(`${this.base}/catalog-defects`, { params: p });
  }

  imprimir(pedido: BoxLabelPrintRequest): Observable<BoxLabelPrintResponse> {
    return this.http.post<BoxLabelPrintResponse>(`${this.base}/prints`, pedido);
  }
}
