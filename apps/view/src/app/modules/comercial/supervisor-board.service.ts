import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type {
  SetVendorTargetRequest,
  SetVendorTargetResponse,
  SupervisorBoardResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MCP.3.9]` Tablero del supervisor de ventas: sus vendedores desglosados + la meta de la catorcena. */
@Injectable({ providedIn: 'root' })
export class SupervisorBoardService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/vendor-routes/supervisor`;

  board(date: string): Observable<SupervisorBoardResponse> {
    return this.http.get<SupervisorBoardResponse>(`${this.base}/board`, { params: new HttpParams().set('date', date) });
  }

  setTarget(body: SetVendorTargetRequest): Observable<SetVendorTargetResponse> {
    return this.http.put<SetVendorTargetResponse>(`${this.base}/targets`, body);
  }
}
