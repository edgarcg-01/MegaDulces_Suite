import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ConsolaSurtidoAlmacen,
  ConsolaSurtidoResponse,
  KeplerWavesAutoResponse,
  PickerTakeNextResponse,
  PickerWave,
  RouteKind,
  RouteKindMotivo,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** Un pedido esperando surtido (lo que hoy se resuelve por WhatsApp). */
export interface PoolOrder {
  id: string;
  code: string;
  customer_id: string;
  customer_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  requested_delivery_date: string | null;
  total: string | number;
  confirmed_at: string | null;
  lines: number;
  units: string | number;
  /** `[VEC.2]` Ruta del cliente (derivada, no snapshot). `null` = no se pudo resolver. */
  sales_route: string | null;
  /** `[VEC.1]` Tipo de esa ruta. `null` = nadie lo declaró — ver `route_kind_motivo`. */
  route_kind: RouteKind | null;
  /** Por qué no hay tipo. Cada motivo tiene un dueño distinto; NULL a secas no sirve. */
  route_kind_motivo: RouteKindMotivo | null;
}

/**
 * `[VEC.4]` Un aviso a la sucursal: "tenés este pedido por armar".
 *
 * Lo que lo hace distinto del pool: el pool es el ESTADO de ahora ("qué falta surtir"); esto es
 * un HECHO con acuse ("se avisó, y alguien lo vio o no"). Un pedido ya surtido sale del pool y
 * su aviso queda — así se puede responder *"¿nos avisaron?"* días después.
 */
export interface Aviso {
  id: string;
  order_id: string;
  warehouse_id: string;
  warehouse_name: string | null;
  created_at: string;
  /** `null` = nadie lo ha acusado todavía. Es lo que hace que sobreviva a no estar mirando. */
  seen_at: string | null;
  code: string;
  status: string;
  total: string | number;
  requested_delivery_date: string | null;
  customer_name: string | null;
  sales_route: string | null;
  route_kind: RouteKind | null;
  route_kind_motivo: RouteKindMotivo | null;
  /** Ya entró a una ola: separa "falta armarlo" de "ya lo armé". */
  en_ola: boolean;
}

export interface AvisosResponse {
  data: Aviso[];
  count: number;
  pendientes: number;
  /**
   * De dónde sale el recorte. `todos` = el usuario no tiene alcance declarado y ve todo (no es
   * un privilegio: es que `users.warehouse_id` está poblado en 1 de 6 almacenistas y filtrar
   * por ahí los dejaría ciegos). `ninguno` = tiene alcance y no incluye almacenes vivos.
   */
  alcance: 'todos' | 'recortado' | 'ninguno';
}

/** `[VEC.10]` Una sucursal que SÍ tiene lo que falta. */
export interface SugerenciaSucursal {
  warehouse_id: string;
  name: string;
  disponible: string | number;
  /** Línea recta desde la sucursal del pedido. `null` = alguna de las dos no tiene coordenada. */
  km: string | number | null;
  sin_coordenada: boolean;
}

/** `[VEC.10]` Un renglón que no alcanza, y de dónde traerlo. */
export interface Faltante {
  order_id: string;
  code: string;
  warehouse_id: string;
  warehouse_name: string | null;
  customer_name: string | null;
  sales_route: string | null;
  route_kind: RouteKind | null;
  product_id: string;
  /** ⚠️ 3,043 de 11,291 productos no tienen descripción: la pantalla cae al SKU. */
  sku: string | null;
  product_name: string | null;
  pedida: string | number;
  hay: string | number;
  falta: string | number;
  /** La sucursal DEL PEDIDO no tiene coordenada → ninguna distancia se pudo calcular. */
  origen_sin_coordenada: boolean;
  /** Vacío = ninguna sucursal lo cubre. Eso NO es un traslado: es una compra. */
  sugerencias: SugerenciaSucursal[];
}

export interface FaltantesResponse {
  data: Faltante[];
  count: number;
  /** Cuántos no los cubre ninguna sucursal. Se separa porque se resuelve distinto. */
  sin_alternativa: number;
  pendiente_offline: string;
}

/** Respuesta de armar la ola sola. `creada:false` NO es un error: es que no había qué armar. */
export interface OlaAutoResponse {
  creada: boolean;
  motivo?: string;
  detalle?: string;
  pendiente_offline?: string;
  id?: string;
  code?: string;
  orders_count?: number;
}

/**
 * `[VEC.8]` Un grupo del pool: los pedidos de UNA ruta en UNA sucursal.
 *
 * El grano es **(sucursal, ruta)**, no sólo la ruta: medido en prod, `RUTA 23` existe en
 * Padre Hidalgo **y** en La Piedad Abastos. Una ola por ruta sin acotar el almacén sería un
 * recorrido imposible — dos bodegas.
 */
export interface PoolGrupo {
  warehouse_id: string;
  warehouse_name: string | null;
  sales_route: string | null;
  route_kind: RouteKind | null;
  route_kind_motivo: RouteKindMotivo | null;
  pedidos: number;
  renglones: number;
  unidades: string;
  total: string;
}

