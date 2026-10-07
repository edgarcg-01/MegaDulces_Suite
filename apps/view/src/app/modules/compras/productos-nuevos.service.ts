import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[NP.5]` Productos nuevos — cliente de `GET /commercial/products/new-products`.
 *
 * Las formas reflejan `libs/commercial/.../new-products.ts`. Las decisiones (etapa, estado,
 * hitos, cohortes) las toma el servidor; aquí sólo se pintan.
 */

export type ClasificacionNueva = 'nuevo' | 'recodificacion' | 'promocion' | 'no_mercancia';
export type EtapaNueva = 'sin_movimiento' | 'mes_1' | 'mes_2' | 'mes_3' | 'graduado';
export type EstadoNuevo = 'seguimiento' | 'sin_movimiento' | 'no_medible' | 'excluido';
export type HitoNuevo = 30 | 60 | 90;

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
  dias_con_venta_30: number;
  ultima_venta: string | null;
  sin_venta_30: boolean;
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
  inversion: number | null;
  venta: number;
  venta_por_peso: number | null;
  recomprados: number;
  con_30_dias: number;
  sin_venta_30: number;
}

export interface RespuestaNuevos {
  calculado: boolean;
  calculado_at: string | null;
  historia_desde: string | null;
  costo_visible: boolean;
  resumen: ResumenNuevos | null;
  cohortes: CohorteNuevos[];
  filas: ProductoNuevo[];
}

@Injectable({ providedIn: 'root' })
export class ProductosNuevosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/products/new-products`;

  listar(): Observable<RespuestaNuevos> {
    return this.http.get<RespuestaNuevos>(this.base);
  }

  /** `clasificacion: null` quita la clasificación: el producto vuelve a "por confirmar". */
  clasificar(productId: string, clasificacion: ClasificacionNueva | null, nota: string | null): Observable<unknown> {
    return this.http.put(`${this.base}/${productId}/classification`, { kind: clasificacion, note: nota });
  }
}
