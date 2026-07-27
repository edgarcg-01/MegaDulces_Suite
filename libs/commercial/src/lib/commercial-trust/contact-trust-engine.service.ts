import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, normalizeMxPhone } from '@megadulces/platform-core';

/**
 * FIQ.7 (ADR-037) — Motor de trust-score del contacto. CERO LLM.
 *
 * Agrega señales REALES por teléfono E.164 (pedidos/entregas/llamadas/
 * conversaciones/apartados-vencidos/deuda) → un tier que el gate del bot obedece.
 * El MOTOR decide; el LLM solo comunica y NUNCA acusa (ADR-016/020). Guard
 * `min_observations`: contactos nuevos = neutral (cold-start, no falsos positivos).
 *
 * Tiers: neutral (sin datos) | allow | require_deposit | block. El gate traduce
 * `block` a handoff humano (nunca refuse hard) y `require_deposit` a pedir
 * transferencia/anticipo verificado por humano (NO cobro online — Fase H diferida).
 */

export type TrustTier = 'neutral' | 'allow' | 'require_deposit' | 'block';

export interface TrustFeatures {
  orders_created: number;
  orders_confirmed: number;
  orders_fulfilled: number;
  orders_cancelled: number;
  deliveries_total: number;
  deliveries_failed: number;
  calls_total: number;
  calls_unproductive: number;
  conversations_total: number;
  conversations_without_order: number;
  reservations_expired: number;
  balance: number;
}

export interface TrustAssessment {
  phone: string;
  customer_id: string | null;
  tier: TrustTier;
  risk_score: number; // 0..1
  reasons: string[];
  observations: number;
  features: TrustFeatures;
}

