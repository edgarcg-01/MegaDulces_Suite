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
  agotadas: Array<{ plaza: string; nombre: string | null }>;
  compra: AnalisisCompra;
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
}

@Injectable({ providedIn: 'root' })
export class ProductosFlujoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/products`;

  listar(ids: string[]): Observable<FlujoLista> {
    return this.http.get<FlujoLista>(`${this.base}/flow`, { params: new HttpParams().set('ids', ids.join(',')) });
  }

  detalle(id: string): Observable<FlujoDetalle> {
    return this.http.get<FlujoDetalle>(`${this.base}/${id}/flow`);
  }
}
