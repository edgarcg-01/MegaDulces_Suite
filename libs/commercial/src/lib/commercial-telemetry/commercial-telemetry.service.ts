import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KNEX_NEW_DB, TenantKnexService } from '@megadulces/platform-core';
import {
  PEDIDO_ACCESOS,
  VENTANA_ACCESOS_DIAS,
  type AccesoMedido,
  type MisAccesos,
  type OrigenAcceso,
} from '@megadulces/contracts';
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

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
  ) {}

  /**
   * `[SN.12]` Retención: 90 días y afuera.
   *
   * La migración que creó esta tabla (junio 2026) dejó escrito *"esta tabla crece rápido.
   * Follow-up recomendado: job de cron que borre filas > 90 días. No se implementa aquí."* Nunca
   * se implementó, y al sumarle el uso de la suite interna la tabla deja de crecer sólo con las
   * visitas del portal. Se cierra acá porque es la deuda de este mismo primitivo, no otra fase.
   *
   * Borra en lotes para no tomar un lock largo sobre una tabla que está recibiendo inserts, y
   * declara en el log cuántas filas se fueron. `timeZone` explícito: sin él el contenedor corre en
   * UTC y el "3 AM" no es el que uno cree.
   */
  @Cron('0 15 3 * * *', { timeZone: 'America/Mexico_City' })
  async purgarViejos(): Promise<number> {
    const DIAS = 90;
    const LOTE = 5000;
    let total = 0;
    try {
      for (;;) {
        const borradas = await this.knex(TABLE)
          .whereIn(
            'id',
            this.knex(TABLE)
              .select('id')
              .where('created_at', '<', this.knex.raw(`now() - interval '${DIAS} days'`))
              .limit(LOTE),
          )
          .del();
        total += borradas;
        if (borradas < LOTE) break;
      }
      if (total > 0) this.logger.log(`telemetría: purgadas ${total} filas de más de ${DIAS} días`);
      return total;
    } catch (err) {
      // Que la limpieza falle no puede tumbar la ingesta; se declara y se reintenta mañana.
      this.logger.error(`telemetría: la purga falló — ${(err as Error)?.message}`);
      return total;
    }
  }

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

  // ── Lectura: lo que esta persona abre ────────────────────────────────────────

  /**
   * `[SN.40]` **El primer lector del registro de clics.** Devuelve las puertas que esta persona
   * abre, y cuando no alcanzan, las de su puesto y después las de su departamento.
   *
   * ── Por qué la cascada no es un adorno ─────────────────────────────────────────────────────
   * Medido en prod el 2026-10-05 sobre los 90 días: **64 de 148** personas activas no tienen un
   * solo clic, y de las 84 que sí, **sólo 15 llegan a 6 puertas distintas**. Con la historia
   * propia a secas, ~8 de cada 10 verían una fila vacía o de dos chips — que es exactamente el
   * estado del que esta fase viene saliendo. El relleno por grupo es lo que hace que la fila
   * valga el primer día; el campo `origen` es lo que hace que no mienta sobre de quién es.
   *
   * ── Las tres decisiones de la consulta ─────────────────────────────────────────────────────
   *
   * 1. **Una sola ida a la base.** Las tres fuentes se unen en SQL y `DISTINCT ON (id)` con la
   *    prioridad se queda con la mejor: una puerta que ya es tuya nunca vuelve como "de tu
   *    puesto". Tres consultas encadenadas serían tres viajes en la ruta de carga de la landing.
   *
   * 2. ⛔ **El tenant se filtra A MANO sobre los eventos.** `commercial.portal_telemetry_events`
   *    **no tiene RLS** (verificado: `relrowsecurity = false`), así que sin este `where` la
   *    consulta agregaría los clics de todos los tenants. `identity.users` sí lo tiene, y
   *    FORZADO, por eso todo corre dentro de `tk.run()` — sin el contexto, el `JOIN` a usuarios
   *    devolvería cero filas y la cascada se caería al silencio en vez de al error.
   *
   * 3. **El puesto y el departamento salen de la base, no del token.** El JWT no los lleva, y
   *    aunque los llevara serían el estado congelado de hace hasta 12 h: a quien le cambian el
   *    puesto le seguiría llegando la sugerencia del anterior.
   *
   * ⚠️ **La cobertura del puesto no es pareja y la fila lo va a reflejar**: `cajera` tiene 10 de
   * 14 personas con clics, `encargado_sucursal` 6 de 6, pero `vendedor_ruta` **2 de 25**. Cuando
   * no hay de dónde sacar, devuelve MENOS elementos. Nunca rellena con lo primero del mapa: un
   * atajo inventado es peor que un hueco, porque el hueco se nota.
   *
   * ⚠️ Devuelve más de los que la fila muestra (`PEDIDO_ACCESOS`): el servidor no sabe qué puertas
   * ve cada quien —lo decide `visibleSuiteMap()` contra los permisos— y las que no se puedan abrir
   * se caen del lado del front.
   */
  async misAccesos(userId: string, tenantId: string, limite = PEDIDO_ACCESOS): Promise<MisAccesos> {
    const dias = VENTANA_ACCESOS_DIAS;
    const filas = await this.tk.run(tenantId, async (trx) => {
      const { rows } = await trx.raw(
        `
        WITH yo AS (
          SELECT position_code, department_code
            FROM identity.users
           WHERE id = ? AND tenant_id = ?
        ), ev AS (
          -- ⛔ El filtro de tenant va acá y es obligatorio: esta tabla no tiene RLS.
          SELECT e.user_id, e.props->>'id' AS id, e.created_at
            FROM commercial.portal_telemetry_events e
           WHERE e.name = 'abrio_puerta'
             AND e.tenant_id = ?
             AND e.created_at >= now() - make_interval(days => ?)
             AND coalesce(e.props->>'id', '') <> ''
        ), mio AS (
          SELECT id, count(*)::int AS clics, max(created_at) AS ultimo_at,
                 1 AS personas, 'mio'::text AS origen, 1 AS prio
            FROM ev WHERE user_id = ? GROUP BY 1
        ), pares_puesto AS (
          SELECT u.id FROM identity.users u, yo
           WHERE u.tenant_id = ? AND u.id <> ? AND u.deleted_at IS NULL
             AND yo.position_code IS NOT NULL AND u.position_code = yo.position_code
        ), puesto AS (
          SELECT id, count(*)::int AS clics, max(created_at) AS ultimo_at,
                 count(DISTINCT user_id)::int AS personas, 'puesto'::text AS origen, 2 AS prio
            FROM ev WHERE user_id IN (SELECT id FROM pares_puesto) GROUP BY 1
        ), pares_depto AS (
          SELECT u.id FROM identity.users u, yo
           WHERE u.tenant_id = ? AND u.id <> ? AND u.deleted_at IS NULL
             AND yo.department_code IS NOT NULL AND u.department_code = yo.department_code
        ), depto AS (
          SELECT id, count(*)::int AS clics, max(created_at) AS ultimo_at,
                 count(DISTINCT user_id)::int AS personas, 'departamento'::text AS origen, 3 AS prio
            FROM ev WHERE user_id IN (SELECT id FROM pares_depto) GROUP BY 1
        ), todas AS (
          SELECT * FROM mio
          UNION ALL SELECT * FROM puesto
          UNION ALL SELECT * FROM depto
        ), mejor AS (
          -- La de menor prio gana: tuya antes que de tu puesto, y de tu puesto antes que del área.
          SELECT DISTINCT ON (id) * FROM todas ORDER BY id, prio
        )
        SELECT id, clics, ultimo_at, personas, origen,
               (SELECT count(*)::int FROM mio) AS propias
          FROM mejor
         ORDER BY prio, clics DESC, ultimo_at DESC NULLS LAST
         LIMIT ?
        `,
        [userId, tenantId, tenantId, dias, userId, tenantId, userId, tenantId, userId, limite],
      );
      return rows as Array<Record<string, unknown>>;
    });

    return {
      medido_at: new Date().toISOString(),
      ventana_dias: dias,
      // `propias` viaja repetido en cada fila; sin filas es 0, que es el arranque en frío.
      propias: filas.length ? Number(filas[0]['propias'] ?? 0) : 0,
      accesos: filas.map(
        (r): AccesoMedido => ({
          id: String(r['id']),
          clics: Number(r['clics'] ?? 0),
          ultimo_at: r['ultimo_at'] ? new Date(r['ultimo_at'] as string).toISOString() : null,
          origen: r['origen'] as OrigenAcceso,
          personas: Number(r['personas'] ?? 0),
        }),
      ),
    };
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
