import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  ViewChild,
} from '@angular/core';
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
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

import { DashboardService, DashboardData } from './dashboard.service';
import { FiltersStateService } from '../graphics/filters-state.service';
import {
  MetasConfigService,
  KpiRange,
  KpiStatus,
} from '../graphics/metas-config.service';
import { GlobalFiltersComponent } from '../graphics/global-filters.component';

interface KpiCard {
  id: string;
  label: string;
  value: string;
  rawValue: number;
  unit: string;
  status: KpiStatus;
  pct: number;
  delta: string;
  deltaDir: 'up' | 'down' | 'flat';
  icon: string;
  meta: string;
}

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
  template: `
    <div class="dashboard-container w-full min-h-screen text-content-main">
      <!-- ── Header ─────────────────────────────────────────────────── -->
      <header
        class="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10"
      >
        <div>
          <h1 class="title-premium">Dashboard Estratégico</h1>
          <div class="flex items-center gap-3 mt-2">
            <span
              class="px-2 py-0.5 rounded-full bg-accent-brand-light text-[10px] font-black text-brand tracking-widest uppercase"
              >Live Metrics</span
            >
            <p class="text-xs text-content-muted font-medium">
              Visión de campo · {{ filtersState.rangeLabel() }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <p-button
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            [rounded]="true"
            (click)="loadDashboardData()"
            [loading]="loading()"
            pTooltip="Refrescar"
          />
          <p-button
            label="Metas"
            icon="pi pi-sliders-h"
            styleClass="p-button-brand"
            size="small"
            (click)="showMetasDialog = true"
          />
          <p-button
            label="PDF"
            icon="pi pi-file-pdf"
            severity="secondary"
            size="small"
            (click)="exportPdf()"
          />
        </div>
      </header>

      <!-- ── Filtros globales ────────────────────────────────────────── -->
      <app-global-filters
        #globalFilters
        (filtersChanged)="loadDashboardData()"
      />

      <!-- ── KPI Cards ──────────────────────────────────────────────── -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <ng-container *ngIf="loading()">
          <div
            *ngFor="let i of [1, 2, 3, 4, 5]"
            class="card-premium animate-pulse h-32"
          >
            <p-skeleton width="100%" height="4rem" />
          </div>
        </ng-container>

        <ng-container *ngIf="!loading()">
          <div
            *ngFor="let k of kpiCards()"
            class="card-premium flex flex-col justify-between group elevation-hover"
            [class.border-l-4]="true"
            [ngClass]="{
              'border-l-green-500': k.status === 'ok',
              'border-l-amber-400': k.status === 'warn',
              'border-l-red-500': k.status === 'bad',
            }"
          >
            <div class="flex items-start justify-between mb-4">
              <span class="stat-label text-xs">{{ k.label }}</span>
              <!-- Semáforo pill -->
              <span
                class="text-[9px] font-black tracking-widest uppercase px-2 py-0.5 rounded-full"
                [ngClass]="{
                  'bg-green-100 text-green-800': k.status === 'ok',
                  'bg-amber-100 text-amber-800': k.status === 'warn',
                  'bg-red-100 text-red-800': k.status === 'bad',
                }"
              >
                {{ statusLabel(k.status) }}
              </span>
            </div>

            <div class="flex items-end justify-between">
              <div>
                <div class="stat-value leading-none">{{ k.value }}</div>
                <div
                  class="text-[10px] mt-1 font-medium"
                  [ngClass]="{
                    'text-green-600': k.deltaDir === 'up',
                    'text-red-500': k.deltaDir === 'down',
                    'text-content-faint': k.deltaDir === 'flat',
                  }"
                >
                  {{ k.delta }}
                </div>
              </div>
              <div class="text-right">
                <div class="text-[9px] text-content-faint uppercase">Meta</div>
                <div class="text-xs font-bold text-content-muted">
                  {{ k.meta }}
                </div>
              </div>
            </div>

            <!-- Mini progress bar con color semáforo -->
            <div
              class="mt-3 h-1 rounded-full bg-surface-layout overflow-hidden"
            >
              <div
                class="h-full rounded-full transition-all duration-500"
                [style.width.%]="k.pct"
                [ngClass]="{
                  'bg-green-500': k.status === 'ok',
                  'bg-amber-400': k.status === 'warn',
                  'bg-red-500': k.status === 'bad',
                }"
              ></div>
            </div>
          </div>
        </ng-container>
      </div>

      <!-- ── Main grid ───────────────────────────────────────────────── -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- Izquierda 8 cols -->
        <div class="lg:col-span-8 space-y-6">
          <!-- Gráfica con línea de meta -->
          <div class="card-premium">
            <div class="flex items-center justify-between mb-6">
              <h3 class="stat-label">Ejecución semanal vs meta</h3>
              <div class="flex gap-4 text-[11px] text-content-muted flex-wrap">
                <span class="flex items-center gap-1.5">
                  <span class="w-3 h-0.5 bg-content-main inline-block"></span
                  >Visitas
                </span>
                <span class="flex items-center gap-1.5">
                  <span
                    class="w-3 h-0.5 bg-amber-400 inline-block"
                    style="border-top:2px dashed #EF9F27"
                  ></span
                  >Score
                </span>
                <span class="flex items-center gap-1.5">
                  <span
                    class="w-3 h-0.5 bg-red-400 inline-block"
                    style="border-top:2px dashed #E24B4A"
                  ></span
                  >Meta
                </span>
              </div>
            </div>
            <div class="h-[280px]">
              <p-chart
                type="line"
                [data]="chartData"
                [options]="chartOptions"
                height="100%"
                *ngIf="chartData && !loading()"
              />
              <p-skeleton height="280px" *ngIf="loading()" />
            </div>
          </div>

          <!-- Tabla de mobiliario con semáforo -->
          <div class="card-premium">
            <div
              class="flex items-center justify-between mb-6 pb-3 border-b border-divider"
            >
              <h3 class="stat-label">Cumplimiento por mobiliario</h3>
              <span
                class="text-[10px] text-content-faint uppercase tracking-widest"
                >Vs metas configuradas</span
              >
            </div>
            <div class="overflow-x-auto">
              <table class="w-full border-collapse">
                <thead>
                  <tr
                    class="text-[10px] text-content-muted font-black uppercase border-b border-divider"
                  >
                    <th class="pb-3 text-left">Activo</th>
                    <th class="pb-3 text-center">Realizado</th>
                    <th class="pb-3 text-center">Meta</th>
                    <th class="pb-3 text-center">Estado</th>
                    <th class="pb-3 text-right pr-4">Avance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    *ngFor="let row of furnitureRows()"
                    class="border-b border-divider/50 hover:bg-surface-layout transition-colors"
                  >
                    <td class="py-4">
                      <div class="flex items-center gap-3">
                        <div
                          class="w-9 h-9 rounded-xl bg-surface-layout border border-divider flex items-center justify-center"
                        >
                          <i [class]="row.icon" class="text-content-muted"></i>
                        </div>
                        <span class="text-sm font-bold">{{ row.label }}</span>
                      </div>
                    </td>
                    <td class="py-4 text-center font-mono font-bold">
                      {{ row.actual }}
                    </td>
                    <td class="py-4 text-center font-mono text-content-muted">
                      {{ row.target }}
                    </td>
                    <td class="py-4 text-center">
                      <span
                        class="px-2 py-0.5 rounded-full text-[10px] font-bold"
                        [ngClass]="{
                          'bg-green-100 text-green-800': row.status === 'ok',
                          'bg-amber-100 text-amber-800': row.status === 'warn',
                          'bg-red-100 text-red-800': row.status === 'bad',
                        }"
                      >
                        {{ statusLabel(row.status) }}
                      </span>
                    </td>
                    <td class="py-4 pr-4">
                      <div class="flex items-center justify-end gap-3">
                        <div
                          class="w-28 h-1.5 bg-surface-layout rounded-full overflow-hidden"
                        >
                          <div
                            class="h-full rounded-full"
                            [style.width.%]="row.pct"
                            [ngClass]="{
                              'bg-green-500': row.status === 'ok',
                              'bg-amber-400': row.status === 'warn',
                              'bg-red-500': row.status === 'bad',
                            }"
                          ></div>
                        </div>
                        <span class="text-xs font-mono font-bold w-9 text-right"
                          >{{ row.pct }}%</span
                        >
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Derecha 4 cols -->
        <div class="lg:col-span-4 space-y-6">
          <!-- Insight card (tu diseño original mejorado) -->
          <div class="card-premium monochrome-highlight shadow-2xl">
            <div class="flex items-center justify-between mb-6">
              <div class="stat-label !text-zinc-400 tracking-widest text-xs">
                Ejecución crítica
              </div>
              <div class="h-2 w-2 rounded-full bg-white animate-pulse"></div>
            </div>
            <div class="space-y-4">
              <div class="p-4 border border-white/10 rounded-2xl bg-white/5">
                <p
                  class="text-[10px] uppercase font-black tracking-widest text-zinc-500 mb-1"
                >
                  Mejor ejecutivo
                </p>
                <h4 class="text-xl font-extrabold tracking-tighter text-white">
                  {{ summary()?.mejor_ejecutivo || 'N/A' }}
                </h4>
              </div>
              <div class="p-4 border border-white/10 rounded-2xl bg-white/5">
                <p
                  class="text-[10px] uppercase font-black tracking-widest text-zinc-500 mb-1"
                >
                  Evidencias verificadas
                </p>
                <div class="flex items-end gap-2">
                  <span class="text-4xl font-extrabold tracking-tighter">{{
                    summary()?.total_fotos ?? 0
                  }}</span>
                  <span class="text-xs text-zinc-500 mb-1">fotos</span>
                </div>
              </div>
            </div>
            <div
              class="mt-8 pt-4 border-t border-white/10 flex justify-between items-center"
            >
              <span class="text-[10px] font-mono text-zinc-500 uppercase"
                >Sync v2.5</span
              >
              <i class="pi pi-shield text-zinc-500"></i>
            </div>
          </div>

          <!-- Actividad reciente -->
          <div class="card-premium">
            <div
              class="flex items-center justify-between mb-6 pb-3 border-b border-divider"
            >
              <h3 class="stat-label">Actividad reciente</h3>
              <p-button
                icon="pi pi-external-link"
                [text]="true"
                severity="secondary"
                size="small"
                routerLink="/dashboard/reports"
              />
            </div>
            <div class="space-y-4">
              <div
                *ngFor="let cap of recentCaptures()"
                class="flex items-start gap-3 group cursor-pointer hover:translate-x-1 transition-transform"
              >
                <div
                  class="h-9 w-9 shrink-0 rounded-full bg-surface-active text-content-active
                        flex items-center justify-center text-xs font-black uppercase ring-2 ring-surface-layout"
                >
                  {{ cap.captured_by_username?.charAt(0) }}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-2 mb-0.5">
                    <span class="text-xs font-bold truncate">{{
                      cap.captured_by_username
                    }}</span>
                    <span class="text-[9px] font-mono text-content-faint">
                      {{ cap.fechaCaptura | date: 'shortTime' }}
                    </span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span
                      class="text-[10px] text-content-muted uppercase tracking-tight"
                      >{{ cap.zona_captura }}</span
                    >
                    <!-- Score con semáforo -->
                    <span
                      class="text-xs font-black"
                      [ngClass]="{
                        'text-green-600':
                          metasConfig.statusFor(
                            'score',
                            cap.stats?.puntuacionTotal ?? 0
                          ) === 'ok',
                        'text-amber-500':
                          metasConfig.statusFor(
                            'score',
                            cap.stats?.puntuacionTotal ?? 0
                          ) === 'warn',
                        'text-red-500':
                          metasConfig.statusFor(
                            'score',
                            cap.stats?.puntuacionTotal ?? 0
                          ) === 'bad',
                      }"
                    >
                      {{ cap.stats?.puntuacionTotal }}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Acceso directo -->
          <div class="card-premium">
            <h3 class="stat-label mb-4">Operativa directa</h3>
            <div class="space-y-2">
              <a
                *ngFor="let a of quickActions"
                [routerLink]="a.route"
                class="flex items-center justify-between p-3 rounded-xl bg-surface-layout hover:bg-surface-hover
                    transition-all no-underline group border border-transparent hover:border-divider"
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-9 h-9 rounded-xl bg-surface-card border border-divider flex items-center justify-center
                          text-content-muted group-hover:bg-surface-active group-hover:text-content-active transition-colors"
                  >
                    <i [class]="a.icon"></i>
                  </div>
                  <span class="text-xs font-bold">{{ a.label }}</span>
                </div>
                <i
                  class="pi pi-chevron-right text-xs text-content-faint group-hover:translate-x-1 transition-transform"
                ></i>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════
     DIALOG: METAS Y RANGOS
═══════════════════════════════════════════════════════════════════ -->
    <p-dialog
      header="Metas y rangos de cumplimiento"
      [(visible)]="showMetasDialog"
      [modal]="true"
      [style]="{ width: '90vw', maxWidth: '680px' }"
      [draggable]="false"
      [resizable]="false"
      styleClass="surface-card rounded-2xl"
      [contentStyleClass]="'bg-surface-card'"
    >
      <div class="space-y-6 pt-2">
        <!-- Explicación de rangos -->
        <div
          class="flex gap-3 p-3 bg-surface-layout rounded-xl border border-divider text-xs text-content-muted"
        >
          <i class="pi pi-info-circle mt-0.5 text-content-faint"></i>
          <span
            >Define dos umbrales por KPI. El dashboard y los reportes usarán
            estos rangos para colorear el semáforo automáticamente. Los cambios
            se guardan en el navegador.</span
          >
        </div>

        <!-- Leyenda -->
        <div class="flex gap-4 flex-wrap text-[11px]">
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-red-200 inline-block"></span>
            <span class="text-red-700">Por debajo del mínimo</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-amber-200 inline-block"></span>
            <span class="text-amber-700">Entre mínimo y óptimo</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-green-200 inline-block"></span>
            <span class="text-green-700">Óptimo o superior</span>
          </span>
        </div>

        <!-- Sección KPIs -->
        <div>
          <h4
            class="text-xs font-black uppercase tracking-widest text-content-faint mb-3"
          >
            KPIs de ejecución
          </h4>
          <div class="space-y-4">
            <div
              *ngFor="let r of editableKpi"
              class="p-4 bg-surface-layout rounded-xl border border-divider"
            >
              <div class="flex items-center justify-between mb-3">
                <span class="font-bold text-sm">{{ r.label }}</span>
                <div class="flex gap-2 text-[10px]">
                  <span
                    class="px-2 py-0.5 rounded-full bg-red-100 text-red-700"
                  >
                    &lt; {{ r.min }}{{ r.unit }} = bajo
                  </span>
                  <span
                    class="px-2 py-0.5 rounded-full bg-green-100 text-green-700"
                  >
                    ≥ {{ r.opt }}{{ r.unit }} = óptimo
                  </span>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div class="flex flex-col gap-1">
                  <label
                    class="text-[10px] font-bold text-content-faint uppercase"
                    >Meta mínima</label
                  >
                  <p-inputNumber
                    [(ngModel)]="r.min"
                    [min]="0"
                    [max]="r.opt - 1"
                    [showButtons]="true"
                    buttonLayout="horizontal"
                    decrementButtonClass="p-button-secondary"
                    incrementButtonClass="p-button-secondary"
                    [suffix]="r.unit ? ' ' + r.unit : ''"
                    class="w-full"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label
                    class="text-[10px] font-bold text-content-faint uppercase"
                    >Meta óptima</label
                  >
                  <p-inputNumber
                    [(ngModel)]="r.opt"
                    [min]="r.min + 1"
                    [showButtons]="true"
                    buttonLayout="horizontal"
                    decrementButtonClass="p-button-secondary"
                    incrementButtonClass="p-button-secondary"
                    [suffix]="r.unit ? ' ' + r.unit : ''"
                    class="w-full"
                  />
                </div>
              </div>
              <!-- Barra visual de rango -->
              <div class="mt-3 h-2 rounded-full overflow-hidden flex">
                <div class="bg-red-300" [style.flex]="r.min"></div>
                <div class="bg-amber-300" [style.flex]="r.opt - r.min"></div>
                <div class="bg-green-300" [style.flex]="r.opt * 0.5"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Sección Mobiliario -->
        <div>
          <h4
            class="text-xs font-black uppercase tracking-widest text-content-faint mb-3"
          >
            Mobiliario
          </h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div
              *ngFor="let f of editableFurniture"
              class="flex items-center justify-between p-3 bg-surface-layout rounded-xl border border-divider gap-3"
            >
              <div class="flex items-center gap-2">
                <i
                  [class]="f.icon"
                  class="text-content-muted w-5 text-center"
                ></i>
                <span class="font-medium text-sm">{{ f.label }}</span>
              </div>
              <div class="w-28">
                <p-inputNumber
                  [(ngModel)]="f.target"
                  [min]="0"
                  [showButtons]="true"
                  buttonLayout="horizontal"
                  decrementButtonClass="p-button-secondary"
                  incrementButtonClass="p-button-secondary"
                  class="w-full"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <ng-template pTemplate="footer">
        <div class="flex justify-end gap-3">
          <p-button
            label="Cancelar"
            icon="pi pi-times"
            severity="secondary"
            (click)="cancelMetas()"
          />
          <p-button
            label="Guardar metas"
            icon="pi pi-check"
            styleClass="p-button-brand"
            (click)="saveMetas()"
          />
        </div>
      </ng-template>
    </p-dialog>

    <p-toast />
  `,
})
export class DashboardComponent implements OnInit {
  private dashboardService = inject(DashboardService);
  readonly filtersState = inject(FiltersStateService);
  readonly metasConfig = inject(MetasConfigService);
  private messageService = inject(MessageService);

