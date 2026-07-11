import {
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { DashboardService, DashboardData } from './dashboard.service';
import { FiltersStateService } from '../graphics/filters-state.service';
import {
  MetasConfigService,
  KpiRange,
  KpiStatus,
} from '../graphics/metas-config.service';
import { GlobalFiltersComponent } from '../graphics/global-filters.component';
import { WebSocketService } from '../../../../core/services/websocket.service';
import { ThemeService } from '../../../../core/services/theme.service';
import { getChartTokens } from '../../../../shared/theme/chart-theme';

interface SparkBar {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  tooltip: string;
  isToday: boolean;
}

interface SparkConfig {
  bars: SparkBar[];
  metaY: number;
  viewBox: string;
  ariaLabel: string;
}

interface GaugeConfig {
  pct: number;
  color: string;
  centerValue: string;
  centerUnit: string;
  ariaLabel: string;
  circumference: number;
  dashoffset: number;
}

type KpiKind = 'spark' | 'gauge';

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
  kind: KpiKind;
  spark?: SparkConfig;
  gauge?: GaugeConfig;
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
    <div class="dashboard-container w-full min-h-screen text-content-main pt-8">
      <!-- ── Header ─────────────────────────────────────────────────── -->
      <header
        class="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10"
      >
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-content-main flex items-center gap-3"><i class="pi pi-th-large text-content-main"></i> Dashboard Estratégico</h1>
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
        (filtersChanged)="scheduleLoad()"
      />

      <!-- ── KPI Cards ──────────────────────────────────────────────── -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <ng-container *ngIf="loading()">
          <div
            *ngFor="let i of [1, 2, 3, 4]"
            class="card-premium animate-pulse h-40"
          >
            <p-skeleton width="100%" height="100%" />
          </div>
        </ng-container>

        <ng-container *ngIf="!loading()">
          <div
            *ngFor="let k of kpiCards()"
            class="card-premium flex flex-col gap-3 group elevation-hover border-l-4 motion-safe:transition-shadow"
            [ngClass]="{
              'border-l-ok-fg': k.status === 'ok',
              'border-l-warn-fg': k.status === 'warn',
              'border-l-bad-fg': k.status === 'bad',
            }"
          >
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-[10px] uppercase tracking-widest font-bold text-content-muted truncate">{{ k.label }}</span>
              <span class="text-[9px] text-content-faint shrink-0">Meta {{ k.meta }}</span>
            </div>

            <!-- Variante SPARK: valor grande + delta + sparkbars debajo -->
            <ng-container *ngIf="k.kind === 'spark'">
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="text-3xl font-extrabold tabular-nums leading-none text-content-main">{{ k.value }}</span>
                <span class="text-[11px] font-semibold inline-flex items-center gap-0.5"
                      [ngClass]="{
                        'text-ok-fg':         k.deltaDir === 'up',
                        'text-bad-fg':        k.deltaDir === 'down',
                        'text-content-faint': k.deltaDir === 'flat',
                      }">
                  <i class="pi text-[9px]"
                     [ngClass]="{
                       'pi-arrow-up':   k.deltaDir === 'up',
                       'pi-arrow-down': k.deltaDir === 'down',
                       'pi-minus':      k.deltaDir === 'flat',
                     }"
                     aria-hidden="true"></i>
                  {{ k.delta }}
                </span>
              </div>

              <svg *ngIf="k.spark as s" [attr.viewBox]="s.viewBox" preserveAspectRatio="none"
                   class="w-full h-10 mt-auto kpi-spark"
                   [attr.aria-label]="s.ariaLabel" role="img">
                <line *ngIf="s.metaY >= 0"
                      x1="0" [attr.y1]="s.metaY" x2="100" [attr.y2]="s.metaY"
                      stroke="var(--text-faint)" stroke-width="0.3"
                      stroke-dasharray="1.5 1.5" opacity="0.55"></line>
                <g *ngFor="let b of s.bars; let i = index">
                  <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h"
                        [attr.fill]="b.color" rx="0.4"
                        [attr.opacity]="b.isToday ? 1 : 0.65"
                        class="motion-safe:transition-opacity hover:!opacity-100 cursor-help">
                    <title>{{ b.tooltip }}</title>
                  </rect>
                  <circle *ngIf="b.isToday"
                          [attr.cx]="b.x + b.w / 2" [attr.cy]="b.y - 1.2" r="0.7"
                          [attr.fill]="b.color"></circle>
                </g>
              </svg>
            </ng-container>

            <!-- Variante GAUGE: donut con valor centrado + delta debajo -->
            <ng-container *ngIf="k.kind === 'gauge' && k.gauge as g">
              <div class="flex-1 flex flex-col items-center justify-center gap-1.5 py-1">
                <div class="relative" role="img" [attr.aria-label]="g.ariaLabel">
                  <svg viewBox="0 0 40 40" class="w-20 h-20 -rotate-90 motion-safe:transition-transform">
                    <circle cx="20" cy="20" r="15.5" fill="none"
                            stroke="var(--layout-bg)" stroke-width="3"></circle>
                    <circle cx="20" cy="20" r="15.5" fill="none"
                            [attr.stroke]="g.color" stroke-width="3" stroke-linecap="round"
                            [attr.stroke-dasharray]="g.circumference"
                            [attr.stroke-dashoffset]="g.dashoffset"
                            class="motion-safe:transition-all duration-700">
                      <title>{{ g.ariaLabel }}</title>
                    </circle>
                  </svg>
                  <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span class="text-xl font-extrabold tabular-nums leading-none text-content-main">{{ g.centerValue }}</span>
                    <span *ngIf="g.centerUnit" class="text-[9px] text-content-muted uppercase tracking-wider mt-0.5">{{ g.centerUnit }}</span>
                  </div>
                </div>
                <span class="text-[11px] font-semibold inline-flex items-center gap-0.5"
                      [ngClass]="{
                        'text-ok-fg':         k.deltaDir === 'up',
                        'text-bad-fg':        k.deltaDir === 'down',
                        'text-content-faint': k.deltaDir === 'flat',
                      }">
                  <i class="pi text-[9px]"
                     [ngClass]="{
                       'pi-arrow-up':   k.deltaDir === 'up',
                       'pi-arrow-down': k.deltaDir === 'down',
                       'pi-minus':      k.deltaDir === 'flat',
                     }"
                     aria-hidden="true"></i>
                  {{ k.delta }}
                </span>
              </div>
            </ng-container>
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
                    class="w-3 h-0.5 bg-warn inline-block"
                    style="border-top:2px dashed var(--warn-fg)"
                  ></span
                  >Score
                </span>
                <span class="flex items-center gap-1.5">
                  <span
                    class="w-3 h-0.5 bg-bad inline-block"
                    style="border-top:2px dashed var(--bad-fg)"
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
                          'bg-ok-soft-bg text-ok-fg': row.status === 'ok',
                          'bg-warn-soft-bg text-warn-fg': row.status === 'warn',
                          'bg-bad-soft-bg text-bad-fg': row.status === 'bad',
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
                              'bg-ok': row.status === 'ok',
                              'bg-warn': row.status === 'warn',
                              'bg-bad': row.status === 'bad',
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
              <div class="stat-label !text-content-faint tracking-widest text-xs">
                Ejecución crítica
              </div>
              <div class="h-2 w-2 rounded-full bg-white animate-pulse"></div>
            </div>
            <div class="space-y-4">
              <div class="p-4 border border-white/10 rounded-2xl bg-white/5">
                <p
                  class="text-[10px] uppercase font-black tracking-widest text-content-faint mb-1"
                >
                  Mejor ejecutivo
                </p>
                <h4 class="text-xl font-extrabold tracking-tighter text-white">
                  {{ summary()?.mejor_ejecutivo || 'N/A' }}
                </h4>
              </div>
              <div class="p-4 border border-white/10 rounded-2xl bg-white/5">
                <p
                  class="text-[10px] uppercase font-black tracking-widest text-content-faint mb-1"
                >
                  Evidencias verificadas
                </p>
                <div class="flex items-end gap-2">
                  <span class="text-4xl font-extrabold tracking-tighter">{{
                    summary()?.total_fotos ?? 0
                  }}</span>
                  <span class="text-xs text-content-faint mb-1">fotos</span>
                </div>
              </div>
            </div>
            <div
              class="mt-8 pt-4 border-t border-white/10 flex justify-between items-center"
            >
              <span class="text-[10px] font-mono text-content-faint uppercase"
                >Sync v2.5</span
              >
              <i class="pi pi-shield text-content-faint"></i>
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
                        'text-ok-fg':
                          metasConfig.statusFor(
                            'score',
                            cap.stats?.puntuacionTotal ?? 0
                          ) === 'ok',
                        'text-warn-fg':
                          metasConfig.statusFor(
                            'score',
                            cap.stats?.puntuacionTotal ?? 0
                          ) === 'warn',
                        'text-bad-fg':
                          metasConfig.statusFor(
                            'score',
                            cap.stats?.puntuacionTotal ?? 0
                          ) === 'bad',
                      }"
                    >
                      {{ fmtScore(cap.stats?.puntuacionTotal) }}
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
            <span class="w-3 h-3 rounded bg-bad-soft-bg inline-block"></span>
            <span class="text-bad-fg">Por debajo del mínimo</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-warn-soft-bg inline-block"></span>
            <span class="text-warn-fg">Entre mínimo y óptimo</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-ok-soft-bg inline-block"></span>
            <span class="text-ok-fg">Óptimo o superior</span>
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
                    class="px-2 py-0.5 rounded-full bg-bad-soft-bg text-bad-fg"
                  >
                    &lt; {{ r.min }}{{ r.unit }} = bajo
                  </span>
                  <span
                    class="px-2 py-0.5 rounded-full bg-ok-soft-bg text-ok-fg"
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
                <div class="bg-bad-soft-bg" [style.flex]="r.min"></div>
                <div class="bg-warn-soft-bg" [style.flex]="r.opt - r.min"></div>
                <div class="bg-ok-soft-bg" [style.flex]="r.opt * 0.5"></div>
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
export class DashboardComponent implements OnInit, OnDestroy {
  private dashboardService = inject(DashboardService);
  readonly filtersState = inject(FiltersStateService);
  readonly metasConfig = inject(MetasConfigService);
  private messageService = inject(MessageService);
  private ws = inject(WebSocketService);
  private destroyRef = inject(DestroyRef);
  public themeService = inject(ThemeService);

