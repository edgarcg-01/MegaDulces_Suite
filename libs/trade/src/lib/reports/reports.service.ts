import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { getDataScope } from '@megadulces/platform-core';
import { EventsService } from '../websocket/events.service';
import { ReportsCacheService } from './reports-cache.service';
import { MapMatchingService } from './map-matching.service';
import { toMxDateKey, todayMx } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly eventsService: EventsService,
    private readonly cache: ReportsCacheService,
    private readonly mapMatching: MapMatchingService,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {
    this.eventsService.onCaptureChange = async (affectedUserIds: string[]) => {
      // Rate-limit: si ya hay un broadcast en vuelo, acumular usuarios y salir.
      // El broadcast en curso re-revisará la cola al terminar.
      if (affectedUserIds && affectedUserIds.length > 0) {
        for (const uid of affectedUserIds) this.pendingAffectedUsers.add(uid);
      }
      if (this.metricsBroadcastInFlight) return;
      this.metricsBroadcastInFlight = true;

      try {
        await this.runMetricsBroadcast();
      } finally {
        this.metricsBroadcastInFlight = false;
        // Si llegaron más cambios mientras estábamos ocupados, programar otro
        // pase con un pequeño cool-down para coalescer bursts.
        if (this.pendingAffectedUsers.size > 0) {
          setTimeout(() => {
            // Re-disparar; los usuarios pendientes están en el set
            if (this.eventsService.onCaptureChange) {
              this.eventsService.onCaptureChange([]);
            }
          }, this.METRICS_COOLDOWN_MS).unref?.();
        }
      }
    };
  }

  private metricsBroadcastInFlight = false;
  private pendingAffectedUsers = new Set<string>();
  private readonly METRICS_COOLDOWN_MS = 1500;

  // Guard de columna `customer_id` en daily_captures: las capturas de vendor
  // se anclan al cliente (no a una tienda), así que cuando store_id es NULL el
  // nombre vive en commercial.customers.name. Si la columna no existe en este
  // entorno (deploy window pre-migración), omitimos el JOIN en vez de romper.
  private _hasCustomerIdColumn: boolean | null = null;
  private _hasCustomerIdCheckedAt = 0;
  private readonly CUSTOMER_ID_NEGATIVE_TTL_MS = 60_000;
  private async hasCustomerIdColumn(): Promise<boolean> {
    if (this._hasCustomerIdColumn === true) return true;
    const stale =
      this._hasCustomerIdColumn === false &&
      Date.now() - this._hasCustomerIdCheckedAt < this.CUSTOMER_ID_NEGATIVE_TTL_MS;
    if (stale) return false;
    try {
      const exists = await this.knex.schema
        .withSchema('trade')
        .hasColumn('daily_captures', 'customer_id');
      this._hasCustomerIdColumn = exists;
      this._hasCustomerIdCheckedAt = Date.now();
      return exists;
    } catch {
      this._hasCustomerIdColumn = false;
      this._hasCustomerIdCheckedAt = Date.now();
      return false;
    }
  }

  // Guard de columna `route_id` en daily_captures (ruta self-service / vendor).
  // Permite asociar capturas de vendor a una ruta aunque no tengan store_id.
  private _hasRouteIdColumn: boolean | null = null;
  private _hasRouteIdCheckedAt = 0;
  private async hasRouteIdColumn(): Promise<boolean> {
    if (this._hasRouteIdColumn === true) return true;
    const stale =
      this._hasRouteIdColumn === false &&
      Date.now() - this._hasRouteIdCheckedAt < this.CUSTOMER_ID_NEGATIVE_TTL_MS;
    if (stale) return false;
    try {
      const exists = await this.knex.schema
        .withSchema('trade')
        .hasColumn('daily_captures', 'route_id');
      this._hasRouteIdColumn = exists;
      this._hasRouteIdCheckedAt = Date.now();
      return exists;
    } catch {
      this._hasRouteIdColumn = false;
      this._hasRouteIdCheckedAt = Date.now();
      return false;
    }
  }

  private async runMetricsBroadcast() {
    const affectedUserIds = Array.from(this.pendingAffectedUsers);
    this.pendingAffectedUsers.clear();

    const before = this.cache.getHitRate();
    if (affectedUserIds.length > 0) {
      for (const uid of affectedUserIds) {
        this.cache.invalidateForUser(uid);
      }
    } else {
      this.cache.invalidateAllReports();
    }

    if (!this.eventsService.isServerReady) return;

    try {
      // Usar TZ MX: 'today' debe coincidir con el día calendario que ven los
      // usuarios en México, no con UTC (que rola al día siguiente a las 18:00 MX).
      const today = todayMx();
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      const startDate = toMxDateKey(startOfMonth);

      const filters = { startDate, endDate: today };

      const afterGlobal = this.cache.getHitRate();
      const lines = [`[Cache] invalidated. Hit rate: ${before.rate} → ${afterGlobal.rate}`];

      const connectedScopes = this.eventsService.getConnectedUserScopes();
      // Iteramos sesiones únicas: cada admin global recibe métricas SOLO de
      // su tenant; cada own/team recibe en su room scoped. No hay broadcast
      // global cross-tenant — sería un leak.
      const seen = new Map<string, boolean>();

      for (const sc of connectedScopes) {
        const key = `${sc.tenantId}:${sc.type}:${sc.userId}`;
        if (seen.has(key)) continue;
        seen.set(key, true);

        try {
          const user =
            sc.type === 'all'
              ? { sub: sc.userId, tenant_id: sc.tenantId, permissions: {}, rules: [{ action: 'manage', subject: 'all' }] }
              : sc.type === 'team'
                ? { sub: sc.userId, tenant_id: sc.tenantId, permissions: {}, rules: [{ action: 'read', subject: 'reports_team' }] }
                : { sub: sc.userId, tenant_id: sc.tenantId, permissions: {}, rules: [] };

          const [s, ds] = await Promise.all([
            this.getSummary(filters, user),
            this.getDailyScoresPerUser(filters, user),
          ]);

          const payload = {
            type: 'metrics:updated' as const,
            scope: sc.type === 'all' ? 'global' as const : sc.type,
            summary: s,
            dailyScores: ds,
          };

          if (sc.type === 'all') {
            this.eventsService.emitMetricsToGlobal(sc.tenantId, payload);
          } else {
            this.eventsService.emitMetricsToUser(sc.tenantId, sc.type, sc.userId, payload);
          }

          lines.push(`  ${sc.tenantId}/${sc.type}/${sc.userId}`);
        } catch (err) {
          this.logger.warn(
            `Failed to compute metrics for ${sc.tenantId}/${sc.type}/${sc.userId}: ${err.message}`,
          );
        }
      }

      this.logger.debug(lines.join('\n'));
    } catch (err) {
      this.logger.warn(`Failed to compute metrics update: ${err.message}`);
    }
  }

  async getSummary(
    filters: {
      startDate?: string;
      endDate?: string;
      zone?: string;
      supervisorId?: string;
      userIds?: string[];
    } = {},
    user: any,
  ) {
    const scope = getDataScope(user);
    const cacheKey = this.cache.buildKey('summary', {
      scopeType: scope.type,
      scopeUserId: scope.type !== 'all' ? scope.userId : 'all',
      ...filters,
    });

    const cached = this.cache.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const { query: dcQuery } = await this.buildBaseQuery(user, filters);
    // Mismo motivo que buildBaseQuery: el count de tiendas debe filtrar tenant
    // explícito (RLS bypasseado por el connection postgres).
    const sTenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    const sQuery = this.knex('stores');
    if (sTenantId) sQuery.where('tenant_id', sTenantId);

    // Filtrar por fecha actual para cierres de hoy. `today` debe ser el día
    // calendario en MX — con UTC, después de las 18:00 MX el "today" del
    // servidor avanza al día siguiente y se pierde la tarde de capturas.
    // El `DATE(hora_inicio)` en Postgres se evalúa en la TZ de México para
    // que coincida con el día calendario del negocio, no con UTC.
    const today = todayMx();
    const todayQuery = dcQuery.clone().whereRaw(
      "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') = ?",
      [today],
    );
    const [totalDailyToday] = await todayQuery.count('id as count');

    const [totalDaily] = await dcQuery.clone().count('id as count');
    const [totalTiendas] = await sQuery.count('id as count');

    // Calcular meta diaria: 5 visitas por día como base (puede ajustarse)
    const metaDiaria = 5;

    // Aggregates for the dashboard
    const [stats] = await dcQuery
      .clone()
      .select(
        this.knex.raw("SUM((stats->>'totalExhibiciones')::int) as visitas"),
        this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"),
        this.knex.raw("SUM(COALESCE(NULLIF((stats->>'ventaTotal')::float, 0), (stats->>'ventaAdicional')::float)) as ventas"),
        this.knex.raw(
          'AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min',
        ),
      );

    // Get Top Performer
    const [topPerformer] = (await dcQuery
      .clone()
      .select('captured_by_username')
      .select(
        this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"),
      )
      .groupBy('captured_by_username')
      .orderBy('avg_score', 'desc')
      .limit(1)) as any[];

    // Get conceptos catalog for mapping IDs to names
    const conceptos = await this.knex('catalogs')
      .where({ catalog_id: 'conceptos' })
      .select('id', 'value');
    const conceptoMap = {};
    conceptos.forEach((c) => {
      conceptoMap[c.id] = c.value.toLowerCase();
    });

    // Deep count of furniture types and photos
    const rows = await dcQuery.clone().select('exhibiciones');
    let totalPhotos = 0;
    const furnitureCounts: Record<string, number> = {
      vitrina: 0,
      exhibidor: 0,
      vitroleros: 0,
      paleteros: 0,
      tiras: 0,
      otros: 0,
    };

    rows.forEach((r) => {
      const exArray =
        typeof r.exhibiciones === 'string'
          ? JSON.parse(r.exhibiciones)
          : r.exhibiciones || [];
      exArray.forEach((ex: any) => {
        // Get concept name from catalog using conceptoId
        const conceptName = conceptoMap[ex.conceptoId] || '';

        // Count furniture by concept name
        if (conceptName.includes('vitrina')) furnitureCounts['vitrina']++;
        else if (conceptName.includes('exhibidor'))
          furnitureCounts['exhibidor']++;
        else if (conceptName.includes('vitrolero'))
          furnitureCounts['vitroleros']++;
        else if (conceptName.includes('paletero'))
          furnitureCounts['paleteros']++;
        else if (conceptName.includes('tira')) furnitureCounts['tiras']++;
        else furnitureCounts['otros']++;

        // Count photos
        if (ex.fotoUrl || ex.foto_url) {
          totalPhotos++;
        }
      });
    });

        const result = {
      status: 'Calculado Exitosamente',
      metricas_globales: {
        total_tiendas: Number(totalTiendas?.count || 0),
        cierres_diarios_registrados: Number(totalDaily?.count || 0),
        cierres_hoy: Number(totalDailyToday?.count || 0),
        meta_diaria: metaDiaria,
        visitas_totales: Number(stats?.visitas || 0),
        puntuacion_promedio: Math.round(Number(stats?.avg_score || 0)),
        ventas_totales: Number(stats?.ventas || 0),
        avg_duration_min: Number(stats?.avg_duration_min || 0).toFixed(1),
        total_fotos: totalPhotos,
        mejor_ejecutivo: topPerformer?.captured_by_username || 'N/A',
        desglose_muebles: furnitureCounts,
      },
      generado_el: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  async getDailyCompliance(
    filters: {
      startDate?: string;
      endDate?: string;
      zone?: string;
      supervisorId?: string;
      userIds?: string[];
    },
    user: any,
  ) {
    const scope = getDataScope(user);
    const cacheKey = this.cache.buildKey('daily_compliance', {
      scopeType: scope.type,
      scopeUserId: scope.type !== 'all' ? scope.userId : 'all',
      ...filters,
    });

    const cached = this.cache.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const { query: dcQuery } = await this.buildBaseQuery(user, filters);
    const sTenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    const sQuery = this.knex('stores');
    if (sTenantId) sQuery.where('tenant_id', sTenantId);

    const [totalDaily] = await dcQuery.clone().count('id as count');
    const [totalTiendas] = await sQuery.count('id as count');

    const [stats] = await dcQuery.clone().select(
      this.knex.raw("SUM((stats->>'totalExhibiciones')::int) as visitas"),
      this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"),
      this.knex.raw("SUM(COALESCE(NULLIF((stats->>'ventaTotal')::float, 0), (stats->>'ventaAdicional')::float)) as ventas"),
      this.knex.raw('AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min'),
    );

    const conceptos = await this.knex('catalogs')
      .where({ catalog_id: 'conceptos' })
      .select('id', 'value');
    const conceptoMap = {};
    conceptos.forEach((c) => { conceptoMap[c.id] = c.value.toLowerCase(); });

    const rows = await dcQuery.clone().select('exhibiciones');
    let totalPhotos = 0;
    const furnitureCounts: Record<string, number> = {
      vitrina: 0, exhibidor: 0, vitroleros: 0, paleteros: 0, tiras: 0, otros: 0,
    };

    rows.forEach((r) => {
      const exArray = typeof r.exhibiciones === 'string' ? JSON.parse(r.exhibiciones) : r.exhibiciones || [];
      exArray.forEach((ex: any) => {
        const conceptName = conceptoMap[ex.conceptoId] || '';
        if (conceptName.includes('vitrina')) furnitureCounts['vitrina']++;
        else if (conceptName.includes('exhibidor')) furnitureCounts['exhibidor']++;
        else if (conceptName.includes('vitrolero')) furnitureCounts['vitroleros']++;
        else if (conceptName.includes('paletero')) furnitureCounts['paleteros']++;
        else if (conceptName.includes('tira')) furnitureCounts['tiras']++;
        else furnitureCounts['otros']++;
        if (ex.fotoUrl || ex.foto_url) totalPhotos++;
      });
    });

    const result = {
      metricas_diarias: {
        cierres_diarios: Number(totalDaily?.count || 0),
        total_tiendas: Number(totalTiendas?.count || 0),
        visitas_totales: Number(stats?.visitas || 0),
        puntuacion_promedio: Math.round(Number(stats?.avg_score || 0)),
        ventas_totales: Number(stats?.ventas || 0),
        avg_duration_min: Number(stats?.avg_duration_min || 0).toFixed(1),
        total_fotos: totalPhotos,
        desglose_muebles: furnitureCounts,
      },
      generado_el: new Date().toISOString(),
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  async getFilteredData(
    filters: {
      startDate?: string;
      endDate?: string;
      userId?: string;
      userIds?: string[];
      zone?: string;
      supervisorId?: string;
      page?: string;
      pageSize?: string;
      include?: string;
    },
    user: any,
  ) {
    this.logger.debug(
      `getFilteredData user=${user.username} role=${user.role_name} filters=${JSON.stringify(filters)}`,
    );

    // Paginación obligatoria: capamos a MAX_PAGE_SIZE para evitar cargar 10k+
    // filas con JSONB pesado en la response. NOTA: las agregaciones se hacen
    // sobre el set COMPLETO filtrado (no paginado) — antes había bug donde
    // métricas se calculaban solo sobre la página, mintiendo cuando había
    // total > pageSize.
    const MAX_PAGE_SIZE = 500;
    const DEFAULT_PAGE_SIZE = 200;
    // Cap defensivo para el query de agregación. Más de 20k visitas en un
    // solo filtro es un caso raro; si llega, loguea + cap. Si se vuelve
    // común, mover a agregación SQL pura.
    const MAX_AGG_ROWS = 20000;
    const page = filters.page ? parseInt(filters.page, 10) : 1;
    const rawPageSize = filters.pageSize ? parseInt(filters.pageSize, 10) : DEFAULT_PAGE_SIZE;
    const safePage = page > 0 ? page : 1;
    // pageSize=0 ya no significa "sin paginación" — se trata como DEFAULT.
    const safePageSize = Math.min(rawPageSize > 0 ? rawPageSize : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const include = filters.include || '';

    // Tenant filter explícito (defense in depth — además del RLS que ya
    // aplica vía TenantKnexService). El user del JWT trae `tenant_id` desde
    // auth-mt; si no viene (JWT legacy) caemos al context CLS.
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;

    // Las capturas de vendor no traen store_id (se anclan a customer_id y el
    // backend deriva el store de customer.store_id; si el cliente no tiene
    // tienda mapeada, store_id queda NULL). Caemos al nombre del cliente para
    // que no aparezca "Tienda sin nombre" cuando sí hay un cliente vinculado.
    const hasCustomerId = await this.hasCustomerIdColumn();

    const query = this.knex('daily_captures as dc')
      .leftJoin('stores as s', 's.id', 'dc.store_id');

    if (hasCustomerId) {
      query
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'dc.customer_id');
          if (tenantId) this.andOn('c.tenant_id', '=', query.client.raw('?', [tenantId]));
        })
        .select(
          'dc.*',
          this.knex.raw('COALESCE(s.nombre, c.name) as cliente_nombre'),
          's.direccion as cliente_direccion',
        );
    } else {
      query.select(
        'dc.*',
        's.nombre as cliente_nombre',
        's.direccion as cliente_direccion',
      );
    }

    if (tenantId) {
      query.where('dc.tenant_id', tenantId);
    }

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      query.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        query.whereIn('user_id', teamIds);
      }
    }

    if (filters.userId) query.where('user_id', filters.userId);

    // Si hay supervisorId, obtener IDs del equipo y filtrar por ellos
    if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined') {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      query.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
      query.whereIn('user_id', filters.userIds);
    }

    if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined') {
      const zone = await this.knex('zones').where({ id: filters.zone }).first();
      if (zone && zone.name) {
        // Match tolerante (case/whitespace)
        query.whereRaw('LOWER(TRIM(zona_captura)) = LOWER(TRIM(?))', [zone.name]);
      } else {
        this.logger.warn(`Zone not found for ID: ${filters.zone}`);
      }
    }

    // Snapshot con TODOS los filtros menos fechas → base para el período
    // anterior (tendencias prev_*). Se clona ANTES de aplicar el rango actual.
    const baseForPrev = query.clone();

    if (filters.startDate) {
      query.whereRaw(
        "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?",
        [filters.startDate],
      );
    }
    if (filters.endDate) {
      query.whereRaw(
        "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?",
        [filters.endDate],
      );
    }

    const [{ total }] = await query.clone().clearSelect().clearOrder().count('* as total');
    const totalNum = Number(total) || 0;
    const orderedQuery = query.clone().orderBy('hora_inicio', 'desc');
    // Página para devolver al cliente (tabla).
    const rows = await orderedQuery
      .limit(safePageSize)
      .offset((safePage - 1) * safePageSize);

    // Set COMPLETO para agregaciones — solo columnas necesarias (stats +
    // exhibiciones + fecha + user_id) para no traer toda la fila con joins.
    // Si total > MAX_AGG_ROWS, cap + warn (las métricas serán aproximación).
    let aggRows: any[];
    if (totalNum > MAX_AGG_ROWS) {
      this.logger.warn(
        `getFilteredData: total=${totalNum} > MAX_AGG_ROWS=${MAX_AGG_ROWS} — métricas calculadas sobre primeros ${MAX_AGG_ROWS}`,
      );
      aggRows = await query
        .clone()
        .clearSelect()
        .select('dc.stats', 'dc.exhibiciones', 'dc.fecha', 'dc.hora_inicio', 'dc.user_id', 'dc.captured_by_username')
        .orderBy('hora_inicio', 'desc')
        .limit(MAX_AGG_ROWS);
    } else {
      aggRows = await query
        .clone()
        .clearSelect()
        .select('dc.stats', 'dc.exhibiciones', 'dc.fecha', 'dc.hora_inicio', 'dc.user_id', 'dc.captured_by_username');
    }
    this.logger.debug(
      `getFilteredData total=${totalNum} pageReturned=${rows.length} aggRows=${aggRows.length} page=${safePage} pageSize=${safePageSize} tenant=${tenantId ?? 'none'}`,
    );

    // Get conceptos catalog for mapping IDs to names contextually faster
    const conceptos = await this.knex('catalogs')
      .where({ catalog_id: 'conceptos' })
      .select('id', 'value');
    const conceptoMap: Record<string, string> = {};
    conceptos.forEach((c) => {
      conceptoMap[c.id] = c.value; // Guardamos el nombre original para display
    });
    // Red de seguridad: IDs viejos de clientes con catálogo desincronizado
    // (trade.catalog_aliases old_id → current_id) resuelven al concepto vigente.
    // Defensivo: la tabla no existe en entornos legacy.
    try {
      const aliases = await this.knex('catalog_aliases')
        .where({ catalog_id: 'conceptos' })
        .whereNull('deleted_at')
        .select('old_id', 'current_id');
      aliases.forEach((a) => {
        if (conceptoMap[a.current_id]) conceptoMap[a.old_id] = conceptoMap[a.current_id];
      });
    } catch {
      /* tabla catalog_aliases ausente en este entorno */
    }

    // Get all products and brands for mapping IDs to names (only if include has 'products')
    const includeProducts = include.includes('products');
    let productMap: Record<string, { name: string; brandName: string }> = {};
    let brandMap: Record<string, string> = {};
    if (includeProducts) {
      const products = await this.knex('products').select('id', 'nombre', 'brand_id');
      const brands = await this.knex('brands').select('id', 'nombre');
      
      brands.forEach(b => brandMap[b.id] = b.nombre);
      products.forEach(p => {
        productMap[p.id] = { 
          name: p.nombre, 
          brandName: brandMap[p.brand_id] || 'Otras' 
        };
      });
      
      this.logger.debug(`productMap size=${Object.keys(productMap).length}`);
    }

    // Parse y normaliza la PÁGINA que se devuelve al cliente (tabla).
    const normalizedRows = rows.map((row) => {
      const rawStats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const normalizedStats = {
        ...rawStats,
        ventaTotal: (rawStats.ventaTotal || 0) > 0 ? rawStats.ventaTotal : (rawStats.ventaAdicional || 0),
      };
      return {
        ...row,
        stats: normalizedStats,
        exhibiciones: typeof row.exhibiciones === 'string' ? JSON.parse(row.exhibiciones) : row.exhibiciones || [],
      };
    });

    // Calcular métricas agregadas sobre el SET COMPLETO (no paginado).
    // Antes esto se hacía sobre `normalizedRows` (solo 200-500 filas) y
    // mentía cuando total > pageSize. Ahora usamos `aggRows` que trae todo
    // el filtro (capado a MAX_AGG_ROWS con warn).
    let totalVisitas = 0;
    let totalScore = 0;
    let totalVentas = 0;
    let totalUniqueProducts = 0;
    let totalExhibiciones = 0;
    let totalCapturesAgg = 0;
    let avgProductsPerVisit = '0.00';
    const dailyTrend: Record<string, any> = {};
    const productStats: Record<string, { total: number, exhibidores: Record<string, number> }> = {};
    const exhibidoresHealth = { optimo: 0, regular: 0, critico: 0 };
    const sellerProductStats: Record<string, Record<string, number>> = {};

    aggRows.forEach((row) => {
      const rawStats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const stats = {
        ...rawStats,
        ventaTotal: (rawStats.ventaTotal || 0) > 0 ? rawStats.ventaTotal : (rawStats.ventaAdicional || 0),
      };
      const exhibiciones =
        typeof row.exhibiciones === 'string'
          ? JSON.parse(row.exhibiciones)
          : row.exhibiciones || [];
      const score = stats.puntuacionTotal || 0;
      const ventas = stats.ventaTotal || 0;

      // 1 captura = 1 visita (cada daily_capture es una visita a tienda con su
      // store_id/hora_inicio). Antes se ponderaba por totalExhibiciones, lo que
      // inflaba "Visitas" (contaba exhibiciones, no visitas) y rompía la meta.
      totalCapturesAgg += 1;
      totalVisitas += 1;
      totalScore += score;
      totalVentas += ventas;

      // Todas las fechas del país se calculan en la TZ de MX (ver mx-date.ts).
      const dateKey = toMxDateKey(row.fecha) || toMxDateKey(row.hora_inicio);
      if (!dailyTrend[dateKey]) {
        dailyTrend[dateKey] = { visits: 0, score: 0, count: 0 };
      }
      dailyTrend[dateKey].visits += 1;
      dailyTrend[dateKey].score += score;
      dailyTrend[dateKey].count += 1;

      // Product Analysis Aggregation (only if include has 'products')
      exhibiciones.forEach((ex: any) => {
        const conceptoId = ex.conceptoId || 'otros';
        const rawName = conceptoMap[conceptoId];
        // Si el conceptoId no resuelve (UUID huérfano de un catálogo
        // desincronizado, o null) NO volcamos el valor crudo → "Sin clasificar".
        // Si resuelve, normalizamos variantes del mismo concepto colapsando
        // guion bajo→espacio ("Sin_exhibidor" ↔ "Sin exhibidor") para no
        // fragmentar el conteo en filas separadas.
        const conceptoName = rawName
          ? rawName.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
          : 'Sin clasificar';
        const productosMarcados = ex.productosMarcados || [];

        const val = String(ex.nivelEjecucion).toLowerCase();
        const isOptimo = val === 'alto' || val === 'excelente' || val === 'optimo';
        const isRegular = val === 'medio' || val === 'regular';

        if (isOptimo) exhibidoresHealth.optimo++;
        else if (isRegular) exhibidoresHealth.regular++;
        else exhibidoresHealth.critico++;

        if (includeProducts) {
          productosMarcados.forEach((pid: string) => {
            if (!productStats[pid]) {
              productStats[pid] = { total: 0, exhibidores: {} };
            }
            productStats[pid].total += 1;

            if (!productStats[pid].exhibidores[conceptoName]) {
              productStats[pid].exhibidores[conceptoName] = 0;
            }
            productStats[pid].exhibidores[conceptoName] += 1;

            // Agregar productos por usuario (fallback a username si user_id viene null).
            const userId = row.user_id || row.captured_by_username;
            if (!sellerProductStats[userId]) {
              sellerProductStats[userId] = {};
            }
            if (!sellerProductStats[userId][pid]) {
              sellerProductStats[userId][pid] = 0;
            }
            sellerProductStats[userId][pid] += 1;
          });
        }
      });
    });

    // Find PIDs that are in productStats but not in productMap (deleted products)
    // Remove them from productStats to avoid showing deleted products in reports
    if (includeProducts) {
      const allPIDsInStats = Object.keys(productStats);
      const missingPIDs = allPIDsInStats.filter(pid => !productMap[pid]);
      this.logger.debug(
        `productStats: total=${allPIDsInStats.length} missingInMap=${missingPIDs.length} mapSize=${Object.keys(productMap).length}`,
      );
      
      if (missingPIDs.length > 0) {
        const missingProducts = await this.knex('products')
          .whereIn('id', missingPIDs)
          .select('id', 'nombre', 'brand_id');
        
        this.logger.debug(`Found missing products in DB: ${missingProducts.length}`);
        
        missingProducts.forEach(p => {
          productMap[p.id] = { 
            name: p.nombre, 
            brandName: brandMap[p.brand_id] || 'Otras' 
          };
          this.logger.debug(`Added to productMap: ${p.id} → ${p.nombre}`);
        });
        
        const stillMissing = missingPIDs.filter(pid => !productMap[pid]);
        stillMissing.forEach(pid => {
          delete productStats[pid];
          this.logger.warn(`Removed deleted product from productStats: ${pid}`);
        });
        
        this.logger.debug(
          `Products: missing=${missingPIDs.length} foundInDb=${missingProducts.length} deleted=${stillMissing.length} after=${Object.keys(productStats).length}`,
        );
      }

      totalUniqueProducts = Object.keys(productStats).length;
      avgProductsPerVisit = totalVisitas > 0 ? (totalUniqueProducts / totalVisitas).toFixed(2) : '0.00';
      totalExhibiciones = Object.values(productStats).reduce((sum, p) => sum + p.total, 0);
    }
    
    const totalExhibidores = exhibidoresHealth.optimo + exhibidoresHealth.regular + exhibidoresHealth.critico;
    const healthRate = totalExhibidores > 0 ? +((exhibidoresHealth.optimo / totalExhibidores) * 100).toFixed(2) : 0;

    // `count` = capturas totales del rango filtrado (NO el largo de la página).
    // `avgScore` = score promedio sobre el set completo, no sobre los 200 visibles.
    // Antes ambos venían de `normalizedRows.length` y mentían si total > pageSize.
    const metrics: Record<string, any> = {
      totalVisitas,
      avgScore: totalCapturesAgg > 0 ? Math.round(totalScore / totalCapturesAgg) : 0,
      totalVentas,
      avgVentaPorVisita: totalVisitas > 0 ? +(totalVentas / totalVisitas).toFixed(2) : 0,
      count: totalCapturesAgg,
      // Conteo real de exhibiciones evaluadas (entradas de exhibición), no
      // "marcas de producto". totalExhibiciones (product-marks) queda como
      // métrica interna del tab de productos.
      totalExhibidores,
      totalExhibiciones,
      // Promedio de SKUs distintos por visita (surtido). Reemplaza el mal
      // llamado "stockoutRate" (no computable: la captura no tiene stock esperado).
      productsPerVisit: +avgProductsPerVisit,
      stockoutRate: avgProductsPerVisit,
      healthRate,
      uniqueProducts: totalUniqueProducts,
    };

    // Tendencias prev_*: mismas métricas headline sobre el período inmediato
    // anterior (mismo tamaño de ventana). Alimenta el delta ▲/▼ de las cards.
    if (filters.startDate && filters.endDate) {
      const dur =
        new Date(filters.endDate).getTime() - new Date(filters.startDate).getTime();
      const prevEndDate = new Date(new Date(filters.startDate).getTime() - 86400000);
      const prevStartDate = new Date(prevEndDate.getTime() - dur);
      const prevStart = toMxDateKey(prevStartDate);
      const prevEnd = toMxDateKey(prevEndDate);
      const prevAgg = await baseForPrev
        .clone()
        .clearSelect()
        .select('dc.stats', 'dc.exhibiciones')
        .whereRaw("DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [prevStart])
        .whereRaw("DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [prevEnd])
        .limit(MAX_AGG_ROWS);
      const pm = this.headlineMetrics(prevAgg, includeProducts);
      metrics.prev_visitas = pm.totalVisitas;
      metrics.prev_score = pm.avgScore;
      metrics.prev_venta = pm.totalVentas;
      metrics.prev_avgVenta = pm.avgVentaPorVisita;
      metrics.prev_exhibiciones = pm.totalExhibidores;
      metrics.prev_stockoutRate = pm.productsPerVisit;
      metrics.prev_healthRate = pm.healthRate;
      metrics.prev_uniqueProducts = pm.uniqueProducts;
    }

    const trendData = Object.keys(dailyTrend)
      .sort()
      .map((date) => ({
        date,
        visits: dailyTrend[date].visits,
        avgScore: Math.round(dailyTrend[date].score / dailyTrend[date].count),
      }));

    return {
      total: Number(total),
      metrics,
      trendData,
      ...(includeProducts ? { productStats, productMap, sellerProductStats } : {}),
      exhibidoresHealth,
      rows: normalizedRows,
    };
  }

  /**
   * Métricas headline (sin productStats/dailyTrend pesados) sobre un set de
   * filas agregadas. Usado para el período anterior (tendencias prev_*).
   * 1 fila = 1 visita. uniqueProducts/productsPerVisit solo si includeProducts.
   */
  private headlineMetrics(
    aggRows: any[],
    includeProducts: boolean,
  ): {
    totalVisitas: number;
    avgScore: number;
    totalVentas: number;
    avgVentaPorVisita: number;
    totalExhibidores: number;
    productsPerVisit: number;
    healthRate: number;
    uniqueProducts: number;
  } {
    let visits = 0;
    let score = 0;
    let ventas = 0;
    const health = { optimo: 0, regular: 0, critico: 0 };
    const pids = new Set<string>();
    for (const row of aggRows) {
      const raw = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const venta = (raw.ventaTotal || 0) > 0 ? raw.ventaTotal : raw.ventaAdicional || 0;
      visits += 1;
      score += raw.puntuacionTotal || 0;
      ventas += venta;
      const exhib =
        typeof row.exhibiciones === 'string'
          ? JSON.parse(row.exhibiciones)
          : row.exhibiciones || [];
      for (const ex of exhib) {
        const val = String(ex.nivelEjecucion).toLowerCase();
        if (val === 'alto' || val === 'excelente' || val === 'optimo') health.optimo++;
        else if (val === 'medio' || val === 'regular') health.regular++;
        else health.critico++;
        if (includeProducts) {
          for (const pid of ex.productosMarcados || []) pids.add(pid);
        }
      }
    }
    const totalExhibidores = health.optimo + health.regular + health.critico;
    return {
      totalVisitas: visits,
      avgScore: visits > 0 ? Math.round(score / visits) : 0,
      totalVentas: ventas,
      avgVentaPorVisita: visits > 0 ? +(ventas / visits).toFixed(2) : 0,
      totalExhibidores,
      productsPerVisit: visits > 0 ? +(pids.size / visits).toFixed(2) : 0,
      healthRate:
        totalExhibidores > 0 ? +((health.optimo / totalExhibidores) * 100).toFixed(2) : 0,
      uniqueProducts: pids.size,
    };
  }

  async exportCsvInBuffer(
    filters: {
      startDate?: string;
      endDate?: string;
      userId?: string;
      userIds?: string[];
      zone?: string;
      supervisorId?: string;
    },
    user: any,
  ) {
    const { query } = await this.buildBaseQuery(user, filters);
    // CSV solo necesita estos campos — evitamos cargar el JSONB `exhibiciones`
    // que puede ser muy pesado (varios MB por captura con muchas fotos).
    query.select(
      'folio',
      'captured_by_username',
      'zona_captura',
      'fecha',
      'stats',
    );
    if (filters.userId) query.where('user_id', filters.userId);

    const data = await query.orderBy('fecha', 'desc');

    let csvString = 'FOLIO,EJECUTIVO,ZONA,FECHA,VISITAS,SCORE,VENTA\n';

    for (const row of data) {
      const stats =
        typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const ventaTotal = (stats.ventaTotal || 0) > 0 ? stats.ventaTotal : (stats.ventaAdicional || 0);
      // CSV: fecha en TZ MX para que un export hecho a las 18:30 MX no liste
      // las visitas de hoy como de "ayer".
      const fecha = toMxDateKey(row.fecha);
      csvString += `${row.folio},${row.captured_by_username},${row.zona_captura},${fecha},${stats.totalExhibiciones || 0},${stats.puntuacionTotal || 0},${ventaTotal}\n`;
    }

    return csvString;
  }

  async deleteReport(id: string, user: any) {
    const report = await this.knex('daily_captures').where({ id }).first();

    if (!report) {
      throw new Error('Reporte no encontrado');
    }

    // Role check: Only superadmin or Permission allowed (controller handles Permission)
    // Here we just perform the deletion.
    this.logger.log(`Deleting report ${id} by user ${user.username}`);
    await this.knex('daily_captures').where({ id }).del();

    this.cache.invalidateAllReports();

    // tenant_id puede venir del row (multi-tenant DB) o del context CLS.
    // Si ninguno está, no emitimos para no leakear cross-tenant.
    const tenantId = report.tenant_id || this.tenantContext?.get()?.tenantId;
    if (tenantId) {
      this.eventsService.emitCaptureDeleted({
        type: 'capture:deleted',
        captureId: id,
        userId: report.user_id,
        tenantId,
      });
    } else {
      this.logger.warn(`Skipping capture:deleted emit — sin tenant_id (id=${id})`);
    }

    return { success: true, message: 'Reporte eliminado correctamente' };
  }

  async getDailyScoresPerUser(
    filters: {
      startDate?: string;
      endDate?: string;
      zone?: string;
      supervisorId?: string;
      userIds?: string[];
    },
    user: any,
  ) {
    try {
      this.logger.debug(`START getDailyScoresPerUser user=${user?.sub} filters=${JSON.stringify(filters)}`);

      const scope = getDataScope(user || { sub: '' });
      const cacheKey = this.cache.buildKey('daily_scores', {
        scopeType: scope.type,
        scopeUserId: scope.type !== 'all' ? scope.userId : 'all',
        ...filters,
      });

      const cached = this.cache.get<any>(cacheKey);
      if (cached) {
        return cached;
      }

      const dcQuery = this.knex('daily_captures');
      
      // Select with explicit COALESCE to avoid nulls in calculations.
      // `DATE(hora_inicio AT TIME ZONE ...)` para que el día calendario
      // refleje MX, no UTC del servidor (visitas post-18:00 MX se contaban
      // como del día siguiente).
      dcQuery.select(
        'user_id',
        'captured_by_username',
        this.knex.raw(
          "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') as fecha",
        ),
        this.knex.raw("AVG(COALESCE((stats->>'puntuacionTotal')::float, 0)) as puntuacion"),
        // Suma REAL de puntos del día (no avg) — necesario para volumen acumulado.
        this.knex.raw("SUM(COALESCE((stats->>'puntuacionTotal')::float, 0)) as total"),
        // Conteo de visitas del día — habilita "puntos por visita" + adherencia.
        this.knex.raw('COUNT(*) as visitas'),
      );

      // Scope filtering
      try {
        if (scope.type === 'own') {
          dcQuery.where('user_id', scope.userId || '');
        } else if (scope.type === 'team') {
          if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined' && scope.userId.length > 5) {
            const teamIds = await this.getTeamIds(scope.userId);
            if (teamIds.length > 0) dcQuery.whereIn('user_id', teamIds);
          }
        }
      } catch (scopeErr) {
        this.logger.error(`Scope check failed: ${scopeErr.message}`);
      }

      // Date filtering — TZ MX (las fechas del cliente son MX-local).
      if (filters.startDate && filters.startDate !== 'null' && filters.startDate !== 'undefined') {
        dcQuery.whereRaw(
          "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?",
          [filters.startDate],
        );
      }
      if (filters.endDate && filters.endDate !== 'null' && filters.endDate !== 'undefined') {
        dcQuery.whereRaw(
          "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?",
          [filters.endDate],
        );
      }

      // Metadata filtering (zone) — match case/whitespace-tolerant
      if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined' && filters.zone.length > 5) {
        try {
          const zone = await this.knex('zones').where({ id: filters.zone }).first();
          if (zone && zone.name) {
            dcQuery.whereRaw('LOWER(TRIM(zona_captura)) = LOWER(TRIM(?))', [zone.name]);
          }
        } catch (zErr) {
          this.logger.error(`Zone query failed: ${zErr.message}`);
        }
      }

      // Supervisor / Team filtering
      if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined' && filters.supervisorId.length > 5) {
        try {
          const teamIds = await this.getTeamIds(filters.supervisorId);
          if (teamIds.length > 0) dcQuery.whereIn('user_id', teamIds);
        } catch (tErr) {
          this.logger.error(`Team query failed: ${tErr.message}`);
        }
      } else if (filters.userIds && filters.userIds.length > 0) {
        const ids = Array.isArray(filters.userIds) ? filters.userIds : [filters.userIds];
        const validIds = ids.filter(id => id && id !== 'null' && id !== 'undefined' && id.length > 5);
        if (validIds.length > 0) dcQuery.whereIn('user_id', validIds);
      }

      dcQuery.groupBy(
        'user_id',
        'captured_by_username',
        this.knex.raw("DATE(hora_inicio AT TIME ZONE 'America/Mexico_City')"),
      );
      dcQuery.orderBy('captured_by_username', 'asc');
      dcQuery.orderByRaw("DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') asc");

      this.logger.debug('Executing SQL for Daily Scores');
      const rows = await dcQuery;
      this.logger.debug(`Daily scores rows fetched: ${rows.length}`);

      const metaDiaria = 5;
      const userMap = new Map<
        string,
        {
          nombre: string;
          scores: { fecha: string; puntuacion: number; total: number; visitas: number }[];
          metaDiaria: number;
        }
      >();

      for (const row of rows) {
        if (!userMap.has(row.user_id)) {
          userMap.set(row.user_id, { nombre: row.captured_by_username, scores: [], metaDiaria });
        }

        // fecha del score en TZ MX — consumido por /seguimiento que agrupa
        // por día calendario para el chart per-usuario.
        const fechaStr = toMxDateKey(row.fecha) || 'n/a';

        userMap.get(row.user_id)!.scores.push({
          fecha: fechaStr,
          // Promedio por día (compat con chart histórico).
          puntuacion: Math.round(Number(row.puntuacion) || 0),
          // Suma REAL de puntos del día — habilita modo "Volumen".
          total: Math.round(Number(row.total) || 0),
          // Conteo de visitas — habilita modos "Adherencia" y "Eficiencia".
          visitas: Number(row.visitas) || 0,
        });
      }

      const result = { users: Array.from(userMap.values()) };
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.logger.error(`Critical error in getDailyScoresPerUser: ${error.message}`, error.stack);
      return { users: [] };
    }
  }

  /**
   * Construye una query base sobre `daily_captures` aplicando, en orden:
   *  1. Scope (own / team / all) basado en el JWT del usuario
   *  2. Filtros de fecha (startDate / endDate)
   *  3. Filtro de zona (case/whitespace-tolerant)
   *  4. Filtro por supervisor (resuelve teamIds) o por userIds explícitos
   *
   * IMPORTANTE: Knex.QueryBuilder es "thenable" — si una función `async`
   * retorna directamente un QueryBuilder, el `await` LO EJECUTA en vez de
   * pasarlo (resuelve a un array de filas). Por eso envolvemos en `{ query }`.
   * Llamar con: `const { query: dcQuery } = await this.buildBaseQuery(...)`.
   */
  private async buildBaseQuery(
    user: any,
    filters: {
      startDate?: string;
      endDate?: string;
      zone?: string;
      supervisorId?: string;
      userIds?: string[];
    },
  ): Promise<{ query: Knex.QueryBuilder }> {
    const scope = getDataScope(user);
    let query = this.knex('daily_captures');

    // 0. Tenant isolation (defense-in-depth). El connection legacy es `postgres`
    // y BYPASSEA RLS, así que el aislamiento NO viene de la policy — hay que
    // filtrar explícito. getFilteredData ya lo hacía; getSummary/
    // getDailyScoresPerUser (que usan este base) no, dejando un leak latente
    // apenas exista un 2do tenant. tenant_id sale del JWT o del CLS context.
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    }

    // 1. Scope
    if (scope.type === 'own') {
      query = query.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        // Si por algún motivo no hay teamIds (supervisor sin equipo),
        // forzamos resultado vacío en lugar de quitar el filtro
        query = query.whereIn('user_id', teamIds.length > 0 ? teamIds : ['__none__']);
      } else {
        // Scope team con userId inválido → no debe ver nada (fallar cerrado)
        this.logger.warn(`buildBaseQuery: team scope with invalid userId; denying access`);
        query = query.whereRaw('1=0');
      }
    }

    // 2. Fechas
    if (filters.startDate) {
      query.whereRaw(
        "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?",
        [filters.startDate],
      );
    }
    if (filters.endDate) {
      query.whereRaw(
        "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?",
        [filters.endDate],
      );
    }

    // 3. Zona (tolerante a case/whitespace)
    if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined') {
      const zone = await this.knex('zones').where({ id: filters.zone }).first();
      if (zone && zone.name) {
        query.whereRaw('LOWER(TRIM(zona_captura)) = LOWER(TRIM(?))', [zone.name]);
      } else {
        this.logger.warn(`Zone not found for ID: ${filters.zone}`);
      }
    }

    // 4. Supervisor / userIds explícitos
    if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined') {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      query.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
      query.whereIn('user_id', filters.userIds);
    }

    return { query };
  }

  // Cache de team-ids con TTL corto — evita N+1 cuando varios endpoints/loops
  // consultan al mismo supervisor en una ventana corta (típico en onCaptureChange).
  private readonly teamIdsCache = new Map<string, { ids: string[]; expiresAt: number }>();
  private readonly TEAM_IDS_TTL_MS = 30_000;

  private async getTeamIds(supervisorId: string): Promise<string[]> {
    if (!supervisorId || supervisorId === 'null' || supervisorId === 'undefined') {
      return [];
    }

    // UUID regex check to prevent Postgres error
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supervisorId);
    if (!isUuid) return [];

    const now = Date.now();
    const cached = this.teamIdsCache.get(supervisorId);
    if (cached && cached.expiresAt > now) {
      return cached.ids;
    }

    const team = await this.knex('users')
      .select('id')
      .where('supervisor_id', supervisorId)
      .orWhere('id', supervisorId);

    const ids = team.map((u) => u.id);
    this.teamIdsCache.set(supervisorId, { ids, expiresAt: now + this.TEAM_IDS_TTL_MS });

    // Mantener el Map acotado (eviction simple por tamaño)
    if (this.teamIdsCache.size > 200) {
      const firstKey = this.teamIdsCache.keys().next().value;
      if (firstKey) this.teamIdsCache.delete(firstKey);
    }

    return ids;
  }

  async getRoutesData(
    filters: {
      startDate?: string;
      endDate?: string;
      zone?: string;
      supervisorId?: string;
      userIds?: string[];
    },
    user: any,
  ) {
    const scope = getDataScope(user);

    // ── Previous period for trend ──
    // Calcula el rango "anterior" del mismo tamaño: si el usuario filtra
    // semana actual, prev = semana anterior. Las fechas YYYY-MM-DD se
    // devuelven en TZ MX para que coincidan con la lógica del frontend.
    let prevStart: string | undefined;
    let prevEnd: string | undefined;
    if (filters.startDate && filters.endDate) {
      const dur = new Date(filters.endDate).getTime() - new Date(filters.startDate).getTime();
      const prevEndDate = new Date(new Date(filters.startDate).getTime() - 1);
      const prevStartDate = new Date(prevEndDate.getTime() - dur);
      prevStart = toMxDateKey(prevStartDate);
      prevEnd = toMxDateKey(prevEndDate);
    }

    // Helper to build a route-aggregation query
    const buildRouteQuery = (startDate?: string, endDate?: string) => {
      let q = this.knex('daily_captures as dc')
        .join('stores as s', 's.id', 'dc.store_id')
        .join('catalogs as c', function () {
          this.on('c.id', '=', 's.ruta_id').andOnVal('c.catalog_id', '=', 'rutas');
        })
        // Zona de la RUTA (c.parent_id → zones), NO del store. Si saliera de
        // s.zona_id, una ruta con tiendas de zona_id inconsistente (algunas NULL)
        // se fragmenta en varias filas — bug de la "RUTA 23" duplicada.
        .leftJoin('zones as z', 'z.id', 'c.parent_id')
        .whereNotNull('dc.store_id')
        .whereNotNull('s.ruta_id')
        .select(
          'c.id as route_id',
          'c.value as route_name',
          'z.name as zone_name',
        )
        .select(this.knex.raw('COUNT(DISTINCT dc.id) as visitas'))
        .select(this.knex.raw("COALESCE(AVG((dc.stats->>'puntuacionTotal')::float), 0) as score"))
        .select(this.knex.raw("COALESCE(SUM(COALESCE(NULLIF((dc.stats->>'ventaTotal')::float, 0), (dc.stats->>'ventaAdicional')::float)), 0) as venta"))
        .groupBy('c.id', 'c.value', 'z.name')
        .orderBy('score', 'desc');

      if (scope.type === 'own') q = q.where('dc.user_id', scope.userId);
      else if (scope.type === 'team' && scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')
        q = q.whereIn('dc.user_id', this.knex('users').select('id').where('supervisor_id', scope.userId));

      if (startDate) q.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [startDate]);
      if (endDate) q.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [endDate]);
      if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')
        q.where('c.parent_id', filters.zone);
      if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined')
        q = q.whereIn('dc.user_id', this.knex('users').select('id').where('supervisor_id', filters.supervisorId));
      else if (filters.userIds?.length)
        q = q.whereIn('dc.user_id', filters.userIds);

      return q;
    };

    const routes = await buildRouteQuery(filters.startDate, filters.endDate);
    const prevRoutes = await buildRouteQuery(prevStart, prevEnd);

    // Build trend map from previous period
    const trendMap: Record<string, number> = {};
    for (const r of prevRoutes) {
      trendMap[r.route_id] = Number(r.score);
    }

    // ── Executive breakdown per route ──
    const routeIds = routes.map((r: any) => r.route_id);
    let execQuery = this.knex('daily_captures as dc')
      .join('stores as s', 's.id', 'dc.store_id')
      .whereNotNull('dc.store_id')
      .whereNotNull('s.ruta_id')
      .whereIn('s.ruta_id', routeIds)
      .select('s.ruta_id', 'dc.user_id', 'dc.captured_by_username')
      .select(this.knex.raw('COUNT(DISTINCT dc.id) as exec_visitas'))
      .select(this.knex.raw("COALESCE(AVG((dc.stats->>'puntuacionTotal')::float), 0) as exec_score"))
      .select(this.knex.raw("COALESCE(SUM(COALESCE(NULLIF((dc.stats->>'ventaTotal')::float, 0), (dc.stats->>'ventaAdicional')::float)), 0) as exec_venta"))
      .groupBy('s.ruta_id', 'dc.user_id', 'dc.captured_by_username')
      .orderBy('exec_score', 'desc');

    if (scope.type === 'own') execQuery = execQuery.where('dc.user_id', scope.userId);
    else if (scope.type === 'team' && scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined')
      execQuery = execQuery.whereIn('dc.user_id', this.knex('users').select('id').where('supervisor_id', scope.userId));
    if (filters.startDate) execQuery.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [filters.startDate]);
    if (filters.endDate) execQuery.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [filters.endDate]);
    if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined')
      execQuery = execQuery.whereIn('dc.user_id', this.knex('users').select('id').where('supervisor_id', filters.supervisorId));
    else if (filters.userIds?.length)
      execQuery = execQuery.whereIn('dc.user_id', filters.userIds);

    const execs = await execQuery;

    // Group execs by route_id
    const execMap: Record<string, any[]> = {};
    for (const e of execs) {
      if (!execMap[e.ruta_id]) execMap[e.ruta_id] = [];
      execMap[e.ruta_id].push({
        id: e.user_id,
        name: e.captured_by_username,
        initials: (e.captured_by_username || '').split(' ').map((s: string) => s[0]).join('').slice(0, 2).toUpperCase(),
        v: Number(e.exec_visitas),
        s: Math.round(Number(e.exec_score)),
        sale: Math.round(Number(e.exec_venta)),
      });
    }

    // ── Assemble response ──
    const result = routes.map((r: any) => {
      const currentScore = Number(r.score);
      const prevScore = trendMap[r.route_id] || 0;
      const diff = currentScore - prevScore;
      const trend = diff >= 0 ? `+${Math.round(diff)}` : `${Math.round(diff)}`;

      return {
        id: r.route_id,
        name: r.route_name,
        zona: r.zone_name || '',
        visitas: Number(r.visitas),
        score: Math.round(currentScore),
        venta: Math.round(Number(r.venta)),
        trend,
        execs: execMap[r.route_id] || [],
      };
    });

    // Compute global KPIs
    const totalRoutes = result.length;
    const routesWithVisits = result.filter(r => r.visitas > 0).length;
    const avgScore = totalRoutes > 0 ? Math.round(result.reduce((s, r) => s + r.score, 0) / totalRoutes) : 0;
    const routesInMeta = result.filter(r => r.score >= 80).length;

    return {
      routes: result,
      kpis: {
        totalRoutes,
        routesWithVisits,
        avgScore,
        routesInMeta,
        metaPct: totalRoutes > 0 ? Math.round((routesInMeta / totalRoutes) * 100) : 0,
      },
    };
  }

  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Detalle de visitas de UNA ruta (apartado Rutas). Por cada captura: tienda,
   * hora_inicio/fin, duración (min, derivada), GPS y score; ORDER BY hora_inicio
   * ASC para reconstruir el recorrido del día. Scope own/team/all + tenant +
   * fechas en TZ MX, consistente con getRoutesData (agrupa por stores.ruta_id).
   */
  async getRouteVisits(
    routeId: string,
    filters: { startDate?: string; endDate?: string },
    user: any,
  ) {
    if (!ReportsService.UUID_RE.test(routeId || '')) return [];
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;

    // Las capturas de vendedor no tienen store_id (se anclan a customer_id) pero
    // sí traen route_id (ruta self-service). Para que aparezcan en el análisis de
    // ruta: LEFT JOIN a stores + matcheo por s.ruta_id O dc.route_id, con fallback
    // del nombre al cliente. `skip_scoring` viaja para que la UI no las puntúe.
    const [hasRouteId, hasCustomerId] = await Promise.all([
      this.hasRouteIdColumn(),
      this.hasCustomerIdColumn(),
    ]);

    let q = this.knex('daily_captures as dc')
      .leftJoin('stores as s', 's.id', 'dc.store_id');

    if (hasCustomerId) {
      q = q.leftJoin('commercial.customers as cust', function () {
        this.on('cust.id', '=', 'dc.customer_id');
      });
    }

    if (hasRouteId) {
      q = q.where((qb) => {
        qb.where('s.ruta_id', routeId).orWhere('dc.route_id', routeId);
      });
    } else {
      q = q.where('s.ruta_id', routeId).whereNotNull('dc.store_id');
    }

    q = q
      .select(
        'dc.id as capture_id',
        'dc.folio',
        'dc.store_id',
        'dc.skip_scoring',
        this.knex.raw(
          hasCustomerId
            ? 'COALESCE(s.nombre, cust.name) as store_nombre'
            : 's.nombre as store_nombre',
        ),
        'dc.user_id',
        'dc.captured_by_username',
        'dc.hora_inicio',
        'dc.hora_fin',
        'dc.latitud',
        'dc.longitud',
      )
      .select(
        this.knex.raw(
          'EXTRACT(EPOCH FROM (dc.hora_fin - dc.hora_inicio)) / 60 as duration_min',
        ),
      )
      .select(
        this.knex.raw(
          "COALESCE(NULLIF((dc.stats->>'puntuacionTotal')::float, 0), dc.score_final_pct, 0) as score",
        ),
      )
      .orderBy('dc.hora_inicio', 'asc');

    if (tenantId) q = q.where('dc.tenant_id', tenantId);
    if (scope.type === 'own') q = q.where('dc.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'dc.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );

    if (filters.startDate)
      q.whereRaw(
        "DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?",
        [filters.startDate],
      );
    if (filters.endDate)
      q.whereRaw(
        "DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?",
        [filters.endDate],
      );

    const rows = await q;
    return rows.map((r: any) => ({
      capture_id: r.capture_id,
      folio: r.folio,
      store_id: r.store_id,
      store_nombre: r.store_nombre,
      user_id: r.user_id,
      captured_by_username: r.captured_by_username,
      hora_inicio: r.hora_inicio,
      hora_fin: r.hora_fin,
      duration_min:
        r.duration_min != null ? Math.round(Number(r.duration_min) * 10) / 10 : null,
      latitud: r.latitud != null ? Number(r.latitud) : null,
      longitud: r.longitud != null ? Number(r.longitud) : null,
      score: Math.round(Number(r.score) || 0),
      skip_scoring: !!r.skip_scoring,
    }));
  }

  /**
   * Cobertura de UNA ruta: tiendas ASIGNADAS (stores.ruta_id) con coords +
   * flag `visited` (si tuvo al menos una captura en el rango/scope). Responde
   * "tiendas por ruta" mostrando también cuáles faltaron.
   */
  async getRouteStores(
    routeId: string,
    filters: { startDate?: string; endDate?: string },
    user: any,
  ) {
    if (!ReportsService.UUID_RE.test(routeId || '')) return [];
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;

    let sQ = this.knex('stores as s')
      .leftJoin('zones as z', 'z.id', 's.zona_id')
      .where('s.ruta_id', routeId)
      .whereNull('s.deleted_at')
      .select(
        's.id',
        's.nombre',
        's.direccion',
        's.latitud',
        's.longitud',
        'z.name as zona_name',
      )
      .orderBy('s.nombre', 'asc');
    if (tenantId) sQ = sQ.where('s.tenant_id', tenantId);
    const stores = await sQ;

    // store_ids visitados en el rango (mismo scope que las visitas).
    let vQ = this.knex('daily_captures as dc')
      .join('stores as s2', 's2.id', 'dc.store_id')
      .where('s2.ruta_id', routeId)
      .whereNotNull('dc.store_id')
      .distinct('dc.store_id');
    if (tenantId) vQ = vQ.where('dc.tenant_id', tenantId);
    if (scope.type === 'own') vQ = vQ.where('dc.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      vQ = vQ.whereIn(
        'dc.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );
    if (filters.startDate)
      vQ.whereRaw(
        "DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?",
        [filters.startDate],
      );
    if (filters.endDate)
      vQ.whereRaw(
        "DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?",
        [filters.endDate],
      );
    const visited = new Set((await vQ).map((r: any) => r.store_id));

    return stores.map((s: any) => ({
      id: s.id,
      nombre: s.nombre,
      direccion: s.direccion,
      zona_name: s.zona_name || '',
      latitud: s.latitud != null ? Number(s.latitud) : null,
      longitud: s.longitud != null ? Number(s.longitud) : null,
      visited: visited.has(s.id),
    }));
  }

  // ── Tiempos muertos (Fase 1: derivado de hora_inicio/hora_fin + coords) ──
  /** Velocidad urbana supuesta para estimar el traslado entre tiendas (km/h). */
  static readonly IDLE_SPEED_KMH = 25;
  /** Gaps por debajo de esto son ruido (encadenado de capturas), se ignoran. */
  static readonly IDLE_MIN_GAP_MIN = 5;
  /** idle por encima de esto se marca como "muerto". */
  static readonly IDLE_DEAD_THRESHOLD_MIN = 20;

  /** Haversine en km entre dos coords. null si falta alguna. */
  private static haversineKm(
    lat1?: number | null,
    lng1?: number | null,
    lat2?: number | null,
    lng2?: number | null,
  ): number | null {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Cómputo puro de segmentos de tiempo muerto a partir de capturas ORDENADAS
   * por (user_id, hora_inicio). Para cada par consecutivo del MISMO vendedor:
   *   gap   = hora_inicio[i+1] − hora_fin[i]
   *   trasl = haversine(tienda[i], tienda[i+1]) / velocidad supuesta
   *   idle  = max(0, gap − trasl)   (si no hay coords: idle = gap, sin estimar traslado)
   * Reutilizado por el endpoint /idle y por el job de persistencia.
   */
  static computeIdleSegments(rows: any[]): any[] {
    const out: any[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev.user_id !== cur.user_id) continue; // no cruzar vendedores
      // No cruzar días (en rangos multi-día emparejaría la última visita de un
      // día con la primera del siguiente como un idle gigante). `day` = fecha MX.
      if (prev.day != null && cur.day != null && String(prev.day) !== String(cur.day)) continue;
      const fin = prev.hora_fin ? new Date(prev.hora_fin).getTime() : null;
      const ini = cur.hora_inicio ? new Date(cur.hora_inicio).getTime() : null;
      if (fin == null || ini == null) continue;
      const gapMin = (ini - fin) / 60000;
      if (gapMin < ReportsService.IDLE_MIN_GAP_MIN) continue; // ruido / solapado

      const distKm = ReportsService.haversineKm(
        prev.lat != null ? Number(prev.lat) : null,
        prev.lng != null ? Number(prev.lng) : null,
        cur.lat != null ? Number(cur.lat) : null,
        cur.lng != null ? Number(cur.lng) : null,
      );
      const travelEstMin =
        distKm != null ? (distKm / ReportsService.IDLE_SPEED_KMH) * 60 : null;
      const idleMin =
        travelEstMin != null ? Math.max(0, gapMin - travelEstMin) : gapMin;
      const r2 = (n: number) => Math.round(n * 10) / 10;

      out.push({
        user_id: cur.user_id,
        vendor: cur.captured_by_username,
        day: cur.day != null ? String(cur.day) : null,
        from_capture_id: prev.id,
        to_capture_id: cur.id,
        from_store: prev.nombre,
        to_store: cur.nombre,
        prev_hora_fin: prev.hora_fin,
        next_hora_inicio: cur.hora_inicio,
        gap_min: r2(gapMin),
        dist_km: distKm != null ? r2(distKm) : null,
        travel_est_min: travelEstMin != null ? r2(travelEstMin) : null,
        idle_min: r2(idleMin),
        is_dead: idleMin > ReportsService.IDLE_DEAD_THRESHOLD_MIN,
      });
    }
    return out;
  }

  /** Velocidad por debajo de la cual se considera "estacionado" (km/h). */
  static readonly IDLE_STATIONARY_KMH = 2;

  /**
   * Refina segmentos con breadcrumbs GPS (Fase 2): dentro de la ventana del gap
   * recorre los pings del vendedor y separa tiempo en movimiento vs estacionado.
   * El idle real = tiempo estacionado (no el gap menos un traslado estimado).
   * Sobrescribe idle_min/is_dead y agrega moving_min/traveled_km/has_breadcrumbs.
   * Sin pings suficientes deja el estimado por haversine de computeIdleSegments.
   */
  static refineIdleWithPings(segments: any[], pingsByUser: Map<string, any[]>): void {
    const r2 = (n: number) => Math.round(n * 10) / 10;
    for (const seg of segments) {
      const ups = pingsByUser.get(seg.user_id);
      if (!ups || ups.length < 2) continue;
      const t0 = new Date(seg.prev_hora_fin).getTime();
      const t1 = new Date(seg.next_hora_inicio).getTime();
      const win = ups.filter((p) => {
        const t = new Date(p.captured_at).getTime();
        return t >= t0 && t <= t1;
      });
      if (win.length < 2) continue;

      let stationaryMin = 0;
      let movingMin = 0;
      let traveledKm = 0;
      for (let i = 1; i < win.length; i++) {
        const dtMin =
          (new Date(win[i].captured_at).getTime() -
            new Date(win[i - 1].captured_at).getTime()) /
          60000;
        if (dtMin <= 0) continue;
        const d =
          ReportsService.haversineKm(
            Number(win[i - 1].lat),
            Number(win[i - 1].lng),
            Number(win[i].lat),
            Number(win[i].lng),
          ) || 0;
        traveledKm += d;
        const speedKmh = d / (dtMin / 60);
        if (speedKmh < ReportsService.IDLE_STATIONARY_KMH) stationaryMin += dtMin;
        else movingMin += dtMin;
      }
      // Bordes (gap→primer ping, último ping→siguiente visita): sin evidencia de
      // movimiento, se cuentan como estacionado (conservador).
      const firstT = new Date(win[0].captured_at).getTime();
      const lastT = new Date(win[win.length - 1].captured_at).getTime();
      stationaryMin += Math.max(0, (firstT - t0) / 60000) + Math.max(0, (t1 - lastT) / 60000);

      seg.idle_min = r2(stationaryMin);
      seg.moving_min = r2(movingMin);
      seg.traveled_km = r2(traveledKm);
      seg.has_breadcrumbs = true;
      seg.is_dead = stationaryMin > ReportsService.IDLE_DEAD_THRESHOLD_MIN;
    }
  }

  /**
   * Tiempos muertos de UNA ruta: segmentos entre visitas consecutivas del mismo
   * vendedor + totales. Mismo scope/tenant/fechas (TZ MX) que getRouteVisits.
   * Usa coords de la captura y cae a las de la tienda si faltan. Si hay
   * breadcrumbs GPS en el rango, refina idle a tiempo estacionado real.
   */
  async getRouteIdle(
    routeId: string,
    filters: { startDate?: string; endDate?: string },
    user: any,
  ) {
    const empty = { segments: [], total_idle_min: 0, total_travel_min: 0, dead_count: 0 };
    if (!ReportsService.UUID_RE.test(routeId || '')) return empty;
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;

    let q = this.knex('daily_captures as dc')
      .join('stores as s', 's.id', 'dc.store_id')
      .where('s.ruta_id', routeId)
      .whereNotNull('dc.store_id')
      .select(
        'dc.id',
        'dc.store_id',
        's.nombre',
        'dc.user_id',
        'dc.captured_by_username',
        'dc.hora_inicio',
        'dc.hora_fin',
      )
      .select(this.knex.raw('COALESCE(dc.latitud, s.latitud) as lat'))
      .select(this.knex.raw('COALESCE(dc.longitud, s.longitud) as lng'))
      .select(this.knex.raw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') as day"))
      .orderBy('dc.user_id', 'asc')
      .orderBy('dc.hora_inicio', 'asc');

    if (tenantId) q = q.where('dc.tenant_id', tenantId);
    if (scope.type === 'own') q = q.where('dc.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'dc.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );
    if (filters.startDate)
      q.whereRaw(
        "DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?",
        [filters.startDate],
      );
    if (filters.endDate)
      q.whereRaw(
        "DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?",
        [filters.endDate],
      );

    const rows = await q;
    const segments = ReportsService.computeIdleSegments(rows);

    // Refinamiento Fase 2: si hay breadcrumbs GPS, separar estacionado vs
    // traslado. Best-effort: si la tabla no existe (DB sin migrar) o falla,
    // se conserva el estimado por haversine.
    if (segments.length > 0) {
      try {
        const pingsByUser = await this.fetchPingsByUser(
          [...new Set(segments.map((s) => s.user_id))],
          filters,
          tenantId,
        );
        if (pingsByUser.size > 0) {
          ReportsService.refineIdleWithPings(segments, pingsByUser);
        }
      } catch (e: any) {
        this.logger.debug(`getRouteIdle refine skipped: ${e?.message || e}`);
      }
    }

    const r2 = (n: number) => Math.round(n * 10) / 10;
    return {
      segments,
      total_idle_min: r2(segments.reduce((a, s) => a + s.idle_min, 0)),
      total_travel_min: r2(
        segments.reduce((a, s) => a + (s.travel_est_min || 0), 0),
      ),
      dead_count: segments.filter((s) => s.is_dead).length,
    };
  }

  /**
   * Trae los breadcrumbs GPS de los vendedores dados en el rango, agrupados y
   * ordenados por captured_at. Scoped por tenant. Usado para refinar idle.
   */
  private async fetchPingsByUser(
    userIds: string[],
    filters: { startDate?: string; endDate?: string },
    tenantId?: string,
  ): Promise<Map<string, any[]>> {
    const byUser = new Map<string, any[]>();
    if (userIds.length === 0) return byUser;
    let pq = this.knex('public.route_location_pings')
      .whereIn('user_id', userIds)
      .select('user_id', 'captured_at', 'lat', 'lng')
      .orderBy('user_id', 'asc')
      .orderBy('captured_at', 'asc');
    if (tenantId) pq = pq.where('tenant_id', tenantId);
    if (filters.startDate)
      pq.whereRaw("DATE(captured_at AT TIME ZONE 'America/Mexico_City') >= ?", [filters.startDate]);
    if (filters.endDate)
      pq.whereRaw("DATE(captured_at AT TIME ZONE 'America/Mexico_City') <= ?", [filters.endDate]);
    const pings = await pq;
    for (const p of pings) {
      let arr = byUser.get(p.user_id);
      if (!arr) { arr = []; byUser.set(p.user_id, arr); }
      arr.push(p);
    }
    return byUser;
  }

  /**
   * Traza GPS de una ruta (apartado Rutas → mapa): breadcrumbs de
   * public.route_location_pings con route_id = la ruta, agrupados por vendedor y
   * ordenados por captured_at. Cada track trae sus puntos + la última posición
   * (marcador "camión"). Scope own/team + tenant explícito (tabla sin RLS).
   */
  async getRouteTrack(
    routeId: string,
    filters: { startDate?: string; endDate?: string },
    user: any,
  ): Promise<{ tracks: any[] }> {
    if (!ReportsService.UUID_RE.test(routeId || '')) return { tracks: [] };
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;

    let q = this.knex('public.route_location_pings as p')
      .leftJoin('users as u', 'u.id', 'p.user_id')
      .where('p.route_id', routeId)
      .select('p.user_id', 'u.username', 'p.lat', 'p.lng', 'p.captured_at', 'p.speed_mps')
      .orderBy('p.user_id', 'asc')
      .orderBy('p.captured_at', 'asc');
    if (tenantId) q = q.where('p.tenant_id', tenantId);
    if (scope.type === 'own') q = q.where('p.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'p.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );
    if (filters.startDate)
      q.whereRaw("DATE(p.captured_at AT TIME ZONE 'America/Mexico_City') >= ?", [filters.startDate]);
    if (filters.endDate)
      q.whereRaw("DATE(p.captured_at AT TIME ZONE 'America/Mexico_City') <= ?", [filters.endDate]);

    const rows = await q;
    const byUser = new Map<string, any>();
    for (const r of rows) {
      let t = byUser.get(r.user_id);
      if (!t) {
        t = { user_id: r.user_id, username: r.username || '—', points: [] as any[] };
        byUser.set(r.user_id, t);
      }
      t.points.push({
        lat: Number(r.lat),
        lng: Number(r.lng),
        at: r.captured_at,
        speed_mps: r.speed_mps != null ? Number(r.speed_mps) : null,
      });
    }
    const tracks = Array.from(byUser.values()).map((t) => ({
      user_id: t.user_id,
      username: t.username,
      points: t.points,
      count: t.points.length,
      last: t.points[t.points.length - 1] || null,
    }));
    return { tracks };
  }

  /**
   * R.1/R.2 — Recorrido "por calles" de una ruta en un día: para cada vendedor
   * con pings en (ruta, día) devuelve la geometría pegada a calles (map-matching
   * cacheado) + paradas detectadas. Scope own/team + tenant explícito.
   */
  async getRouteSnapped(
    routeId: string,
    date: string | undefined,
    user: any,
  ): Promise<{ tracks: any[]; date: string }> {
    const day = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    if (!ReportsService.UUID_RE.test(routeId || '')) return { tracks: [], date: day };
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    if (!tenantId) return { tracks: [], date: day };

    let q = this.knex('public.route_location_pings as p')
      .leftJoin('users as u', 'u.id', 'p.user_id')
      .where('p.route_id', routeId)
      .where('p.tenant_id', tenantId)
      .whereRaw("DATE(p.captured_at AT TIME ZONE 'America/Mexico_City') = ?", [day])
      .distinct('p.user_id', 'u.username');
    if (scope.type === 'own') q = q.where('p.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'p.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );

    const users = await q;
    const tracks: any[] = [];
    for (const u of users) {
      try {
        const snap = await this.mapMatching.getSnappedTrack(tenantId, u.user_id, day, routeId);
        if (snap) tracks.push({ user_id: u.user_id, username: u.username || '—', ...snap });
      } catch (e: any) {
        this.logger.warn(`getRouteSnapped user=${u.user_id}: ${e?.message || e}`);
      }
    }
    return { tracks, date: day };
  }

  /**
   * R.3 — Vendedores con actividad GPS en un día (para el picker del historial).
   * Scope own/team/all + tenant explícito.
   */
  async getFieldUsers(
    date: string | undefined,
    user: any,
  ): Promise<{ users: any[]; date: string }> {
    const day = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    if (!tenantId) return { users: [], date: day };

    let q = this.knex('public.route_location_pings as p')
      .leftJoin('users as u', 'u.id', 'p.user_id')
      .where('p.tenant_id', tenantId)
      .whereRaw("DATE(p.captured_at AT TIME ZONE 'America/Mexico_City') = ?", [day])
      .groupBy('p.user_id', 'u.username')
      .select('p.user_id', 'u.username')
      .count('p.id as ping_count')
      .orderBy('u.username', 'asc');
    if (scope.type === 'own') q = q.where('p.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'p.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );

    const rows = await q;
    return {
      users: rows.map((r: any) => ({
        user_id: r.user_id,
        username: r.username || '—',
        ping_count: Number(r.ping_count) || 0,
      })),
      date: day,
    };
  }

  /**
   * R.3/R.5 — Día de UN vendedor: recorrido por calles (map-matching) + paradas
   * + KPIs (distancia real, paradas, tiempo en parada, span activo, movimiento,
   * velocidad media). Enforce de scope: 'own' solo a sí mismo; 'team' a su equipo.
   */
  async getVendorDay(
    userId: string,
    date: string | undefined,
    user: any,
  ): Promise<{ user_id: string; username: string; date: string; snapped: any; kpis: any } | null> {
    const day = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    if (!ReportsService.UUID_RE.test(userId || '')) return null;
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    if (!tenantId) return null;

    // Enforce de scope.
    if (scope.type === 'own' && userId !== scope.userId) return null;
    if (scope.type === 'team') {
      const teamIds = await this.getTeamIds(scope.userId);
      if (!teamIds.includes(userId)) return null;
    }

    const meta = await this.knex('public.route_location_pings')
      .where({ tenant_id: tenantId, user_id: userId })
      .whereRaw("DATE(captured_at AT TIME ZONE 'America/Mexico_City') = ?", [day])
      .min('captured_at as first')
      .max('captured_at as last')
      .count('id as pings')
      .first();
    const username =
      (await this.knex('users').select('username').where('id', userId).first())?.username || '—';

    const snapped = await this.mapMatching.getSnappedTrack(tenantId, userId, day, null);

    const first = meta?.first ? new Date(meta.first as any).getTime() : null;
    const last = meta?.last ? new Date(meta.last as any).getTime() : null;
    const activeMin = first && last ? Math.round((last - first) / 60000) : 0;
    const stops = snapped?.stops || [];
    const stopMin = stops.reduce((a: number, s: any) => a + (s.minutes || 0), 0);
    const movingMin = Math.max(0, activeMin - stopMin);
    const distKm = snapped?.distance_m ? Math.round(snapped.distance_m / 100) / 10 : 0;
    const speedKmh = movingMin > 0 ? Math.round((distKm / (movingMin / 60)) * 10) / 10 : null;

    return {
      user_id: userId,
      username,
      date: day,
      snapped,
      kpis: {
        pings: Number(meta?.pings) || 0,
        first_at: meta?.first || null,
        last_at: meta?.last || null,
        active_min: activeMin,
        stop_count: stops.length,
        stop_min: stopMin,
        moving_min: movingMin,
        distance_km: distKm,
        avg_speed_kmh: speedKmh,
      },
    };
  }

  /**
   * Resumen de tiempos muertos agregado POR VENDEDOR sobre un rango (todas las
   * rutas del scope). On-the-fly desde daily_captures (los segmentos son
   * recomputables; no se persisten). Para dashboards "¿quién acumula tiempo
   * muerto?" sin tabla derivada. Segmentos cortados por (vendedor, día MX).
   */
  async getIdleSummary(
    filters: { startDate?: string; endDate?: string; zone?: string },
    user: any,
  ) {
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;

    let q = this.knex('daily_captures as dc')
      .join('stores as s', 's.id', 'dc.store_id')
      .whereNotNull('dc.store_id')
      .select(
        'dc.id',
        's.nombre',
        'dc.user_id',
        'dc.captured_by_username',
        'dc.hora_inicio',
        'dc.hora_fin',
      )
      .select(this.knex.raw('COALESCE(dc.latitud, s.latitud) as lat'))
      .select(this.knex.raw('COALESCE(dc.longitud, s.longitud) as lng'))
      .select(this.knex.raw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') as day"))
      .orderBy('dc.user_id', 'asc')
      .orderBy('dc.hora_inicio', 'asc');

    if (tenantId) q = q.where('dc.tenant_id', tenantId);
    if (scope.type === 'own') q = q.where('dc.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'dc.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );
    if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')
      q = q.where('s.zona_id', filters.zone);
    if (filters.startDate)
      q.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [filters.startDate]);
    if (filters.endDate)
      q.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [filters.endDate]);

    const rows = await q;
    const segments = ReportsService.computeIdleSegments(rows);

    // Agregar por vendedor.
    const byVendor = new Map<string, any>();
    for (const seg of segments) {
      let agg = byVendor.get(seg.user_id);
      if (!agg) {
        agg = {
          user_id: seg.user_id,
          vendor: seg.vendor,
          total_idle_min: 0,
          total_travel_min: 0,
          dead_count: 0,
          segments: 0,
          max_idle_min: 0,
        };
        byVendor.set(seg.user_id, agg);
      }
      agg.total_idle_min += seg.idle_min;
      agg.total_travel_min += seg.travel_est_min || 0;
      agg.segments += 1;
      if (seg.is_dead) agg.dead_count += 1;
      if (seg.idle_min > agg.max_idle_min) agg.max_idle_min = seg.idle_min;
    }
    const r2 = (n: number) => Math.round(n * 10) / 10;
    const vendors = Array.from(byVendor.values())
      .map((a) => ({
        ...a,
        total_idle_min: r2(a.total_idle_min),
        total_travel_min: r2(a.total_travel_min),
        max_idle_min: r2(a.max_idle_min),
      }))
      .sort((a, b) => b.total_idle_min - a.total_idle_min);

    return {
      vendors,
      total_idle_min: r2(segments.reduce((a, s) => a + s.idle_min, 0)),
      dead_count: segments.filter((s) => s.is_dead).length,
    };
  }

  /**
   * Ingesta de breadcrumbs GPS (Fase 2). Bulk insert idempotente en
   * public.route_location_pings (sin RLS; tenant_id explícito del usuario
   * autenticado). ON CONFLICT (tenant_id, client_uuid) DO NOTHING → re-enviar
   * la cola offline no duplica. Devuelve cuántos pings nuevos se guardaron.
   */
  async ingestRoutePings(
    batch: { pings: any[] },
    user: any,
  ): Promise<{ inserted: number; high_freq_sec: number }> {
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    const userId: string | undefined = user?.sub || user?.id || user?.userId;
    if (!tenantId || !userId) return { inserted: 0, high_freq_sec: 0 };

    const pings = (batch?.pings || []).filter(
      (p) => p?.client_uuid && p?.captured_at && p?.lat != null && p?.lng != null,
    );
    if (pings.length === 0)
      return { inserted: 0, high_freq_sec: this.eventsService.watchRemainingSec(tenantId, userId) };

    const rows = pings.map((p) => ({
      tenant_id: tenantId,
      user_id: userId,
      route_id: p.route_id || null,
      client_uuid: p.client_uuid,
      captured_at: p.captured_at,
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.accuracy_m ?? null,
      speed_mps: p.speed_mps ?? null,
      source: p.source || 'foreground',
    }));

    const inserted = await this.knex('public.route_location_pings')
      .insert(rows)
      .onConflict(['tenant_id', 'client_uuid'])
      .ignore()
      .returning('id');
    const insertedCount = Array.isArray(inserted) ? inserted.length : 0;

    // Live tracking: reemitir la última posición del usuario a los supervisores.
    // Solo si algo nuevo entró (no re-broadcastear reintentos de la cola offline).
    if (insertedCount > 0) {
      const latest = rows.reduce((a, b) =>
        new Date(b.captured_at).getTime() >= new Date(a.captured_at).getTime() ? b : a,
      );
      this.eventsService.emitRoutePing({
        type: 'route_ping',
        tenantId,
        userId,
        username: user?.username,
        routeId: latest.route_id,
        lat: Number(latest.lat),
        lng: Number(latest.lng),
        capturedAt: new Date(latest.captured_at).toISOString(),
        speedMps: latest.speed_mps,
        accuracyM: latest.accuracy_m,
        source: latest.source,
      });
    }
    return {
      inserted: insertedCount,
      high_freq_sec: this.eventsService.watchRemainingSec(tenantId, userId),
    };
  }

  /**
   * Posiciones en vivo: última posición por usuario de campo del tenant dentro
   * de una ventana reciente (default 30 min). Seed del mapa en vivo antes de que
   * empiecen a llegar los `route_ping` por WebSocket. Scope own/team/all +
   * tenant explícito (tabla sin RLS). DISTINCT ON toma el fix más nuevo por user.
   */
  async getLivePositions(
    user: any,
    opts?: { sinceMin?: number },
  ): Promise<{ positions: any[]; server_now: string }> {
    const scope = getDataScope(user);
    const tenantId: string | undefined =
      user?.tenant_id || this.tenantContext?.get()?.tenantId;
    const sinceMin = Math.min(Math.max(Number(opts?.sinceMin) || 30, 1), 240);

    let q = this.knex('public.route_location_pings as p')
      .leftJoin('users as u', 'u.id', 'p.user_id')
      .select(
        this.knex.raw('DISTINCT ON (p.user_id) p.user_id'),
        'u.username',
        'p.lat',
        'p.lng',
        'p.captured_at',
        'p.speed_mps',
        'p.accuracy_m',
        'p.route_id',
        'p.source',
      )
      .whereRaw("p.captured_at >= now() - (? || ' minutes')::interval", [sinceMin])
      .orderBy('p.user_id', 'asc')
      .orderBy('p.captured_at', 'desc');
    if (tenantId) q = q.where('p.tenant_id', tenantId);
    if (scope.type === 'own') q = q.where('p.user_id', scope.userId);
    else if (
      scope.type === 'team' &&
      scope.userId &&
      scope.userId !== 'null' &&
      scope.userId !== 'undefined'
    )
      q = q.whereIn(
        'p.user_id',
        this.knex('users').select('id').where('supervisor_id', scope.userId),
      );

    const rows = await q;
    const positions = rows.map((r: any) => ({
      user_id: r.user_id,
      username: r.username || '—',
      lat: Number(r.lat),
      lng: Number(r.lng),
      captured_at: r.captured_at,
      speed_mps: r.speed_mps != null ? Number(r.speed_mps) : null,
      accuracy_m: r.accuracy_m != null ? Number(r.accuracy_m) : null,
      route_id: r.route_id || null,
      source: r.source || null,
    }));
    return { positions, server_now: new Date().toISOString() };
  }

  async getStoresData(
    filters: {
      startDate?: string;
      endDate?: string;
      storeId?: string;
      zone?: string;
    },
    user: any,
  ) {
    this.logger.debug(`getStoresData filters=${JSON.stringify(filters)}`);

    // Base query: daily_captures with store_id
    let query = this.knex('daily_captures as dc')
      .join('stores as s', 's.id', 'dc.store_id')
      .leftJoin('zones as z', 'z.id', 's.zona_id')
      .whereNotNull('dc.store_id');

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      query.where('dc.user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        // Fail closed si el equipo está vacío — antes esto colaba ver todo.
        query.whereIn('dc.user_id', teamIds.length > 0 ? teamIds : ['__none__']);
      } else {
        this.logger.warn('getStoresData: team scope with invalid userId; denying access');
        query.whereRaw('1=0');
      }
    }

    if (filters.startDate) query.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(dc.hora_inicio AT TIME ZONE 'America/Mexico_City') <= ?", [filters.endDate]);

    if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined') {
      query.where('s.zona_id', filters.zone);
    }

    // Get conceptos catalog for mapping
    const conceptos = await this.knex('catalogs')
      .where({ catalog_id: 'conceptos' })
      .select('id', 'value');
    const conceptoMap: Record<string, string> = {};
    conceptos.forEach((c) => { conceptoMap[c.id] = c.value; });

    // Get products for names
    const products = await this.knex('products').select('id', 'nombre', 'brand_id');
    const brands = await this.knex('brands').select('id', 'nombre');
    const brandMap: Record<string, string> = {};
    brands.forEach(b => brandMap[b.id] = b.nombre);
    const productMap: Record<string, { name: string; brandName: string }> = {};
    products.forEach(p => {
      productMap[p.id] = { name: p.nombre, brandName: brandMap[p.brand_id] || 'Otras' };
    });

    if (filters.storeId) {
      // ---- DETAIL VIEW for a single store ----
      query.where('dc.store_id', filters.storeId);
      const rows = await query.orderBy('dc.hora_inicio', 'desc');

      const store = await this.knex('stores as s')
        .leftJoin('zones as z', 'z.id', 's.zona_id')
        .where('s.id', filters.storeId)
        .select('s.id', 's.nombre', 's.direccion', 'z.name as zona', 's.zona_id')
        .first();

      let totalScore = 0;
      let totalVentas = 0;
      const healthCount = { optimo: 0, regular: 0, critico: 0 };
      const productStats: Record<string, { total: number }> = {};
      const scoreEvolucion: Record<string, { sum: number; count: number }> = {};
      const ultimasVisitas: any[] = [];

      rows.forEach((row) => {
        const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
        const score = stats.puntuacionTotal || 0;
        const ventas = stats.ventaTotal || (stats.ventaAdicional || 0);
        totalScore += score;
        totalVentas += ventas;

        const exhibiciones = typeof row.exhibiciones === 'string'
          ? JSON.parse(row.exhibiciones) : row.exhibiciones || [];

        exhibiciones.forEach((ex: any) => {
          const val = String(ex.nivelEjecucion).toLowerCase();
          if (val === 'alto' || val === 'excelente' || val === 'optimo') healthCount.optimo++;
          else if (val === 'medio' || val === 'regular') healthCount.regular++;
          else healthCount.critico++;

          (ex.productosMarcados || []).forEach((pid: string) => {
            if (!productStats[pid]) productStats[pid] = { total: 0 };
            productStats[pid].total++;
          });
        });

        // dateKey en TZ MX — agrupa scoreEvolucion por día calendario local.
        const dateKey = toMxDateKey(row.hora_inicio);
        if (!scoreEvolucion[dateKey]) scoreEvolucion[dateKey] = { sum: 0, count: 0 };
        scoreEvolucion[dateKey].sum += score;
        scoreEvolucion[dateKey].count++;
      });

      // Last visits (distinct by date — TZ MX)
      const visitDates = new Set<string>();
      rows.forEach((row) => {
        const dateKey = toMxDateKey(row.hora_inicio);
        if (!visitDates.has(dateKey)) {
          visitDates.add(dateKey);
          const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
          ultimasVisitas.push({
            fecha: dateKey,
            usuario: row.captured_by_username,
            score: stats.puntuacionTotal || 0,
          });
        }
      });

      // Product rankings
      const rankedProducts = Object.entries(productStats)
        .map(([pid, st]) => ({
          id: pid,
          nombre: productMap[pid]?.name || 'Producto',
          marca: productMap[pid]?.brandName || '',
          presencia: st.total,
        }))
        .sort((a, b) => b.presencia - a.presencia);

      const totalExhibidores = healthCount.optimo + healthCount.regular + healthCount.critico;
      const ultimaFecha = rows.length > 0 ? toMxDateKey(rows[0].hora_inicio) || null : null;
      const diasSinVisita = ultimaFecha
        ? Math.floor((Date.now() - new Date(ultimaFecha).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        store: {
          id: store?.id,
          nombre: store?.nombre,
          zona: store?.zona,
          score: rows.length > 0 ? Math.round(totalScore / rows.length) : 0,
          totalVisitas: rows.length,
          ventaTotal: totalVentas,
          ultimaVisita: ultimaFecha,
          diasSinVisita,
          healthRate: totalExhibidores > 0 ? {
            optimo: +((healthCount.optimo / totalExhibidores) * 100).toFixed(1),
            regular: +((healthCount.regular / totalExhibidores) * 100).toFixed(1),
            critico: +((healthCount.critico / totalExhibidores) * 100).toFixed(1),
          } : { optimo: 0, regular: 0, critico: 0 },
          productos: {
            top: rankedProducts.slice(0, 5),
            bottom: rankedProducts.slice(-5).reverse(),
          },
          evolucionScore: Object.entries(scoreEvolucion)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([fecha, data]) => ({
              fecha,
              score: +(data.sum / data.count).toFixed(2),
            })),
          ultimasVisitas: ultimasVisitas.slice(0, 10),
        },
      };
    }

    // ---- GLOBAL VIEW: all stores aggregated ----
    const rows = await query
      .select(
        'dc.store_id',
        's.nombre as store_nombre',
        's.zona_id',
        'z.name as zona_nombre',
        'dc.stats',
        'dc.exhibiciones',
        'dc.hora_inicio',
        'dc.captured_by_username',
      )
      .orderBy('dc.hora_inicio', 'desc');

    // Aggregate per store
    const storeMap = new Map<string, any>();
    for (const row of rows) {
      const sid = row.store_id;
      if (!storeMap.has(sid)) {
        storeMap.set(sid, {
          id: sid,
          nombre: row.store_nombre,
          zona: row.zona_nombre,
          scoreSum: 0,
          scoreCount: 0,
          ventaTotal: 0,
          visitas: 0,
          ultimaVisita: null,
          healthCount: { optimo: 0, regular: 0, critico: 0 },
          productCount: 0,
          rangoCompraSum: 0,
          rangoCompraCount: 0,
        });
      }
      const s = storeMap.get(sid);
      const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const score = stats.puntuacionTotal || 0;
      s.scoreSum += score;
      s.scoreCount++;
      s.ventaTotal += stats.ventaTotal || (stats.ventaAdicional || 0);
      s.visitas++;

      // Calculate rangoCompra average from exhibiciones
      const exhibiciones = typeof row.exhibiciones === 'string'
        ? JSON.parse(row.exhibiciones) : row.exhibiciones || [];
      const rangoMap: Record<string, number> = {
        '>500': 500,
        '>1000': 1000,
        '>1500': 1500,
        '>2000': 2000,
        '>2500': 2500,
      };
      exhibiciones.forEach((ex: any) => {
        const rangoCompra = ex.rangoCompra || '';
        if (rangoCompra) {
          const rangoValue = rangoMap[rangoCompra] || 0;
          if (rangoValue === 0 && rangoCompra) {
            this.logger.warn(`Unknown rangoCompra value "${rangoCompra}" for store ${sid}`);
          }
          s.rangoCompraSum += rangoValue;
          s.rangoCompraCount++;
        } else {
          console.debug(`[ReportsService] Empty rangoCompra for exhibicion in store ${sid}`);
        }
        // Also calculate health metrics
        const val = String(ex.nivelEjecucion).toLowerCase();
        if (val === 'alto' || val === 'excelente' || val === 'optimo') s.healthCount.optimo++;
        else if (val === 'medio' || val === 'regular') s.healthCount.regular++;
        else s.healthCount.critico++;
        s.productCount += (ex.productosMarcados || []).length;
      });

      // Última visita del store en TZ MX para no contar capturas de la tarde
      // como del día siguiente.
      const fecha = toMxDateKey(row.hora_inicio);
      if (!s.ultimaVisita || fecha > s.ultimaVisita) s.ultimaVisita = fecha;
    }

    const storesList: any[] = [];
    const oportunidades: any[] = [];
    let scoreSumGlobal = 0;
    let productsPerVisitSumGlobal = 0;
    let tiendasSinVisita7d = 0;

    for (const s of storeMap.values()) {
      const score = s.scoreCount > 0 ? Math.round(s.scoreSum / s.scoreCount) : 0;
      const totalExh = s.healthCount.optimo + s.healthCount.regular + s.healthCount.critico;
      const healthRate = totalExh > 0 ? {
        optimo: +((s.healthCount.optimo / totalExh) * 100).toFixed(1),
        regular: +((s.healthCount.regular / totalExh) * 100).toFixed(1),
        critico: +((s.healthCount.critico / totalExh) * 100).toFixed(1),
      } : { optimo: 0, regular: 0, critico: 0 };

      const diasSinVisita = s.ultimaVisita
        ? Math.floor((Date.now() - new Date(s.ultimaVisita).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      // Surtido real: SKUs marcados por visita. Reemplaza el "stockoutPct" que
      // asumía una baseline mágica de 10 productos/visita (no computable: la
      // captura no tiene surtido esperado por tienda).
      const productsPerVisit = s.visitas > 0
        ? +(s.productCount / s.visitas).toFixed(1)
        : 0;

      // Calculate rangoCompra average and convert back to range string
      let rangoCompraPromedio = '';
      if (s.rangoCompraCount > 0) {
        const avgRango = s.rangoCompraSum / s.rangoCompraCount;
        // Convert average back to nearest range
        const ranges = [500, 1000, 1500, 2000, 2500];
        // Use <= to correctly handle ties, then pick the higher value on equal distance
        const nearestRange = ranges.reduce((prev, curr) => {
          const distCurr = Math.abs(curr - avgRango);
          const distPrev = Math.abs(prev - avgRango);
          // If distances are equal, pick the higher range value (tie-breaking upward)
          if (distCurr === distPrev) return curr > prev ? curr : prev;
          // Otherwise pick the closer one
          return distCurr < distPrev ? curr : prev;
        });
        rangoCompraPromedio = `>${nearestRange}`;
        this.logger.debug(
          `Store ${s.id}: rangoCompraCount=${s.rangoCompraCount} sum=${s.rangoCompraSum} avg=${avgRango.toFixed(2)} rounded=${rangoCompraPromedio}`,
        );
      }

      const storeData = {
        id: s.id,
        nombre: s.nombre,
        zona: s.zona,
        score,
        totalVisitas: s.visitas,
        ventaTotal: s.ventaTotal,
        ultimaVisita: s.ultimaVisita,
        diasSinVisita,
        productsPerVisit,
        healthRate,
        rangoCompraPromedio,
      };
      storesList.push(storeData);

      scoreSumGlobal += score;
      productsPerVisitSumGlobal += productsPerVisit;
      if (diasSinVisita !== null && diasSinVisita > 7) tiendasSinVisita7d++;

      // Oportunidad: score bajo, surtido pobre (<2 SKUs/visita) o sin visita >7d.
      if (score < 60 || productsPerVisit < 2 || (diasSinVisita !== null && diasSinVisita > 7)) {
        oportunidades.push(storeData);
      }
    }

    const storeCount = storesList.length;

    return {
      stores: storesList,
      oportunidades,
      kpiGlobales: {
        scorePromedio: storeCount > 0 ? Math.round(scoreSumGlobal / storeCount) : 0,
        productosPorVisitaPromedio: storeCount > 0 ? +(productsPerVisitSumGlobal / storeCount).toFixed(1) : 0,
        tiendasSinVisita7d,
        totalTiendas: storeCount,
      },
    };
  }
}
