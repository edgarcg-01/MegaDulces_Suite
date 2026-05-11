import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
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
import { Subscription, interval } from 'rxjs';
import { Chart } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { MetasConfigService, KpiRange } from '../../../modules/dashboard/reports/graphics/metas-config.service';
import { MessageService } from 'primeng/api';
import { ReportsService, ReportsData } from '../../../modules/dashboard/reports/reports.service';
import { FiltersStateService } from '../../../modules/dashboard/reports/graphics/filters-state.service';
import { GlobalFiltersComponent } from '../../../modules/dashboard/reports/graphics/global-filters.component';

(Chart as any).register(annotationPlugin);

const barLabelPlugin = {
  id: 'barLabels',
  afterDatasetsDraw(chart: any) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = '#374151';
    ctx.font = 'bold 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    chart.data.datasets.forEach((dataset: any, i: number) => {
      const meta = chart.getDatasetMeta(i);
      meta.data.forEach((bar: any, index: number) => {
        const value = dataset.data[index];
        if (value == null) return;
        ctx.fillText(Math.round(value) + ' pts', bar.x + 6, bar.y);
      });
    });
    ctx.restore();
  }
};
(Chart as any).register(barLabelPlugin);

@Component({
  selector: 'app-seguimiento',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ChartModule, DialogModule, InputNumberModule, ToastModule, InputTextModule, IconFieldModule, InputIconModule, TagModule, GlobalFiltersComponent],
  providers: [MessageService],
  template: `
    <main class="p-6 space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-content-main">
            Seguimiento Diario
          </h1>
          <p class="text-content-muted text-sm">
            Score por ejecutivo — {{ filtersState.rangeLabel() }}
          </p>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <span class="text-xs text-content-faint">{{ lastUpdate }}</span>
          <p-button
            icon="pi pi-refresh"
            label="Actualizar"
            severity="secondary"
            [outlined]="true"
            (onClick)="refreshAll()"
            [disabled]="loading() || loadingVisitas()"
          />
          <p-button
            *ngIf="canEditMetas()"
            label="Metas"
            icon="pi pi-sliders-h"
            styleClass="p-button-brand"
            size="small"
            (click)="openMetasDialog()"
          />
        </div>
      </div>

      <div *ngIf="totalUsers() > 0" class="flex items-center gap-2 px-4 py-2.5 bg-surface-50 rounded-lg border border-surface-200">
        <span class="text-sm font-semibold text-content-main">
          {{ enMeta() }} de {{ totalUsers() }} ejecutivos en meta
          <span class="text-content-muted font-normal text-xs ml-1">(\u2265{{ scoreOpt }} pts)</span>
        </span>
      </div>

      <div class="card-premium">
        <div class="h-[450px]">
          <p-chart
            type="bar"
            [data]="chartData"
            [options]="chartOptions"
            height="100%"
            *ngIf="chartData"
          />
          <div
            *ngIf="!chartData && !loading()"
            class="flex items-center justify-center h-full text-content-muted"
          >
            No hay datos para hoy
          </div>
        </div>
      </div>

      <div class="flex items-center gap-4 text-xs text-content-faint">
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-green-500"></span>
          Optimo (\u2265{{ scoreOpt }})
        </span>
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-amber-400"></span>
          Regular ({{ scoreMin }}\u2013{{ scoreOpt - 1 }})
        </span>
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-red-500"></span>
          Critico (&lt;{{ scoreMin }})
        </span>
        <span class="flex items-center gap-1 ml-2">
          <span class="w-6 h-0.5 bg-amber-500 border-dashed" style="border-top:2px dashed #f59e0b"></span>
          Meta ({{ scoreOpt }} pts)
        </span>
      </div>

      <div class="mt-10 pt-6 border-t border-divider">
        <app-global-filters (filtersChanged)="onVisitsFilterChange()" />

        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold text-content-main">Visitas</h2>
          <div class="flex items-center gap-3">
            <p-iconfield>
              <p-inputicon class="pi pi-search" />
              <input
                pInputText
                type="text"
                [(ngModel)]="searchText"
                placeholder="Buscar visita..."
                class="p-inputtext-sm"
              />
            </p-iconfield>
            <span class="text-xs text-content-muted">{{ allVisits().length }} visita(s)</span>
          </div>
        </div>

        <div *ngIf="selectedVisitsCount() > 0" class="flex items-center gap-3 p-3 bg-surface-layout rounded-xl border border-divider mb-4">
          <span class="text-xs text-content-muted flex-1">{{ selectedVisitsCount() }} visita(s) seleccionada(s)</span>
          <p-button label="Comparar" icon="pi pi-sliders-h" severity="secondary" size="small" (click)="showComparison = !showComparison" />
        </div>

        <div *ngIf="loadingVisitas()" class="flex justify-center py-12">
          <i class="pi pi-spin pi-spinner text-2xl text-content-faint"></i>
        </div>

        <ng-container *ngIf="!loadingVisitas()">
          <div *ngIf="allVisits().length > 0" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div
              *ngFor="let visit of filteredVisits()"
              class="card-premium cursor-pointer hover:border-content-muted/30 transition-all focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
              [class.ring-2]="visit._selected"
              [class.ring-blue-400]="visit._selected"
              (click)="viewDetail(visit)"
              tabindex="0"
              (keydown.enter)="viewDetail(visit)"
            >
              <div class="flex items-start gap-3 mb-4">
                <input
                  type="checkbox"
                  [(ngModel)]="visit._selected"
                  (click)="$event.stopPropagation()"
                  style="accent-color:#185FA5;margin-top:3px"
                  class="focus-visible:ring-2 focus-visible:ring-blue-300"
                />
                <div class="flex-1 min-w-0">
                  <div class="text-xs text-content-faint mb-0.5">#{{ visit.folio }} · {{ visit.fecha | date:'dd MMM':'UTC' }}</div>
                  <div class="font-bold text-sm text-content-main truncate">{{ visit.captured_by_username }}</div>
                  <div class="flex gap-1.5 mt-1 flex-wrap">
                    <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-layout border border-divider text-content-muted uppercase font-bold">{{ visit.zona_captura }}</span>
                    <span *ngIf="visit.latitud" class="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 font-bold">GPS</span>
                  </div>
                </div>
                <div
                  class="w-16 h-16 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 border-2"
                  [ngClass]="{
                    'border-green-400 text-green-700': visitScoreStatus(visit) === 'ok',
                    'border-amber-400 text-amber-700': visitScoreStatus(visit) === 'warn',
                    'border-red-400 text-red-700': visitScoreStatus(visit) === 'bad'
                  }"
                >
                  {{ fmtScore(visit.stats?.puntuacionTotal) }}
                </div>
              </div>
              <div class="flex gap-2">
                <p-button label="Ver detalle" icon="pi pi-eye" severity="secondary" size="small" styleClass="flex-1 justify-center" (click)="viewDetail(visit); $event.stopPropagation()" />
              </div>
            </div>
          </div>

          <div *ngIf="allVisits().length === 0" class="text-center py-12 text-content-muted">
            No hay visitas para hoy
          </div>
        </ng-container>

        <div *ngIf="showComparison && selectedVisitsCount() >= 2" class="card-premium mt-4">
          <h3 class="text-sm font-bold mb-4 text-content-main">Vista comparativa</h3>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="text-xs uppercase text-content-muted border-b border-divider">
                  <th class="py-2 text-left">M\u00e9trica</th>
                  <th *ngFor="let v of selectedVisits()" class="py-2 text-center">
                    <span class="font-bold text-content-main">#{{ v.folio }}</span><br />
                    <span class="text-[11px] font-normal">{{ v.captured_by_username }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr class="border-b border-divider/50">
                  <td class="py-2 text-content-muted">Score final</td>
                  <td *ngFor="let v of selectedVisits()" class="py-2 text-center font-bold"
                    [ngClass]="{ 'text-green-600': visitScoreStatus(v) === 'ok', 'text-amber-500': visitScoreStatus(v) === 'warn', 'text-red-500': visitScoreStatus(v) === 'bad' }">
                    {{ fmtScore(v.stats?.puntuacionTotal) }}
                  </td>
                </tr>
                <tr class="border-b border-divider/50">
                  <td class="py-2 text-content-muted">Exhibiciones</td>
                  <td *ngFor="let v of selectedVisits()" class="py-2 text-center">{{ v.exhibiciones?.length ?? 0 }}</td>
                </tr>
                <tr class="border-b border-divider/50">
                  <td class="py-2 text-content-muted">Zona</td>
                  <td *ngFor="let v of selectedVisits()" class="py-2 text-center text-content-muted text-xs uppercase">{{ v.zona_captura }}</td>
                </tr>
                <tr class="border-b border-divider/50">
                  <td class="py-2 text-content-muted">GPS</td>
                  <td *ngFor="let v of selectedVisits()" class="py-2 text-center">
                    <span [ngClass]="v.latitud ? 'text-green-600' : 'text-red-500'" class="font-bold text-xs">{{ v.latitud ? 'S\u00ed' : 'No' }}</span>
                  </td>
                </tr>
                <tr>
                  <td class="py-2 text-content-muted">Venta total</td>
                  <td *ngFor="let v of selectedVisits()" class="py-2 text-center font-bold">{{ (v.stats?.ventaTotal ?? 0) | number:'1.0-0' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>

    <p-dialog
      header="Detalle de visita"
      [(visible)]="showDetail"
      [modal]="true"
      [style]="{ width: '90vw', maxWidth: '700px' }"
      [draggable]="false"
      [resizable]="false"
    >
      <div *ngIf="selectedRow" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="p-3 bg-surface-layout rounded-xl">
            <div class="text-[10px] font-bold text-content-faint uppercase mb-1">Folio</div>
            <div class="font-bold">#{{ selectedRow.folio }}</div>
          </div>
          <div class="p-3 bg-surface-layout rounded-xl">
            <div class="text-[10px] font-bold text-content-faint uppercase mb-1">Score</div>
            <div class="font-bold"
              [ngClass]="{ 'text-green-600': visitScoreStatus(selectedRow) === 'ok', 'text-amber-500': visitScoreStatus(selectedRow) === 'warn', 'text-red-500': visitScoreStatus(selectedRow) === 'bad' }">
              {{ fmtScore(selectedRow.stats?.puntuacionTotal) }}
            </div>
          </div>
          <div class="p-3 bg-surface-layout rounded-xl">
            <div class="text-[10px] font-bold text-content-faint uppercase mb-1">Ejecutivo</div>
            <div class="font-medium">{{ selectedRow.captured_by_username }}</div>
          </div>
          <div class="p-3 bg-surface-layout rounded-xl">
            <div class="text-[10px] font-bold text-content-faint uppercase mb-1">Zona</div>
            <div class="font-medium uppercase">{{ selectedRow.zona_captura }}</div>
          </div>
          <div class="p-3 bg-surface-layout rounded-xl">
            <div class="text-[10px] font-bold text-content-faint uppercase mb-1">Fecha</div>
            <div class="font-medium">{{ selectedRow.fecha | date:'dd MMM yyyy':'UTC' }}</div>
          </div>
          <div class="p-3 bg-surface-layout rounded-xl">
            <div class="text-[10px] font-bold text-content-faint uppercase mb-1">GPS</div>
            <div class="font-medium">
              <span *ngIf="selectedRow.latitud" class="text-green-600">S\u00ed</span>
              <span *ngIf="!selectedRow.latitud" class="text-red-500">No</span>
            </div>
          </div>
        </div>

        <div *ngIf="selectedRow.exhibiciones?.length" class="p-3 bg-surface-layout rounded-xl">
          <div class="text-[10px] font-bold text-content-faint uppercase mb-2">Exhibiciones ({{ selectedRow.exhibiciones.length }})</div>
          <div class="overflow-x-auto">
            <table class="w-full text-xs border-collapse">
              <thead>
                <tr class="border-b border-divider text-content-faint text-[10px] uppercase">
                  <th class="py-1 pr-2 text-left">Formato</th>
                  <th class="py-1 pr-2 text-left">Nivel</th>
                  <th class="py-1 pr-2 text-left">Rango</th>
                  <th class="py-1 pr-2 text-left">Productos</th>
                  <th class="py-1 pr-2 text-right">Venta</th>
                  <th class="py-1 text-right">Puntos</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let ex of selectedRow.exhibiciones" class="border-b border-divider/50">
                  <td class="py-1 pr-2">{{ ex.formato || '-' }}</td>
                  <td class="py-1 pr-2">
                    <span [ngClass]="{ 'text-green-600': ex.nivel === 'optimo', 'text-amber-500': ex.nivel === 'regular', 'text-red-500': ex.nivel === 'critico' }" class="font-medium">
                      {{ ex.nivel || '-' }}
                    </span>
                  </td>
                  <td class="py-1 pr-2">{{ ex.rango || '-' }}</td>
                  <td class="py-1 pr-2">{{ ex.productos?.length ?? 0 }}</td>
                  <td class="py-1 pr-2 text-right">{{ (ex.ventaTotal ?? 0) | number:'1.0-0' }}</td>
                  <td class="py-1 text-right font-bold">{{ ex.puntos ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <p-button label="Cerrar" severity="secondary" (click)="closeDetail()" />
        </div>
      </div>
    </p-dialog>

    <p-dialog
      [(visible)]="showImagePreview"
      [modal]="true"
      [closable]="false"
      [style]="{ width: '90vw', maxWidth: '1200px', maxHeight: '90vh' }"
    >
      <div class="relative w-full h-full flex flex-col">
        <button (click)="closeImagePreview()" class="absolute top-4 right-4 z-10 bg-white/80 rounded-full w-8 h-8 flex items-center justify-center hover:bg-white transition-colors">
          <i class="pi pi-times text-xl"></i>
        </button>
        <img [src]="previewImageUrl" alt="Preview" class="w-full h-full object-contain max-h-[85vh]" (click)="closeImagePreview()" />
      </div>
    </p-dialog>

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
        <div class="flex gap-3 p-3 bg-surface-layout rounded-xl border border-divider text-xs text-content-muted">
          <i class="pi pi-info-circle mt-0.5 text-content-faint"></i>
          <span>Define dos umbrales por KPI. El dashboard y los reportes usar\u00e1n estos rangos para colorear el sem\u00e1foro autom\u00e1ticamente. Los cambios se guardan en el navegador.</span>
        </div>
        <div class="flex gap-4 flex-wrap text-[11px]">
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-red-200 inline-block"></span>
            <span class="text-red-700">Por debajo del m\u00ednimo</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-amber-200 inline-block"></span>
            <span class="text-amber-700">Entre m\u00ednimo y \u00f3ptimo</span>
          </span>
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded bg-green-200 inline-block"></span>
            <span class="text-green-700">\u00d3ptimo o superior</span>
          </span>
        </div>
        <div>
          <h4 class="text-xs font-black uppercase tracking-widest text-content-faint mb-3">KPIs de ejecuci\u00f3n</h4>
          <div class="space-y-4">
            <div *ngFor="let r of editableKpi" class="p-4 bg-surface-layout rounded-xl border border-divider">
              <div class="flex items-center justify-between mb-3">
                <span class="font-bold text-sm">{{ r.label }}</span>
                <div class="flex gap-2 text-[10px]">
                  <span class="px-2 py-0.5 rounded-full bg-red-100 text-red-700">&lt; {{ r.min }}{{ r.unit }} = bajo</span>
                  <span class="px-2 py-0.5 rounded-full bg-green-100 text-green-700">\u2265 {{ r.opt }}{{ r.unit }} = \u00f3ptimo</span>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div class="flex flex-col gap-1">
                  <label class="text-[10px] font-bold text-content-faint uppercase">Meta m\u00ednima</label>
                  <p-inputNumber [(ngModel)]="r.min" [min]="0" [max]="r.opt - 1" [showButtons]="true" buttonLayout="horizontal" decrementButtonClass="p-button-secondary" incrementButtonClass="p-button-secondary" [suffix]="r.unit ? ' ' + r.unit : ''" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-[10px] font-bold text-content-faint uppercase">Meta \u00f3ptima</label>
                  <p-inputNumber [(ngModel)]="r.opt" [min]="r.min + 1" [showButtons]="true" buttonLayout="horizontal" decrementButtonClass="p-button-secondary" incrementButtonClass="p-button-secondary" [suffix]="r.unit ? ' ' + r.unit : ''" class="w-full" />
                </div>
              </div>
              <div class="mt-3 h-2 rounded-full overflow-hidden flex">
                <div class="bg-red-300" [style.flex]="r.min"></div>
                <div class="bg-amber-300" [style.flex]="r.opt - r.min"></div>
                <div class="bg-green-300" [style.flex]="r.opt * 0.5"></div>
              </div>
            </div>
          </div>
        </div>
        <div *ngIf="editableFurniture.length > 0">
          <h4 class="text-xs font-black uppercase tracking-widest text-content-faint mb-3">Mobiliario</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div *ngFor="let f of editableFurniture" class="flex items-center justify-between p-3 bg-surface-layout rounded-xl border border-divider gap-3">
              <div class="flex items-center gap-2">
                <i [class]="f.icon" class="text-content-muted w-5 text-center"></i>
                <span class="font-medium text-sm">{{ f.label }}</span>
              </div>
              <div class="w-28">
                <p-inputNumber [(ngModel)]="f.target" [min]="0" [showButtons]="true" buttonLayout="horizontal" decrementButtonClass="p-button-secondary" incrementButtonClass="p-button-secondary" class="w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <ng-template pTemplate="footer">
        <div class="flex justify-end gap-3">
          <p-button label="Cancelar" icon="pi pi-times" severity="secondary" (click)="cancelMetas()" />
          <p-button label="Guardar metas" icon="pi pi-check" styleClass="p-button-brand" (click)="saveMetas()" />
        </div>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host ::ng-deep .p-chart { height: 100% !important; }
  `],
})
export class SeguimientoComponent implements OnInit, OnDestroy {
  private service = inject(SeguimientoService);
  private reportsService = inject(ReportsService);
  private auth = inject(AuthService);
  private perms = inject(PermissionsService);
  private metasConfig = inject(MetasConfigService);
  private messageService = inject(MessageService);
  readonly filtersState = inject(FiltersStateService);

