import { Inject, Injectable, Logger, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import {
  KNEX_CONNECTION,
  TenantContextService,
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
 *
 * Scoping: a diferencia de los reportes, este módulo es STORE-céntrico. El
 * historial y los conteos traen TODAS las visitas de la tienda (acotado por
 * tenant + zona del requester, que ya controla QUÉ tiendas ve) — NO se filtra
 * por equipo del usuario (own/team), porque eso ocultaría visitas hechas por
 * otros reps en la misma tienda.
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

    // 2) Capturas agregadas por store_id (todas las visitas; tenant + fechas TZ MX).
    //    Sin filtro own/team: el merge solo conserva las tiendas visibles (zona).
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
    if (tenantId) cQ = cQ.where('dc.tenant_id', tenantId);
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
      .leftJoin('catalogs as c', 'c.id', 's.ruta_id')
      .where('s.id', storeId)
      .whereNull('s.deleted_at')
      .select('s.id', 's.nombre', 's.direccion', 's.zona_id', 'z.name as zona', 'c.value as ruta');
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
    if (tenantId) q = q.where('dc.tenant_id', tenantId);
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
        ruta: store.ruta || '',
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

  /**
   * Presencia de producto: dado `q` (contains ILIKE) o `product_ids` ya resueltos
   * (ej. del matcher IA, vía FE), devuelve las tiendas y las VISITAS donde esos
   * productos aparecen en `exhibiciones[].productosMarcados`. Store-céntrico
   * (tenant + zona del requester, sin filtro own/team), igual que el resto del módulo.
   */
  async getProductPresence(
    filters: { q?: string; product_ids?: string[]; date_from?: string; date_to?: string },
    user: any,
  ) {
    const tenantId = this.tenantId(user);
    const requesterZonaId = await this.getRequesterZonaId(user);
    const empty = { products: [], stores: [], totalStores: 0, totalVisits: 0 };

    // 1) Resolver product ids + metadata (marca para display).
    let products: any[];
    const explicitIds = (filters.product_ids || []).filter((id) =>
      CommercialMapService.UUID_RE.test(id),
    );
    if (explicitIds.length > 0) {
      let pQ = this.knex('products as p')
        .leftJoin('brands as b', 'b.id', 'p.brand_id')
        .whereIn('p.id', explicitIds)
        .select('p.id', 'p.nombre', 'b.nombre as brand_name');
      if (tenantId) pQ = pQ.where('p.tenant_id', tenantId);
      products = await pQ;
    } else if (filters.q && filters.q.trim().length >= 2) {
      const term = `%${filters.q.trim()}%`;
      let pQ = this.knex('products as p')
        .leftJoin('brands as b', 'b.id', 'p.brand_id')
        .whereNull('p.deleted_at')
        .where((bx: Knex.QueryBuilder) =>
          bx
            .where('p.nombre', 'ilike', term)
            .orWhere('p.sku', 'ilike', term)
            .orWhere('p.barcode', 'ilike', term),
        )
        .select('p.id', 'p.nombre', 'b.nombre as brand_name')
        .orderBy('p.nombre', 'asc')
        .limit(40);
      if (tenantId) pQ = pQ.where('p.tenant_id', tenantId);
      products = await pQ;
    } else {
      return empty;
    }

    const productIds: string[] = products.map((p: any) => p.id);
    if (productIds.length === 0) return empty;
    const productNameMap: Record<string, string> = {};
    products.forEach((p: any) => (productNameMap[p.id] = p.nombre));

    // 2) Capturas que contienen alguno de esos productos (contención JSONB, GIN-friendly).
    const orClauses = productIds.map(() => 'dc.exhibiciones @> ?::jsonb').join(' OR ');
    const containParams = productIds.map((id) =>
      JSON.stringify([{ productosMarcados: [id] }]),
    );
    let cQ = this.knex('daily_captures as dc')
      .whereNotNull('dc.store_id')
      .whereRaw(`(${orClauses})`, containParams)
      .select(
        'dc.id',
        'dc.store_id',
        'dc.folio',
        'dc.hora_inicio',
        'dc.captured_by_username',
        'dc.exhibiciones',
        'dc.latitud',
        'dc.longitud',
      )
      .orderBy('dc.hora_inicio', 'desc');
    if (tenantId) cQ = cQ.where('dc.tenant_id', tenantId);
    if (filters.date_from)
      cQ.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [
        filters.date_from,
      ]);
    if (filters.date_to)
      cQ.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [
        filters.date_to,
      ]);
    const caps = await cQ;

    // 3) Tiendas visibles (tenant + zona) → ruta/zona/coord master + acota lo visible.
    let sQ = this.knex('stores as s')
      .leftJoin('zones as z', 'z.id', 's.zona_id')
      .leftJoin('catalogs as c', 'c.id', 's.ruta_id')
      .whereNull('s.deleted_at')
      .select(
        's.id',
        's.nombre',
        's.latitud',
        's.longitud',
        'z.name as zona',
        'c.value as ruta',
      );
    if (tenantId) sQ = sQ.where('s.tenant_id', tenantId);
    if (requesterZonaId) sQ = sQ.where('s.zona_id', requesterZonaId);
    const stores = await sQ;
    const storeMap = new Map<string, any>();
    stores.forEach((s: any) => storeMap.set(s.id, s));

    // 4) Agrupar por tienda visible + coord híbrida + productos que matchearon por visita.
    const idSet = new Set(productIds);
    const grouped = new Map<string, any>();
    for (const r of caps) {
      const s = storeMap.get(r.store_id);
      if (!s) continue; // tienda fuera de la zona/tenant del requester → descartar
      let g = grouped.get(r.store_id);
      if (!g) {
        g = {
          id: s.id,
          nombre: s.nombre,
          ruta: s.ruta || '',
          zona: s.zona || '',
          lat: s.latitud != null ? Number(s.latitud) : null,
          lng: s.longitud != null ? Number(s.longitud) : null,
          coordTime: -1,
          lastSeen: null,
          visits: [],
        };
        grouped.set(r.store_id, g);
      }
      const matchedIds = new Set<string>();
      for (const e of CommercialMapService.parseArray(r.exhibiciones)) {
        for (const pid of e.productosMarcados || []) {
          if (idSet.has(pid)) matchedIds.add(pid);
        }
      }
      const matchedProducts = [...matchedIds]
        .map((pid) => productNameMap[pid])
        .filter(Boolean);
      g.visits.push({
        capture_id: r.id,
        folio: r.folio,
        fecha: toMxDateKey(r.hora_inicio),
        hora_inicio: r.hora_inicio,
        usuario: r.captured_by_username,
        matchedProducts,
        matchedCount: matchedProducts.length,
      });
      if (!g.lastSeen || r.hora_inicio > g.lastSeen) g.lastSeen = r.hora_inicio;
      // Fallback coord: si la tienda no tiene coord master, usar la última GPS de captura.
      const t = r.hora_inicio ? new Date(r.hora_inicio).getTime() : 0;
      if (s.latitud == null && r.latitud != null && t > g.coordTime) {
        g.lat = Number(r.latitud);
        g.lng = Number(r.longitud);
        g.coordTime = t;
      }
    }

    const resultStores = [...grouped.values()]
      .map((g) => ({
        id: g.id,
        nombre: g.nombre,
        ruta: g.ruta,
        zona: g.zona,
        lat: g.lat,
        lng: g.lng,
        located: g.lat != null && g.lng != null,
        visitCount: g.visits.length,
        lastSeen: g.lastSeen ? toMxDateKey(g.lastSeen) : null,
        visits: g.visits,
      }))
      .sort((a, b) => b.visitCount - a.visitCount);

    return {
      products: products.map((p: any) => ({
        id: p.id,
        nombre: p.nombre,
        brand_name: p.brand_name || '',
      })),
      stores: resultStores,
      totalStores: resultStores.length,
      totalVisits: resultStores.reduce((n, s) => n + s.visitCount, 0),
    };
  }
}
