import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { ToastModule } from 'primeng/toast';
import { TabsModule } from 'primeng/tabs';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageService } from 'primeng/api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

import { ReportsService, ReportsData } from './reports.service';
import { AuthService } from '../../../core/services/auth.service';
import { FiltersStateService } from '../reports/graphics/filters-state.service';
import {
  MetasConfigService,
  KpiStatus,
} from '../reports/graphics/metas-config.service';
import { GlobalFiltersComponent } from '../reports/graphics/global-filters.component';

interface DayGroup {
  id: string;
  fecha: string;
  totalVisitas: number;
  avgScore: number;
  totalVenta: number;
  scoreStatus: KpiStatus;
  visitasStatus: KpiStatus;
  visits: any[];
  selected: boolean;
}

interface PdfSection {
  id: string;
  label: string;
  checked: boolean;
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    TagModule,
    ButtonModule,
    ChartModule,
    ToastModule,
    TabsModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    InputNumberModule,
    DialogModule,
    ImageModule,
    CheckboxModule,
    GlobalFiltersComponent,
  ],
  providers: [MessageService],
  templateUrl: './reports.component.html',
  styles: [
    `
      :host ::ng-deep .p-datatable-sm .p-datatable-tbody > tr > td {
        padding: 0.5rem;
      }
      :host ::ng-deep .p-tablist-tablist {
        border-bottom: 2px solid var(--surface-border);
      }
    `,
  ],
})
export class ReportsComponent implements OnInit {
  private reportsService = inject(ReportsService);
  private auth = inject(AuthService);
  private messageService = inject(MessageService);
  readonly filtersState = inject(FiltersStateService);
  readonly metasConfig = inject(MetasConfigService);

  loading = signal(false);
  reportsData = signal<ReportsData | null>(null);
  searchText = '';
  expandedRows: { [key: string]: boolean } = {};
  selectedRow: any = null;
  showDetail = false;
  showPdfBuilder = false;
  showComparison = false;

  pdfTitle = 'Reporte de mercadeo';
  pdfSections: PdfSection[] = [
    { id: 'metrics', label: 'Resumen de métricas', checked: true },
    { id: 'trend', label: 'Gráfica de tendencia', checked: true },
    { id: 'furniture', label: 'Cumplimiento mobiliario', checked: true },
    { id: 'table', label: 'Tabla de registros', checked: true },
    { id: 'ranking', label: 'Ranking por vendedor', checked: false },
  ];

  // Modal de metas (solo superadmin y supervisor_m)
  showMetasDialog = false;
  editableFurniture = [...this.metasConfig.furniture()].map(f => ({ ...f }));
  editableKpi = [...this.metasConfig.kpiRanges()].map(k => ({ ...k }));

  // Verificar si el usuario puede editar metas
  canEditMetas = computed(() => {
    const user = this.auth.user();
    if (!user) return false;
    return user.role_name === 'superadmin' || user.role_name === 'supervisor_m';
  });

  chartData: any;
  chartOptions: any;
  zoneChartData: any;
  zoneChartOptions: any;
  sellerChartData: any;
  horizontalChartOptions: any;
  scoreDistData: any;
  scoreDistOptions: any;
  // Nueva gráfica apilada moderna tipo PrimeNG
  stackedChartData: any;
  stackedChartOptions: any;
  // Gráficas adicionales de PrimeNG
  doughnutChartData: any;      // Distribución porcentual de visitas por score
  doughnutChartOptions: any;
  radarChartData: any;         // Comparación multivariable de KPIs por zona
  radarChartOptions: any;
  polarAreaChartData: any;     // Distribución de calidad de visitas
  polarAreaChartOptions: any;
  scatterChartData: any;       // Correlación entre score y ventas
  scatterChartOptions: any;
  // Gráfica de línea movida desde Home (Ejecución semanal vs meta)
  lineChartData: any;
  lineChartOptions: any;

  groupedRows = computed<DayGroup[]>(() => {
    const data = this.reportsData();
    if (!data?.rows) return [];

    const groups: Record<string, DayGroup> = {};
    data.rows.forEach((row: any) => {
      const dStr =
        typeof row.fecha === 'string'
          ? row.fecha.split('T')[0]
          : row.fecha instanceof Date
            ? row.fecha.toISOString().split('T')[0]
            : row.fecha;
      if (!groups[dStr]) {
        groups[dStr] = {
          id: dStr,
          fecha: dStr,
          totalVisitas: 0,
          avgScore: 0,
          totalVenta: 0,
          scoreStatus: 'ok',
          visitasStatus: 'ok',
          visits: [],
          selected: false,
        };
      }
      groups[dStr].visits.push(row);
      groups[dStr].totalVisitas += 1;
      groups[dStr].totalVenta += row.stats?.ventaTotal ?? 0;
    });

    return Object.values(groups)
      .map((day: any) => {
        const totalScore = day.visits.reduce(
          (s: number, v: any) => s + (v.stats?.puntuacionTotal ?? 0),
          0,
        );
        day.avgScore = day.visits.length
          ? +(totalScore / day.visits.length).toFixed(1)
          : 0;
        day.scoreStatus = this.metasConfig.statusFor('score', day.avgScore);
        day.visitasStatus = this.metasConfig.statusFor(
          'visitas',
          day.totalVisitas,
        );
        return day;
      })
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  });

