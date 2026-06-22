import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TagModule } from 'primeng/tag';
import {
  DailyScoresResponse,
  SeguimientoFilters,
  SeguimientoService,
  UserScore,
  UserScores,
} from './seguimiento.service';
import { DailyCaptureService } from '../captures/daily-capture.service';
import { of, catchError, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Chart } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { PermissionsService } from '../../../core/services/permissions.service';
import { getChartTokens } from '../../../shared/theme/chart-theme';
import { ThemeService } from '../../../core/services/theme.service';
import { MetasConfigService, KpiRange } from '../../../modules/dashboard/reports/graphics/metas-config.service';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ReportsService, ReportsData } from '../../../modules/dashboard/reports/reports.service';
import { FiltersStateService } from '../../../modules/dashboard/reports/graphics/filters-state.service';
import { GlobalFiltersComponent } from '../../../modules/dashboard/reports/graphics/global-filters.component';
import { WebSocketService } from '../../../core/services/websocket.service';

interface WsMetricsEvent {
  type?: string;
  scope?: 'own' | 'team' | 'global';
  summary?: unknown;
  dailyScores?: { users?: UserScores[] };
}

/** Forma de cada `exhibición` dentro de una visita (lo que se renderiza). */
interface Exhibicion {
  id?: string;
  conceptoId?: string;
  ubicacionId?: string;
  formato?: string;
  rango?: string;
  perteneceMegaDulces?: boolean;
  productosMarcados?: (string | { nombre?: string })[];
  productos?: (string | { nombre?: string })[];
  fotoUrl?: string;
  ventaTotal?: number;
  horaRegistro?: string;
  puntuacionCalculada?: number;
  puntos?: number;
  nivelEjecucion?: string;
  nivel?: string;
}

/** Forma de las stats acumuladas de una visita. */
interface VisitStats {
  puntuacionTotal?: number;
  ventaTotal?: number;
  ventaAdicional?: number;
  rangoCompra?: string;
  totalExhibiciones?: number;
  totalProductosMarcados?: number;
}

/** Forma de una visita devuelta por `/reports/data` (lo que el grid usa). */
interface Visit {
  id?: string;
  folio: string;
  fecha?: string;
  hora_inicio?: string;
  hora_fin?: string;
  zona_captura?: string;
  cliente_nombre?: string;
  sucursal?: string;
  captured_by_username?: string;
  latitud?: number | null;
  longitud?: number | null;
  exhibiciones?: Exhibicion[];
  stats?: VisitStats;
  /** Las visitas de vendedor (app vendor) no se puntúan ni clasifican
   *  como exhibición de trade: no llevan score, concepto ni propio/competencia. */
  skip_scoring?: boolean;
}

/**
 * Lee los colores de barra del chart desde CSS variables del theme. Se
 * resuelven en runtime para que respondan al cambio light/dark sin
 * hardcodear hex. Las variables están definidas en styles.css:
 *   --chart-fill-low / -mid / -high / --chart-meta-line
 */
function readChartColors() {
  const t = getChartTokens();
  return {
    low: t.chartFillLow,
    mid: t.chartFillMid,
    high: t.chartFillHigh,
    goalLine: t.chartMetaLine,
  };
}

Chart.register(annotationPlugin);

