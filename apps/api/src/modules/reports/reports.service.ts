import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { getDataScope } from '../../shared/ability/data-scope';
import { EventsService } from '../websocket/events.service';
import { ReportsCacheService } from './reports-cache.service';
import { toMxDateKey, todayMx } from '../../shared/date/mx-date';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly eventsService: EventsService,
    private readonly cache: ReportsCacheService,
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
    const sQuery = this.knex('stores');

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
    const sQuery = this.knex('stores');

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

    const query = this.knex('daily_captures as dc')
      .leftJoin('stores as s', 's.id', 'dc.store_id')
      .select('dc.*', 's.nombre as cliente_nombre', 's.direccion as cliente_direccion');

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
        .select('dc.stats', 'dc.exhibiciones', 'dc.fecha', 'dc.hora_inicio', 'dc.user_id', 'dc.captured_by')
        .orderBy('hora_inicio', 'desc')
        .limit(MAX_AGG_ROWS);
    } else {
      aggRows = await query
        .clone()
        .clearSelect()
        .select('dc.stats', 'dc.exhibiciones', 'dc.fecha', 'dc.hora_inicio', 'dc.user_id', 'dc.captured_by');
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
      const numVisitas = stats.totalExhibiciones || 1;
      const score = stats.puntuacionTotal || 0;
      const ventas = stats.ventaTotal || 0;

      totalCapturesAgg += 1;
      totalVisitas += numVisitas;
      totalScore += score;
      totalVentas += ventas;

      // Todas las fechas del país se calculan en la TZ de MX (ver mx-date.ts).
      const dateKey = toMxDateKey(row.fecha) || toMxDateKey(row.hora_inicio);
      if (!dailyTrend[dateKey]) {
        dailyTrend[dateKey] = { visits: 0, score: 0, count: 0 };
      }
      dailyTrend[dateKey].visits += numVisitas;
      dailyTrend[dateKey].score += score;
      dailyTrend[dateKey].count += 1;

      // Product Analysis Aggregation (only if include has 'products')
      exhibiciones.forEach((ex: any) => {
        const conceptoId = ex.conceptoId || 'otros';
        const conceptoName = conceptoMap[conceptoId] || conceptoId;
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

            // Agregar productos por usuario
            const userId = row.user_id || row.captured_by;
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
    const metrics = {
      totalVisitas,
      avgScore: totalCapturesAgg > 0 ? Math.round(totalScore / totalCapturesAgg) : 0,
      totalVentas,
      avgVentaPorVisita: totalVisitas > 0 ? +(totalVentas / totalVisitas).toFixed(2) : 0,
      count: totalCapturesAgg,
      totalExhibiciones,
      stockoutRate: avgProductsPerVisit,
      healthRate,
      uniqueProducts: totalUniqueProducts,
    };

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
        .leftJoin('zones as z', 'z.id', 's.zona_id')
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

      if (startDate) q.whereRaw("DATE(dc.hora_inicio) >= ?", [startDate]);
      if (endDate) q.whereRaw("DATE(dc.hora_inicio) <= ?", [endDate]);
      if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined')
        q.where('s.zona_id', filters.zone);
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
    if (filters.startDate) execQuery.whereRaw("DATE(dc.hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) execQuery.whereRaw("DATE(dc.hora_inicio) <= ?", [filters.endDate]);
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

    if (filters.startDate) query.whereRaw("DATE(dc.hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(dc.hora_inicio) <= ?", [filters.endDate]);

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
    let stockoutSumGlobal = 0;
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

      const stockoutPct = s.visitas > 0
        ? +((1 - s.productCount / (s.visitas * 10)) * 100).toFixed(1) // approximate: expected ~10 products per visit
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
        stockoutRate: Math.min(100, Math.max(0, stockoutPct)),
        healthRate,
        rangoCompraPromedio,
      };
      storesList.push(storeData);

      scoreSumGlobal += score;
      stockoutSumGlobal += stockoutPct;
      if (diasSinVisita !== null && diasSinVisita > 7) tiendasSinVisita7d++;

      // Detect opportunity stores
      if (score < 60 || stockoutPct > 30 || (diasSinVisita !== null && diasSinVisita > 7)) {
        oportunidades.push(storeData);
      }
    }

    const storeCount = storesList.length;

    return {
      stores: storesList,
      oportunidades,
      kpiGlobales: {
        scorePromedio: storeCount > 0 ? Math.round(scoreSumGlobal / storeCount) : 0,
        stockoutPromedio: storeCount > 0 ? +(stockoutSumGlobal / storeCount).toFixed(1) : 0,
        tiendasSinVisita7d,
        totalTiendas: storeCount,
      },
    };
  }
}
