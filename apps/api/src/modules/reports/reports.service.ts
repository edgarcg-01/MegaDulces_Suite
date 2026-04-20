import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class ReportsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async getSummary(user: any) {
    let dcQuery = this.knex('daily_captures');
    let sQuery = this.knex('stores');

    if (user.role_name === 'colaborador') {
      dcQuery = dcQuery.where('user_id', user.sub);
      // For stores, we might want to filter by the user's assigned stores if that existed,
      // but for now let's just filter the captures.
    } else if (user.role_name === 'supervisor_v') {
      const teamIds = await this.getTeamIds(user.sub);
      dcQuery = dcQuery.whereIn('user_id', teamIds);
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
        this.knex.raw("AVG((stats->>'score_calidad_pct')::float) as avg_score"),
        this.knex.raw("SUM((stats->>'ventaTotal')::float) as ventas"),
        this.knex.raw(
          'AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min',
        ),
      );

    // Get Top Performer
    const [topPerformer] = (await dcQuery
      .clone()
      .select('captured_by_username')
      .select(
        this.knex.raw("AVG((stats->>'score_calidad_pct')::float) as avg_score"),
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

    return {
      status: 'Calculado Exitosamente',
      metricas_globales: {
        total_tiendas: Number(totalTiendas?.count || 0),
        cierres_diarios_registrados: Number(totalDaily?.count || 0),
        cierres_hoy: Number(totalDailyToday?.count || 0),
        meta_diaria: metaDiaria,
        visitas_totales: Number(stats?.visitas || 0),
        puntuacion_promedio: Number(stats?.avg_score || 0).toFixed(2),
        ventas_totales: Number(stats?.ventas || 0),
        avg_duration_min: Number(stats?.avg_duration_min || 0).toFixed(1),
        total_fotos: totalPhotos,
        mejor_ejecutivo: topPerformer?.captured_by_username || 'N/A',
        desglose_muebles: furnitureCounts,
      },
      generado_el: new Date().toISOString(),
    };
  }

  async getFilteredData(
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
    console.log('[ReportsService] getFilteredData called with filters:', filters);
    console.log('[ReportsService] user role:', user.role_name, 'user sub:', user.sub);

    const query = this.knex('daily_captures').select('*');

    if (user.role_name === 'colaborador') {
      query.where('user_id', user.sub);
    } else if (user.role_name === 'supervisor_v') {
      const teamIds = await this.getTeamIds(user.sub);
      query.whereIn('user_id', teamIds);
    }

    if (filters.startDate) query.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
    if (filters.userId) query.where('user_id', filters.userId);

    // Si hay supervisorId, obtener IDs del equipo y filtrar por ellos
    if (filters.supervisorId) {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      query.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0) {
      query.whereIn('user_id', filters.userIds);
    }

    if (filters.zone) {
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
    const rows = await query.orderBy('hora_inicio', 'desc');
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

    // Get all products and brands for mapping IDs to names
    // Include products from the planogram to ensure all PIDs have names
    const products = await this.knex('products').select('id', 'nombre', 'brand_id');
    const brands = await this.knex('brands').select('id', 'nombre');
    
    const productMap: Record<string, { name: string; brandName: string }> = {};
    const brandMap: Record<string, string> = {};
    
    brands.forEach(b => brandMap[b.id] = b.nombre);
    products.forEach(p => {
      productMap[p.id] = { 
        name: p.nombre, 
        brandName: brandMap[p.brand_id] || 'Otras' 
      };
    });
    
    // Log productMap for debugging
    console.log('[ReportsService] productMap keys:', Object.keys(productMap));
    console.log('[ReportsService] productMap sample:', Object.keys(productMap).slice(0, 5));
    console.log('[ReportsService] productMap sample with names:', Object.entries(productMap).slice(0, 5).map(([k, v]) => ({ id: k, name: v.name })));

    // Calculate aggregated metrics for the filtered set
    let totalVisitas = 0;
    let totalScore = 0;
    let totalVentas = 0;
    const dailyTrend: Record<string, any> = {};
    const productStats: Record<string, { total: number, exhibidores: Record<string, number> }> = {};
    const exhibidoresHealth = { optimo: 0, regular: 0, critico: 0 };
    const sellerProductStats: Record<string, Record<string, number>> = {}; // Productos por usuario

    // Collect all unique PIDs from exhibiciones for later mapping
    const allPIDsInExhibiciones = new Set<string>();

    rows.forEach((row) => {
      const stats =
        typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const numVisitas = stats.totalExhibiciones || 1; // Falling back to 1 if not present
      const score = stats.score_calidad_pct || 0;
      const ventas = stats.ventaTotal || 0;
      const exhibiciones = 
        typeof row.exhibiciones === 'string' ? JSON.parse(row.exhibiciones) : row.exhibiciones || [];

      totalVisitas += numVisitas;
      totalScore += score;
      totalVentas += ventas;

      const dateKey = (row.hora_inicio instanceof Date
        ? row.hora_inicio.toISOString().split('T')[0]
        : typeof row.hora_inicio === 'string'
          ? row.hora_inicio.split('T')[0]
          : row.fecha) || row.fecha;
      if (!dailyTrend[dateKey]) {
        dailyTrend[dateKey] = { visits: 0, score: 0, count: 0 };
      }
      dailyTrend[dateKey].visits += numVisitas;
      dailyTrend[dateKey].score += score;
      dailyTrend[dateKey].count += 1;

      // Product Analysis Aggregation
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

        productosMarcados.forEach((pid: string) => {
          if (!productStats[pid]) {
            productStats[pid] = { total: 0, exhibidores: {} };
          }
          productStats[pid].total += 1;

          if (!productStats[pid].exhibidores[conceptoName]) {
            productStats[pid].exhibidores[conceptoName] = 0;
          }
          productStats[pid].exhibidores[conceptoName] += 1;

          // Collect PID for later mapping
          allPIDsInExhibiciones.add(pid);

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
      });
    });

    // Find PIDs that are in productStats but not in productMap (deleted products)
    // Remove them from productStats to avoid showing deleted products in reports
    const allPIDsInStats = Object.keys(productStats);
    const missingPIDs = allPIDsInStats.filter(pid => !productMap[pid]);
    console.log('[ReportsService] PIDs in productStats not in productMap (deleted products):', missingPIDs);
    console.log('[ReportsService] Total products in productMap:', Object.keys(productMap).length);
    console.log('[ReportsService] Total PIDs in productStats before filtering:', allPIDsInStats.length);
    
    if (missingPIDs.length > 0) {
      // Try to get product info from products table (in case we missed some)
      const missingProducts = await this.knex('products')
        .whereIn('id', missingPIDs)
        .select('id', 'nombre', 'brand_id');
      
      console.log('[ReportsService] Found missing products in DB:', missingProducts.length);
      
      // Add the found products to productMap
      missingProducts.forEach(p => {
        productMap[p.id] = { 
          name: p.nombre, 
          brandName: brandMap[p.brand_id] || 'Otras' 
        };
        console.log('[ReportsService] Added to productMap:', p.id, '->', p.nombre);
      });
      
      // Remove still missing PIDs from productStats (deleted products should not appear in reports)
      const stillMissing = missingPIDs.filter(pid => !productMap[pid]);
      stillMissing.forEach(pid => {
        delete productStats[pid];
        console.warn('[ReportsService] Removed deleted product from productStats:', pid);
      });
      
      console.log('[ReportsService] Summary: Found', missingProducts.length, 'of', missingPIDs.length, 'missing products');
      console.log('[ReportsService] Removed', stillMissing.length, 'deleted products from productStats');
      console.log('[ReportsService] Total PIDs in productStats after filtering:', Object.keys(productStats).length);
    }

    // Calculate stockout rate: percentage of products not appearing in any exhibition
    const totalUniqueProducts = Object.keys(productStats).length;
    const avgProductsPerVisit = totalVisitas > 0 ? (totalUniqueProducts / totalVisitas).toFixed(2) : 0;
    
    // Calculate total exhibiciones
    const totalExhibiciones = Object.values(productStats).reduce((sum, p) => sum + p.total, 0);
    
    // Calculate exhibidores health percentage
    const totalExhibidores = exhibidoresHealth.optimo + exhibidoresHealth.regular + exhibidoresHealth.critico;
    const healthRate = totalExhibidores > 0 ? ((exhibidoresHealth.optimo / totalExhibidores) * 100).toFixed(2) : 0;

    const metrics = {
      totalVisitas,
      avgScore: rows.length > 0 ? (totalScore / rows.length).toFixed(2) : 0,
      totalVentas,
      avgVentaPorVisita: totalVisitas > 0 ? (totalVentas / totalVisitas).toFixed(2) : 0,
      count: rows.length,
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
        avgScore: (dailyTrend[date].score / dailyTrend[date].count).toFixed(2),
      }));

    return {
      metrics,
      trendData,
      productStats,
      productMap, // We send the mapping to the frontend
      exhibidoresHealth,
      sellerProductStats, // Productos por usuario
      rows: rows.map((r) => ({
        ...r,
        stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats,
        exhibiciones:
          typeof r.exhibiciones === 'string'
            ? JSON.parse(r.exhibiciones)
            : r.exhibiciones,
      })),
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

    if (user.role_name === 'colaborador') {
      query.where('user_id', user.sub);
    } else if (user.role_name === 'supervisor_v') {
      const teamIds = await this.getTeamIds(user.sub);
      query.whereIn('user_id', teamIds);
    }

    if (filters.startDate) query.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);
    if (filters.userId) query.where('user_id', filters.userId);

    // Si hay supervisorId, obtener IDs del equipo y filtrar por ellos
    if (filters.supervisorId) {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      query.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0) {
      query.whereIn('user_id', filters.userIds);
    }

    if (filters.zone) {
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
      const fecha =
        row.fecha instanceof Date
          ? row.fecha.toISOString().split('T')[0]
          : row.fecha;
      csvString += `${row.folio},${row.captured_by_username},${row.zona_captura},${fecha},${stats.totalExhibiciones || 0},${stats.puntuacionTotal || 0},${stats.ventaTotal || 0}\n`;
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

    return { success: true, message: 'Reporte eliminado correctamente' };
  }

  private async getTeamIds(supervisorId: string): Promise<string[]> {
    const team = await this.knex('users')
      .select('id')
      .where('supervisor_id', supervisorId)
      .orWhere('id', supervisorId);
    return team.map((u) => u.id);
  }
}