  loading = signal(false);
  chartData: any = null;
  chartOptions: any = null;
  lastUpdate = '\u2014';
  todayStr = '';
  enMeta = signal(0);
  totalUsers = signal(0);
  isSuperAdmin = computed(() => this.auth.user()?.permissions?.[Permission.REPORTES_VER_GLOBAL] === true);

  canEditMetas = this.perms.can$('manage', 'kpi_goals');

  scoreOpt = 80;
  scoreMin = 50;

  showMetasDialog = false;
  editableKpi: KpiRange[] = [];
  editableFurniture: { id: string; label: string; icon: string; target: number }[] = [];

  loadingVisitas = signal(false);
  reportsData = signal<ReportsData | null>(null);
  searchText = '';
  showComparison = false;
  showDetail = false;
  selectedRow: any = null;
  showImagePreview = false;
  previewImageUrl = '';

  allVisits = computed(() =>
    (this.reportsData()?.rows ?? []).map((v: any) => ({ ...v, _selected: false })),
  );

  filteredVisits = computed(() => {
    const q = this.searchText.toLowerCase().trim();
    if (!q) return this.allVisits();
    return this.allVisits().filter(
      (v) =>
        (v.folio?.toLowerCase().includes(q) ?? false) ||
        (v.captured_by_username?.toLowerCase().includes(q) ?? false) ||
        (v.zona_captura?.toLowerCase().includes(q) ?? false),
    );
  });

