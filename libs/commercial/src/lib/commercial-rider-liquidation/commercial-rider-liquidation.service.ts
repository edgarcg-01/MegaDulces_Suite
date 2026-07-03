import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  CloseLiquidationDto,
  MXN_DENOMINATIONS,
  OpenLiquidationDto,
} from './dto/rider-liquidation.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CENT = 0.005;

/**
 * Fase LM.5 — corte de caja del repartidor (§11–12 del SOP).
 *
 * El corte se COMPUTA desde `commercial.payments` (received_by = repartidor + día),
 * no acopla el cobro: cash_expected/card/transfer salen de los pagos del día.
 * Al cerrar, el encargado captura el ARQUEO por denominación (cash_breakdown);
 * cash_counted se deriva de la suma y cash_difference = counted − expected (meta 0).
 * Los pagos del día se estampan con liquidation_id (audit del corte).
 *
 * Distinto de logistics.liquidations (nómina/comisiones). Sucursal = branch_store_id.
 */
@Injectable()
export class CommercialRiderLiquidationService {
  private readonly logger = new Logger(CommercialRiderLiquidationService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private requireUserId(): string {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Usuario no identificado en el contexto');
    return userId;
  }

  private async nextFolio(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();
    const [{ current_value }] = (
      await trx.raw(
        `INSERT INTO commercial.rider_liquidation_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.rider_liquidation_sequences.current_value + 1,
               updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      )
    ).rows;
    return `LIQ-${year}-${String(current_value).padStart(5, '0')}`;
  }

  /** Abre (o devuelve) el corte del día para el repartidor. */
  async open(dto: OpenLiquidationDto) {
    if (!UUID_RE.test(dto?.rider_user_id || '')) throw new BadRequestException('rider_user_id inválido');
    if (!DATE_RE.test(dto?.business_date || '')) throw new BadRequestException('business_date debe ser YYYY-MM-DD');
    if (dto.branch_store_id && !UUID_RE.test(dto.branch_store_id))
      throw new BadRequestException('branch_store_id inválido');

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.rider_liquidations')
        .where({ rider_user_id: dto.rider_user_id, business_date: dto.business_date })
        .whereNull('deleted_at')
        .first();
      if (existing) return existing;

      const folio = await this.nextFolio(trx);
      const userId = this.requireUserId();
      const [row] = await trx('commercial.rider_liquidations')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          rider_user_id: dto.rider_user_id,
          branch_store_id: dto.branch_store_id || null,
          business_date: dto.business_date,
          folio,
          status: 'open',
          created_by: userId,
        })
        .returning('*');
      return row;
    });
  }

  /**
   * Computa los totales del día del repartidor desde los pagos + incidencias.
   * No persiste: sirve para preview antes del arqueo y para el cierre.
   */
  private async computeTotals(trx: any, riderUserId: string, businessDate: string) {
    const pays = await trx('commercial.payments')
      .whereRaw('received_at::date = ?', [businessDate])
      .andWhere({ received_by: riderUserId })
      .whereNot({ status: 'reversed' })
      .whereNull('deleted_at')
      .select('payment_method', 'amount', 'order_id', 'kepler_folio');

    let cash = 0;
    let card = 0;
    let transfer = 0;
    const deliveries = new Set<string>(); // cuenta pedidos commercial O folios Kepler
    for (const p of pays) {
      const amt = Number(p.amount) || 0;
      if (p.payment_method === 'cash') cash += amt;
      else if (p.payment_method === 'card') card += amt;
      else if (p.payment_method === 'transfer') transfer += amt;
      const key = p.order_id || (p.kepler_folio ? `k:${p.kepler_folio}` : null);
      if (key) deliveries.add(key);
    }

    // Incidencias del día en las guías del repartidor (join drivers.user_id).
    const [{ incidents }] = await trx('logistics.guide_recipients as r')
      .join('logistics.delivery_guides as g', 'g.id', 'r.guide_id')
      .join('logistics.drivers as d', 'd.id', 'g.driver_id')
      .where('d.user_id', riderUserId)
      .whereNotNull('r.incident_type')
      .whereRaw('COALESCE(r.attempted_at, r.updated_at)::date = ?', [businessDate])
      .count({ incidents: 'r.id' });

    return {
      cash_expected: Math.round(cash * 100) / 100,
      card_total: Math.round(card * 100) / 100,
      transfer_total: Math.round(transfer * 100) / 100,
      deliveries_count: deliveries.size,
      incidents_count: Number(incidents) || 0,
    };
  }

  /** Preview del corte (totales computados) sin cerrar. */
  async preview(liquidationId: string) {
    if (!UUID_RE.test(liquidationId)) throw new BadRequestException('liquidationId inválido');
    return this.tk.run(async (trx) => {
      const liq = await trx('commercial.rider_liquidations').where({ id: liquidationId }).first();
      if (!liq) throw new NotFoundException('Corte no encontrado');
      const totals = await this.computeTotals(trx, liq.rider_user_id, liq.business_date);
      return { ...liq, ...totals };
    });
  }

  /** Suma del arqueo por denominación → efectivo contado. */
  private countedFromBreakdown(breakdown: Record<string, number>): number {
    let total = 0;
    for (const [denom, count] of Object.entries(breakdown || {})) {
      const d = Number(denom);
      const c = Number(count);
      if (!MXN_DENOMINATIONS.includes(d))
        throw new BadRequestException(`Denominación inválida: ${denom}`);
      if (!Number.isInteger(c) || c < 0)
        throw new BadRequestException(`Conteo inválido para ${denom}: ${count}`);
      total += d * c;
    }
    return Math.round(total * 100) / 100;
  }

  /** Cierra el corte con el arqueo del encargado. */
  async close(liquidationId: string, dto: CloseLiquidationDto) {
    if (!UUID_RE.test(liquidationId)) throw new BadRequestException('liquidationId inválido');
    if (!dto?.cash_breakdown || typeof dto.cash_breakdown !== 'object')
      throw new BadRequestException('cash_breakdown (arqueo) requerido');

    const cashCounted = this.countedFromBreakdown(dto.cash_breakdown);

    return this.tk.run(async (trx) => {
      const liq = await trx('commercial.rider_liquidations')
        .where({ id: liquidationId })
        .forUpdate()
        .first();
      if (!liq) throw new NotFoundException('Corte no encontrado');
      if (liq.status !== 'open')
        throw new ConflictException(`El corte ya está ${liq.status}`);

      const totals = await this.computeTotals(trx, liq.rider_user_id, liq.business_date);
      const cashDifference = Math.round((cashCounted - totals.cash_expected) * 100) / 100;
      const userId = this.requireUserId();

      // Estampa los pagos del día con el corte (audit).
      await trx('commercial.payments')
        .whereRaw('received_at::date = ?', [liq.business_date])
        .andWhere({ received_by: liq.rider_user_id })
        .whereNull('liquidation_id')
        .update({ liquidation_id: liquidationId });

      const [updated] = await trx('commercial.rider_liquidations')
        .where({ id: liquidationId })
        .update({
          deliveries_count: totals.deliveries_count,
          cash_expected: totals.cash_expected,
          cash_counted: cashCounted,
          cash_breakdown: JSON.stringify(dto.cash_breakdown),
          cash_difference: cashDifference,
          transfer_total: totals.transfer_total,
          card_total: totals.card_total,
          incidents_count: totals.incidents_count,
          status: 'closed',
          closed_by: userId,
          closed_at: trx.fn.now(),
          notes: dto.notes || liq.notes || null,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');
      return updated;
    });
  }

  /** Lista cortes (opcional filtro por sucursal/fecha) — cierre por sucursal. */
  async list(query: { branch_store_id?: string; business_date?: string; status?: string } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.rider_liquidations').whereNull('deleted_at');
      if (query.branch_store_id) q = q.andWhere({ branch_store_id: query.branch_store_id });
      if (query.business_date) q = q.andWhere({ business_date: query.business_date });
      if (query.status) q = q.andWhere({ status: query.status });
      return q.orderBy('business_date', 'desc').orderBy('folio', 'desc');
    });
  }
}
