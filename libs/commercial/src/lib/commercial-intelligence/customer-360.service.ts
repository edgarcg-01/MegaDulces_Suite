import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { Customer360 } from './customer-360.types';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Feature store por customer (Fase M, Sprint M.0).
 *
 * Deriva métricas de commercial.orders (confirmed/fulfilled) y las persiste en
 * commercial.customer_360 (UPSERT). Determinista, sin ML, NO toca dinero.
 *
 * - cadence_days = mediana de días entre pedidos (percentile_cont 0.5). null si <3 pedidos.
 * - lifecycle_stage: reglas sobre recency vs cadencia.
 *   reactivated queda reservado (necesita estado previo) — no se emite en v1.
 */
@Injectable()
export class Customer360Service {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Recomputa TODO el tenant actual (un solo UPSERT batch). Usado por el cron. */
  async computeForTenant(): Promise<{ customers: number }> {
    return this.tk.run(async (trx) => {
      const result = await this.runUpsert(trx);
      return { customers: result.rowCount ?? 0 };
    });
  }

  /** Recomputa un solo customer (on-demand cuando está stale). */
  async computeForCustomer(customerId: string): Promise<Customer360> {
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');

    return this.tk.run(async (trx) => {
      const exists = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!exists)
        throw new NotFoundException(`Customer ${customerId} no existe`);

      await this.runUpsert(trx, customerId);
      const row = await trx('commercial.customer_360')
        .where({ customer_id: customerId })
        .first();
      return this.mapRow(row);
    });
  }

  /** Lee el perfil; si falta o está stale (>24h) recomputa y devuelve fresco. */
  async getForCustomer(customerId: string): Promise<Customer360> {
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');

    const row = await this.tk.run(async (trx) =>
      trx('commercial.customer_360').where({ customer_id: customerId }).first(),
    );

    const isStale =
      !row || Date.now() - new Date(row.computed_at).getTime() > STALE_MS;
    if (isStale) return this.computeForCustomer(customerId);

    return this.mapRow(row);
  }

  /** Perfil del customer del JWT actual (Portal B2B). */
  async getForMyCustomer(): Promise<Customer360> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Usuario no identificado');

    const customerId = await this.tk.run(async (trx) => {
      const r = await trx('public.users')
        .where({ id: userId })
        .select('customer_id')
        .first();
      return r?.customer_id;
    });
    if (!customerId)
      throw new BadRequestException(
        'Usuario sin customer_id linkeado — no es customer_b2b',
      );
    return this.getForCustomer(customerId);
  }

  /**
   * UPSERT batch. Si `customerId` se pasa, recomputa solo ese customer.
   * tenant_id se setea via public.current_tenant_id() y RLS WITH CHECK lo valida.
   */
  private async runUpsert(trx: any, customerId?: string): Promise<any> {
    const baseFilter = customerId ? 'AND o.customer_id = ?' : '';
    const aggFilter = customerId ? 'AND c.id = ?' : '';
    const bindings = customerId ? [customerId, customerId] : [];

    return trx.raw(
      `
      INSERT INTO commercial.customer_360 (
        id, tenant_id, customer_id, orders_count, first_order_at, last_order_at,
        recency_days, frequency_90d, monetary_90d, aov, cadence_days,
        next_order_estimate, lifecycle_stage, computed_at, created_at, updated_at
      )
      order_days AS (
        SELECT DISTINCT o.customer_id,
          (o.created_at AT TIME ZONE 'America/Mexico_City')::date AS order_day
        FROM commercial.orders o
        WHERE o.status IN ('confirmed', 'fulfilled')
          AND o.deleted_at IS NULL
          ${baseFilter}
      ),
      gaps AS (
        SELECT customer_id,
          (order_day - LAG(order_day) OVER (
            PARTITION BY customer_id ORDER BY order_day
          ))::numeric AS gap_days
        FROM order_days
      ),
      cadence AS (
        SELECT customer_id,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_days) AS cadence_days
        FROM gaps
        WHERE gap_days IS NOT NULL
        GROUP BY customer_id
      ),
      agg AS (
        SELECT
          c.id AS customer_id,
          COUNT(o.id)::int AS orders_count,
          MIN(o.created_at) AS first_order_at,
          MAX(o.created_at) AS last_order_at,
          COUNT(o.id) FILTER (WHERE o.created_at >= NOW() - INTERVAL '90 days')::int AS frequency_90d,
          COALESCE(SUM(o.total) FILTER (WHERE o.created_at >= NOW() - INTERVAL '90 days'), 0)::numeric AS monetary_90d,
          COALESCE(AVG(o.total), 0)::numeric AS aov
        FROM commercial.customers c
        LEFT JOIN commercial.orders o
          ON o.customer_id = c.id
          AND o.status IN ('confirmed', 'fulfilled')
          AND o.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
          ${aggFilter}
        GROUP BY c.id
      ),
      metrics AS (
        SELECT agg.*,
          cad.cadence_days,
          CASE WHEN agg.last_order_at IS NULL THEN NULL
               ELSE EXTRACT(EPOCH FROM (NOW() - agg.last_order_at)) / 86400.0
          END AS recency_f
        FROM agg
        LEFT JOIN cadence cad ON cad.customer_id = agg.customer_id
      )
      SELECT
        gen_random_uuid(),
        public.current_tenant_id(),
        m.customer_id,
        m.orders_count,
        m.first_order_at,
        m.last_order_at,
        CASE WHEN m.recency_f IS NULL THEN NULL ELSE FLOOR(m.recency_f)::int END,
        m.frequency_90d,
        m.monetary_90d,
        ROUND(m.aov, 2),
        ROUND(m.cadence_days::numeric, 2),
        CASE WHEN m.last_order_at IS NOT NULL AND m.cadence_days IS NOT NULL
             THEN ((m.last_order_at + (m.cadence_days || ' days')::interval) AT TIME ZONE 'America/Mexico_City')::date
             ELSE NULL
        END,
        CASE
          WHEN m.orders_count = 0 THEN 'new'
          WHEN m.first_order_at >= NOW() - INTERVAL '30 days' AND m.orders_count <= 2 THEN 'new'
          WHEN m.cadence_days IS NOT NULL THEN
            CASE
              WHEN m.recency_f <= m.cadence_days * 1.5 THEN 'active'
              WHEN m.recency_f <= m.cadence_days * 3 THEN 'at_risk'
              ELSE 'lost'
            END
          ELSE
            CASE
              WHEN m.recency_f <= 45 THEN 'active'
              WHEN m.recency_f <= 90 THEN 'at_risk'
              ELSE 'lost'
            END
        END,
        NOW(), NOW(), NOW()
      FROM metrics m
      ON CONFLICT (tenant_id, customer_id) DO UPDATE SET
        orders_count = EXCLUDED.orders_count,
        first_order_at = EXCLUDED.first_order_at,
        last_order_at = EXCLUDED.last_order_at,
        recency_days = EXCLUDED.recency_days,
        frequency_90d = EXCLUDED.frequency_90d,
        monetary_90d = EXCLUDED.monetary_90d,
        aov = EXCLUDED.aov,
        cadence_days = EXCLUDED.cadence_days,
        next_order_estimate = EXCLUDED.next_order_estimate,
        lifecycle_stage = EXCLUDED.lifecycle_stage,
        computed_at = NOW(),
        updated_at = NOW()
      `,
      bindings,
    );
  }

  private mapRow(row: any): Customer360 {
    return {
      customer_id: row.customer_id,
      orders_count: Number(row.orders_count),
      first_order_at: row.first_order_at
        ? new Date(row.first_order_at).toISOString()
        : null,
      last_order_at: row.last_order_at
        ? new Date(row.last_order_at).toISOString()
        : null,
      recency_days: row.recency_days === null ? null : Number(row.recency_days),
      frequency_90d: Number(row.frequency_90d),
      monetary_90d: Number(row.monetary_90d),
      aov: Number(row.aov),
      cadence_days: row.cadence_days === null ? null : Number(row.cadence_days),
      next_order_estimate: row.next_order_estimate
        ? typeof row.next_order_estimate === 'string'
          ? row.next_order_estimate
          : new Date(row.next_order_estimate).toISOString().slice(0, 10)
        : null,
      lifecycle_stage: row.lifecycle_stage,
      computed_at: row.computed_at
        ? new Date(row.computed_at).toISOString()
        : new Date().toISOString(),
    };
  }
}
