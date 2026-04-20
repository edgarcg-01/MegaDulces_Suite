import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
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
import { ChipModule } from 'primeng/chip';
import { MultiSelectModule } from 'primeng/multiselect';
import { DropdownModule } from 'primeng/dropdown';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

import { ReportsService, ReportsData } from './reports.service';
import { AuthService } from '../../../core/services/auth.service';
import { FiltersStateService } from '../reports/graphics/filters-state.service';
import { DailyCaptureService } from '../captures/daily-capture.service';
import {
  UBICACIONES_EXHIBICION,
  CONCEPTOS_EXHIBICION,
  PRODUCTOS_PLANOGRAMA,
  BrandGroup,
} from '../captures/daily-capture.models';
import {
  MetasConfigService,
  KpiStatus,
} from '../reports/graphics/metas-config.service';
import { GlobalFiltersComponent } from '../reports/graphics/global-filters.component';
import { Permission } from '../../../core/constants/permissions';

/**
 * Interfaz para agrupar visitas por día
 */
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

/**
 * Interfaz para secciones del PDF
 */
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
    ChipModule,
    MultiSelectModule,
    DropdownModule,
    GlobalFiltersComponent,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
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
/**
 * Componente principal de reportes y análisis de métricas
 * Muestra KPIs, gráficas y tablas de visitas individuales
 */
