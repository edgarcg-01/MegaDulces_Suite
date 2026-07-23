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

// Tokens significativos de un nombre de beneficiario (para el 3er pase del matcher
// por nombre). Quita ruido societario (SA/DE/CV/SAPI…), acentos y palabras cortas.
// Ruido societario + palabras operativas GENÉRICAS: un concepto que solo tiene estas
// (p.ej. "Nomina 01", "Gasto", "Abono") NO debe casar por nombre — no identifica una
// contraparte. Solo casan conceptos con un nombre propio (proveedor/persona) real.
const STOP_TOKENS = new Set(['SA', 'DE', 'CV', 'SAPI', 'SAB', 'SC', 'SRL', 'RL', 'SOFOM', 'ENR', 'SOF', 'THE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'PAGO', 'SPEI', 'TRANSFERENCIA',
  'NOMINA', 'GASTO', 'GASTOS', 'ABONO', 'PRESTAMO', 'RETIRO', 'DEPOSITO', 'COMPRA', 'VENTA', 'COMISION', 'CONSUMO', 'CONSUMOS', 'REEMBOLSO', 'ANTICIPO', 'VIATICOS', 'TRASPASO', 'INTERES', 'INTERESES', 'CAPITAL', 'SUELDO', 'FINIQUITO', 'FACTURA', 'DOMICILIACION', 'SERVICIO', 'SERVICIOS']);
