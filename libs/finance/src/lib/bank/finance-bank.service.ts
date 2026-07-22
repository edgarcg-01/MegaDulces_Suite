import { Injectable, BadRequestException, Logger, Inject, Optional } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

/**
 * CB.2 — Conciliación bancaria (ADR-033). Servicio de lectura + reclasificación
 * sobre `finance.bank_*`. Reemplaza el workbook Excel: cuentas, catálogo de
 * categorías, estados de cuenta por periodo, movimientos (filtrables) y el
 * tablero CONCENTRADO (pivote cuenta × grupo). NO escribe a Kepler.
 *
 * finance.* tiene RLS forzado → todo va por TenantKnexService.run() (el tenant
 * lo pone el contexto; los WHERE no repiten tenant_id).
 */

const n = (v: any) => Number(v) || 0;
const normKey = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const money = (v: any): number => {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').replace(/[$,\s]/g, '').trim();
  const num = Number(t);
  return Number.isFinite(num) ? num : 0;
};
function cellVal(row: ExcelJS.Row, i?: number): any {
  if (!i) return null;
  const v = row.getCell(i).value as any;
  return v && typeof v === 'object' && v.result !== undefined ? v.result : v;
}
function excelDate(v: any): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/**
 * CB.6 — Motor de clasificación desde DB (finance.bank_classify_rules).
 * Reglas ordenadas por priority; una aplica si TODOS sus matchers no-nulos
 * (regex sobre M/C/concepto) hacen match. La primera que aplica gana.
 * Reemplaza la función classify() hardcodeada (ahora las reglas viven en DB,
 * editables desde la vista Admin). Patrones inválidos se ignoran (best-effort).
 */
export interface ClassifyRuleRow {
  priority: number; match_type: string | null; match_code: string | null;
  match_concept: string | null; category_code: string;
}
interface CompiledRule { reType: RegExp | null; reCode: RegExp | null; reConcept: RegExp | null; category: string; }

function compileRules(rules: ClassifyRuleRow[]): CompiledRule[] {
  const safe = (p: string | null): RegExp | null => {
    if (!p) return null;
    try { return new RegExp(p, 'i'); } catch { return null; }
  };
  return [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({ reType: safe(r.match_type), reCode: safe(r.match_code), reConcept: safe(r.match_concept), category: r.category_code }));
}

function classifyWith(compiled: CompiledRule[], M: any, C: any, concept: any): string {
  const m = normKey(M), c = normKey(C), t = normKey(concept);
  for (const r of compiled) {
    if (r.reType && !r.reType.test(m)) continue;
    if (r.reCode && !r.reCode.test(c)) continue;
    if (r.reConcept && !r.reConcept.test(t)) continue;
    return r.category;
  }
  return 'sin_clasificar';
}

