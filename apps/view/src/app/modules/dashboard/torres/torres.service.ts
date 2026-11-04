import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { TorreDesarrollo, TorreSistemas } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';

/** `[TOR.3]` Las dos torres de control. Los contratos viven en `@megadulces/contracts`. */
@Injectable({ providedIn: 'root' })
export class TorresService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/admin/db-health`;

  sistemas(): Observable<TorreSistemas> {
    return this.http.get<TorreSistemas>(`${this.base}/torre/sistemas`);
  }

  desarrollo(): Observable<TorreDesarrollo> {
    return this.http.get<TorreDesarrollo>(`${this.base}/torre/desarrollo`);
  }

  /** Marca vista una alerta persistida (no la resuelve: eso lo hace el escáner). */
  marcarVista(alertaId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/alerts/${alertaId}/ack`, {});
  }
}
