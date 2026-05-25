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
  UserScores,
} from './seguimiento.service';
import { DailyCaptureService } from '../captures/daily-capture.service';
import { of, catchError, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Chart } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { PermissionsService } from '../../../core/services/permissions.service';
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
}

/**
 * Lee los colores de barra del chart desde CSS variables del theme. Se
 * resuelven en runtime para que respondan al cambio light/dark sin
 * hardcodear hex. Las variables están definidas en styles.css:
 *   --chart-fill-low / -mid / -high / --chart-meta-line
 *
 * Si el browser no soporta CSS vars o el theme no se ha cargado, devuelve
 * un fallback razonable (los hex originales) para que el chart no se vea
 * en blanco.
 */
function readChartColors() {
  const fallback = {
    low: '#b4b4b4',
    mid: '#6b6b6b',
    high: '#1e1e1e',
    goalLine: '#9ca3af',
  };
  if (typeof getComputedStyle === 'undefined') return fallback;
  const cs = getComputedStyle(document.body);
  const read = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    low: read('--chart-fill-low', fallback.low),
    mid: read('--chart-fill-mid', fallback.mid),
    high: read('--chart-fill-high', fallback.high),
    goalLine: read('--chart-meta-line', fallback.goalLine),
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
      data: { datasets: { data: number[] }[] };
      getDatasetMeta(idx: number): {
        data: { x: number; y: number; base: number; active?: boolean }[];
      };
    }) => {
      const { ctx, data } = chart;
      ctx.save();
      data.datasets[0].data.forEach((value: number, i: number) => {
        const meta = chart.getDatasetMeta(0);
        const bar = meta.data[i];
        if (bar && bar.active !== false) {
          ctx.font = 'bold 12px sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          const text = `${value} pts`;
          const xPos = bar.x - 10;
          if (xPos > bar.base + 30) {
            ctx.fillText(text, xPos, bar.y);
          }
        }
      });
      ctx.restore();
    },
  };

  /** Lista de plugins para `<p-chart [plugins]>`. Tipada como `unknown[]` para
   * que Angular acepte el binding (PrimeNG espera `any[]`). */
  protected readonly chartPlugins: unknown[] = [this.scoreLabelsPlugin];

  // Computed \u2014 permisos
  canEditMetas = this.perms.can$('manage', 'kpi_goals');
  // Coherente con el backend: requiere REPORTES_GESTIONAR ('delete' on 'reports_manage').
  canDeleteVisit = this.perms.can$('delete', 'reports_manage');

  chartHeight = computed(() => Math.max(160, this.totalUsers() * 56 + 80));

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
      return c ? c.nombre : conceptoId;
    };
  });

  ngOnInit(): void {
    this.setupDataLoading();
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

    // ── Filtros: reacciona a cambios debounceados del state global ──
    // effect() requiere injection context; lo creamos aquí (fuera del
    // constructor) pasando el injector explícitamente.
    let firstFilterRun = true;
    effect(() => {
      this.filtersState.filtersDebounced();
      if (firstFilterRun) {
        firstFilterRun = false;
        return; // evitar doble fetch en la carga inicial (lo hacemos abajo)
      }
      this.searchText.set('');
      this.showComparison.set(false);
      this.reloadAll();
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
    const range = this.metasConfig.getRange('score');
    const scoreOpt = range?.opt ?? 80;
    const scoreMin = range?.min ?? 50;
    this.scoreOpt.set(scoreOpt);
    this.scoreMin.set(scoreMin);
    this.periodLabel.set(this.pickPeriodLabel());

    if (!res.users?.length) {
      this.chartData.set(null);
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
      }))
      .filter((u) => u.score > 0)
      .sort((a, b) => b.score - a.score);

    this.totalUsers.set(users.length);
    this.enMeta.set(users.filter((u) => u.score >= scoreOpt).length);

    if (!users.length) {
      this.chartData.set(null);
      return;
    }

    // Color por tier discreto. Los hex provienen de CSS variables del theme
    // (--chart-fill-*), por lo que respetan automáticamente light/dark.
    const chartColors = readChartColors();
    const colorForScore = (score: number): string => {
      if (score >= scoreOpt) return chartColors.high;
      if (score >= scoreOpt / 2) return chartColors.mid;
      return chartColors.low;
    };
    const barColors = users.map((u) => colorForScore(u.score));
    const visitsPerUser = users.map((u) => u.visits);

    this.chartData.set({
      labels: users.map((u) => u.nombre),
      datasets: [
        {
          data: users.map((u) => u.score),
          backgroundColor: barColors,
          borderRadius: 2,
          barPercentage: 0.7,
          categoryPercentage: 0.9,
          // Cantidad de visitas del usuario en el rango — se usa en el tooltip.
          visitsPerUser,
        },
      ],
    });

    this.chartOptions.set({
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context: {
              parsed: { x: number };
              dataIndex: number;
              dataset: { visitsPerUser?: number[] };
            }) => {
              const n = context.dataset.visitsPerUser?.[context.dataIndex] ?? 0;
              const visitsTxt = n === 1 ? '1 visita' : `${n} visitas`;
              return ` Promedio: ${context.parsed.x} pts · ${visitsTxt}`;
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
                color: '#4b5563',
                font: { weight: 'bold', size: 11 },
              },
            },
          },
        },
        scoreLabels: { afterDraw: this.scoreLabelsPlugin.afterDraw },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: 'Puntos acumulados', color: '#9ca3af' },
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { color: '#6b7280' },
        },
        y: {
          title: { display: false },
          grid: { display: false },
          ticks: { color: '#374151', font: { weight: 'bold', size: 12 } },
        },
      },
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