interface Thresholds {
  min_observations: number;
  block_fail_rate: number;
  deposit_fail_rate: number;
  block_fail_count: number;
  deposit_cancel_rate: number;
  deposit_playing_convos: number;
  deposit_min_balance: number;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  min_observations: 3,
  block_fail_rate: 0.5,
  deposit_fail_rate: 0.25,
  block_fail_count: 2,
  deposit_cancel_rate: 0.5,
  deposit_playing_convos: 6,
  deposit_min_balance: 0.01,
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

@Injectable()
export class ContactTrustEngineService {
  private readonly logger = new Logger(ContactTrustEngineService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Evalúa un contacto por teléfono (determinista) y PERSISTE el feature store.
   * Es el camino del gate (on-demand en confirmar_pedido). Idempotente (UPSERT).
   */
  async assess(phone: string): Promise<TrustAssessment> {
    const canonical = normalizeMxPhone(phone);
    if (!canonical) throw new BadRequestException('Teléfono inválido.');

    return this.tk.run(async (trx) => {
      const th = await this.loadThresholds(trx);

      // Clientes ligados al teléfono (E.164 normalizado). Puede haber varios (casual dup).
      const custs = await trx('commercial.customers')
        .whereNull('deleted_at')
        .andWhere((b: any) => {
          b.whereRaw('public.mx_normalize_phone(whatsapp) = ?', [canonical]).orWhereRaw(
            'public.mx_normalize_phone(phone) = ?',
            [canonical],
          );
        })
        .select('id', 'balance');
      const ids: string[] = custs.map((c: any) => c.id);
      const customerId = ids[0] || null;
      const balance = custs.reduce((m: number, c: any) => Math.max(m, Number(c.balance) || 0), 0);

      // Pedidos por estado (solo si hay cliente ligado).
      let orders = { created: 0, confirmed: 0, fulfilled: 0, cancelled: 0 };
      let deliveries = { total: 0, failed: 0 };
      let calls = { total: 0, unproductive: 0 };
      if (ids.length) {
        const o = await trx('commercial.orders')
          .whereIn('customer_id', ids)
          .whereNull('deleted_at')
          .select(
            trx.raw(`count(*) filter (where status <> 'draft')::int as created`),
            trx.raw(`count(*) filter (where status in ('confirmed','fulfilled'))::int as confirmed`),
            trx.raw(`count(*) filter (where status = 'fulfilled')::int as fulfilled`),
            trx.raw(`count(*) filter (where status = 'cancelled')::int as cancelled`),
          )
          .first();
        orders = { created: +o.created, confirmed: +o.confirmed, fulfilled: +o.fulfilled, cancelled: +o.cancelled };

        const d = await trx('commercial.home_deliveries')
          .whereIn('customer_id', ids)
          .whereNull('deleted_at')
          .select(
            trx.raw('count(*)::int as total'),
            trx.raw(
              `count(*) filter (where status in ('rechazado','no_entregado')
                 or incident_type in ('customer_rejected','not_located','wrong_address'))::int as failed`,
            ),
          )
          .first();
        deliveries = { total: +d.total, failed: +d.failed };

        const c = await trx('commercial.call_logs')
          .whereIn('customer_id', ids)
          .select(
            trx.raw('count(*)::int as total'),
            trx.raw(`count(*) filter (where outcome in ('no_answer','no_sale'))::int as unproductive`),
          )
          .first();
        calls = { total: +c.total, unproductive: +c.unproductive };
      }

      // Conversaciones del bot (por teléfono) y apartados vencidos (FIQ.6).
      const conv = await trx('whatsapp.conversation_threads')
        .where({ phone: canonical })
        .count<{ count: string }>('* as count')
        .first();
      const conversationsTotal = Number(conv?.count) || 0;

      const resExp = await trx('commercial.stock_reservations')
        .where({ phone: canonical, released_reason: 'expired' })
        .count<{ count: string }>('* as count')
        .first();
      const reservationsExpired = Number(resExp?.count) || 0;

      const conversationsWithoutOrder = Math.max(0, conversationsTotal - orders.created);
      const features: TrustFeatures = {
        orders_created: orders.created,
        orders_confirmed: orders.confirmed,
        orders_fulfilled: orders.fulfilled,
        orders_cancelled: orders.cancelled,
        deliveries_total: deliveries.total,
        deliveries_failed: deliveries.failed,
        calls_total: calls.total,
        calls_unproductive: calls.unproductive,
        conversations_total: conversationsTotal,
        conversations_without_order: conversationsWithoutOrder,
        reservations_expired: reservationsExpired,
        balance,
      };

      const { tier, riskScore, reasons, observations } = this.decide(features, th);

      await trx('commercial.contact_trust_features')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          phone: canonical,
          customer_id: customerId,
          orders_created: features.orders_created,
          orders_confirmed: features.orders_confirmed,
          orders_fulfilled: features.orders_fulfilled,
          orders_cancelled: features.orders_cancelled,
          deliveries_total: features.deliveries_total,
          deliveries_failed: features.deliveries_failed,
          calls_total: features.calls_total,
          calls_unproductive: features.calls_unproductive,
          conversations_total: features.conversations_total,
          conversations_without_order: features.conversations_without_order,
          reservations_expired: features.reservations_expired,
          balance: features.balance,
          observations,
          risk_score: riskScore,
          tier,
          reasons: JSON.stringify(reasons),
          computed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .onConflict(['tenant_id', 'phone'])
        .merge({
          customer_id: trx.raw('EXCLUDED.customer_id'),
          orders_created: trx.raw('EXCLUDED.orders_created'),
          orders_confirmed: trx.raw('EXCLUDED.orders_confirmed'),
          orders_fulfilled: trx.raw('EXCLUDED.orders_fulfilled'),
          orders_cancelled: trx.raw('EXCLUDED.orders_cancelled'),
          deliveries_total: trx.raw('EXCLUDED.deliveries_total'),
          deliveries_failed: trx.raw('EXCLUDED.deliveries_failed'),
          calls_total: trx.raw('EXCLUDED.calls_total'),
          calls_unproductive: trx.raw('EXCLUDED.calls_unproductive'),
          conversations_total: trx.raw('EXCLUDED.conversations_total'),
          conversations_without_order: trx.raw('EXCLUDED.conversations_without_order'),
          reservations_expired: trx.raw('EXCLUDED.reservations_expired'),
          balance: trx.raw('EXCLUDED.balance'),
          observations: trx.raw('EXCLUDED.observations'),
          risk_score: trx.raw('EXCLUDED.risk_score'),
          tier: trx.raw('EXCLUDED.tier'),
          reasons: trx.raw('EXCLUDED.reasons'),
          computed_at: trx.raw('EXCLUDED.computed_at'),
          updated_at: trx.fn.now(),
        });

      return { phone: canonical, customer_id: customerId, tier, risk_score: riskScore, reasons, observations, features };
    });
  }

  /**
   * Recalcula el feature store de TODOS los contactos del tenant actual (los que
   * han chateado con el bot). Enciende la señal "solo juega" para quien nunca
   * compra. Corre en scope CLS ya establecido (cron). Devuelve conteos por tier.
   */
  async scanTenant(limit = 5000): Promise<{ scanned: number; by_tier: Record<string, number> }> {
    const phones: Array<{ phone: string }> = await this.tk.run((trx) =>
      trx('whatsapp.conversation_threads')
        .distinct('phone')
        .whereNotNull('phone')
        .limit(limit),
    );
    const byTier: Record<string, number> = {};
    let scanned = 0;
    for (const p of phones) {
      try {
        const a = await this.assess(p.phone);
        byTier[a.tier] = (byTier[a.tier] || 0) + 1;
        scanned++;
      } catch (e: any) {
        this.logger.warn(`scanTenant: assess ${p.phone} falló (${e?.message}).`);
      }
    }
    if (phones.length >= limit) this.logger.log(`scanTenant: alcanzó el cap ${limit} contactos (hay más).`);
    return { scanned, by_tier: byTier };
  }

  // ── decisión determinista ──────────────────────────────────────────────────

  private decide(f: TrustFeatures, th: Thresholds): { tier: TrustTier; riskScore: number; reasons: string[]; observations: number } {
    const observations = f.orders_created + f.conversations_total;
    const reasons: string[] = [];

    const failRate = f.deliveries_total > 0 ? f.deliveries_failed / f.deliveries_total : 0;
    const cancelRate = f.orders_created > 0 ? f.orders_cancelled / f.orders_created : 0;
    const playingRatio = f.conversations_total > 0 ? f.conversations_without_order / f.conversations_total : 0;
    const isPlaying = f.orders_created === 0 && f.conversations_without_order >= th.deposit_playing_convos;
    const hasDebt = f.balance >= th.deposit_min_balance;

    // risk_score (0..1) para ranking/telemetría — no gobierna el tier, solo lo acompaña.
    const riskScore =
      Math.round(
        clamp01(
          0.45 * failRate +
            0.25 * cancelRate +
            0.2 * playingRatio * (f.orders_created === 0 ? 1 : 0.3) +
            (hasDebt ? 0.15 : 0) +
            Math.min(f.reservations_expired, 3) * 0.05,
        ) * 10000,
      ) / 10000;

    // Cold-start: sin señal suficiente → neutral (no penalizar contactos nuevos).
    if (observations < th.min_observations) {
      return { tier: 'neutral', riskScore, reasons: ['cold_start_sin_historial'], observations };
    }

    // BLOCK: no-show duro (rechaza/no recibe la mayoría, con volumen mínimo).
    if (failRate >= th.block_fail_rate && f.deliveries_failed >= th.block_fail_count) {
      reasons.push(`no_recibe_pedidos: ${f.deliveries_failed}/${f.deliveries_total} entregas fallidas`);
      return { tier: 'block', riskScore, reasons, observations };
    }

    // REQUIRE_DEPOSIT: fallos parciales, cancelaciones altas, "solo juega", o deuda.
    let deposit = false;
    if (f.deliveries_total >= 1 && failRate >= th.deposit_fail_rate) {
      deposit = true;
      reasons.push(`entregas_fallidas: ${f.deliveries_failed}/${f.deliveries_total}`);
    }
    if (f.orders_created >= 2 && cancelRate >= th.deposit_cancel_rate) {
      deposit = true;
      reasons.push(`cancela_seguido: ${f.orders_cancelled}/${f.orders_created} pedidos`);
    }
    if (isPlaying) {
      deposit = true;
      reasons.push(`solo_conversa_sin_comprar: ${f.conversations_without_order} charlas, 0 pedidos`);
    }
    if (hasDebt) {
      deposit = true;
      reasons.push(`saldo_pendiente: ${f.balance}`);
    }
    if (deposit) return { tier: 'require_deposit', riskScore, reasons, observations };

    reasons.push('sin_señales_de_riesgo');
    return { tier: 'allow', riskScore, reasons, observations };
  }

  private async loadThresholds(trx: any): Promise<Thresholds> {
    const row = await trx('commercial.trust_thresholds')
      .where({ tenant_id: this.tenantCtx.requireTenantId() })
      .first();
    if (!row) return DEFAULT_THRESHOLDS;
    return {
      min_observations: Number(row.min_observations),
      block_fail_rate: Number(row.block_fail_rate),
      deposit_fail_rate: Number(row.deposit_fail_rate),
      block_fail_count: Number(row.block_fail_count),
      deposit_cancel_rate: Number(row.deposit_cancel_rate),
      deposit_playing_convos: Number(row.deposit_playing_convos),
      deposit_min_balance: Number(row.deposit_min_balance),
    };
  }
}
