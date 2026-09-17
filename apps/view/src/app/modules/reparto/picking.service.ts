import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
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
}

export interface PoolResponse {
  data: PoolOrder[];
  count: number;
  capped: boolean;
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
  private readonly base = `${environment.apiUrl}/almacen/surtido`;

  pool(opts: { warehouseId?: string; deliveryDate?: string } = {}): Observable<PoolResponse> {
    let params = new HttpParams();
    if (opts.warehouseId) params = params.set('warehouse_id', opts.warehouseId);
    if (opts.deliveryDate) params = params.set('delivery_date', opts.deliveryDate);
    return this.http.get<PoolResponse>(`${this.base}/pool`, { params });
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

  finish(id: string): Observable<Wave> {
    return this.http.post<Wave>(`${this.base}/waves/${id}/finish`, {});
  }
}