  loading = signal(false);
  summary = signal<any>(null);
  rawData = signal<any>(null);

  showMetasDialog = false;

  // Copias editables para el diálogo (no se aplican hasta "Guardar")
  editableKpi = [...this.metasConfig.kpiRanges()].map((r) => ({ ...r }));
  editableFurniture = [...this.metasConfig.furniture()].map((f) => ({ ...f }));

  quickActions = [
    {
      label: 'Ver reportes',
      icon: 'pi pi-chart-bar',
      route: '/dashboard/reports',
    },
    {
      label: 'Capturas hoy',
      icon: 'pi pi-camera',
      route: '/dashboard/captures',
    },
    { label: 'Vendedores', icon: 'pi pi-users', route: '/dashboard/users' },
  ];

  chartData: any;
  chartOptions: any;

  // ── KPI cards computadas con semáforo ─────────────────────────
  kpiCards = computed<KpiCard[]>(() => {
    const data = this.rawData();
    if (!data) return [];
    const m = data.metrics ?? {};

    const defs = [
      {
        id: 'visitas',
        label: 'Visitas',
        raw: m.totalVisitas ?? 0,
        fmt: (v: number) => v.toLocaleString(),
        unit: '',
        icon: 'pi pi-map-marker',
      },
      {
        id: 'score',
        label: 'Avg score',
        raw: m.avgScore ?? 0,
        fmt: (v: number) => v + '%',
        unit: '%',
        icon: 'pi pi-star',
      },
      {
        id: 'venta',
        label: 'Impacto venta',
        raw: m.totalVentas ?? 0,
        fmt: (v: number) => '$' + v.toLocaleString(),
        unit: '',
        icon: 'pi pi-dollar',
      },
      {
        id: 'exhibiciones',
        label: 'Exhibiciones',
        raw: m.totalExhibiciones ?? 0,
        fmt: (v: number) => v.toLocaleString(),
        unit: '',
        icon: 'pi pi-images',
      },
      {
        id: 'gps',
        label: 'GPS cobertura',
        raw: m.gpsPct ?? 0,
        fmt: (v: number) => v + '%',
        unit: '%',
        icon: 'pi pi-map',
      },
    ];

    return defs.map((d) => {
      const range = this.metasConfig.getRange(d.id);
      const status = this.metasConfig.statusFor(d.id, d.raw);
      const pct = this.metasConfig.progressPct(d.id, d.raw);
      const prev = m['prev_' + d.id] ?? d.raw;
      const diff = prev ? Math.round(((d.raw - prev) / prev) * 100) : 0;
      return {
        id: d.id,
        label: d.label,
        value: d.fmt(d.raw),
        rawValue: d.raw,
        unit: d.unit,
        status,
        pct,
        delta:
          diff === 0
            ? 'Sin variación'
            : (diff > 0 ? `+${diff}%` : `${diff}%`) + ' vs anterior',
        deltaDir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        icon: d.icon,
        meta: range ? `${range.opt}${d.unit}` : '—',
      };
    });
  });

