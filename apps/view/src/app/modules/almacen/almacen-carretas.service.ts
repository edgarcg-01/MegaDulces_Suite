import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { BulkCartsBody, BulkCartsResult, CartRow, CartsResponse, OccupyCartBody, OccupyCartResult, WaveCartsResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[GP.11.5]` Cliente de carretas y carritos (`/warehouse/carts`, FASE_GP paso 4). */
@Injectable({ providedIn: 'root' })
export class AlmacenCarretasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/carts`;

  list(warehouseId: string): Observable<CartsResponse> {
    return this.http.get<CartsResponse>(this.base, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }

  forWave(waveId: string): Observable<WaveCartsResponse> {
    return this.http.get<WaveCartsResponse>(`${this.base}/ola/${encodeURIComponent(waveId)}`);
  }

  occupy(body: OccupyCartBody): Observable<OccupyCartResult> {
    return this.http.post<OccupyCartResult>(`${this.base}/occupy`, body);
  }

  undo(binId: string): Observable<CartRow> {
    return this.http.post<CartRow>(`${this.base}/${encodeURIComponent(binId)}/undo`, {});
  }

  release(binId: string): Observable<CartRow> {
    return this.http.post<CartRow>(`${this.base}/${encodeURIComponent(binId)}/release`, {});
  }

  bulk(body: BulkCartsBody): Observable<BulkCartsResult> {
    return this.http.post<BulkCartsResult>(`${this.base}/bulk`, body);
  }
}
