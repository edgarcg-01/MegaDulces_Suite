import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PU.5 — Presupuestos: Marketing (campañas) (ADR-066, spec §9/§6/§10).
 *
 * Una campaña es una DIMENSIÓN sobre las partidas (reusa el ledger de PU.1): sus partidas se etiquetan
 * con `campaign_id` y su gasto real = el ejercido de esas partidas. La EVALUACIÓN es honesta:
 *   - «ventas vinculadas» se sacan de `analytics.sales_daily` por la VENTANA de la campaña, y se
 *     DECLARA la regla de atribución — las ventas vinculadas NO prueban efecto incremental (spec §6/§10).
 *   - El «retorno» solo se calcula si se entrega un `margen_incremental` explícito y costo > 0 (spec §10).
 *   - Las aportaciones de proveedor NO reducen el gasto salvo las CONFIRMADAS/APLICADAS (spec §9).
 *   - Un `descuento_comercial` puede estar YA en ventas netas → se marca, no se dobla (spec §9).
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? round2((num / den) * 100) : null);

export interface CreateCampaignDto {
  name: string;
  objective?: string | null;
  responsible?: string | null;
  campaign_type?: 'publicidad' | 'materiales' | 'eventos' | 'promociones' | 'descuento_comercial' | 'otro';
  channels?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  planned_budget?: number;
  evaluation_method?: string | null;
  attribution_rule?: string | null;
  notes?: string | null;
}
export interface ContributionDto { supplier: string; amount: number; condition?: string | null; status?: 'incierta' | 'confirmada' | 'aplicada'; evidence?: string | null }

