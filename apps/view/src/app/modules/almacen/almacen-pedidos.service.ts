import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { WarehouseOrderDetail, WarehouseOrdersResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** Filtros del tablero. Sin `month` ni rango, el servidor usa el mes en curso. */
export interface AlmacenPedidosFiltro {
  month?: string;
  from?: string;
  to?: string;
  estatus?: string[];
  origen?: string | null;
  sucursal?: string | null;
  q?: string | null;
}

/** `[GP.1]` Cliente del tablero de pedidos del almacén (`/almacen/pedidos`, sólo lectura). */
@Injectable({ providedIn: 'root' })
export class AlmacenPedidosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/orders`;

  list(f: AlmacenPedidosFiltro): Observable<WarehouseOrdersResponse> {
    let p = new HttpParams();
    if (f.from && f.to) p = p.set('from', f.from).set('to', f.to);
    else if (f.month) p = p.set('month', f.month);
    if (f.estatus?.length) p = p.set('status', f.estatus.join(','));
    if (f.origen) p = p.set('origin', f.origen);
    if (f.sucursal) p = p.set('branch', f.sucursal);
    if (f.q) p = p.set('q', f.q);
    return this.http.get<WarehouseOrdersResponse>(this.base, { params: p });
  }

  detail(sucursal: string, serie: number, folio: string): Observable<WarehouseOrderDetail> {
    return this.http.get<WarehouseOrderDetail>(`${this.base}/${sucursal}/${serie}/${folio}`);
  }
}
