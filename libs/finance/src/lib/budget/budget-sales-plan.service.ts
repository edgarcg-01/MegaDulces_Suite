import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PV.3 — Presupuesto de Ventas: captura de la meta (ADR-066 / PV).
 *
 * La meta vive en Presupuestos al grano del molde del Excel: ENTIDAD (`v_sales_entity`) ×
 * PERIODO 13×4 (`v_retail_calendar`). ÚNICA verdad de la meta = `budget.sales_plan_lines`
 * (no se duplica en `budget_lines`; la UI la presenta como la sección de ingresos del ejercicio).
 *
 * Captura (spec §4):
 *   · generateFromHistory: meta = real del AÑO ANTERIOR (del ODS, rolado por PV.1/PV.2) × (1+growth).
 *     Sin real del año anterior → NO se crea fila («sin datos» ≠ cero): la UI la deja para captura manual.
 *   · upsertLine: captura/override manual.
 *
 * El "real" NUNCA se recalcula acá — se lee de `analytics.v_sellout_daily` por el calendario.
 */

export interface GenerateFromHistoryDto {
  /** crecimiento objetivo, p.ej. 0.10 = +10% sobre el real del año anterior. */
  growth_pct: number;
  /** limitar a ciertas entidades (entity_key); por defecto todas las que tengan base. */
  entity_keys?: string[];
  /** sobrescribir filas manuales existentes (por defecto NO se pisan). */
  overwrite_manual?: boolean;
}

export interface UpsertSalesPlanLineDto {
  entity_key: string;
  period_no: number;
  meta_amount: number;
  notes?: string | null;
}

export interface ProposePlanDto {
  /** crecimiento objetivo por canal (fracción), p.ej. { credito: 0.10, ruta: 0.12 }. */
  growth_by_channel?: Record<string, number>;
  /** crecimiento de respaldo (fracción) para canales sin objetivo explícito. */
  default_growth_pct?: number;
  /** 'hibrido' = base×crec + PART/estacionalidad; 'historico' = solo base×crec (plano). */
  proposal_method?: 'hibrido' | 'historico';
  /** sobrescribir filas capturadas a mano (por defecto NO). */
  overwrite_manual?: boolean;
}

export interface UpsertSalesPlanSettingsDto {
  proposal_method?: 'hibrido' | 'historico';
  default_growth_pct?: number;
  growth_by_channel?: Record<string, number>;
}

/** Canales canónicos del sell-out (taxonomía del proyecto). */
const CHANNELS = ['mostrador', 'credito', 'ruta', 'preventa'] as const;
/** shrinkage de la estacionalidad de entidad hacia canal/global (n/(n+K)). */
const SEASON_SHRINK_K = 4;
/** periodos apareados mínimos para confiar en un YoY (menos = tendencia no confiable → default).
 *  Protege la rampa: con un año anterior parcial, un YoY sobre 1-2 periodos da números absurdos. */
const MIN_PAIRED_PERIODS = 4;

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