  // ── Filas de mobiliario ────────────────────────────────────────
  furnitureRows = computed(() => {
    const data = this.rawData();
    return this.metasConfig.furniture().map((f) => {
      const actual = data?.furniture?.[f.id] ?? 0;
      const status = this.metasConfig.furnitureStatus(actual, f.target);
      const pct = Math.min(100, Math.round((actual / f.target) * 100));
      return { ...f, actual, status, pct };
    });
  });

  recentCaptures = computed(() => this.rawData()?.recentCaptures ?? []);

  ngOnInit() {
    this.initChartOptions();
    this.loadDashboardData();
  }

  loadDashboardData() {
    this.loading.set(true);
    const f = this.filtersState.filters();
    this.dashboardService.getDashboardData(f).subscribe({
      next: (data: DashboardData) => {
        this.rawData.set(data);
        this.summary.set(data.metrics);
        this.buildChart(data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  // ── Gráfica con línea de meta ──────────────────────────────────
  buildChart(data: any) {
    const visitasMeta = this.metasConfig.getRange('visitas')?.opt ?? 50;
    const trend = data.trendData ?? [];
    this.chartData = {
      labels: trend.map((d: any) => d.date),
      datasets: [
        {
          label: 'Visitas',
          data: trend.map((d: any) => d.visits),
          borderColor: '#185FA5',
          backgroundColor: 'rgba(24,95,165,.06)',
          tension: 0.4,
          pointRadius: 4,
          yAxisID: 'y',
        },
        {
          label: 'Score %',
          data: trend.map((d: any) => d.avgScore),
          borderColor: '#EF9F27',
          backgroundColor: 'rgba(239,159,39,.04)',
          tension: 0.4,
          pointRadius: 4,
          borderDash: [4, 3],
          yAxisID: 'y2',
        },
        {
          label: 'Meta visitas',
          data: trend.map(() => visitasMeta),
          borderColor: '#E24B4A',
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          backgroundColor: 'transparent',
          yAxisID: 'y',
        },
      ],
    };
  }

  initChartOptions() {
    this.chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          beginAtZero: false,
          grid: { color: 'rgba(0,0,0,.05)' },
          ticks: { font: { size: 11 } },
        },
        y2: {
          beginAtZero: false,
          min: 0,
          max: 100,
          position: 'right',
          grid: { display: false },
          ticks: { callback: (v: number) => v + '%', font: { size: 11 } },
        },
      },
    };
  }

  // ── Semáforo helper para template ─────────────────────────────
  statusLabel(s: KpiStatus): string {
    return s === 'ok' ? 'Óptimo' : s === 'warn' ? 'En rango' : 'Bajo';
  }

  // ── Dialog de metas ───────────────────────────────────────────
  openMetasDialog() {
    // Clonar para edición sin afectar estado hasta guardar
    this.editableKpi = this.metasConfig.kpiRanges().map((r) => ({ ...r }));
    this.editableFurniture = this.metasConfig
      .furniture()
      .map((f) => ({ ...f }));
    this.showMetasDialog = true;
  }

  saveMetas() {
    this.editableKpi.forEach((r) =>
      this.metasConfig.updateKpiRange(r.id, r.min, r.opt),
    );
    this.editableFurniture.forEach((f) =>
      this.metasConfig.updateFurnitureTarget(f.id, f.target),
    );
    this.showMetasDialog = false;
    // Reconstruir gráfica con nueva meta
    const data = this.rawData();
    if (data) this.buildChart(data);
    this.messageService.add({
      severity: 'success',
      summary: 'Metas guardadas',
      detail: 'Los rangos se actualizaron.',
    });
  }

  cancelMetas() {
    this.showMetasDialog = false;
  }

  // ── Export PDF ────────────────────────────────────────────────
  exportPdf() {
    const doc = new jsPDF();
    const f = this.filtersState.filters();

    doc.setFontSize(16);
    doc.text('Dashboard Estratégico', 14, 20);
    doc.setFontSize(10);
    doc.text(
      `Período: ${this.filtersState.rangeLabel()} | Generado: ${new Date().toLocaleString()}`,
      14,
      28,
    );

    // KPIs
    doc.setFontSize(12);
    doc.text('KPIs de ejecución', 14, 40);
    autoTable(doc, {
      startY: 44,
      head: [['KPI', 'Valor', 'Meta óptima', 'Estado']],
      body: this.kpiCards().map((k) => [
        k.label,
        k.value,
        k.meta,
        this.statusLabel(k.status),
      ]),
    });

    // Mobiliario
    const afterKpi = (doc as any).lastAutoTable.finalY + 10;
    doc.setFontSize(12);
    doc.text('Cumplimiento por mobiliario', 14, afterKpi);
    autoTable(doc, {
      startY: afterKpi + 4,
      head: [['Activo', 'Realizado', 'Meta', 'Avance', 'Estado']],
      body: this.furnitureRows().map((r) => [
        r.label,
        r.actual,
        r.target,
        r.pct + '%',
        this.statusLabel(r.status),
      ]),
    });

    doc.save(`dashboard_${f.startDate}_${f.endDate}.pdf`);
  }
}
