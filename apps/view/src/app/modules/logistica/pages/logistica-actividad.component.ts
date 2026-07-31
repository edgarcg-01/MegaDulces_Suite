import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import {
  LogisticaService,
  FleetProductivityRow,
  VehicleStop,
} from '../logistica.service';
import { todayMx } from '../../../core/utils/mx-date';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

/**
 * LTV.0 + LTV.5 — Actividad de flota del día. Sobre los viajes reconstruidos
 * (vehicle_day_summary + vehicle_stops) muestra por vehículo: km, tiempos
 * (movimiento/detenido/muerto/offline), paradas productivas vs muertas y
 * km por entrega. Drill a las paradas del vehículo (timeline con cliente
 * matcheado). Botón para reconstruir el día si el cron nocturno aún no corrió.
 *
 * Operations/DESIGN: KPIs = MetricStrip (ADR-033, flota route lleva composición
 * captura vs sin captura); tabla = p-table densa con header sticky + 1ª columna
 * congelada + selección por teclado + skeleton; fecha + unidad viven en la URL.
 */
@Component({
  selector: 'app-logistica-actividad',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TooltipModule, SkeletonModule, MetricStripComponent, ContextHelpComponent],
  template: `
    <div class="surf-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <span class="rk-eyebrow"><i class="pi pi-chart-bar" aria-hidden="true"></i> {{ fleet === 'route' ? 'Auditoría en Ruta' : 'Logística' }}</span>
          <h1>{{ fleet === 'route' ? 'Actividad de ruta' : 'Actividad de flota' }}</h1>
          <p class="surf-page-sub">
            {{ rows().length }} unidad{{ rows().length === 1 ? '' : 'es' }} con actividad
            <span class="rk-muted">· productividad y tiempos muertos del día</span>
          </p>
        </div>
        <div class="rk-actions">
          <input type="date" class="rk-date" [ngModel]="date()" (ngModelChange)="setDate($event)"
            [max]="today" aria-label="Fecha de actividad" />
          <button pButton severity="secondary" size="small" [text]="true" [loading]="rebuilding()" (click)="rebuild()" pTooltip="Recalcula paradas y resumen desde el rastro GPS (por si el proceso nocturno aún no corrió)"><span class="p-button-icon p-button-icon-left pi pi-cog" aria-hidden="true"></span><span class="p-button-label">Reconstruir día</span></button>
          <button pButton [text]="true" size="small" [loading]="loading()" (click)="refresh()" aria-label="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
          <app-context-help topic="route-activity" />
        </div>
      </header>

      <!-- KPIs del día (MetricStrip, ADR-033). Flota route: composición captura vs sin captura. -->
      <div class="rk-kpi-strip">
        <app-metric-strip mode="strip" [items]="kpiStrip()" ariaLabel="Actividad del día" />
        @if (captureComp(); as cc) {
          <app-metric-strip class="rk-cov" mode="composition" [items]="cc" ariaLabel="Capturas de las paradas en tienda" />
        }
      </div>

      @if (loading() && !rows().length) {
        <!-- Skeleton de filas (DESIGN datos-densos §4) -->
        <div class="sheet cols-12">
          <article class="cell cell-span-7 is-flush">
            <div class="rk-skel">
              @for (i of skeletonRows; track i) {
                <div class="rk-skel-row"><p-skeleton height="1.1rem" /></div>
              }
            </div>
          </article>
        </div>
      } @else if (rows().length) {
        <!-- Master-detail -->
        <div class="sheet cols-12">
          <article class="cell cell-span-7 is-flush">
            <p-table [value]="rows()" dataKey="vehicle_id"
              selectionMode="single" [metaKeySelection]="false"
              [selection]="selected()" (selectionChange)="onSelectionChange($event)"
              [scrollable]="true" [rowHover]="true" styleClass="p-datatable-sm rk-ptable">
              <ng-template #header>
                <tr>
                  <th pFrozenColumn>Unidad</th>
                  <th class="num">Km</th>
                  <th class="num" pTooltip="En movimiento">Mov.</th>
                  <th class="num" pTooltip="Detenido improductivo (paradas ≥20 min sin cliente)">Muerto</th>
                  @if (fleet === 'route') {
                    <th class="num" pTooltip="Paradas en tienda de trade">Tiendas</th>
                    <th class="num" pTooltip="Tiendas con captura de auditoría / paradas en tienda">Auditadas</th>
                    <th class="num" pTooltip="Paró en tienda pero no capturó">Sin capt.</th>
                  } @else {
                    <th class="num" pTooltip="Paradas con cliente / total">Paradas</th>
                    <th class="num" pTooltip="Km por entrega (parada con cliente)">Km/ent.</th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [pSelectableRow]="r">
                  <td pFrozenColumn class="rk-unit">{{ r.vehicle_plate || shortId(r.vehicle_id) }}</td>
                  <td class="num">{{ r.km_driven | number:'1.0-1' }}</td>
                  <td class="num">{{ fmtMin(r.moving_min) }}</td>
                  <td class="num" [class.rk-warn]="r.dead_min > 0">{{ r.dead_min ? fmtMin(r.dead_min) : '—' }}</td>
                  @if (fleet === 'route') {
                    <td class="num">{{ r.store_stops }}</td>
                    <td class="num"><b>{{ r.captured_stops }}</b><span class="rk-of">/{{ r.store_stops }}</span></td>
                    <td class="num" [class.rk-warn]="r.uncaptured_stops > 0">{{ r.uncaptured_stops || '—' }}</td>
                  } @else {
                    <td class="num"><b>{{ r.customer_stops }}</b><span class="rk-of">/{{ r.stops_count }}</span></td>
                    <td class="num">{{ r.km_per_customer_stop != null ? (r.km_per_customer_stop | number:'1.0-1') : '—' }}</td>
                  }
                </tr>
              </ng-template>
            </p-table>
          </article>
          @if (selected(); as s) {
            <article class="cell cell-span-5">
              <div class="rk-detail-head">
                <h3>{{ s.vehicle_plate || shortId(s.vehicle_id) }}</h3>
                <span class="rk-muted">Paradas del {{ date() }}</span>
              </div>
              <dl class="rk-kv">
                <div><dt>En movimiento</dt><dd class="num">{{ fmtMin(s.moving_min) }}</dd></div>
                <div><dt>Detenido</dt><dd class="num">{{ fmtMin(s.stopped_min) }}</dd></div>
                <div><dt>Tiempo muerto</dt><dd class="num">{{ fmtMin(s.dead_min) }}</dd></div>
                <div><dt>Sin señal</dt><dd class="num">{{ fmtMin(s.offline_min) }}</dd></div>
              </dl>
              <h4 class="rk-sub-h">Recorrido de paradas</h4>
              @if (loadingStops()) {
                <div class="rk-muted rk-pad">Cargando paradas…</div>
              }
              @if (!loadingStops() && stops().length === 0) {
                <div class="rk-muted rk-pad">Sin paradas registradas.</div>
              }
              @if (!loadingStops() && stops().length) {
                <ol class="rk-stops">
                  @for (st of stops(); track trackStop($index, st)) {
                    <li class="rk-stop" [class.cust]="st.matched_store_id || st.is_customer">
                      <span class="rk-stop-time">{{ hm(st.arrived_at) }}</span>
                      <span class="rk-stop-dot"></span>
                      <span class="rk-stop-body">
                        <span class="rk-stop-name">
                          @if (st.store_name || st.matched_store_id) {
                            <i class="pi pi-shop" aria-hidden="true"></i>
                            {{ st.store_name || 'Tienda' }}
                            @if (st.match_distance_m != null) {
                              <span class="rk-stop-dist">· {{ st.match_distance_m }} m</span>
                            }
                          } @else {
                            @if (st.is_customer) {
                              <i class="pi pi-user" aria-hidden="true"></i>
                              {{ st.customer_name || st.customer_code || 'Cliente' }}
                            } @else {
                              <i class="pi pi-pause-circle" aria-hidden="true"></i> Parada
                            }
                          }
                        </span>
                        <span class="rk-stop-meta">
                          {{ st.minutes }} min
                          @if (st.matched_store_id) {
                            <span class="rk-cap" [class.no]="!st.captured">
                              · {{ st.captured ? 'capturada' : 'sin captura' }}
                            </span>
                          }
                        </span>
                      </span>
                    </li>
                  }
                </ol>
              }
            </article>
          } @else {
            <article class="cell cell-span-5">
              <div class="rk-pick"><i class="pi pi-list" aria-hidden="true"></i>
              <p>Seleccioná una unidad para ver el detalle de sus paradas del día.</p>
            </div>
          </article>
          }
        </div>
      } @else {
        <div class="sheet cols-12">
          <article class="cell cell-span-12">
            @if (!errored()) {
              <div class="rk-empty">
                <div class="rk-empty-icon"><i class="pi pi-chart-bar" aria-hidden="true"></i></div>
                <h3>Sin actividad reconstruida</h3>
                <p>No hay viajes para <b>{{ date() }}</b>. Si ya hubo rastreo ese día, probá <b>Reconstruir día</b>.</p>
                <button pButton size="small" [loading]="rebuilding()" (click)="rebuild()"><span class="p-button-label">Reconstruir día</span></button>
              </div>
            } @else {
              <div class="rk-empty">
                <div class="rk-empty-icon"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i></div>
                <h3>No se pudo cargar la actividad</h3>
                <p>Revisá tu conexión y reintentá.</p>
                <button pButton size="small" (click)="refresh()"><span class="p-button-label">Reintentar</span></button>
              </div>
            }
          </article>
        </div>
      }

    </div>
  `,
  styles: [`
    :host { display:block; }
    .rk-eyebrow { display:inline-flex; align-items:center; gap:.35rem; font-size:var(--fs-micro); font-weight:var(--fw-bold); text-transform:uppercase; letter-spacing:.08em; color:var(--c-text-2); margin-bottom:.35rem; }
    .rk-muted { color:var(--c-text-3); }
    .rk-actions { display:flex; gap:.4rem; align-items:center; }
    .rk-date { padding:.4rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }
    .rk-date:focus-visible { outline:2px solid var(--action); outline-offset:1px; }

    .rk-kpi-strip { display:flex; align-items:center; gap:1.75rem; flex-wrap:wrap; margin:.5rem 0 1rem; }
    .rk-cov { min-width:15rem; }

    /* skeleton de filas */
    .rk-skel { padding:.4rem 0; }
    .rk-skel-row { padding:.55rem .7rem; border-top:1px solid var(--c-divider); }
    .rk-skel-row:first-child { border-top:none; }

    /* p-table densa (tokens sobre el tema PrimeNG) */
    :host ::ng-deep .rk-ptable .p-datatable-thead > tr > th { text-transform:uppercase; letter-spacing:.05em; font-size:var(--fs-micro); font-weight:var(--fw-bold); color:var(--c-text-3); }
    :host ::ng-deep .rk-ptable td.num, :host ::ng-deep .rk-ptable th.num { text-align:right; font-variant-numeric:tabular-nums; }
    :host ::ng-deep .rk-ptable td.num { font-family:var(--font-mono,'Geist Mono',monospace); }
    :host ::ng-deep .rk-ptable .p-datatable-tbody > tr.p-datatable-row-selected { background:var(--overlay-selected); box-shadow:inset 3px 0 0 var(--action); }
    :host ::ng-deep .rk-ptable .p-datatable-tbody > tr:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .rk-unit { font-weight:var(--fw-medium); max-width:10rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rk-of { color:var(--c-text-3); }
    .rk-warn { color:var(--warn-fg); }

    .rk-detail-head { display:flex; flex-direction:column; gap:.15rem; margin-bottom:.75rem; }
    .rk-detail-head h3 { margin:0; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-kv { display:grid; grid-template-columns:1fr 1fr; gap:0 1rem; margin:0 0 .75rem; }
    .rk-kv > div { display:flex; justify-content:space-between; gap:.5rem; padding:.35rem 0; border-top:1px solid var(--c-divider); }
    .rk-kv dt { color:var(--c-text-3); font-size:var(--fs-sm); margin:0; }
    .rk-kv dd { margin:0; font-size:var(--fs-sm); color:var(--c-text-1); }
    .rk-kv dd.num { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }

    .rk-sub-h { margin:.25rem 0 .5rem; font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); font-weight:var(--fw-bold); }
    .rk-pad { padding:.5rem 0; font-size:var(--fs-sm); }
    .rk-stops { list-style:none; margin:0; padding:0; }
    .rk-stop { display:flex; align-items:flex-start; gap:.6rem; padding:.35rem 0; }
    .rk-stop-time { font-family:var(--font-mono,'Geist Mono',monospace); font-size:var(--fs-micro); color:var(--c-text-3); width:3rem; flex:0 0 auto; padding-top:.1rem; }
    .rk-stop-dot { width:9px; height:9px; border-radius:50%; background:var(--c-text-3); flex:0 0 auto; margin-top:.3rem; }
    .rk-stop.cust .rk-stop-dot { background:var(--ok-fg); }
    .rk-stop-body { display:flex; flex-direction:column; gap:.05rem; min-width:0; }
    .rk-stop-name { font-size:var(--fs-sm); color:var(--c-text-1); overflow:hidden; text-overflow:ellipsis; }
    .rk-stop-name .pi { font-size:.75rem; color:var(--c-text-3); }
    .rk-stop.cust .rk-stop-name .pi { color:var(--ok-fg); }
    .rk-stop-dist { color:var(--c-text-3); font-size:var(--fs-micro); }
    .rk-stop-meta { font-size:var(--fs-micro); color:var(--c-text-3); font-variant-numeric:tabular-nums; }
    .rk-cap { color:var(--ok-fg); font-weight:var(--fw-medium); }
    .rk-cap.no { color:var(--warn-fg); }

    .rk-pick { text-align:center; color:var(--c-text-3); padding:2rem 1rem; font-size:var(--fs-sm); }
    .rk-pick i { font-size:1.4rem; display:block; margin-bottom:.5rem; }
    .rk-empty { text-align:center; padding:2.5rem 1.5rem; max-width:440px; margin:0 auto; }
    .rk-empty-icon { width:56px; height:56px; margin:0 auto 1rem; border-radius:14px; background:var(--c-surface-2); color:var(--c-text-2); display:grid; place-items:center; font-size:1.5rem; }
    .rk-empty h3 { margin:0 0 .375rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-empty p { margin:0 0 .75rem; color:var(--c-text-2); font-size:var(--fs-sm); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaActividadComponent {
  private readonly api = inject(LogisticaService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Alcance de flota: 'route' (Auditoría en Ruta) o 'logistics' (Logística). */
  readonly fleet: 'route' | 'logistics' = this.route.snapshot.data['fleet'] ?? 'logistics';

  readonly today = todayMx();
  readonly date = signal<string>(this.today);
  readonly rows = signal<FleetProductivityRow[]>([]);
  readonly stops = signal<VehicleStop[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loadingStops = signal(false);
  readonly rebuilding = signal(false);
  readonly errored = signal(false);
  readonly skeletonRows = [1, 2, 3, 4, 5, 6];

  readonly selected = computed(() => this.rows().find((r) => r.vehicle_id === this.selectedId()) ?? null);

  readonly totals = computed(() => {
    const r = this.rows();
    return {
      km: r.reduce((a, x) => a + (x.km_driven || 0), 0),
      customerStops: r.reduce((a, x) => a + (x.customer_stops || 0), 0),
      deadMin: r.reduce((a, x) => a + (x.dead_min || 0), 0),
      deadStops: r.reduce((a, x) => a + (x.dead_stops || 0), 0),
      storeStops: r.reduce((a, x) => a + (x.store_stops || 0), 0),
      captured: r.reduce((a, x) => a + (x.captured_stops || 0), 0),
      uncaptured: r.reduce((a, x) => a + (x.uncaptured_stops || 0), 0),
    };
  });

  /** KPIs base (varían por flota). Conteos/tiempos = valores únicos → strip. */
  readonly kpiStrip = computed<MetricStripItem[]>(() => {
    const t = this.totals();
    if (this.fleet === 'route') {
      return [
        { label: 'Km recorridos', value: Math.round(t.km), format: 'number' },
        { label: 'Paradas en tienda', value: t.storeStops, format: 'number' },
      ];
    }
    return [
      { label: 'Km recorridos', value: Math.round(t.km), format: 'number' },
      { label: 'Paradas con cliente', value: t.customerStops, tone: 'ok', format: 'number' },
      { label: 'Tiempo muerto', value: this.fmtMin(t.deadMin), format: 'text', tone: t.deadMin > 0 ? 'warn' : 'default' },
      { label: 'Paradas muertas', value: t.deadStops, format: 'number' },
    ];
  });

  /** Flota route: composición captura vs sin captura de las paradas en tienda. */
  readonly captureComp = computed<MetricStripItem[] | null>(() => {
    if (this.fleet !== 'route') return null;
    const t = this.totals();
    if (t.storeStops === 0) return null;
    return [
      { label: 'Con captura', value: t.captured, tone: 'ok' },
      { label: 'Sin captura', value: t.uncaptured, tone: 'warn' },
    ];
  });

  constructor() {
    // Estado en URL (DESIGN #10/#15): fecha + unidad seleccionada.
    const q = this.route.snapshot.queryParamMap;
    const qDate = q.get('date');
    if (qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)) this.date.set(qDate);
    this.selectedId.set(q.get('sel'));
    this.refresh();
  }

  setDate(d: string) {
    if (!d) return;
    this.date.set(d);
    this.selectedId.set(null);
    this.stops.set([]);
    this.writeUrl();
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.api.fleetProductivity(this.date(), this.fleet).subscribe({
      next: (r) => {
        this.rows.set(r || []);
        this.errored.set(false);
        this.loading.set(false);
        const id = this.selectedId();
        if (id && this.selected()) { if (!this.stops().length) this.loadStops(id); }
        else if (id) { this.selectedId.set(null); this.writeUrl(); }
      },
      error: () => { this.errored.set(true); this.loading.set(false); },
    });
  }

  rebuild() {
    this.rebuilding.set(true);
    this.api.rebuildTrips(this.date()).subscribe({
      next: () => { this.rebuilding.set(false); this.refresh(); if (this.selectedId()) this.loadStops(this.selectedId()!); },
      error: () => this.rebuilding.set(false),
    });
  }

  onSelectionChange(sel: FleetProductivityRow | null) {
    const id = sel?.vehicle_id ?? null;
    this.selectedId.set(id);
    this.stops.set([]);
    this.writeUrl();
    if (id) this.loadStops(id);
  }

  private loadStops(vehicleId: string) {
    this.loadingStops.set(true);
    this.stops.set([]);
    this.api.vehicleStops(vehicleId, this.date()).subscribe({
      next: (s) => { this.stops.set(s || []); this.loadingStops.set(false); },
      error: () => { this.loadingStops.set(false); },
    });
  }

  /** Refleja fecha + selección en la URL sin ensuciar el historial. */
  private writeUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { date: this.date(), sel: this.selectedId() || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  trackStop = (_: number, s: VehicleStop) => s.id;
  shortId(id: string) { return id ? id.slice(0, 8) : '—'; }
  fmtMin(min: number | null | undefined): string {
    const m = Math.round(min || 0);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  hm(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' });
  }
}
