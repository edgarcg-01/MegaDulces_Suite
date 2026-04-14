import { Component, OnInit, inject, signal, computed, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs'; // Importante para lanzar múltiples peticiones

// Servicios
import { ReportsService } from '../reports/reports.service';
import { ThemeService } from '../../../core/services/theme.service';
import { FiltersStateService } from '../reports/graphics/filters-state.service';
import {
  MetasConfigService,
  KpiStatus,
} from '../reports/graphics/metas-config.service';
import { GlobalFiltersComponent } from '../reports/graphics/global-filters.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    ChartModule,
    DialogModule,
    InputNumberModule,
    SkeletonModule,
    TooltipModule,
    ToastModule,
    GlobalFiltersComponent,
  ],
  providers: [MessageService],
  templateUrl: './home.component.html',
  encapsulation: ViewEncapsulation.None,
})
export class HomeComponent implements OnInit {
  // Inyecciones adaptadas a tu código anterior
  private reportsService = inject(ReportsService);
  public themeService = inject(ThemeService);
  readonly filtersState = inject(FiltersStateService);
  readonly metasConfig = inject(MetasConfigService);
  private messageService = inject(MessageService);

  loading = signal(true);

  // Signals para almacenar la data del backend
  summary = signal<any>(null);
  reportsData = signal<any>(null);

  // Modal de metas
  showMetasDialog = false;
  editableFurniture = [...this.metasConfig.furniture()].map(f => ({ ...f }));
  editableKpi = [...this.metasConfig.kpiRanges()].map(k => ({ ...k }));

  // Variables para la gráfica
  chartData: any;
  chartOptions: any;
  // Gráfica apilada estilo PrimeNG
  stackedChartData: any;
  stackedChartOptions: any;

  // Tarjetas de navegación rápida
  quickActions = [
    { label: 'Nueva Captura', icon: 'pi pi-pencil', route: '/dashboard/captures' },
    { label: 'Ver Reportes', icon: 'pi pi-chart-bar', route: '/dashboard/reports' },
    { label: 'Gestionar Tiendas', icon: 'pi pi-building', route: '/dashboard/stores' },
  ];

  // 1. Computed: Tarjetas KPI (Mapea la lógica de tu mapKPICards original)
  kpiCards = computed(() => {
    const metrics = this.summary() || {};
    const totalTiendas = metrics.total_tiendas || 0;
    const visitadasHoy = metrics.cierres_diarios_registrados || 0;
    const pending = Math.max(0, totalTiendas - visitadasHoy);

    // Integramos el semáforo para el Score usando el MetasConfigService
    const scoreVal = parseFloat(metrics.puntuacion_promedio) || 0;
    const scoreStatus = this.metasConfig.statusFor('score', scoreVal);
    const scoreRange = this.metasConfig.getRange('score');

    return [
      {
        label: 'Score Global',
        value: `${metrics.puntuacion_promedio || 0}%`,
        icon: 'pi pi-chart-line',
        colorClass: 'text-blue-500',
        trend: '+2.4%',
        status: scoreStatus,
        meta: scoreRange ? `${scoreRange.opt}%` : '—',
        delta: 'Sin variación',
        deltaDir: 'flat',
        pct: this.metasConfig.progressPct('score', scoreVal)
      },
      {
        label: 'Tiempo Prom/Visita',
        value: `${metrics.avg_duration_min || 0}m`,
        icon: 'pi pi-clock',
        colorClass: 'text-amber-500',
        trend: 'Actual',
        status: 'ok',
        meta: '—',
        delta: 'Sin variación',
        deltaDir: 'flat',
        pct: 0
      },
      {
        label: 'Evidencia Visual',
        value: (metrics.total_fotos || 0).toString(),
        icon: 'pi pi-camera',
        colorClass: 'text-purple-500',
        trend: 'Sincronizado',
        status: 'ok',
        meta: '—',
        delta: 'Sin variación',
        deltaDir: 'flat',
        pct: 0
      },
      {
        label: 'Tiendas Pendientes',
        value: pending.toString(),
        icon: 'pi pi-exclamation-triangle',
        colorClass: 'text-rose-500',
        trend: 'Hoy',
        status: pending > 0 ? 'warn' : 'ok',
        meta: '—',
        delta: pending > 0 ? `${pending} restantes` : 'Completado',
        deltaDir: pending > 0 ? 'down' : 'up',
        pct: 0
      }
    ];
  });

  // 2. Computed: Desglose de Mobiliario (Mapea metrics.desglose_muebles)
  furnitureRows = computed(() => {
    const metrics = this.summary() || {};
    const d = metrics.desglose_muebles || {};

    return this.metasConfig.furniture().map(f => {
      // Intentamos mapear el ID de la meta con la llave del JSON que manda tu backend
      let actual = 0;
      if (f.id === 'vitrina') actual = d.vitrina || 0;
      if (f.id === 'exhibidor') actual = d.exhibidor || 0;
      if (f.id === 'vitrolero') actual = d.vitroleros || 0;
      if (f.id === 'paletero') actual = d.paleteros || 0;
      if (f.id === 'tira') actual = d.tiras || 0;

      const status = this.metasConfig.furnitureStatus(actual, f.target);
      const pct = f.target > 0 ? Math.min(100, Math.round((actual / f.target) * 100)) : 0;

      return { ...f, actual, status, pct };
    });
  });

  // 3. Computed: Actividad Reciente
  recentCaptures = computed(() => {
    const data = this.reportsData();
    if (!data || !data.rows) return [];
    return data.rows.slice(0, 5);
  });

  ngOnInit() {
    this.initChartConfig();
    this.loadDashboardData();
  }

