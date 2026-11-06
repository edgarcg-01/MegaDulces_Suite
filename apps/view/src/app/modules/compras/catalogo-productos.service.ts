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
  /** Lo vendido en el PERIODO pedido (por omisión, el mes). null = no se puede medir en ese periodo. */
  vendidoMes: { monto: number; unidadesBase: number } | null;
  /** null = no se pudo medir la existencia (se declara «Sin dato»). */
  existenciaBase: number | null;
  /** `[PF.23]` Desde cuándo vende en Kepler (YYYY-MM-DD); null = siempre. Ausente = servidor anterior. */
  corteKepler?: string | null;
  /** `[PF.23]` Sin corte a Kepler: su venta no se mide en ningún periodo. */
  sinCorte?: boolean;
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
  /** La última venta del periodo en alguna sucursal. */
  corteVenta: string | null;
  /** `[PF.23]` El periodo de la venta por sucursal. Ausente = servidor anterior (el mes en curso). */
  periodo?: { desde: string; hasta: string };
  ultimaEntrada: {
    sucursal: string;
    nombreSucursal: string | null;
    fecha: string;
    cantidad: number;
    unidad: string;
    /**
     * `[PF.12.3]` Por `unidad`, SIN IVA ni IEPS (la misma regla que la lista). null si quien consulta no lo ve,
     * o si la entrada no trae costo.
     */
    costo: number | null;
    /** `[PF.12.3]` Cómo se sabe que va sin impuestos; `sin_dato` = no se sabe y se dice. Ausente = servidor anterior. */
    impuesto?: ImpuestoEntrada;
    /** `[PF.22]` El costo en cada unidad (paquete, caja…), con la función del renglón. Ausente o [] = sólo el de la entrada. */
    porUnidad?: CostoEnUnidad[];
  } | null;
  costo_visible: boolean;
  calculado_al: string;
}

/**
 * `[PF.12.3]` Cómo se sabe que un costo de entrada va SIN IVA ni IEPS: `neto` (se capturó sin impuestos),
 * `descontado` (los traía y se le quitaron) o `sin_dato` (el renglón no dice; se muestra tal cual y se declara).
 */
export type ImpuestoEntrada = 'neto' | 'descontado' | 'sin_dato';

/** `[PF.12.3]` El último costo en una unidad del renglón (mismo orden que `unidades`). */
export interface CostoEnUnidad {
  unidad: string;
  /** Sin IVA ni IEPS, en esta unidad. */
  costo: number;
  /** El precio de lista de esta unidad sin impuestos (contra lo que se compara). null = sin precio o sin tasa. */
  precioSinImpuestos: number | null;
  /** El precio sin impuestos queda por debajo del costo. null = no se pudo comparar. */
  bajoCosto: boolean | null;
}

