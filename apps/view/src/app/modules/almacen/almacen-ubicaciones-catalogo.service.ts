import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  BulkLocationsBody,
  BulkLocationsPreview,
  BulkLocationsResult,
  CreateWarehouseLocationBody,
  LocationCaptureBatch,
  UndoLocationBatchResult,
  WarehouseLocationRow,
  WarehouseLocationsResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[UB.1]`/`[UB.2]` Cliente del catálogo de ubicaciones (`/almacen/ubicaciones`, Fase UB). */
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

  // ── [UB.2] captura masiva ──
  preview(body: BulkLocationsBody): Observable<BulkLocationsPreview> {
    return this.http.post<BulkLocationsPreview>(`${this.base}/bulk/preview`, body);
  }

  apply(body: BulkLocationsBody): Observable<BulkLocationsResult> {
    return this.http.post<BulkLocationsResult>(`${this.base}/bulk`, body);
  }

  batches(warehouseId: string): Observable<LocationCaptureBatch[]> {
    return this.http.get<LocationCaptureBatch[]>(`${this.base}/batches`, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }

  undo(batchId: string): Observable<UndoLocationBatchResult> {
    return this.http.post<UndoLocationBatchResult>(`${this.base}/batches/${batchId}/undo`, {});
  }
}
