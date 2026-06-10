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
}
