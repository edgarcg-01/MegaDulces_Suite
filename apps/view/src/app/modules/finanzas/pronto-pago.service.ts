import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** `[PP.1]` En qué punto de su ventana de pronto pago está una factura pendiente. */
export type EstadoPronto = 'capturable' | 'por_vencer' | 'fuera_de_ventana' | 'sin_medir';

/**
 * `[PP.2]` Por qué decimos lo que decimos de esta factura. Va aparte del estado: el estado
 * contesta «¿puedo actuar sobre una fecha?», el motivo «¿por qué, y qué hago si no?».
 */
export type MotivoPronto = 'historial' | 'historial_disperso' | 'nunca_dio' | 'pocas_veces' | 'sin_fecha';

export interface ProntoPagoRow {
  sucursal: string;
  proveedor_code: string;
  proveedor_nombre: string | null;
  folio: string;
  fecha: string | null;
  vencimiento: string | null;
  pendiente: number;
  /** Tasa OBSERVADA (no pactada). `null` = el proveedor no tiene suficientes observaciones. */
  tasa_observada: number | null;
  beneficio: number | null;
  dias_mediana: number | null;
  n_observaciones: number;
  fecha_limite: string | null;
  dias_restantes: number | null;
  estado: EstadoPronto;
  /** `[PP.2]` Por qué. Lo arma el SERVIDOR: es el único que sabe con qué evidencia se calculó. */
  motivo: MotivoPronto;
  /** La misma razón, en una frase que se lee sin saber de dónde salió el número. */
  porque: string;
}

export interface ProntoPagoBalde { estado: string; docs: number; monto: number; beneficio: number }

export interface ProntoPagoResponse {
  /** ADR-056 — el número dice con qué se calculó. La ventana es OBSERVADA, no pactada. */
  procedencia: { ventana: string; min_observaciones: number; dias_aviso: number; nota: string };
  kpis: {
    capturable: ProntoPagoBalde;
    por_vencer: ProntoPagoBalde;
    fuera_de_ventana: ProntoPagoBalde;
    sin_medir: ProntoPagoBalde;
    total_pendiente: number;
    beneficio_en_juego: number;
  };
  /** Lo ya perdido, leído de `finance.findings` — no se vuelve a detectar con otra definición. */
  perdido: { hallazgos: number; monto: number; sin_triage: number; ultimo: string | null };
  rows: ProntoPagoRow[];
  truncado: boolean;
}

@Injectable({ providedIn: 'root' })
export class ProntoPagoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/pronto-pago`;

  overview(q: { estado?: EstadoPronto | ''; search?: string; limit?: number } = {}): Observable<ProntoPagoResponse> {
    const p = new URLSearchParams();
    if (q.estado) p.set('estado', q.estado);
    if (q.search) p.set('search', q.search);
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<ProntoPagoResponse>(`${this.base}${qs ? '?' + qs : ''}`);
  }
}
