import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PVG — Presupuesto de GASTOS auto-propuesto desde los egresos de Kepler (ADR-073).
 *
 * El gasto se presupuesta al grano contable natural: la CUENTA MAYOR (`analytics.expense_entries.
 * cuenta_mayor`, siempre poblada; `dpto`/`concepto` son ralos). El sistema PROPONE (base histórica ×
 * (1+crecimiento), relleno híbrido); el humano sólo ajusta. «Sin datos» ≠ cero.
 *
 * La propuesta vive en la rejilla `budget.expense_plan_lines` (cuenta × sucursal × mes) — capa de
 * PROPUESTA re-ejecutable, SEPARADA del libro mayor de 5 estados `budget.budget_lines` (que lleva
 * reserva/compromiso/ejercido y no se pisa a ciegas). La materialización de la rejilla aprobada a
 * partidas de `budget_lines` es un paso posterior declarado (no en este sprint).
 *
 * El «real» de gastos NUNCA se recalcula acá — se lee de `analytics.expense_entries` por mes.
 */

export interface UpsertExpensePlanSettingsDto {
  proposal_families?: string[];
  default_growth_pct?: number;
  growth_by_account?: Record<string, number>;
  by_sucursal?: boolean;
  control_level?: 'informativo' | 'advertencia' | 'bloqueo';
}

export interface ProposeExpensePlanDto {
  /** crecimiento objetivo por cuenta mayor (fracción), p.ej. { '610': 0.08 }. */
  growth_by_account?: Record<string, number>;
  /** crecimiento de respaldo (fracción) para cuentas sin objetivo explícito. */
  default_growth_pct?: number;
  /** familias Kepler a incluir; degrada a settings → ['6'] (gasto operativo). */
  families?: string[];
  /** presupuestar por sucursal (true) o consolidado (false); degrada a settings. */
  by_sucursal?: boolean;
  /** sobrescribir líneas capturadas a mano (por defecto NO). */
  overwrite_manual?: boolean;
}

export interface UpsertExpensePlanLineDto {
  account_code: string;
  account_name?: string | null;
  sucursal?: string | null;
  year_month: string;
  monto: number;
  notes?: string | null;
}

/** familias Kepler por defecto = gasto operativo. */
const DEFAULT_FAMILIES = ['6'];
/** meses apareados mínimos para confiar en un YoY por cuenta (menos = tendencia no confiable → default). */
const MIN_PAIRED_MONTHS = 4;
/** meses presentes mínimos para tratar una cuenta como RECURRENTE (rellenar meses faltantes con su promedio). */
const MIN_MONTHS_RECURRENT = 6;

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

