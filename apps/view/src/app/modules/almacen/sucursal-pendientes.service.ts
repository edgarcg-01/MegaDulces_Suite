import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { SucursalPendientesAlmacen, SucursalPendientesResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[AB.45]` Pendientes de la sucursal: todas las colas de la Suite con trabajo de una sucursal. */
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
}