  selectedVisits = computed(() => this.allVisits().filter((v) => v._selected));
  selectedVisitsCount = computed(() => this.selectedVisits().length);

  private pollingSub?: Subscription;

  ngOnInit(): void {
    this.loadData();
    this.loadVisits();
    this.pollingSub = interval(30000).subscribe(() => {
      this.loadData();
      this.loadVisits();
    });
  }

  ngOnDestroy(): void {
    this.pollingSub?.unsubscribe();
  }

  refreshAll(): void {
    this.searchText = '';
    this.showComparison = false;
    this.loadData();
    this.loadVisits();
  }

  onVisitsFilterChange(): void {
    this.searchText = '';
    this.showComparison = false;
    this.loadData();
    this.loadVisits();
  }

  loadData(): void {
    this.loading.set(true);
    const f = this.filtersState.filters();

    const params: any = { startDate: f.startDate, endDate: f.endDate };
    if (f.zone) params.zone = f.zone;
    if (f.supervisorId) params.supervisorId = f.supervisorId;
    this.service.getDailyScores(params).subscribe({
      next: (res) => {
        this.buildChart(res);
        this.lastUpdate = '\u00dalt. act. ' + new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  loadVisits(): void {
    this.loadingVisitas.set(true);
    const f = this.filtersState.filters();
    const filters: any = {
      startDate: f.startDate,
      endDate: f.endDate,
    };
    if (f.zone) filters.zone = f.zone;
    if (f.supervisorId) filters.supervisorId = f.supervisorId;
    if (f.sellerIds?.length) filters.sellerIds = f.sellerIds;
    this.reportsService.getReportsData(filters).subscribe({
      next: (data) => {
        this.reportsData.set(data);
        this.loadingVisitas.set(false);
      },
      error: () => this.loadingVisitas.set(false),
    });
  }

  private scoreStatus(val: number): 'ok' | 'warn' | 'bad' {
    if (val >= this.scoreOpt) return 'ok';
    if (val >= this.scoreMin) return 'warn';
    return 'bad';
  }

  visitScoreStatus(visit: any): 'ok' | 'warn' | 'bad' {
    return this.metasConfig.statusFor('score', visit.stats?.puntuacionTotal ?? 0);
  }

  fmtScore(v: any): string {
    return v != null ? Math.round(v) + ' pts' : '';
  }

  private buildChart(res: DailyScoresResponse): void {
    const avg = (scores: { puntuacion: number }[]) =>
      scores.length > 0 ? Math.round(scores.reduce((s, x) => s + x.puntuacion, 0) / scores.length) : 0;
    const range = this.metasConfig.getRange('score');
    this.scoreOpt = range?.opt ?? 80;
    this.scoreMin = range?.min ?? 50;

    if (!res.users?.length) {
      this.chartData = null;
      return;
    }

    const users = res.users
      .map((u) => {
        const score = avg(u.scores);
        return { nombre: u.nombre, score };
      })
      .filter((u) => u.score > 0)
      .sort((a, b) => b.score - a.score);

    this.totalUsers.set(users.length);
    this.enMeta.set(users.filter(u => u.score >= this.scoreOpt).length);

    if (!users.length) {
      this.chartData = null;
      return;
    }

    const barColors = users.map((u) => {
      const s = this.scoreStatus(u.score);
      return s === 'ok' ? '#22c55e' : s === 'warn' ? '#f59e0b' : '#ef4444';
    });

    this.chartData = {
      labels: users.map((u) => u.nombre),
      datasets: [{
        data: users.map((u) => u.score),
        backgroundColor: barColors,
        borderRadius: 4,
      }],
    };

    this.chartOptions = {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        annotation: {
          annotations: {
            goalLine: {
              type: 'line',
              xMin: this.scoreOpt,
              xMax: this.scoreOpt,
              borderColor: '#f59e0b',
              borderWidth: 2,
              borderDash: [6, 3],
              label: {
                display: true,
                content: 'Meta ' + this.scoreOpt + ' pts',
                position: 'start',
                backgroundColor: 'rgba(245,158,11,0.15)',
                color: '#92400e',
                font: { weight: 'bold', size: 11 },
              },
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          max: 110,
          title: { display: true, text: 'Puntuaci\u00f3n', color: '#6b7280' },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y: {
          title: { display: true, text: 'Ejecutivo', color: '#6b7280' },
          grid: { display: false },
        },
      },
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
    const base = (this.reportsService as any).apiUrl?.replace('/reports', '') ?? '';
    return `${base}${url}`;
  }

  openMetasDialog(): void {
    this.editableKpi = this.metasConfig.kpiRanges().filter((r) => r.id === 'score').map((r) => ({ ...r }));
    this.editableFurniture = [];
    this.showMetasDialog = true;
  }

  saveMetas(): void {
    this.editableKpi.forEach((r) => this.metasConfig.updateKpiRange(r.id, r.min, r.opt));
    this.editableFurniture.forEach((f) => this.metasConfig.updateFurnitureTarget(f.id, f.target));
    this.showMetasDialog = false;
    this.loadData();
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
