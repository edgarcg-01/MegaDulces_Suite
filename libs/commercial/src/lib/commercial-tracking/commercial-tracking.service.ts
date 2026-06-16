import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import {
  TenantKnexService,
  TenantContextService,
  KNEX_NEW_DB_ADMIN,
} from '@megadulces/platform-core';
import { TrackPoint, douglasPeucker, encodePolyline, totalDistanceM } from './geo-track.util';

/** Tolerancia de simplificación de ruta (metros perpendiculares). */
const RDP_EPSILON_M = 12;
/** Cap defensivo de pings por request (un lote normal trae ~5-30). */
const MAX_POINTS_PER_BATCH = 500;
/** SQL: fecha local MX a partir de un timestamptz. */
const MX_DATE = `(recorded_at AT TIME ZONE 'America/Mexico_City')::date`;

export interface IngestPoint {
  lat: number;
  lng: number;
  accuracy_m?: number;
  /** ISO 8601. Si falta, se usa el now() del servidor. */
  recorded_at?: string;
}

/**
 * Tracking de campo (vendedores + colaboradores). Modelo "capturar denso,
 * almacenar ralo": el dispositivo manda lotes de pings → se guardan crudos +
 * se actualiza la posición viva; un cron nocturno consolida el día en UNA ruta
 * (Douglas-Peucker + encoded polyline) y purga los crudos.
 */
@Injectable()
export class CommercialTrackingService {
  private readonly logger = new Logger(CommercialTrackingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Inject(KNEX_NEW_DB_ADMIN) private readonly adminKnex: Knex | null,
  ) {}

  // ─────────── ingest (request del propio usuario, RLS) ───────────

