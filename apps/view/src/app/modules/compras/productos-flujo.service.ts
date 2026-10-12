import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { UnidadEscalera } from '@megadulces/contracts';
import type { ExistenciaDudaNueva, UnidadesKepler } from './productos-nuevos.service';

/**
 * `[PF.1]` Flujo de venta de cualquier producto: el mes contra los mismos días del anterior en tiempo
 * real, dónde se estancó y si hace falta comprar. Espejo de `libs/commercial/.../product-flow.ts`.
 */

export interface PeriodosFlujo {
  hoy: string;
  mesIni: string;
  dias: number;
  prevIni: string;
  prevFin: string;
  desde30: string;
  desdeHistoria: string;
}

export interface CriterioFlujo {
  ventanaRitmo: number;
  ventanaHistoria: number;
  diasEstancado: number;
  caidaFrenado: number;
  diasMinimosComparar: number;
  coberturaComprar: number;
  coberturaSobra: number;
  coberturaQueSeQueda: number;
  ventanaReparto: number;
  lideresCorte: number;
  coberturaComprarLider: number;
  caducidadAviso: number;
  diasSinVenta: number;
  ventanaSinVenta: number;
  ventanaNuevos: number;
  limiteNoSeVenden: number;
  ventanaMargen: number;
}

/** `[PF.5]` Un margen con lo que alcanza a cubrir (la forma de `[NP.15]`). */
export interface Margen {
  pct: number | null;
  utilidad: number | null;
  cobertura: number | null;
  nota: string | null;
}

export interface Margenes {
  venta_neta: number;
  lista: Margen;
  real: Margen;
  pagado: Margen;
  costo_pagado: { unidad: string; por_unidad: number } | null;
}

export interface MargenesProducto {
  product_id: string;
  /** `[PF.8]` La matvista nocturna (`foto`) o el cálculo en el momento (`en_vivo`). */
  origen?: { fuente: 'foto' | 'en_vivo'; calculado_at: string | null };
  desde: string;
  hasta: string;
  dias: number;
  total: Margenes | null;
  plazas: Array<{ plaza: string; nombre: string | null; margenes: Margenes }>;
}

export type TramoSinVenta = 'mes' | 'trimestre' | 'anio';

/** `[PF.4]` Un producto con existencia que no se vende. */
export interface NoSeVende {
  product_id: string;
  sku: string;
  nombre: string | null;
  existencia: number;
  valor: number | null;
  valor_incompleto: boolean;
  plazas: Array<{ plaza: string; nombre: string | null }>;
  ultima_venta: string | null;
  dias_sin_venta: number | null;
  tramo: TramoSinVenta;
  escalera: UnidadEscalera[] | null;
  caducidad: CaducidadResumen | null;
}

/** `[PF.2]` Lugar en la venta de la red en 90 días. */
export interface Lider {
  rank: number;
  participacion: number;
}

export type MotivoLider = 'agotado' | 'comprar' | 'mover' | 'se_freno';

/** `[PF.3]` Resumen de los lotes con fecha registrada de un producto. Cantidades en unidad base. */
export interface CaducidadResumen {
  vencido: number;
  en_riesgo: number;
  por_caducar: number;
  proxima: string | null;
  plazas_vencido: string[];
  plazas_en_riesgo: string[];
  lotes: number;
}

export type EstadoLote = 'caducado' | 'no_alcanza' | 'justo' | 'a_tiempo';

export interface LoteCaducidad {
  plaza: string;
  nombre: string | null;
  lote: string | null;
  caduca: string;
  dias: number;
  registrado: number;
  en_existencia: number | null;
  se_vende_antes: number;
  queda: number;
  estado: EstadoLote;
  accion: string;
  mover_a: Array<{ plaza: string; nombre: string | null; cantidad: number }>;
  sin_destino: number;
  escalera: UnidadEscalera[] | null;
}

export type VeredictoCompra = 'comprar' | 'traspasar' | 'esperar' | 'sobra' | 'no_comprar' | 'sin_movimiento';
export type EstadoPlaza = 'se_mueve' | 'le_sobra' | 'se_freno' | 'estancado' | 'agotado' | 'sin_movimiento';

export interface TraspasoSugerido {
  desde: string;
  desde_nombre: string | null;
  hacia: string;
  hacia_nombre: string | null;
  cantidad: number;
}

export interface AnalisisCompra {
  veredicto: VeredictoCompra;
  titulo: string;
  motivos: string[];
  impacto: string[];
  traspasos: TraspasoSugerido[];
  cobertura_dias: number | null;
  se_acaba: string | null;
  venta_en_riesgo_dia: number;
  inmovilizado: number | null;
}

