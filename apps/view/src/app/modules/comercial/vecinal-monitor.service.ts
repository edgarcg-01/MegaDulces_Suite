import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  VecinalCashierOrder,
  VecinalCashiersResponse,
  VecinalOrdersResponse,
  VecinalPickerOrder,
  VecinalPickersResponse,
  VecinalVendorDetail,
  VecinalVendorsResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** Los filtros de la pantalla: periodo (AAAA-MM-DD), sucursal (código) y ruta vecinal. */
export interface FiltroMonitoreo {
  from: string;
  to: string;
  warehouse?: string | null;
  route?: string | null;
}

/** `[MV.3]` Monitoreo vecinal: vendedores, surtidores y cajeras de la preventa (sólo lectura). */
@Injectable({ providedIn: 'root' })
export class VecinalMonitorService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/vecinal-monitor`;

  private params(f: FiltroMonitoreo, conRuta = false): HttpParams {
    let p = new HttpParams().set('from', f.from).set('to', f.to);
    if (f.warehouse) p = p.set('warehouse', f.warehouse);
    if (conRuta && f.route) p = p.set('route', f.route);
    return p;
  }

  vendors(f: FiltroMonitoreo): Observable<VecinalVendorsResponse> {
    return this.http.get<VecinalVendorsResponse>(`${this.base}/vendors`, { params: this.params(f, true) });
  }
  vendor(userId: string, f: FiltroMonitoreo): Observable<VecinalVendorDetail> {
    return this.http.get<VecinalVendorDetail>(`${this.base}/vendors/${userId}`, { params: this.params(f) });
  }
  pickers(f: FiltroMonitoreo): Observable<VecinalPickersResponse> {
    return this.http.get<VecinalPickersResponse>(`${this.base}/pickers`, { params: this.params(f) });
  }
  pickerOrders(userId: string, f: FiltroMonitoreo): Observable<VecinalOrdersResponse<VecinalPickerOrder>> {
    return this.http.get<VecinalOrdersResponse<VecinalPickerOrder>>(`${this.base}/pickers/${userId}/orders`, { params: this.params(f) });
  }
  cashiers(f: FiltroMonitoreo): Observable<VecinalCashiersResponse> {
    return this.http.get<VecinalCashiersResponse>(`${this.base}/cashiers`, { params: this.params(f) });
  }
  cashierOrders(userId: string, f: FiltroMonitoreo): Observable<VecinalOrdersResponse<VecinalCashierOrder>> {
    return this.http.get<VecinalOrdersResponse<VecinalCashierOrder>>(`${this.base}/cashiers/${userId}/orders`, { params: this.params(f) });
  }
}
