import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { UnidadEscalera } from '@megadulces/contracts';

/**
 * `[NP.5]` Productos nuevos — cliente de `/commercial/products/new-products`.
 *
 * Las formas reflejan `libs/commercial/.../new-products.ts`. Las decisiones (etapa, estado,
 * hitos, recomendación) las toma el servidor; aquí sólo se pintan.
 */

export type ClasificacionNueva = 'nuevo' | 'recodificacion' | 'promocion' | 'no_mercancia';
export type EtapaNueva = 'sin_movimiento' | 'mes_1' | 'mes_2' | 'mes_3' | 'graduado';
export type EstadoNuevo = 'seguimiento' | 'sin_movimiento' | 'no_medible' | 'excluido';
/**
 * `[NP.20]` «¿El lanzamiento funcionó?» — la compra la contesta Productos, no esta pantalla. `[NP.21]` `agotado`:
 * sin mercancía donde se vendía, la venta no se puede juzgar. Antes: recomprar · esperar · revisar · no_recomprar.
 */
export type VeredictoNuevo = 'se_queda' | 'revisar' | 'sacar' | 'agotado' | 'pronto';
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

export interface HitoValores {
  cerrado: boolean;
  inversion: number | null;
  /** Venta CON impuestos (lo que cobró la caja). */
  venta: number | null;
  /** `[NP.UI.1]` Venta SIN IVA/IEPS del tramo. NULL = no se pudo medir. Opcional: un servidor anterior no la manda. */
  venta_neta?: number | null;
  /** `[NP.UI.1]` Venta sin impuestos por cada $1 invertido (sin impuestos) en el tramo. */
  venta_por_peso?: number | null;
  /** `[NP.16]` Lo vendido en tienda Kepler en ese tramo, en las unidades en que se vendió. */
  unidades: UnidadesKepler;
  /** `[NP.6]` Semáforo contra el umbral registrado. NULL = no ha cerrado, o sin permiso de costo. */
  semaforo?: SemaforoHitoNuevo | null;
}

/** `[NP.6]` Los cinco estados del registro de umbrales: `sin_meta` y `sin_medir` NO son verde. */
export type EstadoSemaforo = 'ok' | 'warn' | 'bad' | 'sin_meta' | 'sin_medir';
export interface SemaforoHitoNuevo {
  kpi_key: string;
  valor: number | null;
  estado: EstadoSemaforo;
  motivo: string | null;
  escala_a: string | null;
  avance: number | null;
}

/**
 * `[NP.6]` Qué se pudo leer de los umbrales (no es lo mismo «no hay» que «no se pudo leer»). Los cortes no se guardan:
 * se derivan de la historia (sin tabla, 2026-11-04).
 */
export interface HitosInfoNuevos {
  umbrales_disponibles: boolean;
  umbrales: number;
}

/**
 * `[NP.18]` Cómo quedó la compra sin impuestos (la calcula el servidor). `medida = false` = no se pudieron leer los
 * renglones de compra: la inversión va como la escribió Kepler y puede traer impuestos.
 */
export interface CompraInfoNuevos {
  medida: boolean;
  documentos: number;
  descontados: number;
  sin_documento: number;
  no_cuadra: number;
}

/** `[NP.16]` Cuándo llegó a la empresa (barrido del kardex de Kepler). */
export interface LlegadaNueva {
  /** La primera compra física (orden de entrada). NULL = no hay compra en Kepler. */
  fecha: string | null;
  sucursales: Array<{ plaza: string; nombre: string | null }>;
  /** `kardex` = del barrido; `compra_aplicada` = el kardex no trae nada. */
  fuente: 'kardex' | 'compra_aplicada';
  /** Si entró antes por otro camino, o no hubo compra: cuándo y por qué documento. */
  antes: { fecha: string; tipo: string } | null;
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
  /** Venta CON impuestos. */
  venta_total: number | null;
  /** `[NP.UI.1]` Venta SIN IVA/IEPS. NULL = no se pudo medir. */
  venta_neta_total?: number | null;
  /** `[NP.UI.1]` Venta SIN impuestos por cada $1 invertido (compra sin impuestos). */
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
  /** `[NP.16]` NULL = no hay compra ni entrada con qué fecharlo. */
  llegada: LlegadaNueva | null;
  /** `[NP.16]` La escalera de unidades común a sus sucursales; NULL = sin ficha o fichas distintas. */
  escalera: UnidadEscalera[] | null;
  /** `[NP.16]` Sucursales cuya existencia de Kepler está en duda. */
  existencia_en_duda: number;
}

