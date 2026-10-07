import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { RecommendationsService } from '../commercial-recommendations/recommendations.service';
import { Customer360Service } from './customer-360.service';
import { Customer360, NextBestAction, NbaListItem } from './customer-360.types';

const DAY_MS = 86400000;

/**
 * Motor de Decisión v1 (Fase M, Sprint M.1).
 *
 * Determinista. Lee del Customer 360 y decide la Next-Best-Action. NO toca
 * dinero ni usa LLM — solo reglas explicables sobre cadencia + lifecycle.
 * La canasta sugerida reusa la categoría `base` de RecommendationsService.
 */
@Injectable()
export class DecisionEngineService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly customer360: Customer360Service,
    private readonly recommendations: RecommendationsService,
  ) {}

  /** NBA de un customer: ¿toca reorden hoy? */
  async nextBestAction(customerId: string): Promise<NextBestAction> {
    const c = await this.customer360.getForCustomer(customerId);
    return this.deriveNba(c);
  }

  private deriveNba(c: Customer360): NextBestAction {
    const head = {
      customer_id: c.customer_id,
      next_order_estimate: c.next_order_estimate,
      lifecycle_stage: c.lifecycle_stage,
    };

    if (c.orders_count === 0) {
      return { ...head, action: 'none', reason: 'Cliente sin pedidos', urgency: null, days_overdue: null };
    }
    if (!c.next_order_estimate) {
      return { ...head, action: 'none', reason: 'Sin cadencia suficiente (≥3 pedidos) para estimar reorden', urgency: null, days_overdue: null };
    }
    if (!['active', 'at_risk'].includes(c.lifecycle_stage)) {
      const why = c.lifecycle_stage === 'lost'
        ? 'Cliente perdido — requiere reactivación, no reorden'
        : 'Cliente nuevo — aún sin patrón de reorden';
      return { ...head, action: 'none', reason: why, urgency: null, days_overdue: null };
    }

    const dueTime = new Date(c.next_order_estimate).getTime();
    const daysOverdue = Math.floor((Date.now() - dueTime) / DAY_MS);
    if (daysOverdue < 0) {
      return { ...head, action: 'none', reason: `Próximo pedido estimado ${c.next_order_estimate} (aún no vence)`, urgency: null, days_overdue: daysOverdue };
    }

    const urgency = daysOverdue <= 3 ? 'low' : daysOverdue <= 10 ? 'medium' : 'high';
    const cadenceTxt = c.cadence_days ? `cada ~${Math.round(c.cadence_days)} días` : 'periódicamente';
    return {
      ...head,
      action: 'due_for_reorder',
      reason: `Suele pedir ${cadenceTxt}; lleva ${c.recency_days ?? '?'} días sin pedir`,
      urgency,
      days_overdue: daysOverdue,
    };
  }

  /** Canasta sugerida de reorden = categoría `base` de la canasta estratégica. */
  async suggestedBasket(customerId: string) {
    const basket = await this.recommendations.getForCustomer(customerId);
    const items = basket.items.filter((i) => i.category === 'base');
    return {
      customer_id: customerId,
      computed_at: basket.computed_at,
      total: items.length,
      items,
    };
  }

  /** Lista de customers del tenant que están due-for-reorder hoy, más urgentes primero. */
  async listDueForReorder(limit = 50): Promise<NbaListItem[]> {
    const cap = Math.min(Math.max(limit, 1), 200);
    return this.tk.run(async (trx) => {
      const res = await trx.raw(
        `
        WITH today AS (SELECT (NOW() AT TIME ZONE 'America/Mexico_City')::date AS d)
        SELECT c.id AS customer_id, c.code, c.name,
               c360.last_order_at, c360.next_order_estimate,
               c360.cadence_days, c360.lifecycle_stage,
               ((SELECT d FROM today) - c360.next_order_estimate) AS days_overdue
        FROM commercial.customer_360 c360
        JOIN commercial.customers c
          ON c.id = c360.customer_id AND c.deleted_at IS NULL
        WHERE c360.next_order_estimate IS NOT NULL
          AND c360.next_order_estimate <= (SELECT d FROM today)
          AND c360.lifecycle_stage IN ('active', 'at_risk')
        ORDER BY c360.next_order_estimate ASC
        LIMIT ?
        `,
        [cap],
      );
      return res.rows.map((r: any): NbaListItem => {
        const days = Number(r.days_overdue);
        return {
          customer_id: r.customer_id,
          code: r.code ?? null,
          name: r.name ?? null,
          last_order_at: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
          next_order_estimate: this.toDateStr(r.next_order_estimate),
          cadence_days: r.cadence_days === null ? null : Number(r.cadence_days),
          lifecycle_stage: r.lifecycle_stage,
          days_overdue: days,
          urgency: days <= 3 ? 'low' : days <= 10 ? 'medium' : 'high',
        };
      });
    });
  }

  private toDateStr(v: any): string | null {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    return new Date(v).toISOString().slice(0, 10);
  }
}
