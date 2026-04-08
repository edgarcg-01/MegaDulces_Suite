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

    const [totalDaily] = await dcQuery.clone().count('id as count');
    const [totalTiendas] = await sQuery.count('id as count');
    
    // Aggregates for the dashboard
    const [stats] = await dcQuery.clone()
      .select(
        this.knex.raw('SUM((stats->>\'totalExhibiciones\')::int) as visitas'),
        this.knex.raw('AVG((stats->>\'puntuacionTotal\')::float) as avg_score'),
        this.knex.raw('SUM((stats->>\'ventaTotal\')::float) as ventas'),
        this.knex.raw('AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min')
      );

    // Get Top Performer
    const [topPerformer] = await dcQuery.clone()
      .select('captured_by_username')
      .select(this.knex.raw('AVG((stats->>\'puntuacionTotal\')::float) as avg_score'))
      .groupBy('captured_by_username')
      .orderBy('avg_score', 'desc')
      .limit(1) as any[];

    // Get conceptos catalog for mapping IDs to names
    const conceptos = await this.knex('catalogs').where({ catalog_id: 'conceptos' }).select('id', 'value');
    const conceptoMap = {};
    conceptos.forEach(c => {
      conceptoMap[c.id] = c.value.toLowerCase();
    });

    // Deep count of furniture types and photos
    const rows = await dcQuery.clone().select('exhibiciones');
    let totalPhotos = 0;
    const furnitureCounts: Record<string, number> = {
      'vitrina': 0,
      'exhibidor': 0,
      'vitroleros': 0,
      'paleteros': 0,
      'tiras': 0,
      'otros': 0
    };

    rows.forEach(r => {
      const exArray = typeof r.exhibiciones === 'string' ? JSON.parse(r.exhibiciones) : (r.exhibiciones || []);
      exArray.forEach((ex: any) => {
        // Get concept name from catalog using conceptoId
        const conceptName = conceptoMap[ex.conceptoId] || '';
        
        // Count furniture by concept name
        if (conceptName.includes('vitrina')) furnitureCounts['vitrina']++;
        else if (conceptName.includes('exhibidor')) furnitureCounts['exhibidor']++;
        else if (conceptName.includes('vitrolero')) furnitureCounts['vitroleros']++;
        else if (conceptName.includes('paletero')) furnitureCounts['paleteros']++;
        else if (conceptName.includes('tira')) furnitureCounts['tiras']++;
        else furnitureCounts['otros']++;

        // Count photos
        if (ex.fotoUrl || ex.foto_url) {
          totalPhotos++;
        }
      });
    });

    return {
      status: "Calculado Exitosamente",
      metricas_globales: {
        total_tiendas: Number(totalTiendas?.count || 0),
        cierres_diarios_registrados: Number(totalDaily?.count || 0),
        visitas_totales: Number(stats?.visitas || 0),
        puntuacion_promedio: Number(stats?.avg_score || 0).toFixed(2),
        ventas_totales: Number(stats?.ventas || 0),
        avg_duration_min: Number(stats?.avg_duration_min || 0).toFixed(1),
        total_fotos: totalPhotos,
        mejor_ejecutivo: topPerformer?.captured_by_username || 'N/A',
        desglose_muebles: furnitureCounts
      },
      generado_el: new Date().toISOString()
    };
  }

  async getFilteredData(filters: { startDate?: string, endDate?: string, userId?: string, userIds?: string[], zone?: string, supervisorId?: string }, user: any) {
    const query = this.knex('daily_captures').select('*');

    if (user.role_name === 'colaborador') {
      query.where('user_id', user.sub);
    } else if (user.role_name === 'supervisor_v')  {
      const teamIds = await this.getTeamIds(user.sub);
      query.whereIn('user_id', teamIds);
    }

    if (filters.startDate) query.where('fecha', '>=', filters.startDate);
    if (filters.endDate) query.where('fecha', '<=', filters.endDate);
    if (filters.userId) query.where('user_id', filters.userId);

    // Si hay supervisorId, obtener IDs del equipo y filtrar por ellos
    if (filters.supervisorId) {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      query.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0) {
      query.whereIn('user_id', filters.userIds);
    }

    if (filters.zone) query.where('zona_captura', filters.zone);

    const rows = await query.orderBy('fecha', 'desc');

    // Calculate aggregated metrics for the filtered set
    let totalVisitas = 0;
    let totalScore = 0;
    let totalVentas = 0;
    const dailyTrend = {};

    rows.forEach(row => {
      const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats;
      const numVisitas = stats.totalExhibiciones || 1; // Falling back to 1 if not present
      const score = stats.puntuacionTotal || 0;
      const ventas = stats.ventaTotal || 0;

      totalVisitas += numVisitas;
      totalScore += score;
      totalVentas += ventas;

      const dateKey = row.fecha instanceof Date ? row.fecha.toISOString().split('T')[0] : row.fecha;
      if (!dailyTrend[dateKey]) {
        dailyTrend[dateKey] = { visits: 0, score: 0, count: 0 };
      }
      dailyTrend[dateKey].visits += numVisitas;
      dailyTrend[dateKey].score += score;
      dailyTrend[dateKey].count += 1;
    });

    const metrics = {
      totalVisitas,
      avgScore: rows.length > 0 ? (totalScore / rows.length).toFixed(2) : 0,
      totalVentas,
      count: rows.length
    };

    const trendData = Object.keys(dailyTrend).sort().map(date => ({
      date,
      visits: dailyTrend[date].visits,
      avgScore: (dailyTrend[date].score / dailyTrend[date].count).toFixed(2)
    }));

    return {
      metrics,
      trendData,
      rows: rows.map(r => ({
        ...r,
        stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats,
        exhibiciones: typeof r.exhibiciones === 'string' ? JSON.parse(r.exhibiciones) : r.exhibiciones
      }))
    };
  }

  async exportCsvInBuffer(filters: { startDate?: string; endDate?: string; userId?: string; userIds?: string[]; zone?: string; supervisorId?: string }, user: any) {  
    const query = this.knex('daily_captures').select('*');

    if (user.role_name === 'colaborador') {
      query.where('user_id', user.sub);
    } else if (user.role_name === 'supervisor_v')  {
      const teamIds = await this.getTeamIds(user.sub);
      query.whereIn('user_id', teamIds);
    }

    if (filters.startDate) query.where('fecha', '>=', filters.startDate);
    if (filters.endDate) query.where('fecha', '<=', filters.endDate);
    if (filters.userId) query.where('user_id', filters.userId);

    // Si hay supervisorId, obtener IDs del equipo y filtrar por ellos
    if (filters.supervisorId) {
      const teamIds = await this.getTeamIds(filters.supervisorId);
      query.whereIn('user_id', teamIds);
    } else if (filters.userIds && filters.userIds.length > 0) {
      query.whereIn('user_id', filters.userIds);
    }

    if (filters.zone) query.where('zona_captura', filters.zone);

    const data = await query.orderBy('fecha', 'desc');
    
    let csvString = "FOLIO,EJECUTIVO,ZONA,FECHA,VISITAS,SCORE,VENTA\n";
    
    for(const row of data) {
      const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : (row.stats || {});
      const fecha = row.fecha instanceof Date ? row.fecha.toISOString().split('T')[0] : row.fecha;
      csvString += `${row.folio},${row.captured_by_username},${row.zona_captura},${fecha},${stats.totalExhibiciones || 0},${stats.puntuacionTotal || 0},${stats.ventaTotal || 0}\n`;
    }
    
    return csvString;
  }

  private async getTeamIds(supervisorId: string): Promise<string[]> {
    const team = await this.knex('users')
      .select('id')
      .where('supervisor_id', supervisorId)
      .orWhere('id', supervisorId);
    return team.map(u => u.id);
  }
}
