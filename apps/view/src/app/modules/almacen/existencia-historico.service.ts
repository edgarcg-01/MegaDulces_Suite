import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ExistenciaHistorico, ExistenciaHistoricoDetalle } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[EX.H2]` Cliente de «Consulta históricos» (Existencia). La forma de lo que viaja vive en
 * `libs/contracts/src/http/existencia-historico.contract.ts`, compartida con el servidor: aquí no
 * se redeclara ninguna interfaz.
 */
@Injectable({ providedIn: 'root' })
export class ExistenciaHistoricoApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/inventory/stock-snapshot/historico`;

  /** El valor de cada sucursal al cierre de cada día del rango. `almacenes` vacío = todas. */
  historico(q: { desde: string; hasta: string; almacenes: string[] }): Observable<ExistenciaHistorico> {
    let p = new HttpParams().set('desde', q.desde).set('hasta', q.hasta);
    if (q.almacenes.length) p = p.set('almacenes', q.almacenes.join(','));
    return this.http.get<ExistenciaHistorico>(this.base, { params: p });
  }

  /** El desglose de una celda: los productos de una sucursal en un día. */
  detalle(fecha: string, almacen: string): Observable<ExistenciaHistoricoDetalle> {
    const p = new HttpParams().set('fecha', fecha).set('almacen', almacen);
    return this.http.get<ExistenciaHistoricoDetalle>(`${this.base}/detalle`, { params: p });
  }
}
