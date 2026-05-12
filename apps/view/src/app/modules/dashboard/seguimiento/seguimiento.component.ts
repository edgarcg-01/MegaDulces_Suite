import { 
  Component, 
  OnInit, 
  inject, 
  signal, 
  computed, 
  ChangeDetectionStrategy,
  DestroyRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TagModule } from 'primeng/tag';
import { SeguimientoService, DailyScoresResponse } from './seguimiento.service';
import { DailyCaptureService } from '../captures/daily-capture.service';
import { Subject, switchMap, startWith, tap, forkJoin, of, catchError } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Chart } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { PermissionsService } from '../../../core/services/permissions.service';
import { MetasConfigService, KpiRange } from '../../../modules/dashboard/reports/graphics/metas-config.service';
import { MessageService } from 'primeng/api';
import { ReportsService, ReportsData } from '../../../modules/dashboard/reports/reports.service';
import { FiltersStateService } from '../../../modules/dashboard/reports/graphics/filters-state.service';
import { GlobalFiltersComponent } from '../../../modules/dashboard/reports/graphics/global-filters.component';

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
    GlobalFiltersComponent
  ],
  providers: [MessageService],
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
  private destroyRef = inject(DestroyRef);
  private dailyCaptureService = inject(DailyCaptureService);
  readonly filtersState = inject(FiltersStateService);

  // Signals
  loading = signal(false);
  loadingVisitas = signal(false);
  reportsData = signal<ReportsData | null>(null);
  searchText = signal('');
  lastUpdate = signal('\u2014');
  enMeta = signal(0);
  totalUsers = signal(0);
  selectedVisitIds = signal<Set<string>>(new Set());
  
  // State
  chartData: any = null;
  chartOptions: any = null;
  scoreOpt = 80;
  scoreMin = 50;
  showComparison = false;
  showDetail = false;
  selectedRow: any = null;
  showImagePreview = false;
  previewImageUrl = '';
  showMetasDialog = false;
  editableKpi: KpiRange[] = [];
  editableFurniture: { id: string; label: string; icon: string; target: number }[] = [];

  // Triggers
  private loadTrigger$ = new Subject<void>();

  // Computed
  canEditMetas = this.perms.can$('manage', 'kpi_goals');

  chartHeight = computed(() => Math.max(160, (this.totalUsers() * 56) + 80));

  allVisits = computed(() => this.reportsData()?.rows ?? []);

  filteredVisits = computed(() => {
    const q = this.searchText().toLowerCase().trim();
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
    return (conceptoId: string) => {
      const c = conceptos.find(c => c.id === conceptoId);
      return c ? c.nombre : conceptoId;
    };
  });

  ngOnInit(): void {
    this.setupDataLoading();
  }

  private setupDataLoading(): void {
    // Merge manual triggers and polling
    this.loadTrigger$.pipe(
      startWith(null),
      takeUntilDestroyed(this.destroyRef),
      tap(() => {
        this.loading.set(true);
        this.loadingVisitas.set(true);
      }),
      switchMap(() => {
        const f = this.filtersState.filters();
        const params: any = { 
          startDate: f.startDate, 
          endDate: f.endDate
        };
        if (f.zone && f.zone !== 'null') params.zone = f.zone;
        if (f.supervisorId && f.supervisorId !== 'null') params.supervisorId = f.supervisorId;
        
        const visitFilters: any = { ...params };
        if (f.sellerIds?.length) visitFilters.sellerIds = f.sellerIds;

        console.log('[Seguimiento] Loading data with clean params:', { params, visitFilters });

        // Use forkJoin with catchError on individual streams to prevent one failure from blocking both
        return forkJoin({
          scores: this.service.getDailyScores(params).pipe(
            catchError(err => {
              console.error('[Seguimiento] Scores API failed:', err);
              return of({ users: [] });
            })
          ),
          visitas: this.reportsService.getReportsData(visitFilters).pipe(
            catchError(err => {
              console.error('[Seguimiento] Reports API failed:', err);
              return of({ rows: [], metrics: {} } as any);
            })
          )
        }).pipe(
          tap(({ scores, visitas }) => {
            console.log('[Seguimiento] Data received:', { 
              scoresCount: scores.users?.length ?? 0, 
              visitasCount: visitas.rows?.length ?? 0
            });
            this.buildChart(scores);
            this.reportsData.set(visitas);
          })
        );
      })
    ).subscribe({
      next: (res) => {
        this.loading.set(false);
        this.loadingVisitas.set(false);
        this.lastUpdate.set('Últ. act. ' + new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }));
      },
      error: () => {
        this.loading.set(false);
        this.loadingVisitas.set(false);
      }
    });
  }

  refreshAll(): void {
    this.searchText.set('');
    this.showComparison = false;
    this.loadTrigger$.next();
  }

  onVisitsFilterChange(): void {
    this.searchText.set('');
    this.showComparison = false;
    this.loadTrigger$.next();
  }

  visitScoreStatus(visit: any): 'ok' | 'warn' | 'bad' {
    return this.metasConfig.statusFor('score', visit.stats?.puntuacionTotal ?? 0);
  }

  fmtScore(v: any): string {
    return v != null ? Math.round(v).toString() : '0';
  }

  getProductNames = computed(() => {
    const map = this.reportsData()?.productMap;
    // Process names once when productMap changes
    return (ex: any) => {
      const pids = ex.productosMarcados || ex.productos || [];
      if (!pids || !Array.isArray(pids)) return [];
      
      return pids.map((p: any) => {
        if (typeof p === 'object' && p.nombre) return p.nombre;
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

  private buildChart(res: DailyScoresResponse): void {
    const range = this.metasConfig.getRange('score');
    this.scoreOpt = range?.opt ?? 80;
    this.scoreMin = range?.min ?? 50;

    if (!res.users?.length) {
      this.chartData = null;
      return;
    }

    const avg = (scores: { puntuacion: number }[]) =>
      scores.length > 0 ? Math.round(scores.reduce((s, x) => s + x.puntuacion, 0) / scores.length) : 0;

    const users = res.users
      .map((u) => ({ nombre: u.nombre, score: avg(u.scores) }))
      .filter((u) => u.score > 0)
      .sort((a, b) => b.score - a.score);

    this.totalUsers.set(users.length);
    this.enMeta.set(users.filter(u => u.score >= this.scoreOpt).length);

    if (!users.length) {
      this.chartData = null;
      return;
    }

    const barColors = users.map((u) => {
      const ratio = Math.min(u.score / this.scoreOpt, 1);
      const value = Math.round(26 + (200 - 26) * (1 - ratio));
      return `rgb(${value}, ${value}, ${value})`;
    });

    this.chartData = {
      labels: users.map((u) => u.nombre),
      datasets: [{
        data: users.map((u) => u.score),
        backgroundColor: barColors,
        borderRadius: 2,
        barPercentage: 0.7,
        categoryPercentage: 0.9,
      }],
    };

    this.chartOptions = {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context: any) => ` Puntos: ${context.parsed.x}`
          }
        },
        annotation: {
          annotations: {
            goalLine: {
              type: 'line',
              xMin: this.scoreOpt,
              xMax: this.scoreOpt,
              borderColor: '#9ca3af',
              borderWidth: 2,
              borderDash: [6, 3],
              label: {
                display: true,
                content: 'Meta ' + this.scoreOpt + ' pts',
                position: 'end',
                backgroundColor: 'rgba(156,163,175,0.15)',
                color: '#4b5563',
                font: { weight: 'bold', size: 11 },
              },
            },
          },
        },
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
      plugins_custom: [{
        id: 'scoreLabels',
        afterDraw: (chart: any) => {
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
        }
      }]
    };

    (this.chartOptions.plugins as any).scoreLabels = {
      afterDraw: (this.chartOptions as any).plugins_custom[0].afterDraw
    };
  }

  viewDetail(visit: any): void {
    this.selectedRow = visit;
    this.showDetail = true;
  }

  closeDetail(): void {
    this.showDetail = false;
    this.selectedRow = null;
  }

  countPhotos(exhibiciones: any[]): number {
    return (exhibiciones ?? []).filter(ex => ex.fotoUrl).length;
  }

  openImagePreview(url: string): void {
    this.previewImageUrl = url;
    this.showImagePreview = true;
  }

  closeImagePreview(): void {
    this.showImagePreview = false;
    this.previewImageUrl = '';
  }

  getImageUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${this.reportsService.baseUrl}/${url}`;
  }

  openMetasDialog(): void {
    // Load all KPI ranges but keep it robust
    this.editableKpi = this.metasConfig.kpiRanges().map((r) => ({ ...r }));
    this.editableFurniture = [];
    this.showMetasDialog = true;
  }

  saveMetas(): void {
    this.editableKpi.forEach((r) => this.metasConfig.updateKpiRange(r.id, r.min, r.opt));
    this.showMetasDialog = false;
    this.loadTrigger$.next();
    this.messageService.add({
      severity: 'success',
      summary: 'Metas guardadas',
      detail: 'Los rangos se actualizaron.',
    });
  }

  cancelMetas(): void {
    this.showMetasDialog = false;
  }
}