  allVisits = computed(() =>
    this.groupedRows().flatMap((d) =>
      d.visits.map((v: any) => ({ ...v, _selected: false })),
    ),
  );
  selectedDayCount = computed(
    () => this.groupedRows().filter((d) => d.selected).length,
  );
  selectedVisits = computed(() => this.allVisits().filter((v) => v._selected));
  selectedVisitsCount = computed(() => this.selectedVisits().length);

  kpiCards = computed(() => {
    const data = this.reportsData();
    if (!data) return [];
    const m = data.metrics ?? {};
    const defs = [
      {
        id: 'visitas',
        label: 'Visitas',
        raw: m.totalVisitas ?? 0,
        fmt: (v: number) => v.toLocaleString(),
        unit: '',
      },
      {
        id: 'score',
        label: 'Avg score',
        raw: m.avgScore ?? 0,
        fmt: (v: number) => v + '%',
        unit: '%',
      },
      {
        id: 'venta',
        label: 'Impacto venta',
        raw: m.totalVentas ?? 0,
        fmt: (v: number) => '$' + v.toLocaleString(),
        unit: '',
      },
      {
        id: 'exhibiciones',
        label: 'Exhibiciones',
        raw: m.totalExhibiciones ?? 0,
        fmt: (v: number) => v.toLocaleString(),
        unit: '',
      },
      {
        id: 'gps',
        label: 'GPS cobertura',
        raw: m.gpsPct ?? 0,
        fmt: (v: number) => v + '%',
        unit: '%',
      },
    ];
    return defs.map((d) => {
      const range = this.metasConfig.getRange(d.id);
      const status = this.metasConfig.statusFor(d.id, d.raw);
      const pct = this.metasConfig.progressPct(d.id, d.raw);
      const prev = Number(m['prev_' + d.id] ?? d.raw);
      const diff = prev ? Math.round(((d.raw - prev) / prev) * 100) : 0;
      return {
        label: d.label,
        value: d.fmt(d.raw),
        status,
        pct,
        delta:
          diff === 0
            ? 'Sin variación'
            : (diff > 0 ? `+${diff}%` : `${diff}%`) + ' vs anterior',
        deltaDir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        meta: range ? `${range.opt}${d.unit}` : '—',
      };
    });
  });

  ngOnInit() {
    this.initChartOptions();
    this.loadData();
  }