  /** Ingesta un lote de pings del usuario logueado: crudos + UPSERT posición viva. */
  async ingest(points: IngestPoint[]) {
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new BadRequestException('Usuario no identificado');
    const clean = (Array.isArray(points) ? points : [])
      .filter(
        (p) =>
          Number.isFinite(p?.lat) &&
          Number.isFinite(p?.lng) &&
          Math.abs(p.lat) <= 90 &&
          Math.abs(p.lng) <= 180,
      )
      .slice(0, MAX_POINTS_PER_BATCH);
    if (!clean.length) return { ingested: 0 };

    return this.tk.run(async (trx) => {
      const acc = (p: IngestPoint) => (Number.isFinite(p.accuracy_m as number) ? p.accuracy_m : null);
      await trx('commercial.field_track_points').insert(
        clean.map((p) => ({
          tenant_id: trx.raw('public.current_tenant_id()'),
          user_id: me,
          latitude: p.lat,
          longitude: p.lng,
          accuracy_m: acc(p),
          recorded_at: p.recorded_at || trx.fn.now(),
        })),
      );

      const last = clean[clean.length - 1];
      const livePatch = {
        latitude: last.lat,
        longitude: last.lng,
        accuracy_m: acc(last),
        recorded_at: last.recorded_at || trx.fn.now(),
        updated_at: trx.fn.now(),
      };
      await trx('commercial.field_live_position')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          user_id: me,
          ...livePatch,
        })
        .onConflict(['tenant_id', 'user_id'])
        .merge(livePatch);

      return { ingested: clean.length };
    });
  }

  // ─────────── lecturas (RLS por tenant) ───────────

  /** Rutas consolidadas del usuario logueado. */
  async myRoutes(from?: string, to?: string) {
    const me = this.tenantCtx.get()?.userId;
    if (!me) return [];
    return this.tk.run((trx) => this.queryRoutes(trx, me, from, to));
  }

  /** Rutas de un usuario específico (supervisor). */
  async routesForUser(userId: string, from?: string, to?: string) {
    return this.tk.run((trx) => this.queryRoutes(trx, userId, from, to));
  }

  private queryRoutes(trx: any, userId: string, from?: string, to?: string) {
    let q = trx('commercial.field_routes')
      .where({ user_id: userId })
      .select('route_date', 'polyline', 'point_count', 'distance_m', 'started_at', 'ended_at')
      .orderBy('route_date', 'desc');
    if (from) q = q.where('route_date', '>=', from);
    if (to) q = q.where('route_date', '<=', to);
    return q.limit(120);
  }

  /** Posición viva del equipo (todo el tenant; el rol acota quién lo consulta). */
  async teamLive() {
    return this.tk.run((trx) =>
      trx('commercial.field_live_position as p')
        .leftJoin('public.users as u', 'u.id', 'p.user_id')
        .select(
          'p.user_id',
          'u.username',
          'p.latitude',
          'p.longitude',
          'p.accuracy_m',
          'p.recorded_at',
        )
        .orderBy('p.recorded_at', 'desc'),
    );
  }

  // ─────────── consolidación (cron, cross-tenant via admin) ───────────

  /** 09:10 UTC = 03:10 MX: consolida el día anterior para todos los usuarios. */
  @Cron('0 10 9 * * *')
  async scheduledConsolidate(): Promise<void> {
    if (!this.adminKnex) {
      this.logger.debug('Skip consolidate: KNEX_NEW_DB_ADMIN no disponible');
      return;
    }
    const day = this.yesterdayMx();
    try {
      const n = await this.consolidateDate(day);
      this.logger.log(`Consolidación ${day}: ${n} rutas`);
    } catch (e: any) {
      this.logger.error(`Consolidación ${day} falló: ${e?.message}`);
    }
  }

  /** Consolida una fecha (YYYY-MM-DD) para todos los (tenant,user) con pings ese día. */
  async consolidateDate(dateIso: string): Promise<number> {
    if (!this.adminKnex) throw new Error('KNEX_NEW_DB_ADMIN no disponible');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw new BadRequestException('date debe ser YYYY-MM-DD');
    const db = this.adminKnex;
    const groups = await db('commercial.field_track_points')
      .whereRaw(`${MX_DATE} = ?`, [dateIso])
      .distinct('tenant_id', 'user_id');
    let done = 0;
    for (const g of groups) {
      try {
        await this.consolidateOne(db, g.tenant_id, g.user_id, dateIso);
        done++;
      } catch (e: any) {
        this.logger.error(`Consolidar ${g.user_id} ${dateIso}: ${e?.message}`);
      }
    }
    return done;
  }

  private async consolidateOne(db: Knex, tenantId: string, userId: string, dateIso: string) {
    await db.transaction(async (trx) => {
      const scope = trx('commercial.field_track_points')
        .where({ tenant_id: tenantId, user_id: userId })
        .whereRaw(`${MX_DATE} = ?`, [dateIso]);

      const pts = await scope
        .clone()
        .orderBy('recorded_at', 'asc')
        .select('latitude', 'longitude', 'recorded_at');

      if (pts.length >= 2) {
        const track: TrackPoint[] = pts.map((p: any) => ({
          lat: Number(p.latitude),
          lng: Number(p.longitude),
        }));
        const simplified = douglasPeucker(track, RDP_EPSILON_M);
        const routeRow = {
          tenant_id: tenantId,
          user_id: userId,
          route_date: dateIso,
          polyline: encodePolyline(simplified),
          point_count: simplified.length,
          distance_m: Math.round(totalDistanceM(track)),
          started_at: pts[0].recorded_at,
          ended_at: pts[pts.length - 1].recorded_at,
          updated_at: trx.fn.now(),
        };
        await trx('commercial.field_routes')
          .insert(routeRow)
          .onConflict(['tenant_id', 'user_id', 'route_date'])
          .merge(routeRow);
      }
      // Purga los crudos del día (consolidados o demasiado pocos para una ruta).
      await scope.clone().del();
    });
  }

  /** Ayer en TZ MX (YYYY-MM-DD). */
  private yesterdayMx(): string {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
