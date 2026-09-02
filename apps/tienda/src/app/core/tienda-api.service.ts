import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  CarritoResult, CatalogoFiltros, CatalogoTiendaResponse, CheckoutOpciones,
  CheckoutRequest, CheckoutResult, PedidoResult, ProductoTiendaResult, TiendaConfig,
} from './models';

/**
 * Wrapper delgado de HttpClient contra la tienda real de catalogo-kp
 * (apps/catalogo-kp/src/tienda/*.controller.ts). Sin auth: este app no tiene
 * login, el token del carrito viaja en la URL/body, firmado por el propio
 * servidor (CATALOGO_KP_JWT_SECRET).
 */
@Injectable({ providedIn: 'root' })
export class TiendaApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/tienda`;

  config(): Observable<TiendaConfig> {
    return this.http.get<TiendaConfig>(`${this.base}/config`);
  }

  catalogo(query: {
    q?: string; familia?: string; marca?: string;
    orden?: string; dir?: string; page?: number; limit?: number;
  }): Observable<CatalogoTiendaResponse> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    }
    return this.http.get<CatalogoTiendaResponse>(`${this.base}/catalogo`, { params });
  }

  filtros(): Observable<CatalogoFiltros> {
    // Referencia (familias/marcas) — comparte el catálogo interno, ver
    // apps/catalogo-kp/src/catalogo/catalogo.controller.ts (getFiltros es
    // público, no depende de sesión ni de sucursal restringida).
    return this.http.get<CatalogoFiltros>(`${environment.apiUrl}/catalogo/filtros`);
  }

  imagenesDisponibles(): Observable<string[]> {
    return this.http.get<string[]>(`${environment.apiUrl}/catalogo/imagenes`);
  }

  producto(codigo: string): Observable<ProductoTiendaResult> {
    return this.http.get<ProductoTiendaResult>(`${this.base}/producto/${encodeURIComponent(codigo)}`);
  }

  crearCarrito(): Observable<CarritoResult> {
    return this.http.post<CarritoResult>(`${this.base}/carrito`, {});
  }

  verCarrito(token: string): Observable<CarritoResult> {
    return this.http.get<CarritoResult>(`${this.base}/carrito/${token}`);
  }

  agregarItem(token: string, codigo: string, unidad: string, cantidad: number): Observable<CarritoResult> {
    return this.http.post<CarritoResult>(`${this.base}/carrito/${token}/items`, { codigo, unidad, cantidad });
  }

  cambiarCantidad(token: string, itemId: number, cantidad: number): Observable<CarritoResult> {
    return this.http.patch<CarritoResult>(`${this.base}/carrito/${token}/items/${itemId}`, { cantidad });
  }

  quitarItem(token: string, itemId: number): Observable<CarritoResult> {
    return this.http.delete<CarritoResult>(`${this.base}/carrito/${token}/items/${itemId}`);
  }

  cancelarCarrito(token: string): Observable<CarritoResult> {
    return this.http.delete<CarritoResult>(`${this.base}/carrito/${token}`);
  }

  datosCliente(token: string, datos: { nombre: string; email: string; tel: string }): Observable<CarritoResult> {
    return this.http.post<CarritoResult>(`${this.base}/carrito/${token}/cliente`, datos);
  }

  checkoutOpciones(): Observable<CheckoutOpciones> {
    return this.http.get<CheckoutOpciones>(`${this.base}/checkout/opciones`);
  }

  checkout(token: string, datos: CheckoutRequest): Observable<CheckoutResult> {
    return this.http.post<CheckoutResult>(`${this.base}/carrito/${token}/checkout`, datos);
  }

  pedido(seguimiento: string): Observable<PedidoResult> {
    return this.http.get<PedidoResult>(`${this.base}/pedido/${encodeURIComponent(seguimiento)}`);
  }
}
