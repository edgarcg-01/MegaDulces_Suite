import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { getDataScope } from '../../shared/ability/data-scope';

@Injectable()
export class ReportsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

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
    let dcQuery = this.knex('daily_captures');
    let sQuery = this.knex('stores');

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      dcQuery = dcQuery.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      const teamIds = await this.getTeamIds(scope.userId);
      dcQuery = dcQuery.whereIn('user_id', teamIds);
    }

    if (filters.startDate) dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);

    if (filters.zone) {
      const zone = await this.knex('zones').where({ id: filters.zone }).first();
      if (zone && zone.name) {
        dcQuery.where('zona_captura', String(zone.name));
      }
    }

    if (filters.supervisorId) {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      dcQuery.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0) {
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

    return {
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
    let dcQuery = this.knex('daily_captures');
    let sQuery = this.knex('stores');

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      dcQuery = dcQuery.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      const teamIds = await this.getTeamIds(scope.userId);
      dcQuery = dcQuery.whereIn('user_id', teamIds);
    }

    if (filters.startDate) dcQuery.whereRaw("DATE(hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) dcQuery.whereRaw("DATE(hora_inicio) <= ?", [filters.endDate]);

    if (filters.zone) {
      const zone = await this.knex('zones').where({ id: filters.zone }).first();
      if (zone && zone.name) {
        dcQuery.where('zona_captura', String(zone.name));
      }
    }

    if (filters.supervisorId) {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      dcQuery.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0) {
      dcQuery.whereIn('user_id', filters.userIds);
    }

    const [totalDaily] = await dcQuery.clone().count('id as count');
    const [totalTiendas] = await sQuery.count('id as count');

    const [stats] = await dcQuery.clone().select(
      this.knex.raw("SUM((stats->>'totalExhibiciones')::int) as visitas"),
      this.knex.raw("AVG((stats->>'puntuacionTotal')::float) as avg_score"),
      this.knex.raw("SUM((stats->>'ventaTotal')::float) as ventas"),
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

    return {
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
      const teamIds = await this.getTeamIds(scope.userId);
      query.whereIn('dc.user_id', teamIds);
    }

    if (filters.startDate) query.whereRaw("DATE(dc.hora_inicio) >= ?", [filters.startDate]);
    if (filters.endDate) query.whereRaw("DATE(dc.hora_inicio) <= ?", [filters.endDate]);

    if (filters.zone) {
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
        const ventas = stats.ventaTotal || 0;
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
        });
      }
      const s = storeMap.get(sid);
      const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats || {};
      const score = stats.puntuacionTotal || 0;
      s.scoreSum += score;
      s.scoreCount++;
      s.ventaTotal += stats.ventaTotal || 0;
      s.visitas++;

      const fecha = row.hora_inicio instanceof Date
        ? row.hora_inicio.toISOString().split('T')[0]
        : String(row.hora_inicio).split('T')[0];
      if (!s.ultimaVisita || fecha > s.ultimaVisita) s.ultimaVisita = fecha;

      const exhibiciones = typeof row.exhibiciones === 'string'
        ? JSON.parse(row.exhibiciones) : row.exhibiciones || [];
      exhibiciones.forEach((ex: any) => {
        const val = ex.nivelEjecucion;
        if (val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80)) s.healthCount.optimo++;
        else if (val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50)) s.healthCount.regular++;
        else s.healthCount.critico++;
        s.productCount += (ex.productosMarcados || []).length;
      });
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

    const query = this.knex('daily_captures').select('*');

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      query.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      const teamIds = await this.getTeamIds(scope.userId);
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
      const score = stats.puntuacionTotal || 0;
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
      avgScore: rows.length > 0 ? Math.round(totalScore / rows.length) : 0,
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
        avgScore: Math.round(dailyTrend[date].score / dailyTrend[date].count),
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

    const scope = getDataScope(user);
    if (scope.type === 'own') {
      query.where('user_id', scope.userId);
    } else if (scope.type === 'team') {
      const teamIds = await this.getTeamIds(scope.userId);
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