@Injectable()
export class BudgetCampaignsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async create(dto: CreateCampaignDto, username: string) {
    if (!dto.name?.trim()) throw new BadRequestException('name es requerido');
    if (dto.start_date && dto.end_date && dto.end_date < dto.start_date) throw new BadRequestException('end_date no puede ser anterior a start_date');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('budget.campaigns').insert({
        tenant_id: tenantId, name: dto.name.trim(), objective: dto.objective ?? null, responsible: dto.responsible ?? null,
        campaign_type: dto.campaign_type ?? 'publicidad', channels: dto.channels ?? null,
        start_date: dto.start_date ?? null, end_date: dto.end_date ?? null,
        planned_budget: dto.planned_budget ?? 0, evaluation_method: dto.evaluation_method ?? null,
        attribution_rule: dto.attribution_rule ?? null, notes: dto.notes ?? null, created_by: username,
      }).returning('*');
      return row;
    });
  }

  async list() {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('budget.campaigns').orderBy('created_at', 'desc'));
  }

  async get(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('budget.campaigns').where({ id }).first());
    if (!row) throw new NotFoundException('Campaña no encontrada');
    return row;
  }

  async setStatus(id: string, status: 'borrador' | 'activa' | 'cerrada', username: string) {
    if (!['borrador', 'activa', 'cerrada'].includes(status)) throw new BadRequestException('status inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('budget.campaigns').where({ tenant_id: tenantId, id })
        .update({ status, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new NotFoundException('Campaña no encontrada');
      return row;
    });
  }

  /** Etiqueta una partida con la campaña (o la desliga con campaignId=null). */
  async linkLine(lineId: string, campaignId: string | null, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (campaignId) {
        const c = await trx('budget.campaigns').where({ tenant_id: tenantId, id: campaignId }).first();
        if (!c) throw new NotFoundException('Campaña no encontrada');
      }
      const [row] = await trx('budget.budget_lines').where({ tenant_id: tenantId, id: lineId })
        .update({ campaign_id: campaignId, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new NotFoundException('Partida no encontrada');
      return row;
    });
  }

  // ── Aportaciones de proveedor ────────────────────────────────────────────────────────────
  async addContribution(campaignId: string, dto: ContributionDto, username: string) {
    if (!dto.supplier?.trim()) throw new BadRequestException('supplier es requerido');
    if (!(Number(dto.amount) > 0)) throw new BadRequestException('amount debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('budget.campaigns').where({ tenant_id: tenantId, id: campaignId }).first();
      if (!c) throw new NotFoundException('Campaña no encontrada');
      const [row] = await trx('budget.campaign_contributions').insert({
        tenant_id: tenantId, campaign_id: campaignId, supplier: dto.supplier.trim(), amount: dto.amount,
        condition: dto.condition ?? null, status: dto.status ?? 'incierta', evidence: dto.evidence ?? null, created_by: username,
      }).returning('*');
      return row;
    });
  }

  async listContributions(campaignId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('budget.campaign_contributions').where({ campaign_id: campaignId }).orderBy('created_at', 'desc'));
  }

  async setContributionStatus(contribId: string, status: 'incierta' | 'confirmada' | 'aplicada', username: string) {
    if (!['incierta', 'confirmada', 'aplicada'].includes(status)) throw new BadRequestException('status inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('budget.campaign_contributions').where({ tenant_id: tenantId, id: contribId })
        .update({ status, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new NotFoundException('Aportación no encontrada');
      return row;
    });
  }

  // ── Evaluación (costo vs resultado) — honesta ─────────────────────────────────────────────
  async evaluate(campaignId: string, opts: { margen_incremental?: number } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('budget.campaigns').where({ tenant_id: tenantId, id: campaignId }).first();
      if (!c) throw new NotFoundException('Campaña no encontrada');

      // Costo = ejercido de las partidas etiquetadas (reusa el ledger).
      const [lineAgg] = await trx('budget.budget_lines').where({ tenant_id: tenantId, campaign_id: campaignId })
        .select(trx.raw('count(*)::int AS n'), trx.raw('coalesce(sum(vigente_amount),0) AS presupuesto'), trx.raw('coalesce(sum(exercised_amount),0) AS ejercido'));
      const costo = round2(Number(lineAgg.ejercido));
      const esDescuento = c.campaign_type === 'descuento_comercial';

      // Aportaciones: solo las CONFIRMADAS/APLICADAS reducen; las inciertas se muestran aparte.
      const contribs = await trx('budget.campaign_contributions').where({ tenant_id: tenantId, campaign_id: campaignId });
      const sum = (st: string[]) => round2(contribs.filter((x: any) => st.includes(x.status)).reduce((s: number, x: any) => s + Number(x.amount), 0));
      const aport_confirmada = sum(['confirmada', 'aplicada']);
      const aport_incierta = sum(['incierta']);
      const costo_neto = round2(costo - aport_confirmada);

      // Ventas vinculadas: por la VENTANA de la campaña (atribución declarada, NO prueba incremental).
      let ventas: { available: boolean; monto: number | null; as_of: string | null; source: string; attribution: string; reason?: string };
      if (c.start_date && c.end_date) {
        const [s] = await trx('analytics.sales_daily').where({ tenant_id: tenantId })
          .whereBetween('sale_date', [this.dOnly(c.start_date), this.dOnly(c.end_date)])
          .select(trx.raw('count(*)::int AS n'), trx.raw('coalesce(sum(revenue),0) AS ventas'), trx.raw('max(updated_at) AS as_of'));
        ventas = Number(s.n) > 0
          ? { available: true, monto: round2(Number(s.ventas)), as_of: s.as_of, source: 'analytics.sales_daily', attribution: 'ventana temporal de la campaña (NO prueba efecto incremental)' }
          : { available: false, monto: null, as_of: null, source: 'analytics.sales_daily', attribution: 'ventana temporal', reason: 'Sin ventas en la ventana' };
      } else {
        ventas = { available: false, monto: null, as_of: null, source: 'analytics.sales_daily', attribution: 'n/a', reason: 'La campaña no tiene vigencia (start/end) para atribuir ventas' };
      }

      // Retorno SOLO con margen incremental explícito (spec §10). Si no, se declara.
      const tieneMargen = opts.margen_incremental != null && Number.isFinite(Number(opts.margen_incremental));
      const retorno = tieneMargen && costo > 0
        ? { available: true, roi_pct: round2(((Number(opts.margen_incremental) - costo) / costo) * 100), basis: 'margen incremental EXPLÍCITO provisto' }
        : { available: false, roi_pct: null, reason: costo <= 0 ? 'costo = 0' : 'Requiere margen_incremental explícito (una regla de atribución), no se infiere de ventas vinculadas' };

      return {
        campaign: { id: c.id, name: c.name, campaign_type: c.campaign_type, status: c.status, start_date: c.start_date, end_date: c.end_date, attribution_rule: c.attribution_rule },
        partidas: Number(lineAgg.n),
        presupuesto: round2(Number(lineAgg.presupuesto)),
        costo,
        costo_neto_aportacion: costo_neto,
        aportaciones: { confirmada: aport_confirmada, incierta: aport_incierta, nota: 'La incierta NO reduce el gasto (spec §9).' },
        ventas_vinculadas: ventas,
        intensidad_gasto_ventas_pct: ventas.available ? pct(costo, ventas.monto as number) : null, // gasto/ventas (§10: intensidad, NO retorno)
        retorno,
        warnings: esDescuento ? ['Tipo descuento_comercial: su costo puede estar YA deducido en ventas netas — no sumar otra vez como gasto (spec §9).'] : [],
      };
    });
  }

  private dOnly(d: any): string { return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10); }
}
