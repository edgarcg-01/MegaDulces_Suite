import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** CB.2/CB.3 — cliente del tablero de conciliación bancaria (finance.bank_*). */

export interface BankAccount {
  id: string; bank: string; account_label: string; alias: string | null;
  kind: 'bank' | 'cash' | 'factoraje'; kepler_link: string | null; active: boolean;
}

export interface MovementCategory {
  id: string; code: string; name: string; flow: 'in' | 'out' | 'both' | 'none';
  kepler_account: string | null; group_key: string; kepler_note: string | null;
  sort_order: number; active: boolean;
}

export interface BankStatement {
  id: string; bank_account_id: string; bank: string; account_label: string; alias: string | null;
  kind: string; opening_balance: number; closing_balance: number;
  total_in: number; total_out: number; source_file: string | null; status: string; imported_at: string | null;
}

export interface BankMovement {
  id: string; movement_date: string; bank: string; account_label: string; bank_account_id: string;
  category_id: string | null; category_code: string | null; category_name: string | null;
  group_key: string | null; kepler_account: string | null;
  raw_type: string | null; raw_code: string | null; sucursal: string | null; concept: string | null;
  amount_in: number; amount_out: number; running_balance: number | null; recon_status: string;
}

export interface MovementsPage { total: number; rows: BankMovement[]; }

export interface ConcentradoGroup { deposits: number; withdrawals: number; movs: number; }
export interface ConcentradoAccount {
  account_id: string; bank: string; account_label: string; alias: string | null; kind: string;
  groups: Record<string, ConcentradoGroup>; deposits: number; withdrawals: number; movs: number;
}
export interface Concentrado {
  period: string; accounts: ConcentradoAccount[];
  groupTotals: Record<string, ConcentradoGroup>; grand: ConcentradoGroup;
}

export interface ReconCash {
  bank_in: number; kepler_102_cargos: number; delta_in: number;
  bank_out: number; kepler_102_abonos: number; delta_out: number;
}
export interface ReconAccount { kepler_account: string; concept: string; bank: number; book: number; delta: number; }
export interface Reconciliation {
  period: string; cash: ReconCash; accounts: ReconAccount[]; cobranza: number; sin_clasificar: number;
}

export interface MovementsQuery {
  period?: string; account_id?: string; category_id?: string; group_key?: string;
  uncategorized?: boolean; recon_status?: string; search?: string; limit?: number; offset?: number;
}

@Injectable({ providedIn: 'root' })
export class BankService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/bank`;

  accounts(): Observable<BankAccount[]> { return this.http.get<BankAccount[]>(`${this.base}/accounts`); }
  categories(): Observable<MovementCategory[]> { return this.http.get<MovementCategory[]>(`${this.base}/categories`); }
  periods(): Observable<string[]> { return this.http.get<string[]>(`${this.base}/periods`); }
  statements(period: string): Observable<BankStatement[]> { return this.http.get<BankStatement[]>(`${this.base}/statements?period=${encodeURIComponent(period)}`); }
  concentrado(period: string): Observable<Concentrado> { return this.http.get<Concentrado>(`${this.base}/concentrado?period=${encodeURIComponent(period)}`); }
  reconciliation(period: string): Observable<Reconciliation> { return this.http.get<Reconciliation>(`${this.base}/reconciliation?period=${encodeURIComponent(period)}`); }

  movements(q: MovementsQuery): Observable<MovementsPage> {
    const p = new URLSearchParams();
    if (q.period) p.set('period', q.period);
    if (q.account_id) p.set('account_id', q.account_id);
    if (q.category_id) p.set('category_id', q.category_id);
    if (q.group_key) p.set('group_key', q.group_key);
    if (q.uncategorized) p.set('uncategorized', 'true');
    if (q.recon_status) p.set('recon_status', q.recon_status);
    if (q.search) p.set('search', q.search);
    if (q.limit != null) p.set('limit', String(q.limit));
    if (q.offset != null) p.set('offset', String(q.offset));
    return this.http.get<MovementsPage>(`${this.base}/movements?${p.toString()}`);
  }

  reclassify(id: string, categoryId: string | null): Observable<unknown> {
    return this.http.patch(`${this.base}/movements/${id}/category`, { category_id: categoryId });
  }

  importWorkbook(fileBase64: string, period: string, sourceFile: string): Observable<ImportResult> {
    return this.http.post<ImportResult>(`${this.base}/import`, { file_base64: fileBase64, period, source_file: sourceFile });
  }
}

export interface ImportResult {
  period: string;
  accounts: { sheet: string; movs?: number; deposits?: number; withdrawals?: number; sin_clasificar?: number; note?: string }[];
  total: number; deposits: number; withdrawals: number; sin_clasificar: number;
}