export interface PoolResponse {
  data: PoolOrder[];
  count: number;
  capped: boolean;
  /** `[VEC.8]` Los mismos pedidos, agrupados por (sucursal, ruta). Derivados de `data`. */
  grupos: PoolGrupo[];
  /** ⚠️ Lo capturado sin señal todavía no llegó al servidor. Se declara, no se estima. */
  pendiente_offline: string;
}

export interface Wave {
  id: string;
  code: string;
  warehouse_id: string;
  warehouse_name?: string | null;
  delivery_date: string | null;
  status: 'abierta' | 'en_surtido' | 'surtida' | 'cancelada';
  assigned_to: string | null;
  started_at: string | null;
  finished_at: string | null;
  orders_count?: number;
  picked_by?: string | null;
  verified_by?: string | null;
}

/** Un renglón del recorrido: lo que pide la ola y lo que la persona levantó. */
export interface WaveLine {
  id: string;
  product_id: string;
  product_name: string | null;
  sku: string | null;
  qty_requested: string | number;
  /** `null` = las líneas venían en unidades distintas o sin declarar → se cuenta en base. */
  qty_unit: string | null;
  unidad_mixta: boolean;
  /** `null` = nadie pasó por este renglón. `0` con agotado = se pasó y no había. */
  qty_picked: string | number | null;
  status: 'pendiente' | 'surtido' | 'faltante' | 'agotado' | 'danado';
  bin_code: string | null;
  note: string | null;
}

export interface WaveDetail extends Wave {
  orders: Array<{
    wave_order_id: string;
    stage: string;
    order_id: string;
    code: string;
    total: string | number;
    customer_name: string | null;
  }>;
  consolidated: Array<{
    product_id: string;
    product_name: string | null;
    sku: string | null;
    total_base: number;
    qty_unit: string | null;
    unidad_mixta: boolean;
    unidades_capturadas: string[];
    por_pedido: Array<{ order_id: string; order_code: string; quantity: number }>;
  }>;
}

/**
 * Fase SU — surtido por olas (ADR-067). Una sola persona hace el flujo completo, así que este
 * servicio cubre las tres etapas que el documento original repartía en tres pantallas.
 */