export class ReportsComponent implements OnInit {
  private reportsService = inject(ReportsService);
  private auth = inject(AuthService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  readonly filtersState = inject(FiltersStateService);
  readonly metasConfig = inject(MetasConfigService);
  private dailyCaptureService = inject(DailyCaptureService);

  /** Estado de carga */
  loading = signal(false);
  /** Datos de reportes */
  reportsData = signal<ReportsData | null>(null);
  /** Texto de búsqueda */
  searchText = '';
  /** Filas expandidas en la tabla */
  expandedRows: { [key: string]: boolean } = {};
  /** Fila seleccionada */
  selectedRow: any = null;
  /** Muestra el diálogo de detalle */
  showDetail = false;
  /** Muestra el constructor de PDF */
  showPdfBuilder = false;
  /** Muestra el diálogo de comparación */
  showComparison = false;
  /** Muestra el diálogo de reporte de rutas */
  showRouteReportDialog = false;
  /** Muestra la vista previa de imagen */
  showImagePreview = false;
  /** URL de imagen para vista previa */
  previewImageUrl = '';
  /** Usuarios seleccionados para reporte de rutas */
  selectedRouteUsers: string[] = [];
  /** Fecha del reporte de rutas */
  routeReportDate: string = '';
  /** Usuarios disponibles */
  availableUsers = signal<any[]>([]);
  /** Productos por usuario procesados para mostrar */
  sellerProductsByUser = computed(() => {
    const data = this.reportsData();
    if (!data?.sellerProductStats || !data?.productMap) return [];

    const userMap = new Map();
    const rows = data.rows || [];

    // Mapear userId a username
    rows.forEach((row: any) => {
      if (row.user_id && row.captured_by_username) {
        userMap.set(row.user_id, row.captured_by_username);
      }
    });

    // Procesar productos por usuario
    const result: Array<{
      userId: string;
      username: string;
      products: Array<{ name: string; brandName: string; count: number }>;
      totalProducts: number;
    }> = [];

    Object.entries(data.sellerProductStats).forEach(([userId, products]) => {
      const username = userMap.get(userId) || userId;
      const productList = Object.entries(products).map(([pid, count]) => ({
        name: data.productMap?.[pid]?.name || pid,
        brandName: data.productMap?.[pid]?.brandName || 'Otras',
        count: count as number,
      })).sort((a, b) => b.count - a.count);

      result.push({
        userId,
        username,
        products: productList,
        totalProducts: productList.reduce((sum, p) => sum + p.count, 0),
      });
    });

    return result.sort((a, b) => b.totalProducts - a.totalProducts);
  });

  /**
   * Verifica si el usuario es supervisor
   * @returns true si el usuario es superadmin o supervisor_m
   */
  isSupervisor = computed(() => {
    const user = this.auth.user();
    if (!user) return false;
    return user.role_name === 'superadmin' || user.role_name === 'supervisor_m';
  });

  /** Título del PDF */
  pdfTitle = 'Reporte de mercadeo';
  /** Secciones disponibles para el PDF */
  pdfSections: PdfSection[] = [
    { id: 'metrics', label: 'Resumen de métricas', checked: true },
    { id: 'trend', label: 'Gráfica de tendencia', checked: true },
    { id: 'furniture', label: 'Cumplimiento mobiliario', checked: true },
    { id: 'table', label: 'Tabla de registros', checked: true },
    { id: 'ranking', label: 'Ranking por vendedor', checked: false },
  ];

  // Modal de metas (solo superadmin y supervisor_m)
  /** Muestra el diálogo de configuración de metas */
  showMetasDialog = false;
  /** Mobiliario editable */
  editableFurniture = [...this.metasConfig.furniture()].map((f) => ({ ...f }));
  /** Rangos de KPI editables */
  editableKpi = [...this.metasConfig.kpiRanges()].map((k) => ({ ...k }));

  /**
   * Verifica si el usuario puede editar metas
   * @returns true si el usuario es superadmin o supervisor_m
   */
  canEditMetas = computed(() => {
    const user = this.auth.user();
    if (!user) return false;
    return user.role_name === 'superadmin' || user.role_name === 'supervisor_m';
  });

  /**
   * Verifica si el usuario puede gestionar reportes
   * @returns true si el usuario tiene permiso para gestionar reportes
   */
  canManageReports = computed(() => {
    return this.auth.hasPermission(Permission.REPORTES_GESTIONAR);
  });

  /**
   * Muestra el diálogo de confirmación para eliminar un reporte
   * @param report Reporte a eliminar
   */
  confirmDelete(report: any) {
    this.confirmationService.confirm({
      message: `¿Estás seguro de que deseas eliminar permanentemente el reporte con folio <b>${report.folio}</b>? Esta acción no se puede deshacer.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger p-button-text',
      rejectButtonStyleClass: 'p-button-text p-button-secondary',
      accept: () => {
        this.deleteReport(report.id);
      },
    });
  }

  /**
   * Elimina un reporte por su ID
   * @param id ID del reporte a eliminar
   */
  private deleteReport(id: string) {
    this.loading.set(true);
    this.reportsService.deleteReport(id).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Eliminado',
          detail: 'El reporte ha sido eliminado correctamente',
        });
        this.loadData();
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'No se pudo eliminar el reporte',
        });
      },
    });
  }

  constructor() {
    effect(() => {
      // Re-construir los charts de productos cuando cambien los datos Y los catálogos se hayan cargado
      const data = this.reportsData();
      const products = this.dailyCaptureService.groupedProducts();
      if (data?.productStats && products.length > 0) {
        this.buildProductCharts(data);
      }
    });
  }

  /** Datos de la gráfica principal */
  chartData: any;
  /** Opciones de la gráfica principal */
  chartOptions: any;
  /** Datos de la gráfica de zonas */
  zoneChartData: any;
  /** Opciones de la gráfica de zonas */
  zoneChartOptions: any;
  /** Datos de la gráfica de vendedores */
  sellerChartData: any;
  /** Opciones de la gráfica horizontal */
  horizontalChartOptions: any;
  /** Datos de la distribución de scores */
  scoreDistData: any;
  /** Opciones de la distribución de scores */
  scoreDistOptions: any;
  // Nueva gráfica apilada moderna tipo PrimeNG
  /** Datos de la gráfica apilada */
  stackedChartData: any;
  /** Opciones de la gráfica apilada */
  stackedChartOptions: any;
  // Gráficas adicionales de PrimeNG
  /** Datos de la gráfica de doughnut */
  doughnutChartData: any;
  /** Opciones de la gráfica de doughnut */
  doughnutChartOptions: any;
  /** Datos de la gráfica radar */
  radarChartData: any;
  /** Opciones de la gráfica radar */
  radarChartOptions: any;
  /** Datos de la gráfica polar area */
  polarAreaChartData: any;
  /** Opciones de la gráfica polar area */
  polarAreaChartOptions: any;
  /** Datos de la gráfica scatter */
  scatterChartData: any;
  /** Opciones de la gráfica scatter */
  scatterChartOptions: any;
  // Gráfica de línea movida desde Home (Ejecución semanal vs meta)
  /** Datos de la gráfica de línea */
  lineChartData: any;
  /** Opciones de la gráfica de línea */
  lineChartOptions: any;

  // Propiedades para filtrado de productos
  /** Marca seleccionada para filtrar productos */
  selectedBrand: string | null = null;
  /** Marcas disponibles */
  availableBrands: any[] = [];
  /** Estadísticas de productos sin filtrar */
  allProductStatsRaw: any[] = [];

  // Analysis de Productos
  /** Datos de la gráfica de productos top */
  productTopChartData: any;
  /** Productos más frecuentes */
  topProducts: any[] = [];
  /** Productos menos frecuentes */
  bottomProducts: any[] = [];
  /** Indica si se han procesado las estadísticas de productos */
  productStatsProcessed: boolean = false;

  // Nuevas Métricas
  /** Datos de la gráfica de salud de exhibidores */
  exhibidoresHealthChartData: any;
  /** Productos con mayor faltante */
  topFaltantes: any[] = [];

  /**
   * Agrupa las filas de visitas por fecha
   * @returns Lista de grupos de días con estadísticas
   */
  groupedRows = computed<DayGroup[]>(() => {
    const data = this.reportsData();
    if (!data?.rows) return [];

    const groups: Record<string, DayGroup> = {};
    data.rows.forEach((row: any) => {
      const dStr =
        (typeof row.hora_inicio === 'string'
          ? row.hora_inicio.split('T')[0]
          : row.hora_inicio instanceof Date
            ? row.hora_inicio.toISOString().split('T')[0]
            : row.fecha) || row.fecha;
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
          (s: number, v: any) => s + (v.stats?.score_calidad_pct ?? 0),
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
    const m = (data.metrics ?? {}) as ReportsData['metrics'];
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
        raw: (m as any).totalExhibiciones ?? 0,
        fmt: (v: number) => v.toLocaleString(),
        unit: '',
      },
      {
        id: 'avgVenta',
        label: 'Venta promedio',
        raw: (m as any).avgVentaPorVisita ?? 0,
        fmt: (v: number) => '$' + v.toLocaleString(),
        unit: '',
      },
      {
        id: 'stockoutRate',
        label: 'Stockout Rate',
        raw: (m as any).stockoutRate ?? 0,
        fmt: (v: number) => v + '%',
        unit: '%',
      },
      {
        id: 'healthRate',
        label: 'Health Rate',
        raw: (m as any).healthRate ?? 0,
        fmt: (v: number) => v + '%',
        unit: '%',
      },
      {
        id: 'uniqueProducts',
        label: 'Productos Únicos',
        raw: (m as any).uniqueProducts ?? 0,
        fmt: (v: number) => v.toLocaleString(),
        unit: '',
      },
    ];
    return defs.map((d) => {
      const range = this.metasConfig.getRange(d.id);
      const status = this.metasConfig.statusFor(d.id, d.raw);
      const pct = this.metasConfig.progressPct(d.id, d.raw);
      const prev = (m as any)['prev_' + d.id] ?? d.raw;
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

  /**
   * Inicializa el componente cargando las opciones de gráficas y datos
   */
  ngOnInit() {
    this.initChartOptions();
    this.loadData();
  }

  /**
   * Carga los datos de reportes aplicando los filtros actuales
   */
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

  /**
   * Reseta todos los filtros (llamado por GlobalFiltersComponent)
   */
  resetAll() {
    this.loadData();
  }

  /**
   * Construye todas las gráficas con los datos de reportes
   * @param data Datos de reportes
   */
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

    const zones = (data as any).zoneStats ?? [];
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

    const sellers = ((data as any).sellerStats ?? []).slice(0, 7);
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
      rows.filter((r: any) => (r.stats?.score_calidad_pct ?? 0) < 50).length,
      rows.filter((r: any) => {
        const v = r.stats?.score_calidad_pct ?? 0;
        return v >= 50 && v < 70;
      }).length,
      rows.filter((r: any) => {
        const v = r.stats?.score_calidad_pct ?? 0;
        return v >= 70 && v < 85;
      }).length,
      rows.filter((r: any) => (r.stats?.score_calidad_pct ?? 0) >= 85).length,
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
        low: Math.max(0, lowVisits),
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
        },
      ],
    };

    // 1. DOUGHNUT CHART - Distribución porcentual de visitas por rango de score
    // Muestra el % del total de visitas que caen en cada rango de calidad
    const scoreRanges = [
      rows.filter((r: any) => (r.stats?.score_calidad_pct ?? 0) < 50).length,
      rows.filter((r: any) => {
        const v = r.stats?.score_calidad_pct ?? 0;
        return v >= 50 && v < 70;
      }).length,
      rows.filter((r: any) => {
        const v = r.stats?.score_calidad_pct ?? 0;
        return v >= 70 && v < 85;
      }).length,
      rows.filter((r: any) => (r.stats?.score_calidad_pct ?? 0) >= 85).length,
    ];
    this.doughnutChartData = {
      labels: [
        'Bajo (0-49%)',
        'Regular (50-69%)',
        'Bueno (70-84%)',
        'Excelente (85-100%)',
      ],
      datasets: [
        {
          data: scoreRanges,
          backgroundColor: ['#F09595', '#FAC775', '#85B7EB', '#97C459'],
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    };

    // 2. RADAR CHART - Comparación multivariable de KPIs por zona
    // Muestra el desempeño de cada zona en múltiples dimensiones
    const radarZones = data.zoneStats?.slice(0, 5) ?? [];
    const radarLabels = [
      'Score Promedio',
      'Visitas',
      'Cumplimiento GPS',
      'Exhibiciones',
      'Ventas',
    ];

    // Si no hay datos de zonas, generar datos desde las filas agrupadas por zona
    let zoneData = radarZones;
    if (zoneData.length === 0) {
      const zoneMap = new Map<string, any>();
      rows.forEach((r: any) => {
        const zone = r.zona_captura || 'Sin zona';
        if (!zoneMap.has(zone)) {
          zoneMap.set(zone, {
            zone,
            avgScore: 0,
            totalVisitas: 0,
            gpsPct: 0,
            totalExhibiciones: 0,
            totalVentas: 0,
            count: 0,
          });
        }
        const z = zoneMap.get(zone);
        z.avgScore += r.stats?.score_calidad_pct ?? 0;
        z.totalVisitas += 1;
        z.gpsPct += r.stats?.gpsPct ?? 0;
        z.totalExhibiciones += r.exhibiciones?.length ?? 0;
        z.totalVentas += r.stats?.ventaTotal ?? 0;
        z.count += 1;
      });

      zoneData = Array.from(zoneMap.values())
        .map((z: any) => ({
          zone: z.zone,
          avgScore: z.count > 0 ? z.avgScore / z.count : 0,
          totalVisitas: z.totalVisitas,
          gpsPct: z.count > 0 ? z.gpsPct / z.count : 0,
          totalExhibiciones: z.totalExhibiciones,
          totalVentas: z.totalVentas,
        }))
        .slice(0, 5);
    }

    this.radarChartData = {
      labels: radarLabels,
      datasets: zoneData.map((z: any, idx: number) => ({
        label: z.zone,
        data: [
          z.avgScore || 0,
          Math.min(100, (z.totalVisitas ?? 0) / 2), // Normalizado a 100
          z.gpsPct || 0,
          Math.min(100, (z.totalExhibiciones ?? 0) / 2), // Normalizado a 100
          Math.min(100, (z.totalVentas ?? 0) / 1000), // Normalizado a 100 (asumiendo ventas en miles)
        ],
        borderColor: ['#185FA5', '#5B9BD5', '#97C459', '#FAC775', '#F09595'][
          idx
        ],
        backgroundColor: [
          'rgba(24,95,165,0.2)',
          'rgba(91,155,213,0.2)',
          'rgba(151,196,89,0.2)',
          'rgba(250,199,117,0.2)',
          'rgba(240,149,149,0.2)',
        ][idx],
      })),
    };

    // 3. POLAR AREA CHART - Distribución de calidad de visitas
    // Similar a doughnut pero con área proporcional al valor
    this.polarAreaChartData = {
      labels: ['Excelente', 'Bueno', 'Regular', 'Bajo'],
      datasets: [
        {
          data: [
            scoreRanges[3],
            scoreRanges[2],
            scoreRanges[1],
            scoreRanges[0],
          ],
          backgroundColor: [
            'rgba(151, 196, 89, 0.7)', // Verde - Excelente
            'rgba(133, 183, 235, 0.7)', // Azul - Bueno
            'rgba(250, 199, 117, 0.7)', // Amarillo - Regular
            'rgba(240, 149, 149, 0.7)', // Rojo - Bajo
          ],
          borderWidth: 1,
          borderColor: '#fff',
        },
      ],
    };

    // 4. SCATTER CHART - Correlación entre Score y Ventas
    // Cada punto representa una visita, mostrando relación calidad vs impacto económico
    const scatterData = rows.slice(0, 50).map((r: any) => ({
      x: r.stats?.score_calidad_pct ?? 0,
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
        },
      ],
    };

    // 5. LINE CHART - Ejecución Semanal vs Meta (movida desde Home)
    // Muestra la tendencia del score promedio a lo largo del tiempo
    this.lineChartData = {
      labels: trend.map((d: any) => d.date),
      datasets: [
        {
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
        },
      ],
    };

    if (data.productStats) {
      this.buildProductCharts(data);
    }
  }

  buildProductCharts(data: ReportsData) {
    console.log('[ReportsComponent] buildProductCharts() -> productStats received:', data.productStats);

    if (!data.productStats || Object.keys(data.productStats).length === 0) {
      console.warn('[ReportsComponent] No product stats available or is empty object.');
      this.productStatsProcessed = false;
      return;
    }
    this.productStatsProcessed = true;
    const stats = data.productStats;
    
    // Build Health Chart
    this.refreshHealthData(data.exhibidoresHealth);

    const groups = this.dailyCaptureService.groupedProducts();
    // Poblar mapa de productos para búsqueda rápida por marca
    this.pidToBrandMap = {};
    groups.forEach(g => {
      g.items.forEach((i: any) => this.pidToBrandMap[i.pid] = g.marca);
    });
    
    // Extraer marcas directamente de la Base de Datos (del catálogo asíncrono)
    const dbBrands = groups.length > 0 ? groups.map(g => g.marca) : PRODUCTOS_PLANOGRAMA.map(g => g.marca);
    const uniqueBrands = Array.from(new Set(dbBrands));

    // Preparar lista de marcas para el dropdown
    this.availableBrands = [
      { label: 'Todas las marcas', value: null },
      ...uniqueBrands.map(marca => ({ label: marca, value: marca }))
    ];

    this.allProductStatsRaw = Object.keys(stats).map(pid => {
      const pData = stats[pid];
      
      // Intentar obtener nombre y marca del mapa del backend (Fuente de Verdad de la DB)
      let name = pid;
      let marca = 'Otros';
      
      const dbProduct = data.productMap?.[pid];
      if (dbProduct) {
        name = dbProduct.name;
        marca = dbProduct.brandName || 'Otros';
      } else {
        // Fallback a los catálogos locales si no viene en el mapa
        name = this.getProductName(pid);
        const dbGroup = groups.find(g => g.items.some((i: any) => i.pid === pid));
        if (dbGroup) marca = dbGroup.marca;
      }
      
      console.log(`[ReportsComponent] Mapping PID: ${pid} -> Name: ${name}, Marca: ${marca}`);
      return {
        pid,
        name,
        marca,
        total: pData.total,
        exhibidores: pData.exhibidores
      };
    });

    // Ordenar de mayor a menor globalmente
    this.allProductStatsRaw.sort((a, b) => b.total - a.total);
    
    this.applyBrandFilter();
  }

  applyBrandFilter() {
    const filtered = this.selectedBrand 
      ? this.allProductStatsRaw.filter(p => p.marca === this.selectedBrand)
      : this.allProductStatsRaw;

    this.topProducts = filtered.slice(0, 7); 
    this.bottomProducts = [...filtered].reverse().slice(0, 5); 
    
    this.productTopChartData = {
      labels: this.topProducts.map(p => p.name.length > 20 ? p.name.substring(0,20)+'...' : p.name),
      datasets: [
        {
          label: 'Frecuencia en puntos de venta',
          data: this.topProducts.map(p => p.total),
          backgroundColor: '#97C459', 
          borderRadius: 4,
        }
      ]
    };

    const rData = this.reportsData();
    const totalVisitas = rData?.metrics?.count || 1; 
    
    const stockoutData = filtered.map(p => {
       const rate = Math.max(0, 100 - ((p.total / totalVisitas) * 100));
       return {
          ...p,
          stockoutRate: rate.toFixed(1),
          rateNum: rate
       };
    }).sort((a, b) => b.rateNum - a.rateNum);
    
    this.topFaltantes = stockoutData.slice(0, 5); 
    this.updateHealthByBrand();
  }

  pidToBrandMap: Record<string, string> = {};
  currentHealthStats = { optimo: 0, regular: 0, critico: 0 };

  updateHealthByBrand() {
    const data = this.reportsData();
    if (!data?.rows) return;

    if (!this.selectedBrand) {
      // Usar datos globales del backend si no hay marca
      this.refreshHealthData(data.exhibidoresHealth);
      return;
    }

    const health = { optimo: 0, regular: 0, critico: 0 };
    
    data.rows.forEach(row => {
      const exhibiciones = row.exhibiciones || [];
      exhibiciones.forEach((ex: any) => {
        // ¿Este exhibidor tiene productos de la marca seleccionada?
        const hasBrandProduct = ex.productosMarcados?.some((pid: string) => this.pidToBrandMap[pid] === this.selectedBrand);
        
        if (hasBrandProduct) {
          const val = ex.nivelEjecucion;
          const isOptimo = val === 'excelente' || val === 'optimo' || (typeof val === 'number' && val >= 80);
          const isRegular = val === 'medio' || val === 'regular' || (typeof val === 'number' && val >= 50);

          if (isOptimo) health.optimo++;
          else if (isRegular) health.regular++;
          else health.critico++;
        }
      });
    });

    this.refreshHealthData(health);
  }

  refreshHealthData(h: any) {
    this.currentHealthStats = h || { optimo: 0, regular: 0, critico: 0 };
    this.exhibidoresHealthChartData = {
      labels: ['Óptimo', 'Regular', 'Crítico'],
      datasets: [{
        data: [this.currentHealthStats.optimo, this.currentHealthStats.regular, this.currentHealthStats.critico],
        backgroundColor: ['#97C459', '#F59E0B', '#EF4444'],
        hoverBackgroundColor: ['#86b04f', '#d97706', '#dc2626'],
        borderWidth: 0
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
            color: '#52525b',
          },
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
          bodyFont: { size: 12 },
        },
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
            color: '#52525b',
          },
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
          bodyFont: { size: 12 },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 11, weight: '500' },
            color: '#71717a',
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' },
        },
      },
    };

    // Gráfica de zonas - Barras verticales con gradiente
    this.zoneChartOptions = {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: false },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: '500' }, color: '#71717a' },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' },
        },
      },
    };

    // Gráfica horizontal de vendedores - Barras horizontales modernas
    this.horizontalChartOptions = {
      ...base,
      indexAxis: 'y' as const,
      plugins: {
        ...base.plugins,
        legend: { display: false },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' },
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 12, weight: '500' }, color: '#52525b' },
        },
      },
    };

    // Distribución de scores - Barras con colores de semáforo
    this.scoreDistOptions = {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: false },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: '500' }, color: '#52525b' },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: { font: { size: 11 }, color: '#71717a' },
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
            color: '#52525b',
          },
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
            label: function (context: any) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                label += context.parsed.y;
              }
              return label;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            font: { size: 11, weight: '500' },
            color: '#71717a',
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#f4f4f5', drawBorder: false },
          ticks: {
            font: { size: 11 },
            color: '#71717a',
            callback: function (value: number) {
              return value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value;
            },
          },
        },
      },
      interaction: {
        mode: 'index' as const,
        intersect: false,
      },
      animation: {
        duration: 750,
        easing: 'easeOutQuart' as any,
      },
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
            color: '#52525b',
          },
        },
        tooltip: {
          callbacks: {
            label: function (context: any) {
              const label = context.label || '';
              const value = context.parsed;
              const total = context.dataset.data.reduce(
                (a: number, b: number) => a + b,
                0,
              );
              const percentage =
                total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${label}: ${value} visitas (${percentage}%)`;
            },
          },
        },
      },
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
            color: '#52525b',
          },
          ticks: {
            backdropColor: 'transparent',
            color: '#71717a',
            font: { size: 10 },
          },
          suggestedMin: 0,
          suggestedMax: 100,
        },
      },
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
            color: '#52525b',
          },
          ticks: {
            backdropColor: 'transparent',
            color: '#71717a',
          },
        },
      },
    };

    // 4. SCATTER CHART OPTIONS - Correlación entre variables
    this.scatterChartOptions = {
      ...base,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (context: any) {
              return `Score: ${context.parsed.x}%, Ventas: $${context.parsed.y}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear' as const,
          position: 'bottom' as const,
          title: {
            display: true,
            text: 'Score (%)',
            font: { size: 12, weight: '500' },
            color: '#52525b',
          },
          grid: { color: '#f4f4f5' },
          ticks: { color: '#71717a' },
        },
        y: {
          title: {
            display: true,
            text: 'Ventas ($)',
            font: { size: 12, weight: '500' },
            color: '#52525b',
          },
          grid: { color: '#f4f4f5' },
          ticks: { color: '#71717a' },
        },
      },
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
          callbacks: {
            label: (context: any) => ` Score: ${context.parsed.y}%`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#71717a', font: { size: 11, weight: '500' } },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: '#f4f4f5', drawTicks: false },
          ticks: {
            color: '#71717a',
            font: { size: 11 },
            callback: (value: any) => `${value}%`,
          },
        },
      },
    };
  }

  statusLabel(s: KpiStatus): string {
    return s === 'ok' ? 'Óptimo' : s === 'warn' ? 'En rango' : 'Bajo';
  }
  visitScoreStatus(visit: any): KpiStatus {
    return this.metasConfig.statusFor(
      'score',
      visit.stats?.score_calidad_pct ?? 0,
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

  openRouteReportDialog() {
    const user = this.auth.user();
    if (!user) return;

    // Si es colaborador, usar su propio ID
    if (!this.isSupervisor()) {
      this.selectedRouteUsers = [user.sub];
    } else {
      // Si es supervisor, cargar usuarios disponibles
      this.reportsService.getSellers().subscribe({
        next: (users) => {
          this.availableUsers.set(users || []);
          this.selectedRouteUsers = [];
        },
        error: (error) => {
          console.error('Error loading users:', error);
          this.availableUsers.set([]);
          this.selectedRouteUsers = [];
        },
      });
    }

    // Establecer fecha de hoy por defecto
    this.routeReportDate = new Date().toISOString().split('T')[0];
    this.showRouteReportDialog = true;
  }

  exportRouteReportPdf() {
    const user = this.auth.user();
    if (!user) return;

    // Si es colaborador, usar su propio ID
    // Si es supervisor y deja vacío, significa "todos sus usuarios"
    let userIds: string[];
    if (!this.isSupervisor()) {
      userIds = [user.sub];
    } else {
      // Si es supervisor y no seleccionó usuarios, usar array vacío para indicar todos
      userIds =
        this.selectedRouteUsers.length === 0 ? [] : this.selectedRouteUsers;
    }

    // Generar PDF de rutas diarias (array vacío significa todos los usuarios para supervisor)
    this.generateRouteReportPdf(userIds, this.routeReportDate);
    this.showRouteReportDialog = false;
  }

  generateRouteReportPdf(userIds: string[], date: string) {
    try {
      const doc = new jsPDF();
      const margin = 15;
      const pageWidth = doc.internal.pageSize.width;

      // Colores corporativos (paleta amarillo-naranja de la empresa)
      const brandPrimary: [number, number, number] = [253, 231, 7];
      const brandOrange: [number, number, number] = [246, 143, 30];
      const brandSunset: [number, number, number] = [240, 90, 40];
      const brandLight: [number, number, number] = [255, 248, 188];
      const text: [number, number, number] = [30, 30, 30];
      const textMuted: [number, number, number] = [100, 100, 100];
      const white: [number, number, number] = [255, 255, 255];
      const grayLight: [number, number, number] = [245, 245, 245];

      // Header con gradiente amarillo-naranja
      doc.setFillColor(brandOrange[0], brandOrange[1], brandOrange[2]);
      doc.rect(margin, 10, pageWidth - margin * 2, 35, 'F');

      // Logo circular (simulado)
      doc.setFillColor(brandLight[0], brandLight[1], brandLight[2]);
      doc.circle(margin + 15, 27.5, 10, 'F');
      doc.setTextColor(brandSunset[0], brandSunset[1], brandSunset[2]);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('MD', margin + 15, 32, { align: 'center' });

      // Título centrado
      doc.setTextColor(white[0], white[1], white[2]);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('REPORTE DE RUTAS', pageWidth / 2, 25, { align: 'center' });
      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      doc.text(
        `Fecha: ${new Date(date).toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        pageWidth / 2,
        35,
        { align: 'center' },
      );

      // Información del reporte
      let y = 55;
      doc.setTextColor(text[0], text[1], text[2]);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('INFORMACIÓN DEL REPORTE', margin, y);
      y += 8;

      autoTable(doc, {
        startY: y,
        body: [
          ['Fecha del reporte', new Date(date).toLocaleDateString('es-MX')],
          [
            'Usuarios',
            userIds.length === 0
              ? 'Todos los usuarios'
              : userIds.length === 1 && userIds[0] === this.auth.user()?.sub
                ? 'Mi reporte'
                : `${userIds.length} usuarios seleccionados`,
          ],
          ['Generado por', this.auth.user()?.username || 'N/A'],
          ['Rol', this.auth.user()?.role_name || 'N/A'],
        ],
        theme: 'plain',
        bodyStyles: {
          fontSize: 9,
          textColor: text,
          cellPadding: 3,
        },
        columnStyles: {
          0: { cellWidth: 40, fontStyle: 'bold', textColor: textMuted },
          1: { cellWidth: 'auto' },
        },
        margin: { left: margin, right: margin },
      });

      y = (doc as any).lastAutoTable.finalY + 15;

      // Sección de rutas (placeholder por ahora)
      doc.setTextColor(text[0], text[1], text[2]);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('RUTAS DEL DÍA', margin, y);
      y += 8;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.text(
        'Las rutas detalladas se mostrarán aquí con la información de visitas, GPS y tiempos.',
        margin,
        y,
      );

      // Footer
      const totalPages = (doc as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
        doc.text(
          `Mega Dulces · Trade Marketing © ${new Date().getFullYear()}`,
          pageWidth / 2,
          doc.internal.pageSize.height - 10,
          { align: 'center' },
        );
      }

      doc.save(`rutas_${date}.pdf`);
      this.messageService.add({
        severity: 'success',
        summary: 'PDF generado',
        detail: 'El reporte de rutas se ha generado correctamente.',
      });
    } catch (error) {
      console.error('Error generando PDF de rutas:', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail:
          'No se pudo generar el PDF de rutas. Por favor intenta nuevamente.',
      });
    }
  }
  openMap(lat: number, lng: number) {
    if (lat && lng) {
      window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
    }
  }

  openImagePreview(imageUrl: string) {
    this.previewImageUrl = imageUrl;
    this.showImagePreview = true;
  }

  closeImagePreview() {
    this.showImagePreview = false;
    this.previewImageUrl = '';
  }

  getImageUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    const base =
      (this.reportsService as any).apiUrl?.replace('/reports', '') ?? '';
    return `${base}${url}`;
  }

  // Helper methods to get names from IDs
  getProductName(pid: string): string {
    // 1. Priorizar el mapa que viene del reporte actual (backend DB)
    const reportData = this.reportsData();
    if (reportData?.productMap?.[pid]) {
      return reportData.productMap[pid].name;
    }

    // 2. Buscar en los catálogos importados estáticos
    for (const group of PRODUCTOS_PLANOGRAMA) {
      const prod = group.items.find((p) => p.pid === pid);
      if (prod) {
        return prod.name;
      }
    }
    
    // 3. Fallback: tratar de buscar en el signal service
    const allProducts = this.dailyCaptureService.groupedProducts();
    for (const brand of allProducts) {
      const prod = brand.items.find((p) => p.pid === pid);
      if (prod) {
        return prod.name;
      }
    }

    console.warn('[getProductName] Product not found for PID:', pid, '- returning PID as fallback');
    return pid;
  }

  getLocationName(ubicacionId: string): string {
    const ubicaciones = this.dailyCaptureService.ubicaciones();
    const loc = ubicaciones.find((u) => u.id === ubicacionId);
    return loc ? loc.nombre : ubicacionId;
  }

  getConceptoName(conceptoId: string): string {
    const conceptos = this.dailyCaptureService.conceptos();
    const concept = conceptos.find((c) => c.id === conceptoId);
    return concept ? concept.nombre : conceptoId;
  }

  getProductNames(pids: string[]): string[] {
    if (!pids || pids.length === 0) return [];
    return pids.map((pid) => this.getProductName(pid));
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
      v.stats?.score_calidad_pct,
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
    try {
      const data = this.reportsData();
      if (!data) {
        this.messageService.add({
          severity: 'warn',
          summary: 'Sin datos',
          detail: 'No hay datos disponibles para generar el PDF.',
        });
        return;
      }
      const doc = new jsPDF();
      const f = this.filtersState.filters();
      const pageWidth = doc.internal.pageSize.width;
      const margin = 14;

      // Colores corporativos (simplified to reduce excessive color)
      const primary: [number, number, number] = [100, 100, 100];
      const text: [number, number, number] = [9, 9, 11];
      const textMuted: [number, number, number] = [82, 82, 91];
      const bgLight: [number, number, number] = [244, 244, 245];
      const success: [number, number, number] = [34, 197, 94];
      const warning: [number, number, number] = [251, 191, 36];
      const danger: [number, number, number] = [239, 68, 68];

      // Header simplificado
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text('MEGA DULCES', margin, 20);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.text('Trade Marketing Report', margin, 28);

      // Título del reporte
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text('Reporte Ejecutivo', pageWidth - margin, 20, { align: 'right' });

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.text('Análisis de desempeño comercial', pageWidth - margin, 28, {
        align: 'right',
      });

      // Período
      let y = 50;
      doc.setFillColor(bgLight[0], bgLight[1], bgLight[2]);
      doc.roundedRect(margin, y, pageWidth - margin * 2, 20, 4, 4, 'F');
      doc.setFontSize(9);
      doc.setTextColor(text[0], text[1], text[2]);
      doc.setFont('helvetica', 'bold');
      doc.text('PERÍODO DE ANÁLISIS', margin + 6, y + 7);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(primary[0], primary[1], primary[2]);
      doc.text(this.filtersState.rangeLabel(), margin + 6, y + 16);
      doc.setFont('helvetica', 'normal');

      y += 35;

      // KPIs
      if (this.pdfSections.find((s) => s.id === 'metrics')?.checked) {
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(text[0], text[1], text[2]);
        doc.text('MÉTRICAS PRINCIPALES', margin, y);
        y += 10;

        autoTable(doc, {
          startY: y,
          head: [['KPI', 'Valor', 'Meta', 'Estado']],
          body: this.kpiCards().map((k) => [
            k.label,
            k.value,
            k.meta,
            this.statusLabel(k.status),
          ]),
          theme: 'grid',
          headStyles: {
            fillColor: bgLight,
            textColor: text,
            fontSize: 9,
            fontStyle: 'bold',
          },
          bodyStyles: {
            fontSize: 9,
            textColor: text,
          },
          alternateRowStyles: {
            fillColor: [250, 250, 250],
          },
          margin: { left: margin, right: margin },
        });

        y = (doc as any).lastAutoTable.finalY + 15;
      }

      // Mobiliario
      if (this.pdfSections.find((s) => s.id === 'furniture')?.checked) {
        if (y > 220) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(text[0], text[1], text[2]);
        doc.text('CUMPLIMIENTO POR MOBILIARIO', margin, y);
        y += 10;

        const furnitureData = this.metasConfig.furniture().map((f) => {
          const current = data.furniture?.[f.id] ?? 0;
          const pct = Math.min(100, (current / f.target) * 100);
          let status: KpiStatus = 'ok';
          if (pct < 50) status = 'bad';
          else if (pct < 80) status = 'warn';
          return [
            f.label,
            `${current}/${f.target}`,
            `${pct.toFixed(0)}%`,
            this.statusLabel(status),
          ];
        });

        autoTable(doc, {
          startY: y,
          head: [['Activo', 'Progreso', 'Porcentaje', 'Estado']],
          body: furnitureData,
          theme: 'grid',
          headStyles: {
            fillColor: bgLight,
            textColor: text,
            fontSize: 9,
            fontStyle: 'bold',
          },
          bodyStyles: {
            fontSize: 9,
            textColor: text,
          },
          alternateRowStyles: {
            fillColor: [250, 250, 250],
          },
          margin: { left: margin, right: margin },
        });

        y = (doc as any).lastAutoTable.finalY + 15;
      }

      // Ranking
      if (
        this.pdfSections.find((s) => s.id === 'ranking')?.checked &&
        data.sellerStats
      ) {
        if (y > 180) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(text[0], text[1], text[2]);
        doc.text('RANKING DE EJECUTIVOS', margin, y);
        y += 10;

        autoTable(doc, {
          startY: y,
          head: [['#', 'Ejecutivo', 'Visitas', 'Score Prom.', 'Calificación']],
          body: data.sellerStats.map((s: any, index: number) => {
            let stars = '★★★';
            if (s.avgScore >= 90) stars = '★★★★★';
            else if (s.avgScore >= 80) stars = '★★★★';
            else if (s.avgScore >= 70) stars = '★★★';
            else if (s.avgScore >= 60) stars = '★★';
            else stars = '★';
            return [
              (index + 1).toString(),
              s.username,
              s.totalVisitas.toString(),
              `${s.avgScore}%`,
              stars,
            ];
          }),
          theme: 'grid',
          headStyles: {
            fillColor: bgLight,
            textColor: text,
            fontSize: 9,
            fontStyle: 'bold',
            halign: 'center',
          },
          bodyStyles: {
            fontSize: 9,
            textColor: text,
          },
          columnStyles: {
            0: { halign: 'center', cellWidth: 15 },
            2: { halign: 'center', cellWidth: 20 },
            3: { halign: 'center', cellWidth: 25 },
            4: { halign: 'center', cellWidth: 30 },
          },
          alternateRowStyles: {
            fillColor: [250, 250, 250],
          },
          margin: { left: margin, right: margin },
        });

        y = (doc as any).lastAutoTable.finalY + 15;
      }

      // Gráficas como tablas
      if (this.pdfSections.find((s) => s.id === 'charts')?.checked) {
        if (y > 200) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(text[0], text[1], text[2]);
        doc.text('ANÁLISIS VISUAL', margin, y);
        y += 10;

        // Tendencia de ejecución semanal (line chart data)
        if (this.lineChartData && this.lineChartData.labels?.length > 0) {
          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
          doc.text('Tendencia de Ejecución Semanal', margin, y);
          y += 8;

          const trendData = this.lineChartData.labels.map(
            (label: string, index: number) => ({
              fecha: label,
              score:
                typeof this.lineChartData.datasets[0].data[index] === 'number'
                  ? this.lineChartData.datasets[0].data[index].toFixed(1)
                  : '0',
            }),
          );

          autoTable(doc, {
            startY: y,
            head: [['Fecha', 'Score']],
            body: trendData.map((d: any) => [d.fecha, d.score + '%']),
            theme: 'grid',
            headStyles: {
              fillColor: bgLight,
              textColor: text,
              fontSize: 8,
              fontStyle: 'bold',
            },
            bodyStyles: {
              fontSize: 8,
              textColor: text,
            },
            alternateRowStyles: {
              fillColor: [250, 250, 250],
            },
            margin: { left: margin, right: margin },
          });

          y = (doc as any).lastAutoTable.finalY + 12;
        }

        // Distribución de scores (doughnut chart data)
        if (
          this.doughnutChartData &&
          this.doughnutChartData.labels?.length > 0
        ) {
          if (y > 220) {
            doc.addPage();
            y = 20;
          }

          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
          doc.text('Distribución de Calidad de Visitas', margin, y);
          y += 8;

          const distData = this.doughnutChartData.labels.map(
            (label: string, index: number) => ({
              rango: label,
              cantidad: this.doughnutChartData.datasets[0].data[index],
            }),
          );

          autoTable(doc, {
            startY: y,
            head: [['Rango', 'Cantidad']],
            body: distData.map((d: any) => [d.rango, d.cantidad]),
            theme: 'grid',
            headStyles: {
              fillColor: bgLight,
              textColor: text,
              fontSize: 8,
              fontStyle: 'bold',
            },
            bodyStyles: {
              fontSize: 8,
              textColor: text,
            },
            alternateRowStyles: {
              fillColor: [250, 250, 250],
            },
            margin: { left: margin, right: margin },
          });

          y = (doc as any).lastAutoTable.finalY + 12;
        }

        // Performance por zona (radar chart data)
        if (this.radarChartData && this.radarChartData.datasets?.length > 0) {
          if (y > 220) {
            doc.addPage();
            y = 20;
          }

          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
          doc.text('Performance por Zona', margin, y);
          y += 8;

          const zoneData = this.radarChartData.datasets.map((ds: any) => ({
            zona: ds.label,
            score: ds.data[0]?.toFixed(1) || '0',
            visitas: ds.data[1]?.toFixed(0) || '0',
          }));

          autoTable(doc, {
            startY: y,
            head: [['Zona', 'Score', 'Visitas']],
            body: zoneData.map((d: any) => [d.zona, d.score + '%', d.visitas]),
            theme: 'grid',
            headStyles: {
              fillColor: bgLight,
              textColor: text,
              fontSize: 8,
              fontStyle: 'bold',
            },
            bodyStyles: {
              fontSize: 8,
              textColor: text,
            },
            alternateRowStyles: {
              fillColor: [250, 250, 250],
            },
            margin: { left: margin, right: margin },
          });

          y = (doc as any).lastAutoTable.finalY + 12;
        }
      }

      // Detalle
      if (
        this.pdfSections.find((s) => s.id === 'table')?.checked &&
        data.rows?.length
      ) {
        doc.addPage();
        let yDetail = 20;

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(text[0], text[1], text[2]);
        doc.text('REGISTROS DETALLADOS', margin, yDetail);
        yDetail += 10;

        autoTable(doc, {
          startY: yDetail,
          head: [
            ['Folio', 'Fecha', 'Ejecutivo', 'Zona', 'Score', 'Estado', 'Venta'],
          ],
          body: data.rows.map((r: any) => {
            const status = this.metasConfig.statusFor(
              'score',
              r.stats?.puntuacionTotal ?? 0,
            );
            let statusText = 'OK';
            if (status === 'warn') statusText = 'REGULAR';
            if (status === 'bad') statusText = 'BAJO';
            return [
              r.folio?.substring(0, 8) || 'N/A',
              new Date(r.fecha).toLocaleDateString('es-ES', {
                day: '2-digit',
                month: 'short',
              }),
              r.captured_by_username?.substring(0, 20) || 'N/A',
              r.zona_captura?.substring(0, 15) || 'N/A',
              `${r.stats?.puntuacionTotal ?? 0}%`,
              statusText,
              `$${(r.stats?.ventaTotal ?? 0).toLocaleString()}`,
            ];
          }),
          theme: 'grid',
          headStyles: {
            fillColor: bgLight,
            textColor: text,
            fontSize: 8,
            fontStyle: 'bold',
          },
          bodyStyles: {
            fontSize: 8,
            textColor: text,
          },
          columnStyles: {
            0: { cellWidth: 22 },
            1: { cellWidth: 20, halign: 'center' },
            4: { cellWidth: 18, halign: 'center' },
            5: { cellWidth: 20, halign: 'center' },
            6: { cellWidth: 25, halign: 'right' },
          },
          alternateRowStyles: {
            fillColor: [250, 250, 250],
          },
          margin: { left: margin, right: margin },
        });
      }

      // Footer
      const totalPages = (doc as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
        doc.text(
          `Mega Dulces · Trade Marketing © ${new Date().getFullYear()}`,
          pageWidth / 2,
          doc.internal.pageSize.height - 10,
          { align: 'center' },
        );
      }

      doc.save(`reporte_${f.startDate}_${f.endDate}.pdf`);
      this.showPdfBuilder = false;
      this.messageService.add({
        severity: 'success',
        summary: 'PDF generado',
        detail: 'El reporte se ha generado correctamente.',
      });
    } catch (error) {
      console.error('Error generando PDF:', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'No se pudo generar el PDF. Por favor intenta nuevamente.',
      });
    }
  }

  exportBrandPdf() {
    try {
      const data = this.reportsData();
      if (!data || !this.selectedBrand) {
        this.messageService.add({
          severity: 'warn',
          summary: 'Sin datos',
          detail: 'No hay datos disponibles o no se ha seleccionado una marca.',
        });
        return;
      }

      const doc = new jsPDF();
      const f = this.filtersState.filters();
      const pageWidth = doc.internal.pageSize.width;
      const margin = 14;

      // Colores corporativos
      const primary: [number, number, number] = [100, 100, 100];
      const text: [number, number, number] = [9, 9, 11];
      const textMuted: [number, number, number] = [82, 82, 91];
      const bgLight: [number, number, number] = [244, 244, 245];
      const success: [number, number, number] = [34, 197, 94];
      const warning: [number, number, number] = [251, 191, 36];
      const danger: [number, number, number] = [239, 68, 68];

      // Header
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text('MEGA DULCES', margin, 20);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.text('Trade Marketing Report', margin, 28);

      // Título del reporte
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text(`Reporte: ${this.selectedBrand}`, pageWidth - margin, 20, { align: 'right' });

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.text('Análisis por marca', pageWidth - margin, 28, { align: 'right' });

      // Período
      let y = 50;
      doc.setFillColor(bgLight[0], bgLight[1], bgLight[2]);
      doc.roundedRect(margin, y, pageWidth - margin * 2, 20, 4, 4, 'F');
      doc.setFontSize(9);
      doc.setTextColor(text[0], text[1], text[2]);
      doc.setFont('helvetica', 'bold');
      doc.text('PERÍODO DE ANÁLISIS', margin + 6, y + 7);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(primary[0], primary[1], primary[2]);
      doc.text(this.filtersState.rangeLabel(), margin + 6, y + 16);
      doc.setFont('helvetica', 'normal');

      y += 35;

      // KPIs de la marca
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text('MÉTRICAS DE LA MARCA', margin, y);
      y += 10;

      const brandProducts = this.allProductStatsRaw.filter(p => p.marca === this.selectedBrand);
      const totalBrandPresence = brandProducts.reduce((sum, p) => sum + p.total, 0);
      const totalVisits = data.metrics?.totalVisitas || 1;
      const shareOfShelf = ((totalBrandPresence / (totalVisits * brandProducts.length)) * 100).toFixed(1);

      autoTable(doc, {
        startY: y,
        head: [['Métrica', 'Valor']],
        body: [
          ['Marca', this.selectedBrand],
          ['Productos Únicos', brandProducts.length.toString()],
          ['Presencia Total', totalBrandPresence.toString()],
          ['Share of Shelf', `${shareOfShelf}%`],
          ['Avg por Producto', (totalBrandPresence / brandProducts.length).toFixed(1)],
        ],
        theme: 'grid',
        headStyles: {
          fillColor: bgLight,
          textColor: text,
          fontSize: 9,
          fontStyle: 'bold',
        },
        bodyStyles: {
          fontSize: 9,
          textColor: text,
        },
        alternateRowStyles: {
          fillColor: [250, 250, 250],
        },
        margin: { left: margin, right: margin },
      });

      y = (doc as any).lastAutoTable.finalY + 15;

      // Productos Top de la marca
      if (y > 200) {
        doc.addPage();
        y = 20;
      }

      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text('PRODUCTOS TOP', margin, y);
      y += 10;

      const topProductsWithStockout = this.topProducts
        .filter(p => p.marca === this.selectedBrand)
        .slice(0, 10)
        .map(p => ({
          ...p,
          stockoutRate: Math.max(0, 100 - ((p.total / totalVisits) * 100)).toFixed(1)
        }));

      autoTable(doc, {
        startY: y,
        head: [['Producto', 'Frecuencia', 'Stockout Rate']],
        body: topProductsWithStockout.map(p => [
          p.name,
          p.total.toString(),
          p.stockoutRate + '%',
        ]),
        theme: 'grid',
        headStyles: {
          fillColor: bgLight,
          textColor: text,
          fontSize: 9,
          fontStyle: 'bold',
        },
        bodyStyles: {
          fontSize: 8,
          textColor: text,
        },
        alternateRowStyles: {
          fillColor: [250, 250, 250],
        },
        margin: { left: margin, right: margin },
      });

      y = (doc as any).lastAutoTable.finalY + 15;

      // Productos con problemas
      if (y > 200) {
        doc.addPage();
        y = 20;
      }

      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(text[0], text[1], text[2]);
      doc.text('ÁREAS DE OPORTUNIDAD', margin, y);
      y += 10;

      const bottomProductsWithStockout = this.bottomProducts
        .filter(p => p.marca === this.selectedBrand)
        .slice(0, 10)
        .map(p => ({
          ...p,
          stockoutRate: Math.max(0, 100 - ((p.total / totalVisits) * 100)).toFixed(1)
        }));

      autoTable(doc, {
        startY: y,
        head: [['Producto', 'Frecuencia', 'Stockout Rate']],
        body: bottomProductsWithStockout.map(p => [
          p.name,
          p.total.toString(),
          p.stockoutRate + '%',
        ]),
        theme: 'grid',
        headStyles: {
          fillColor: bgLight,
          textColor: text,
          fontSize: 9,
          fontStyle: 'bold',
        },
        bodyStyles: {
          fontSize: 8,
          textColor: text,
        },
        alternateRowStyles: {
          fillColor: [250, 250, 250],
        },
        margin: { left: margin, right: margin },
      });

      // Footer
      const totalPages = (doc as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
        doc.text(
          `Mega Dulces · Trade Marketing © ${new Date().getFullYear()}`,
          pageWidth / 2,
          doc.internal.pageSize.height - 10,
          { align: 'center' },
        );
      }

      doc.save(`reporte_marca_${this.selectedBrand}_${f.startDate}_${f.endDate}.pdf`);
      this.messageService.add({
        severity: 'success',
        summary: 'PDF generado',
        detail: `Reporte de marca "${this.selectedBrand}" generado correctamente.`,
      });
    } catch (error) {
      console.error('Error generando PDF de marca:', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'No se pudo generar el PDF. Por favor intenta nuevamente.',
      });
    }
  }

  exportSingleVisitPdf(row: any) {
    try {
      console.log('Generando PDF para visita:', row.folio);
      console.log('Datos de visita:', row);

      const doc = new jsPDF();
      const margin = 15;
      const pageWidth = doc.internal.pageSize.width;

      // Colores corporativos (paleta amarillo-naranja de la empresa)
      const brandPrimary: [number, number, number] = [253, 231, 7]; // Amarillo
      const brandOrange: [number, number, number] = [246, 143, 30]; // Naranja
      const brandSunset: [number, number, number] = [240, 90, 40]; // Naranja oscuro
      const brandLight: [number, number, number] = [255, 248, 188]; // Amarillo claro
      const text: [number, number, number] = [30, 30, 30];
      const textMuted: [number, number, number] = [100, 100, 100];
      const white: [number, number, number] = [255, 255, 255];
      const grayLight: [number, number, number] = [245, 245, 245];

      // Header con gradiente amarillo-naranja
      doc.setFillColor(brandOrange[0], brandOrange[1], brandOrange[2]);
      doc.rect(margin, 10, pageWidth - margin * 2, 35, 'F');

      // Logo circular (simulado)
      doc.setFillColor(brandLight[0], brandLight[1], brandLight[2]);
      doc.circle(margin + 15, 27.5, 10, 'F');
      doc.setTextColor(brandSunset[0], brandSunset[1], brandSunset[2]);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('MD', margin + 15, 32, { align: 'center' });

      // Título centrado
      doc.setTextColor(white[0], white[1], white[2]);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('REPORTE DE VISITA', pageWidth / 2, 25, { align: 'center' });
      doc.setFontSize(12);
      doc.text(`#${row.folio}`, pageWidth / 2, 35, { align: 'center' });

      // Bloque de datos emisor/receptor
      let y = 55;

      // Línea divisoria vertical
      doc.setDrawColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.setLineWidth(0.1);
      doc.line(pageWidth / 2, y - 5, pageWidth / 2, y + 35);

      // Columna izquierda - Datos del ejecutivo
      doc.setTextColor(text[0], text[1], text[2]);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('DATOS DEL EJECUTIVO', margin, y);
      y += 7;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(`Nombre: ${row.captured_by_username || 'N/A'}`, margin, y);
      y += 5;
      doc.text(`Zona: ${row.zona_captura || 'N/A'}`, margin, y);
      y += 5;
      doc.text(
        `Fecha: ${row.fecha ? new Date(row.fecha).toLocaleDateString('es-MX') : 'N/A'}`,
        margin,
        y,
      );
      y += 5;
      doc.text(
        `Hora inicio: ${row.hora_inicio ? new Date(row.hora_inicio).toLocaleTimeString('es-MX') : 'N/A'}`,
        margin,
        y,
      );
      y += 5;
      doc.text(
        `Hora fin: ${row.hora_fin ? new Date(row.hora_fin).toLocaleTimeString('es-MX') : 'N/A'}`,
        margin,
        y,
      );

      // Columna derecha - Datos de la visita
      y = 55;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('DATOS DE LA VISITA', pageWidth / 2 + 5, y);
      y += 7;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(
        `Exhibiciones: ${row.exhibiciones?.length ?? 0}`,
        pageWidth / 2 + 5,
        y,
      );
      y += 5;
      doc.text(
        `Venta total: $${((row.stats?.ventaTotal ?? 0) || 0).toLocaleString('es-MX')}`,
        pageWidth / 2 + 5,
        y,
      );
      y += 5;
      doc.text(
        `GPS: ${row.latitud && typeof row.latitud === 'number' ? `${row.latitud.toFixed(6)}, ${row.longitud.toFixed(6)}` : 'No capturado'}`,
        pageWidth / 2 + 5,
        y,
      );
      y += 5;

      // Score badge
      const score = row.stats?.score_calidad_pct ?? 0;
      const status = this.statusLabel(
        this.metasConfig.statusFor('score', score),
      );
      doc.text(`Score: ${score}% (${status})`, pageWidth / 2 + 5, y);

      y += 15;

      // Tabla de exhibiciones
      if (row.exhibiciones && row.exhibiciones.length > 0) {
        const exhibicionesData = row.exhibiciones.map((ex: any) => {
          try {
            const productos =
              ex.productosMarcados && ex.productosMarcados.length > 0
                ? this.getProductNames(ex.productosMarcados).join(', ')
                : 'Sin productos';

            return [
              this.getConceptoName(ex.conceptoId),
              ex.nivelEjecucion || 'N/A',
              ex.rangoCompra || ex.rango_compra || ex.rango || '-',
              productos,
              '$' + (ex.ventaAdicional || 0 || 0).toLocaleString('es-MX'),
              (ex.puntuacionCalculada || 0).toString(),
            ];
          } catch (e) {
            console.error('Error procesando exhibición:', e);
            return ['N/A', 'N/A', 'N/A', 'Error', '$0', '0'];
          }
        });

        autoTable(doc, {
          startY: y,
          head: [['FORMATO', 'NIVEL', 'RANGO', 'PRODUCTOS', 'VENTA', 'PUNTOS']],
          body: exhibicionesData,
          theme: 'grid',
          headStyles: {
            fillColor: brandOrange,
            textColor: white,
            fontSize: 9,
            fontStyle: 'bold',
            halign: 'center',
          },
          bodyStyles: {
            fontSize: 8,
            textColor: text,
            cellPadding: 4,
            valign: 'top',
          },
          columnStyles: {
            0: { cellWidth: 25 },
            1: { cellWidth: 20, halign: 'center' },
            2: { cellWidth: 20, halign: 'center' },
            3: { cellWidth: 'auto' },
            4: { cellWidth: 25, halign: 'right' },
            5: { cellWidth: 15, halign: 'right' },
          },
          alternateRowStyles: {
            fillColor: grayLight,
          },
          margin: { left: margin, right: margin },
        });

        y = (doc as any).lastAutoTable.finalY + 15;
      }

      // Bloque de totales
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('RESUMEN', pageWidth - margin, y, { align: 'right' });
      y += 8;

      autoTable(doc, {
        startY: y,
        body: [
          ['Score Total', `${row.stats?.score_calidad_pct ?? 0}%`],
          [
            'Venta Total',
            `$${((row.stats?.ventaTotal ?? 0) || 0).toLocaleString('es-MX')}`,
          ],
          ['Exhibiciones', (row.exhibiciones?.length ?? 0).toString()],
          [
            'Estado',
            this.statusLabel(
              this.metasConfig.statusFor(
                'score',
                row.stats?.score_calidad_pct ?? 0,
              ),
            ),
          ],
        ],
        theme: 'plain',
        bodyStyles: {
          fontSize: 9,
          textColor: text,
          cellPadding: 3,
        },
        columnStyles: {
          0: { cellWidth: 80, fontStyle: 'normal', textColor: textMuted },
          1: {
            cellWidth: 40,
            fontStyle: 'bold',
            halign: 'right',
            textColor: brandSunset,
          },
        },
        margin: { left: pageWidth - 125, right: margin },
      });

      y = (doc as any).lastAutoTable.finalY + 30;

      // Pie de documento con firmas
      doc.setDrawColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.setLineWidth(0.3);

      // Firma ejecutivo
      doc.line(margin, y, margin + 60, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
      doc.text('Firma del Ejecutivo', margin, y + 5);

      // Firma cliente
      doc.line(pageWidth - margin - 60, y, pageWidth - margin, y);
      doc.text('Firma del Cliente', pageWidth - margin - 60, y + 5);

      // Footer
      const totalPages = (doc as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(textMuted[0], textMuted[1], textMuted[2]);
        doc.text(
          `Mega Dulces · Trade Marketing © ${new Date().getFullYear()}`,
          pageWidth / 2,
          doc.internal.pageSize.height - 10,
          { align: 'center' },
        );
      }

      doc.save(`visita_${row.folio}.pdf`);
      this.messageService.add({
        severity: 'success',
        summary: 'PDF generado',
        detail: 'El reporte de visita se ha generado correctamente.',
      });
    } catch (error) {
      console.error('Error generando PDF de visita:', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail:
          'No se pudo generar el PDF de la visita. Por favor intenta nuevamente.',
      });
    }
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
    this.editableFurniture = this.metasConfig
      .furniture()
      .map((f) => ({ ...f }));
    this.editableKpi = this.metasConfig.kpiRanges().map((k) => ({ ...k }));
    this.showMetasDialog = true;
  }

  saveMetas() {
    // Al guardar, actualizamos el servicio local que maneja el localStorage
    this.editableFurniture.forEach((f) =>
      this.metasConfig.updateFurnitureTarget(f.id, f.target),
    );
    this.showMetasDialog = false;
    // Forzamos un refresco de los datos para aplicar los nuevos rangos
    this.reportsData.set({ ...this.reportsData()! });
    this.messageService.add({
      severity: 'success',
      summary: 'Metas actualizadas',
      detail: 'Las metas se han guardado correctamente',
    });
  }

  cancelMetas() {
    this.showMetasDialog = false;
  }
}
