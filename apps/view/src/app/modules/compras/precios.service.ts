import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  ConsultaFichaSucursales,
  ConsultaListaPrecios,
  ConsultaSinClasificar,
  RespuestaFichaSucursales,
  RespuestaHistoriaPrecio,
  RespuestaListaPrecios,
  RespuestaSinClasificar,
} from '@megadulces/contracts';

/** Sólo los parámetros con valor: un `undefined` no viaja como texto «undefined». */
function params(q: object): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  return p;
}

/** `[CAT-PRECIO]` Compras › Catálogo: Mantenimiento y Precios. */
@Injectable({ providedIn: 'root' })
export class PreciosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/products`;

  /** `[CAT-PRECIO.1]` La ficha de venta que no coincide entre sucursales. */
  diferencias(q: ConsultaFichaSucursales = {}): Observable<RespuestaFichaSucursales> {
    return this.http.get<RespuestaFichaSucursales>(`${this.base}/branch-differences`, { params: params(q) });
  }

  /** `[CAT-PRECIO.5]` Productos sin línea, tipo o grupo en ninguna sucursal. */
  sinClasificar(q: ConsultaSinClasificar = {}): Observable<RespuestaSinClasificar> {
    return this.http.get<RespuestaSinClasificar>(`${this.base}/unclassified`, { params: params(q) });
  }

  /** `[CAT-PRECIO.2]` El catálogo de precios de una sucursal. */
  lista(q: ConsultaListaPrecios = {}): Observable<RespuestaListaPrecios> {
    return this.http.get<RespuestaListaPrecios>(`${this.base}/price-list`, { params: params(q) });
  }

  /** `[CAT-PRECIO.4]` La historia de un precio (producto × unidad × sucursal). */
  historia(sku: string, sucursal: string, unidad: string): Observable<RespuestaHistoriaPrecio> {
    return this.http.get<RespuestaHistoriaPrecio>(`${this.base}/price-history`, { params: params({ sku, sucursal, unidad }) });
  }
}
