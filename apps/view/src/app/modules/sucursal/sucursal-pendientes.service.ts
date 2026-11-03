import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  AtribuirPendienteRequest,
  ResponsablePendiente,
  SucursalPendientesAlmacen,
  SucursalPendientesResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[AB.45]`/`[AB.46]` Pendientes de sucursal: todas las colas de la Suite con trabajo de una sucursal. */
@Injectable({ providedIn: 'root' })
export class SucursalPendientesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/sucursal-pendientes`;

  almacenes(): Observable<SucursalPendientesAlmacen[]> {
    return this.http.get<SucursalPendientesAlmacen[]>(`${this.base}/almacenes`);
  }

  pendientes(warehouseId: string): Observable<SucursalPendientesResponse> {
    return this.http.get<SucursalPendientesResponse>(this.base, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }

  /** `[AB.46]` «Yo lo resuelvo». */
  atribuir(body: AtribuirPendienteRequest): Observable<ResponsablePendiente> {
    return this.http.post<ResponsablePendiente>(`${this.base}/atribuir`, body);
  }

  /** `[AB.46]` Soltar un pendiente propio. */
  soltar(body: AtribuirPendienteRequest): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/soltar`, body);
  }
}
