import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Catálogo de productos (vista Sencillo): la lista buscable y la ficha de un producto.
 * Espejo del contrato de `GET /api/commercial/products/catalogo` y `.../catalogo/:id/ficha`.
 *
 * Las cantidades de existencia y venta llegan en la UNIDAD BASE del producto (`unidadBase`); la ficha
 * las dice compuestas con `componerEnUnidades` (`unidades-composicion.ts`).
 */

/** Una unidad en que se maneja el producto, con lo que equivale y su precio. */
export interface UnidadPrecio {
  unidad: string;
  /** A qué equivale (p. ej. 20 PAQ). null en la unidad base. */
  equivale: { cantidad: number; unidad: string } | null;
  /** Cuántas unidades base trae (la base = 1). */
  factorBase: number;
  /** null = no hay precio de lista para esta unidad (se declara «Sin precio», nunca $0). */
  precio: number | null;
  mayoreo: { precio: number; desde: number } | null;
}

export interface FichaSucursal {
  codigo: string;
  nombre: string | null;
  /** null = no hay dato de venta del mes para esta sucursal. */
  vendidoMes: { monto: number; unidadesBase: number } | null;
  /** null = no se pudo medir la existencia (se declara «Sin dato»). */
  existenciaBase: number | null;
}

export interface FichaProducto {
  id: string;
  sku: string | null;
  nombre: string;
  /** null si viene vacía o igual al nombre (lo decide el backend). */
  descripcion: string | null;
  activo: boolean;
  proveedor: { id: string; nombre: string } | null;
  /** Todos los códigos de barras; el primero es el principal. */
  codigos: string[];
  unidadBase: string | null;
  unidades: UnidadPrecio[];
  precioRed: { sucursales: number; min: number | null; max: number | null };
  sucursales: FichaSucursal[];
  /** Hasta qué día cuenta «vendido este mes». */
  corteVenta: string | null;
  ultimaEntrada: {
    sucursal: string;
    nombreSucursal: string | null;
    fecha: string;
    cantidad: number;
    unidad: string;
    /** null si quien consulta no tiene permiso de costo. */
    costo: number | null;
  } | null;
  costo_visible: boolean;
  calculado_al: string;
}

export interface FilaCatalogoProducto {
  id: string;
  sku: string | null;
  nombre: string;
  proveedor: { id: string; nombre: string } | null;
  unidades: UnidadPrecio[];
  /** Por qué coincidió con la búsqueda (SKU, código de barras…). null = por nombre o sin búsqueda. */
  razon: string | null;
  /** Códigos de barras activos distintos. 0 = sin código. */
  nCodigos: number;
}

/** «Mostrar» de la lista; se filtra en el servidor (la lista es paginada). */
export type MostrarCatalogo = 'todos' | 'varios_codigos' | 'sin_codigo' | 'sin_precio';

/** Cuántos de la BÚSQUEDA caen en cada opción de «Mostrar». */
export interface ConteosCatalogo {
  todos: number;
  variosCodigos: number;
  sinCodigo: number;
  /** null = no se pudo medir (la base no tiene precio por sucursal). Se declara, nunca 0. */
  sinPrecio: number | null;
}

export interface CatalogoLista {
  sucursal: string;
  /** Total de la opción aplicada (el que pagina). */
  total: number;
  filas: FilaCatalogoProducto[];
  calculado_al: string;
  conteos: ConteosCatalogo;
  /** La opción que el servidor aplicó. */
  mostrar: MostrarCatalogo;
}

export interface CatalogoListaParams {
  search?: string | null;
  sucursal?: string | null;
  page?: number | null;
  pageSize?: number | null;
  /** Default todos (no se manda). */
  mostrar?: MostrarCatalogo | null;
}

// ── Vista Detallado (GET catalogo?vista=detallado): lo de Sencillo + venta del mes, etiquetas y filtros de compra ──

/** «Mostrar» de Detallado: los 4 de Sencillo + «Qué hacer», «Para cuidar hoy» y sin proveedor. */
export type FiltroDetallado =
  | MostrarCatalogo
  | 'sin_proveedor'
  | 'comprar' | 'traspasar' | 'esperar' | 'sobra' | 'no_comprar'
  | 'lideres_pendiente' | 'no_se_venden' | 'caducidad' | 'nuevos';
