import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[NP.5]` Productos nuevos — cliente de `/commercial/products/new-products`.
 *
 * Las formas reflejan `libs/commercial/.../new-products.ts`. Las decisiones (etapa, estado,
 * hitos, recomendación) las toma el servidor; aquí sólo se pintan.
 */

export type ClasificacionNueva = 'nuevo' | 'recodificacion' | 'promocion' | 'no_mercancia';
export type EtapaNueva = 'sin_movimiento' | 'mes_1' | 'mes_2' | 'mes_3' | 'graduado';
export type EstadoNuevo = 'seguimiento' | 'sin_movimiento' | 'no_medible' | 'excluido';
export type VeredictoNuevo = 'recomprar' | 'esperar' | 'revisar' | 'no_recomprar' | 'pronto';
export type HitoNuevo = 30 | 60 | 90;

export interface Recomendacion {
  veredicto: VeredictoNuevo;
  motivos: string[];
}

/**
 * Cantidad por rótulo de Kepler (`{ CJA: 3, PZA: 40 }`), tal como lo declaró el renglón. Cada
 * rótulo por su lado: no se suman entre sí. `?` = renglón sin unidad declarada.
 */
export type UnidadesKepler = Record<string, number>;

export interface CantidadEnUnidad {
  unidad: string;
  cantidad: number;
}

export interface HitoValores {
  cerrado: boolean;
  inversion: number | null;
  venta: number | null;
}

export interface ProductoNuevo {
  product_id: string;
  sku: string;
  nombre: string | null;
  marca: string | null;
  proveedor: string | null;
  alta_suite: string;
  alta_en_lote: boolean;
  primera_recepcion: string | null;
  primera_venta: string | null;
  lanzamiento: string | null;
  dia: number | null;
  fuentes: string[];
  etapa: EtapaNueva;
  estado: EstadoNuevo;
  motivo: string | null;
  posible_recodificacion: boolean;
  clasificacion: ClasificacionNueva | null;
  nota: string | null;
  clasificado_por: string | null;
  hitos: Record<HitoNuevo, HitoValores>;
  inversion_total: number | null;
  venta_total: number | null;
  venta_por_peso: number | null;
  entradas: number;
  plazas_recibido: number;
  primera_recompra: string | null;
  dia_recompra: number | null;
  plazas_venta: number;
  plazas_con_existencia: number;
  agotado_en: number;
  dias_con_venta_30: number;
  dias_con_venta_28: number;
  venta_28: number;
  tendencia: number | null;
  ultima_venta: string | null;
  sin_venta_30: boolean;
  semanas: number[];
  venta_hoy: number;
  /** Venta en tienda Kepler, en las unidades en que se vendió. */
  unidades_vendidas: UnidadesKepler;
  /** Pesos sin unidad de Kepler (ruta y plazas en Wincaja). */
  venta_sin_unidad: number;
  unidades_recibidas: UnidadesKepler;
  unidades_hoy: UnidadesKepler;
  recomendacion: Recomendacion | null;
  /** `[NP.15]` NULL = sin venta en la historia, o sin permiso de costo. */
  margenes: MargenesNuevo | null;
  /** `[NP.15]` La sucursal donde mejor se mueve. NULL = ninguna compite todavía. */
  mejor_plaza: MejorPlazaNuevo | null;
}

/** `[NP.15]` Un margen con lo que alcanza a cubrir; `pct` NULL = no se pudo medir (`nota` dice por qué). */
export interface MargenNuevo {
  pct: number | null;
  utilidad: number | null;
  /** Qué parte de la venta sin impuesto cubre (0 a 1). */
  cobertura: number | null;
  nota: string | null;
}

/** `[NP.15]` Los tres márgenes, sobre la venta SIN IVA/IEPS de la historia. */
export interface MargenesNuevo {
  venta_neta: number;
  lista: MargenNuevo;
  real: MargenNuevo;
  pagado: MargenNuevo;
  costo_pagado: { unidad: string; por_unidad: number } | null;
}

export interface MovilidadNueva {
  venta_neta_dia: number | null;
  dias: number | null;
  /** De lo que pasó por la sucursal (vendido + existencia), qué parte se vendió (0 a 1). */
  desplazado: number | null;
  /** 1 = la que mejor se mueve; NULL = todavía no compite. */
  lugar: number | null;
}

export interface MejorPlazaNuevo {
  plaza: string;
  nombre: string | null;
  venta_neta_dia: number;
  dias: number;
}

export interface PlazaNueva {
  plaza: string;
  nombre: string | null;
  dia: number | null;
  primera_actividad: string | null;
  venta_total: number;
  venta_28: number;
  dias_con_venta_28: number;
  inversion_total: number | null;
  entradas: number;
  primera_recompra: string | null;
  existencia: number | null;
  /** Rótulo de la ficha de Kepler de la plaza; NULL = no se sabe (Wincaja o sin ficha). */
  existencia_unidad: string | null;
  existencia_fuente: string | null;
  existencia_mayor: CantidadEnUnidad | null;
  unidades_vendidas: UnidadesKepler;
  venta_sin_unidad: number;
  unidades_recibidas: UnidadesKepler;
  unidades_hoy: UnidadesKepler;
  ultima_venta: string | null;
  semanas: number[];
  venta_hoy: number;
  recomendacion: Recomendacion;
  margenes: MargenesNuevo | null;
  movimiento: MovilidadNueva;
}

export interface CohorteNuevos {
  mes: string;
  productos: number;
  con_inversion: number;
  inversion: number | null;
  venta: number;
  venta_por_peso: number | null;
  recomprados: number;
  con_30_dias: number;
  sin_venta_30: number;
}

export interface ResumenNuevos {
  total: number;
  seguimiento: number;
  por_confirmar: number;
  sin_movimiento: number;
  no_medible: number;
  excluido: number;
  por_etapa: Record<'mes_1' | 'mes_2' | 'mes_3' | 'graduado', number>;
  por_veredicto: Record<VeredictoNuevo, number>;
  inversion: number | null;
  venta: number;
  venta_hoy: number;
  venta_por_peso: number | null;
  recomprados: number;
  con_30_dias: number;
  sin_venta_30: number;
}

export interface FrescuraNuevos {
  historia_al: string | null;
  corte: string | null;
  en_vivo_al: string;
  hoy: string;
}

export interface CriterioRecompra {
  diasMinimos: number;
  ventana: number;
  diasConVentaSano: number;
  caidaMaxima: number;
  recuperadoAlto: number;
  sinVentaDias: number;
}

export interface RespuestaNuevos {
  calculado: boolean;
  frescura: FrescuraNuevos | null;
  costo_visible: boolean;
  criterio: CriterioRecompra;
  resumen: ResumenNuevos | null;
  cohortes: CohorteNuevos[];
  filas: ProductoNuevo[];
}

export interface DetalleNuevo {
  frescura: FrescuraNuevos;
  costo_visible: boolean;
  producto: ProductoNuevo;
  plazas: PlazaNueva[];
}

@Injectable({ providedIn: 'root' })
export class ProductosNuevosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/products/new-products`;

  listar(): Observable<RespuestaNuevos> {
    return this.http.get<RespuestaNuevos>(this.base);
  }

  /** Un producto, sucursal por sucursal. */
  detalle(productId: string): Observable<DetalleNuevo> {
    return this.http.get<DetalleNuevo>(`${this.base}/${productId}`);
  }
}