export interface FlujoResumen {
  product_id: string;
  mes: number;
  mes_anterior_mismo: number;
  mes_anterior_total: number;
  variacion: number | null;
  venta_dia: number;
  estancadas: Array<{ plaza: string; nombre: string | null; dias_sin_venta: number | null }>;
  frenadas: Array<{ plaza: string; nombre: string | null; variacion: number | null }>;
  agotadas: Array<{ plaza: string; nombre: string | null; venta_dia: number }>;
  compra: AnalisisCompra;
  lider: Lider | null;
  caducidad: CaducidadResumen | null;
  /** `[PF.5]` Margen real de los últimos días cerrados. Sólo con permiso de costo. */
  margen_real?: Margen | null;
}

export interface FlujoLista {
  periodos: PeriodosFlujo;
  corte: string;
  en_vivo_al: string;
  costo_visible: boolean;
  criterio: CriterioFlujo;
  productos: FlujoResumen[];
}

export interface PlazaFlujo {
  plaza: string;
  nombre: string | null;
  mes: number;
  mes_anterior_mismo: number;
  mes_anterior_total: number;
  variacion: number | null;
  venta_dia: number;
  unidades_dia: number;
  ultima_venta: string | null;
  dias_sin_venta: number | null;
  existencia: number | null;
  existencia_duda: ExistenciaDudaNueva | null;
  existencia_usada: number | null;
  cobertura_dias: number | null;
  estado: EstadoPlaza;
  motivo: string;
  escalera: UnidadEscalera[] | null;
  inmovilizado: number | null;
}

export interface RepartoPlaza {
  plaza: string;
  nombre: string | null;
  comprado: UnidadesKepler;
  recibido: UnidadesKepler;
  mandado_sucursales: UnidadesKepler;
  mandado_rutas: UnidadesKepler;
  escalera: UnidadEscalera[] | null;
}

export interface FlujoDetalle {
  product_id: string;
  sku: string;
  nombre: string | null;
  periodos: PeriodosFlujo;
  corte: string;
  en_vivo_al: string;
  costo_visible: boolean;
  criterio: CriterioFlujo;
  resumen: FlujoResumen;
  serie: { dias: number[]; actual: Array<number | null>; anterior: number[] };
  plazas: PlazaFlujo[];
  llegada: {
    primera_compra: string | null;
    primera_compra_plazas: Array<{ plaza: string; nombre: string | null }>;
    ultima_compra: string | null;
    ultima_compra_plazas: Array<{ plaza: string; nombre: string | null }>;
  };
  reparto: RepartoPlaza[];
  escalera: UnidadEscalera[] | null;
  lotes: LoteCaducidad[];
}

/** `[PF.7]` Lo que «Para cuidar hoy» trae de cada producto (el análisis completo llega al abrirlo). */
export interface ResumenCuidar {
  product_id: string;
  mes: number;
  variacion: number | null;
  lider: Lider | null;
  caducidad: CaducidadResumen | null;
  agotadas: Array<{ plaza: string; nombre: string | null }>;
  compra: Pick<AnalisisCompra, 'veredicto' | 'titulo'>;
  margen_real: Pick<Margen, 'pct' | 'cobertura'> | null;
}

export interface ProductoACuidar {
  sku: string;
  nombre: string | null;
  resumen: ResumenCuidar;
  motivos?: MotivoLider[];
  en_juego_dia?: number;
}

/** `[PF.2]`/`[PF.3]` Para cuidar hoy. */
export interface CuidarRespuesta {
  /** `[PF.6]` La foto del worker (cada minuto) o el cálculo en vivo; y cuándo se calculó. */
  origen?: { fuente: 'foto' | 'en_vivo'; calculado_at: string };
  periodos: PeriodosFlujo;
  corte: string;
  en_vivo_al: string;
  costo_visible: boolean;
  criterio: CriterioFlujo;
  lideres: { total: number; calculado: string | null; lista: ProductoACuidar[]; por_motivo: Record<MotivoLider, number> };
  no_se_venden: { nuevos_excluidos: boolean; total: number; valor_total: number | null; por_tramo: Record<TramoSinVenta, number>; productos: NoSeVende[] };
  caducidad: {
    productos: ProductoACuidar[];
    cobertura: { lotes: number; productos: number; sucursales: Array<{ plaza: string; nombre: string | null }> };
  };
}

@Injectable({ providedIn: 'root' })
export class ProductosFlujoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/products`;

  listar(ids: string[]): Observable<FlujoLista> {
    return this.http.get<FlujoLista>(`${this.base}/flow`, { params: new HttpParams().set('ids', ids.join(',')) });
  }

  cuidar(): Observable<CuidarRespuesta> {
    return this.http.get<CuidarRespuesta>(`${this.base}/flow/cuidar`);
  }

  margenes(id: string): Observable<MargenesProducto> {
    return this.http.get<MargenesProducto>(`${this.base}/${id}/flow/margins`);
  }

  detalle(id: string): Observable<FlujoDetalle> {
    return this.http.get<FlujoDetalle>(`${this.base}/${id}/flow`);
  }
}