export type OrdenDetallado = 'producto' | 'mes';
export type DireccionOrden = 'asc' | 'desc';

export interface FilaCatalogoDetallada extends FilaCatalogoProducto {
  /** Venta con impuestos del 1 a hoy. null = no se pudo medir («Sin dato», nunca un cero). */
  mes: number | null;
  mesAnterior: number | null;
  variacion: number | null;
  /** Líder #N. */
  lider: number | null;
  nuevo: string | null;
  caducidad: 'caducado' | 'pronto' | null;
}

export interface CatalogoListaDetallada {
  vista: 'detallado';
  sucursal: string;
  total: number;
  filas: FilaCatalogoDetallada[];
  calculado_al: string;
  mostrar: FiltroDetallado;
  orden: OrdenDetallado;
  dir: DireccionOrden;
  /** De la búsqueda entera. null = no se pudo medir (su porqué en notas). */
  conteos: Record<FiltroDetallado, number | null>;
  notas: Partial<Record<FiltroDetallado, string>>;
  venta: {
    medida: boolean;
    calculado_al: string | null;
    periodos: { hoy: string; mesIni: string; prevIni: string; prevFin: string; dias: number } | null;
  };
  /** false = esa familia de etiquetas no se pudo medir: un renglón sin etiqueta no dice «no es». */
  etiquetas: { lider: boolean; caducidad: boolean; nuevo: boolean };
  cuidar: { fuente: 'foto' | 'en_vivo'; calculado_at: string } | null;
}

export interface CatalogoDetalladoParams {
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  mostrar?: FiltroDetallado | null;
  orden?: OrdenDetallado | null;
  dir?: DireccionOrden | null;
}

/** Ficha detallada › compras (entradas XA20) de la ventana y la última entrada. */
export interface ComprasProducto {
  desde: string;
  dias: number;
  entradas: number;
  comprado: Array<{ unidad: string; cantidad: number }>;
  primera: string | null;
  ultima: { fecha: string; sucursal: string; nombreSucursal: string | null; cantidad: number; unidad: string; costo: number | null } | null;
  costo_visible: boolean;
}

@Injectable({ providedIn: 'root' })
export class CatalogoProductosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/products/catalogo`;

  lista(p: CatalogoListaParams = {}): Observable<CatalogoLista> {
    let params = new HttpParams();
    const search = p.search?.trim();
    if (search) params = params.set('search', search);
    if (p.sucursal) params = params.set('sucursal', p.sucursal);
    if (p.page != null) params = params.set('page', String(p.page));
    if (p.pageSize != null) params = params.set('pageSize', String(p.pageSize));
    if (p.mostrar && p.mostrar !== 'todos') params = params.set('mostrar', p.mostrar);
    return this.http.get<CatalogoLista>(this.base, { params });
  }

  /** Vista Detallado: filtra, cuenta, ordena y pagina el servidor. */
  detallado(p: CatalogoDetalladoParams = {}): Observable<CatalogoListaDetallada> {
    let params = new HttpParams().set('vista', 'detallado');
    const search = p.search?.trim();
    if (search) params = params.set('search', search);
    if (p.page != null) params = params.set('page', String(p.page));
    if (p.pageSize != null) params = params.set('pageSize', String(p.pageSize));
    if (p.mostrar && p.mostrar !== 'todos') params = params.set('mostrar', p.mostrar);
    if (p.orden) params = params.set('orden', p.orden);
    if (p.dir) params = params.set('dir', p.dir);
    return this.http.get<CatalogoListaDetallada>(this.base, { params });
  }

  compras(id: string): Observable<ComprasProducto> {
    return this.http.get<ComprasProducto>(`${this.base}/${encodeURIComponent(id)}/compras`);
  }

  ficha(id: string, sucursal?: string | null): Observable<FichaProducto> {
    const params = sucursal ? new HttpParams().set('sucursal', sucursal) : undefined;
    return this.http.get<FichaProducto>(`${this.base}/${encodeURIComponent(id)}/ficha`, { params });
  }
}
