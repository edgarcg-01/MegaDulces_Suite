import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { Knex } from 'knex';

const TABLE = 'commercial.portal_telemetry_events';
const MAX_EVENTS_PER_BEACON = 100;
const VALID_KINDS = new Set(['web_vital', 'error', 'event']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un evento crudo tal como lo manda el portal (no confiar en los tipos). */
export interface RawTelemetryEvent {
  kind?: string;
  name?: string;
  value?: unknown;
  rating?: string;
  props?: unknown;
  ts?: number;
  url?: string;
  session_id?: string;
  env?: string;
  release?: string;
}

export interface IngestContext {
  ip: string | null;
  userAgent: string | null;
  tenantId: string | null;
  userId: string | null;
}

export interface SummaryQuery {
  from: Date;
  to: Date;
  tenantId?: string | null;
}

@Injectable()
export class CommercialTelemetryService {
  private readonly logger = new Logger(CommercialTelemetryService.name);

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  // ── Ingesta ─────────────────────────────────────────────────────────────────

  /**
   * Inserta el lote del beacon. Tolerante a basura: clampa longitudes, descarta
   * lo inválido, cap de MAX_EVENTS_PER_BEACON. NUNCA lanza al caller — la
   * telemetría jamás debe romper al cliente (devolvemos { inserted }).
   */
  async ingestPortal(events: RawTelemetryEvent[], ctx: IngestContext): Promise<{ inserted: number }> {
    if (!Array.isArray(events) || events.length === 0) return { inserted: 0 };

    const tenantId = ctx.tenantId && UUID_RE.test(ctx.tenantId) ? ctx.tenantId : null;
    const userId = ctx.userId && UUID_RE.test(ctx.userId) ? ctx.userId : null;

    const rows = events
      .slice(0, MAX_EVENTS_PER_BEACON)
      .map((e) => this.toRow(e, ctx, tenantId, userId))
      .filter((r): r is Record<string, unknown> => r !== null);

    if (rows.length === 0) return { inserted: 0 };

    try {
      await this.knex(TABLE).insert(rows);
      return { inserted: rows.length };
    } catch (err) {
      // Tragar a propósito: el cliente ya se fue (beacon). Solo dejamos rastro
      // server-side para no perder visibilidad de un fallo de ingesta.
      this.logger.error(`portal telemetry insert failed: ${(err as Error)?.message}`);
      return { inserted: 0 };
    }
  }

  private toRow(
    e: RawTelemetryEvent,
    ctx: IngestContext,
    tenantId: string | null,
    userId: string | null,
  ): Record<string, unknown> | null {
    const kind = String(e?.kind ?? '').trim();
    if (!VALID_KINDS.has(kind)) return null;
    const name = String(e?.name ?? '').trim();
    if (!name) return null;

    const value =
      typeof e?.value === 'number' && Number.isFinite(e.value) ? e.value : null;
    const clientTs =
      typeof e?.ts === 'number' && Number.isFinite(e.ts) ? new Date(e.ts) : null;

    return {
      kind: kind.slice(0, 32),
      name: name.slice(0, 120),
      value,
      rating: e?.rating ? String(e.rating).slice(0, 32) : null,
      props: this.jsonbOrNull(e?.props),
      session_id: e?.session_id ? String(e.session_id).slice(0, 80) : null,
      env: e?.env ? String(e.env).slice(0, 24) : null,
      release: e?.release ? String(e.release).slice(0, 60) : null,
      url: e?.url ? String(e.url).slice(0, 512) : null,
      tenant_id: tenantId,
      user_id: userId,
      ip: ctx.ip ? ctx.ip.slice(0, 64) : null,
      user_agent: ctx.userAgent ? ctx.userAgent.slice(0, 400) : null,
      client_ts: clientTs,
    };
  }

  /** Serializa props a jsonb con cap de tamaño; null si no es serializable. */
  private jsonbOrNull(props: unknown): Knex.Raw | null {
    if (props == null || typeof props !== 'object') return null;
    try {
      const json = JSON.stringify(props).slice(0, 4000);
      return this.knex.raw('?::jsonb', [json]);
    } catch {
      return null;
    }
  }

  // ── Agregación (dashboard) ───────────────────────────────────────────────────

  /**
   * Resumen para el dashboard: p75/p95/p99 de cada Web Vital, tasa de error y
   * funnel (counts por evento) en la ventana [from, to). `percentile_cont` es
   * de Postgres.
   */
  async summary(q: SummaryQuery) {
    const scope = <T extends Knex.QueryBuilder>(qb: T): T => {
      qb.where('created_at', '>=', q.from).andWhere('created_at', '<', q.to);
      if (q.tenantId && UUID_RE.test(q.tenantId)) qb.andWhere('tenant_id', q.tenantId);
      return qb;
    };

    const vitals = await scope(this.knex(TABLE))
      .where('kind', 'web_vital')
      .whereNotNull('value')
      .groupBy('name')
      .select('name')
      .count({ samples: '*' })
      .select(this.knex.raw('round(percentile_cont(0.75) within group (order by value)::numeric, 2) as p75'))
      .select(this.knex.raw('round(percentile_cont(0.95) within group (order by value)::numeric, 2) as p95'))
      .select(this.knex.raw('round(percentile_cont(0.99) within group (order by value)::numeric, 2) as p99'));

    const funnel = await scope(this.knex(TABLE))
      .where('kind', 'event')
      .groupBy('name')
      .select('name')
      .count({ count: '*' })
      .orderBy('count', 'desc');

    const errorsRow = await scope(this.knex(TABLE)).where('kind', 'error').count({ c: '*' }).first();
    const totalRow = await scope(this.knex(TABLE)).count({ c: '*' }).first();
    const errors = Number(errorsRow?.['c'] ?? 0);
    const total = Number(totalRow?.['c'] ?? 0);

    const topErrors = await scope(this.knex(TABLE))
      .where('kind', 'error')
      .groupBy('name')
      .select('name')
      .count({ count: '*' })
      .orderBy('count', 'desc')
      .limit(10);

    return {
      range: { from: q.from.toISOString(), to: q.to.toISOString() },
      tenant_id: q.tenantId ?? null,
      web_vitals: vitals,
      funnel,
      errors: { total: errors, top: topErrors, error_rate: total > 0 ? errors / total : 0 },
      total_events: total,
    };
  }
}
