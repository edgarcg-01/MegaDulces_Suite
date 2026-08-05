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

@Injectable({ providedIn: 'root' })
export class PagosControlService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/pagos`;
  overview(): Observable<PagosControl> { return this.http.get<PagosControl>(`${this.base}/control`); }
}