const nameTokens = (s: any): Set<string> => {
  const t = normKey(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ');
  return new Set(t.split(/\s+/).filter((w) => w.length >= 4 && !STOP_TOKENS.has(w)));
};
const nameScore = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
};
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
        // Agrupa por la columna cruda (nullable); el COALESCE del SELECT deriva de
        // ella y Postgres lo acepta. NO agrupar por el COALESCE con binding: el
        // literal del SELECT y el $ del GROUP BY no matchean → 42803 (visto en prod).
        .groupBy('ba.id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind', 'mc.group_key')
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

      // TI=TE: traspasos internos deben netear en la red (depósitos ≈ retiros). CB.13.1 —
      // el cuadre se mide SOLO sobre los marcadores reales de traspaso interno (raw_type
      // TI/TE), no sobre toda la categoría 'traspaso': movimientos S (Spei) o G que caen
      // mal clasificados ahí contaminaban el neto con un descuadre falso (era misclasificación,
      // no un lado faltante — los TI/TE reales netean exacto a 0).
      const tr = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereIn('bm.raw_type', ['TI', 'TE'])
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
   * CB.9 — Diagnóstico "¿por qué no cuadra y qué falta?". Agregador legible que
   * consolida todas las fuentes de descuadre en una lista accionable (cada ítem:
   * qué es, monto, y qué falta hacer). Reúsa balances + reconciliation + conteos;
   * no lee data nueva. Es la pestaña que traduce lo técnico a "esto te falta".
   */
  /** Fecha (Date o 'YYYY-MM-DD') → 'DD/MM' con componentes locales (sin voltear a UTC). */
  private dm(v: any): string {
    if (v instanceof Date && !isNaN(v.getTime())) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}`;
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}` : String(v ?? '');
  }

  async diagnostico(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const money = (v: number) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

    // Totales de la tabla (ingresos/egresos) + sin_clasificar + cuentas sin estado de cuenta.
    const { totales, sinClas, sinClasBuckets, cuentasSinEstado, matchedCount, keplerPostingsCount } = await this.tk.run(async (trx) => {
      const t = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period)
        .select(trx.raw('SUM(bm.amount_in)::numeric AS ingresos'), trx.raw('SUM(bm.amount_out)::numeric AS egresos'), trx.raw('COUNT(*)::int AS movs'))
        .first();
      const sc = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.category_id')
        .select(trx.raw('COUNT(*)::int AS n'), trx.raw('SUM(bm.amount_in + bm.amount_out)::numeric AS monto')).first();
      // Los grupos que más pesan del sin_clasificar (código + concepto) → qué regla agregar.
      const scb = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.category_id')
        .groupByRaw(`COALESCE(NULLIF(bm.raw_code,''),'—'), LEFT(UPPER(COALESCE(bm.concept,'')), 28)`)
        .select(trx.raw(`COALESCE(NULLIF(bm.raw_code,''),'—') AS code`),
          trx.raw(`LEFT(UPPER(COALESCE(bm.concept,'')), 28) AS concepto`),
          trx.raw('COUNT(*)::int AS n'), trx.raw('SUM(bm.amount_in + bm.amount_out)::numeric AS monto'))
        .orderByRaw('SUM(bm.amount_in + bm.amount_out) DESC').limit(6);
      // Cuentas activas sin estado de cuenta cargado este periodo (p.ej. CAJA GENERAL no importable).
      const missing = await trx('finance.bank_accounts as ba')
        .where('ba.active', true)
        .whereNotExists(function () { this.select(trx.raw('1')).from('finance.bank_statements as st').whereRaw('st.bank_account_id = ba.id AND st.period = ?', [period]); })
        .select('ba.bank', 'ba.account_label', 'ba.kind');
      // ¿Ya corrió la conciliación por-transacción? Si 0 casados, la evidencia dirá
      // "sin casar en Kepler" en TODO → engañoso (parece que falta en Kepler cuando
      // en realidad no se ha pareado). Avisamos que corra "Conciliar" primero.
      const mc = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).where('bm.recon_status', 'matched')
        .count({ n: '*' }).first();
      // ¿Hay pólizas del 102 de Kepler cargadas para el periodo? (feed analytics.bank_postings,
      // sin RLS → tenant explícito). Sin ellas el matching NO puede correr en absoluto.
      const kp = await trx('analytics.bank_postings')
        .where({ tenant_id: tenantId, anio_mes: period }).count({ n: '*' }).first();
      return { totales: t, sinClas: sc, sinClasBuckets: scb, cuentasSinEstado: missing,
        matchedCount: n((mc as any)?.n), keplerPostingsCount: n((kp as any)?.n) };
    });

    const bal = await this.balances(period);
    let recon: any = null;
    try { recon = await this.reconciliation(period); } catch { recon = null; }

    const ingresos = n((totales as any)?.ingresos), egresos = n((totales as any)?.egresos);
    const items: any[] = [];

    // 1. Movimientos sin clasificar (+ evidencia: los grupos que más pesan = qué regla agregar).
    if (n((sinClas as any)?.n) > 0) {
      const evidencia = (sinClasBuckets as any[]).map((b) => ({
        label: `Cód ${b.code} · "${String(b.concepto || '').trim() || '(sin concepto)'}…"`,
        count: Number(b.n), monto: n(b.monto),
      }));
      items.push({ tipo: 'sin_clasificar', severidad: 'warn', importe: n((sinClas as any)?.monto),
        titulo: `${(sinClas as any).n} movimientos sin clasificar`,
        detalle: `Hay ${money(n((sinClas as any)?.monto))} sin categoría asignada. No entran a ningún grupo del cuadre. Los grupos de abajo son los que más pesan.`,
        accion: 'Por ahora la clasificación no se edita aquí. En Kepler, busca cada movimiento por monto + fecha en el auxiliar del 102: la contracuenta te dice su naturaleza. Si no está registrado, captúralo en la cuenta correcta.',
        evidencia });
    }
    // 2. Cuentas cuyo saldo no cuadra (+ evidencia: el renglón donde el saldo salta).
    for (const a of bal.accounts.filter((x: any) => !x.cuadra && !x.sin_saldo)) {
      items.push({ tipo: 'saldo_no_cuadra', severidad: Math.abs(a.delta) >= 100000 ? 'bad' : 'warn', importe: Math.abs(a.delta),
        titulo: `${a.bank} ${a.account_label}: el saldo no cierra`,
        detalle: `Inicial ${money(a.opening)} + ingresos ${money(a.total_in)} − egresos ${money(a.total_out)} = ${money(a.computed_closing)}, pero el saldo final es ${money(a.closing)} (Δ ${money(a.delta)}).`,
        accion: 'Falta capturar un movimiento en esta cuenta, o el saldo está mal tecleado. Revisa el/los renglón(es) de abajo: ahí el saldo del estado de cuenta salta más de lo que explica el movimiento.',
        _statementId: a.statement_id, _opening: a.opening });
    }
    // 3. Cuentas sin estado de cuenta cargado (CAJA GENERAL, etc.).
    for (const c of cuentasSinEstado as any[]) {
      items.push({ tipo: 'cuenta_sin_cargar', severidad: 'warn', importe: 0,
        titulo: `${c.bank} ${c.account_label}: sin cargar`,
        detalle: `La cuenta existe en el catálogo pero no tiene estado de cuenta en ${period}.${c.kind === 'cash' ? ' (CAJA GENERAL tiene un layout de columnas distinto — pendiente de soportar.)' : ''}`,
        accion: 'Sube su estado de cuenta del periodo, o desactívala en Admin si ya no aplica.' });
    }
    // 4. Traspasos internos que no netean (TI=TE).
    if (Math.abs(bal.traspasos.delta) >= 1000) {
      items.push({ tipo: 'traspaso_descuadre', severidad: 'warn', importe: Math.abs(bal.traspasos.delta),
        titulo: 'Los traspasos internos no netean',
        detalle: `Entra ${money(bal.traspasos.entra)} vs sale ${money(bal.traspasos.sale)} en traspasos entre cuentas propias (Δ ${money(bal.traspasos.delta)}). Deberían ser iguales.`,
        accion: 'Falta el otro lado de un traspaso (la cuenta destino o la de origen). Revisa los movimientos tipo TI/TE.' });
    }
    // 5. Diferencias vs Kepler (P&L) — solo si hay balanza. Dirección + causa concreta.
    if (recon?.accounts?.length) {
      for (const a of recon.accounts.filter((x: any) => Math.abs(n(x.delta)) >= 10000)) {
        const delta = n(a.delta), abs = Math.abs(delta);
        const keplerMas = delta < 0; // book (mayor) > banco (pagado)
        const detalle = keplerMas
          ? `Kepler registra ${money(a.book)} de gasto en el mayor ${a.kepler_account} («${a.concept}»), pero por banco solo salieron ${money(a.bank)}: hay ${money(abs)} MÁS reconocido en Kepler que pagado por banco.`
          : `Por banco salieron ${money(a.bank)} en «${a.concept}», pero Kepler solo registra ${money(a.book)} en el mayor ${a.kepler_account}: el banco pagó ${money(abs)} MÁS de lo que Kepler reconoce.`;
        const accion = keplerMas
          ? `Kepler YA reconoció este gasto; el banco todavía no lo paga. Normalmente NO se corrige en Kepler — es cuenta por pagar. Pasos: (1) en Kepler abre el auxiliar del mayor ${a.kepler_account} y saca las facturas SIN pago aplicado (esas explican el Δ); (2) confirma que el proveedor esté en cuentas por pagar; (3) si YA se pagó, busca el pago en otra cuenta de banco o en factoraje. El detalle de facturas por proveedor está en el módulo Egresos.`
          : `Salió dinero del banco que Kepler no reconoce en el mayor ${a.kepler_account}. Cada renglón de abajo con «sin conciliar en Kepler» es un pago SIN póliza en el 102. Pasos en Kepler, uno por uno: (1) busca la póliza de egreso por beneficiario + monto + fecha; (2) si NO existe, captúrala en el mayor correcto; (3) si existe pero en otra cuenta, reclasifícala. Los renglones que ya muestran folio Kepler están conciliados —esos no se tocan.`;
        items.push({ tipo: 'kepler_pnl', severidad: abs >= 100000 ? 'bad' : 'warn', importe: abs,
          titulo: keplerMas ? `Kepler registra más que el banco: ${a.concept}` : `El banco pagó más que Kepler: ${a.concept}`,
          detalle, accion, _mayor: a.kepler_account });
      }
    }

    // Evidencia con folios/renglones concretos (saldo + Kepler). Un solo tk.run.
    const needsEvidence = items.some((it) => it._statementId || it._mayor);
    if (needsEvidence) {
      await this.tk.run(async (trx) => {
        for (const it of items) {
          // Saldo: recorrer el estado de cuenta y ubicar dónde el saldo salta más que el neto.
          if (it._statementId) {
            const movs = await trx('finance.bank_movements')
              .where({ statement_id: it._statementId }).whereNotNull('running_balance')
              .select('movement_date', 'concept', 'amount_in', 'amount_out', 'running_balance')
              .orderBy([{ column: 'movement_date' }, { column: 'id' }]);
            let cum = n(it._opening), prevRes = 0; const breaks: any[] = [];
            for (const m of movs as any[]) {
              cum = Math.round((cum + n(m.amount_in) - n(m.amount_out)) * 100) / 100;
              const res = Math.round((n(m.running_balance) - cum) * 100) / 100;
              const step = Math.round((res - prevRes) * 100) / 100;
              if (Math.abs(step) >= 1) breaks.push({ label: `${this.dm(m.movement_date)} · ${(m.concept || '—').slice(0, 40)}`, monto: step });
              prevRes = res;
            }
            breaks.sort((x, y) => Math.abs(y.monto) - Math.abs(x.monto));
            it.evidencia = breaks.slice(0, 3);
          }
          // Kepler: los pagos del banco de ese mayor (con folio Kepler si están casados).
          if (it._mayor) {
            const rows = await trx('finance.bank_movements as bm')
              .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
              .join('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
              .leftJoin('finance.bank_recon_matches as rm', 'rm.bank_movement_id', 'bm.id')
              .where('st.period', period).where('bm.amount_out', '>', 0)
              .whereRaw(`(regexp_split_to_array(mc.kepler_account, '[-/]'))[1] = ?`, [it._mayor])
              .select('bm.movement_date', 'bm.concept', 'bm.amount_out', 'rm.kepler_doc_tipo', 'rm.kepler_doc_folio')
              .orderBy('bm.amount_out', 'desc').limit(6);
            it.evidencia = (rows as any[]).map((r) => ({
              label: `${this.dm(r.movement_date)} · ${(r.concept || '—').slice(0, 40)}`,
              monto: n(r.amount_out),
              folio: r.kepler_doc_folio ? `Kepler ${r.kepler_doc_tipo || ''} ${r.kepler_doc_folio}`.trim() : 'sin conciliar en Kepler',
            }));
          }
        }
      });
    }
    for (const it of items) { delete it._statementId; delete it._opening; delete it._mayor; }

    items.sort((x, y) => (y.importe || 0) - (x.importe || 0));
    const cuadra = items.length === 0; // real issues, antes de meter el aviso informativo
    // Aviso al frente: la evidencia "sin casar en Kepler" solo es confiable si (a) están
    // cargadas las pólizas del 102 de Kepler y (b) ya corrió el matching. Si no, todo
    // sale "sin casar" y parecería que falta en Kepler cuando NO es cierto.
    const conciliacionCorrida = n(matchedCount) > 0;
    const sinPostingsKepler = n(keplerPostingsCount) === 0;
    if (sinPostingsKepler && !!recon?.accounts?.length) {
      items.unshift({ tipo: 'aviso_conciliar', severidad: 'info', importe: 0,
        titulo: 'Faltan las pólizas del 102 de Kepler (no se puede conciliar aún)',
        detalle: 'No hay pólizas del 102 (bancos/caja) de Kepler cargadas para este periodo, así que la conciliación por-transacción no puede correr y toda la evidencia dirá «sin conciliar en Kepler». Eso NO significa que falte en Kepler — todavía no hay con qué cruzar.',
        accion: 'Carga el feed de pólizas 102 del periodo (import-bank-postings) y luego presiona «Conciliar» en la pestaña Conciliación. Recién entonces la evidencia mostrará el folio exacto de Kepler de cada pago.' });
    } else if (!conciliacionCorrida && !!recon?.accounts?.length) {
      items.unshift({ tipo: 'aviso_conciliar', severidad: 'info', importe: 0,
        titulo: 'Corre «Conciliar» primero',
        detalle: 'Las pólizas de Kepler están cargadas pero la conciliación por-transacción no se ha ejecutado este periodo, así que la evidencia de abajo marca todo como «sin conciliar en Kepler». Eso NO significa que falte en Kepler — significa que aún no se parean los pagos.',
        accion: 'Ve a la pestaña Conciliación y presiona «Conciliar». Después, cada renglón mostrará su folio de Kepler cuando exista, y solo los que queden «sin conciliar» serán gaps reales que capturar.' });
    }
    const totalDescuadre = bal.totals.descuadre;
    return {
      period,
      ingresos, egresos, neto: Math.round((ingresos - egresos) * 100) / 100,
      movimientos: n((totales as any)?.movs),
      cuadra,
      cuentas_ok: bal.accounts.filter((a: any) => a.cuadra).length,
      cuentas_total: bal.accounts.length,
      total_descuadre: totalDescuadre,
      // CB.13.1 — la balanza está "cargada" si el 102 de Kepler tiene datos (cargos/abonos),
      // NO si recon.accounts tiene filas: ese array se vació a propósito al eliminar el P&L
      // adivinado, así que atarlo ahí dejaba el banner "balanza no cargada" prendido siempre.
      tiene_balanza_kepler: n(recon?.cash?.kepler_102_cargos) > 0 || n(recon?.cash?.kepler_102_abonos) > 0,
      conciliacion_corrida: conciliacionCorrida,
      kepler_postings_cargados: !sinPostingsKepler,
      items,
    };
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
      { rule_key: 'banco_saldo_no_cuadra', nombre: 'Saldo de cuenta no cuadra', clase: 'error_captura',
        descripcion: 'saldo_inicial + depósitos − retiros ≠ saldo_final del estado de cuenta: falta capturar un movimiento o el saldo está mal tecleado.' },
    ];

    const findings: FinanceFindingInput[] = [];

    for (const m of unmatched as any[]) {
      const importe = n(m.amount_out);
      findings.push({
        rule_key: 'banco_retiro_sin_kepler', clase: 'riesgo',
        severity: importe >= 500000 ? 'critical' : 'warn', score: importe >= 500000 ? 0.9 : 0.65,
        titulo: `Retiro sin conciliar ${money(importe)} — ${m.concept || m.bank}`,
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

    // CB.13 — banco_pnl_descuadre ELIMINADO: se alimentaba del P&L categoría→mayor
    // adivinado (removido). Generaba hallazgos falsos. La conciliación real es el
    // retiro-sin-casar (arriba) del matching por-transacción.

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
      // 3er pase (CB.10): por NOMBRE del beneficiario + monto aproximado. Rescata los
      // pagos donde los centavos banco ≠ Kepler (redondeos, IVA, comisión embebida) pero
      // el beneficiario coincide. Exige AMBOS: |Δmonto| ≤ max($5, 0.5%) Y score de nombre
      // ≥ 0.5 (tokens significativos compartidos) → no casa por monto solo (seguro).
      const NAME_PASS_MIN = 5000;
      let thirdPass = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || n(mv.amount_out) < NAME_PASS_MIN) continue;
        const amt = n(mv.amount_out), tol = Math.max(5, amt * 0.005);
        const mvTok = nameTokens(mv.concept);
        if (!mvTok.size) continue;
        let best: any = null, bestScore = 0, bestD = Infinity;
        for (const p of posts) {
          if (p.used || Math.abs(p.importe - amt) > tol) continue;
          const sc = nameScore(mvTok, nameTokens(p.contraparte));
          if (sc < 0.5) continue;
          const d = p.fecha ? days(mv.movement_date, p.fecha) : 999;
          if (sc > bestScore || (sc === bestScore && d < bestD)) { best = p; bestScore = sc; bestD = d; }
        }
        if (!best) continue;
        best.used = true; matchedIds.push(mv.id); matchedSet.add(mv.id); thirdPass++;
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: best.doc_tipo,
          kepler_doc_folio: best.folio, kepler_cuenta: '102', kepler_amount: best.importe,
          match_type: 'inferred', match_confidence: 0.6, matched_by: 'motor-name' });
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
      this.logger.log(`match ${period}: ${matches.length}/${bankMovs.length} retiros casados (${secondPass} 2º pase, ${thirdPass} por nombre)`);
      return {
        period, bank_movements: bankMovs.length, matched: matches.length, second_pass: secondPass, name_pass: thirdPass,
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

      // Lado libro: balanza del periodo. Base = ALMACÉN 00 (CEDIS): el 100% del 102
      // (pólizas de banco) de Kepler vive ahí; 02/03 son libros locales de tienda que
      // NO salen de estos bancos corporativos. Sumar las 3 sucursales inflaba el 102 (CB.13).
      const book = await trx('analytics.ledger_monthly')
        .where({ tenant_id: tenantId, anio_mes: period, sucursal: '00' })
        .groupBy('cuenta_mayor')
        .select('cuenta_mayor', trx.raw('SUM(cargos)::numeric AS cargos'), trx.raw('SUM(abonos)::numeric AS abonos'));
      const bookBy: Record<string, { cargos: number; abonos: number }> = {};
      for (const r of book as any[]) bookBy[r.cuenta_mayor] = { cargos: n(r.cargos), abonos: n(r.abonos) };

      // CAJA: banco (excl. traspasos internos) vs 102 de almacén 00. ESTA es la conciliación
      // contra Kepler. El detalle exacto (¿qué pago casa con qué póliza?) vive en el matching
      // por-transacción (runMatch) — no en un mapeo categoría→mayor.
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

      // CB.13 — El P&L "categoría banco → mayor Kepler" se ELIMINÓ: los mapeos eran
      // adivinados (602 es vehículos, no traslado; 608 es misc, no tarjeta; 611-003 tiene
      // $600, no todas las comisiones) y generaban deltas falsos. El catálogo real (185
      // cuentas, branch-specific) + el desfase cash/devengado hacen imposible el mapeo 1:N.
      // La conciliación real = matching por-transacción (exacto). accounts queda vacío.
      const accounts: { kepler_account: string; concept: string; bank: number; book: number; delta: number }[] = [];

      // Cobranza (ingreso) como memo: depósitos vs 102 cargos (ya en cash).
      const cobranza = (bank as any[]).filter((r) => r.group_key === 'ingreso').reduce((s, r) => s + n(r.deposits), 0);

      return { period, cash, accounts, cobranza,
        sin_clasificar: (bank as any[]).filter((r) => r.group_key === 'sin_clasificar').reduce((s, r) => s + n(r.deposits) + n(r.withdrawals), 0) };
    });
  }

  /**
   * CB.11 — Verifica el PARSEO contra la hoja CONCENTRADO (finance.bank_concentrado_ref):
   * agrega bank_movements por cuenta × tipo-M y compara contra la referencia humana
   * (la verdad que contabilidad ya cuadró). Δ≠0 en cualquier tipo = error de captura
   * NUESTRO, detectado de una vez (no por muestreo). Los tipos S/DS (pares Spei/DevSpei)
   * se reportan aparte: el CONCENTRADO los excluye por lavarse. Candado de regresión.
   */
  async parseCheck(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const CONC_TYPES = ['I', 'ID', 'LEM', 'CI', 'C', 'CF', 'PF', 'P', 'PLEM', 'G', 'TI', 'TE'];
    const digits = (s: any) => String(s || '').replace(/\D/g, '');
    return this.tk.run(async (trx) => {
      const ref = await trx('finance.bank_concentrado_ref').where({ period })
        .select('bank', 'cuenta', 'account_key', 'tipo', 'monto');
      if (!ref.length) return { period, tiene_referencia: false, ok: null,
        mensaje: 'No hay hoja CONCENTRADO cargada para este periodo (corre import-concentrado).' };

      const refByAcct: Record<string, { bank: string; cuenta: string; t: Record<string, number> }> = {};
      for (const r of ref as any[]) { (refByAcct[r.account_key] ||= { bank: r.bank, cuenta: r.cuenta, t: {} }).t[r.tipo] = n(r.monto); }

      const mv = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .where('st.period', period)
        .groupBy('ba.bank', 'ba.account_label', 'ba.alias', 'bm.raw_type')
        .select('ba.account_label as lbl', 'ba.bank', 'ba.alias', trx.raw('UPPER(bm.raw_type) as rt'),
          trx.raw('SUM(bm.amount_in + bm.amount_out)::numeric as monto'));
      const dbByAcct: Record<string, { bank: string; lbl: string; alias: string; t: Record<string, number> }> = {};
      for (const r of mv as any[]) { const k = `${r.bank}|${r.lbl}`;
        (dbByAcct[k] ||= { bank: r.bank, lbl: r.lbl, alias: String(r.alias || '').toUpperCase(), t: {} });
        dbByAcct[k].t[r.rt] = (dbByAcct[k].t[r.rt] || 0) + n(r.monto); }

      const matchRef = (d: any): [string, any] | null => {
        const dd = digits(d.lbl), dbank = String(d.bank).toUpperCase();
        for (const [k, e] of Object.entries(refByAcct)) {
          const kd = digits(k);
          if (kd && dd && (kd === dd || (kd.length >= 3 && dd.endsWith(kd)) || (dd.length >= 3 && kd.endsWith(dd)))) return [k, e];
          const tok = String(k).toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (tok && d.alias.replace(/[^A-Z0-9]/g, '').includes(tok)) return [k, e];
          if (!kd && !dd && (String(e.bank).toUpperCase().startsWith(dbank) || dbank.startsWith(String(e.bank).toUpperCase().slice(0, 4)))) return [k, e];
        }
        return null;
      };

      const cuentas: any[] = []; let totalDelta = 0; const usedRef = new Set<string>();
      for (const d of Object.values(dbByAcct)) {
        const m = matchRef(d);
        if (!m) { cuentas.push({ bank: d.bank, cuenta: d.lbl, matched: false, nota: 'sin fila en CONCENTRADO' }); continue; }
        const [rk, e] = m; usedRef.add(rk);
        const byType: Record<string, number> = {}; const extras: Record<string, number> = {};
        for (const [rt, v] of Object.entries(d.t)) { if (CONC_TYPES.includes(rt)) byType[rt] = (byType[rt] || 0) + v; else extras[rt] = (extras[rt] || 0) + v; }
        const diffs: any[] = [];
        for (const ty of CONC_TYPES) { const ex = e.t[ty] || 0, ob = byType[ty] || 0; const delta = Math.round((ob - ex) * 100) / 100;
          if (Math.abs(delta) >= 1) { diffs.push({ tipo: ty, excel: ex, db: ob, delta }); totalDelta += Math.abs(delta); } }
        cuentas.push({ bank: e.bank, cuenta: e.cuenta, matched: true, diffs,
          extras: Object.entries(extras).filter(([, v]) => Math.abs(v) >= 1).map(([tipo, monto]) => ({ tipo, monto: Math.round(monto) })) });
      }
      const refSinCuenta = Object.entries(refByAcct).filter(([k]) => !usedRef.has(k)).map(([, e]) => ({ bank: e.bank, cuenta: e.cuenta }));
      totalDelta = Math.round(totalDelta * 100) / 100;
      return { period, tiene_referencia: true, ok: totalDelta < 1, total_delta: totalDelta,
        cuentas_ok: cuentas.filter((c) => c.matched && !c.diffs?.length).length,
        cuentas_total: cuentas.length, cuentas, ref_sin_cuenta: refSinCuenta };
    });
  }

  /**
   * CB.13 (Fase 1) — Búsqueda en el catálogo REAL de cuentas de Kepler (finance.kepler_accounts,
   * canónico almacén 00). Por clave o descripción — réplica del "Búsqueda de cuentas" de Kepler.
   * Sirve para mapear/consultar contra el catálogo real en vez de adivinar.
   */
  async keplerAccounts(search?: string, limit = 60) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = trx('finance.kepler_accounts')
        .select('cuenta', 'cuenta_nombre', 'cuenta_mayor', 'cuenta_mayor_nombre', 'es_mayor')
        .orderBy('cuenta').limit(Math.min(limit, 200));
      const s = String(search || '').trim();
      if (s) q.where((b) => b.where('cuenta', 'ilike', `%${s}%`).orWhere('cuenta_nombre', 'ilike', `%${s}%`));
      return q;
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
        // Alias de columnas: hojas de banco (C/PROVEEDOR/RETIRO/DEPOSITO/SALDO) y
        // CAJA GENERAL (CTA/DESCRIPCION/EGRESO/INGRESO, sin SALDO — trae ARQUEO/DIF).
        const ci = {
          fecha: col['FECHA'], m: col['M'], s: col['S'],
          c: col['C'] || col['CTA'], prov: col['PROVEEDOR'] || col['DESCRIPCION'],
          ret: col['RETIRO'] || col['EGRESO'], dep: col['DEPOSITO'] || col['INGRESO'],
          saldo: col['SALDO'], folio: col['#'] || col['FOLIO'],
        };
        if (!hRow || !ci.fecha || (!ci.ret && !ci.dep)) { perAccount.push({ sheet: ws.name, note: 'layout no estándar — omitido' }); continue; }
        if (!acct) { perAccount.push({ sheet: ws.name, note: 'cuenta no registrada — omitido' }); continue; }

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