  constructor() {
    // Re-render chart options + data al cambiar tema (NG0600: writes vía
    // untracked). Tokens se resuelven al construir cada chart config.
    effect(() => {
      this.themeService.isMonochrome();
      untracked(() => {
        this.initChartOptions();
        const data = this.rawData();
        if (data) this.buildChart(data);
      });
    });
  }

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
    const trend: Array<{ date: string; visits: number; avgScore: number }> = data.trendData ?? [];

    // Ratios para proyectar series diarias en KPIs que solo tienen totales
    // agregados. Aproximación: distribuye totalVentas/Exhibiciones por las
    // visitas reales del día. Bueno para forma de tendencia, no para cifras.
    const visitsTotal = m.totalVisitas || 0;
    const ventasPerVisit = visitsTotal ? (m.totalVentas ?? 0) / visitsTotal : 0;
    const exhPerVisit = visitsTotal ? (m.totalExhibiciones ?? visitsTotal) / visitsTotal : 1;

    const defs = [
      {
        id: 'visitas',
        label: 'Visitas',
        raw: m.totalVisitas ?? 0,
        fmt: (v: number) => Math.round(v).toLocaleString(),
        unit: '',
        icon: 'pi pi-map-marker',
        kind: 'spark' as KpiKind,
        series: trend.map((t) => ({ date: t.date, value: t.visits })),
      },
      {
        id: 'score',
        label: 'Avg score',
        raw: m.avgScore ?? 0,
        fmt: (v: number) => Math.round(v) + ' pts',
        unit: 'pts',
        icon: 'pi pi-star',
        kind: 'gauge' as KpiKind,
        series: [] as { date: string; value: number }[],
      },
      {
        id: 'venta',
        label: 'Impacto venta',
        raw: m.totalVentas ?? 0,
        fmt: (v: number) => '$' + Math.round(v).toLocaleString(),
        unit: '',
        icon: 'pi pi-dollar',
        kind: 'spark' as KpiKind,
        series: trend.map((t) => ({ date: t.date, value: ventasPerVisit * t.visits })),
      },
      {
        id: 'exhibiciones',
        label: 'Exhibiciones',
        raw: m.totalExhibiciones ?? 0,
        fmt: (v: number) => Math.round(v).toLocaleString(),
        unit: '',
        icon: 'pi pi-images',
        kind: 'gauge' as KpiKind,
        series: [] as { date: string; value: number }[],
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
        deltaDir: (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat',
        icon: d.icon,
        meta: range ? `${range.opt}${d.unit}` : '—',
        kind: d.kind,
        spark: d.kind === 'spark' ? this.buildSpark(d.series, d.id, d.fmt) : undefined,
        gauge: d.kind === 'gauge' ? this.buildGauge(d.raw, status, d.fmt(d.raw), range?.opt ?? 0, d.unit) : undefined,
      };
    });
  });

  /**
   * Gauge donut full-circle (rotada -90° en CSS). Background ring + foreground
   * arc cuya longitud = pct vs meta óptima. Color por status. Center muestra
   * el valor numérico + unidad pequeña debajo.
   */
  private buildGauge(
    rawValue: number,
    status: KpiStatus,
    formattedValue: string,
    metaOpt: number,
    unit: string,
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
      pct,
      color,
      centerValue: num,
      centerUnit: subUnit || unit,
      ariaLabel: `${formattedValue} de meta ${metaOpt}${unit}. ${pct}% alcanzado.`,
      circumference: C,
      dashoffset,
    };
  }

  /**
   * Genera sparkbars SVG normalizados a viewBox 0 0 100 24. Cada barra
   * coloreada por el semáforo (ok/warn/bad) según el valor de ESE día vs
   * el rango del KPI — no por el status global. Línea de meta dashed.
   * `today` marcado con dot sobre la barra. `<title>` provee tooltip nativo.
   */
  private buildSpark(
    series: { date: string; value: number }[],
    kpiId: string,
    fmt: (v: number) => string,
  ): SparkConfig | undefined {
    if (!series.length) return undefined;
    const range = this.metasConfig.getRange(kpiId);
    const opt = range?.opt ?? 0;
    const min = range?.min ?? 0;
    const values = series.map((s) => s.value);
    const maxVal = Math.max(...values, opt, 1);
    const W = 100;
    const H = 24;
    const gap = 1.5;
    const barW = (W - gap * Math.max(series.length - 1, 0)) / series.length;
    const metaY = opt > 0 ? H - 2 - (opt / maxVal) * (H - 4) : -1;
    const todayIdx = series.length - 1;

    const bars: SparkBar[] = series.map((s, i) => {
      const rawH = (s.value / maxVal) * (H - 4);
      const h = Math.max(rawH, 0.5);
      const y = H - 2 - h;
      let color: string;
      if (opt && s.value >= opt) color = 'var(--ok-fg)';
      else if (min && s.value >= min) color = 'var(--warn-fg)';
      else if (opt) color = 'var(--bad-fg)';
      else color = 'var(--info-fg)';
      return {
        x: i * (barW + gap),
        y,
        w: barW,
        h,
        color,
        tooltip: `${this.formatShortDate(s.date)} · ${fmt(s.value)}`,
        isToday: i === todayIdx,
      };
    });

    return {
      bars,
      metaY,
      viewBox: `0 0 ${W} ${H}`,
      ariaLabel: `Tendencia ${series.length} ${series.length === 1 ? 'día' : 'días'}. ${opt ? 'Meta ' + fmt(opt) + '.' : ''}`,
    };
  }

  private formatShortDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' });
  }

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

  // Debounce para cambios rápidos de filtros — evita N refetches al cambiar
  // zona/supervisor/seller en sucesión rápida.
  private _loadTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOAD_DEBOUNCE_MS = 300;

  scheduleLoad(): void {
    if (this._loadTimer) clearTimeout(this._loadTimer);
    this._loadTimer = setTimeout(() => {
      this._loadTimer = null;
      this.loadDashboardData();
    }, DashboardComponent.LOAD_DEBOUNCE_MS);
  }

  ngOnDestroy(): void {
    if (this._loadTimer) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
  }

  ngOnInit() {
    this.initChartOptions();
    this.loadDashboardData();

    this.ws.debouncedCaptureEvent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        console.log('[DashboardGraphics] WS event received, reloading');
        this.loadDashboardData();
      });

    this.ws.metricsUpdated
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        const f = this.filtersState.filters();
        const hasFilters = f.zone || f.supervisorId || (f.sellerIds && f.sellerIds.length > 0);

        if (!hasFilters && event.summary?.metricas_globales) {
          const m = event.summary.metricas_globales;
          const desglose = m.desglose_muebles || {};
          const furniture: Record<string, number> = {
            vitrina: desglose.vitrina || 0,
            exhibidor: desglose.exhibidor || 0,
            vitrolero: desglose.vitroleros || 0,
            paletero: desglose.paleteros || 0,
            tira: desglose.tiras || 0,
            otros: desglose.otros || 0,
          };

          this.summary.set({
            totalVisitas: m.visitas_totales || 0,
            avgScore: parseFloat(m.puntuacion_promedio) || 0,
            totalVentas: m.ventas_totales || 0,
            count: m.cierres_diarios_registrados || 0,
            totalExhibiciones: m.visitas_totales || 0,
            gpsPct: 0,
            totalTiendas: m.total_tiendas || 0,
            cierresDiarios: m.cierres_diarios_registrados || 0,
            avgDurationMin: parseFloat(m.avg_duration_min) || 0,
            totalFotos: m.total_fotos || 0,
            mejorEjecutivo: m.mejor_ejecutivo || 'N/A',
          });

          this.rawData.set({
            metrics: this.summary(),
            furniture,
            rows: event.dailyScores?.users ?? [],
            trendData: [],
            zoneStats: [],
            sellerStats: [],
            recentCaptures: [],
          });

          this.buildChart(this.rawData());
          this.loading.set(false);
        } else {
          this.loadDashboardData();
        }
      });
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
    const t = getChartTokens();
    const visitasMeta = this.metasConfig.getRange('visitas')?.opt ?? 50;
    const trend = data.trendData ?? [];
    this.chartData = {
      labels: trend.map((d: any) => d.date),
      datasets: [
        {
          label: 'Visitas',
          data: trend.map((d: any) => d.visits),
          borderColor: t.okFg,
          backgroundColor: t.okFg,
          tension: 0.4,
          pointRadius: 0,
          yAxisID: 'y',
        },
        {
          label: 'Score (pts)',
          data: trend.map((d: any) => d.avgScore),
          borderColor: t.warnFg,
          backgroundColor: t.warnFg,
          tension: 0.4,
          pointRadius: 0,
          borderDash: [4, 3],
          yAxisID: 'y2',
        },
        {
          label: 'Meta visitas',
          data: trend.map(() => visitasMeta),
          borderColor: t.badFg,
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
    const t = getChartTokens();
    this.chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, color: t.chartAxis } },
        y: {
          beginAtZero: false,
          grid: { color: t.chartGrid },
          ticks: { font: { size: 11 }, color: t.chartAxis },
        },
        y2: {
          beginAtZero: true,
          position: 'right',
          grid: { display: false },
          ticks: { font: { size: 11 }, color: t.chartAxis },
        },
      },
    };
  }

  // ── Semáforo helper para template ─────────────────────────────
  statusLabel(s: KpiStatus): string {
    return s === 'ok' ? 'Óptimo' : s === 'warn' ? 'En rango' : 'Bajo';
  }

  fmtScore(v: any): string {
    return v != null ? Math.round(v) + ' pts' : '';
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
  // jspdf y jspdf-autotable se cargan bajo demanda al primer export
  // para no engrosar el chunk del dashboard. Se cachean en _pdfLibs
  // tras la primera carga.
  private _pdfLibs?: {
    jsPDF: typeof import('jspdf').default;
    autoTable: typeof import('jspdf-autotable').default;
  };
  private async loadPdfLibs() {
    if (!this._pdfLibs) {
      const [jspdfMod, autotableMod] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      this._pdfLibs = {
        jsPDF: jspdfMod.default,
        autoTable: autotableMod.default,
      };
    }
    return this._pdfLibs;
  }

  async exportPdf() {
    const { jsPDF, autoTable } = await this.loadPdfLibs();
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
