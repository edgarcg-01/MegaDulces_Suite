import { Component, signal, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { ReportsService } from '../reports/reports.service';
import { ThemeService } from '../../../core/services/theme.service';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { SkeletonModule } from 'primeng/skeleton';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterModule, ButtonModule, ChartModule, SkeletonModule],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css']
})
export class HomeComponent implements OnInit {
  private authService = inject(AuthService);
  private reportsService = inject(ReportsService);
  public themeService = inject(ThemeService);
  
  user = this.authService.user;
  loading = signal(true);
  
  summary = signal<any>(null);
  recentCaptures = signal<any[]>([]);
  kpiCards = signal<any[]>([]);
  furnitureKPIs = signal<any[]>([]);
  
  chartData: any;
  chartOptions: any;

  ngOnInit() {
    this.initChartConfig();
    this.loadDashboardData();
  }

  loadDashboardData() {
    this.loading.set(true);
    this.reportsService.getSummary().subscribe({
      next: (res) => {
        this.summary.set(res.metricas_globales);
        this.mapKPICards(res.metricas_globales);
      }
    });

    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7);

    this.reportsService.getReportsData({
      startDate: new Date().toLocaleDateString('en-CA'), // Filter for today's trend or last 7 days
      endDate: end.toLocaleDateString('en-CA')
    }).subscribe({
      next: (data) => {
        this.recentCaptures.set(data.rows.slice(0, 5));
        this.updateChart(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  mapKPICards(metrics: any) {
    const totalTiendas = metrics.total_tiendas || 0;
    const visitadasHoy = metrics.cierres_diarios_registrados || 0; // Backend counts total, but in a real scenario we'd query today's visit count
    const pending = Math.max(0, totalTiendas - visitadasHoy);
    
    this.kpiCards.set([
      { label: 'Score Global', value: `${metrics.puntuacion_promedio}%`, icon: 'pi pi-chart-line', color: 'text-blue-500', trend: '+2.4%' },
      { label: 'Tiempo Prom/Visita', value: `${metrics.avg_duration_min}m`, icon: 'pi pi-clock', color: 'text-amber-500', trend: 'Actual' },
      { label: 'Evidencia Visual', value: metrics.total_fotos, icon: 'pi pi-camera', color: 'text-purple-500', trend: 'Sincronizado' },
      { label: 'Tiendas Pendientes', value: pending, icon: 'pi pi-exclamation-triangle', color: 'text-rose-500', trend: 'Hoy' },
    ]);

    const d = metrics.desglose_muebles || {};
    this.furnitureKPIs.set([
      { name: 'Vitrinas', icon: 'pi pi-objects-column', actual: d.vitrina || 0, target: 10 },
      { name: 'Exhibidores', icon: 'pi pi-box', actual: d.exhibidor || 0, target: 15 },
      { name: 'Vitroleros', icon: 'pi pi-database', actual: d.vitroleros || 0, target: 5 },
      { name: 'Paleteros', icon: 'pi pi-stop-circle', actual: d.paleteros || 0, target: 5 },
      { name: 'Tiras', icon: 'pi pi-list', actual: d.tiras || 0, target: 30 },
    ].map(k => ({
      ...k,
      pct: k.target > 0 ? Math.min(100, Math.round((k.actual / k.target) * 100)) : 0
    })));
  }

  initChartConfig() {
    this.chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748b' } },
        y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#64748b' } }
      }
    };
  }

  updateChart(data: any) {
    this.chartData = {
      labels: data.trendData.map((d: any) => d.date),
      datasets: [{ 
        label: 'Score', 
        data: data.trendData.map((d: any) => d.avgScore), 
        borderColor: '#2563eb', 
        backgroundColor: 'rgba(37, 99, 235, 0.1)',
        fill: true,
        tension: 0.4
      }]
    };
  }

  quickActions = [
    { label: 'Nueva Captura', icon: 'pi pi-pencil', route: '/dashboard/captures' },
    { label: 'Ver Reportes', icon: 'pi pi-chart-bar', route: '/dashboard/reports' },
    { label: 'Gestionar Tiendas', icon: 'pi pi-building', route: '/dashboard/stores' },
  ];
}