import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** CXP.2 — cliente del tablero maestro de Cuentas por Pagar. */

export interface PagosKpiTop { titulo: string; importe: number; proveedor: string | null; severity: string }
export interface PagosKpi { total: number; count: number; criticos: number; top: PagosKpiTop[] }
export interface PagosControl {
  kpis: { fuga_descuento: PagosKpi; doble_pago: PagosKpi; factura_duplicada: PagosKpi; dpo: PagosKpi };
  acciones: { pendientes: number; total_importe: number; top: { titulo: string; importe: number; finding_id: string | null }[] };
  reconciliacion: { desc_pago: number; desc_nota: number; total: number };
  hallazgos_abiertos: number;
}

export type ConciliacionEstado = 'cuadra' | 'revisar' | 'sin_banco' | 'sin_kepler';
export interface ConciliacionRow { mes: string; kepler: number; banco: number; n_kepler: number; n_banco: number; delta: number; estado: ConciliacionEstado }
export interface Conciliacion { rows: ConciliacionRow[]; totals: { kepler: number; banco: number; delta: number }; meses: number; cuadran: number }

@Injectable({ providedIn: 'root' })
export class PagosControlService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/pagos`;
  overview(): Observable<PagosControl> { return this.http.get<PagosControl>(`${this.base}/control`); }
  conciliacion(q: { from_mes?: string; to_mes?: string } = {}): Observable<Conciliacion> {
    const p = new URLSearchParams();
    if (q.from_mes) p.set('from_mes', q.from_mes);
    if (q.to_mes) p.set('to_mes', q.to_mes);
    const qs = p.toString();
    return this.http.get<Conciliacion>(`${this.base}/conciliacion${qs ? '?' + qs : ''}`);
  }
}
