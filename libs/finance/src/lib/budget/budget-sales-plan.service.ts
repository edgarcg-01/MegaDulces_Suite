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

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
}
