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

export interface MatchResult {
  period: string; bank_movements: number; matched: number; second_pass?: number; unmatched_bank: number;
  kepler_postings: number; unmatched_kepler: number; matched_amount: number; bank_amount: number; match_rate: number;
}

/** CB.8 — cuadre de saldos por cuenta. */
export interface BalanceRow {
  statement_id: string; bank: string; account_label: string; kind: string;
  opening: number; total_in: number; total_out: number; computed_closing: number; closing: number; delta: number;
  cuadra: boolean; sin_saldo: boolean;
}
export interface Balances {
  period: string; accounts: BalanceRow[];
  traspasos: { entra: number; sale: number; delta: number };
  totals: { opening: number; total_in: number; total_out: number; closing: number; descuadre: number };
  cuentas_descuadradas: number; cuentas_sin_saldo: number;
}

export interface Differences {
  period: string;
  bank_unmatched: { id: string; movement_date: string; amount_out: number; concept: string | null; raw_code: string | null; category_name: string | null; group_key: string | null }[];
  kepler_unmatched: { doc_tipo: string; folio: string; fecha: string | null; importe: number; contraparte: string | null }[];
}

/** CB.6 — regla de clasificación editable (finance.bank_classify_rules). */
export interface ClassifyRule {
  id: string; priority: number;
  match_type: string | null; match_code: string | null; match_concept: string | null;
  category_code: string; category_name: string | null; group_key: string | null;
  note: string | null; active: boolean;
}
export interface ReclassifyResult { scanned: number; changed: number; }
export interface SyncFindingsResult { pushed: number; inserted: number; skipped: number; }

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
  balances(period: string): Observable<Balances> { return this.http.get<Balances>(`${this.base}/balances?period=${encodeURIComponent(period)}`); }

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

  runMatch(period: string): Observable<MatchResult> {
    return this.http.post<MatchResult>(`${this.base}/match`, { period });
  }
  differences(period: string): Observable<Differences> {
    return this.http.get<Differences>(`${this.base}/differences?period=${encodeURIComponent(period)}`);
  }
  syncFindings(period: string): Observable<SyncFindingsResult> {
    return this.http.post<SyncFindingsResult>(`${this.base}/findings/sync`, { period });
  }

  importWorkbook(fileBase64: string, period: string, sourceFile: string): Observable<ImportResult> {
    return this.http.post<ImportResult>(`${this.base}/import`, { file_base64: fileBase64, period, source_file: sourceFile });
  }

  // ── CB.6 Admin ──
  createAccount(body: Partial<BankAccount>): Observable<BankAccount> { return this.http.post<BankAccount>(`${this.base}/accounts`, body); }
  updateAccount(id: string, body: Partial<BankAccount>): Observable<BankAccount> { return this.http.patch<BankAccount>(`${this.base}/accounts/${id}`, body); }
  createCategory(body: Partial<MovementCategory>): Observable<MovementCategory> { return this.http.post<MovementCategory>(`${this.base}/categories`, body); }
  updateCategory(id: string, body: Partial<MovementCategory>): Observable<MovementCategory> { return this.http.patch<MovementCategory>(`${this.base}/categories/${id}`, body); }

  rules(): Observable<ClassifyRule[]> { return this.http.get<ClassifyRule[]>(`${this.base}/rules`); }
  createRule(body: Partial<ClassifyRule>): Observable<ClassifyRule> { return this.http.post<ClassifyRule>(`${this.base}/rules`, body); }
  updateRule(id: string, body: Partial<ClassifyRule>): Observable<ClassifyRule> { return this.http.patch<ClassifyRule>(`${this.base}/rules/${id}`, body); }
  deleteRule(id: string): Observable<unknown> { return this.http.delete(`${this.base}/rules/${id}`); }
  reclassifyAll(period?: string): Observable<ReclassifyResult> { return this.http.post<ReclassifyResult>(`${this.base}/reclassify`, { period }); }
}

export interface ImportResult {
  period: string;
  accounts: { sheet: string; movs?: number; deposits?: number; withdrawals?: number; sin_clasificar?: number; note?: string }[];
  total: number; deposits: number; withdrawals: number; sin_clasificar: number;
}
