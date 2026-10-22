import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type {
  SetVendorTargetRequest,
  SetVendorTargetResponse,
  SupervisorBoardResponse,
  VendorSummaryResponse,
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

  /** `[MCP.3.10]` Resumen de un vendedor de tu equipo: meta, sus días de la catorcena, ruta y sucursal. */
  vendorSummary(userId: string, date: string): Observable<VendorSummaryResponse> {
    return this.http.get<VendorSummaryResponse>(`${this.base}/vendor-summary`, {
      params: new HttpParams().set('user_id', userId).set('date', date),
    });
  }

  setTarget(body: SetVendorTargetRequest): Observable<SetVendorTargetResponse> {
    return this.http.put<SetVendorTargetResponse>(`${this.base}/targets`, body);
  }
}
