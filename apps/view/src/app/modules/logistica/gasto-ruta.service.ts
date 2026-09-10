import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * RD.4 + RD.5 — gasto de flota y operación (odómetro / $/km) de la Ruta Directa.
 * Servicio propio y chico en vez de sumarlo a `logistica.service.ts` (1,500 líneas):
 * la superficie es acotada y así el diff se lee.
 */

export interface ExpenseType {
  code: number;
  nombre: string;
  lleva_litros: boolean;
  notes: string | null;
}

export interface RouteExpense {
  id: string;
  route_code: string;
  expense_date: string;
  expense_type: number;
  tipo_nombre: string | null;
  lleva_litros: boolean | null;
  folio: string | null;
  supplier: string | null;
  description: string | null;
  liters: number | null;
  total: number;
  is_remote: boolean;
  period_no: number | null;
  source: string;
  notes: string | null;
}

export interface ExpenseList {
  rows: RouteExpense[];
  total_filas: number;
  total_monto: number;
  total_litros: number;
  /** Cuántas filas siguen sin tipo. Va en pantalla: el resumen por tipo está incompleto mientras no sea 0. */
  sin_clasificar: number;
  limit: number;
  offset: number;
}

export interface ExpenseSummaryRow {
  route_code: string;
  expense_type: number;
  tipo_nombre: string | null;
  n: number;
  total: number;
  litros: number;
  costo_por_litro: number | null;
}

export interface ExpenseSummary {
  from: string; to: string;
  rows: ExpenseSummaryRow[];
  total: number;
  litros: number;
  rutas: number;
}

export type KmStatus = 'ok' | 'incompleto' | 'retroceso' | 'salto_implausible' | 'sin_movimiento' | 'sin_lectura';

export interface OperationPeriod {
  route_code: string;
  anio: number;
  period_no: number;
  km_inicial: number | null;
  km_final: number | null;
  km_recorridos: number | null;
  km_status: KmStatus;
  litros: number | null;
  gasto_combustible: number | null;
  gasto_total: number | null;
  docs: number | null;
  costo_por_litro: number | null;
  km_por_litro: number | null;
  costo_fijo_por_km: number | null;
  costo_fijo_anual: number | null;
  km_base_anual: number | null;
  costo_operacion: number | null;
  costo_por_km: number | null;
  costo_status: string;
}

export interface OperationPayload {
  anio: number;
  rows: OperationPeriod[];
  total_filas: number;
  con_km_utilizable: number;
  sin_km_utilizable: number;
  km_status: Record<string, number>;
  sin_ficha_de_costo: number;
}

export interface CostSheet {
  route_code: string;
  costo_fijo_anual: number | null;
  km_base_anual: number | null;
  costo_fijo_por_km: number | null;
}

export interface OdometerDto {
  route_code: string;
  anio: number;
  period_no: number;
  km_inicial: number | null;
  km_final: number | null;
  notes?: string | null;
}

@Injectable({ providedIn: 'root' })
export class GastoRutaService {
  private readonly http = inject(HttpClient);
  private readonly gasto = `${environment.apiUrl}/logistics/route-expenses`;
  private readonly oper = `${environment.apiUrl}/logistics/route-operation`;

  private params(q: Record<string, string | number | boolean | undefined | null>): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    }
    return p;
  }

  // ── RD.4 gasto ──────────────────────────────────────────────────────────
  types(): Observable<ExpenseType[]> {
    return this.http.get<ExpenseType[]>(`${this.gasto}/types`);
  }

  list(q: {
    from?: string; to?: string; route_code?: string;
    expense_type?: number; sin_clasificar?: boolean; limit?: number; offset?: number;
  } = {}): Observable<ExpenseList> {
    return this.http.get<ExpenseList>(this.gasto, { params: this.params(q) });
  }

  summary(from: string, to: string): Observable<ExpenseSummary> {
    return this.http.get<ExpenseSummary>(`${this.gasto}/summary`, { params: this.params({ from, to }) });
  }

  updateExpense(id: string, patch: Partial<RouteExpense>): Observable<RouteExpense> {
    return this.http.patch<RouteExpense>(`${this.gasto}/${id}`, patch);
  }

  createExpense(dto: Partial<RouteExpense>): Observable<RouteExpense> {
    return this.http.post<RouteExpense>(this.gasto, dto);
  }

  // ── RD.5 operación ──────────────────────────────────────────────────────
  periods(q: { anio?: number; route_code?: string; solo_problemas?: boolean } = {}): Observable<OperationPayload> {
    return this.http.get<OperationPayload>(`${this.oper}/periods`, { params: this.params(q) });
  }

  costSheets(): Observable<CostSheet[]> {
    return this.http.get<CostSheet[]>(`${this.oper}/cost-sheets`);
  }

  saveOdometer(dto: OdometerDto): Observable<unknown> {
    return this.http.post(`${this.oper}/odometer`, dto);
  }
}
