import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { HomeChartsComponent } from './home-charts.component';
import { getChartTokens, colorForScore } from '../../../shared/theme/chart-theme';
import { forkJoin } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

// Visualizaciones SVG para KPI cards. 3 estilos: bars (sparkbars), area
// (sparkline rellena), gauge (donut).
interface SparkBar {
  x: number; y: number; w: number; h: number;
  color: string; tooltip: string; isToday: boolean;
}
interface SparkBarsConfig {
  style: 'bars';
  bars: SparkBar[];
  metaY: number; viewBox: string; ariaLabel: string;
}
interface SparkAreaPoint {
  x: number; y: number; tooltip: string; isToday: boolean;
}
interface SparkAreaConfig {
  style: 'area';
  linePath: string; areaPath: string;
  points: SparkAreaPoint[];
  metaY: number; viewBox: string; ariaLabel: string;
  color: string; gradientId: string;
}
type SparkConfig = SparkBarsConfig | SparkAreaConfig;

interface GaugeConfig {
  pct: number; color: string;
  centerValue: string; centerUnit: string; ariaLabel: string;
  circumference: number; dashoffset: number;
  size: 'hero' | 'normal';
}

// Servicios
import { ReportsService } from '../reports/reports.service';
import { ThemeService } from '../../../core/services/theme.service';
import { FiltersStateService } from '../reports/graphics/filters-state.service';
import {
  KpiStatus,
  MetasConfigService,
} from '../reports/graphics/metas-config.service';
import { parseLocalDate } from '../../../core/utils/mx-date';
import { WebSocketService } from '../../../core/services/websocket.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    DialogModule,
    InputNumberModule,
    SkeletonModule,
    TooltipModule,
    ToastModule,
    HomeChartsComponent,
  ],
  providers: [MessageService],
  templateUrl: './home.component.html',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnInit {
  private reportsService = inject(ReportsService);
  public themeService = inject(ThemeService);
  readonly filtersState = inject(FiltersStateService);
  readonly metasConfig = inject(MetasConfigService);
  private messageService = inject(MessageService);
  private ws = inject(WebSocketService);
  private destroyRef = inject(DestroyRef);
  private perms = inject(PermissionsService);

  summaryMonthlyLoading = signal(true);
  summaryDailyLoading = signal(true);
  reportsDataLoading = signal(true);

  // Timestamp de la última sincronización exitosa. Reemplaza el placeholder
  // "Sync v2.5" / "Live Metrics" por información real.
  lastUpdatedAt = signal<Date | null>(null);

  summaryMonthly = signal<any>(null);
  summaryDaily = signal<any>(null);
  reportsData = signal<any>(null);

  // Chart como signals para reaccionar con OnPush.
  stackedChartData = signal<any>(null);
  stackedChartOptions = signal<any>(null);

  // Modal de metas
  showMetasDialog = signal<boolean>(false);
  editableFurniture: { id: string; label: string; icon: string; target: number }[] = [];
  editableKpi: any[] = [];

  // Quick actions con permiso requerido
  private rawQuickActions: { label: string; icon: string; route: string; permission: Permission }[] = [
    { label: 'Nueva Captura', icon: 'pi pi-pencil', route: '/dashboard/captures', permission: Permission.VISITAS_REGISTRAR },
    { label: 'Ver Reportes', icon: 'pi pi-chart-bar', route: '/dashboard/reports', permission: Permission.REPORTES_VER_PROPIO },
    { label: 'Gestionar Tiendas', icon: 'pi pi-building', route: '/dashboard/stores', permission: Permission.TIENDAS_VER },
  ];

  private permToSubject: Record<string, string> = {
    [Permission.VISITAS_REGISTRAR]: 'visits',
    [Permission.REPORTES_VER_PROPIO]: 'reports_own',
    [Permission.TIENDAS_VER]: 'stores',
  };

  readonly quickActions = computed(() =>
    this.rawQuickActions.filter((a) =>
      this.perms.can('read', this.permToSubject[a.permission] as any),
    ),
  );

  // Loading global (si cualquier sección sigue cargando)
  readonly anyLoading = computed(
    () =>
      this.summaryMonthlyLoading() ||
      this.summaryDailyLoading() ||
      this.reportsDataLoading(),
  );

  // 1. Tarjetas KPI - usando datos MENSUALES.
  // 4 cards · 2 estilos: gauge para "achievement vs meta", spark para flujo
  // diario. Score/Tiempo = gauge. Evidencia/Meta-diaria = spark.
  kpiCards = computed(() => {
    const metrics = this.summaryMonthly() || {};
    const cierresHoy = metrics.cierres_hoy || 0;
    const trend: Array<{ date: string; visits: number; avgScore: number }> =
      this.reportsData()?.trendData ?? [];

    const metaDiariaRange = this.metasConfig.getRange('metaDiaria');
    const metaDiaria = metaDiariaRange?.opt || 5;
    const pending = Math.max(0, metaDiaria - cierresHoy);

    const scoreVal = parseFloat(metrics.puntuacion_promedio) || 0;
    const scoreStatus = this.metasConfig.statusFor('score', scoreVal);
    const scoreRange = this.metasConfig.getRange('score');

    const avgDurationVal = parseFloat(metrics.avg_duration_min) || 0;
    const avgDurationStatus = this.metasConfig.statusFor('avgDuration', avgDurationVal);
    const avgDurationRange = this.metasConfig.getRange('avgDuration');

    const evidenciaVal = metrics.total_fotos || 0;
    const evidenciaStatus = this.metasConfig.statusFor('evidenciaVisual', evidenciaVal);
    const evidenciaRange = this.metasConfig.getRange('evidenciaVisual');

    const visitsTotal = metrics.visitas_totales || 0;
    const fotosPerVisit = visitsTotal ? evidenciaVal / visitsTotal : 0;
    const evidenciaSeries = trend.map((t) => ({ date: t.date, value: fotosPerVisit * t.visits }));
    const visitsSeries = trend.map((t) => ({ date: t.date, value: t.visits }));

    return [
      {
        label: 'Score Global',
        value: `${Math.round(scoreVal || 0)} pts`,
        rawValue: scoreVal,
        icon: 'pi pi-chart-line',
        status: scoreStatus,
        meta: scoreRange ? `${scoreRange.opt} pts` : '—',
        pct: this.metasConfig.progressPct('score', scoreVal),
        delta: '',
        deltaDir: 'flat' as 'up' | 'down' | 'flat',
        kind: 'gauge' as 'gauge' | 'spark',
        size: 'hero' as 'hero' | 'normal',
        gauge: this.buildGauge(scoreVal, scoreStatus, `${Math.round(scoreVal)} pts`, scoreRange?.opt ?? 0, 'pts', 'hero'),
        spark: undefined as SparkConfig | undefined,
      },
      {
        label: 'Tiempo Prom/Visita',
        value: `${metrics.avg_duration_min || 0}m`,
        rawValue: avgDurationVal,
        icon: 'pi pi-clock',
        status: avgDurationStatus,
        meta: avgDurationRange ? `≥ ${avgDurationRange.opt} min` : '—',
        pct: this.metasConfig.progressPct('avgDuration', avgDurationVal),
        delta: '',
        deltaDir: 'flat' as 'up' | 'down' | 'flat',
        kind: 'gauge' as 'gauge' | 'spark',
        size: 'normal' as 'hero' | 'normal',
        gauge: this.buildGauge(avgDurationVal, avgDurationStatus, `${avgDurationVal} m`, avgDurationRange?.opt ?? 0, 'min', 'normal'),
        spark: undefined as SparkConfig | undefined,
      },
      {
        label: 'Evidencia Visual',
        value: evidenciaVal.toString(),
        rawValue: evidenciaVal,
        icon: 'pi pi-camera',
        status: evidenciaStatus,
        meta: evidenciaRange ? `≥ ${evidenciaRange.opt} fotos` : '—',
        pct: this.metasConfig.progressPct('evidenciaVisual', evidenciaVal),
        delta: '',
        deltaDir: 'flat' as 'up' | 'down' | 'flat',
        kind: 'spark' as 'gauge' | 'spark',
        size: 'normal' as 'hero' | 'normal',
        gauge: undefined as GaugeConfig | undefined,
        spark: this.buildSparkArea(evidenciaSeries, 'evidenciaVisual', (v) => `${Math.round(v)} fotos`),
      },
      {
        label: 'Meta Diaria',
        value: `${cierresHoy}/${metaDiaria}`,
        rawValue: cierresHoy,
        icon: 'pi pi-bullseye',
        status: (pending > 0 ? 'warn' : 'ok') as KpiStatus,
        meta: `${metaDiaria} visitas`,
        delta: pending > 0 ? `${pending} restantes` : 'Completado',
        deltaDir: (pending > 0 ? 'down' : 'up') as 'up' | 'down' | 'flat',
        pct: metaDiaria > 0 ? Math.round((cierresHoy / metaDiaria) * 100) : 0,
        kind: 'spark' as 'gauge' | 'spark',
        size: 'normal' as 'hero' | 'normal',
        gauge: undefined as GaugeConfig | undefined,
        spark: this.buildSparkBars(visitsSeries, 'metaDiaria', (v) => `${Math.round(v)} visitas`),
      },
    ];
  });

  /** Padded series: rellena ceros hacia atrás hasta llegar a 14 días. Evita
      el render roto cuando solo hay 1 día de actividad real en el mes. */
  private padSeries(
    series: { date: string; value: number }[],
    minLength = 14,
  ): { date: string; value: number; isReal: boolean }[] {
    const real = series.map((s) => ({ ...s, isReal: true }));
    if (real.length >= minLength) return real.slice(-minLength);
    if (!real.length) return [];
    const earliest = new Date(real[0].date);
    const pad: { date: string; value: number; isReal: boolean }[] = [];
    for (let i = minLength - real.length; i > 0; i--) {
      const d = new Date(earliest);
      d.setDate(d.getDate() - i);
      pad.push({ date: d.toISOString().split('T')[0], value: 0, isReal: false });
    }
    return [...pad, ...real];
  }

  /** Sparkbars: barras verticales coloreadas por semáforo de cada día. */
  private buildSparkBars(
    series: { date: string; value: number }[],
    kpiId: string,
    fmt: (v: number) => string,
  ): SparkBarsConfig | undefined {
    const padded = this.padSeries(series);
    if (!padded.length) return undefined;
    const range = this.metasConfig.getRange(kpiId);
    const opt = range?.opt ?? 0;
    const min = range?.min ?? 0;
    const values = padded.map((s) => s.value);
    const maxVal = Math.max(...values, opt, 1);
    const W = 100;
    const H = 24;
    const gap = 1.2;
    const barW = (W - gap * Math.max(padded.length - 1, 0)) / padded.length;
    const metaY = opt > 0 ? H - 2 - (opt / maxVal) * (H - 4) : -1;
    const todayIdx = padded.length - 1;

    const bars: SparkBar[] = padded.map((s, i) => {
      const rawH = (s.value / maxVal) * (H - 4);
      const h = Math.max(rawH, 0.4);
      const y = H - 2 - h;
      let color: string;
      if (!s.isReal) color = 'var(--text-faint)';
      else if (opt && s.value >= opt) color = 'var(--ok-fg)';
      else if (min && s.value >= min) color = 'var(--warn-fg)';
      else if (opt) color = 'var(--bad-fg)';
      else color = 'var(--info-fg)';
      return {
        x: i * (barW + gap), y, w: barW, h,
        color,
        tooltip: s.isReal
          ? `${this.formatShortDate(s.date)} · ${fmt(s.value)}`
          : `${this.formatShortDate(s.date)} · sin actividad`,
        isToday: i === todayIdx,
      };
    });

    return {
      style: 'bars',
      bars, metaY, viewBox: `0 0 ${W} ${H}`,
      ariaLabel: `Tendencia ${padded.length} días. ${opt ? 'Meta ' + fmt(opt) + '.' : ''}`,
    };
  }

  /** Sparkline area: línea suave + gradiente bajo. Mucho más vistoso que
   * bars para flujo continuo (fotos, ventas). */
  private buildSparkArea(
    series: { date: string; value: number }[],
    kpiId: string,
    fmt: (v: number) => string,
  ): SparkAreaConfig | undefined {
    const padded = this.padSeries(series);
    if (!padded.length) return undefined;
    const range = this.metasConfig.getRange(kpiId);
    const opt = range?.opt ?? 0;
    const status = this.metasConfig.statusFor(kpiId, padded[padded.length - 1].value);
    const values = padded.map((s) => s.value);
    const maxVal = Math.max(...values, opt, 1);
    const W = 100;
    const H = 24;
    const pad = 2;
    const stepX = padded.length > 1 ? W / (padded.length - 1) : W;
    const metaY = opt > 0 ? H - pad - (opt / maxVal) * (H - pad * 2) : -1;
    const todayIdx = padded.length - 1;

    let color = 'var(--info-fg)';
    if (opt) {
      if (status === 'ok') color = 'var(--ok-fg)';
      else if (status === 'warn') color = 'var(--warn-fg)';
      else color = 'var(--bad-fg)';
    }

    const points: SparkAreaPoint[] = padded.map((s, i) => {
      const x = padded.length > 1 ? i * stepX : W / 2;
      const y = H - pad - (s.value / maxVal) * (H - pad * 2);
      return {
        x, y,
        tooltip: s.isReal
          ? `${this.formatShortDate(s.date)} · ${fmt(s.value)}`
          : `${this.formatShortDate(s.date)} · sin actividad`,
        isToday: i === todayIdx,
      };
    });

    const linePath = points
      .map((p, i) => (i === 0 ? 'M' : 'L') + ` ${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ');
    const last = points[points.length - 1];
    const areaPath = `${linePath} L ${last.x.toFixed(2)},${H} L 0,${H} Z`;

    return {
      style: 'area',
      linePath, areaPath, points,
      metaY, viewBox: `0 0 ${W} ${H}`,
      ariaLabel: `Tendencia ${padded.length} días. ${opt ? 'Meta ' + fmt(opt) + '.' : ''}`,
      color,
      gradientId: `spark-grad-${kpiId}`,
    };
  }

  /** Donut gauge. Hero variant: stroke más grueso, números grandes. */
  private buildGauge(
    rawValue: number,
    status: KpiStatus,
    formattedValue: string,
    metaOpt: number,
    unit: string,
    size: 'hero' | 'normal' = 'normal',
  ): GaugeConfig {
    const pct = metaOpt > 0 ? Math.min(100, Math.round((rawValue / metaOpt) * 100)) : 0;
    const r = 15.5;
    const C = 2 * Math.PI * r;
    const dashoffset = C * (1 - pct / 100);
    let color = 'var(--bad-fg)';
    if (status === 'ok') color = 'var(--ok-fg)';
    else if (status === 'warn') color = 'var(--warn-fg)';

    const parts = formattedValue.split(' ');
    const num = parts[0];
    const subUnit = parts.slice(1).join(' ');

    return {
      pct, color,
      centerValue: num,
      centerUnit: subUnit || unit,
      ariaLabel: `${formattedValue} de meta ${metaOpt}${unit}. ${pct}% alcanzado.`,
      circumference: C,
      dashoffset,
      size,
    };
  }

  private formatShortDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' });
  }

  // 2. Desglose de Mobiliario - usando datos DIARIOS
  furnitureRows = computed(() => {
    const metrics = this.summaryDaily() || {};
    const d = metrics.desglose_muebles || {};

    return this.metasConfig.furniture().map((f) => {
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

  // 3. Actividad reciente — enriquece con status pre-calculado para no
  // invocar `metasConfig.statusFor` desde el template en cada CD.
  recentCaptures = computed(() => {
    const data = this.reportsData();
    if (!data || !data.rows) return [];
    return data.rows.slice(0, 5).map((cap: any) => ({
      ...cap,
      _score: cap.stats?.puntuacionTotal ?? 0,
      _scoreStatus: this.metasConfig.statusFor('score', cap.stats?.puntuacionTotal ?? 0),
    }));
  });

  constructor() {
    // Effect: reacciona a filtros debounceados; usa `untracked` para que
    // los writes dentro de loadDashboardData no se rastreen como deps.
    effect(() => {
      this.filtersState.filtersDebounced();
      untracked(() => this.loadDashboardData());
    });

    // Re-render options + data colors al cambiar tema (NG0600: writes vía untracked).
    effect(() => {
      this.themeService.isMonochrome();
      untracked(() => {
        this.stackedChartOptions.set(this.buildChartOptions());
        const data = this.reportsData();
        if (data) this.updateChart(data);
      });
    });

    // WebSocket: recargar dashboard al llegar capturas (con debounce interno).
    this.ws.debouncedCaptureEvent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.loadDashboardData());

    // WebSocket: aplicar payload directo si no hay filtros activos.
    this.ws.metricsUpdated
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        const f = this.filtersState.filters();
        const hasFilters =
          !!f.zone ||
          !!f.supervisorId ||
          (f.sellerIds && f.sellerIds.length > 0);

        if (!hasFilters && event.summary?.metricas_globales) {
          this.summaryMonthly.set(event.summary.metricas_globales);
          this.summaryMonthlyLoading.set(false);
          if (event.dailyScores?.users) {
            this.summaryDaily.set(event.dailyScores.users);
            this.summaryDailyLoading.set(false);
          }
        } else {
          this.loadDashboardData();
        }
      });
  }

  ngOnInit(): void {
    // El effect del constructor dispara la primera carga; el otro genera
    // las opciones del chart con el tema activo. No hace falta nada acá.
  }

  // Helpers de rango de fechas (sin signals — son puros).
  private getMonthlyDateRange(): { startDate: string; endDate: string } {
    const end = new Date();
    const start = new Date();
    start.setDate(1);
    return {
      startDate: start.toLocaleDateString('en-CA'),
      endDate: end.toLocaleDateString('en-CA'),
    };
  }

  private getDailyDateRange(): { startDate: string; endDate: string } {
    const today = new Date().toLocaleDateString('en-CA');
    return { startDate: today, endDate: today };
  }

  loadDashboardData(): void {
    this.summaryMonthlyLoading.set(true);
    this.summaryDailyLoading.set(true);
    this.reportsDataLoading.set(true);

    const f = this.filtersState.filters();
    const monthlyRange = this.getMonthlyDateRange();
    const dailyRange = this.getDailyDateRange();

    forkJoin({
      summaryMonthly: this.reportsService.getSummary({
        startDate: monthlyRange.startDate,
        endDate: monthlyRange.endDate,
        zone: f.zone,
        supervisorId: f.supervisorId,
        sellerIds: f.sellerIds,
      }),
      summaryDaily: this.reportsService.getDailyCompliance({
        startDate: dailyRange.startDate,
        endDate: dailyRange.endDate,
        zone: f.zone,
        supervisorId: f.supervisorId,
        sellerIds: f.sellerIds,
      }),
      reportsRes: this.reportsService.getReportsData(
        {
          startDate: monthlyRange.startDate,
          endDate: monthlyRange.endDate,
          zone: f.zone,
          supervisorId: f.supervisorId,
          sellerIds: f.sellerIds,
        },
        1,
        5,
        'metrics,trend',
      ),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ summaryMonthly, summaryDaily, reportsRes }) => {
          this.summaryMonthly.set(summaryMonthly.metricas_globales);
          this.summaryMonthlyLoading.set(false);
          this.summaryDaily.set(summaryDaily.metricas_diarias);
          this.summaryDailyLoading.set(false);
          this.reportsData.set(reportsRes);
          this.reportsDataLoading.set(false);
          this.updateChart(reportsRes);
          this.lastUpdatedAt.set(new Date());
        },
        error: () => {
          this.summaryMonthlyLoading.set(false);
          this.summaryDailyLoading.set(false);
          this.reportsDataLoading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar los datos del dashboard.',
          });
        },
      });
  }

  private buildChartOptions(): any {
    const t = getChartTokens();
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 750, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.cardBg,
          titleColor: t.textMain,
          bodyColor: t.textMuted,
          borderColor: t.borderColor,
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (context: any) => {
              const visits = context.parsed.y;
              const score = context.dataset.scores?.[context.dataIndex];
              const lines = [`Visitas: ${visits}`];
              if (score != null) lines.push(`Score promedio: ${Math.round(score)} pts`);
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: t.chartAxis, font: { size: 11, weight: '500' } },
        },
        y: {
          beginAtZero: true,
          grid: { color: t.chartGrid, drawBorder: false },
          ticks: {
            color: t.chartAxis,
            font: { size: 10 },
            callback: (value: number) =>
              value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value,
          },
        },
      },
      interaction: { mode: 'index', intersect: false },
    };
  }

  /**
   * Calcula totales por día de la semana a partir del `trendData` del
   * backend y arma un bar chart simple. Antes se inventaba un desglose
   * alto/medio/bajo con factores fijos (60/30/10) — eso engañaba al usuario.
   * Ahora el chart muestra el dato real (total de visitas) y colorea cada
   * barra según el score promedio del día.
   */
  private updateChart(data: any): void {
    if (!data || !data.trendData) {
      this.stackedChartData.set(null);
      return;
    }

    const weekDays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const weekStats = weekDays.map(() => ({ visits: 0, scoreSum: 0, scoreCount: 0 }));

    for (const d of data.trendData) {
      // `parseLocalDate` evita el bug de UTC de `new Date('YYYY-MM-DD')`
      // que en MX desplaza el día uno hacia atrás. Ver core/utils/mx-date.
      const date = parseLocalDate(d.date);
      if (!date) continue;

      const dayIndex = date.getDay();
      const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1; // 0=Lun, 6=Dom

      weekStats[adjustedIndex].visits += d.visits || 0;
      if (typeof d.avgScore === 'number') {
        weekStats[adjustedIndex].scoreSum += d.avgScore;
        weekStats[adjustedIndex].scoreCount += 1;
      }
    }

    // Score promedio real por día para colorear y mostrar en tooltip.
    const avgScores = weekStats.map((s) =>
      s.scoreCount > 0 ? s.scoreSum / s.scoreCount : null,
    );

    const t = getChartTokens();
    this.stackedChartData.set({
      labels: weekDays,
      datasets: [
        {
          label: 'Visitas',
          data: weekStats.map((s) => s.visits),
          backgroundColor: avgScores.map((score) => colorForScore(t, score)),
          scores: avgScores,
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    });
  }

  fmtScore(v: any): string {
    return v != null ? Math.round(v) + ' pts' : '';
  }

  statusLabel(s: KpiStatus | string): string {
    return s === 'ok'
      ? 'Óptimo'
      : s === 'warn'
        ? 'Precaución'
        : s === 'bad'
          ? 'Bajo'
          : 'Info';
  }

  // --- Lógica del Diálogo de Metas ---
  openMetasDialog(): void {
    // Snapshot fresco cada vez que se abre — antes los valores quedaban
    // stale tras el primer save (los field initializers solo corren una vez).
    this.editableFurniture = this.metasConfig.furniture().map((f) => ({ ...f }));
    this.editableKpi = this.metasConfig.kpiRanges().map((k) => ({ ...k }));
    this.showMetasDialog.set(true);
  }

  saveMetas(): void {
    this.editableFurniture.forEach((f) =>
      this.metasConfig.updateFurnitureTarget(f.id, f.target),
    );
    this.editableKpi.forEach((k) =>
      this.metasConfig.updateKpiRange(k.id, k.min, k.opt),
    );
    this.showMetasDialog.set(false);
    // No recargamos del backend: las metas se aplican client-side
    // (statusFor, progressPct) y `metasConfig` es signal — los computeds
    // reaccionan solos.
    this.messageService.add({
      severity: 'success',
      summary: 'Metas guardadas',
      detail: 'Los rangos se aplicaron al dashboard.',
    });
  }

  cancelMetas(): void {
    this.showMetasDialog.set(false);
  }

  printPage(): void {
    window.print();
  }
}
