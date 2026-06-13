import { Inject, Injectable, Logger, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import {
  KNEX_CONNECTION,
  TenantContextService,
  getDataScope,
  toMxDateKey,
} from '@megadulces/platform-core';

type Presence = 'none' | 'own' | 'competitor' | 'both' | 'unknown';

/**
 * Mapa Comercial — tiendas geolocalizadas + historial de exhibiciones.
 *
 * Lee la MISMA fuente que ReportsService: `daily_captures.exhibiciones` (JSONB),
 * que es la fuente VIVA (las tablas normalizadas visits/exhibitions son código
 * muerto). Cada exhibición trae el flag `perteneceMegaDulces` (true=propio,
 * false=competencia, ausente=sin clasificar).
 *
 * Conexión/seguridad: usa el connection legacy (KNEX_CONNECTION) que resuelve
 * `daily_captures`/`stores` sin calificar a las tablas reales vía search_path y
 * BYPASSA RLS — por eso el aislamiento es por filtro `tenant_id` EXPLÍCITO
 * (del JWT o del CLS), igual que ReportsService. No usar TenantKnexService acá.
 */
@Injectable()
export class CommercialMapService {
  private readonly logger = new Logger(CommercialMapService.name);
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /** zona_id a la que está restringido el requester, o null si tiene acceso amplio. */
  private async getRequesterZonaId(user: any): Promise<string | null> {
    const uid = user?.sub || user?.id || user?.userId;
    if (!uid || !CommercialMapService.UUID_RE.test(String(uid))) return null;
    const row = await this.knex('users').where({ id: uid }).select('zona_id').first();
    return row?.zona_id ?? null;
  }

  /** Ids del equipo de un supervisor (miembros + él mismo); [] si inválido. */
  private async getTeamIds(supervisorId?: string): Promise<string[]> {
    if (!supervisorId || !CommercialMapService.UUID_RE.test(supervisorId)) return [];
    const team = await this.knex('users')
      .select('id')
      .where('supervisor_id', supervisorId)
      .orWhere('id', supervisorId);
    return team.map((u: any) => u.id);
  }

  private static parseArray(v: any): any[] {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private static parseObj(v: any): Record<string, any> {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) || {};
      } catch {
        return {};
      }
    }
    return {};
  }

  /** Aplica scope own/team/all + tenant a una query sobre daily_captures (alias dc). */
  private async applyCaptureScope(
    q: Knex.QueryBuilder,
    user: any,
  ): Promise<Knex.QueryBuilder> {
    const tenantId = this.tenantId(user);
    if (tenantId) q = q.where('dc.tenant_id', tenantId);
    const scope = getDataScope(user);
    if (scope.type === 'own') {
      q = q.where('dc.user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        q = q.whereIn('dc.user_id', teamIds.length > 0 ? teamIds : ['__none__']);
      } else {
        q = q.whereRaw('1=0');
      }
    }
    return q;
  }

  /**
   * Tiendas en scope con coord híbrida (master `stores` o fallback última GPS de
   * captura) + conteo propio/competencia/sin-clasificar y presencia derivada.
   */
  async getStores(
    filters: {
      date_from?: string;
      date_to?: string;
      zone_id?: string;
      route_id?: string;
      presence?: 'any' | 'own' | 'competitor' | 'both';
    },
    user: any,
  ) {
    const tenantId = this.tenantId(user);
    const requesterZonaId = await this.getRequesterZonaId(user);
    const isUuid = (v?: string) => !!v && CommercialMapService.UUID_RE.test(v);

    // 1) Tiendas en scope (tenant + zona del requester + filtros opcionales).
    let sQ = this.knex('stores as s')
      .leftJoin('zones as z', 'z.id', 's.zona_id')
      .leftJoin('catalogs as c', 'c.id', 's.ruta_id')
      .whereNull('s.deleted_at')
      .select(
        's.id',
        's.nombre',
        's.direccion',
        's.latitud',
        's.longitud',
        's.zona_id',
        'z.name as zona',
        's.ruta_id',
        'c.value as ruta',
      )
      .orderBy('s.nombre', 'asc');
    if (tenantId) sQ = sQ.where('s.tenant_id', tenantId);
    if (requesterZonaId) sQ = sQ.where('s.zona_id', requesterZonaId);
    else if (isUuid(filters.zone_id)) sQ = sQ.where('s.zona_id', filters.zone_id);
    if (isUuid(filters.route_id)) sQ = sQ.where('s.ruta_id', filters.route_id);
    const stores = await sQ;

    // 2) Capturas agregadas por store_id (mismo scope + fechas TZ MX).
    let cQ = this.knex('daily_captures as dc')
      .whereNotNull('dc.store_id')
      .select(
        'dc.store_id',
        'dc.exhibiciones',
        'dc.stats',
        'dc.hora_inicio',
        'dc.latitud',
        'dc.longitud',
      );
    cQ = await this.applyCaptureScope(cQ, user);
    if (filters.date_from)
      cQ.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [
        filters.date_from,
      ]);
    if (filters.date_to)
      cQ.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [
        filters.date_to,
      ]);
    const caps = await cQ;

    type Agg = {
      visitas: number;
      own: number;
      competitor: number;
      unknown: number;
      scoreSum: number;
      scoreCount: number;
      ultimaVisita: any;
      lat: number | null;
      lng: number | null;
      coordTime: number;
    };
    const agg = new Map<string, Agg>();
    for (const r of caps) {
      const sid = r.store_id;
      let a = agg.get(sid);
      if (!a) {
        a = {
          visitas: 0,
          own: 0,
          competitor: 0,
          unknown: 0,
          scoreSum: 0,
          scoreCount: 0,
          ultimaVisita: null,
          lat: null,
          lng: null,
          coordTime: -1,
        };
        agg.set(sid, a);
      }
      a.visitas++;
      const stats = CommercialMapService.parseObj(r.stats);
      a.scoreSum += Number(stats.puntuacionTotal) || 0;
      a.scoreCount++;
      if (!a.ultimaVisita || r.hora_inicio > a.ultimaVisita) a.ultimaVisita = r.hora_inicio;
      for (const e of CommercialMapService.parseArray(r.exhibiciones)) {
        if (e.perteneceMegaDulces === true) a.own++;
        else if (e.perteneceMegaDulces === false) a.competitor++;
        else a.unknown++;
      }
      // Fallback coord = GPS de la captura más reciente con coords no nulas.
      const t = r.hora_inicio ? new Date(r.hora_inicio).getTime() : 0;
      if (r.latitud != null && t > a.coordTime) {
        a.lat = Number(r.latitud);
        a.lng = Number(r.longitud);
        a.coordTime = t;
      }
    }

    let result = stores.map((s: any) => {
      const a = agg.get(s.id);
      const lat = s.latitud != null ? Number(s.latitud) : a?.lat ?? null;
      const lng = s.longitud != null ? Number(s.longitud) : a?.lng ?? null;
      const own = a?.own ?? 0;
      const competitor = a?.competitor ?? 0;
      const unknown = a?.unknown ?? 0;
      let presence: Presence = 'none';
      if (own > 0 && competitor > 0) presence = 'both';
      else if (own > 0) presence = 'own';
      else if (competitor > 0) presence = 'competitor';
      else if (unknown > 0) presence = 'unknown';
      return {
        id: s.id,
        nombre: s.nombre,
        direccion: s.direccion,
        zona: s.zona || '',
        ruta: s.ruta || '',
        lat,
        lng,
        located: lat != null && lng != null,
        visitas: a?.visitas ?? 0,
        ultimaVisita: a?.ultimaVisita ? toMxDateKey(a.ultimaVisita) : null,
        score: a && a.scoreCount > 0 ? Math.round(a.scoreSum / a.scoreCount) : 0,
        own,
        competitor,
        unknown,
        presence,
      };
    });

    // Filtro de presencia (own/competitor/both); 'any'/ausente = todas.
    if (filters.presence && filters.presence !== 'any') {
      result = result.filter((r) => r.presence === filters.presence);
    }

    const unlocatedCount = result.filter((r) => !r.located).length;
    return { stores: result, total: result.length, unlocatedCount };
  }

  /**
   * Historial de visitas/exhibiciones de UNA tienda, separado propio vs
   * competencia. Reusa el parseo del JSONB de getStoresData (detail view).
   */
  async getStoreHistory(
    storeId: string,
    filters: { date_from?: string; date_to?: string },
    user: any,
  ) {
    if (!CommercialMapService.UUID_RE.test(storeId || '')) {
      throw new NotFoundException('Tienda no encontrada.');
    }
    const tenantId = this.tenantId(user);

    let storeQ = this.knex('stores as s')
      .leftJoin('zones as z', 'z.id', 's.zona_id')
      .where('s.id', storeId)
      .whereNull('s.deleted_at')
      .select('s.id', 's.nombre', 's.direccion', 's.zona_id', 'z.name as zona');
    if (tenantId) storeQ = storeQ.where('s.tenant_id', tenantId);
    const store = await storeQ.first();
    if (!store) throw new NotFoundException('Tienda no encontrada.');

    const requesterZonaId = await this.getRequesterZonaId(user);
    if (requesterZonaId && store.zona_id !== requesterZonaId) {
      throw new ForbiddenException('No puedes ver tiendas fuera de tu zona.');
    }

    // Catálogos para resolver nombres (mismo patrón que ReportsService).
    const [conceptos, ubicaciones, products, brands] = await Promise.all([
      this.knex('catalogs').where({ catalog_id: 'conceptos' }).select('id', 'value'),
      this.knex('catalogs').where({ catalog_id: 'ubicaciones' }).select('id', 'value'),
      this.knex('products').select('id', 'nombre', 'brand_id'),
      this.knex('brands').select('id', 'nombre'),
    ]);
    const conceptoMap: Record<string, string> = {};
    conceptos.forEach((c: any) => (conceptoMap[c.id] = c.value));
    const ubicacionMap: Record<string, string> = {};
    ubicaciones.forEach((u: any) => (ubicacionMap[u.id] = u.value));
    const brandMap: Record<string, string> = {};
    brands.forEach((b: any) => (brandMap[b.id] = b.nombre));
    const productMap: Record<string, string> = {};
    products.forEach((p: any) => (productMap[p.id] = p.nombre));

    let q = this.knex('daily_captures as dc')
      .where('dc.store_id', storeId)
      .select(
        'dc.id',
        'dc.folio',
        'dc.hora_inicio',
        'dc.hora_fin',
        'dc.captured_by_username',
        'dc.stats',
        'dc.exhibiciones',
      )
      .orderBy('dc.hora_inicio', 'desc');
    q = await this.applyCaptureScope(q, user);
    if (filters.date_from)
      q.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [
        filters.date_from,
      ]);
    if (filters.date_to)
      q.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [
        filters.date_to,
      ]);
    const rows = await q;

    let ownTotal = 0;
    let competitorTotal = 0;
    let unknownTotal = 0;
    let scoreSum = 0;

    const visits = rows.map((r: any) => {
      const stats = CommercialMapService.parseObj(r.stats);
      const score = Math.round(Number(stats.puntuacionTotal) || 0);
      scoreSum += score;
      const exhibiciones = CommercialMapService.parseArray(r.exhibiciones).map((e: any) => {
        const pm = e.perteneceMegaDulces === true ? true : e.perteneceMegaDulces === false ? false : null;
        if (pm === true) ownTotal++;
        else if (pm === false) competitorTotal++;
        else unknownTotal++;
        return {
          concepto: conceptoMap[e.conceptoId] || 'Sin clasificar',
          ubicacion: ubicacionMap[e.ubicacionId] || '',
          nivel: e.nivelEjecucion || '',
          score: e.puntuacionCalculada != null ? Number(e.puntuacionCalculada) : null,
          fotoUrl: e.fotoUrl || null,
          perteneceMegaDulces: pm,
          productos: (e.productosMarcados || [])
            .map((pid: string) => productMap[pid])
            .filter(Boolean),
        };
      });
      return {
        capture_id: r.id,
        folio: r.folio,
        fecha: toMxDateKey(r.hora_inicio),
        hora_inicio: r.hora_inicio,
        hora_fin: r.hora_fin,
        usuario: r.captured_by_username,
        score,
        exhibiciones,
      };
    });

    const ultimaVisita = rows.length > 0 ? toMxDateKey(rows[0].hora_inicio) : null;
    const diasSinVisita = ultimaVisita
      ? Math.floor((Date.now() - new Date(ultimaVisita).getTime()) / 86_400_000)
      : null;

    return {
      store: {
        id: store.id,
        nombre: store.nombre,
        direccion: store.direccion,
        zona: store.zona || '',
        totalVisitas: visits.length,
        ultimaVisita,
        diasSinVisita,
        score: visits.length > 0 ? Math.round(scoreSum / visits.length) : 0,
        ownTotal,
        competitorTotal,
        unknownTotal,
      },
      visits,
    };
  }
}
