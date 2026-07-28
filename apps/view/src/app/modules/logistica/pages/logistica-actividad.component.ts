import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import {
  LogisticaService,
  FleetProductivityRow,
  VehicleStop,
} from '../logistica.service';

/**
 * LTV.0 + LTV.5 — Actividad de flota del día. Sobre los viajes reconstruidos
 * (vehicle_day_summary + vehicle_stops) muestra por vehículo: km, tiempos
 * (movimiento/detenido/muerto/offline), paradas productivas vs muertas y
 * km por entrega. Drill a las paradas del vehículo (timeline con cliente
 * matcheado). Botón para reconstruir el día si el cron nocturno aún no corrió.
 */
@Component({
  selector: 'app-logistica-actividad',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, TooltipModule],
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
          <button pButton icon="pi pi-cog" label="Reconstruir día" severity="secondary" size="small" [text]="true"
                  [loading]="rebuilding()" (click)="rebuild()"
                  pTooltip="Recalcula paradas y resumen desde el rastro GPS (por si el proceso nocturno aún no corrió)"></button>
          <button pButton icon="pi pi-refresh" label="Actualizar" [text]="true" size="small"
                  [loading]="loading()" (click)="refresh()" aria-label="Refrescar"></button>
        </div>
      </header>

      <!-- KPIs del día -->
      <div class="sheet cols-12 rk-kpis">
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n">{{ totals().km | number:'1.0-0' }}</span>
          <span class="rk-kpi-l">Km recorridos</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" style="color:var(--ok-fg)">{{ totals().customerStops }}</span>
          <span class="rk-kpi-l">Paradas con cliente</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" style="color:var(--warn-fg)">{{ fmtMin(totals().deadMin) }}</span>
          <span class="rk-kpi-l">Tiempo muerto</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n rk-dim">{{ totals().deadStops }}</span>
          <span class="rk-kpi-l">Paradas muertas</span>
        </article>
      </div>

      <!-- Master-detail -->
      <div class="sheet cols-12" *ngIf="rows().length; else empty">
        <article class="cell cell-span-7 is-flush">
          <div class="rk-table-wrap">
            <table class="rk-table">
              <thead>
                <tr>
                  <th>Unidad</th>
                  <th class="num">Km</th>
                  <th class="num" pTooltip="En movimiento">Mov.</th>
                  <th class="num" pTooltip="Detenido improductivo (paradas ≥20 min sin cliente)">Muerto</th>
                  <th class="num" pTooltip="Paradas con cliente / total">Paradas</th>
                  <th class="num" pTooltip="Km por entrega (parada con cliente)">Km/ent.</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let r of rows(); trackBy: trackById"
                    class="rk-tr" [class.sel]="r.vehicle_id === selectedId()" (click)="select(r)">
                  <td class="rk-unit">{{ r.vehicle_plate || shortId(r.vehicle_id) }}</td>
                  <td class="num">{{ r.km_driven | number:'1.0-1' }}</td>
                  <td class="num">{{ fmtMin(r.moving_min) }}</td>
                  <td class="num" [class.rk-warn]="r.dead_min > 0">{{ r.dead_min ? fmtMin(r.dead_min) : '—' }}</td>
                  <td class="num"><b>{{ r.customer_stops }}</b><span class="rk-of">/{{ r.stops_count }}</span></td>
                  <td class="num">{{ r.km_per_customer_stop != null ? (r.km_per_customer_stop | number:'1.0-1') : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article class="cell cell-span-5" *ngIf="selected() as s; else pickHint">
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
          <div *ngIf="loadingStops()" class="rk-muted rk-pad">Cargando paradas…</div>
          <div *ngIf="!loadingStops() && stops().length === 0" class="rk-muted rk-pad">Sin paradas registradas.</div>
          <ol class="rk-stops" *ngIf="!loadingStops() && stops().length">
            <li *ngFor="let st of stops(); trackBy: trackStop" class="rk-stop" [class.cust]="st.is_customer">
              <span class="rk-stop-time">{{ hm(st.arrived_at) }}</span>
              <span class="rk-stop-dot"></span>
              <span class="rk-stop-body">
                <span class="rk-stop-name">
                  <ng-container *ngIf="st.is_customer; else nocust">
                    <i class="pi pi-shop" aria-hidden="true"></i>
                    {{ st.customer_name || st.customer_code || 'Cliente' }}
                    <span class="rk-stop-dist" *ngIf="st.match_distance_m != null">· {{ st.match_distance_m }} m</span>
                  </ng-container>
                  <ng-template #nocust><i class="pi pi-pause-circle" aria-hidden="true"></i> Parada</ng-template>
                </span>
                <span class="rk-stop-meta">{{ st.minutes }} min</span>
              </span>
            </li>
          </ol>
        </article>

        <ng-template #pickHint>
          <article class="cell cell-span-5">
            <div class="rk-pick"><i class="pi pi-list" aria-hidden="true"></i>
              <p>Seleccioná una unidad para ver el detalle de sus paradas del día.</p>
            </div>
          </article>
        </ng-template>
      </div>

      <ng-template #empty>
        <div class="sheet cols-12">
          <article class="cell cell-span-12">
            <div class="rk-empty" *ngIf="!errored(); else errBox">
              <div class="rk-empty-icon"><i class="pi pi-chart-bar" aria-hidden="true"></i></div>
              <h3>Sin actividad reconstruida</h3>
              <p>No hay viajes para <b>{{ date() }}</b>. Si ya hubo rastreo ese día, probá <b>Reconstruir día</b>.</p>
              <button pButton size="small" label="Reconstruir día" [loading]="rebuilding()" (click)="rebuild()"></button>
            </div>
            <ng-template #errBox>
              <div class="rk-empty">
                <div class="rk-empty-icon"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i></div>
                <h3>No se pudo cargar la actividad</h3>
                <p>Revisá tu conexión y reintentá.</p>
                <button pButton size="small" label="Reintentar" (click)="refresh()"></button>
              </div>
            </ng-template>
          </article>
        </div>
      </ng-template>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .rk-eyebrow { display:inline-flex; align-items:center; gap:.35rem; font-size:var(--fs-micro); font-weight:var(--fw-bold); text-transform:uppercase; letter-spacing:.08em; color:var(--c-text-2); margin-bottom:.35rem; }
    .rk-muted { color:var(--c-text-3); }
    .rk-actions { display:flex; gap:.4rem; align-items:center; }
    .rk-date { padding:.4rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }
    .rk-date:focus-visible { outline:2px solid var(--action); outline-offset:1px; }

    .rk-kpi { display:flex; flex-direction:column; gap:.1rem; }
    .rk-kpi-n { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; font-size:var(--fs-h2,1.5rem); font-weight:var(--fw-bold); line-height:1.1; }
    .rk-kpi-n.rk-dim { color:var(--c-text-3); }
    .rk-kpi-l { font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); }

    .rk-table-wrap { overflow-x:auto; }
    .rk-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .rk-table thead th { text-align:left; padding:.5rem .7rem; font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-3); font-weight:var(--fw-bold); border-bottom:1px solid var(--c-divider); white-space:nowrap; }
    .rk-table th.num, .rk-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .rk-table td.num { font-family:var(--font-mono,'Geist Mono',monospace); }
    .rk-tr { cursor:pointer; }
    .rk-tr > td { padding:.5rem .7rem; border-top:1px solid var(--c-divider); white-space:nowrap; }
    .rk-tr:hover { background:var(--overlay-hover); }
    .rk-tr.sel { background:var(--overlay-selected); box-shadow:inset 3px 0 0 var(--action); }
    .rk-unit { font-weight:var(--fw-medium); }
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
  private readonly destroyRef = inject(DestroyRef);
  /** Alcance de flota: 'route' (Auditoría en Ruta) o 'logistics' (Logística). */
  readonly fleet: 'route' | 'logistics' = inject(ActivatedRoute).snapshot.data['fleet'] ?? 'logistics';

  readonly today = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  readonly date = signal<string>(this.today);
  readonly rows = signal<FleetProductivityRow[]>([]);
  readonly stops = signal<VehicleStop[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loadingStops = signal(false);
  readonly rebuilding = signal(false);
  readonly errored = signal(false);

  readonly selected = computed(() => this.rows().find((r) => r.vehicle_id === this.selectedId()) ?? null);

  readonly totals = computed(() => {
    const r = this.rows();
    return {
      km: r.reduce((a, x) => a + (x.km_driven || 0), 0),
      customerStops: r.reduce((a, x) => a + (x.customer_stops || 0), 0),
      deadMin: r.reduce((a, x) => a + (x.dead_min || 0), 0),
      deadStops: r.reduce((a, x) => a + (x.dead_stops || 0), 0),
    };
  });

  constructor() {
    this.refresh();
  }

  setDate(d: string) {
    if (!d) return;
    this.date.set(d);
    this.selectedId.set(null);
    this.stops.set([]);
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.api.fleetProductivity(this.date(), this.fleet).subscribe({
      next: (r) => { this.rows.set(r || []); this.errored.set(false); this.loading.set(false); },
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

  select(r: FleetProductivityRow) {
    if (this.selectedId() === r.vehicle_id) { this.selectedId.set(null); this.stops.set([]); return; }
    this.selectedId.set(r.vehicle_id);
    this.loadStops(r.vehicle_id);
  }

  private loadStops(vehicleId: string) {
    this.loadingStops.set(true);
    this.stops.set([]);
    this.api.vehicleStops(vehicleId, this.date()).subscribe({
      next: (s) => { this.stops.set(s || []); this.loadingStops.set(false); },
      error: () => { this.loadingStops.set(false); },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  trackById = (_: number, r: FleetProductivityRow) => r.vehicle_id;
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
