import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecordSignalDto {
  customer_id: string;
  signal_type: string;
  channel: string;
  context?: Record<string, unknown>;
}

export interface ConversionSummary {
  window_days: number;
  offers: number;
  converted: number;
  conversion_pct: number;
}

export interface ReasonConversion {
  reason: string;
  offers: number; // productos ofrecidos con esa razón (atribuido a nivel producto)
  converted: number; // de esos, cuántos el cliente compró en la ventana
  conversion_pct: number;
}

export interface ConversionByReason {
  window_days: number;
  attribution_days: number;
  total: { offers: number; converted: number; conversion_pct: number };
  by_reason: ReasonConversion[];
}

export interface ConversionDailyRow {
  day: string;
  offers: number;
  converted: number;
  conversion_pct: number;
}

/**
 * Feedback loop (Fase M, Sprint M.4) — capa "aprende" de ADR-016.
 *
 * Registra ofertas/impresiones en commercial.commerce_signals (append-only) y
 * deriva conversión por join con orders (sin write-back, sin acoplar orders).
 * Todos los métodos son tenant-scoped via TenantKnexService.run (RLS).
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Registra una señal para un customer explícito (vendor/admin/agente). Best-effort en el caller. */
  async record(dto: RecordSignalDto): Promise<{ id: string }> {
    if (!UUID_REGEX.test(dto.customer_id))
      throw new BadRequestException('customer_id inválido');
    const type = (dto.signal_type || '').slice(0, 40);
    const channel = (dto.channel || '').slice(0, 20);
    if (!type || !channel)
      throw new BadRequestException('signal_type y channel son requeridos');

    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.commerce_signals')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          customer_id: dto.customer_id,
          signal_type: type,
          channel,
          user_id: userId,
          context: JSON.stringify(dto.context || {}),
        })
        .returning('id');
      return { id: row.id };
    });
  }

  /** Registra una señal para el customer del JWT (Portal B2B). */
  async recordForMyCustomer(
    dto: Omit<RecordSignalDto, 'customer_id'>,
  ): Promise<{ id: string }> {
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
      throw new BadRequestException('Usuario sin customer_id linkeado');
    return this.record({ ...dto, customer_id: customerId });
  }

  /**
   * Conversión: de las ofertas en la ventana, cuántas tuvieron un pedido
   * confirmado/fulfilled del mismo customer dentro de los 7 días siguientes.
   */
  async conversionSummary(days = 30): Promise<ConversionSummary> {
    const windowDays = Math.min(Math.max(days, 1), 365);
    return this.tk.run(async (trx) => {
      const res = await trx.raw(
        `
        WITH offers AS (
          SELECT id, customer_id, created_at
          FROM commercial.commerce_signals
          WHERE created_at >= NOW() - (? || ' days')::interval
        )
        SELECT
          COUNT(*)::int AS offers,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM commercial.orders o
            WHERE o.customer_id = ofr.customer_id
              AND o.status IN ('confirmed', 'fulfilled')
              AND o.deleted_at IS NULL
              AND o.created_at > ofr.created_at
              AND o.created_at <= ofr.created_at + INTERVAL '7 days'
          ))::int AS converted
        FROM offers ofr
        `,
        [windowDays],
      );
      const row = res.rows?.[0] || { offers: 0, converted: 0 };
      const offers = Number(row.offers) || 0;
      const converted = Number(row.converted) || 0;
      return {
        window_days: windowDays,
        offers,
        converted,
        conversion_pct: offers > 0 ? +((converted / offers) * 100).toFixed(1) : 0,
      };
    });
  }

  /**
   * Serie diaria de la conversión (mismo criterio que conversionSummary, agrupado
   * por día de la oferta en TZ MX). Alimenta las mini-barras del Command Center.
   */
  async conversionDaily(days = 30): Promise<ConversionDailyRow[]> {
    const windowDays = Math.min(Math.max(days, 1), 365);
    return this.tk.run(async (trx) => {
      const res = await trx.raw(
        `
        WITH offers AS (
          SELECT
            DATE_TRUNC('day', cs.created_at AT TIME ZONE 'America/Mexico_City')::date AS day,
            EXISTS (
              SELECT 1 FROM commercial.orders o
              WHERE o.customer_id = cs.customer_id
                AND o.status IN ('confirmed', 'fulfilled')
                AND o.deleted_at IS NULL
                AND o.created_at > cs.created_at
                AND o.created_at <= cs.created_at + INTERVAL '7 days'
            ) AS converted
          FROM commercial.commerce_signals cs
          WHERE cs.created_at >= NOW() - (? || ' days')::interval
        )
        SELECT
          day,
          COUNT(*)::int AS offers,
          COUNT(*) FILTER (WHERE converted)::int AS converted
        FROM offers
        GROUP BY day
        ORDER BY day ASC
        `,
        [windowDays],
      );
      return (res.rows || []).map((r: any) => {
        const offers = Number(r.offers) || 0;
        const converted = Number(r.converted) || 0;
        return {
          day: r.day,
          offers,
          converted,
          conversion_pct: offers > 0 ? +((converted / offers) * 100).toFixed(1) : 0,
        };
      });
    });
  }

  /**
   * Conversión ATRIBUIDA a nivel producto y desglosada por razón de Thot.
   *
   * A diferencia de `conversionSummary` (cuenta cualquier pedido del cliente), acá
   * cada producto ofrecido cuenta como "convertido" solo si ESE product_id aparece
   * en una línea de pedido confirmado/fulfilled dentro de los `attribution_days`
   * siguientes. Requiere ofertas logueadas con `context.items=[{p,r}]`
   * (p=product_id, r=reason) — el endpoint thot/suggest?log=<canal> las escribe.
   * Esto es lo que permite ver si whitespace/recompra/afinidad realmente convierten.
   */
  async conversionByReason(days = 30, attributionDays = 7): Promise<ConversionByReason> {
    const windowDays = Math.min(Math.max(days, 1), 365);
    const attrDays = Math.min(Math.max(attributionDays, 1), 30);
    return this.tk.run(async (trx) => {
      const res = await trx.raw(
        `
        WITH offer_items AS (
          SELECT cs.customer_id, cs.created_at,
                 (it->>'p')::uuid AS product_id,
                 COALESCE(NULLIF(it->>'r',''), 'demanda') AS reason
          FROM commercial.commerce_signals cs
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE jsonb_typeof(cs.context->'items') WHEN 'array' THEN cs.context->'items' ELSE '[]'::jsonb END) it
          WHERE cs.created_at >= NOW() - (? || ' days')::interval
            AND it->>'p' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        SELECT oi.reason,
          COUNT(*)::int AS offers,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM commercial.orders o
            JOIN commercial.order_lines ol
              ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id
            WHERE o.customer_id = oi.customer_id
              AND o.status IN ('confirmed', 'fulfilled')
              AND o.deleted_at IS NULL
              AND o.created_at > oi.created_at
              AND o.created_at <= oi.created_at + (? || ' days')::interval
              AND ol.product_id = oi.product_id
          ))::int AS converted
        FROM offer_items oi
        GROUP BY oi.reason
        ORDER BY offers DESC
        `,
        [windowDays, attrDays],
      );
      const by_reason: ReasonConversion[] = (res.rows || []).map((r: any) => {
        const offers = Number(r.offers) || 0;
        const converted = Number(r.converted) || 0;
        return {
          reason: r.reason,
          offers,
          converted,
          conversion_pct: offers > 0 ? +((converted / offers) * 100).toFixed(1) : 0,
        };
      });
      const offers = by_reason.reduce((a, b) => a + b.offers, 0);
      const converted = by_reason.reduce((a, b) => a + b.converted, 0);
      return {
        window_days: windowDays,
        attribution_days: attrDays,
        total: {
          offers,
          converted,
          conversion_pct: offers > 0 ? +((converted / offers) * 100).toFixed(1) : 0,
        },
        by_reason,
      };
    });
  }
}