@Injectable({ providedIn: 'root' })
export class PickingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/reparto/surtido`;

  pool(
    opts: {
      warehouseId?: string;
      deliveryDate?: string;
      routeKind?: readonly RouteKind[];
      /** [VEC.8] UNA ruta. Siempre con warehouseId: la misma ruta vive en dos sucursales. */
      salesRoute?: string;
    } = {},
  ): Observable<PoolResponse> {
    let params = new HttpParams();
    if (opts.warehouseId) params = params.set('warehouse_id', opts.warehouseId);
    if (opts.deliveryDate) params = params.set('delivery_date', opts.deliveryDate);
    // Lista vacía NO se manda: en el backend un filtro vacío devuelve TRUE (no filtra), pero
    // mandar `route_kind=` igual sería ruido en el log y en la URL. Sin filtro = todos.
    if (opts.routeKind?.length) params = params.set('route_kind', opts.routeKind.join(','));
    if (opts.salesRoute) params = params.set('sales_route', opts.salesRoute);
    return this.http.get<PoolResponse>(`${this.base}/pool`, { params });
  }

  /**
   * `[VEC.10]` Lo que no se va a poder surtir, con la sucursal más cercana que sí lo tiene.
   * Mismos filtros que el pool, para que lo que se ve acá corresponda a lo que se ve allá.
   */
  faltantes(
    opts: { warehouseId?: string; routeKind?: readonly RouteKind[]; salesRoute?: string } = {},
  ): Observable<FaltantesResponse> {
    let params = new HttpParams();
    if (opts.warehouseId) params = params.set('warehouse_id', opts.warehouseId);
    if (opts.routeKind?.length) params = params.set('route_kind', opts.routeKind.join(','));
    if (opts.salesRoute) params = params.set('sales_route', opts.salesRoute);
    return this.http.get<FaltantesResponse>(`${this.base}/faltantes`, { params });
  }

  /** `[VEC.4]` La bandeja de avisos de la sucursal. `soloPendientes` = lo que nadie acusó. */
  avisos(soloPendientes = false): Observable<AvisosResponse> {
    let params = new HttpParams();
    if (soloPendientes) params = params.set('pendientes', '1');
    return this.http.get<AvisosResponse>(`${this.base}/avisos`, { params });
  }

  /** `[VEC.4]` Acuse. Idempotente: re-marcar no pisa quién lo vio primero. */
  marcarVisto(id: string): Observable<Aviso> {
    return this.http.post<Aviso>(`${this.base}/avisos/${id}/visto`, {});
  }

  /**
   * `[VEC.5]` Arma la ola con todo lo pendiente de un tipo de ruta — el "pedido global".
   * Repetirlo es seguro: la segunda vez no hay elegibles y responde `creada:false`.
   */
  crearOlaAuto(dto: {
    warehouse_id: string;
    delivery_date?: string;
    route_kind?: readonly RouteKind[];
    /** `[VEC.8]` Armar la ola de UNA ruta: una ola = una ruta, mercancía ya separada. */
    sales_route?: string;
  }): Observable<OlaAutoResponse> {
    return this.http.post<OlaAutoResponse>(`${this.base}/waves/auto`, dto);
  }

  waves(status?: string): Observable<Wave[]> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    return this.http.get<Wave[]>(`${this.base}/waves`, { params });
  }

  wave(id: string): Observable<WaveDetail> {
    return this.http.get<WaveDetail>(`${this.base}/waves/${id}`);
  }

  createWave(dto: {
    warehouse_id: string;
    delivery_date?: string;
    order_ids: string[];
  }): Observable<Wave> {
    return this.http.post<Wave>(`${this.base}/waves`, dto);
  }

  cancelWave(id: string, reason?: string): Observable<Wave> {
    return this.http.post<Wave>(`${this.base}/waves/${id}/cancel`, { reason });
  }

  /** Congela el consolidado en renglones y devuelve el recorrido. */
  start(id: string): Observable<WaveLine[]> {
    return this.http.post<WaveLine[]>(`${this.base}/waves/${id}/start`, {});
  }

  lines(id: string): Observable<WaveLine[]> {
    return this.http.get<WaveLine[]>(`${this.base}/waves/${id}/lines`);
  }

  /** Marca cuánto se levantó de un renglón. No detiene el recorrido. */
  pick(
    waveId: string,
    lineId: string,
    dto: { qty_picked: number; status?: string; note?: string; bin_code?: string },
  ): Observable<WaveLine> {
    return this.http.post<WaveLine>(`${this.base}/waves/${waveId}/lines/${lineId}/pick`, dto);
  }

  finish(id: string): Observable<Wave & { cambios_en_kepler?: string[] }> {
    return this.http.post<Wave & { cambios_en_kepler?: string[] }>(`${this.base}/waves/${id}/finish`, {});
  }

  /**
   * `[GP.3]` "Tomar el siguiente": la ola que el surtidor ya trae, o la libre más vieja de su
   * almacén (armada desde Kepler si no hay). Llega arrancada, con sus renglones.
   */
  tomarSiguiente(dto: { warehouse_id: string; origen?: string }): Observable<PickerTakeNextResponse> {
    return this.http.post<PickerTakeNextResponse>(`${this.base}/waves/next`, dto);
  }

  /** `[GP.3]` Sucursales donde puede surtir quien consulta (con el permiso de surtir, no el de almacenes). */
  almacenesSurtido(): Observable<ConsolaSurtidoAlmacen[]> {
    return this.http.get<ConsolaSurtidoAlmacen[]>(`${this.base}/almacenes`);
  }

  /** `[GP.3]` Las olas abiertas o en surtido de quien consulta. */
  misOlas(): Observable<PickerWave[]> {
    return this.http.get<PickerWave[]>(`${this.base}/waves/mine`);
  }

  // ── [GP.3c] La consola del coordinador (permiso ALMACEN_SURTIDO_COORDINAR) ───────────────

  consolaAlmacenes(): Observable<ConsolaSurtidoAlmacen[]> {
    return this.http.get<ConsolaSurtidoAlmacen[]>(`${this.base}/consola/almacenes`);
  }

  consola(warehouseId: string): Observable<ConsolaSurtidoResponse> {
    return this.http.get<ConsolaSurtidoResponse>(`${this.base}/consola`, {
      params: new HttpParams().set('warehouse_id', warehouseId),
    });
  }

  consolaPrioridad(waveId: string, urgente: boolean, motivo?: string): Observable<{ id: string; prioridad: 0 | 1 }> {
    return this.http.post<{ id: string; prioridad: 0 | 1 }>(`${this.base}/consola/waves/${waveId}/prioridad`, { urgente, motivo });
  }

  consolaLiberar(waveId: string): Observable<{ id: string; liberada: true }> {
    return this.http.post<{ id: string; liberada: true }>(`${this.base}/consola/waves/${waveId}/liberar`, {});
  }

  consolaCancelar(waveId: string, motivo: string): Observable<{ id: string; cancelada: true }> {
    return this.http.post<{ id: string; cancelada: true }>(`${this.base}/consola/waves/${waveId}/cancelar`, { motivo });
  }

  consolaSalida(dto: {
    warehouse_id: string;
    destino_code: string;
    destino_nombre?: string | null;
    hora_salida: string | null;
  }): Observable<{ destino_code: string; hora_salida: string | null }> {
    return this.http.put<{ destino_code: string; hora_salida: string | null }>(`${this.base}/consola/salidas`, dto);
  }

  consolaUmbral(warehouseId: string, umbral: number): Observable<{ umbral_tanda: number }> {
    return this.http.put<{ umbral_tanda: number }>(`${this.base}/consola/ajustes`, { warehouse_id: warehouseId, umbral_tanda: umbral });
  }

  consolaArmar(warehouseId: string, origen?: string): Observable<KeplerWavesAutoResponse> {
    return this.http.post<KeplerWavesAutoResponse>(`${this.base}/consola/armar`, { warehouse_id: warehouseId, origen });
  }
}
