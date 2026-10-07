import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { FiltersStateService } from '../../reports/graphics/filters-state.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';
import {
  HorusStatus,
  SeguimientoService,
  VendorAgg,
  VendorReviewResponse,
  VendorVisit,
  VisitDetail,
} from '../seguimiento.service';

interface StatusMeta {
  key: HorusStatus | 'all';
  label: string;
  cls: string;
  icon: string;
}

/**
 * Reporte por vendedor con revisión Horus (Operations surface).
 *
 * Master-detail: lista de vendedores (izquierda) → visitas del vendedor
 * seleccionado (derecha) con su calificación y el estado de revisión de Horus
 * (valida / requiere_supervision / fraude / confirmada / descartada / no_revisada).
 * El fetch es único por cambio de filtro; la selección de vendedor y el filtro
 * por estado son client-side para interacciones instantáneas.
 */
@Component({
  selector: 'app-vendor-review',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DatePickerModule, DialogModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
      .hbadge {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.1rem 0.5rem;
        border-radius: 9999px;
        font-size: 0.68rem;
        font-weight: 600;
        white-space: nowrap;
        border: 1px solid transparent;
      }
      .h-valida {
        background: color-mix(in srgb, var(--p-green-500, #16a34a) 14%, transparent);
        color: var(--p-green-600, #15803d);
        border-color: color-mix(in srgb, var(--p-green-500, #16a34a) 30%, transparent);
      }
      .h-requiere_supervision {
        background: color-mix(in srgb, #d97706 15%, transparent);
        color: #b45309;
        border-color: color-mix(in srgb, #d97706 32%, transparent);
      }
      .h-fraude {
        background: color-mix(in srgb, #dc2626 15%, transparent);
        color: #b91c1c;
        border-color: color-mix(in srgb, #dc2626 34%, transparent);
      }
      .h-confirmada {
        background: color-mix(in srgb, #dc2626 10%, transparent);
        color: #b91c1c;
        border-color: color-mix(in srgb, #dc2626 40%, transparent);
      }
      .h-descartada {
        background: color-mix(in srgb, var(--content-faint, #94a3b8) 14%, transparent);
        color: var(--content-muted, #64748b);
        border-color: color-mix(in srgb, var(--content-faint, #94a3b8) 30%, transparent);
      }
      .h-no_revisada {
        background: color-mix(in srgb, var(--content-faint, #94a3b8) 10%, transparent);
        color: var(--content-faint, #94a3b8);
        border-color: color-mix(in srgb, var(--content-faint, #94a3b8) 24%, transparent);
      }
      .vrow:hover {
        background: var(--surface-hover, rgba(0, 0, 0, 0.03));
      }
      :host ::ng-deep .dark .vrow:hover {
        background: rgba(255, 255, 255, 0.03);
      }
    `,
  ],
  template: `
    <p-toast />
    <div class="space-y-4">
      <!-- Barra de acciones -->
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-wrap">
          <!-- Filtro por rango de fechas (comparte estado con los filtros globales). -->
          <div class="flex items-center gap-1.5">
            <i class="pi pi-calendar text-content-faint text-sm" aria-hidden="true"></i>
            <p-datepicker
              [(ngModel)]="dateRange"
              selectionMode="range"
              [readonlyInput]="true"
              [showButtonBar]="true"
              [maxDate]="today"
              dateFormat="dd/mm/yy"
              placeholder="Rango de fechas"
              (onSelect)="onDateChange()"
              (onClear)="onDateClear()"
              styleClass="p-input-sm"
            />
            <div class="inline-flex rounded-md border border-divider overflow-hidden">
              @for (p of quickRanges; track p.days) {
                <button
                  type="button"
                  class="px-2 py-1 text-[11px] font-semibold motion-safe:transition-colors text-content-muted hover:text-content-main hover:bg-surface-active"
                  (click)="applyQuickRange(p.days)"
                >{{ p.label }}</button>
              }
            </div>
          </div>
          <span class="text-sm text-content-muted">
            @if (loading()) {
              <i class="pi pi-spin pi-spinner mr-1" aria-hidden="true"></i> Cargando…
            } @else {
              <span class="font-semibold text-content-main">{{ data()?.by_vendor?.length || 0 }}</span>
              vendedores ·
              <span class="font-semibold text-content-main">{{ data()?.visits?.length || 0 }}</span>
              visitas
            }
          </span>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <p-button
            icon="pi pi-refresh"
            label="Actualizar"
            severity="secondary"
            [outlined]="true"
            size="small"
            (onClick)="reload()"
            [disabled]="loading()"
          />
          @if (canAnalyzeHorus()) {
            <p-button
              icon="pi pi-sparkles"
              label="Analizar con Horus"
              styleClass="p-button-brand"
              size="small"
              (onClick)="analyzeHorus()"
              [disabled]="analyzing() || loading()"
              [loading]="analyzing()"
            />
          }
          <p-button
            icon="pi pi-file-pdf"
            label="PDF"
            severity="secondary"
            [outlined]="true"
            size="small"
            (onClick)="downloadPdf()"
            [disabled]="loading() || downloadingPdf() || (data()?.by_vendor?.length || 0) === 0"
            [loading]="downloadingPdf()"
          />
          <p-button
            icon="pi pi-download"
            label="Exportar CSV"
            severity="secondary"
            [outlined]="true"
            size="small"
            (onClick)="exportCsv()"
            [disabled]="!selectedVendor() || detailVisits().length === 0"
          />
        </div>
      </div>

      @if (data() && !data()!.horus_available) {
        <div class="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-divider bg-surface-layout text-sm text-content-muted">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Horus no está disponible en este entorno — las visitas se muestran sin estado de revisión.
        </div>
      }

      <div class="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        <!-- Master: lista de vendedores -->
        <div class="card-premium card-flat p-0 overflow-hidden self-start">
          <div class="px-4 py-2.5 border-b border-divider text-xs font-semibold uppercase tracking-wider text-content-faint">
            Vendedores
          </div>
          <div class="max-h-[70vh] overflow-y-auto">
            @if (!loading() && (data()?.by_vendor?.length || 0) === 0) {
              <div class="px-4 py-6 text-sm text-content-faint text-center">Sin visitas en el rango.</div>
            }
            @for (v of vendors(); track v.user_id) {
              <button
                type="button"
                class="w-full text-left px-4 py-3 border-b border-divider/60 motion-safe:transition-colors vrow"
                [class.bg-surface-active]="selectedVendorId() === v.user_id"
                (click)="selectVendor(v.user_id)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="font-semibold text-sm text-content-main truncate">{{ v.nombre }}</span>
                  @if (v.avg_score !== null) {
                    <span class="text-xs font-bold text-content-main shrink-0">{{ v.avg_score }} pts</span>
                  }
                </div>
                <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span class="text-[11px] text-content-faint">{{ v.total_visitas }} visitas</span>
                  @if (v.sin_visitas) {
                    <span class="hbadge h-requiere_supervision">
                      <i class="pi pi-ban text-[9px]" aria-hidden="true"></i> sin visitas
                    </span>
                  }
                  @if (v.por_supervisar > 0) {
                    <span class="hbadge h-requiere_supervision">
                      <i class="pi pi-flag text-[9px]" aria-hidden="true"></i> {{ v.por_supervisar }} a revisar
                    </span>
                  }
                  @if (v.fraud_flag) {
                    <span class="hbadge h-fraude">
                      <i class="pi pi-exclamation-triangle text-[9px]" aria-hidden="true"></i> fraude
                    </span>
                  }
                </div>
              </button>
            }
          </div>
        </div>

        <!-- Detail: visitas del vendedor -->
        <div class="card-premium card-flat p-0 overflow-hidden">
          @if (!selectedVendor()) {
            <div class="px-4 py-10 text-center text-sm text-content-faint">
              Seleccioná un vendedor para ver sus visitas.
            </div>
          } @else {
            <!-- Cabecera del vendedor + filtros por estado -->
            <div class="px-4 py-3 border-b border-divider">
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div class="font-bold text-content-main">{{ selectedVendor()!.nombre }}</div>
                  <div class="text-xs text-content-faint">
                    {{ selectedVendor()!.total_visitas }} visitas ·
                    {{ selectedVendor()!.pct_validas }}% válidas ·
                    {{ selectedVendor()!.avg_score ?? '—' }} pts prom
                  </div>
                </div>
                <p-button
                  icon="pi pi-file-pdf"
                  label="Reporte individual"
                  severity="secondary"
                  [outlined]="true"
                  size="small"
                  (onClick)="downloadIndividual()"
                  [disabled]="downloadingIndividual()"
                  [loading]="downloadingIndividual()"
                />
              </div>
              <div class="flex items-center gap-1.5 mt-3 flex-wrap">
                @for (s of statusChips(); track s.key) {
                  <button
                    type="button"
                    class="hbadge motion-safe:transition-all"
                    [class]="'hbadge ' + (s.key === 'all' ? '' : s.cls)"
                    [class.ring-2]="statusFilter() === s.key"
                    [class.ring-offset-1]="statusFilter() === s.key"
                    [style.opacity]="statusFilter() === s.key || statusFilter() === 'all' ? '1' : '0.55'"
                    (click)="setStatusFilter(s.key)"
                  >
                    <i class="pi {{ s.icon }} text-[9px]" aria-hidden="true"></i>
                    {{ s.label }} ({{ countFor(s.key) }})
                  </button>
                }
              </div>
            </div>

            <!-- Tabla densa de visitas -->
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-[11px] uppercase tracking-wider text-content-faint border-b border-divider">
                    <th class="text-left font-semibold px-3 py-2">Folio</th>
                    <th class="text-left font-semibold px-3 py-2">Fecha</th>
                    <th class="text-left font-semibold px-3 py-2">Tienda / Zona</th>
                    <th class="text-right font-semibold px-3 py-2">Score</th>
                    <th class="text-left font-semibold px-3 py-2">Revisión Horus</th>
                    <th class="text-right font-semibold px-3 py-2">Evidencia</th>
                  </tr>
                </thead>
                <tbody>
                  @for (v of detailVisits(); track v.id) {
                    <tr
                      class="border-b border-divider/60 vrow motion-safe:transition-colors cursor-pointer"
                      (click)="openVisit(v)"
                      title="Ver detalle de la visita"
                    >
                      <td class="px-3 py-2 font-mono text-xs text-content-main">{{ v.folio }}</td>
                      <td class="px-3 py-2 text-content-muted whitespace-nowrap">{{ v.fecha }}</td>
                      <td class="px-3 py-2">
                        <div class="text-content-main truncate max-w-[220px]">{{ v.store_name || v.zona || '—' }}</div>
                        @if (v.store_name && v.zona) {
                          <div class="text-[11px] text-content-faint truncate max-w-[220px]">{{ v.zona }}</div>
                        }
                      </td>
                      <td class="px-3 py-2 text-right">
                        @if (v.skip_scoring) {
                          <span class="text-[11px] text-content-faint">vendedor</span>
                        } @else {
                          <span class="font-bold text-content-main">{{ v.score ?? '—' }}</span>
                        }
                      </td>
                      <td class="px-3 py-2">
                        <span class="hbadge" [class]="'hbadge h-' + v.horus_status">
                          <i class="pi {{ metaFor(v.horus_status).icon }} text-[9px]" aria-hidden="true"></i>
                          {{ metaFor(v.horus_status).label }}
                        </span>
                      </td>
                      <td class="px-3 py-2 text-right text-[11px] text-content-faint whitespace-nowrap">
                        @if (v.photos_total > 0) {
                          <span>{{ v.photos_analyzed }}/{{ v.photos_total }} fotos</span>
                        }
                        @if (v.flags > 0) {
                          <span class="text-amber-600 font-semibold ml-1">· {{ v.flags }} flags</span>
                        }
                        @if (v.open_findings > 0) {
                          <span class="ml-1">· {{ v.open_findings }} hallazgos</span>
                        }
                      </td>
                    </tr>
                  }
                  @if (detailVisits().length === 0) {
                    <tr>
                      <td colspan="6" class="px-3 py-8 text-center text-content-faint text-sm">
                        @if (selectedVendor()?.sin_visitas) {
                          <i class="pi pi-ban mr-1" aria-hidden="true"></i>
                          Este vendedor no registró visitas en el rango seleccionado.
                        } @else {
                          Sin visitas para este filtro.
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </div>

      <!-- Diálogo de detalle de visita -->
      <p-dialog
        [visible]="showDetail()"
        (visibleChange)="showDetail.set($event)"
        [modal]="true"
        [dismissableMask]="true"
        [style]="{ width: '760px', maxWidth: '96vw' }"
        [header]="detail()?.folio || 'Visita'"
      >
        @if (detailLoading()) {
          <div class="py-10 text-center text-content-faint">
            <i class="pi pi-spin pi-spinner text-2xl" aria-hidden="true"></i>
          </div>
        } @else if (detail(); as d) {
          <!-- Cabecera -->
          <div class="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div>
              <div class="font-bold text-content-main">{{ d.store_name || d.zona || '—' }}</div>
              <div class="text-xs text-content-faint">
                {{ d.vendedor }} · {{ d.fecha }} @if (d.zona && d.store_name) { · {{ d.zona }} }
              </div>
            </div>
            <span class="hbadge" [class]="'hbadge h-' + selectedVisitStatus()">
              <i class="pi {{ metaFor(selectedVisitStatus()).icon }} text-[9px]" aria-hidden="true"></i>
              {{ metaFor(selectedVisitStatus()).label }}
            </span>
          </div>

          <!-- KPIs de la visita -->
          <div class="grid grid-cols-3 gap-2 mb-4">
            <div class="border border-divider rounded-lg px-3 py-2">
              <div class="text-[9px] uppercase tracking-wider text-content-faint font-bold">Score</div>
              <div class="text-lg font-extrabold text-content-main">
                {{ d.skip_scoring ? '—' : (d.score ?? '—') }}
                @if (d.score_pct !== null) { <span class="text-xs text-content-faint">({{ d.score_pct }}%)</span> }
              </div>
            </div>
            <div class="border border-divider rounded-lg px-3 py-2">
              <div class="text-[9px] uppercase tracking-wider text-content-faint font-bold">Venta total</div>
              <div class="text-lg font-extrabold text-content-main">{{ money(d.venta_total) }}</div>
            </div>
            <div class="border border-divider rounded-lg px-3 py-2">
              <div class="text-[9px] uppercase tracking-wider text-content-faint font-bold">Exhibiciones</div>
              <div class="text-lg font-extrabold text-content-main">{{ d.total_exhibiciones }}</div>
            </div>
          </div>

          <!-- Exhibiciones con foto + veredicto Horus -->
          <div class="text-xs font-semibold uppercase tracking-wider text-content-faint mb-2">Exhibiciones</div>
          @if (d.exhibiciones.length === 0) {
            <div class="text-sm text-content-faint py-3 text-center">Sin exhibiciones registradas.</div>
          }
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            @for (e of d.exhibiciones; track e.idx) {
              <div class="border border-divider rounded-lg overflow-hidden">
                @if (e.foto_url) {
                  <img [src]="e.foto_url" alt="Foto exhibición" loading="lazy"
                       class="w-full h-40 object-cover bg-surface-layout" />
                } @else {
                  <div class="w-full h-40 flex items-center justify-center bg-surface-layout text-content-faint">
                    <i class="pi pi-image text-2xl" aria-hidden="true"></i>
                  </div>
                }
                <div class="p-2.5 space-y-1.5">
                  <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="text-content-muted">{{ e.productos }} productos · {{ e.puntos }} pts</span>
                    <span class="font-semibold text-content-main">{{ money(e.venta_total) }}</span>
                  </div>
                  @if (e.pertenece_mega !== null) {
                    <span class="hbadge" [class]="e.pertenece_mega ? 'hbadge h-valida' : 'hbadge h-descartada'">
                      {{ e.pertenece_mega ? 'Mega Dulces' : 'Competencia' }}
                    </span>
                  }
                  @if (visionFor(e.idx); as vz) {
                    <div class="flex flex-wrap gap-1 pt-1">
                      @if (vz.mismatch) { <span class="hbadge h-fraude">mismatch</span> }
                      @if (vz.out_of_stock) { <span class="hbadge h-requiere_supervision">quiebre</span> }
                      @if (vz.is_shelf === false) { <span class="hbadge h-requiere_supervision">no anaquel</span> }
                      @if (vz.is_shelf && !vz.mismatch && !vz.out_of_stock) { <span class="hbadge h-valida">anaquel ok</span> }
                      @if (vz.photo_quality) { <span class="hbadge h-no_revisada">{{ vz.photo_quality }}</span> }
                    </div>
                  } @else {
                    <div class="text-[11px] text-content-faint pt-0.5">Horus no analizó esta foto.</div>
                  }
                </div>
              </div>
            }
          </div>
        } @else {
          <div class="py-8 text-center text-content-faint text-sm">No se pudo cargar el detalle.</div>
        }
      </p-dialog>
    </div>
  `,
})
export class VendorReviewComponent {
  private service = inject(SeguimientoService);
  private filtersState = inject(FiltersStateService);
  private perms = inject(PermissionsService);
  private auth = inject(AuthService);
  private messageService = inject(MessageService);
  private destroyRef = inject(DestroyRef);

  loading = signal(false);
  analyzing = signal(false);
  downloadingPdf = signal(false);
  downloadingIndividual = signal(false);
  data = signal<VendorReviewResponse | null>(null);
  selectedVendorId = signal<string | null>(null);
  statusFilter = signal<HorusStatus | 'all'>('all');

  // Diálogo de detalle de visita.
  showDetail = signal(false);
  detailLoading = signal(false);
  detail = signal<VisitDetail | null>(null);
  private selectedVisit = signal<VendorVisit | null>(null);

  /** Rango de fechas del picker (bound al estado global de filtros). */
  dateRange: Date[] = [];
  readonly today = new Date();
  readonly quickRanges = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
  ];

  private static readonly STATUS_META: StatusMeta[] = [
    { key: 'valida', label: 'Válidas', cls: 'h-valida', icon: 'pi-check-circle' },
    { key: 'requiere_supervision', label: 'A supervisar', cls: 'h-requiere_supervision', icon: 'pi-flag' },
    { key: 'fraude', label: 'Fraude', cls: 'h-fraude', icon: 'pi-exclamation-triangle' },
    { key: 'confirmada', label: 'Confirmadas', cls: 'h-confirmada', icon: 'pi-verified' },
    { key: 'descartada', label: 'Descartadas', cls: 'h-descartada', icon: 'pi-minus-circle' },
    { key: 'no_revisada', label: 'No revisadas', cls: 'h-no_revisada', icon: 'pi-clock' },
  ];

  vendors = computed(() => this.data()?.by_vendor ?? []);

  selectedVendor = computed<VendorAgg | null>(() => {
    const id = this.selectedVendorId();
    return this.vendors().find((v) => v.user_id === id) ?? null;
  });

  private vendorVisits = computed<VendorVisit[]>(() => {
    const id = this.selectedVendorId();
    if (!id) return [];
    return (this.data()?.visits ?? []).filter((v) => v.user_id === id);
  });

  detailVisits = computed<VendorVisit[]>(() => {
    const f = this.statusFilter();
    const rows = this.vendorVisits();
    return f === 'all' ? rows : rows.filter((v) => v.horus_status === f);
  });

  statusChips = computed<StatusMeta[]>(() => [
    { key: 'all', label: 'Todas', cls: '', icon: 'pi-list' },
    ...VendorReviewComponent.STATUS_META,
  ]);

  canAnalyzeHorus = computed(() => {
    const p = this.auth.user()?.permissions;
    return this.perms.isAdmin() || (p ? p[Permission.SUPERVISOR_AI_VER] === true : false);
  });

  constructor() {
    // Inicializa el picker desde el rango actual del estado global.
    const f = this.filtersState.filters();
    const start = this.parseYmd(f.startDate);
    const end = this.parseYmd(f.endDate);
    if (start && end) this.dateRange = [start, end];

    // Re-fetch cuando cambian los filtros globales (dates/zone/supervisor).
    effect(() => {
      this.filtersState.filtersDebounced();
      this.reload();
    });
  }

  /** 'YYYY-MM-DD' → Date local (evita el shift de día de new Date(str) en UTC). */
  private parseYmd(s?: string): Date | null {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  onDateChange(): void {
    if (this.dateRange?.[0] && this.dateRange?.[1]) {
      this.filtersState.setDateRange(this.dateRange[0], this.dateRange[1]);
    }
  }

  onDateClear(): void {
    this.dateRange = [];
    // Vuelve al preset por defecto (última semana) del estado global.
    this.filtersState.setPeriod('semanal');
    const f = this.filtersState.filters();
    const start = this.parseYmd(f.startDate);
    const end = this.parseYmd(f.endDate);
    if (start && end) this.dateRange = [start, end];
  }

  applyQuickRange(days: number): void {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    this.dateRange = [start, end];
    this.filtersState.setDateRange(start, end);
  }

  metaFor(status: HorusStatus): StatusMeta {
    return (
      VendorReviewComponent.STATUS_META.find((m) => m.key === status) ??
      VendorReviewComponent.STATUS_META[5]
    );
  }

  countFor(key: HorusStatus | 'all'): number {
    const rows = this.vendorVisits();
    if (key === 'all') return rows.length;
    return rows.filter((v) => v.horus_status === key).length;
  }

  setStatusFilter(key: HorusStatus | 'all'): void {
    this.statusFilter.set(key);
  }

  selectVendor(id: string): void {
    this.selectedVendorId.set(id);
    this.statusFilter.set('all');
  }

  reload(): void {
    const f = this.filtersState.filters();
    this.loading.set(true);
    this.service
      .getVendorVisitsReview({
        startDate: f.startDate,
        endDate: f.endDate,
        zone: f.zone ?? undefined,
        supervisorId: f.supervisorId ?? undefined,
        // Si el filtro global tiene un vendedor elegido, arrancamos en él.
        userId: f.sellerIds?.length ? f.sellerIds[0] : undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res);
          // Mantener selección si sigue existiendo; si no, primer vendedor.
          const cur = this.selectedVendorId();
          const stillThere = res.by_vendor.some((v) => v.user_id === cur);
          if (!stillThere) {
            const pick =
              (f.sellerIds?.length && res.by_vendor.find((v) => v.user_id === f.sellerIds[0])) ||
              res.by_vendor[0];
            this.selectedVendorId.set(pick ? pick.user_id : null);
          }
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudo cargar el reporte por vendedor.',
          });
        },
      });
  }

  analyzeHorus(): void {
    this.analyzing.set(true);
    this.service
      .scanHorusVision(24)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res: any) => {
          this.analyzing.set(false);
          const scan = res?.scan || {};
          const analyzed = Number(scan.analyzed || 0);
          let severity: 'success' | 'info' | 'warn' = 'success';
          let detail: string;
          if (scan.reason === 'no_api_key') {
            severity = 'warn';
            detail = 'El servidor no tiene ANTHROPIC_API_KEY configurada — Horus no puede analizar fotos.';
          } else if (scan.reason === 'no_tenant') {
            severity = 'warn';
            detail = 'No se pudo resolver el tenant de tu sesión.';
          } else if (analyzed > 0) {
            detail = `Horus analizó ${analyzed} foto(s). Actualizando estados…`;
          } else if (Number(scan.candidates || 0) === 0) {
            severity = 'info';
            detail = 'No hay fotos en el rango para analizar.';
          } else {
            severity = 'info';
            detail = 'Todas las fotos del rango ya estaban analizadas.';
          }
          this.messageService.add({ severity, summary: 'Horus', detail });
          this.reload();
        },
        error: () => {
          this.analyzing.set(false);
          this.messageService.add({
            severity: 'warn',
            summary: 'Horus',
            detail: 'No se pudo disparar el análisis (¿sin permiso SUPERVISOR_AI_VER o tablas faltantes?).',
          });
        },
      });
  }

  downloadPdf(): void {
    const f = this.filtersState.filters();
    this.downloadingPdf.set(true);
    this.service
      .downloadVendorReviewPdf({
        startDate: f.startDate,
        endDate: f.endDate,
        zone: f.zone ?? undefined,
        supervisorId: f.supervisorId ?? undefined,
        focusUserId: this.selectedVendorId() ?? undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => {
          this.downloadingPdf.set(false);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'reporte_visitas_horus.pdf';
          a.click();
          URL.revokeObjectURL(url);
        },
        error: () => {
          this.downloadingPdf.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'PDF',
            detail: 'No se pudo generar el PDF.',
          });
        },
      });
  }

  openVisit(v: VendorVisit): void {
    this.selectedVisit.set(v);
    this.detail.set(null);
    this.detailLoading.set(true);
    this.showDetail.set(true);
    this.service
      .getVisitDetail(v.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.detail.set(d);
          this.detailLoading.set(false);
        },
        error: () => {
          this.detailLoading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Detalle',
            detail: 'No se pudo cargar el detalle de la visita.',
          });
        },
      });
  }

  selectedVisitStatus(): HorusStatus {
    return this.selectedVisit()?.horus_status ?? 'no_revisada';
  }

  visionFor(idx: number) {
    return (this.detail()?.vision ?? []).find((v) => v.exhibition_idx === idx) ?? null;
  }

  money(n: number | null | undefined): string {
    return Number(n || 0).toLocaleString('es-MX', {
      style: 'currency',
      currency: 'MXN',
    });
  }

  downloadIndividual(): void {
    const vendor = this.selectedVendor();
    if (!vendor) return;
    const f = this.filtersState.filters();
    this.downloadingIndividual.set(true);
    this.service
      .downloadVendorReviewPdf({
        startDate: f.startDate,
        endDate: f.endDate,
        zone: f.zone ?? undefined,
        supervisorId: f.supervisorId ?? undefined,
        focusUserId: vendor.user_id,
        individual: 'true',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => {
          this.downloadingIndividual.set(false);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `reporte_${vendor.nombre.replace(/\s+/g, '_')}.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        },
        error: () => {
          this.downloadingIndividual.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'PDF',
            detail: 'No se pudo generar el reporte individual.',
          });
        },
      });
  }

  exportCsv(): void {
    const vendor = this.selectedVendor();
    const rows = this.detailVisits();
    if (!vendor || rows.length === 0) return;
    const header = ['folio', 'fecha', 'tienda', 'zona', 'score', 'estado_horus', 'fotos_analizadas', 'fotos_total', 'flags', 'hallazgos_abiertos'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((v) =>
      [v.folio, v.fecha, v.store_name, v.zona, v.skip_scoring ? '' : v.score, v.horus_status, v.photos_analyzed, v.photos_total, v.flags, v.open_findings]
        .map(esc)
        .join(','),
    );
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `horus_${vendor.nombre.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
