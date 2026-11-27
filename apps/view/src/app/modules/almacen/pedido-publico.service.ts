import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { PedidoPublico } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[MCP.36]` La superficie PÚBLICA del pedido: sin sesión, autorizada por la firma `k` de la liga de su etiqueta.
 * `authInterceptor` exceptúa `/commercial/pedido-publico` (no pega ni pierde sesión aquí).
 */
@Injectable({ providedIn: 'root' })
export class PedidoPublicoService {
  private readonly http = inject(HttpClient);

  pedido(folio: string, k: string): Observable<PedidoPublico> {
    return this.http.get<PedidoPublico>(`${environment.apiUrl}/commercial/pedido-publico/${encodeURIComponent(folio)}`, {
      params: { k },
    });
  }
}