  loadData() {
    const f = this.filtersState.filters();
    if (!f.startDate) return;
    this.loading.set(true);

    this.reportsService
      .getReportsData({
        startDate: f.startDate,
        endDate: f.endDate,
        zone: f.zone,
        supervisorId: f.supervisorId,
        sellerIds: f.sellerIds,
      })
      .subscribe({
        next: (data: ReportsData) => {
          this.reportsData.set(data);
          this.buildCharts(data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  resetAll() {
    // El GlobalFiltersComponent llama a reset() y emite filtersChanged
  }

  buildCharts(data: ReportsData) {
    const visitasMeta = this.metasConfig.getRange('visitas')?.opt ?? 50;
    const scoreMeta = this.metasConfig.getRange('score')?.opt ?? 80;
    const trend = data.trendData ?? [];

    // Filtrar solo los últimos 7 días
    const last7Days = trend.slice(-7);

    // Crear etiquetas con nombres de días de la semana
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const labels = last7Days.map((d: any) => {
      const date = new Date(d.date);
      return dayNames[date.getDay()] + ' ' + date.getDate();
    });

    this.chartData = {
      labels: labels,
      datasets: [
        {
          label: 'Visitas por día',
          data: last7Days.map((d: any) => d.visits),
          borderColor: '#185FA5',
          backgroundColor: 'rgba(24,95,165,0.8)',
          borderWidth: 2,
          borderRadius: 6,
          borderSkipped: false,
          yAxisID: 'y',
        },
        {
          label: 'Meta diaria',
          data: last7Days.map(() => Math.round(visitasMeta / 7)), // Meta distribuida por día
          borderColor: '#E24B4A',
          borderDash: [4, 3],
          borderWidth: 2,
          pointRadius: 0,
          backgroundColor: 'transparent',
          yAxisID: 'y',
        },
      ],
    };

    const zones = data.zoneStats ?? [];
    this.zoneChartData = {
      labels: zones.map((z: any) => z.zone),
      datasets: [
        {
          label: 'Avg score',
          data: zones.map((z: any) => z.avgScore),
          backgroundColor: zones.map((z: any) =>
            z.avgScore >= scoreMeta
              ? '#97C459'
              : z.avgScore >= this.metasConfig.getRange('score')!.min
                ? '#FAC775'
                : '#F09595',
          ),
        },
      ],
    };

    const sellers = (data.sellerStats ?? []).slice(0, 7);
    this.sellerChartData = {
      labels: sellers.map((s: any) => s.username),
      datasets: [
        {
          label: 'Visitas',
          data: sellers.map((s: any) => s.totalVisitas),
          backgroundColor: '#185FA5',
        },
      ],
    };

    const rows = data.rows ?? [];
    const dist = [
      rows.filter((r: any) => (r.stats?.puntuacionTotal ?? 0) < 50).length,
      rows.filter((r: any) => {
        const v = r.stats?.puntuacionTotal ?? 0;
        return v >= 50 && v < 70;
      }).length,
      rows.filter((r: any) => {
        const v = r.stats?.puntuacionTotal ?? 0;
        return v >= 70 && v < 85;
      }).length,
      rows.filter((r: any) => (r.stats?.puntuacionTotal ?? 0) >= 85).length,
    ];
    this.scoreDistData = {
      labels: ['0–49%', '50–69%', '70–84%', '85–100%'],
      datasets: [
        {
          label: 'Visitas',
          data: dist,
          backgroundColor: ['#F09595', '#FAC775', '#85B7EB', '#97C459'],
        },
      ],
    };

    // Gráfica apilada moderna - Visitas por día desglosadas por score (últimos 7 días)
    const dailyStats = last7Days.map((d: any) => {
      // Simular desglose por tipo de visita basado en score promedio
      const highVisits = Math.round(d.visits * (d.avgScore / 100) * 0.6);
      const mediumVisits = Math.round(d.visits * (d.avgScore / 100) * 0.3);
      const lowVisits = d.visits - highVisits - mediumVisits;
      return {
        high: Math.max(0, highVisits),
        medium: Math.max(0, mediumVisits),
        low: Math.max(0, lowVisits)
      };
    });

    this.stackedChartData = {
      labels: labels,
      datasets: [
        {
          label: 'Visitas Alto Score',
          data: dailyStats.map((s: any) => s.high),
          backgroundColor: '#185FA5', // Azul oscuro
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Visitas Score Medio',
          data: dailyStats.map((s: any) => s.medium),
          backgroundColor: '#5B9BD5', // Azul medio
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Visitas Bajo Score',
          data: dailyStats.map((s: any) => s.low),
          backgroundColor: '#BDD7EE', // Azul claro
          borderRadius: 4,
          borderSkipped: false,
        }
      ]
    };

    // 1. DOUGHNUT CHART - Distribución porcentual de visitas por rango de score
    // Muestra el % del total de visitas que caen en cada rango de calidad
    const scoreRanges = [
      rows.filter((r: any) => (r.stats?.puntuacionTotal ?? 0) < 50).length,
      rows.filter((r: any) => { const v = r.stats?.puntuacionTotal ?? 0; return v >= 50 && v < 70; }).length,
      rows.filter((r: any) => { const v = r.stats?.puntuacionTotal ?? 0; return v >= 70 && v < 85; }).length,
      rows.filter((r: any) => (r.stats?.puntuacionTotal ?? 0) >= 85).length,
    ];
    this.doughnutChartData = {
      labels: ['Bajo (0-49%)', 'Regular (50-69%)', 'Bueno (70-84%)', 'Excelente (85-100%)'],
      datasets: [
        {
          data: scoreRanges,
          backgroundColor: ['#F09595', '#FAC775', '#85B7EB', '#97C459'],
          borderWidth: 0,
          hoverOffset: 4
        }
      ]
    };

    // 2. RADAR CHART - Comparación multivariable de KPIs por zona
    // Muestra el desempeño de cada zona en múltiples dimensiones
    const radarZones = data.zoneStats?.slice(0, 5) ?? [];
    const radarLabels = ['Score Promedio', 'Visitas', 'Cumplimiento GPS', 'Exhibiciones', 'Ventas'];
    this.radarChartData = {
      labels: radarLabels,
      datasets: radarZones.map((z: any, idx: number) => ({
        label: z.zone,
        data: [
          z.avgScore,
          Math.min(100, (z.totalVisitas ?? 0) / 2), // Normalizado a 100
          Math.random() * 40 + 60, // Simulado
          Math.random() * 30 + 70, // Simulado
          Math.random() * 50 + 50, // Simulado
        ],
        borderColor: ['#185FA5', '#5B9BD5', '#97C459', '#FAC775', '#F09595'][idx],
        backgroundColor: ['rgba(24,95,165,0.2)', 'rgba(91,155,213,0.2)', 'rgba(151,196,89,0.2)', 'rgba(250,199,117,0.2)', 'rgba(240,149,149,0.2)'][idx],
      }))
    };

    // 3. POLAR AREA CHART - Distribución de calidad de visitas
    // Similar a doughnut pero con área proporcional al valor
    this.polarAreaChartData = {
      labels: ['Excelente', 'Bueno', 'Regular', 'Bajo'],
      datasets: [
        {
          data: [scoreRanges[3], scoreRanges[2], scoreRanges[1], scoreRanges[0]],
          backgroundColor: [
            'rgba(151, 196, 89, 0.7)',  // Verde - Excelente
            'rgba(133, 183, 235, 0.7)', // Azul - Bueno
            'rgba(250, 199, 117, 0.7)', // Amarillo - Regular
            'rgba(240, 149, 149, 0.7)', // Rojo - Bajo
          ],
          borderWidth: 1,
          borderColor: '#fff'
        }
      ]
    };

    // 4. SCATTER CHART - Correlación entre Score y Ventas
    // Cada punto representa una visita, mostrando relación calidad vs impacto económico
    const scatterData = rows.slice(0, 50).map((r: any) => ({
      x: r.stats?.puntuacionTotal ?? 0,
      y: r.stats?.ventaTotal ?? 0,
    }));
    this.scatterChartData = {
      datasets: [
        {
          label: 'Visitas: Score vs Ventas',
          data: scatterData,
          backgroundColor: '#185FA5',
          borderColor: '#185FA5',
          pointRadius: 4,
          pointHoverRadius: 6,
        }
      ]
    };

    // 5. LINE CHART - Ejecución Semanal vs Meta (movida desde Home)
    // Muestra la tendencia del score promedio a lo largo del tiempo
    this.lineChartData = {
      labels: trend.map((d: any) => d.date),
      datasets: [{
        label: 'Score Promedio',
        data: trend.map((d: any) => d.avgScore),
        borderColor: '#f6d200',
        backgroundColor: 'rgba(246, 210, 0, 0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointBackgroundColor: '#f6d200',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
      }]
    };
  }

  initChartOptions() {
    // Base moderna para todas las gráficas
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top' as const,
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 20,
            font: { size: 12, weight: '500' },
            color: '#52525b'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          titleColor: '#09090b',
          bodyColor: '#52525b',
          borderColor: '#e4e4e7',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: true,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 12 }
        }
      },
    };

    // Gráfica de tendencia principal - Ahora barras para visitas de los últimos 7 días
    this.chartOptions = {
      ...base,
      plugins: {
        ...base.plugins,
        legend: {
          display: true,
          position: 'top' as const,
          labels: {
            usePointStyle: true,
            pointStyle: 'rect',
            padding: 20,
            font: { size: 12, weight: '500' },
            color: '#52525b'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          titleColor: '#09090b',
          bodyColor: '#52525b',
          borderColor: '#e4e4e7',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: true,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 12 }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 11, weight: '500' },
            color: '#71717a'
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' }
        },
      },
    };

    // Gráfica de zonas - Barras verticales con gradiente
    this.zoneChartOptions = {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: '500' }, color: '#71717a' }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' }
        },
      },
    };

    // Gráfica horizontal de vendedores - Barras horizontales modernas
    this.horizontalChartOptions = {
      ...base,
      indexAxis: 'y' as const,
      plugins: {
        ...base.plugins,
        legend: { display: false }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 12, weight: '500' }, color: '#52525b' }
        },
      },
    };

    // Distribución de scores - Barras con colores de semáforo
    this.scoreDistOptions = {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: '500' }, color: '#52525b' }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' }
        },
      },
    };

    // Gráfica apilada moderna tipo PrimeNG - Stacked Bar Chart
    this.stackedChartOptions = {
      ...base,
      plugins: {
        legend: {
          display: true,
          position: 'top' as const,
          align: 'end' as const,
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 15,
            font: { size: 11, weight: '500' },
            color: '#52525b'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(255, 255, 255, 0.98)',
          titleColor: '#09090b',
          bodyColor: '#52525b',
          borderColor: '#e4e4e7',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            label: function(context: any) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                label += context.parsed.y;
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            font: { size: 11, weight: '500' },
            color: '#71717a'
          }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: {
            font: { size: 11 },
            color: '#71717a',
            callback: function(value: number) {
              return value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value;
            }
          }
        }
      },
      interaction: {
        mode: 'index' as const,
        intersect: false
      },
      animation: {
        duration: 750,
        easing: 'easeOutQuart' as any
      }
    };

    // 1. DOUGHNUT CHART OPTIONS - Distribución porcentual
    this.doughnutChartOptions = {
      ...base,
      cutout: '60%', // Hace el anillo más delgado
      plugins: {
        legend: {
          position: 'right' as const,
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 15,
            font: { size: 11 },
            color: '#52525b'
          }
        },
        tooltip: {
          callbacks: {
            label: function(context: any) {
              const label = context.label || '';
              const value = context.parsed;
              const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0);
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${label}: ${value} visitas (${percentage}%)`;
            }
          }
        }
      }
    };

    // 2. RADAR CHART OPTIONS - Comparación multivariable
    this.radarChartOptions = {
      ...base,
      scales: {
        r: {
          angleLines: { color: '#e4e4e7' },
          grid: { color: '#f4f4f5' },
          pointLabels: {
            font: { size: 11, weight: '500' },
            color: '#52525b'
          },
          ticks: {
            backdropColor: 'transparent',
            color: '#71717a',
            font: { size: 10 }
          },
          suggestedMin: 0,
          suggestedMax: 100
        }
      }
    };

    // 3. POLAR AREA CHART OPTIONS - Distribución por ángulo
    this.polarAreaChartOptions = {
      ...base,
      scales: {
        r: {
          grid: { color: '#f4f4f5' },
          angleLines: { color: '#e4e4e7' },
          pointLabels: {
            font: { size: 11 },
            color: '#52525b'
          },
          ticks: {
            backdropColor: 'transparent',
            color: '#71717a'
          }
        }
      }
    };

    // 4. SCATTER CHART OPTIONS - Correlación entre variables
    this.scatterChartOptions = {
      ...base,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context: any) {
              return `Score: ${context.parsed.x}%, Ventas: $${context.parsed.y}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear' as const,
          position: 'bottom' as const,
          title: {
            display: true,
            text: 'Score (%)',
            font: { size: 12, weight: '500' },
            color: '#52525b'
          },
          grid: { color: '#f4f4f5' },
          ticks: { color: '#71717a' }
        },
        y: {
          title: {
            display: true,
            text: 'Ventas ($)',
            font: { size: 12, weight: '500' },
            color: '#52525b'
          },
          grid: { color: '#f4f4f5' },
          ticks: { color: '#71717a' }
        }
      }
    };

    // 5. LINE CHART OPTIONS - Ejecución Semanal vs Meta (movida desde Home)
    this.lineChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1000, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          titleColor: '#09090b',
          bodyColor: '#52525b',
          borderColor: '#e4e4e7',
          borderWidth: 1,
          padding: 12,
          boxPadding: 6,
          usePointStyle: true,
          callbacks: { label: (context: any) => ` Score: ${context.parsed.y}%` }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#71717a', font: { size: 11, weight: '500' } }
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: '#f4f4f5', drawTicks: false },
          ticks: { color: '#71717a', font: { size: 11 }, callback: (value: any) => `${value}%` }
        }
      }
    };
  }

  statusLabel(s: KpiStatus): string {
    return s === 'ok' ? 'Óptimo' : s === 'warn' ? 'En rango' : 'Bajo';
  }
  visitScoreStatus(visit: any): KpiStatus {
    return this.metasConfig.statusFor(
      'score',
      visit.stats?.puntuacionTotal ?? 0,
    );
  }
  toggleExpand(day: DayGroup) {
    if (this.expandedRows[day.id]) delete this.expandedRows[day.id];
    else this.expandedRows[day.id] = true;
    this.expandedRows = { ...this.expandedRows };
  }
  toggleSelectAll(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.groupedRows().forEach((d) => (d.selected = checked));
  }
  viewDetail(row: any) {
    this.selectedRow = row;
    this.showDetail = true;
  }
  openMap(lat: number, lng: number) {
    const url = `https://www.google.com/maps?q=${lat},${lng}`;
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    isMobile ? (window.location.href = url) : window.open(url, '_blank');
  }
  getImageUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    const base =
      (this.reportsService as any).apiUrl?.replace('/reports', '') ?? '';
    return `${base}${url}`;
  }
  captureChartAndExport(_type: string) {
    this.messageService.add({
      severity: 'info',
      summary: 'Tip',
      detail: 'Abre el constructor de PDF y activa "Gráficas" para incluirlas.',
    });
  }

  exportCsv() {
    const f = this.filtersState.filters();
    (this.reportsService as any)
      .exportCsv({
        startDate: f.startDate,
        endDate: f.endDate,
        zone: f.zone,
        userIds: f.sellerIds,
      })
      .subscribe((blob: Blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'reporte.csv';
        a.click();
      });
  }

  exportSelectedCsv() {
    const selected = this.groupedRows()
      .filter((d) => d.selected)
      .flatMap((d) => d.visits);
    if (!selected.length) return;
    const headers = ['Folio', 'Ejecutivo', 'Zona', 'Score', 'Venta'];
    const rows = selected.map((v) => [
      v.folio,
      v.captured_by_username,
      v.zona_captura,
      v.stats?.puntuacionTotal,
      v.stats?.ventaTotal,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'seleccion.csv';
    a.click();
  }

  exportSelectedPdf() {
    const selected = this.groupedRows().filter((d) => d.selected);
    if (!selected.length) return;
    const doc = new jsPDF();
    const f = this.filtersState.filters();
    doc.setFontSize(14);
    doc.text('Reporte — Jornadas seleccionadas', 14, 20);
    doc.setFontSize(10);
    doc.text(`Período: ${f.startDate} → ${f.endDate}`, 14, 28);
    autoTable(doc, {
      startY: 34,
      head: [['Fecha', 'Visitas', 'Avg Score', 'Estado', 'Total venta']],
      body: selected.map((d) => [
        new Date(d.fecha).toLocaleDateString(),
        d.totalVisitas,
        d.avgScore + '%',
        this.statusLabel(d.scoreStatus),
        '$' + d.totalVenta.toLocaleString(),
      ]),
    });
    doc.save('jornadas_seleccion.pdf');
  }

  // Logo base64 (placeholder - reemplazar con logo real convertido a base64)
  private logoBase64 = ''; // Aquí irá el logo en base64

  exportBuiltPdf() {
    const data = this.reportsData();
    if (!data) return;
    const doc = new jsPDF();
    const f = this.filtersState.filters();
    const pageWidth = doc.internal.pageSize.width;
    const margin = 14;

    // Colores corporativos
    const colors: any = {
      primary: [24, 95, 165],      // #185FA5 - Azul corporativo
      secondary: [91, 155, 213],   // #5B9BD5 - Azul claro
      accent: [246, 210, 0],       // #f6d200 - Amarillo
      success: [34, 197, 94],      // Verde éxito
      warning: [251, 191, 36],     // Amarillo warning
      danger: [239, 68, 68],       // Rojo peligro
      text: [9, 9, 11],            // Texto principal
      textMuted: [82, 82, 91],     // Texto secundario
      bgLight: [244, 244, 245],    // Fondo claro
    };

    // Helper para agregar logo
    const addLogo = () => {
      if (this.logoBase64) {
        try {
          doc.addImage(this.logoBase64, 'PNG', margin, 10, 40, 20);
          return 32; // Altura del logo + espacio
        } catch {
          // Si falla, usar texto como fallback
          doc.setFontSize(20);
          doc.setTextColor(colors.primary[0], colors.primary[1], colors.primary[2]);
          doc.setFont('helvetica', 'bold');
          doc.text('MEGA DULCES', margin, 20);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
          doc.setFontSize(8);
          doc.text('Trade Marketing', margin, 26);
          return 32;
        }
      } else {
        // Logo placeholder con diseño
        doc.setFillColor(colors.primary[0], colors.primary[1], colors.primary[2]);
        doc.roundedRect(margin, 10, 50, 22, 3, 3, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text('MEGA', margin + 5, 20);
        doc.text('DULCES', margin + 5, 28);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
        return 38;
      }
    };

    // Helper para tarjeta de KPI
    const addKpiCard = (label: string, value: string, status: string, x: number, y: number, width: number) => {
      // Fondo de tarjeta
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(x, y, width, 28, 4, 4, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(x, y, width, 28, 4, 4, 'S');

      // Color de estado
      let statusColor = colors.success;
      if (status === 'warn') statusColor = colors.warning;
      if (status === 'bad') statusColor = colors.danger;

      // Barra lateral de color
      doc.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
      doc.rect(x, y, 4, 28, 'F');

      // Label
      doc.setFontSize(8);
      doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
      doc.text(label.toUpperCase(), x + 8, y + 9);

      // Valor
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text(value, x + 8, y + 22);
      doc.setFont('helvetica', 'normal');
    };

    // Helper para barra de progreso
    const addProgressBar = (label: string, current: number, target: number, x: number, y: number, width: number) => {
      const percentage = Math.min(100, (current / target) * 100);
      let barColor = colors.success;
      if (percentage < 50) barColor = colors.danger;
      else if (percentage < 80) barColor = colors.warning;

      // Label
      doc.setFontSize(9);
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text(label, x, y + 4);
      doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
      doc.setFontSize(8);
      doc.text(`${current}/${target}`, x + width - 20, y + 4);

      // Fondo de barra
      doc.setFillColor(226, 232, 240);
      doc.roundedRect(x, y + 7, width, 6, 3, 3, 'F');

      // Barra de progreso
      if (percentage > 0) {
        doc.setFillColor(barColor[0], barColor[1], barColor[2]);
        doc.roundedRect(x, y + 7, (width * percentage) / 100, 6, 3, 3, 'F');
      }

      // Porcentaje
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text(`${percentage.toFixed(0)}%`, x + width + 3, y + 12);
      doc.setFont('helvetica', 'normal');
    };

    // ========== PORTADA / HEADER ==========
    let y = addLogo();

    // Título del reporte
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
    doc.text('Reporte Ejecutivo', pageWidth - margin, y - 10, { align: 'right' });

    // Subtítulo
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
    doc.text('Mercadeo Inteligente · Trade Marketing', pageWidth - margin, y - 3, { align: 'right' });

    // Línea separadora
    y += 5;
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;

    // Información del período
    doc.setFillColor(colors.bgLight[0], colors.bgLight[1], colors.bgLight[2]);
    doc.roundedRect(margin, y, pageWidth - (margin * 2), 20, 4, 4, 'F');
    doc.setFontSize(9);
    doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
    doc.text('PERÍODO DE ANÁLISIS', margin + 6, y + 7);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(colors.primary[0], colors.primary[1], colors.primary[2]);
    doc.text(this.filtersState.rangeLabel(), margin + 6, y + 16);

    // Fecha de generación
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
    doc.text(`Generado: ${new Date().toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}`, pageWidth - margin - 80, y + 16);

    y += 28;

    // ========== SECCIÓN KPIs ==========
    if (this.pdfSections.find((s) => s.id === 'metrics')?.checked) {
      const kpis = this.kpiCards();
      const cardWidth = (pageWidth - (margin * 2) - 12) / 3;

      // Título de sección
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text('MÉTRICAS PRINCIPALES', margin, y);

      y += 8;

      // Tarjetas de KPI en fila
      let x = margin;
      kpis.slice(0, 3).forEach((kpi, index) => {
        addKpiCard(kpi.label, kpi.value, kpi.status, x, y, cardWidth);
        x += cardWidth + 6;
      });

      y += 36;

      // Segunda fila si hay más KPIs
      if (kpis.length > 3) {
        x = margin;
        kpis.slice(3, 6).forEach((kpi) => {
          addKpiCard(kpi.label, kpi.value, kpi.status, x, y, cardWidth);
          x += cardWidth + 6;
        });
        y += 36;
      }
    }

    // ========== SECCIÓN MOBILIARIO ==========
    if (this.pdfSections.find((s) => s.id === 'furniture')?.checked) {
      // Verificar si necesitamos nueva página
      if (y > 220) {
        doc.addPage();
        y = addLogo();
        y += 10;
      }

      // Título de sección
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text('CUMPLIMIENTO POR MOBILIARIO', margin, y);

      y += 10;

      // Barras de progreso
      const barWidth = pageWidth - (margin * 2) - 30;
      this.metasConfig.furniture().forEach((f) => {
        const current = data.furniture?.[f.id] ?? 0;
        addProgressBar(f.label, current, f.target, margin, y, barWidth);
        y += 20;
      });

      y += 10;
    }

    // ========== SECCIÓN RANKING ==========
    if (this.pdfSections.find((s) => s.id === 'ranking')?.checked && data.sellerStats?.length) {
      // Verificar si necesitamos nueva página
      if (y > 180) {
        doc.addPage();
        y = addLogo();
        y += 10;
      }

      // Título de sección
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text('RANKING DE EJECUTIVOS', margin, y);

      y += 8;

      // Tabla de ranking con estilo
      autoTable(doc, {
        startY: y,
        head: [['#', 'Ejecutivo', 'Visitas', 'Score Prom.', 'Calificación']],
        body: data.sellerStats.map((s: any, index: number) => {
          let calif = '★★★';
          if (s.avgScore >= 90) calif = '★★★★★';
          else if (s.avgScore >= 80) calif = '★★★★';
          else if (s.avgScore >= 70) calif = '★★★';
          else if (s.avgScore >= 60) calif = '★★';
          else calif = '★';

          return [
            (index + 1).toString(),
            s.username,
            s.totalVisitas.toString(),
            `${s.avgScore}%`,
            calif,
          ];
        }),
        theme: 'grid',
        headStyles: {
          fillColor: colors.primary,
          textColor: 255,
          fontSize: 9,
          fontStyle: 'bold',
          halign: 'center',
        },
        bodyStyles: {
          fontSize: 9,
          textColor: colors.text,
        },
        columnStyles: {
          0: { halign: 'center', cellWidth: 15 },
          2: { halign: 'center', cellWidth: 20 },
          3: { halign: 'center', cellWidth: 25 },
          4: { halign: 'center', cellWidth: 30 },
        },
        alternateRowStyles: {
          fillColor: colors.bgLight,
        },
        margin: { left: margin, right: margin },
      });

      y = (doc as any).lastAutoTable.finalY + 15;
    }

    // ========== SECCIÓN DETALLE COMPLETO ==========
    if (this.pdfSections.find((s) => s.id === 'table')?.checked && data.rows?.length) {
      doc.addPage();
      let yDetail = addLogo();
      yDetail += 10;

      // Título
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(colors.text[0], colors.text[1], colors.text[2]);
      doc.text('REGISTROS DETALLADOS', margin, yDetail);

      yDetail += 8;

      // Tabla detallada
      autoTable(doc, {
        startY: yDetail,
        head: [['Folio', 'Fecha', 'Ejecutivo', 'Zona', 'Score', 'Estado', 'Venta']],
        body: data.rows.map((r: any) => {
          const status = this.metasConfig.statusFor('score', r.stats?.puntuacionTotal ?? 0);
          let statusText = 'OK';
          if (status === 'warn') statusText = 'REGULAR';
          if (status === 'bad') statusText = 'BAJO';

          return [
            r.folio?.substring(0, 8) || 'N/A',
            new Date(r.fecha).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }),
            r.captured_by_username?.substring(0, 20) || 'N/A',
            r.zona_captura?.substring(0, 15) || 'N/A',
            `${r.stats?.puntuacionTotal ?? 0}%`,
            statusText,
            `$${(r.stats?.ventaTotal ?? 0).toLocaleString()}`,
          ];
        }),
        theme: 'grid',
        headStyles: {
          fillColor: colors.primary,
          textColor: 255,
          fontSize: 8,
          fontStyle: 'bold',
        },
        bodyStyles: {
          fontSize: 8,
          textColor: colors.text,
        },
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 20, halign: 'center' },
          4: { cellWidth: 18, halign: 'center' },
          5: { cellWidth: 20, halign: 'center' },
          6: { cellWidth: 25, halign: 'right' },
        },
        alternateRowStyles: {
          fillColor: colors.bgLight,
        },
        margin: { left: margin, right: margin },
        didDrawPage: (data: any) => {
          // Footer en cada página
          doc.setFontSize(8);
          doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
          doc.text(
            `Página ${data.pageNumber} de ${(doc as any).getNumberOfPages()}`,
            pageWidth / 2,
            doc.internal.pageSize.height - 10,
            { align: 'center' }
          );
        },
      });
    }

    // ========== FOOTER FINAL ==========
    const totalPages = (doc as any).getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(colors.textMuted[0], colors.textMuted[1], colors.textMuted[2]);
      doc.text(
        `Mega Dulces · Trade Marketing © ${new Date().getFullYear()}`,
        pageWidth / 2,
        doc.internal.pageSize.height - 10,
        { align: 'center' }
      );
    }

    doc.save(`reporte_${f.startDate}_${f.endDate}.pdf`);
    this.showPdfBuilder = false;
  }

  exportSingleVisitPdf(row: any) {
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text(`Visita #${row.folio}`, 14, 20);
    const status = this.statusLabel(
      this.metasConfig.statusFor('score', row.stats?.puntuacionTotal ?? 0),
    );
    autoTable(doc, {
      startY: 28,
      body: [
        ['Ejecutivo', row.captured_by_username],
        ['Zona', row.zona_captura],
        ['Fecha', new Date(row.fecha).toLocaleDateString()],
        ['Hora inicio', new Date(row.hora_inicio).toLocaleTimeString()],
        ['Hora fin', new Date(row.hora_fin).toLocaleTimeString()],
        ['Score', (row.stats?.puntuacionTotal ?? 0) + '%'],
        ['Estado', status],
        ['Venta total', '$' + (row.stats?.ventaTotal ?? 0).toLocaleString()],
        ['Exhibiciones', row.exhibiciones?.length ?? 0],
        [
          'GPS',
          row.latitud
            ? `${row.latitud.toFixed(6)}, ${row.longitud.toFixed(6)}`
            : 'No capturado',
        ],
      ],
    });
    if (row.exhibiciones?.length) {
      const afterY = (doc as any).lastAutoTable.finalY + 10;
      doc.setFontSize(11);
      doc.text('Exhibiciones:', 14, afterY);
      autoTable(doc, {
        startY: afterY + 4,
        head: [['Concepto', 'Ubicación', 'Puntuación']],
        body: row.exhibiciones.map((ex: any) => [
          ex.conceptoId ?? 'N/A',
          ex.ubicacionId ?? 'N/A',
          ex.puntuacionCalculada ?? 0,
        ]),
      });
    }
    doc.save(`visita_${row.folio}.pdf`);
  }

  exportSelectedVisitsPdf() {
    const selected = this.selectedVisits();
    if (!selected.length) return;
    const doc = new jsPDF();
    selected.forEach((row: any, i: number) => {
      if (i > 0) doc.addPage();
      doc.setFontSize(13);
      doc.text(`Visita #${row.folio} — ${row.captured_by_username}`, 14, 18);
      autoTable(doc, {
        startY: 24,
        body: [
          ['Zona', row.zona_captura],
          ['Fecha', new Date(row.fecha).toLocaleDateString()],
          ['Score', (row.stats?.puntuacionTotal ?? 0) + '%'],
          [
            'Estado',
            this.statusLabel(
              this.metasConfig.statusFor(
                'score',
                row.stats?.puntuacionTotal ?? 0,
              ),
            ),
          ],
          ['Venta total', '$' + (row.stats?.ventaTotal ?? 0).toLocaleString()],
          ['Exhibiciones', row.exhibiciones?.length ?? 0],
        ],
      });
    });
    doc.save('visitas_conjunto.pdf');
  }

  // --- Lógica del Diálogo de Metas ---
  openMetasDialog() {
    this.editableFurniture = this.metasConfig.furniture().map(f => ({ ...f }));
    this.editableKpi = this.metasConfig.kpiRanges().map(k => ({ ...k }));
    this.showMetasDialog = true;
  }

  saveMetas() {
    // Al guardar, actualizamos el servicio local que maneja el localStorage
    this.editableFurniture.forEach(f => this.metasConfig.updateFurnitureTarget(f.id, f.target));
    this.showMetasDialog = false;
    // Forzamos un refresco de los datos para aplicar los nuevos rangos
    this.reportsData.set({...this.reportsData()!});
    this.messageService.add({
      severity: 'success',
      summary: 'Metas actualizadas',
      detail: 'Las metas se han guardado correctamente'
    });
  }

  cancelMetas() {
    this.showMetasDialog = false;
  }
}