/**
 * `[NP.16]` La existencia de Kepler no se puede creer: sumó renglones de otro rótulo (paquetes) como
 * si fueran de la base de la ficha (piezas). `estimada` = convirtiéndolos; NULL = no se pudo convertir.
 */
export interface ExistenciaDudaNueva {
  kepler: number;
  estimada: number | null;
  base: string;
  otros: string[];
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
  /** `[NP.UI.1]` Venta SIN impuestos de la sucursal. NULL = no se pudo medir. */
  venta_neta_total?: number | null;
  venta_28: number;
  dias_con_venta_28: number;
  inversion_total: number | null;
  entradas: number;
  primera_recompra: string | null;
  existencia: number | null;
  /** Rótulo de la ficha de Kepler de la plaza; NULL = no se sabe (Wincaja o sin ficha). */
  existencia_unidad: string | null;
  existencia_fuente: string | null;
  /** `[NP.16]` La escalera de unidades de la ficha de esta sucursal; NULL = sin ficha. */
  escalera: UnidadEscalera[] | null;
  /** `[NP.16]` NULL = la existencia de Kepler se puede creer. */
  existencia_duda: ExistenciaDudaNueva | null;
  unidades_vendidas: UnidadesKepler;
  venta_sin_unidad: number;
  unidades_recibidas: UnidadesKepler;
  /** `[NP.16]` Lo que le llegó de otra sucursal (traspaso). */
  recibido_traspaso: UnidadesKepler;
  /** `[NP.16]` Lo que mandó a otras sucursales. */
  enviado_sucursales: UnidadesKepler;
  /** `[NP.16]` Lo que mandó a camiones de ruta. */
  enviado_rutas: UnidadesKepler;
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
  /** Productos con inversión Y venta neta medidas: el universo del cociente. */
  con_inversion: number;
  inversion: number | null;
  venta: number;
  /** `[NP.UI.1]` Venta SIN impuestos del universo del cociente. */
  venta_neta?: number | null;
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
  /** `[NP.UI.1]` Venta SIN impuestos del universo del cociente. */
  venta_neta?: number | null;
  /** Productos que entran al cociente (inversión y venta neta medidas). */
  con_inversion?: number;
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

/** `[NP.20]` El criterio del juicio del lanzamiento (antes `CriterioRecompra`; ya sin `recuperadoAlto`). */
export interface CriterioLanzamiento {
  diasMinimos: number;
  ventana: number;
  diasConVentaSano: number;
  caidaMaxima: number;
  sinVentaDias: number;
}

export interface RespuestaNuevos {
  calculado: boolean;
  frescura: FrescuraNuevos | null;
  costo_visible: boolean;
  criterio: CriterioLanzamiento;
  resumen: ResumenNuevos | null;
  cohortes: CohorteNuevos[];
  filas: ProductoNuevo[];
  /** `[NP.6]` NULL/ausente = la lista no se calculó o el servidor es anterior a NP.6. */
  hitos_info?: HitosInfoNuevos | null;
  /** `[NP.18]` NULL/ausente = no se calculó o el servidor es anterior. */
  compra_info?: CompraInfoNuevos | null;
}

export interface DetalleNuevo {
  frescura: FrescuraNuevos;
  costo_visible: boolean;
  producto: ProductoNuevo;
  plazas: PlazaNueva[];
  hitos_info?: HitosInfoNuevos | null;
  compra_info?: CompraInfoNuevos | null;
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