@Injectable()
export class BudgetExpensePlanService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Plan de gastos de un ejercicio: cabecera + supuestos + líneas propuestas. */
  async getPlan(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!budget) throw new NotFoundException('Presupuesto no encontrado');
      const settings = await this.settingsRow(trx, tenantId, budgetId);
      const lines = await trx('budget.expense_plan_lines')
        .where({ tenant_id: tenantId, budget_id: budgetId })
        .orderBy([{ column: 'account_code', order: 'asc' }, { column: 'sucursal', order: 'asc' }, { column: 'year_month', order: 'asc' }]);
      return { budget, settings, lines };
    });
  }

  private normFamilies(v: unknown): string[] {
    if (Array.isArray(v) && v.length) return v.map((x) => String(x));
    if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); if (Array.isArray(p) && p.length) return p.map((x) => String(x)); } catch { /* noop */ } }
    return DEFAULT_FAMILIES;
  }

  private async settingsRow(trx: import('knex').Knex, tenantId: string, budgetId: string) {
    const row = await trx('budget.expense_plan_settings').where({ tenant_id: tenantId, budget_id: budgetId }).first();
    if (!row) return { budget_id: budgetId, proposal_families: DEFAULT_FAMILIES, default_growth_pct: 0, growth_by_account: {} as Record<string, number>, by_sucursal: false, control_level: 'advertencia', exists: false };
    return {
      ...row,
      proposal_families: this.normFamilies(row.proposal_families),
      growth_by_account: row.growth_by_account || {},
      by_sucursal: !!row.by_sucursal,
      exists: true,
    };
  }

  async getSettings(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => this.settingsRow(trx, tenantId, budgetId));
  }

  async upsertSettings(budgetId: string, dto: UpsertExpensePlanSettingsDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (dto.control_level && !['informativo', 'advertencia', 'bloqueo'].includes(dto.control_level)) throw new BadRequestException('control_level inválido');
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      const patch: Record<string, unknown> = { updated_by: username, updated_at: trx.fn.now() };
      if (dto.proposal_families != null) patch.proposal_families = JSON.stringify(this.normFamilies(dto.proposal_families));
      if (dto.default_growth_pct != null) patch.default_growth_pct = round4(Number(dto.default_growth_pct));
      if (dto.growth_by_account != null) patch.growth_by_account = JSON.stringify(dto.growth_by_account);
      if (dto.by_sucursal != null) patch.by_sucursal = !!dto.by_sucursal;
      if (dto.control_level != null) patch.control_level = dto.control_level;
      const [row] = await trx('budget.expense_plan_settings')
        .insert({
          tenant_id: tenantId, budget_id: budgetId,
          proposal_families: JSON.stringify(this.normFamilies(dto.proposal_families ?? DEFAULT_FAMILIES)),
          default_growth_pct: dto.default_growth_pct != null ? round4(Number(dto.default_growth_pct)) : 0,
          growth_by_account: JSON.stringify(dto.growth_by_account ?? {}),
          by_sucursal: dto.by_sucursal != null ? !!dto.by_sucursal : false,
          control_level: dto.control_level ?? 'advertencia',
          created_by: username, updated_by: username,
        })
        .onConflict(['tenant_id', 'budget_id'])
        .merge(patch)
        .returning('*');
      return { ...row, proposal_families: this.normFamilies(row.proposal_families), growth_by_account: row.growth_by_account || {}, by_sucursal: !!row.by_sucursal };
    });
  }

  /** Egresos NETOS (cargo − abono) por cuenta mayor × [sucursal] × año × mes, para N años y familias dadas. */
  private async netByAccountYearMonth(
    trx: import('knex').Knex, tenantId: string, years: number[], families: string[], bySucursal: boolean,
  ): Promise<Array<{ account_code: string; account_name: string | null; familia: string; sucursal: string; year: number; month: number; monto: number }>> {
    if (!years.length || !families.length) return [];
    const sucSel = bySucursal ? 'coalesce(sucursal, \'\')' : `''`;
    const rows = await trx.raw(
      `SELECT cuenta_mayor AS account_code,
              max(cuenta_mayor_nombre) AS account_name,
              max(familia) AS familia,
              ${sucSel} AS sucursal,
              extract(year from fecha)::int AS year,
              extract(month from fecha)::int AS month,
              sum(CASE WHEN cargo_abono = 'A' THEN -importe ELSE importe END) AS monto
         FROM analytics.expense_entries
        WHERE tenant_id = ?
          AND familia = ANY(?)
          AND cuenta_mayor IS NOT NULL AND cuenta_mayor <> ''
          AND extract(year from fecha) = ANY(?)
        GROUP BY cuenta_mayor, ${sucSel}, extract(year from fecha), extract(month from fecha)`,
      [tenantId, families, years],
    );
    return (rows.rows || rows).map((r: Record<string, unknown>) => ({
      account_code: String(r.account_code), account_name: r.account_name != null ? String(r.account_name) : null,
      familia: r.familia != null ? String(r.familia) : '', sucursal: String(r.sucursal ?? ''),
      year: Number(r.year), month: Number(r.month), monto: Number(r.monto) || 0,
    }));
  }

  /** Años con egresos (de las familias dadas) anteriores a `fy`. */
  private async yearsWithExpenseBefore(trx: import('knex').Knex, tenantId: string, fy: number, families: string[]): Promise<number[]> {
    if (!families.length) return [];
    const rows = await trx.raw(
      `SELECT DISTINCT extract(year from fecha)::int AS year
         FROM analytics.expense_entries
        WHERE tenant_id = ? AND familia = ANY(?) AND extract(year from fecha) < ?`,
      [tenantId, families, fy],
    );
    return (rows.rows || rows).map((r: { year: number | string }) => Number(r.year)).sort((a: number, b: number) => a - b);
  }

  /** Frescura declarable del fact de egresos (max computed_at). */
  private async expenseFreshness(trx: import('knex').Knex, tenantId: string) {
    const r = await trx('analytics.expense_entries').where({ tenant_id: tenantId }).max({ as_of: 'computed_at' }).first();
    return r?.as_of ?? null;
  }

  /**
   * Propone el crecimiento (CREC) por cuenta mayor desde la tendencia histórica (YoY del par de años más
   * reciente, sobre meses APAREADOS). Escalera de fallback: cuenta → global → default. Declara la cobertura.
   */
  async proposeExpenseGrowth(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      const fy = Number(b.fiscal_year);
      const settings = await this.settingsRow(trx, tenantId, budgetId);
      const families = settings.proposal_families;
      const def = Number(settings.default_growth_pct) || 0;
      const years = await this.yearsWithExpenseBefore(trx, tenantId, fy, families);
      const as_of = await this.expenseFreshness(trx, tenantId);

      if (years.length < 2) {
        return { by_account: {} as Record<string, { growth_pct: number; basis: string; paired_months: number }>, global: { growth_pct: def, basis: 'default', paired_months: 0 }, years_available: years, fiscal_year: fy, families, as_of, min_paired_months: MIN_PAIRED_MONTHS };
      }
      const y1 = years[years.length - 1];
      const y0 = years[years.length - 2];
      const rows = await this.netByAccountYearMonth(trx, tenantId, [y0, y1], families, false);

      const yoy = (pred: (account: string) => boolean) => {
        const byMonth = new Map<number, { a: number; b: number }>(); // a=y0, b=y1
        for (const r of rows) {
          if (!pred(r.account_code)) continue;
          const e = byMonth.get(r.month) || { a: 0, b: 0 };
          if (r.year === y0) e.a += r.monto; else if (r.year === y1) e.b += r.monto;
          byMonth.set(r.month, e);
        }
        let a = 0, bb = 0, paired = 0;
        for (const [, e] of byMonth) { if (e.a > 0 && e.b > 0) { a += e.a; bb += e.b; paired++; } }
        return paired >= MIN_PAIRED_MONTHS && a > 0 ? { growth_pct: round4((bb - a) / a), paired } : null;
      };

      const g = yoy(() => true);
      const global = g ? { growth_pct: g.growth_pct, basis: 'yoy_paired' as const, paired_months: g.paired } : { growth_pct: def, basis: 'default' as const, paired_months: 0 };
      const accounts = [...new Set(rows.map((r) => r.account_code))];
      const nameByAcc = new Map(rows.map((r) => [r.account_code, r.account_name]));
      const by_account: Record<string, { growth_pct: number; basis: string; paired_months: number; account_name: string | null }> = {};
      for (const acc of accounts) {
        const c = yoy((x) => x === acc);
        if (c) by_account[acc] = { growth_pct: c.growth_pct, basis: 'yoy_paired', paired_months: c.paired, account_name: nameByAcc.get(acc) ?? null };
        else if (global.basis === 'yoy_paired') by_account[acc] = { growth_pct: global.growth_pct, basis: 'global', paired_months: global.paired_months, account_name: nameByAcc.get(acc) ?? null };
        else by_account[acc] = { growth_pct: def, basis: 'default', paired_months: 0, account_name: nameByAcc.get(acc) ?? null };
      }
      return { by_account, global, years_available: years, fiscal_year: fy, families, as_of, min_paired_months: MIN_PAIRED_MONTHS };
    });
  }

  /**
   * Propone el plan de gastos COMPLETO (cuenta × [sucursal] × 12 meses) desde la historia:
   *   · mes con base real del año anterior → monto = base × (1+crec)                 (method='historico_ajustado')
   *   · cuenta RECURRENTE (≥6 meses con dato), mes faltante → promedio × (1+crec)     (method='estacional')
   *   · cuenta esporádica → sólo los meses con dato (no se inventa el resto)          («sin datos» ≠ cero)
   * Nunca pisa method='manual' salvo overwrite_manual.
   */
  async proposeExpensePlan(budgetId: string, dto: ProposeExpensePlanDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`Solo se propone el plan de gastos en un ejercicio en borrador/revisión (está '${b.status}').`);
      }
      const fy = Number(b.fiscal_year);
      const priorYear = fy - 1;
      const settings = await this.settingsRow(trx, tenantId, budgetId);
      const families = dto.families && dto.families.length ? this.normFamilies(dto.families) : settings.proposal_families;
      const bySucursal = dto.by_sucursal != null ? !!dto.by_sucursal : !!settings.by_sucursal;
      const def = dto.default_growth_pct != null ? Number(dto.default_growth_pct) : Number(settings.default_growth_pct) || 0;
      const growthByAccount: Record<string, number> = { ...(settings.growth_by_account || {}), ...(dto.growth_by_account || {}) };
      const growthFor = (acc: string) => (growthByAccount[acc] != null && Number.isFinite(Number(growthByAccount[acc])) ? Number(growthByAccount[acc]) : def);

      const rows = await this.netByAccountYearMonth(trx, tenantId, [priorYear], families, bySucursal);

      // agrupar por (account, sucursal): { month → monto }, nombre, familia
      type Grp = { account_name: string | null; familia: string; byMonth: Map<number, number> };
      const groups = new Map<string, Grp>();
      for (const r of rows) {
        if (!(r.monto > 0)) continue; // base neta positiva
        const key = `${r.account_code}|${r.sucursal}`;
        if (!groups.has(key)) groups.set(key, { account_name: r.account_name, familia: r.familia, byMonth: new Map() });
        const g = groups.get(key)!;
        g.byMonth.set(r.month, (g.byMonth.get(r.month) || 0) + r.monto);
      }

      const cov = { historico_ajustado: 0, estacional: 0, no_signal: 0, manual_kept: 0, accounts: groups.size };
      for (const [key, g] of groups) {
        const sep = key.indexOf('|');
        const accountCode = key.slice(0, sep);
        const sucursal = key.slice(sep + 1);
        const growth = growthFor(accountCode);
        const present = [...g.byMonth.values()].filter((v) => v > 0);
        const monthsPresent = present.length;
        const avg = monthsPresent ? present.reduce((a, c) => a + c, 0) / monthsPresent : 0;
        const recurrent = monthsPresent >= MIN_MONTHS_RECURRENT;

        for (let month = 1; month <= 12; month++) {
          const base = g.byMonth.get(month) || 0;
          const yym = ym(fy, month);
          const existing = await trx('budget.expense_plan_lines')
            .where({ tenant_id: tenantId, budget_id: budgetId, account_code: accountCode, sucursal, year_month: yym }).first();
          if (existing && existing.method === 'manual' && !dto.overwrite_manual) { cov.manual_kept++; continue; }

          let monto: number | null = null; let method: 'historico_ajustado' | 'estacional' | null = null; let baseAmount: number | null = null;
          if (base > 0) {
            monto = round2(base * (1 + growth)); method = 'historico_ajustado'; baseAmount = round2(base);
          } else if (recurrent && avg > 0) {
            monto = round2(avg * (1 + growth)); method = 'estacional'; baseAmount = round2(avg);
          }
          if (monto == null || method == null) { cov.no_signal++; continue; }

          await trx('budget.expense_plan_lines')
            .insert({
              tenant_id: tenantId, budget_id: budgetId, account_code: accountCode, account_name: g.account_name,
              familia: g.familia, sucursal, year_month: yym, monto, method, growth_pct: round4(growth), base_amount: baseAmount,
              created_by: username, updated_by: username,
            })
            .onConflict(['tenant_id', 'budget_id', 'account_code', 'sucursal', 'year_month'])
            .merge({ account_name: g.account_name, familia: g.familia, monto, method, growth_pct: round4(growth), base_amount: baseAmount, updated_by: username, updated_at: trx.fn.now() });
          cov[method]++;
        }
      }
      return { prior_year: priorYear, families, by_sucursal: bySucursal, growth_by_account: growthByAccount, default_growth_pct: def, coverage: cov };
    });
  }

  /** Captura/override manual de una línea (cuenta × sucursal × mes). */
  async upsertLine(budgetId: string, dto: UpsertExpensePlanLineDto, username: string) {
    if (!dto.account_code?.trim()) throw new BadRequestException('account_code es requerido');
    if (!/^\d{4}-\d{2}$/.test(String(dto.year_month || ''))) throw new BadRequestException('year_month inválido (YYYY-MM)');
    if (!(Number(dto.monto) >= 0)) throw new BadRequestException('monto debe ser >= 0');
    const tenantId = this.tenantCtx.requireTenantId();
    const monto = round2(dto.monto);
    const sucursal = String(dto.sucursal ?? '');
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`Solo se edita el plan de gastos en un ejercicio en borrador/revisión (está '${b.status}').`);
      }
      const [row] = await trx('budget.expense_plan_lines')
        .insert({
          tenant_id: tenantId, budget_id: budgetId, account_code: dto.account_code.trim(), account_name: dto.account_name ?? null,
          sucursal, year_month: dto.year_month, monto, method: 'manual', notes: dto.notes ?? null,
          created_by: username, updated_by: username,
        })
        .onConflict(['tenant_id', 'budget_id', 'account_code', 'sucursal', 'year_month'])
        .merge({ account_name: dto.account_name ?? null, monto, method: 'manual', notes: dto.notes ?? null, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  async deleteLine(budgetId: string, accountCode: string, sucursal: string, yearMonth: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const n = await trx('budget.expense_plan_lines')
        .where({ tenant_id: tenantId, budget_id: budgetId, account_code: accountCode, sucursal: sucursal ?? '', year_month: yearMonth })
        .del();
      if (!n) throw new NotFoundException('Línea del plan de gastos no encontrada');
      return { deleted: n };
    });
  }
}
