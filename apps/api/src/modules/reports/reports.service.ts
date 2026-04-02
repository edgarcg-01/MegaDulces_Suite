import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class ReportsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async getSummary() {
    const [totalDaily] = await this.knex('daily_captures').count('id as count');
    const [totalTiendas] = await this.knex('stores').count('id as count');
    
    // Aggregates for the dashboard
    const [stats] = await this.knex('daily_captures')
      .select(
        this.knex.raw('SUM((stats->>\'totalExhibiciones\')::int) as visitas'),
        this.knex.raw('AVG((stats->>\'puntuacionTotal\')::float) as avg_score'),
        this.knex.raw('SUM((stats->>\'ventaTotal\')::float) as ventas'),
        this.knex.raw('AVG(EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60) as avg_duration_min')
      );

    // Get Top Performer
    const [topPerformer] = await this.knex('daily_captures')
      .select('captured_by_username')
      .select(this.knex.raw('AVG((stats->>\'puntuacionTotal\')::float) as avg_score'))
      .groupBy('captured_by_username')
      .orderBy('avg_score', 'desc')
      .limit(1) as any[];

    // Deep count of furniture types and photos
    const rows = await this.knex('daily_captures').select('exhibiciones');
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
        // Count furniture (Using conceptoId from the database captures)
        const typeId = (ex.conceptoId || '').toLowerCase();
        
        // Mapeo simple de ID a categoría para el dashboard
        if (typeId.includes('vitrina')) furnitureCounts['vitrina']++;
        else if (typeId.includes('exhibidor')) furnitureCounts['exhibidor']++;
        else if (typeId.includes('vitrolero')) furnitureCounts['vitroleros']++;
        else if (typeId.includes('paletero')) furnitureCounts['paleteros']++;
        else if (typeId.includes('tira')) furnitureCounts['tiras']++;
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

  async getFilteredData(filters: { startDate?: string, endDate?: string, userId?: string, userIds?: string[], zone?: string }) {
    const query = this.knex('daily_captures').select('*');

    if (filters.startDate) query.where('fecha', '>=', filters.startDate);
    if (filters.endDate) query.where('fecha', '<=', filters.endDate);
    if (filters.userId) query.where('user_id', filters.userId);
    if (filters.userIds && filters.userIds.length > 0) query.whereIn('user_id', filters.userIds);
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

  async exportCsvInBuffer(filters: { startDate?: string, endDate?: string, userId?: string, userIds?: string[], zone?: string }) {
    const query = this.knex('daily_captures').select('*');

    if (filters.startDate) query.where('fecha', '>=', filters.startDate);
    if (filters.endDate) query.where('fecha', '<=', filters.endDate);
    if (filters.userId) query.where('user_id', filters.userId);
    if (filters.userIds && filters.userIds.length > 0) query.whereIn('user_id', filters.userIds);
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
}
