import { Injectable, inject } from '@angular/core';
import { Observable, map, forkJoin, of } from 'rxjs';
import { ReportsService, ReportsData } from '../reports.service';

export interface DashboardData {
  metrics: {
    totalVisitas: number;
    avgScore: number;
    totalVentas: number;
    count: number;
    totalExhibiciones?: number;
    gpsPct?: number;
    totalTiendas?: number;
    cierresDiarios?: number;
    avgDurationMin?: number;
    totalFotos?: number;
    mejorEjecutivo?: string;
  };
  trendData: Array<{
    date: string;
    visits: number;
    avgScore: number;
  }>;
  rows: any[];
  zoneStats?: Array<{
    zone: string;
    avgScore: number;
    totalVisitas?: number;
  }>;
  sellerStats?: Array<{
    username: string;
    totalVisitas: number;
    avgScore?: number;
  }>;
  furniture?: Record<string, number>;
  recentCaptures?: any[];
}

@Injectable({
  providedIn: 'root'
})
export class DashboardService {
  private reportsService = inject(ReportsService);

  getDashboardData(filters: any): Observable<DashboardData> {
    // Usar forkJoin para combinar summary (tiene métricas completas) y data (tiene trend y rows)
    return forkJoin({
      summary: this.reportsService.getSummary(),
      data: filters.startDate ? this.reportsService.getReportsData(filters) : of(null)
    }).pipe(
      map(({ summary, data }) => {
        const metricas = summary?.metricas_globales || {};
        const desglose = metricas.desglose_muebles || {};

        // Mapear mobiliario del español al inglés
        const furniture: Record<string, number> = {
          vitrina: desglose.vitrina || 0,
          exhibidor: desglose.exhibidor || 0,
          vitrolero: desglose.vitroleros || 0,
          paletero: desglose.paleteros || 0,
          tira: desglose.tiras || 0,
          otros: desglose.otros || 0,
        };

        return {
          metrics: {
            totalVisitas: metricas.visitas_totales || 0,
            avgScore: parseFloat(metricas.puntuacion_promedio) || 0,
            totalVentas: metricas.ventas_totales || 0,
            count: metricas.cierres_diarios_registrados || 0,
            totalExhibiciones: metricas.visitas_totales || 0,
            gpsPct: 0, // No disponible en summary actual
            totalTiendas: metricas.total_tiendas || 0,
            cierresDiarios: metricas.cierres_diarios_registrados || 0,
            avgDurationMin: parseFloat(metricas.avg_duration_min) || 0,
            totalFotos: metricas.total_fotos || 0,
            mejorEjecutivo: metricas.mejor_ejecutivo || 'N/A',
          },
          trendData: data?.trendData ?? [],
          rows: data?.rows ?? [],
          zoneStats: data?.zoneStats ?? [],
          sellerStats: data?.sellerStats ?? [],
          furniture,
          recentCaptures: data?.rows?.slice(0, 5) ?? [],
        };
      })
    );
  }
}
