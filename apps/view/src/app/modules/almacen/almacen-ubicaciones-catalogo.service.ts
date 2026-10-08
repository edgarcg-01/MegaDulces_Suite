import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { CreateWarehouseLocationBody, WarehouseLocationRow, WarehouseLocationsResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[UB.1]` Cliente del catálogo de ubicaciones (`/almacen/ubicaciones`, Fase UB). */
@Injectable({ providedIn: 'root' })
export class AlmacenUbicacionesCatalogoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/locations`;

  list(warehouseId?: string | null): Observable<WarehouseLocationsResponse> {
    let p = new HttpParams();
    if (warehouseId) p = p.set('warehouse_id', warehouseId);
    return this.http.get<WarehouseLocationsResponse>(this.base, { params: p });
  }

  create(body: CreateWarehouseLocationBody): Observable<WarehouseLocationRow> {
    return this.http.post<WarehouseLocationRow>(this.base, body);
  }
}