@Injectable()
export class BudgetSalesPlanService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Catálogo de entidades de venta (eje columnas del molde). */
  async getEntities() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('analytics.v_sales_entity')
        .where({ tenant_id: tenantId })
        .orderBy([{ column: 'channel', order: 'asc' }, { column: 'warehouse_code', order: 'asc' }]),
    );
  }

  /** Plan de ventas de un ejercicio: cabecera + entidades + líneas capturadas (entidad × periodo). */
  async getPlan(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!budget) throw new NotFoundException('Presupuesto no encontrado');
      const entities = await trx('analytics.v_sales_entity')
        .where({ tenant_id: tenantId })
        .orderBy([{ column: 'channel', order: 'asc' }, { column: 'warehouse_code', order: 'asc' }]);
      const lines = await trx('budget.sales_plan_lines')
        .where({ tenant_id: tenantId, budget_id: budgetId })
        .orderBy([{ column: 'entity_key', order: 'asc' }, { column: 'period_no', order: 'asc' }]);
      return { budget, entities, lines };
    });
  }

  /** Real del AÑO ANTERIOR rolado a entidad × periodo (del ODS, por el calendario 13×4). */
  private async priorYearRealByEntityPeriod(trx: import('knex').Knex, tenantId: string, priorYear: number) {
    const rows = await trx('analytics.v_sellout_daily as sd')
      .join('analytics.v_retail_calendar as cal', function () {
        this.on('cal.date', '=', 'sd.business_date');
      })
      .join('analytics.v_sales_entity as se', function () {
        this.on('se.tenant_id', '=', 'sd.tenant_id')
          .andOn('se.channel', '=', 'sd.channel')
          .andOn('se.warehouse_code', '=', 'sd.warehouse_code');
      })
      .where('sd.tenant_id', tenantId)
      .andWhere('cal.fiscal_year', priorYear)
      .groupBy('se.entity_key', 'cal.period_no')
      .select('se.entity_key', 'cal.period_no')
      .sum({ real_monto: 'sd.monto' }) as unknown as Array<{ entity_key: string; period_no: number | string; real_monto: number | string | null }>;
    // mapa entity_key → { period_no → real_monto }
    const map = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const ek = r.entity_key as string;
      const pn = Number(r.period_no);
      const v = Number(r.real_monto) || 0;
      if (!map.has(ek)) map.set(ek, new Map());
      map.get(ek)!.set(pn, v);
    }
    return map;
  }

  /** Generar meta = real año anterior × (1+growth). Sin base → NO se crea fila (sin datos ≠ cero). */
  async generateFromHistory(budgetId: string, dto: GenerateFromHistoryDto, username: string) {
    const growth = Number(dto.growth_pct);
    if (!Number.isFinite(growth) || growth < -1) throw new BadRequestException('growth_pct inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    const only = dto.entity_keys && dto.entity_keys.length ? new Set(dto.entity_keys) : null;

    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`Solo se puede generar el plan en un ejercicio en borrador/revisión (está '${b.status}').`);
      }
      const priorYear = Number(b.fiscal_year) - 1;
      const real = await this.priorYearRealByEntityPeriod(trx, tenantId, priorYear);

      let generated = 0;
      let entitiesWithBase = 0;
      for (const [entityKey, byPeriod] of real.entries()) {
        if (only && !only.has(entityKey)) continue;
        let any = false;
        for (const [periodNo, base] of byPeriod.entries()) {
          if (!(base > 0)) continue; // sin base real → no se fabrica meta
          const meta = round2(base * (1 + growth));
          // por defecto NO pisar filas capturadas a mano
          const existing = await trx('budget.sales_plan_lines')
            .where({ tenant_id: tenantId, budget_id: budgetId, entity_key: entityKey, period_no: periodNo })
            .first();
          if (existing && existing.method === 'manual' && !dto.overwrite_manual) continue;
          await trx('budget.sales_plan_lines')
            .insert({
              tenant_id: tenantId, budget_id: budgetId, entity_key: entityKey, period_no: periodNo,
              meta_amount: meta, method: 'historico_ajustado', growth_pct: growth, base_amount: round2(base),
              created_by: username, updated_by: username,
            })
            .onConflict(['tenant_id', 'budget_id', 'entity_key', 'period_no'])
            .merge({ meta_amount: meta, method: 'historico_ajustado', growth_pct: growth, base_amount: round2(base), updated_by: username, updated_at: trx.fn.now() });
          generated++;
          any = true;
        }
        if (any) entitiesWithBase++;
      }
      return { generated, entities_with_base: entitiesWithBase, prior_year: priorYear, growth_pct: growth };
    });
  }

  /** Captura/override manual de una celda entidad × periodo. */
  async upsertLine(budgetId: string, dto: UpsertSalesPlanLineDto, username: string) {
    const periodNo = Number(dto.period_no);
    if (!(periodNo >= 1 && periodNo <= 13)) throw new BadRequestException('period_no debe ser 1..13');
    if (!(Number(dto.meta_amount) >= 0)) throw new BadRequestException('meta_amount debe ser >= 0');
    if (!dto.entity_key?.trim()) throw new BadRequestException('entity_key es requerido');
    const tenantId = this.tenantCtx.requireTenantId();
    const meta = round2(dto.meta_amount);

    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`Solo se edita el plan en un ejercicio en borrador/revisión (está '${b.status}').`);
      }
      // la entidad debe existir en el catálogo canónico
      const ent = await trx('analytics.v_sales_entity').where({ tenant_id: tenantId, entity_key: dto.entity_key }).first();
      if (!ent) throw new BadRequestException(`entity_key desconocido: ${dto.entity_key}`);

      const [row] = await trx('budget.sales_plan_lines')
        .insert({
          tenant_id: tenantId, budget_id: budgetId, entity_key: dto.entity_key, period_no: periodNo,
          meta_amount: meta, method: 'manual', notes: dto.notes ?? null,
          created_by: username, updated_by: username,
        })
        .onConflict(['tenant_id', 'budget_id', 'entity_key', 'period_no'])
        .merge({ meta_amount: meta, method: 'manual', notes: dto.notes ?? null, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  async deleteLine(budgetId: string, entityKey: string, periodNo: number) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const n = await trx('budget.sales_plan_lines')
        .where({ tenant_id: tenantId, budget_id: budgetId, entity_key: entityKey, period_no: periodNo })
        .del();
      if (!n) throw new NotFoundException('Línea del plan no encontrada');
      return { deleted: n };
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Fase PVA — Automatización: el sistema PROPONE (crecimiento del histórico + relleno híbrido);
  // el humano solo ajusta. «Sin datos» ≠ cero (escalera de fallback, cobertura declarada).
  // ════════════════════════════════════════════════════════════════════════════════════════════

  /** Real por entidad × año × periodo (del ODS por el calendario 13×4), para N años. */
  private async realByEntityYearPeriod(trx: import('knex').Knex, tenantId: string, years: number[]) {
    if (!years.length) return [] as Array<{ entity_key: string; channel: string; year: number; period: number; monto: number }>;
    const rows = await trx('analytics.v_sellout_daily as sd')
      .join('analytics.v_retail_calendar as cal', 'cal.date', 'sd.business_date')
      .join('analytics.v_sales_entity as se', function () {
        this.on('se.tenant_id', '=', 'sd.tenant_id')
          .andOn('se.channel', '=', 'sd.channel')
          .andOn('se.warehouse_code', '=', 'sd.warehouse_code');
      })
      .where('sd.tenant_id', tenantId)
      .whereIn('cal.fiscal_year', years)
      .groupBy('se.entity_key', 'se.channel', 'cal.fiscal_year', 'cal.period_no')
      .select('se.entity_key', 'se.channel', 'cal.fiscal_year', 'cal.period_no')
      .sum({ real_monto: 'sd.monto' }) as unknown as Array<{ entity_key: string; channel: string; fiscal_year: number | string; period_no: number | string; real_monto: number | string | null }>;
    return rows.map((r) => ({ entity_key: r.entity_key, channel: r.channel, year: Number(r.fiscal_year), period: Number(r.period_no), monto: Number(r.real_monto) || 0 }));
  }

  /** Años fiscales con real en el sell-out, anteriores a `fy`. */
  private async yearsWithRealBefore(trx: import('knex').Knex, tenantId: string, fy: number): Promise<number[]> {
    const rows = await trx('analytics.v_sellout_daily as sd')
      .join('analytics.v_retail_calendar as cal', 'cal.date', 'sd.business_date')
      .where('sd.tenant_id', tenantId)
      .andWhere('cal.fiscal_year', '<', fy)
      .distinct('cal.fiscal_year') as unknown as Array<{ fiscal_year: number | string }>;
    return rows.map((r) => Number(r.fiscal_year)).sort((a, b) => a - b);
  }

  /**
   * Propone el crecimiento (CREC) por canal desde la tendencia histórica (YoY del par de años más reciente,
   * sobre periodos APAREADOS). Escalera de fallback: canal → global → default. Declara la cobertura.
   */
  async proposeGrowth(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      const fy = Number(b.fiscal_year);
      const years = await this.yearsWithRealBefore(trx, tenantId, fy);
      const settings = await this.getSettings(budgetId);
      const def = Number(settings.default_growth_pct) || 0;

      const empty = { by_channel: {} as Record<string, { growth_pct: number; basis: string; paired_periods: number; years_used: number[] }>, global: { growth_pct: def, basis: 'default', paired_periods: 0 }, years_available: years, fiscal_year: fy };
      if (years.length < 2) {
        for (const ch of CHANNELS) empty.by_channel[ch] = { growth_pct: def, basis: 'default', paired_periods: 0, years_used: [] };
        return empty; // sin par de años → todo default, declarado
      }
      const y1 = years[years.length - 1];
      const y0 = years[years.length - 2];
      const rows = await this.realByEntityYearPeriod(trx, tenantId, [y0, y1]);

      // yoy(channelFilter): crecimiento sobre periodos con real en AMBOS años
      const yoy = (pred: (channel: string) => boolean) => {
        const byPeriod = new Map<number, { a: number; b: number }>(); // a=y0, b=y1
        for (const r of rows) {
          if (!pred(r.channel)) continue;
          const e = byPeriod.get(r.period) || { a: 0, b: 0 };
          if (r.year === y0) e.a += r.monto; else if (r.year === y1) e.b += r.monto;
          byPeriod.set(r.period, e);
        }
        let a = 0, bb = 0, paired = 0;
        for (const [, e] of byPeriod) { if (e.a > 0 && e.b > 0) { a += e.a; bb += e.b; paired++; } }
        // YoY sólo confiable con suficientes periodos apareados (rampa: año anterior parcial → no confiar)
        return paired >= MIN_PAIRED_PERIODS && a > 0 ? { growth_pct: round4((bb - a) / a), paired } : null;
      };

      const g = yoy(() => true);
      const global = g ? { growth_pct: g.growth_pct, basis: 'yoy_paired' as const, paired_periods: g.paired } : { growth_pct: def, basis: 'default' as const, paired_periods: 0 };
      const by_channel: Record<string, { growth_pct: number; basis: string; paired_periods: number; years_used: number[] }> = {};
      for (const ch of CHANNELS) {
        const c = yoy((x) => x === ch);
        if (c) by_channel[ch] = { growth_pct: c.growth_pct, basis: 'yoy_paired', paired_periods: c.paired, years_used: [y0, y1] };
        else if (global.basis === 'yoy_paired') by_channel[ch] = { growth_pct: global.growth_pct, basis: 'global', paired_periods: global.paired_periods, years_used: [y0, y1] };
        else by_channel[ch] = { growth_pct: def, basis: 'default', paired_periods: 0, years_used: [] };
      }
      return { by_channel, global, years_available: years, fiscal_year: fy, min_paired_periods: MIN_PAIRED_PERIODS };
    });
  }

  /** Índice estacional por entidad (13 periodos, suma 1) con fallback jerárquico entidad→canal→global. */
  private seasonalIndexByEntity(realY1: Array<{ entity_key: string; channel: string; period: number; monto: number }>) {
    const P = 13;
    const entityByPeriod = new Map<string, number[]>();       // entity → [13]
    const entityChannel = new Map<string, string>();
    const channelByPeriod = new Map<string, number[]>();      // channel → [13]
    const globalByPeriod = new Array(P).fill(0);
    for (const r of realY1) {
      if (!entityByPeriod.has(r.entity_key)) entityByPeriod.set(r.entity_key, new Array(P).fill(0));
      entityByPeriod.get(r.entity_key)![r.period - 1] += r.monto;
      entityChannel.set(r.entity_key, r.channel);
      if (!channelByPeriod.has(r.channel)) channelByPeriod.set(r.channel, new Array(P).fill(0));
      channelByPeriod.get(r.channel)![r.period - 1] += r.monto;
      globalByPeriod[r.period - 1] += r.monto;
    }
    const norm = (arr: number[]) => { const s = arr.reduce((a, b) => a + b, 0); return s > 0 ? arr.map((x) => x / s) : new Array(P).fill(0); };
    const globalShare = norm(globalByPeriod);
    const idx = new Map<string, number[]>();
    for (const [ek, arr] of entityByPeriod) {
      const ch = entityChannel.get(ek)!;
      const nE = arr.filter((x) => x > 0).length;                         // periodos con dato de la entidad
      const entShare = norm(arr);
      const chArr = channelByPeriod.get(ch);
      const fallback = chArr && chArr.some((x) => x > 0) ? norm(chArr) : globalShare;
      // shrinkage: mezcla entidad→fallback ponderada por cuánta historia tiene la entidad
      const blended = entShare.map((v, i) => (nE * v + SEASON_SHRINK_K * fallback[i]) / (nE + SEASON_SHRINK_K));
      idx.set(ek, norm(blended)); // renormaliza a suma 1
    }
    return idx;
  }

  /**
   * Propone el plan COMPLETO (299 celdas) desde la historia (relleno híbrido):
   *   · celda con base real del año anterior → meta = base × (1+crec[canal])          (method='historico_ajustado')
   *   · celda sin base, entidad con historia anual → meta = anual_proyectado × estacionalidad  (method='estacional')
   *   · sin ninguna señal → NO crea fila (se declara en la cobertura)                  («sin datos» ≠ cero)
   * Nunca pisa method='manual' salvo overwrite_manual.
   */
  async proposePlan(budgetId: string, dto: ProposePlanDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`Solo se propone el plan en un ejercicio en borrador/revisión (está '${b.status}').`);
      }
      const fy = Number(b.fiscal_year);
      const priorYear = fy - 1;

      // supuestos: dto pisa settings; settings degrada a defaults
      const settings = await this.getSettings(budgetId);
      const method = dto.proposal_method ?? settings.proposal_method ?? 'hibrido';
      const def = dto.default_growth_pct != null ? Number(dto.default_growth_pct) : Number(settings.default_growth_pct) || 0;
      const growthByChannel: Record<string, number> = { ...(settings.growth_by_channel || {}), ...(dto.growth_by_channel || {}) };
      const growthFor = (ch: string) => (growthByChannel[ch] != null && Number.isFinite(Number(growthByChannel[ch])) ? Number(growthByChannel[ch]) : def);

      // real del año anterior por entidad×periodo + catálogo de entidades
      const realY1 = await this.realByEntityYearPeriod(trx, tenantId, [priorYear]);
      const entities = await trx('analytics.v_sales_entity').where({ tenant_id: tenantId });
      const realMap = new Map<string, Map<number, number>>();
      const entityAnnual = new Map<string, number>();
      for (const r of realY1) {
        if (!realMap.has(r.entity_key)) realMap.set(r.entity_key, new Map());
        realMap.get(r.entity_key)!.set(r.period, r.monto);
        entityAnnual.set(r.entity_key, (entityAnnual.get(r.entity_key) || 0) + r.monto);
      }
      const seasIdx = method === 'hibrido' ? this.seasonalIndexByEntity(realY1) : new Map<string, number[]>();

      const cov = { historico_ajustado: 0, estacional: 0, no_signal: 0, manual_kept: 0 };
      for (const e of entities) {
        const ek = e.entity_key as string;
        const ch = e.channel as string;
        const growth = growthFor(ch);
        const annualBase = entityAnnual.get(ek) || 0;
        const projectedAnnual = annualBase * (1 + growth);
        const byPeriod = realMap.get(ek);
        const idx = seasIdx.get(ek);
        for (let period = 1; period <= 13; period++) {
          const base = byPeriod?.get(period) || 0;
          // respetar captura manual
          const existing = await trx('budget.sales_plan_lines')
            .where({ tenant_id: tenantId, budget_id: budgetId, entity_key: ek, period_no: period }).first();
          if (existing && existing.method === 'manual' && !dto.overwrite_manual) { cov.manual_kept++; continue; }

          let meta: number | null = null;
          let rowMethod: 'historico_ajustado' | 'estacional' | null = null;
          let baseAmount: number | null = null;
          if (base > 0) {
            meta = round2(base * (1 + growth)); rowMethod = 'historico_ajustado'; baseAmount = round2(base);
          } else if (method === 'hibrido' && projectedAnnual > 0 && idx) {
            const share = idx[period - 1] || 0;
            const m = round2(projectedAnnual * share);
            if (m > 0) { meta = m; rowMethod = 'estacional'; baseAmount = null; }
          }
          if (meta == null || rowMethod == null) { cov.no_signal++; continue; }

          await trx('budget.sales_plan_lines')
            .insert({
              tenant_id: tenantId, budget_id: budgetId, entity_key: ek, period_no: period,
              meta_amount: meta, method: rowMethod, growth_pct: round4(growth), base_amount: baseAmount,
              created_by: username, updated_by: username,
            })
            .onConflict(['tenant_id', 'budget_id', 'entity_key', 'period_no'])
            .merge({ meta_amount: meta, method: rowMethod, growth_pct: round4(growth), base_amount: baseAmount, updated_by: username, updated_at: trx.fn.now() });
          cov[rowMethod]++;
        }
      }
      return { prior_year: priorYear, method, growth_by_channel: growthByChannel, default_growth_pct: def, coverage: cov, total_cells: entities.length * 13 };
    });
  }

  // ── Supuestos anuales (la perilla del humano) ──
  async getSettings(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('budget.sales_plan_settings').where({ tenant_id: tenantId, budget_id: budgetId }).first());
    if (!row) return { budget_id: budgetId, proposal_method: 'hibrido' as const, default_growth_pct: 0, growth_by_channel: {} as Record<string, number>, exists: false };
    return { ...row, growth_by_channel: row.growth_by_channel || {}, exists: true };
  }

  async upsertSettings(budgetId: string, dto: UpsertSalesPlanSettingsDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (dto.proposal_method && !['hibrido', 'historico'].includes(dto.proposal_method)) throw new BadRequestException('proposal_method inválido');
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      const patch: Record<string, unknown> = { updated_by: username, updated_at: trx.fn.now() };
      if (dto.proposal_method != null) patch.proposal_method = dto.proposal_method;
      if (dto.default_growth_pct != null) patch.default_growth_pct = round4(Number(dto.default_growth_pct));
      if (dto.growth_by_channel != null) patch.growth_by_channel = JSON.stringify(dto.growth_by_channel);
      const [row] = await trx('budget.sales_plan_settings')
        .insert({
          tenant_id: tenantId, budget_id: budgetId,
          proposal_method: dto.proposal_method ?? 'hibrido',
          default_growth_pct: dto.default_growth_pct != null ? round4(Number(dto.default_growth_pct)) : 0,
          growth_by_channel: JSON.stringify(dto.growth_by_channel ?? {}),
          created_by: username, updated_by: username,
        })
        .onConflict(['tenant_id', 'budget_id'])
        .merge(patch)
        .returning('*');
      return { ...row, growth_by_channel: row.growth_by_channel || {} };
    });
  }
}