@Component({
  selector: 'app-seguimiento',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule, 
    ButtonModule, 
    ChartModule, 
    DialogModule, 
    InputNumberModule, 
    ToastModule, 
    InputTextModule, 
    IconFieldModule, 
    InputIconModule, 
    TagModule, 
    ConfirmDialogModule,
    GlobalFiltersComponent
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './seguimiento.component.html',
  styles: [`
    :host ::ng-deep .p-chart { height: 100% !important; }

    /* ── Detail Dialog: force center + flex layout ── */
    :host ::ng-deep .seguimiento-detail-dialog.p-dialog-mask {
      display: flex !important;
      justify-content: center !important;
      align-items: center !important;
    }
    :host ::ng-deep .seguimiento-detail-dialog .p-dialog {
      display: flex !important;
      flex-direction: column !important;
      margin: 0 !important;
      top: 0 !important;
      left: 0 !important;
      transform: none !important;
      position: relative !important;
      max-height: 85vh !important;
    }
    :host ::ng-deep .seguimiento-detail-dialog .p-dialog-content {
      padding: 0 !important;
      overflow: hidden !important;
      flex: 1 1 auto !important;
      display: flex !important;
      flex-direction: column !important;
      min-height: 0 !important;
    }
    :host ::ng-deep .seguimiento-detail-dialog .p-dialog-content > * {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SeguimientoComponent implements OnInit {
  private service = inject(SeguimientoService);
  private reportsService = inject(ReportsService);
  private perms = inject(PermissionsService);
  private metasConfig = inject(MetasConfigService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private destroyRef = inject(DestroyRef);
  private dailyCaptureService = inject(DailyCaptureService);
  readonly filtersState = inject(FiltersStateService);
  private ws = inject(WebSocketService);
  private injector = inject(Injector);
  private themeService = inject(ThemeService);

  /** Última respuesta de scores cacheada para poder reconstruir el chart
   *  cuando cambia el tema sin volver a hacer fetch al backend. */
  private lastScores: DailyScoresResponse | null = null;

  // Signals \u2014 estado UI
  loadingChart = signal(false);
  loadingTabla = signal(false);
  reportsData = signal<ReportsData | null>(null);
  searchText = signal('');
  lastUpdate = signal('\u2014');

  // Conteos del chart: una barra por ejecutivo. `enMeta` = ejecutivos
  // cuyo promedio (en el rango de filtros) >= scoreOpt.
  enMeta = signal(0);
  totalUsers = signal(0);
  // Etiqueta del per\u00edodo (singular) para usar en subt\u00edtulo/tooltip:
  // "d\u00eda" / "semana" / "mes" seg\u00fan `filtersState.period`.
  periodLabel = signal<'d\u00eda' | 'semana' | 'mes'>('semana');

  selectedVisitIds = signal<Set<string>>(new Set());

  // Signals \u2014 chart. Tipos amplios: Chart.js no exporta tipos c\u00f3modos
  // para `data`/`options` runtime sin importar tooling extenso.
  chartData = signal<Record<string, unknown> | null>(null);
  chartOptions = signal<Record<string, unknown> | null>(null);
  scoreOpt = signal<number>(80);
  scoreMin = signal<number>(50);

  // \u2500\u2500 Chart secundario: Suma total + Promedio por d\u00eda con captura \u2500\u2500
  // Mismo dataset que el chart principal, distinta agregaci\u00f3n:
  //   - SUMA = sum(puntuacion) por usuario en el rango
  //   - AVG  = SUMA / d\u00edas con al menos 1 captura
  // Ej: 800 pts en 6 d\u00edas llenados = 133 pts/d\u00eda. Sirve para detectar
  // ejecutivos con alto volumen vs eficiencia diaria.
  // \u2500\u2500 Chart alternativo \u2014 cambia seg\u00fan `chartMode` \u2500\u2500
  // 4 modos ortogonales. Cada uno aporta una dimensi\u00f3n distinta del
  // desempe\u00f1o del ejecutivo, sin redundancia con el modo Promedio.
  //   'avg'        = Promedio del score (calidad de ejecuci\u00f3n).
  //   'adherence'  = Adherencia % + Visitas totales (constancia y volumen).
  //   'volume'     = Suma REAL de puntos (cu\u00e1nto valor gener\u00f3, no avg).
  //   'efficiency' = Puntos por visita + Visitas por d\u00eda (productividad unitaria).
  altChartData = signal<Record<string, unknown> | null>(null);
  altChartOptions = signal<Record<string, unknown> | null>(null);

  /** KPIs del subheader del chart activo. Cada modo llena distintos. */
  altKpis = signal<{ label: string; value: string }[]>([]);

  chartMode = signal<'avg' | 'adherence' | 'volume' | 'efficiency'>('avg');
  setChartMode(mode: 'avg' | 'adherence' | 'volume' | 'efficiency'): void {
    this.chartMode.set(mode);
    if (mode !== 'avg' && this.lastScores) {
      this.buildAltChart(this.lastScores);
    }
  }

  // Signals \u2014 dialogs & selection
  showComparison = signal(false);
  showDetail = signal(false);
  selectedRow = signal<Visit | null>(null);
  showImagePreview = signal(false);
  previewImageUrl = signal('');
  showMetasDialog = signal(false);

  // Estado in-flight para evitar double-click en delete
  deletingVisit = signal(false);

  // Editor de metas \u2014 solo KPI ranges; este m\u00f3dulo no edita mobiliario.
  editableKpi: KpiRange[] = [];

  /**
   * Plugin custom para pintar "{n} pts" dentro de cada barra del chart de
   * scores. Declarado como readonly del componente para no recrearlo en
   * cada rebuild del chart (antes viv\u00eda dentro de `buildChart` y se
   * reconstru\u00eda con cada WS event / cambio de filtro).
   *
   * `protected` para que sea legible desde el template (v\u00eda `[plugins]`).
   */
  protected readonly scoreLabelsPlugin = {
    id: 'scoreLabels',
    afterDraw: (chart: {
      ctx: CanvasRenderingContext2D;
      data: { datasets: Array<{ data: number[]; labelSuffix?: string }> };
      getDatasetMeta(idx: number): {
        data: { x: number; y: number; base: number; active?: boolean }[];
      };
    }) => {
      const { ctx, data } = chart;
      const ds = data.datasets[0];
      if (!ds) return;
      const suffix = ds.labelSuffix ?? ' pts';
      ctx.save();
      ds.data.forEach((value: number, i: number) => {
        const meta = chart.getDatasetMeta(0);
        const bar = meta.data[i];
        if (bar && bar.active !== false) {
          ctx.font = 'bold 12px sans-serif';
          ctx.fillStyle = getChartTokens().cardBg;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          const text = `${value}${suffix}`;
          const xPos = bar.x - 10;
          if (xPos > bar.base + 30) {
            ctx.fillText(text, xPos, bar.y);
          }
        }
      });
      ctx.restore();
    },
  };

  /**
   * Plugin que pinta una sparkline (línea + dots) DENTRO de cada barra del
   * chart de scores, mostrando la tendencia diaria del ejecutivo. Lee
   * `dataset.sparkData[i]` = scores[] del usuario en el rango. Solo dibuja
   * cuando la barra tiene ancho suficiente (>130px) para no chocar con el
   * score label ni perder legibilidad.
   */
  protected readonly sparklinePlugin = {
    id: 'sparkline',
    afterDraw: (chart: {
      ctx: CanvasRenderingContext2D;
      data: { datasets: Array<{ data: number[]; sparkData?: UserScore[][] }> };
      getDatasetMeta(idx: number): {
        data: { x: number; y: number; base: number; height?: number; active?: boolean }[];
      };
    }) => {
      const { ctx } = chart;
      const dataset = chart.data.datasets[0];
      const sparkData = dataset.sparkData;
      if (!sparkData?.length) return;
      const meta = chart.getDatasetMeta(0);

      ctx.save();
      meta.data.forEach((bar, i) => {
        if (!bar || bar.active === false) return;
        const series = sparkData[i];
        if (!series || series.length < 2) return;

        const barWidth = bar.x - bar.base;
        if (barWidth < 130) return;

        const labelGap = 50;
        const sparkW = 60;
        const sparkRight = bar.x - labelGap;
        const sparkLeft = sparkRight - sparkW;
        const h = (bar as { height?: number }).height ?? 18;
        const halfH = h / 2;
        const sparkTop = bar.y - halfH + 4;
        const sparkBottom = bar.y + halfH - 4;
        const sparkH = sparkBottom - sparkTop;
        if (sparkH < 6) return;

        const ordered = [...series].sort((a, b) =>
          (a.fecha || '').localeCompare(b.fecha || ''),
        );
        const values = ordered.map((s) => s.puntuacion);
        const maxV = Math.max(...values, 1);
        const stepX = sparkW / (ordered.length - 1);

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ordered.forEach((s, idx) => {
          const x = sparkLeft + idx * stepX;
          const y = sparkBottom - (s.puntuacion / maxV) * sparkH;
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ordered.forEach((s, idx) => {
          const x = sparkLeft + idx * stepX;
          const y = sparkBottom - (s.puntuacion / maxV) * sparkH;
          ctx.beginPath();
          ctx.arc(x, y, 1.1, 0, Math.PI * 2);
          ctx.fill();
        });
      });
      ctx.restore();
    },
  };

  /** Lista de plugins para `<p-chart [plugins]>`. Tipada como `unknown[]` para
   * que Angular acepte el binding (PrimeNG espera `any[]`). */
  protected readonly chartPlugins: unknown[] = [this.scoreLabelsPlugin, this.sparklinePlugin];

  // Computed \u2014 permisos
  canEditMetas = this.perms.can$('manage', 'kpi_goals');
  // Coherente con el backend: requiere REPORTES_GESTIONAR ('delete' on 'reports_manage').
  canDeleteVisit = this.perms.can$('delete', 'reports_manage');

  // Alt modes (adherence/volume/efficiency) tienen 2 datasets por usuario
  // que se stackean dentro del slot. Con 56px/user se ven comprimidos —
  // 84px/user les da respiro consistente con el peso visual del avg mode.
  chartHeight = computed(() => {
    const n = this.totalUsers();
    const perUser = this.chartMode() === 'avg' ? 56 : 84;
    return Math.max(160, n * perUser + 80);
  });

  allVisits = computed(() => this.reportsData()?.rows ?? []);

  // Búsqueda debounceada — evita recomputar filteredVisits en cada keystroke
  // cuando la lista tiene cientos de visitas.
  private debouncedSearch = toSignal(
    toObservable(this.searchText).pipe(
      debounceTime(250),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  filteredVisits = computed(() => {
    const q = this.debouncedSearch().toLowerCase().trim();
    const visits = this.allVisits();
    if (!q) return visits;
    return visits.filter(
      (v) =>
        (v.folio?.toLowerCase().includes(q) ?? false) ||
        (v.captured_by_username?.toLowerCase().includes(q) ?? false) ||
        (v.zona_captura?.toLowerCase().includes(q) ?? false),
    );
  });

  selectedVisits = computed(() => 
    this.allVisits().filter((v) => this.selectedVisitIds().has(v.folio))
  );
  
  selectedVisitsCount = computed(() => this.selectedVisitIds().size);

  getConceptoName = computed(() => {
    const conceptos = this.dailyCaptureService.conceptos();
    return (conceptoId: string | undefined): string => {
      if (!conceptoId) return '';
      const c = conceptos.find((cc) => cc.id === conceptoId);
      // NUNCA devolver el conceptoId crudo: si el catálogo aún no cargó, el
      // template caía mostrando el UUID. Devolvemos '' para que el fallback
      // (`|| 'Sin concepto'`) aplique hasta que `conceptos()` se hidrate.
      return c ? c.nombre : '';
    };
  });

  ngOnInit(): void {
    this.setupDataLoading();
    // Los nombres de concepto se resuelven contra el master data del singleton
    // DailyCaptureService (a diferencia de los productos, que vienen en
    // reportsData.productMap). En contextos de solo-reporte ese catálogo puede
    // no haberse cargado nunca → forzamos la carga si está vacío.
    if (!this.dailyCaptureService.conceptos().length) {
      this.dailyCaptureService.reloadMasterData();
    }
  }

  private setupDataLoading(): void {
    // ── Chart: se actualiza con metricsUpdated ──
    this.ws.metricsUpdated
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event: WsMetricsEvent) => {
        const hasFilters = this.hasActiveFilters();

        if (!hasFilters && event.dailyScores?.users) {
          this.buildChart({ users: event.dailyScores.users });
          this.lastUpdate.set('Últ. act. ' + this.nowTime());
        } else {
          this.reloadChart();
        }
      });

    // ── Tabla: se actualiza con eventos de captura ──
    this.ws.debouncedCaptureEvent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.reloadTabla());

    // ── Filtros: reacciona al state RAW (no al debounceado del service).
    // El service.filtersDebounced tiene un timing fragil con OnPush + signals;
    // hacemos debouncing local con setTimeout para garantizar que el effect
    // SIEMPRE dispare al cambiar cualquier filtro (zona / período / vendedor).
    let firstFilterRun = true;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      this.filtersState.filters();
      if (firstFilterRun) {
        firstFilterRun = false;
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.searchText.set('');
        this.showComparison.set(false);
        this.reloadAll();
        debounceTimer = null;
      }, 300);
    }, { injector: this.injector });
    this.destroyRef.onDestroy(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
    });

    // Re-render del chart cuando cambia el tema (light ↔ dark). Sin esto los
    // colores de las barras quedan stale y en dark mode se vuelven ilegibles.
    effect(() => {
      this.themeService.isMonochrome();
      if (this.lastScores) {
        this.buildChart(this.lastScores);
      }
    }, { injector: this.injector });

    // Carga inicial: ambos
    this.reloadAll();
  }

  private reloadChart(): void {
    this.loadingChart.set(true);
    const f = this.filtersState.filters();
    const params: SeguimientoFilters = { startDate: f.startDate, endDate: f.endDate };
    if (f.zone && f.zone !== 'null') params.zone = f.zone;
    if (f.supervisorId && f.supervisorId !== 'null') params.supervisorId = f.supervisorId;
    // Backend espera `userIds` (el state usa `sellerIds`). Sin esto, el chart
    // ignora el multiselect de Vendedor mientras la tabla sí lo aplica.
    if (f.sellerIds?.length) params.userIds = f.sellerIds;

    this.service.getDailyScores(params).pipe(
      takeUntilDestroyed(this.destroyRef),
      catchError(() => of({ users: [] } as DailyScoresResponse)),
    ).subscribe((scores) => {
      this.buildChart(scores);
      this.loadingChart.set(false);
      this.lastUpdate.set('Últ. act. ' + this.nowTime());
    });
  }

  private reloadTabla(): void {
    this.loadingTabla.set(true);
    const f = this.filtersState.filters();
    const visitFilters: SeguimientoFilters = {
      startDate: f.startDate,
      endDate: f.endDate,
    };
    if (f.zone && f.zone !== 'null') visitFilters.zone = f.zone;
    if (f.supervisorId && f.supervisorId !== 'null') visitFilters.supervisorId = f.supervisorId;
    if (f.sellerIds?.length) visitFilters.sellerIds = f.sellerIds;

    this.reportsService.getReportsData(visitFilters, undefined, undefined, 'products').pipe(
      takeUntilDestroyed(this.destroyRef),
      catchError(() => of({ rows: [], metrics: {} } as unknown as ReportsData)),
    ).subscribe((visitas) => {
      this.reportsData.set(visitas);
      this.loadingTabla.set(false);
    });
  }

  private reloadAll(): void {
    this.reloadChart();
    this.reloadTabla();
  }

  private hasActiveFilters(): boolean {
    const f = this.filtersState.filters();
    return !!(f.zone || f.supervisorId || (f.sellerIds && f.sellerIds.length > 0));
  }

  private nowTime(): string {
    return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  refreshAll(): void {
    this.searchText.set('');
    this.showComparison.set(false);
    this.reloadAll();
  }

  onVisitsFilterChange(): void {
    this.searchText.set('');
    this.showComparison.set(false);
    this.reloadAll();
  }

  toggleComparison(): void {
    this.showComparison.update((v) => !v);
  }

  visitScoreStatus(visit: Visit): 'ok' | 'warn' | 'bad' {
    return this.metasConfig.statusFor(
      'score',
      visit.stats?.puntuacionTotal ?? 0,
    );
  }

  /**
   * Mapea el nivel de ejecución textual a status semántico. Igual al de
   * /reports y /captures — cuando lo necesiten en más pantallas valdría
   * extraerlo a un util/pipe compartido.
   */
  nivelSeverity(nivel: string | null | undefined): 'ok' | 'warn' | 'bad' {
    const n = (nivel ?? '').toLowerCase();
    if (n === 'alto' || n === 'excelente' || n === 'optimo' || n === 'óptimo') return 'ok';
    if (n === 'medio' || n === 'regular') return 'warn';
    return 'bad';
  }

  /**
   * Etiqueta humana del status (Excelente/Regular/Crítico) — usada en el
   * subtítulo del score grande del detail dialog.
   */
  scoreStatusLabel(visit: Visit): string {
    const s = this.visitScoreStatus(visit);
    return s === 'ok' ? 'Excelente' : s === 'warn' ? 'Regular' : 'Crítico';
  }

  fmtScore(v: number | null | undefined): string {
    return v != null ? Math.round(v).toString() : '0';
  }

  /** Visita de vendedor (app vendor): no se puntúa ni clasifica como trade.
   *  Oculta puntuación, concepto y chips propio/competencia. */
  isVendorVisit(visit: Visit | null | undefined): boolean {
    return !!visit?.skip_scoring;
  }

  getProductNames = computed(() => {
    const map = this.reportsData()?.productMap;
    return (ex: Exhibicion): string[] => {
      const pids = ex.productosMarcados || ex.productos || [];
      if (!Array.isArray(pids)) return [];
      return pids.map((p) => {
        if (typeof p === 'object' && p?.nombre) return p.nombre;
        if (typeof p === 'string' && map && map[p]) return map[p].name;
        return String(p);
      });
    };
  });

  isVisitSelected(folio: string): boolean {
    return this.selectedVisitIds().has(folio);
  }

  toggleVisitSelection(folio: string, selected: boolean): void {
    const current = new Set(this.selectedVisitIds());
    if (selected) {
      current.add(folio);
    } else {
      current.delete(folio);
    }
    this.selectedVisitIds.set(current);
  }

  /**
   * Etiqueta singular del período activo, usada en el subtítulo y en el
   * tooltip ("Promedio en la semana"). Se deriva de `filtersState.period`:
   * `hoy` → día, `semanal`/`quincenal` → semana, `mensual` → mes, custom
   * → auto por span.
   */
  private pickPeriodLabel(): 'día' | 'semana' | 'mes' {
    const f = this.filtersState.filters();
    if (f.period === 'hoy') return 'día';
    if (f.period === 'mensual') return 'mes';
    if (f.period === 'semanal' || f.period === 'quincenal') return 'semana';
    // custom: derivar del span
    const start = new Date(f.startDate + 'T00:00:00');
    const end = new Date(f.endDate + 'T00:00:00');
    const days = Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1,
    );
    if (days <= 1) return 'día';
    if (days <= 31) return 'semana';
    return 'mes';
  }

  private buildChart(res: DailyScoresResponse): void {
    this.lastScores = res;
    const range = this.metasConfig.getRange('score');
    const scoreOpt = range?.opt ?? 80;
    const scoreMin = range?.min ?? 50;
    this.scoreOpt.set(scoreOpt);
    this.scoreMin.set(scoreMin);
    this.periodLabel.set(this.pickPeriodLabel());

    if (!res.users?.length) {
      this.chartData.set(null);
      this.altChartData.set(null);
      this.altChartOptions.set(null);
      this.altKpis.set([]);
      this.totalUsers.set(0);
      this.enMeta.set(0);
      return;
    }

    // Promedio de las puntuaciones de cada visita del usuario en el rango.
    // El rango lo controla `filtersState` (día / semana / mes / custom),
    // así que la misma agregación responde dinámicamente al período activo.
    const avg = (scores: { puntuacion: number }[]) =>
      scores.length > 0
        ? Math.round(scores.reduce((s, x) => s + x.puntuacion, 0) / scores.length)
        : 0;

    const users = res.users
      .map((u) => ({
        nombre: u.nombre,
        score: avg(u.scores),
        visits: u.scores.length,
        scores: u.scores,
      }))
      .filter((u) => u.score > 0)
      .sort((a, b) => b.score - a.score);

    this.totalUsers.set(users.length);
    this.enMeta.set(users.filter((u) => u.score >= scoreOpt).length);

    if (!users.length) {
      this.chartData.set(null);
      return;
    }

    // Tier discreto en grayscale (--chart-fill-low/mid/high). Respeta tema
    // light/dark automáticamente via CSS variables.
    const t = getChartTokens();
    const chartColors = readChartColors();
    const colorForScore = (score: number): string => {
      if (score >= scoreOpt) return chartColors.high;
      if (score >= scoreMin) return chartColors.mid;
      return chartColors.low;
    };
    const barColors = users.map((u) => colorForScore(u.score));
    const visitsPerUser = users.map((u) => u.visits);
    const sparkData = users.map((u) => u.scores);

    this.chartData.set({
      labels: users.map((u) => u.nombre),
      datasets: [
        {
          data: users.map((u) => u.score),
          backgroundColor: barColors,
          borderRadius: 3,
          barPercentage: 0.72,
          categoryPercentage: 0.9,
          visitsPerUser,
          sparkData,
          labelSuffix: ' pts',
        },
      ],
    });

    this.chartOptions.set({
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.cardBg,
          titleColor: t.textMain,
          bodyColor: t.textMain,
          borderColor: t.borderColor,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            label: (context: {
              parsed: { x: number };
              dataIndex: number;
              dataset: { visitsPerUser?: number[] };
            }) => {
              const score = context.parsed.x;
              const n = context.dataset.visitsPerUser?.[context.dataIndex] ?? 0;
              const visitsTxt = n === 1 ? '1 visita' : `${n} visitas`;
              const gap = score - scoreOpt;
              const gapTxt = gap >= 0 ? `+${gap} sobre meta` : `${gap} bajo meta`;
              return [`${score} pts · ${visitsTxt}`, gapTxt];
            },
          },
        },
        annotation: {
          annotations: {
            goalLine: {
              type: 'line',
              xMin: scoreOpt,
              xMax: scoreOpt,
              borderColor: chartColors.goalLine,
              borderWidth: 2,
              borderDash: [6, 3],
              label: {
                display: true,
                content: 'Meta ' + scoreOpt + ' pts',
                position: 'end',
                backgroundColor: 'rgba(156,163,175,0.15)',
                color: t.textMuted,
                font: { weight: 'bold', size: 11 },
              },
            },
          },
        },
        scoreLabels: { afterDraw: this.scoreLabelsPlugin.afterDraw },
        sparkline: { afterDraw: this.sparklinePlugin.afterDraw },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: 'Puntos acumulados', color: t.chartMetaLine },
          grid: { color: t.chartGrid },
          ticks: { color: t.chartAxis },
        },
        y: {
          title: { display: false },
          grid: { display: false },
          ticks: { color: t.textMain, font: { weight: 'bold', size: 12 } },
        },
      },
    });

    // Si el modo activo no es 'avg', reconstruir el chart alternativo.
    if (this.chartMode() !== 'avg') {
      this.buildAltChart(res);
    }
  }

  /**
   * Calcula días calendario del rango activo (start..end inclusive).
   * Lo usa el modo Adherencia para el denominador. Excluir fines de semana
   * sería un refinamiento futuro — por ahora días naturales.
   */
  private daysInRange(): number {
    const f = this.filtersState.filters();
    const start = new Date(f.startDate + 'T00:00:00');
    const end = new Date(f.endDate + 'T00:00:00');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
    return Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1,
    );
  }

  /**
   * Construye el chart secundario según el modo activo. Tres modos posibles:
   *
   *   'adherence' — Constancia + volumen de actividad:
   *     - Dataset 1: % adherencia = (días con captura / días del rango) × 100
   *     - Dataset 2: Visitas totales en el rango
   *
   *   'volume' — Valor real generado (no avg-de-avg):
   *     - Dataset 1: Suma REAL de puntos (sum(stats.puntuacionTotal) backend)
   *     - Dataset 2: Promedio score (referencia de calidad)
   *
   *   'efficiency' — Productividad unitaria:
   *     - Dataset 1: Puntos por visita = total_pts / total_visitas
   *     - Dataset 2: Visitas por día llenado = total_visitas / días_con_captura
   */
  private buildAltChart(res: DailyScoresResponse): void {
    const mode = this.chartMode();
    if (mode === 'avg') return;

    const dayRange = this.daysInRange();
    const t = getChartTokens();
    const colors = readChartColors();

    // Agregaciones comunes por usuario.
    const users = (res.users ?? [])
      .map((u) => {
        const daysFilled = u.scores.length;
        const totalReal = u.scores.reduce((s, x) => s + (x.total ?? x.puntuacion ?? 0), 0);
        const totalVisits = u.scores.reduce((s, x) => s + (x.visitas ?? 0), 0);
        const avgScore = daysFilled > 0
          ? Math.round(u.scores.reduce((s, x) => s + (x.puntuacion || 0), 0) / daysFilled)
          : 0;
        const adherence = dayRange > 0 ? Math.round((daysFilled / dayRange) * 100) : 0;
        const ptsPerVisit = totalVisits > 0 ? Math.round(totalReal / totalVisits) : 0;
        const visitsPerDay = daysFilled > 0 ? +(totalVisits / daysFilled).toFixed(1) : 0;
        return {
          nombre: u.nombre,
          daysFilled,
          totalReal: Math.round(totalReal),
          totalVisits,
          avgScore,
          adherence,
          ptsPerVisit,
          visitsPerDay,
        };
      })
      .filter((u) => u.daysFilled > 0);

    if (!users.length) {
      this.altChartData.set(null);
      this.altChartOptions.set(null);
      this.altKpis.set([]);
      return;
    }

    // Sort + KPIs globales por modo.
    if (mode === 'adherence') {
      users.sort((a, b) => b.adherence - a.adherence || b.totalVisits - a.totalVisits);
    } else if (mode === 'volume') {
      users.sort((a, b) => b.totalReal - a.totalReal);
    } else {
      // efficiency: priorizar puntos por visita
      users.sort((a, b) => b.ptsPerVisit - a.ptsPerVisit || b.visitsPerDay - a.visitsPerDay);
    }

    // KPIs globales (subheader) — qué se ve depende del modo.
    if (mode === 'adherence') {
      const avgAdh = Math.round(users.reduce((s, u) => s + u.adherence, 0) / users.length);
      const totVisits = users.reduce((s, u) => s + u.totalVisits, 0);
      this.altKpis.set([
        { label: 'Adherencia media', value: `${avgAdh}%` },
        { label: 'Visitas totales', value: `${totVisits}` },
        { label: 'Días del rango', value: `${dayRange}` },
      ]);
    } else if (mode === 'volume') {
      const sumReal = users.reduce((s, u) => s + u.totalReal, 0);
      const totVisits = users.reduce((s, u) => s + u.totalVisits, 0);
      const ptsPerVisitGlobal = totVisits > 0 ? Math.round(sumReal / totVisits) : 0;
      this.altKpis.set([
        { label: 'Puntos generados', value: `${sumReal}` },
        { label: 'Visitas totales', value: `${totVisits}` },
        { label: 'Pts/visita global', value: `${ptsPerVisitGlobal}` },
      ]);
    } else {
      const sumReal = users.reduce((s, u) => s + u.totalReal, 0);
      const totVisits = users.reduce((s, u) => s + u.totalVisits, 0);
      const totDays = users.reduce((s, u) => s + u.daysFilled, 0);
      const ptsPerVisitGlobal = totVisits > 0 ? Math.round(sumReal / totVisits) : 0;
      const visitsPerDayGlobal = totDays > 0 ? +(totVisits / totDays).toFixed(1) : 0;
      this.altKpis.set([
        { label: 'Pts/visita media', value: `${ptsPerVisitGlobal}` },
        { label: 'Visitas/día media', value: `${visitsPerDayGlobal}` },
        { label: 'Ejecutivos', value: `${users.length}` },
      ]);
    }

    // Datasets según modo.
    type DS = Record<string, unknown>;
    let datasets: DS[];
    let scales: DS;

    if (mode === 'adherence') {
      datasets = [
        {
          label: 'Adherencia %',
          data: users.map((u) => u.adherence),
          backgroundColor: colors.high,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          xAxisID: 'xPct',
          metaDays: users.map((u) => u.daysFilled),
          metaRange: dayRange,
          labelSuffix: '%',
        },
        {
          label: 'Visitas totales',
          data: users.map((u) => u.totalVisits),
          backgroundColor: colors.mid,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          xAxisID: 'xCount',
        },
      ];
      scales = {
        xPct: {
          beginAtZero: true, max: 100, position: 'top',
          title: { display: true, text: 'Adherencia %', color: t.chartMetaLine },
          grid: { color: t.chartGrid },
          ticks: { color: t.chartAxis, callback: (v: number) => `${v}%` },
        },
        xCount: {
          beginAtZero: true, position: 'bottom',
          title: { display: true, text: 'Visitas totales', color: t.chartMetaLine },
          grid: { display: false },
          ticks: { color: t.chartAxis },
        },
        y: { grid: { display: false }, ticks: { color: t.textMain, font: { weight: 'bold', size: 12 } } },
      };
    } else if (mode === 'volume') {
      datasets = [
        {
          label: 'Puntos generados',
          data: users.map((u) => u.totalReal),
          backgroundColor: colors.high,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          xAxisID: 'xPts',
          visits: users.map((u) => u.totalVisits),
          labelSuffix: ' pts',
        },
        {
          label: 'Score promedio',
          data: users.map((u) => u.avgScore),
          backgroundColor: colors.mid,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          xAxisID: 'xScore',
        },
      ];
      scales = {
        xPts: {
          beginAtZero: true, position: 'top',
          title: { display: true, text: 'Puntos generados (suma real)', color: t.chartMetaLine },
          grid: { color: t.chartGrid },
          ticks: { color: t.chartAxis },
        },
        xScore: {
          beginAtZero: true, position: 'bottom',
          title: { display: true, text: 'Score promedio', color: t.chartMetaLine },
          grid: { display: false },
          ticks: { color: t.chartAxis },
        },
        y: { grid: { display: false }, ticks: { color: t.textMain, font: { weight: 'bold', size: 12 } } },
      };
    } else {
      // efficiency
      datasets = [
        {
          label: 'Pts/visita',
          data: users.map((u) => u.ptsPerVisit),
          backgroundColor: colors.high,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          xAxisID: 'xPpv',
          visits: users.map((u) => u.totalVisits),
          labelSuffix: ' pts/v',
        },
        {
          label: 'Visitas/día',
          data: users.map((u) => u.visitsPerDay),
          backgroundColor: colors.mid,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          xAxisID: 'xVpd',
        },
      ];
      scales = {
        xPpv: {
          beginAtZero: true, position: 'top',
          title: { display: true, text: 'Puntos por visita', color: t.chartMetaLine },
          grid: { color: t.chartGrid },
          ticks: { color: t.chartAxis },
        },
        xVpd: {
          beginAtZero: true, position: 'bottom',
          title: { display: true, text: 'Visitas por día con captura', color: t.chartMetaLine },
          grid: { display: false },
          ticks: { color: t.chartAxis },
        },
        y: { grid: { display: false }, ticks: { color: t.textMain, font: { weight: 'bold', size: 12 } } },
      };
    }

    this.altChartData.set({
      labels: users.map((u) => u.nombre),
      datasets,
    });

    this.altChartOptions.set({
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.cardBg,
          titleColor: t.textMain,
          bodyColor: t.textMain,
          borderColor: t.borderColor,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            label: (context: {
              parsed: { x: number };
              dataIndex: number;
              dataset: {
                label?: string;
                metaDays?: number[];
                metaRange?: number;
                visits?: number[];
              };
            }) => {
              const ds = context.dataset;
              const idx = context.dataIndex;
              const val = context.parsed.x;
              if (ds.label === 'Adherencia %') {
                const d = ds.metaDays?.[idx] ?? 0;
                const r = ds.metaRange ?? 0;
                return ` ${val}% (${d} de ${r} días)`;
              }
              if (ds.label === 'Visitas totales' || ds.label === 'Visitas/día') {
                return ` ${val}`;
              }
              if (ds.label === 'Puntos generados') {
                const v = ds.visits?.[idx] ?? 0;
                return ` ${val} pts · ${v} visita${v === 1 ? '' : 's'}`;
              }
              if (ds.label === 'Pts/visita') {
                const v = ds.visits?.[idx] ?? 0;
                return ` ${val} pts/visita · ${v} visita${v === 1 ? '' : 's'}`;
              }
              return ` ${val}`;
            },
          },
        },
      },
      scales,
    });
  }

  viewDetail(visit: Visit): void {
    this.selectedRow.set(visit);
    this.showDetail.set(true);
  }

  closeDetail(): void {
    this.showDetail.set(false);
    this.selectedRow.set(null);
  }

  countPhotos(exhibiciones: Exhibicion[] | undefined): number {
    return (exhibiciones ?? []).filter((ex) => ex.fotoUrl).length;
  }

  /** Cuenta exhibiciones marcadas como propias (Mega Dulces). */
  countOwnBrand(exhibiciones: Exhibicion[] | undefined): number {
    return (exhibiciones ?? []).filter((ex) => ex.perteneceMegaDulces === true).length;
  }

  /** Cuenta exhibiciones marcadas como de la competencia. */
  countCompetition(exhibiciones: Exhibicion[] | undefined): number {
    return (exhibiciones ?? []).filter((ex) => ex.perteneceMegaDulces === false).length;
  }

  /**
   * Devuelve true si la visita tiene AL MENOS una exhibición clasificada
   * (propia o competencia). Útil para no mostrar chips vacíos en data legacy
   * sin clasificar (donde perteneceMegaDulces es undefined).
   */
  hasOwnershipData(exhibiciones: Exhibicion[] | undefined): boolean {
    return (exhibiciones ?? []).some((ex) => ex.perteneceMegaDulces !== undefined && ex.perteneceMegaDulces !== null);
  }

  openImagePreview(url: string): void {
    const safe = this.getImageUrl(url);
    if (!safe) return;
    this.previewImageUrl.set(safe);
    this.showImagePreview.set(true);
  }

  closeImagePreview(): void {
    this.showImagePreview.set(false);
    this.previewImageUrl.set('');
  }

  /**
   * Resuelve la URL de una imagen. Solo acepta http(s) (absolute) o rutas
   * relativas controladas (uploads del backend) — bloquea esquemas peligrosos
   * como `javascript:`, `data:`, etc. que podrían disparar XSS.
   */
  getImageUrl(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) return '';
    const trimmed = url.trim();

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    // Bloquea esquemas peligrosos (javascript:, data:, file:, etc.)
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return '';
    }
    // Path relativo confiable — lo concatenamos al baseUrl del backend.
    const clean = trimmed.replace(/^\/+/, '');
    return `${this.reportsService.baseUrl}/${clean}`;
  }

  openMetasDialog(): void {
    this.editableKpi = this.metasConfig.kpiRanges().map((r) => ({ ...r }));
    this.showMetasDialog.set(true);
  }

  saveMetas(): void {
    this.editableKpi.forEach((r) =>
      this.metasConfig.updateKpiRange(r.id, r.min, r.opt),
    );
    this.showMetasDialog.set(false);
    // No recargamos: `metasConfig` es signal, los computeds que dependen de
    // `statusFor`/`progressPct` reaccionan solos. Antes hacía 2 HTTP por
    // cambiar metas client-side.
    this.messageService.add({
      severity: 'success',
      summary: 'Metas guardadas',
      detail: 'Los rangos se actualizaron.',
    });
  }

  cancelMetas(): void {
    this.showMetasDialog.set(false);
  }

  deleteVisit(visit: Visit): void {
    if (this.deletingVisit()) return; // ya hay uno en vuelo
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar la visita <b>#${visit.folio}</b> de ${visit.captured_by_username || '?'}? Esta acción no se puede deshacer.`,
      header: 'Eliminar visita',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger p-button-text',
      rejectButtonStyleClass: 'p-button-text p-button-secondary',
      accept: () => {
        const id = visit.id || visit.folio;
        if (!id) return;
        this.deletingVisit.set(true);
        this.service
          .deleteVisit(id)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.deletingVisit.set(false);
              this.messageService.add({
                severity: 'success',
                summary: 'Visita eliminada',
                detail: `Visita #${visit.folio} eliminada correctamente.`,
              });
              this.closeDetail();
              this.refreshAll();
            },
            error: (err: unknown) => {
              this.deletingVisit.set(false);
              const e = err as { error?: { message?: string }; message?: string };
              const detail =
                e?.error?.message ||
                e?.message ||
                'No se pudo eliminar la visita.';
              this.messageService.add({
                severity: 'error',
                summary: 'Error al eliminar',
                detail,
              });
            },
          });
      },
    });
  }
}
