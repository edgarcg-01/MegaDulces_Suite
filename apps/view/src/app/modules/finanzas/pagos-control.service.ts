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
  overview(q: { date_from?: string; date_to?: string } = {}): Observable<PagosControl> {
    const p = new URLSearchParams();
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    const qs = p.toString();
    return this.http.get<PagosControl>(`${this.base}/control${qs ? '?' + qs : ''}`);
  }
  conciliacion(q: { date_from?: string; date_to?: string } = {}): Observable<Conciliacion> {
    const p = new URLSearchParams();
    if (q.date_from) p.set('date_from', q.date_from);
    if (q.date_to) p.set('date_to', q.date_to);
    const qs = p.toString();
    return this.http.get<Conciliacion>(`${this.base}/conciliacion${qs ? '?' + qs : ''}`);
  }
}