/** `[PF.12.3]` El último costo de compra (la última entrada XA20). */
export interface UltimoCosto {
  fecha: string;
  /** Código de la sucursal de la entrada; la pantalla la nombra. */
  sucursal: string;
  /** La unidad en que se capturó la entrada. */
  unidad: string;
  /** Sin IVA ni IEPS por `unidad`. null = la entrada no trae costo (se dice, nunca $0). */
  costo: number | null;
  impuesto: ImpuestoEntrada;
  /** Una por unidad del renglón. [] = sin convertir: la unidad de la entrada no está en la escalera. */
  porUnidad: CostoEnUnidad[];
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
  /**
   * `[PF.12.3]` Sólo Sencillo y sólo con `costo_visible`. null = sin entradas («Sin compras», nunca $0).
   * Ausente = no se pidió (Detallado) o el servidor no lo manda.
   */
  ultimoCosto?: UltimoCosto | null;
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
  /**
   * `[NP.22]` Los de la búsqueda en seguimiento de Productos nuevos (la lista con ese filtro la sirve Detallado).
   * null = Productos nuevos se está calculando («sin medir»); ausente = servidor anterior.
   */
  nuevos?: number | null;
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
  /** `[PF.12.3]` Si los renglones traen `ultimoCosto`. Ausente = servidor anterior: la columna no se pinta. */
  costo_visible?: boolean;
  /**
   * `[PF.12.3]` `false` = el costo no se pudo leer ahora (falló o tardó de más): «Sin dato», nunca «Sin compras».
   * null/ausente = no se pidió.
   */
  costo_medido?: boolean | null;
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
/** `[NP.22]` `lanzamiento` = el orden de Productos nuevos (lo que pide atención primero). */
export type OrdenDetallado = 'producto' | 'mes' | 'lanzamiento';
export type DireccionOrden = 'asc' | 'desc';

/**
 * `[NP.22]` Los sub-filtros de «Mostrar › Productos nuevos» (los de la pantalla que se unió a Productos).
 * `seguimiento` es el de entrada: el universo del resumen.
 */
export type ResultadoLanzamiento =
  | 'seguimiento' | 'sacar' | 'revisar' | 'agotado' | 'se_queda' | 'pronto'
  | 'sin_venta_30' | 'sin_movimiento' | 'no_medible' | 'excluido';

/** `[NP.22]` Lo que dice Productos nuevos de un renglón del catálogo (de la misma respuesta de Productos nuevos). */
export interface LanzamientoFila {
  estado: 'seguimiento' | 'sin_movimiento' | 'no_medible' | 'excluido';
  etapa: string;
  /** Días desde el lanzamiento; null = todavía no entra ni se vende. */
  dia: number | null;
  /** null = no está en seguimiento. */
  veredicto: 'se_queda' | 'revisar' | 'sacar' | 'agotado' | 'pronto' | null;
  motivo: string | null;
  posible_recodificacion: boolean;
  sin_venta_30: boolean;
  orden: number;
  etiqueta: string | null;
}

export interface FilaCatalogoDetallada extends FilaCatalogoProducto {
  /** Venta con impuestos del 1 a hoy. null = no se pudo medir («Sin dato», nunca un cero). */
  mes: number | null;
  mesAnterior: number | null;
  variacion: number | null;
  /** Líder #N. */
  lider: number | null;
  nuevo: string | null;
  caducidad: 'caducado' | 'pronto' | null;
  /** `[NP.22]` null = no es nuevo. Ausente = servidor anterior. */
  lanzamiento?: LanzamientoFila | null;
}

export interface CatalogoListaDetallada {
  vista: 'detallado';
  sucursal: string;
  /** `[PF.21]` Las sucursales de su alcance (para elegir de cuál es el precio). */
  sucursales?: { codigo: string; nombre: string }[];
  total: number;
  filas: FilaCatalogoDetallada[];
  calculado_al: string;
  mostrar: FiltroDetallado;
  orden: OrdenDetallado;
  dir: DireccionOrden;
  /** De la búsqueda entera. null = no se pudo medir (su porqué en notas). */
  conteos: Record<FiltroDetallado, number | null>;
  /** `[NP.22]` El sub-filtro de «Productos nuevos» aplicado; null/ausente = no se muestra «Productos nuevos» (o servidor anterior). */
  resultado?: ResultadoLanzamiento | null;
  /** `[NP.22]` De la búsqueda entera; null = Productos nuevos sin calcular; ausente = servidor anterior. */
  conteos_lanzamiento?: Record<ResultadoLanzamiento, number> | null;
  notas: Partial<Record<FiltroDetallado, string>>;
  venta: {
    medida: boolean;
    calculado_al: string | null;
    periodos: { hoy: string; mesIni: string; prevIni: string; prevFin: string; dias: number } | null;
  };
  /** false = esa familia de etiquetas no se pudo medir: un renglón sin etiqueta no dice «no es». */
  etiquetas: { lider: boolean; caducidad: boolean; nuevo: boolean };
  cuidar: { fuente: 'foto' | 'en_vivo'; calculado_at: string } | null;
  /** `[PF.12.3]` Como en Sencillo: si los renglones traen `ultimoCosto`. Ausente = la columna no se pinta. */
  costo_visible?: boolean;
  /** `[PF.12.3]` false = no se pudo leer ahora («Sin dato», no «Sin compras»). */
  costo_medido?: boolean | null;
}

export interface CatalogoDetalladoParams {
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  mostrar?: FiltroDetallado | null;
  orden?: OrdenDetallado | null;
  dir?: DireccionOrden | null;
  /** `[NP.22]` Sólo con `mostrar: 'nuevos'`. Default seguimiento (no se manda). */
  resultado?: ResultadoLanzamiento | null;
  /** `[PF.21]` De qué sucursal es el PRECIO. Sin ella, el servidor elige (la 01 si está en tu alcance). */
  sucursal?: string | null;
}

/** Ficha detallada › compras (entradas XA20) de la ventana y la última entrada. */
export interface ComprasProducto {
  desde: string;
  /** `[PF.23]` Último día de la ventana. Ausente = servidor anterior (hasta hoy). */
  hasta?: string;
  dias: number;
  /** `[PF.23]` Sucursales sin el periodo completo en Kepler (antes compraban en Wincaja). */
  incompletas?: Array<{ codigo: string; nombre: string | null; corte: string | null }>;
  entradas: number;
  comprado: Array<{ unidad: string; cantidad: number }>;
  primera: string | null;
  /** `[PF.12.3]` `costo` por `unidad` SIN IVA ni IEPS: el mismo número que la columna «Último costo» del catálogo. */
  ultima: {
    fecha: string; sucursal: string; nombreSucursal: string | null; cantidad: number; unidad: string; costo: number | null;
    impuesto?: ImpuestoEntrada;
  } | null;
  /** `[PF.12.3]` La regla del catálogo (todo el que lo ve), NO la del margen. */
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
    if (p.sucursal) params = params.set('sucursal', p.sucursal);
    if (p.page != null) params = params.set('page', String(p.page));
    if (p.pageSize != null) params = params.set('pageSize', String(p.pageSize));
    if (p.mostrar && p.mostrar !== 'todos') params = params.set('mostrar', p.mostrar);
    if (p.orden) params = params.set('orden', p.orden);
    if (p.dir) params = params.set('dir', p.dir);
    if (p.mostrar === 'nuevos' && p.resultado && p.resultado !== 'seguimiento') params = params.set('resultado', p.resultado);
    return this.http.get<CatalogoListaDetallada>(this.base, { params });
  }

  /** `[PF.23]` Sin periodo: los últimos 90 días (lo de siempre). */
  compras(id: string, periodo?: { desde: string; hasta: string } | null): Observable<ComprasProducto> {
    const params = periodo ? new HttpParams().set('desde', periodo.desde).set('hasta', periodo.hasta) : undefined;
    return this.http.get<ComprasProducto>(`${this.base}/${encodeURIComponent(id)}/compras`, { params });
  }

  /** `[PF.23]` Sin periodo: la venta del mes en curso (lo de siempre). */
  ficha(id: string, sucursal?: string | null, periodo?: { desde: string; hasta: string } | null): Observable<FichaProducto> {
    let params = new HttpParams();
    if (sucursal) params = params.set('sucursal', sucursal);
    if (periodo) params = params.set('desde', periodo.desde).set('hasta', periodo.hasta);
    return this.http.get<FichaProducto>(`${this.base}/${encodeURIComponent(id)}/ficha`, { params });
  }
}