  loadDashboardData() {
    this.loading.set(true);
    const filters = this.filtersState.filters();

    // forkJoin nos permite esperar a que ambas peticiones (Summary y Reports) terminen
    forkJoin({
      summaryRes: this.reportsService.getSummary(),
      reportsRes: this.reportsService.getReportsData(filters)
    }).subscribe({
      next: ({ summaryRes, reportsRes }) => {
        this.summary.set(summaryRes.metricas_globales);
        this.reportsData.set(reportsRes);
        this.updateChart(reportsRes);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  // Se encarga de aplicar los estilos dependiendo de si el theme es oscuro o claro
  initChartConfig() {
    const isDark = this.themeService.isMonochrome();
    this.chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1000, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? '#18181b' : '#ffffff',
          titleColor: isDark ? '#ffffff' : '#09090b',
          bodyColor: isDark ? '#a1a1aa' : '#64748b',
          borderColor: isDark ? '#3f3f46' : '#e2e8f0',
          borderWidth: 1, padding: 12, boxPadding: 6, usePointStyle: true,
          callbacks: { label: (context: any) => ` Score: ${context.parsed.y}%` }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: isDark ? '#71717a' : '#94a3b8', font: { size: 10, weight: '600' } }
        },
        y: {
          min: 0, max: 100,
          grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', drawTicks: false },
          ticks: { color: isDark ? '#71717a' : '#94a3b8', font: { size: 10, weight: '600' }, callback: (value: any) => `${value}%` }
        }
      }
    };

    // Opciones para gráfica apilada estilo PrimeNG
    this.stackedChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 750, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false }, // La leyenda está en el HTML
        tooltip: {
          backgroundColor: isDark ? '#18181b' : '#ffffff',
          titleColor: isDark ? '#ffffff' : '#09090b',
          bodyColor: isDark ? '#a1a1aa' : '#64748b',
          borderColor: isDark ? '#3f3f46' : '#e2e8f0',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (context: any) => {
              const label = context.dataset.label || '';
              const value = context.parsed.y;
              const total = context.chart.data.datasets.reduce((sum: number, ds: any) => {
                return sum + (ds.data[context.dataIndex] || 0);
              }, 0);
              const pct = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${label}: ${value} visitas (${pct}%)`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            color: isDark ? '#71717a' : '#64748b',
            font: { size: 11, weight: '500' }
          }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: {
            color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
            drawBorder: false
          },
          ticks: {
            color: isDark ? '#71717a' : '#64748b',
            font: { size: 10 },
            callback: (value: number) => value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value
          }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      }
    };
  }

  updateChart(data: any) {
    if (!data || !data.trendData) return;

    // Gráfica de línea original (Score) - se mantenerá
    this.chartData = {
      labels: data.trendData.map((d: any) => d.date),
      datasets: [{
        label: 'Score',
        data: data.trendData.map((d: any) => d.avgScore),
        borderColor: '#f6d200',
        backgroundColor: 'rgba(246, 210, 0, 0.1)',
        fill: true,
        tension: 0.4
      }]
    };

    // Gráfica de 7 días fijos de la semana - Desglose por calidad de visita
    const weekDays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const weekDaysFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // Inicializar acumuladores para cada día de la semana
    const weekStats = weekDays.map(() => ({ high: 0, medium: 0, low: 0, count: 0 }));

    // Agrupar datos por día de la semana
    data.trendData.forEach((d: any) => {
      const date = new Date(d.date);
      const dayIndex = date.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab
      // Convertir a índice donde 0=Lun, 6=Dom
      const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;

      // Desglose por tipo de visita basado en score promedio
      const highVisits = Math.round(d.visits * (d.avgScore / 100) * 0.6);
      const mediumVisits = Math.round(d.visits * (d.avgScore / 100) * 0.3);
      const lowVisits = d.visits - highVisits - mediumVisits;

      weekStats[adjustedIndex].high += Math.max(0, highVisits);
      weekStats[adjustedIndex].medium += Math.max(0, mediumVisits);
      weekStats[adjustedIndex].low += Math.max(0, lowVisits);
      weekStats[adjustedIndex].count += 1;
    });

    // Crear datasets para la gráfica apilada (una barra por cada día de la semana)
    this.stackedChartData = {
      labels: weekDays,
      datasets: [
        {
          label: 'Alto Score',
          data: weekStats.map((s: any) => s.high),
          backgroundColor: '#185FA5', // Azul oscuro
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: 'Score Medio',
          data: weekStats.map((s: any) => s.medium),
          backgroundColor: '#5B9BD5', // Azul medio
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: 'Bajo Score',
          data: weekStats.map((s: any) => s.low),
          backgroundColor: '#BDD7EE', // Azul claro
          borderRadius: 6,
          borderSkipped: false,
        }
      ]
    };
  }

  statusLabel(s: KpiStatus | string): string {
    return s === 'ok' ? 'Óptimo' : s === 'warn' ? 'Precaución' : s === 'bad' ? 'Bajo' : 'Info';
  }

  // --- Lógica del Diálogo de Metas ---
  openMetasDialog() {
    this.editableFurniture = this.metasConfig.furniture().map(f => ({ ...f }));
    this.showMetasDialog = true;
  }

  saveMetas() {
    // Al guardar, actualizamos el servicio local que maneja el localStorage
    this.editableFurniture.forEach(f => this.metasConfig.updateFurnitureTarget(f.id, f.target));
    this.showMetasDialog = false;
    // Forzamos un refresco de las propiedades computadas
    this.summary.set({...this.summary()});
  }

  cancelMetas() {
    this.showMetasDialog = false;
  }

  exportPdf() {
    // Aquí puedes implementar la exportación a PDF si lo deseas, o simplemente hacer un window.print()
    window.print();
  }
}
