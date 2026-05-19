import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { getDataScope } from '../../shared/ability/data-scope';
import { EventsService } from '../websocket/events.service';
import { ReportsCacheService } from './reports-cache.service';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly eventsService: EventsService,
    private readonly cache: ReportsCacheService,
  ) {
    this.eventsService.onCaptureChange = async () => {
      const before = this.cache.getHitRate();
      this.cache.invalidateAllReports();

      if (!this.eventsService.isServerReady) return;

      try {
        const today = new Date().toISOString().split('T')[0];
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        const startDate = startOfMonth.toLocaleDateString('en-CA');

        const filters = { startDate, endDate: today };
        const globalUser = { sub: 'system', permissions: {}, rules: [{ action: 'manage', subject: 'all' }] };

        const [summary, dailyScores] = await Promise.all([
          this.getSummary(filters, globalUser),
          this.getDailyScoresPerUser(filters, globalUser),
        ]);

        const afterGlobal = this.cache.getHitRate();
        const lines = [`[Cache] invalidated + global metrics emitted. Hit rate: ${before.rate} → ${afterGlobal.rate}`];

        this.eventsService.emitMetricsUpdateToRoom('reports:global', {
          type: 'metrics:updated',
          scope: 'global',
          summary,
          dailyScores,
        });

        const connectedScopes = this.eventsService.getConnectedUserScopes();
        const seen = new Map<string, boolean>();

        for (const sc of connectedScopes) {
          if (sc.type === 'all') continue;

          const room = sc.type === 'team' ? `reports:team:${sc.userId}` : `reports:own:${sc.userId}`;
          const key = `${sc.type}:${sc.userId}`;

          if (seen.has(key)) continue;
          seen.set(key, true);

          try {
            const user = sc.type === 'team'
              ? { sub: sc.userId, permissions: {}, rules: [{ action: 'read', subject: 'reports_team' }] }
              : { sub: sc.userId, permissions: {}, rules: [] };

            const [s, ds] = await Promise.all([
              this.getSummary(filters, user),
              this.getDailyScoresPerUser(filters, user),
            ]);

            this.eventsService.emitMetricsUpdateToRoom(room, {
              type: 'metrics:updated',
              scope: sc.type,
              summary: s,
              dailyScores: ds,
            });

            lines.push(`  ${sc.type}/${sc.userId} → room ${room}`);
          } catch (err) {
            console.warn(`[ReportsService] Failed to compute ${sc.type} metrics for ${sc.userId}:`, err.message);
          }
        }

        console.log(lines.join('\n'));
      } catch (err) {
        console.warn('[ReportsService] Failed to compute metrics update:', err.message);
      }
    };
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

    let dcQuery = this.knex('daily_captures');
    let sQuery = this.knex('stores');

    if (scope.type === 'own') {
      dcQuery = dcQuery.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        dcQuery = dcQuery.whereIn('user_id', teamIds);
      }
    }

    if (filters.startDate) dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);

    if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined') {
      const zone = await this.knex('zones').where({ id: filters.zone }).first();
      if (zone && zone.name) {
        dcQuery.where('zona_captura', String(zone.name));
      }
    }

    if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined') {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      dcQuery.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
      dcQuery.whereIn('user_id', filters.userIds);
    }

    // Filtrar por fecha actual para cierres de hoy
    const today = new Date().toISOString().split('T')[0];
    const todayQuery = dcQuery.clone().whereRaw("DATE(hora_inicio) = ?", [today]);
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

    let dcQuery = this.knex('daily_captures');
    let sQuery = this.knex('stores');

    if (scope.type === 'own') {
      dcQuery = dcQuery.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        dcQuery = dcQuery.whereIn('user_id', teamIds);
      }
    }

    if (filters.startDate) dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);

    if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined') {
      const zone = await this.knex('zones').where({ id: filters.zone }).first();
      if (zone && zone.name) {
        dcQuery.where('zona_captura', String(zone.name));
      }
    }

    if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined') {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      dcQuery.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0 && Array.isArray(filters.userIds)) {
      dcQuery.whereIn('user_id', filters.userIds);
    }

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
    console.log('[ReportsService] getFilteredData called with filters:', filters);
    console.log('[ReportsService] user role:', user.role_name, 'user sub:', user.sub);

    const page = filters.page ? parseInt(filters.page, 10) : 1;
    const pageSize = filters.pageSize ? parseInt(filters.pageSize, 10) : 0;
    const safePage = page > 0 ? page : 1;
    const safePageSize = pageSize > 0 ? pageSize : 0;
    const include = filters.include || '';

    const query = this.knex('daily_captures as dc')
      .leftJoin('stores as s', 's.id', 'dc.store_id')
      .select('dc.*', 's.nombre as cliente_nombre', 's.direccion as cliente_direccion');

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      query.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        query.whereIn('user_id', teamIds);
      }
    }

    if (filters.startDate) query.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
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
        // Usar el valor directamente como string primitivo
        const zoneValue = String(zone.name);
        query.where('zona_captura', zoneValue);
      } else {
        // Si no se encuentra la zona, no aplicar filtro
        console.log('[ReportsService] Zone not found for ID:', filters.zone);
      }
    }

    console.log('[ReportsService] SQL Query:', query.toSQL());
    const [{ total }] = await query.clone().clearSelect().clearOrder().count('* as total');
    console.log('[ReportsService] Total rows matching filters:', Number(total));
    const orderedQuery = query.clone().orderBy('hora_inicio', 'desc');
    const rows = safePageSize > 0
      ? await orderedQuery.limit(safePageSize).offset((safePage - 1) * safePageSize)
      : await orderedQuery;
    console.log('[ReportsService] Number of rows returned:', rows.length);
    console.log('[ReportsService] zona_captura values:', rows.map(r => r.zona_captura));

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
      
      console.log('[ReportsService] productMap keys:', Object.keys(productMap));
      console.log('[ReportsService] productMap sample:', Object.keys(productMap).slice(0, 5));
      console.log('[ReportsService] productMap sample with names:', Object.entries(productMap).slice(0, 5).map(([k, v]) => ({ id: k, name: v.name })));
    }

    // Parse and normalize stats for each row
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

    // Calculate aggregated metrics for the filtered set using normalized stats
    let totalVisitas = 0;
    let totalScore = 0;
    let totalVentas = 0;
    let totalUniqueProducts = 0;
    let totalExhibiciones = 0;
    let avgProductsPerVisit = '0.00';
    const dailyTrend: Record<string, any> = {};
    const productStats: Record<string, { total: number, exhibidores: Record<string, number> }> = {};
    const exhibidoresHealth = { optimo: 0, regular: 0, critico: 0 };
    const sellerProductStats: Record<string, Record<string, number>> = {};

    normalizedRows.forEach((row) => {
      const stats = row.stats;
      const numVisitas = stats.totalExhibiciones || 1;
      const score = stats.puntuacionTotal || 0;
      const ventas = stats.ventaTotal || 0;
      const exhibiciones = row.exhibiciones;

      totalVisitas += numVisitas;
      totalScore += score;
      totalVentas += ventas;

      const dateKey = row.fecha || (row.hora_inicio instanceof Date
        ? row.hora_inicio.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
        : typeof row.hora_inicio === 'string'
          ? row.hora_inicio.split('T')[0]
          : '');
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

        const val = ex.nivelEjecucion;
        const isOptimo = val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80);
        const isRegular = val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50);

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
      console.log('[ReportsService] PIDs in productStats not in productMap (deleted products):', missingPIDs);
      console.log('[ReportsService] Total products in productMap:', Object.keys(productMap).length);
      console.log('[ReportsService] Total PIDs in productStats before filtering:', allPIDsInStats.length);
      
      if (missingPIDs.length > 0) {
        const missingProducts = await this.knex('products')
          .whereIn('id', missingPIDs)
          .select('id', 'nombre', 'brand_id');
        
        console.log('[ReportsService] Found missing products in DB:', missingProducts.length);
        
        missingProducts.forEach(p => {
          productMap[p.id] = { 
            name: p.nombre, 
            brandName: brandMap[p.brand_id] || 'Otras' 
          };
          console.log('[ReportsService] Added to productMap:', p.id, '->', p.nombre);
        });
        
        const stillMissing = missingPIDs.filter(pid => !productMap[pid]);
        stillMissing.forEach(pid => {
          delete productStats[pid];
          console.warn('[ReportsService] Removed deleted product from productStats:', pid);
        });
        
        console.log('[ReportsService] Summary: Found', missingProducts.length, 'of', missingPIDs.length, 'missing products');
        console.log('[ReportsService] Removed', stillMissing.length, 'deleted products from productStats');
        console.log('[ReportsService] Total PIDs in productStats after filtering:', Object.keys(productStats).length);
      }

      totalUniqueProducts = Object.keys(productStats).length;
      avgProductsPerVisit = totalVisitas > 0 ? (totalUniqueProducts / totalVisitas).toFixed(2) : '0.00';
      totalExhibiciones = Object.values(productStats).reduce((sum, p) => sum + p.total, 0);
    }
    
    const totalExhibidores = exhibidoresHealth.optimo + exhibidoresHealth.regular + exhibidoresHealth.critico;
    const healthRate = totalExhibidores > 0 ? ((exhibidoresHealth.optimo / totalExhibidores) * 100).toFixed(2) : 0;

    const metrics = {
      totalVisitas,
      avgScore: normalizedRows.length > 0 ? Math.round(totalScore / normalizedRows.length) : 0,
      totalVentas,
      avgVentaPorVisita: totalVisitas > 0 ? (totalVentas / totalVisitas).toFixed(2) : 0,
      count: normalizedRows.length,
      totalExhibiciones,
      stockoutRate: avgProductsPerVisit,
      healthRate,
      uniqueProducts: totalUniqueProducts,
    };

    const trendData = Object.keys(dailyTrend)
      .filter(date => new Date(date + 'T12:00:00Z').getUTCDay() !== 0)
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
    const query = this.knex('daily_captures').select('*');

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      query.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      if (scope.userId && scope.userId !== 'null' && scope.userId !== 'undefined') {
        const teamIds = await this.getTeamIds(scope.userId);
        query.whereIn('user_id', teamIds);
      }
    }

    if (filters.startDate) query.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
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
        // Usar el valor directamente como string primitivo
        const zoneValue = String(zone.name);
        query.where('zona_captura', zoneValue);
      } else {
        // Si no se encuentra la zona, no aplicar filtro
        console.log('[ReportsService] Zone not found for ID:', filters.zone);
      }
    }

    const data = await query.orderBy('fecha', 'desc');

    let csvString = 'FOLIO,EJECUTIVO,ZONA,FECHA,VISITAS,SCORE,VENTA\n';

    for (const row of data) {
      const stats =
        typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const ventaTotal = (stats.ventaTotal || 0) > 0 ? stats.ventaTotal : (stats.ventaAdicional || 0);
      const fecha =
        row.fecha instanceof Date
          ? row.fecha.toISOString().split('T')[0]
          : row.fecha;
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
    console.log(`[ReportsService] Deleting report ${id} by user ${user.username}`);
    await this.knex('daily_captures').where({ id }).del();

    this.cache.invalidateAllReports();

    this.eventsService.emitCaptureDeleted({
      type: 'capture:deleted',
      captureId: id,
      userId: report.user_id,
    });

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
      console.log('[ReportsService] START getDailyScoresPerUser', { filters, userSub: user?.sub });

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
      
      // Select with explicit COALESCE to avoid nulls in calculations
      dcQuery.select(
        'user_id',
        'captured_by_username',
        this.knex.raw("DATE(hora_inicio) as fecha"),
        this.knex.raw("AVG(COALESCE((stats->>'puntuacionTotal')::float, 0)) as puntuacion"),
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
        console.error('[ReportsService] Scope check failed:', scopeErr.message);
      }

      // Date filtering
      if (filters.startDate && filters.startDate !== 'null' && filters.startDate !== 'undefined') {
        dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
      }
      if (filters.endDate && filters.endDate !== 'null' && filters.endDate !== 'undefined') {
        dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
      }

      // Metadata filtering (zone)
      if (filters.zone && filters.zone !== 'null' && filters.zone !== 'undefined' && filters.zone.length > 5) {
        try {
          const zone = await this.knex('zones').where({ id: filters.zone }).first();
          if (zone && zone.name) {
            dcQuery.where('zona_captura', String(zone.name));
          }
        } catch (zErr) {
          console.error('[ReportsService] Zone query failed:', zErr.message);
        }
      }

      // Supervisor / Team filtering
      if (filters.supervisorId && filters.supervisorId !== 'null' && filters.supervisorId !== 'undefined' && filters.supervisorId.length > 5) {
        try {
          const teamIds = await this.getTeamIds(filters.supervisorId);
          if (teamIds.length > 0) dcQuery.whereIn('user_id', teamIds);
        } catch (tErr) {
          console.error('[ReportsService] Team query failed:', tErr.message);
        }
      } else if (filters.userIds && filters.userIds.length > 0) {
        const ids = Array.isArray(filters.userIds) ? filters.userIds : [filters.userIds];
        const validIds = ids.filter(id => id && id !== 'null' && id !== 'undefined' && id.length > 5);
        if (validIds.length > 0) dcQuery.whereIn('user_id', validIds);
      }

      dcQuery.groupBy('user_id', 'captured_by_username', this.knex.raw("DATE(hora_inicio)"));
      dcQuery.orderBy('captured_by_username', 'asc');
      dcQuery.orderByRaw("DATE(hora_inicio) asc");

      console.log('[ReportsService] Executing SQL for Daily Scores');
      const rows = await dcQuery;
      console.log('[ReportsService] Rows fetched:', rows.length);

      const metaDiaria = 5;
      const userMap = new Map<string, { nombre: string; scores: { fecha: string; puntuacion: number }[]; metaDiaria: number }>();

      for (const row of rows) {
        if (!userMap.has(row.user_id)) {
          userMap.set(row.user_id, { nombre: row.captured_by_username, scores: [], metaDiaria });
        }
        
        let fechaStr = 'n/a';
        if (row.fecha) {
          fechaStr = row.fecha instanceof Date ? row.fecha.toISOString().split('T')[0] : String(row.fecha);
          if (fechaStr.includes('T')) fechaStr = fechaStr.split('T')[0];
        }

        userMap.get(row.user_id)!.scores.push({
          fecha: fechaStr,
          puntuacion: Math.round(Number(row.puntuacion) || 0),
        });
      }

      const result = { users: Array.from(userMap.values()) };
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error('[ReportsService] Critical error in getDailyScoresPerUser:', error);
      return { users: [] };
    }
  }

  private async getTeamIds(supervisorId: string): Promise<string[]> {
    if (!supervisorId || supervisorId === 'null' || supervisorId === 'undefined') {
      return [];
    }
    
    // UUID regex check to prevent Postgres error
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supervisorId);
    if (!isUuid) return [];

    const team = await this.knex('users')
      .select('id')
      .where('supervisor_id', supervisorId)
      .orWhere('id', supervisorId);
    return team.map((u) => u.id);
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
    let prevStart: string | undefined;
    let prevEnd: string | undefined;
    if (filters.startDate && filters.endDate) {
      const dur = new Date(filters.endDate).getTime() - new Date(filters.startDate).getTime();
      const prevEndDate = new Date(new Date(filters.startDate).getTime() - 1);
      const prevStartDate = new Date(prevEndDate.getTime() - dur);
      prevStart = prevStartDate.toISOString().split('T')[0];
      prevEnd = prevEndDate.toISOString().split('T')[0];
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
    console.log('[ReportsService] getStoresData called with filters:', filters);

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
        query.whereIn('dc.user_id', teamIds);
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
          const val = ex.nivelEjecucion;
          if (val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80)) healthCount.optimo++;
          else if (val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50)) healthCount.regular++;
          else healthCount.critico++;

          (ex.productosMarcados || []).forEach((pid: string) => {
            if (!productStats[pid]) productStats[pid] = { total: 0 };
            productStats[pid].total++;
          });
        });

        const dateKey = row.hora_inicio instanceof Date
          ? row.hora_inicio.toISOString().split('T')[0]
          : String(row.hora_inicio).split('T')[0];
        if (!scoreEvolucion[dateKey]) scoreEvolucion[dateKey] = { sum: 0, count: 0 };
        scoreEvolucion[dateKey].sum += score;
        scoreEvolucion[dateKey].count++;
      });

      // Last visits (distinct by date)
      const visitDates = new Set<string>();
      rows.forEach((row) => {
        const dateKey = row.hora_inicio instanceof Date
          ? row.hora_inicio.toISOString().split('T')[0]
          : String(row.hora_inicio).split('T')[0];
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
      const ultimaFecha = rows.length > 0
        ? (rows[0].hora_inicio instanceof Date ? rows[0].hora_inicio.toISOString().split('T')[0] : String(rows[0].hora_inicio).split('T')[0])
        : null;
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
            console.warn(`[ReportsService] Unknown rangoCompra value: "${rangoCompra}" for store ${sid}. Known values: ${Object.keys(rangoMap).join(', ')}`);
          }
          s.rangoCompraSum += rangoValue;
          s.rangoCompraCount++;
        } else {
          console.debug(`[ReportsService] Empty rangoCompra for exhibicion in store ${sid}`);
        }
        // Also calculate health metrics
        const val = ex.nivelEjecucion;
        if (val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80)) s.healthCount.optimo++;
        else if (val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50)) s.healthCount.regular++;
        else s.healthCount.critico++;
        s.productCount += (ex.productosMarcados || []).length;
      });

      const fecha = row.hora_inicio instanceof Date
        ? row.hora_inicio.toISOString().split('T')[0]
        : String(row.hora_inicio).split('T')[0];
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
        console.log(`[ReportsService] Store ${s.id}: rangoCompraCount=${s.rangoCompraCount}, sum=${s.rangoCompraSum}, avg=${avgRango.toFixed(2)}, rounded=${rangoCompraPromedio}`);
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