export interface ListMovementsQuery {
  period?: string;
  account_id?: string;
  category_id?: string;
  group_key?: string;
  uncategorized?: string;   // 'true' → solo sin categoría
  recon_status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class FinanceBankService {
  private readonly logger = new Logger(FinanceBankService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly findingsSink?: FinanceFindingsSinkPort,
  ) {}

  /** Cuentas de banco/caja/factoraje. */
  async accounts() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.bank_accounts')
        .select('id', 'bank', 'account_label', 'alias', 'kind', 'kepler_link', 'active')
        .orderBy([{ column: 'kind' }, { column: 'bank' }, { column: 'account_label' }]);
    });
  }

  /** Catálogo de categorías limpias (alineado a Kepler). */
  async categories() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.movement_categories')
        .select('id', 'code', 'name', 'flow', 'kepler_account', 'group_key', 'kepler_note', 'sort_order', 'active')
        .orderBy('sort_order');
    });
  }

  /** Periodos con estados de cuenta cargados (más reciente primero). */
  async periods(): Promise<string[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements').distinct('period').orderBy('period', 'desc');
      return rows.map((r: any) => r.period);
    });
  }

  /** Estados de cuenta de un periodo (por cuenta) con totales. */
  async statements(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements as st')
        .join('finance.bank_accounts as ba', 'ba.id', 'st.bank_account_id')
        .where('st.period', period)
        .select('st.id', 'st.bank_account_id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind',
          'st.opening_balance', 'st.closing_balance', 'st.total_in', 'st.total_out',
          'st.source_file', 'st.status', 'st.imported_at')
        .orderBy([{ column: 'ba.kind' }, { column: 'ba.bank' }, { column: 'ba.account_label' }]);
      return rows.map((r: any) => ({
        ...r,
        opening_balance: n(r.opening_balance), closing_balance: n(r.closing_balance),
        total_in: n(r.total_in), total_out: n(r.total_out),
      }));
    });
  }

  /** Movimientos filtrados (grid). Pagina; devuelve total para el contador. */
  async movements(q: ListMovementsQuery) {
    this.tenantCtx.requireTenantId();
    if (!q.period && !q.account_id) throw new BadRequestException('period o account_id requerido');
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
    const offset = Math.max(0, Number(q.offset) || 0);
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
          .leftJoin('finance.bank_statements as st', 'st.id', 'bm.statement_id');
        if (q.period) b.where('st.period', q.period);
        if (q.account_id) b.where('bm.bank_account_id', q.account_id);
        if (q.category_id) b.where('bm.category_id', q.category_id);
        if (q.group_key) b.where('mc.group_key', q.group_key);
        if (q.uncategorized === 'true') b.whereNull('bm.category_id');
        if (q.recon_status) b.where('bm.recon_status', q.recon_status);
        if (q.search) {
          const s = `%${q.search.trim()}%`;
          b.where((w) => w.whereILike('bm.concept', s).orWhereILike('bm.raw_code', s).orWhereILike('bm.sucursal', s));
        }
        return b;
      };
      const [{ count }] = await base().count({ count: '*' });
      const rows = await base()
        .select('bm.id', 'bm.movement_date', 'ba.bank', 'ba.account_label', 'bm.bank_account_id',
          'bm.category_id', 'mc.code as category_code', 'mc.name as category_name', 'mc.group_key',
          'mc.kepler_account', 'bm.raw_type', 'bm.raw_code', 'bm.sucursal', 'bm.concept',
          'bm.amount_in', 'bm.amount_out', 'bm.running_balance', 'bm.recon_status')
        .orderBy([{ column: 'bm.movement_date' }, { column: 'bm.id' }])
        .limit(limit).offset(offset);
      return {
        total: Number(count),
        rows: rows.map((r: any) => ({
          ...r,
          amount_in: n(r.amount_in), amount_out: n(r.amount_out),
          running_balance: r.running_balance === null ? null : n(r.running_balance),
        })),
      };
    });
  }

  /**
   * Tablero CONCENTRADO: pivote cuenta × grupo (ingreso/compra/gasto/factoraje/
   * financiero/traspaso/devolucion/sin_clasificar) con depósitos/retiros, más
   * fila de totales. Es la vista que reemplaza la hoja CONCENTRADO del Excel.
   */
  async concentrado(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_movements as bm')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period)
        .groupBy('ba.id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind')
        .groupByRaw('COALESCE(mc.group_key, ?)', ['sin_clasificar'])
        .select('ba.id as account_id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind',
          trx.raw(`COALESCE(mc.group_key, 'sin_clasificar') AS group_key`),
          trx.raw('SUM(bm.amount_in)::numeric AS deposits'),
          trx.raw('SUM(bm.amount_out)::numeric AS withdrawals'),
          trx.raw('COUNT(*)::int AS movs'));

      const byAccount = new Map<string, any>();
      const groupTotals: Record<string, { deposits: number; withdrawals: number; movs: number }> = {};
      for (const r of rows as any[]) {
        const acc = byAccount.get(r.account_id) || {
          account_id: r.account_id, bank: r.bank, account_label: r.account_label, alias: r.alias, kind: r.kind,
          groups: {}, deposits: 0, withdrawals: 0, movs: 0,
        };
        const dep = n(r.deposits), wd = n(r.withdrawals), mv = Number(r.movs) || 0;
        acc.groups[r.group_key] = { deposits: dep, withdrawals: wd, movs: mv };
        acc.deposits += dep; acc.withdrawals += wd; acc.movs += mv;
        byAccount.set(r.account_id, acc);
        const g = groupTotals[r.group_key] || { deposits: 0, withdrawals: 0, movs: 0 };
        g.deposits += dep; g.withdrawals += wd; g.movs += mv;
        groupTotals[r.group_key] = g;
      }
      const accounts = [...byAccount.values()].sort((a, b) =>
        a.kind.localeCompare(b.kind) || a.bank.localeCompare(b.bank) || a.account_label.localeCompare(b.account_label));
      const grand = {
        deposits: accounts.reduce((s, a) => s + a.deposits, 0),
        withdrawals: accounts.reduce((s, a) => s + a.withdrawals, 0),
        movs: accounts.reduce((s, a) => s + a.movs, 0),
      };
      return { period, accounts, groupTotals, grand };
    });
  }

  /** Reclasifica un movimiento (asigna categoría). null/'' → deja sin clasificar. */
  async reclassify(id: string, categoryId: string | null, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let catId: string | null = null;
      if (categoryId) {
        const cat = await trx('finance.movement_categories').where({ id: categoryId }).first('id');
        if (!cat) throw new BadRequestException('categoría inválida');
        catId = cat.id;
      }
      const [row] = await trx('finance.bank_movements').where({ id })
        .update({ category_id: catId, classified_by: 'manual', updated_at: trx.fn.now() })
        .returning(['id', 'category_id']);
      if (!row) throw new BadRequestException('movimiento no encontrado');
      this.logger.log(`movimiento ${id} reclasificado → ${catId || 'sin_clasificar'} por ${actor || '?'}`);
      return row;
    });
  }

  // ── CB.6 — Admin: catálogo (cuentas + categorías) y reglas de clasificación ──

  /** Alta de cuenta de banco/caja/factoraje. */
  async createAccount(body: any, actor?: string) {
    this.tenantCtx.requireTenantId();
    const bank = String(body?.bank || '').trim();
    const account_label = String(body?.account_label || '').trim();
    if (!bank || !account_label) throw new BadRequestException('bank y account_label requeridos');
    const kind = ['bank', 'cash', 'factoraje'].includes(body?.kind) ? body.kind : 'bank';
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_accounts')
        .insert({ bank, account_label, alias: body?.alias?.trim() || null, kind, kepler_link: body?.kepler_link?.trim() || null })
        .onConflict(['tenant_id', 'bank', 'account_label']).merge(['alias', 'kind', 'kepler_link', 'updated_at'])
        .returning('*');
      this.logger.log(`cuenta ${bank} ${account_label} guardada por ${actor || '?'}`);
      return row;
    });
  }

  /** Edita una cuenta (alias/kepler_link/kind/active). */
  async updateAccount(id: string, body: any) {
    this.tenantCtx.requireTenantId();
    const patch: any = { updated_at: undefined };
    if (body?.alias !== undefined) patch.alias = body.alias?.trim() || null;
    if (body?.kepler_link !== undefined) patch.kepler_link = body.kepler_link?.trim() || null;
    if (body?.kind !== undefined && ['bank', 'cash', 'factoraje'].includes(body.kind)) patch.kind = body.kind;
    if (body?.active !== undefined) patch.active = !!body.active;
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_accounts').where({ id })
        .update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new BadRequestException('cuenta no encontrada');
      return row;
    });
  }

  /** Alta de categoría del catálogo limpio. */
  async createCategory(body: any, actor?: string) {
    this.tenantCtx.requireTenantId();
    const code = String(body?.code || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const name = String(body?.name || '').trim();
    const group_key = String(body?.group_key || '').trim();
    const flow = ['in', 'out', 'both', 'none'].includes(body?.flow) ? body.flow : 'out';
    if (!code || !name || !group_key) throw new BadRequestException('code, name y group_key requeridos');
    return this.tk.run(async (trx) => {
      const maxSort = Number((await trx('finance.movement_categories').max('sort_order as m').first())?.m || 0);
      const [row] = await trx('finance.movement_categories')
        .insert({ code, name, flow, group_key, kepler_account: body?.kepler_account?.trim() || null,
          kepler_note: body?.kepler_note?.trim() || null, sort_order: maxSort + 10 })
        .onConflict(['tenant_id', 'code'])
        .merge(['name', 'flow', 'group_key', 'kepler_account', 'kepler_note', 'updated_at'])
        .returning('*');
      this.logger.log(`categoría ${code} guardada por ${actor || '?'}`);
      return row;
    });
  }

  /** Edita una categoría (name/kepler_account/group_key/flow/active). */
  async updateCategory(id: string, body: any) {
    this.tenantCtx.requireTenantId();
    const patch: any = {};
    if (body?.name !== undefined) patch.name = String(body.name).trim();
    if (body?.kepler_account !== undefined) patch.kepler_account = body.kepler_account?.trim() || null;
    if (body?.kepler_note !== undefined) patch.kepler_note = body.kepler_note?.trim() || null;
    if (body?.group_key !== undefined) patch.group_key = String(body.group_key).trim();
    if (body?.flow !== undefined && ['in', 'out', 'both', 'none'].includes(body.flow)) patch.flow = body.flow;
    if (body?.active !== undefined) patch.active = !!body.active;
    if (!Object.keys(patch).length) throw new BadRequestException('nada que actualizar');
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.movement_categories').where({ id })
        .update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new BadRequestException('categoría no encontrada');
      return row;
    });
  }

  /** Lista las reglas de clasificación (por prioridad). */
  async rules() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.bank_classify_rules as r')
        .leftJoin('finance.movement_categories as mc', function () {
          this.on('mc.code', 'r.category_code');
        })
        .select('r.id', 'r.priority', 'r.match_type', 'r.match_code', 'r.match_concept',
          'r.category_code', 'mc.name as category_name', 'mc.group_key', 'r.note', 'r.active')
        .orderBy('r.priority');
    });
  }

  /** Valida que los patrones sean regex legales y la categoría exista. */
  private async validateRule(trx: any, body: any) {
    for (const key of ['match_type', 'match_code', 'match_concept']) {
      const p = body?.[key];
      if (p) { try { new RegExp(p, 'i'); } catch { throw new BadRequestException(`regex inválida en ${key}`); } }
    }
    const category_code = String(body?.category_code || '').trim();
    if (!category_code) throw new BadRequestException('category_code requerido');
    const cat = await trx('finance.movement_categories').where({ code: category_code }).first('code');
    if (!cat) throw new BadRequestException(`categoría "${category_code}" no existe`);
    if (!body?.match_type && !body?.match_code && !body?.match_concept)
      throw new BadRequestException('al menos un matcher (tipo/código/concepto) requerido');
    return category_code;
  }

  /** Alta de regla de clasificación. */
  async createRule(body: any, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const category_code = await this.validateRule(trx, body);
      let priority = Number(body?.priority);
      if (!Number.isFinite(priority)) priority = Number((await trx('finance.bank_classify_rules').max('priority as m').first())?.m || 0) + 10;
      const [row] = await trx('finance.bank_classify_rules')
        .insert({ priority, match_type: body?.match_type?.trim() || null, match_code: body?.match_code?.trim() || null,
          match_concept: body?.match_concept?.trim() || null, category_code, note: body?.note?.trim() || null })
        .onConflict(['tenant_id', 'priority'])
        .merge(['match_type', 'match_code', 'match_concept', 'category_code', 'note', 'active', 'updated_at'])
        .returning('*');
      this.logger.log(`regla p${priority} → ${category_code} guardada por ${actor || '?'}`);
      return row;
    });
  }

  /** Edita una regla. */
  async updateRule(id: string, body: any) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const patch: any = {};
      if (body?.category_code !== undefined || body?.match_type !== undefined || body?.match_code !== undefined || body?.match_concept !== undefined) {
        const current = await trx('finance.bank_classify_rules').where({ id }).first();
        if (!current) throw new BadRequestException('regla no encontrada');
        const merged = { ...current, ...body };
        patch.category_code = await this.validateRule(trx, merged);
        patch.match_type = merged.match_type?.trim() || null;
        patch.match_code = merged.match_code?.trim() || null;
        patch.match_concept = merged.match_concept?.trim() || null;
      }
      if (body?.priority !== undefined && Number.isFinite(Number(body.priority))) patch.priority = Number(body.priority);
      if (body?.note !== undefined) patch.note = body.note?.trim() || null;
      if (body?.active !== undefined) patch.active = !!body.active;
      if (!Object.keys(patch).length) throw new BadRequestException('nada que actualizar');
      const [row] = await trx('finance.bank_classify_rules').where({ id })
        .update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new BadRequestException('regla no encontrada');
      return row;
    });
  }

  /** Elimina una regla. */
  async deleteRule(id: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const n = await trx('finance.bank_classify_rules').where({ id }).del();
      if (!n) throw new BadRequestException('regla no encontrada');
      return { deleted: n };
    });
  }

  /**
   * CB.6 — Re-aplica las reglas a los movimientos ya importados (tras editarlas).
   * Respeta el override manual: NO toca filas con classified_by='manual'. Opcional
   * `period` para acotar. Devuelve cuántas cambiaron de categoría.
   */
  async reclassifyAll(period?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const compiled = compileRules(
        await trx('finance.bank_classify_rules').where({ active: true })
          .select('priority', 'match_type', 'match_code', 'match_concept', 'category_code'));
      const catMap = new Map<string, string>(
        (await trx('finance.movement_categories').select('id', 'code')).map((r: any) => [r.code, r.id]));

      const q = trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('bm.classified_by', 'rule');
      if (period) q.where('st.period', period);
      const movs = await q.select('bm.id', 'bm.raw_type', 'bm.raw_code', 'bm.concept', 'bm.category_id');

      let changed = 0; const updates: Record<string, string[]> = {};
      for (const m of movs as any[]) {
        const code = classifyWith(compiled, m.raw_type, m.raw_code, m.concept);
        const newCat = code === 'sin_clasificar' ? null : (catMap.get(code) || null);
        if ((newCat || null) !== (m.category_id || null)) {
          const key = newCat || '__null__';
          (updates[key] ||= []).push(m.id);
          changed++;
        }
      }
      for (const [key, ids] of Object.entries(updates)) {
        const catId = key === '__null__' ? null : key;
        for (let i = 0; i < ids.length; i += 500)
          await trx('finance.bank_movements').whereIn('id', ids.slice(i, i + 500))
            .update({ category_id: catId, updated_at: trx.fn.now() });
      }
      this.logger.log(`reclassifyAll ${period || 'todos'}: ${changed}/${movs.length} recategorizados`);
      return { scanned: movs.length, changed };
    });
  }

  /**
   * CB.4.2 — Diferencias de conciliación: lo que NO casó, rankeado por monto (accionable).
   * Requiere haber corrido runMatch (usa recon_status + bank_recon_matches).
   */
  async differences(period?: string, limit = 50) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      // Retiros del banco sin casar (con su categoría).
      const bank = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('bm.amount_out', '>', 0).where('bm.recon_status', 'unmatched')
        .select('bm.id', 'bm.movement_date', 'bm.amount_out', 'bm.concept', 'bm.raw_code',
          'mc.name as category_name', 'mc.group_key')
        .orderBy('bm.amount_out', 'desc').limit(limit);

      // Pagos del 102 en Kepler sin casar (no referenciados por ningún match).
      const kepler = await trx('analytics.bank_postings as p')
        .where({ 'p.tenant_id': tenantId, 'p.anio_mes': period, 'p.cargo_abono': 'A' })
        .whereNotExists(function () {
          this.select(trx.raw('1')).from('finance.bank_recon_matches as m')
            .whereRaw('m.kepler_doc_tipo = p.doc_tipo AND m.kepler_doc_folio = p.folio');
        })
        .select('p.doc_tipo', 'p.folio', 'p.fecha', 'p.importe', 'p.contraparte')
        .orderBy('p.importe', 'desc').limit(limit);

      return {
        period,
        bank_unmatched: bank.map((r: any) => ({ ...r, amount_out: n(r.amount_out) })),
        kepler_unmatched: kepler.map((r: any) => ({ ...r, importe: n(r.importe) })),
      };
    });
  }

  /**
   * CB.8 — Cuadre de saldos: el chequeo de integridad más fuerte del estado de
   * cuenta. Por cuenta: saldo_inicial + depósitos − retiros == saldo_final.
   * Δ ≠ 0 ⇒ falta capturar un movimiento o el saldo está mal tecleado. Más el
   * check TI=TE (traspasos internos: lo que sale de una cuenta entra en otra →
   * depósitos de traspaso ≈ retiros de traspaso en la red).
   */
  async balances(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements as st')
        .join('finance.bank_accounts as ba', 'ba.id', 'st.bank_account_id')
        .where('st.period', period)
        .select('st.id', 'ba.bank', 'ba.account_label', 'ba.kind',
          'st.opening_balance', 'st.closing_balance', 'st.total_in', 'st.total_out')
        .orderBy([{ column: 'ba.kind' }, { column: 'ba.bank' }, { column: 'ba.account_label' }]);

      const accounts = (rows as any[]).map((r) => {
        const opening = n(r.opening_balance), closing = n(r.closing_balance);
        const computed = Math.round((opening + n(r.total_in) - n(r.total_out)) * 100) / 100;
        const delta = Math.round((computed - closing) * 100) / 100;
        return {
          statement_id: r.id, bank: r.bank, account_label: r.account_label, kind: r.kind,
          opening, total_in: n(r.total_in), total_out: n(r.total_out),
          computed_closing: computed, closing, delta,
          cuadra: Math.abs(delta) < 1 && (opening !== 0 || closing !== 0),
          sin_saldo: opening === 0 && closing === 0,
        };
      });

      // TI=TE: traspasos internos deben netear en la red (depósitos ≈ retiros).
      const tr = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('mc.group_key', 'traspaso')
        .select(trx.raw('SUM(bm.amount_in)::numeric AS entra'), trx.raw('SUM(bm.amount_out)::numeric AS sale'))
        .first();
      const traspasos = { entra: n((tr as any)?.entra), sale: n((tr as any)?.sale), delta: Math.round((n((tr as any)?.entra) - n((tr as any)?.sale)) * 100) / 100 };

      const totals = accounts.reduce((t, a) => ({
        opening: t.opening + a.opening, total_in: t.total_in + a.total_in, total_out: t.total_out + a.total_out,
        closing: t.closing + a.closing, descuadre: t.descuadre + (a.cuadra || a.sin_saldo ? 0 : Math.abs(a.delta)),
      }), { opening: 0, total_in: 0, total_out: 0, closing: 0, descuadre: 0 });

      return { period, accounts, traspasos, totals,
        cuentas_descuadradas: accounts.filter((a) => !a.cuadra && !a.sin_saldo).length,
        cuentas_sin_saldo: accounts.filter((a) => a.sin_saldo).length };
    });
  }

  /**
   * CB.7 — Empuja las diferencias de conciliación a la bandeja unificada de Maat
   * (finance.findings) vía FINANCE_FINDINGS_SINK_PORT (@Optional, best-effort).
   * Determinista, sin LLM. Tres reglas:
   *  - banco_retiro_sin_kepler (riesgo): retiro material sin pago 102 en Kepler.
   *  - banco_sin_clasificar (error_captura): monto sin categoría en el periodo.
   *  - banco_pnl_descuadre (riesgo): categoría de gasto vs mayor Kepler fuera de tol.
   * Requiere haber corrido runMatch (usa recon_status). El triage/feedback vive en
   * /finanzas/hallazgos (dedup estable → re-sync actualiza, no duplica).
   */
  async syncFindings(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    if (!this.findingsSink) { this.logger.debug('sink de hallazgos no ligado — syncFindings no-op.'); return { pushed: 0, inserted: 0, skipped: 0 }; }

    const RETIRO_MIN = 50000;   // solo retiros materiales sin casar → hallazgo (evita ruido de comisiones)
    const PNL_MIN = 10000;      // descuadre P&L mínimo para reportar
    const money = (v: number) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

    // Retiros del banco sin casar, materiales (con su cuenta/categoría).
    const unmatched = await this.tk.run(async (trx) =>
      trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('bm.recon_status', 'unmatched').where('bm.amount_out', '>=', RETIRO_MIN)
        .whereRaw(`COALESCE(mc.group_key,'sin_clasificar') NOT IN ('traspaso','ingreso','devolucion')`)
        .select('bm.id', 'bm.movement_date', 'bm.amount_out', 'bm.concept',
          'mc.name as category_name', 'ba.bank', 'ba.account_label')
        .orderBy('bm.amount_out', 'desc'));

    const rc = await this.reconciliation(period);

    const rules: FinanceRuleInput[] = [
      { rule_key: 'banco_retiro_sin_kepler', nombre: 'Retiro bancario sin pago en Kepler', clase: 'riesgo',
        descripcion: 'Retiro material del banco que no casó con ningún pago del 102 en Kepler (monto+fecha). Puede ser timing, pago no contabilizado o salida no soportada.' },
      { rule_key: 'banco_sin_clasificar', nombre: 'Movimientos bancarios sin clasificar', clase: 'error_captura',
        descripcion: 'Monto del estado de cuenta sin categoría asignada en el periodo — pendiente de resolver en la vista de Movimientos.' },
      { rule_key: 'banco_pnl_descuadre', nombre: 'Descuadre banco vs mayor Kepler', clase: 'riesgo',
        descripcion: 'El gasto pagado por banco de una categoría difiere del cargo del mayor contable en Kepler más allá de la tolerancia.' },
      { rule_key: 'banco_saldo_no_cuadra', nombre: 'Saldo de cuenta no cuadra', clase: 'error_captura',
        descripcion: 'saldo_inicial + depósitos − retiros ≠ saldo_final del estado de cuenta: falta capturar un movimiento o el saldo está mal tecleado.' },
    ];

    const findings: FinanceFindingInput[] = [];

    for (const m of unmatched as any[]) {
      const importe = n(m.amount_out);
      findings.push({
        rule_key: 'banco_retiro_sin_kepler', clase: 'riesgo',
        severity: importe >= 500000 ? 'critical' : 'warn', score: importe >= 500000 ? 0.9 : 0.65,
        titulo: `Retiro sin casar ${money(importe)} — ${m.concept || m.bank}`,
        resumen: `Retiro de ${money(importe)} el ${m.movement_date} en ${m.bank} ${m.account_label} (${m.category_name || 'sin clasificar'}) no casó con ningún pago del 102 en Kepler.`,
        entity: { bank_movement_id: m.id, bank: m.bank, account_label: m.account_label, categoria: m.category_name },
        periodo: period, importe,
        evidencia: { movement_date: m.movement_date, concept: m.concept, fuente: 'finance.bank_movements' },
        dedup_key: `banco_retiro_sin_kepler|${m.id}`,
      });
    }

    if (rc.sin_clasificar > 0) {
      findings.push({
        rule_key: 'banco_sin_clasificar', clase: 'error_captura', severity: 'warn', score: 0.5,
        titulo: `${money(rc.sin_clasificar)} sin clasificar en ${period}`,
        resumen: `Hay ${money(rc.sin_clasificar)} en movimientos bancarios sin categoría en ${period}. Resuélvelos en Movimientos para afinar el cuadre.`,
        entity: { periodo: period }, periodo: period, importe: rc.sin_clasificar,
        evidencia: { fuente: 'finance.bank_movements', regla: 'sin category_id' },
        dedup_key: `banco_sin_clasificar|${period}`,
      });
    }

    for (const a of rc.accounts as any[]) {
      if (Math.abs(n(a.delta)) < PNL_MIN) continue;
      findings.push({
        rule_key: 'banco_pnl_descuadre', clase: 'riesgo', severity: Math.abs(a.delta) >= 100000 ? 'critical' : 'warn',
        score: 0.6,
        titulo: `Descuadre ${a.kepler_account} — Δ ${money(a.delta)}`,
        resumen: `${a.concept}: banco pagó ${money(a.bank)} vs ${money(a.book)} del mayor ${a.kepler_account} en Kepler (Δ ${money(a.delta)}).`,
        entity: { kepler_account: a.kepler_account, concepto: a.concept }, periodo: period, importe: Math.abs(n(a.delta)),
        evidencia: { bank: a.bank, book: a.book, fuente: 'analytics.ledger_monthly' },
        dedup_key: `banco_pnl_descuadre|${period}|${a.kepler_account}`,
      });
    }

    // Cuadre de saldos (CB.8): una cuenta cuyo saldo no cierra = movimiento faltante o mal tecleado.
    const bal = await this.balances(period);
    for (const a of bal.accounts as any[]) {
      if (a.cuadra || a.sin_saldo) continue;
      findings.push({
        rule_key: 'banco_saldo_no_cuadra', clase: 'error_captura', severity: Math.abs(a.delta) >= 100000 ? 'critical' : 'warn', score: 0.7,
        titulo: `Saldo no cuadra ${a.bank} ${a.account_label} — Δ ${money(a.delta)}`,
        resumen: `${a.bank} ${a.account_label}: inicial ${money(a.opening)} + depósitos ${money(a.total_in)} − retiros ${money(a.total_out)} = ${money(a.computed_closing)}, pero el saldo final es ${money(a.closing)} (Δ ${money(a.delta)}). Falta un movimiento o el saldo está mal capturado.`,
        entity: { bank: a.bank, account_label: a.account_label, statement_id: a.statement_id }, periodo: period, importe: Math.abs(n(a.delta)),
        evidencia: { opening: a.opening, total_in: a.total_in, total_out: a.total_out, computed_closing: a.computed_closing, closing: a.closing, fuente: 'finance.bank_statements' },
        dedup_key: `banco_saldo_no_cuadra|${period}|${a.statement_id}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const res = await this.findingsSink.pushFindings(tenantId, findings, rules);
    this.logger.log(`syncFindings ${period}: ${findings.length} → Maat (${res.inserted} nuevos, ${res.skipped} omitidos).`);
    return { pushed: findings.length, ...res };
  }

  /**
   * CB.4.1 — Matching por-transacción: retiros del banco (pagos) ↔ abonos del 102
   * de Kepler (`analytics.bank_postings`), por monto exacto + fecha ±7d (greedy,
   * el candidato de fecha más cercana). Escribe finance.bank_recon_matches y marca
   * bank_movements.recon_status. Solo lado pago (los depósitos/cobranza quedan a
   * control-total en CB.4: Kepler los agrega por plaza, no casan 1:1).
   */
  async runMatch(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const cents = (x: number) => Math.round((Number(x) || 0) * 100);
    const days = (a: any, b: any) => Math.abs(Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000));

    const result = await this.tk.run(async (trx) => {
      // Lado banco: retiros del periodo (excluye traspasos internos y sin importe).
      const bankMovs = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('bm.amount_out', '>', 0)
        .whereRaw(`COALESCE(mc.group_key,'sin_clasificar') <> 'traspaso'`)
        .select('bm.id', 'bm.movement_date', 'bm.amount_out', 'bm.concept')
        .orderBy('bm.movement_date');

      // Lado Kepler: abonos del 102 del periodo (pagos que salen).
      const posts = (await trx('analytics.bank_postings')
        .where({ tenant_id: tenantId, anio_mes: period, cargo_abono: 'A' })
        .select('doc_tipo', 'folio', 'fecha', 'importe', 'contraparte'))
        .map((p: any) => ({ ...p, importe: n(p.importe), used: false }));

      // índice por monto en centavos
      const byAmt = new Map<number, any[]>();
      for (const p of posts) { const k = cents(p.importe); (byAmt.get(k) || byAmt.set(k, []).get(k))!.push(p); }

      const matches: any[] = []; const matchedIds: string[] = [];
      const matchedSet = new Set<string>();
      // 1er pase: monto exacto + fecha ±7d (greedy por fecha más cercana).
      for (const mv of bankMovs) {
        const cands = (byAmt.get(cents(n(mv.amount_out))) || []).filter((p) => !p.used);
        if (!cands.length) continue;
        let best: any = null, bestD = 8;
        for (const p of cands) { const d = p.fecha ? days(mv.movement_date, p.fecha) : 99; if (d < bestD) { best = p; bestD = d; } }
        if (!best) continue;
        best.used = true; matchedIds.push(mv.id); matchedSet.add(mv.id);
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: best.doc_tipo,
          kepler_doc_folio: best.folio, kepler_cuenta: '102', kepler_amount: best.importe,
          match_type: 'inferred', match_confidence: bestD === 0 ? 0.95 : 0.75, matched_by: 'motor' });
      }
      // 2º pase (CB.8): retiros materiales (≥$10k) aún sin casar, por monto exacto
      // SIN tope de fecha (elige el post de fecha más cercana). Confianza menor.
      // Rescata pagos grandes con desfase de días (p.ej. el $1.03M a la Rosa) sin
      // ensuciar comisiones/nómina chicas (que Kepler agrupa) por el umbral.
      const SECOND_PASS_MIN = 10000;
      let secondPass = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || n(mv.amount_out) < SECOND_PASS_MIN) continue;
        const cands = (byAmt.get(cents(n(mv.amount_out))) || []).filter((p) => !p.used);
        if (!cands.length) continue;
        let best: any = null, bestD = Infinity;
        for (const p of cands) { const d = p.fecha ? days(mv.movement_date, p.fecha) : 999; if (d < bestD) { best = p; bestD = d; } }
        if (!best) continue;
        best.used = true; matchedIds.push(mv.id); matchedSet.add(mv.id); secondPass++;
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: best.doc_tipo,
          kepler_doc_folio: best.folio, kepler_cuenta: '102', kepler_amount: best.importe,
          match_type: 'inferred', match_confidence: 0.5, matched_by: 'motor-2p' });
      }

      // Persistir: limpiar matches previos del periodo + reinsertar; marcar recon_status.
      const periodMovIds = bankMovs.map((m: any) => m.id);
      if (periodMovIds.length) {
        await trx('finance.bank_recon_matches').whereIn('bank_movement_id', periodMovIds).del();
        for (let i = 0; i < matches.length; i += 500) await trx('finance.bank_recon_matches').insert(matches.slice(i, i + 500));
        await trx('finance.bank_movements').whereIn('id', periodMovIds).update({ recon_status: 'unmatched', updated_at: trx.fn.now() });
        for (let i = 0; i < matchedIds.length; i += 500) {
          await trx('finance.bank_movements').whereIn('id', matchedIds.slice(i, i + 500)).update({ recon_status: 'matched', updated_at: trx.fn.now() });
        }
      }

      const matchedAmt = matches.reduce((s, m) => s + n(m.kepler_amount), 0);
      const bankTotal = bankMovs.reduce((s: number, m: any) => s + n(m.amount_out), 0);
      this.logger.log(`match ${period}: ${matches.length}/${bankMovs.length} retiros casados (${secondPass} en 2º pase)`);
      return {
        period, bank_movements: bankMovs.length, matched: matches.length, second_pass: secondPass,
        unmatched_bank: bankMovs.length - matches.length,
        kepler_postings: posts.length, unmatched_kepler: posts.filter((p) => !p.used).length,
        matched_amount: matchedAmt, bank_amount: bankTotal,
        match_rate: bankMovs.length ? Math.round((matches.length / bankMovs.length) * 100) : 0,
      };
    });

    // CB.7 — tras casar, refresca los hallazgos de conciliación (best-effort).
    try { await this.syncFindings(period); } catch (e: any) { this.logger.warn(`syncFindings tras match falló: ${e?.message || e}`); }
    return result;
  }

  /**
   * CB.4 — Conciliación banco ↔ Kepler (control-total). El estado de cuenta ES el
   * movimiento del 102 (caja/bancos) de Kepler. Dos niveles:
   *  - CAJA: depósitos/retiros del banco (excl. traspasos internos) vs 102 cargos/abonos.
   *  - P&L: cada categoría de gasto vs su cuenta Kepler (cargos del mayor en la balanza).
   * Lee analytics.ledger_monthly (sin RLS → filtro tenant explícito). Diferencias
   * ≠ 0 son esperadas (timing, caja general, factoraje, scope) — es lo que se investiga.
   */
  async reconciliation(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const mayorOf = (acc: string | null) => String(acc || '').split(/[-/]/)[0].trim();

    return this.tk.run(async (trx) => {
      // Lado banco: por categoría (grupo + cuenta Kepler).
      const bank = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period)
        .groupBy('mc.group_key', 'mc.kepler_account', 'mc.name')
        .select(trx.raw(`COALESCE(mc.group_key,'sin_clasificar') AS group_key`),
          'mc.kepler_account', 'mc.name',
          trx.raw('SUM(bm.amount_in)::numeric AS deposits'),
          trx.raw('SUM(bm.amount_out)::numeric AS withdrawals'));

      // Lado libro: balanza del periodo por cuenta mayor (analytics.* → tenant explícito).
      const book = await trx('analytics.ledger_monthly')
        .where({ tenant_id: tenantId, anio_mes: period })
        .groupBy('cuenta_mayor')
        .select('cuenta_mayor', trx.raw('SUM(cargos)::numeric AS cargos'), trx.raw('SUM(abonos)::numeric AS abonos'));
      const bookBy: Record<string, { cargos: number; abonos: number }> = {};
      for (const r of book as any[]) bookBy[r.cuenta_mayor] = { cargos: n(r.cargos), abonos: n(r.abonos) };

      // CAJA: banco (excl. traspasos internos) vs 102.
      const EXCLUDE = new Set(['traspaso']);
      let bankIn = 0, bankOut = 0;
      for (const r of bank as any[]) {
        if (EXCLUDE.has(r.group_key)) continue;
        bankIn += n(r.deposits); bankOut += n(r.withdrawals);
      }
      const k102 = bookBy['102'] || { cargos: 0, abonos: 0 };
      const cash = {
        bank_in: bankIn, kepler_102_cargos: k102.cargos, delta_in: bankIn - k102.cargos,
        bank_out: bankOut, kepler_102_abonos: k102.abonos, delta_out: bankOut - k102.abonos,
      };

      // P&L: categorías de gasto/compra/financiero → cuenta Kepler; banco retiros vs cargos del mayor.
      const PNL_GROUPS = new Set(['gasto', 'compra', 'financiero']);
      const byMayor: Record<string, { concepts: Set<string>; bank: number }> = {};
      for (const r of bank as any[]) {
        if (!PNL_GROUPS.has(r.group_key) || !r.kepler_account) continue;
        const may = mayorOf(r.kepler_account);
        (byMayor[may] ||= { concepts: new Set(), bank: 0 });
        byMayor[may].concepts.add(r.name);
        byMayor[may].bank += n(r.withdrawals);
      }
      const accounts = Object.entries(byMayor).map(([may, v]) => {
        const book = (bookBy[may]?.cargos) || 0;
        return { kepler_account: may, concept: [...v.concepts].join(', '), bank: v.bank, book, delta: v.bank - book };
      }).sort((a, b) => b.bank - a.bank);

      // Cobranza (ingreso) como memo: depósitos vs 102 cargos (ya en cash).
      const cobranza = (bank as any[]).filter((r) => r.group_key === 'ingreso').reduce((s, r) => s + n(r.deposits), 0);

      return { period, cash, accounts, cobranza,
        sin_clasificar: (bank as any[]).filter((r) => r.group_key === 'sin_clasificar').reduce((s, r) => s + n(r.deposits) + n(r.withdrawals), 0) };
    });
  }

  /**
   * CB.2.1 — Import web del workbook Excel (mismo parse+clasificación que el CLI CB.1).
   * Recibe el .xlsx en base64 + periodo; puebla bank_statements + bank_movements
   * (UPSERT por client_uuid, no DELETE). Devuelve resumen por cuenta + grupos.
   */
  async importWorkbook(fileBase64: string, period: string, sourceFile?: string, actor?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!fileBase64) throw new BadRequestException('archivo requerido');
    if (!/^\d{4}-\d{2}$/.test(period || '')) throw new BadRequestException('periodo inválido (YYYY-MM)');
    const b64 = fileBase64.includes(',') ? fileBase64.split(',').pop()! : fileBase64;
    const buf = Buffer.from(b64, 'base64');

    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf as any); } catch { throw new BadRequestException('no se pudo leer el Excel'); }
    const sheets = wb.worksheets.filter((s) => !/TOTAL MOV|CONCENTRADO|FilterDatabase/i.test(s.name));

    return this.tk.run(async (trx) => {
      const catMap = new Map<string, { id: string; group: string }>(
        (await trx('finance.movement_categories').select('id', 'code', 'group_key'))
          .map((r: any) => [r.code, { id: r.id, group: r.group_key }]));
      const acctMap = new Map<string, any>(
        (await trx('finance.bank_accounts').select('id', 'alias', 'account_label'))
          .map((r: any) => [normKey(r.alias), r]));
      const compiled = compileRules(
        await trx('finance.bank_classify_rules').where({ active: true })
          .select('priority', 'match_type', 'match_code', 'match_concept', 'category_code'));

      const perAccount: any[] = [];
      const byGroup: Record<string, { in: number; out: number; n: number }> = {};
      let grandIn = 0, grandOut = 0, grandUncat = 0, grandRows = 0;

      for (const ws of sheets) {
        let hRow = 0; const col: Record<string, number> = {};
        for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
          const u = (ws.getRow(r).values as any[]).map((v) => normKey(v));
          if (u.some((v) => v === 'FECHA')) { hRow = r; u.forEach((v, i) => { if (v) col[v] = i; }); break; }
        }
        const acct = acctMap.get(normKey(ws.name));
        if (!hRow || !col['FECHA'] || (!col['RETIRO'] && !col['DEPOSITO'])) { perAccount.push({ sheet: ws.name, note: 'layout no estándar — omitido' }); continue; }
        if (!acct) { perAccount.push({ sheet: ws.name, note: 'cuenta no registrada — omitido' }); continue; }
        const ci = { fecha: col['FECHA'], m: col['M'], s: col['S'], c: col['C'], prov: col['PROVEEDOR'], ret: col['RETIRO'], dep: col['DEPOSITO'], saldo: col['SALDO'] };

        const rows: any[] = []; const seen = new Map<string, number>();
        let tin = 0, tout = 0, uncat = 0, lastBal: number | null = null, openingBal: number | null = null;
        for (let r = hRow + 1; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          const date = excelDate(cellVal(row, ci.fecha));
          if (!date) continue;
          const amtIn = money(cellVal(row, ci.dep)), amtOut = money(cellVal(row, ci.ret));
          if (amtIn === 0 && amtOut === 0) continue;
          const M = String(cellVal(row, ci.m) ?? '').trim(), C = String(cellVal(row, ci.c) ?? '').trim(), S = String(cellVal(row, ci.s) ?? '').trim();
          const concept = String(cellVal(row, ci.prov) ?? '').replace(/\s+/g, ' ').trim();
          const bal = ci.saldo ? money(cellVal(row, ci.saldo)) : null;
          const catCode = classifyWith(compiled, M, C, concept);
          const cat = catMap.get(catCode);
          const catId = catCode === 'sin_clasificar' ? null : (cat ? cat.id : null);
          const group = catCode === 'sin_clasificar' ? 'sin_clasificar' : (cat ? cat.group : 'sin_clasificar');
          if (!catId) uncat++;
          (byGroup[group] ||= { in: 0, out: 0, n: 0 }); byGroup[group].in += amtIn; byGroup[group].out += amtOut; byGroup[group].n++;
          tin += amtIn; tout += amtOut; if (bal !== null) lastBal = bal;
          // Saldo inicial = saldo (running) tras el primer movimiento − su neto. Habilita el cuadre de saldos (CB.8).
          if (openingBal === null && bal !== null) openingBal = Math.round((bal - amtIn + amtOut) * 100) / 100;
          const contentKey = `${acct.account_label}|${period}|${date}|${M}|${C}|${concept}|${amtIn}|${amtOut}`;
          const occ = (seen.get(contentKey) || 0) + 1; seen.set(contentKey, occ);
          const clientUuid = crypto.createHash('sha1').update(`${contentKey}|${occ}`).digest('hex');
          rows.push({ tenant_id: tenantId, bank_account_id: acct.id, movement_date: date, category_id: catId,
            classified_by: 'rule',
            raw_type: M || null, raw_code: C || null, sucursal: S || null, concept: concept || null,
            amount_in: amtIn, amount_out: amtOut, running_balance: bal, client_uuid: clientUuid, source_file: sourceFile || null });
        }

        const [st] = await trx('finance.bank_statements')
          .insert({ tenant_id: tenantId, bank_account_id: acct.id, period,
            opening_balance: openingBal ?? 0, closing_balance: lastBal ?? 0,
            total_in: Math.round(tin * 100) / 100, total_out: Math.round(tout * 100) / 100,
            source_file: sourceFile || null, status: 'imported', imported_at: trx.fn.now(), imported_by: actor || null })
          .onConflict(['tenant_id', 'bank_account_id', 'period'])
          .merge(['opening_balance', 'closing_balance', 'total_in', 'total_out', 'source_file', 'imported_at', 'updated_at'])
          .returning('id');
        const statementId = (st as any).id;
        for (const r of rows) r.statement_id = statementId;
        for (let i = 0; i < rows.length; i += 500) {
          await trx('finance.bank_movements').insert(rows.slice(i, i + 500))
            .onConflict(['tenant_id', 'client_uuid'])
            // No pisa category_id/classified_by en re-import: preserva la reclasificación
            // manual y la clasificación previa. Para re-aplicar reglas → reclassifyAll().
            .merge(['statement_id', 'bank_account_id', 'movement_date', 'raw_type', 'raw_code',
              'sucursal', 'concept', 'amount_in', 'amount_out', 'running_balance', 'source_file', 'updated_at']);
        }

        grandIn += tin; grandOut += tout; grandUncat += uncat; grandRows += rows.length;
        perAccount.push({ sheet: ws.name, movs: rows.length, deposits: Math.round(tin), withdrawals: Math.round(tout), sin_clasificar: uncat });
      }

      this.logger.log(`import banco periodo ${period}: ${grandRows} movs, ${grandUncat} sin_clasificar, por ${actor || '?'}`);
      return { period, accounts: perAccount, byGroup, total: grandRows, deposits: grandIn, withdrawals: grandOut, sin_clasificar: grandUncat };
    });
  }
}
