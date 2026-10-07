import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[BP.6]` Bitácora de retiros en caja — cliente HTTP de `commercial/pos-line-voids`.
 *
 * Registrar es ESCRIBIR, así que no hay modo sin red: un registro que se guarda sólo en el
 * navegador de una caja es un dato que nadie va a ver nunca. Si falla la red la pantalla lo dice
 * y deja reintentar; no finge que se guardó.
 */

export type VoidReason =
  | 'error_captura'
  | 'cliente_desistio'
  | 'precio_incorrecto'
  | 'producto_danado'
  | 'cantidad_incorrecta'
  | 'otro';

export const MOTIVO_LABEL: Record<VoidReason, string> = {
  error_captura: 'Error de captura',
  cliente_desistio: 'El cliente ya no lo quiso',
  precio_incorrecto: 'Precio incorrecto',
  producto_danado: 'Producto dañado',
  cantidad_incorrecta: 'Cantidad incorrecta',
  otro: 'Otro',
};

/** El orden en pantalla: lo más frecuente primero, y `otro` al final para que no sea el atajo. */
export const MOTIVOS: VoidReason[] = [
  'error_captura',
  'cantidad_incorrecta',
  'cliente_desistio',
  'precio_incorrecto',
  'producto_danado',
  'otro',
];

export interface RegistrarPayload {
  warehouse_code: string;
  caja?: string | null;
  supervisor_code: string;
  supervisor_name?: string | null;
  cashier_code?: string | null;
  sku?: string | null;
  scanned_code?: string | null;
  product_name?: string | null;
  qty_original: number;
  qty_final?: number;
  unidad?: string | null;
  reason: VoidReason;
  reason_note?: string | null;
  occurred_at?: string | null;
}

export interface RegistrarResultado {
  id: string;
  warehouse_code: string;
  sku: string | null;
  product_name: string | null;
  qty_retirada: number;
  est_value: number | null;
  est_source: 'precio_erp' | 'sin_dato';
  /** Por qué no se valoró, cuando no se valoró. La pantalla lo MUESTRA: no lo calla ni pinta $0. */
  est_motivo: string | null;
}

export interface Retiro {
  id: string;
  occurred_at: string;
  reported_at: string;
  warehouse_code: string;
  caja: string | null;
  supervisor_code: string;
  supervisor_name: string | null;
  cashier_code: string | null;
  sku: string | null;
  product_name: string | null;
  qty_original: number;
  qty_final: number;
  qty_retirada: number;
  unidad: string | null;
  reason: VoidReason;
  reason_note: string | null;
  est_value: number | null;
  est_source: string;
}

export interface ResumenSupervisor {
  supervisor_code: string;
  supervisor_name: string | null;
  eventos: number;
  /** Suma de lo valorado. Va SIEMPRE acompañado de `eventos_sin_valorar`. */
  valor_total: number | null;
  eventos_sin_valorar: number;
}

@Injectable({ providedIn: 'root' })
export class RetirosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/pos-line-voids`;

  registrar(payload: RegistrarPayload): Observable<RegistrarResultado> {
    return this.http.post<RegistrarResultado>(this.base, payload);
  }

  porSucursal(code: string, dias = 30): Observable<Retiro[]> {
    return this.http.get<Retiro[]>(`${this.base}/sucursal/${encodeURIComponent(code)}`, {
      params: { dias: String(dias) },
    });
  }

  porSupervisor(code: string, dias = 30): Observable<ResumenSupervisor[]> {
    return this.http.get<ResumenSupervisor[]>(
      `${this.base}/sucursal/${encodeURIComponent(code)}/por-supervisor`,
      { params: { dias: String(dias) } },
    );
  }
}
