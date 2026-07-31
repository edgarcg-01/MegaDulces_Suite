import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MapComponent, MapMarker } from '../../../shared/components/map/map.component';
import {
  LogisticaService,
  TrackerLive,
  TrackerStatus,
  FleetAlertRow,
  Vehicle,
} from '../logistica.service';

type Sev = 'success' | 'warn' | 'danger' | 'secondary' | 'info';

const STATUS_META: Record<TrackerStatus, { label: string; sev: Sev; color: string }> = {
  moving: { label: 'En movimiento', sev: 'success', color: 'var(--ok-fg)' },
  stopped: { label: 'Detenido', sev: 'warn', color: 'var(--warn-fg)' },
  offline: { label: 'Fuera de línea', sev: 'secondary', color: 'var(--c-text-3)' },
  unknown: { label: 'Sin dato', sev: 'secondary', color: 'var(--c-text-3)' },
};

@Component({
  selector: 'app-logistica-rastreo',
  standalone: true,
  imports: [FormsModule, RouterModule, ButtonModule, TagModule, TooltipModule, MapComponent],
  template: `
    <div class="surf-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <span class="rk-eyebrow"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ fleet === 'route' ? 'Auditoría en Ruta' : 'Logística' }}</span>
          <h1>{{ fleet === 'route' ? 'Rastreo de ruta' : 'Rastreo de flota' }}</h1>
          <p class="surf-page-sub">
            {{ units().length }} unidad{{ units().length === 1 ? '' : 'es' }}
            <span class="rk-dot" [class.on]="counts().moving > 0" aria-hidden="true"></span>
            <span class="rk-muted">· {{ counts().moving }} en movimiento · sincronizado {{ syncedAgo() }}</span>
          </p>
        </div>
        <div class="rk-actions">
          @if (fleet === 'route') {
            <button pButton severity="secondary" size="small" [text]="true" [loading]="syncingRoutes()" (click)="syncRoutes()" aria-label="Sincronizar ruta y operador desde el proveedor" pTooltip="Trae ruta + operador autoritativos de MagniTracking (travels/operators)"><span class="p-button-icon p-button-icon-left pi pi-sitemap" aria-hidden="true"></span><span class="p-button-label">Sincronizar rutas</span></button>
          }
          <button pButton severity="secondary" size="small" [text]="true" [loading]="bootstrapping()" (click)="bootstrap()" aria-label="Crear y vincular vehículos por placa" pTooltip="Crea vehículos desde los nombres del GPS y los vincula por placa"><span class="p-button-icon p-button-icon-left pi pi-link" aria-hidden="true"></span><span class="p-button-label">Vincular por placa</span></button>
          <button pButton severity="secondary" size="small" [loading]="syncing()" (click)="syncNow()" aria-label="Forzar sincronización con el proveedor"><span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span><span class="p-button-label">Sincronizar</span></button>
          <button pButton [text]="true" size="small" [loading]="loading()" (click)="refresh()" aria-label="Refrescar posiciones"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>
    
      <!-- Alertas persistidas (scanner server-side: sin señal / exceso de velocidad) -->
      @if (alerts().length) {
        <div class="sheet cols-12">
          <article class="cell cell-span-12 rk-alerts">
            @for (a of alerts(); track trackAlert($index, a)) {
              <div class="rk-alert" [class.ackd]="a.status === 'ack'">
                <button type="button" class="rk-alert-main" (click)="select(a.tracker_id)">
                  <p-tag [value]="alertLabel(a.kind)" [severity]="a.severity" [rounded]="true"></p-tag>
                  <span class="rk-alert-detail">{{ a.external_name || a.route_code || '—' }} · {{ a.message }}</span>
                </button>
                @if (a.status !== 'ack') {
                  <button pButton [text]="true" size="small" severity="secondary" (click)="ackAlert(a.id)" pTooltip="Reconocer" aria-label="Reconocer alerta"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span></button>
                }
              </div>
            }
          </article>
        </div>
      }
    
      <!-- KPIs -->
      <div class="sheet cols-12 rk-kpis">
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" style="color:var(--ok-fg)">{{ counts().moving }}</span>
          <span class="rk-kpi-l">En movimiento</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" style="color:var(--warn-fg)">{{ counts().stopped }}</span>
          <span class="rk-kpi-l">Detenidos</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n rk-dim">{{ counts().offline }}</span>
          <span class="rk-kpi-l">Fuera de línea</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n">{{ counts().linked }}</span>
          <span class="rk-kpi-l">Vinculados</span>
        </article>
      </div>
    
      <!-- Mapa -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <app-map #map [markers]="markers()" [path]="trailPath()" autoFit="once"
          height="480px" (markerClick)="select($event.id)"></app-map>
        </article>
      </div>
    
      <!-- Master-detail -->
      @if (units().length) {
        <div class="sheet cols-12">
          <article class="cell cell-span-7 is-flush">
            <div class="rk-list" role="list">
              @for (u of units(); track trackById($index, u)) {
                <button type="button" class="rk-row" role="listitem"
                  [class.sel]="u.id === selectedId()" (click)="select(u.id)">
                  <span class="rk-status-dot" [style.background]="statusColor(u)"></span>
                  <div class="rk-row-main">
                    <span class="rk-row-name">{{ displayName(u) }}</span>
                    <span class="rk-row-sub">
                      @if (fleet === 'route' && u.route_number != null) {
                        <span class="comm-code">R-{{ u.route_number }}</span>
                      }
                      @if (fleet === 'route' && u.vendor_name) {
                        <span>{{ u.vendor_name }} ·</span>
                      }
                      <span>{{ statusMeta(u).label }}</span>
                      @if (u.last_speed_kmh) {
                        <span>· {{ u.last_speed_kmh }} km/h</span>
                      }
                    </span>
                  </div>
                  <span class="rk-ago">{{ ago(u.last_seen_at) }}</span>
                </button>
              }
            </div>
          </article>
          @if (selected(); as s) {
            <article class="cell cell-span-5">
              <div class="rk-detail-head">
                <p-tag [value]="statusMeta(s).label" [severity]="statusMeta(s).sev" [rounded]="true"></p-tag>
                <h3>{{ displayName(s) }}</h3>
              </div>
              <dl class="rk-kv">
                @if (fleet === 'route') {
                  <div><dt>Ruta</dt><dd>{{ routeLabel(s) }}</dd></div>
                }
                @if (fleet === 'route') {
                  <div><dt>Vendedor</dt><dd>{{ s.vendor_name || '—' }}</dd></div>
                }
                <div><dt>Velocidad</dt><dd class="num">{{ s.last_speed_kmh ?? 0 }} km/h</dd></div>
                <div><dt>Encendido</dt><dd>{{ s.last_ignition === null ? '—' : (s.last_ignition ? 'Sí' : 'No') }}</dd></div>
                <div><dt>Último reporte</dt><dd>{{ ago(s.last_seen_at) }}</dd></div>
                <div><dt>Protocolo</dt><dd>{{ s.protocol || '—' }}</dd></div>
                <div><dt>Coordenadas</dt><dd class="num">{{ s.last_lat }}, {{ s.last_lng }}</dd></div>
                <div><dt>Estado (proveedor)</dt><dd>{{ s.last_status_text || '—' }}</dd></div>
              </dl>
              <div class="rk-link">
                <label [attr.for]="'veh-' + s.id">Vehículo vinculado</label>
                <select [id]="'veh-' + s.id" [ngModel]="s.vehicle_id || ''" (ngModelChange)="link(s, $event)">
                  <option value="">— Sin vincular —</option>
                  @for (v of vehicles(); track v) {
                    <option [value]="v.id">{{ v.plate }}{{ v.brand ? ' · ' + v.brand : '' }}</option>
                  }
                </select>
              </div>
              @if (fleet === 'route') {
                <div class="rk-link">
                  <label [attr.for]="'rt-' + s.id">Ruta (número)</label>
                  <input [id]="'rt-' + s.id" type="number" min="0" max="999" inputmode="numeric"
                    placeholder="ej. 21 — vacío = automático del GPS"
                    [ngModel]="s.route_number" (ngModelChange)="setRoute(s, $event)" />
                    <small class="rk-hint">{{ s.route_number != null ? 'Ruta ' + s.route_number : 'Sin ruta' }}{{ s.vendor_name ? ' · ' + s.vendor_name : '' }}</small>
                  </div>
                }
                <div class="rk-detail-actions">
                  <p-button size="small" [severity]="showTrail() ? 'primary' : 'secondary'"
                    [icon]="loadingTrail() ? 'pi pi-spin pi-spinner' : 'pi pi-directions'"
                    [label]="showTrail() ? 'Ocultar recorrido' : 'Ver recorrido de hoy'"
                  (click)="toggleTrail(s)"></p-button>
                  @if (fleet === 'route') {
                    <a pButton size="small" severity="secondary" [text]="true" routerLink="/dashboard/route-compliance"><span class="p-button-icon p-button-icon-left pi pi-check-circle" aria-hidden="true"></span><span class="p-button-label">Cumplimiento de ruta</span></a>
                  }
                </div>
              </article>
            } @else {
              <article class="cell cell-span-5">
                <div class="rk-pick"><i class="pi pi-map-marker" aria-hidden="true"></i>
                <p>Seleccioná una unidad de la lista o del mapa para ver su detalle y recorrido.</p>
              </div>
            </article>
          }
        </div>
      } @else {
        <div class="sheet cols-12">
          <article class="cell cell-span-12">
            @if (!errored()) {
              <div class="rk-empty">
                <div class="rk-empty-icon"><i class="pi pi-truck" aria-hidden="true"></i></div>
                <h3>Sin unidades</h3>
                <p>Cuando el proveedor reporte dispositivos aparecerán aquí. Probá <b>Sincronizar</b>.</p>
              </div>
            } @else {
              <div class="rk-empty">
                <div class="rk-empty-icon"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i></div>
                <h3>No se pudo cargar el rastreo</h3>
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
    .rk-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--c-text-3); margin:0 .1rem; vertical-align:middle; }
    .rk-dot.on { background:var(--ok-fg); box-shadow:0 0 0 3px var(--ok-soft-bg); }
    .rk-muted { color:var(--c-text-3); }
    .rk-actions { display:flex; gap:.4rem; align-items:center; }

    .rk-alerts { display:flex; flex-wrap:wrap; gap:.4rem; }
    .rk-alert { display:inline-flex; align-items:center; gap:.15rem; border:1px solid var(--c-divider); border-radius:var(--r-md,8px); padding:.2rem .3rem; }
    .rk-alert.ackd { opacity:.55; }
    .rk-alert-main { display:inline-flex; align-items:center; gap:.5rem; background:transparent; border:0; padding:.1rem .3rem; cursor:pointer; font:inherit; color:inherit; border-radius:var(--r-sm,6px); }
    .rk-alert-main:hover { background:var(--overlay-hover); }
    .rk-alert-detail { font-size:var(--fs-sm); color:var(--c-text-2); }

    .rk-kpis { }
    .rk-kpi { display:flex; flex-direction:column; gap:.1rem; }
    .rk-kpi-n { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; font-size:var(--fs-h2,1.5rem); font-weight:var(--fw-bold); line-height:1.1; }
    .rk-kpi-n.rk-dim { color:var(--c-text-3); }
    .rk-kpi-l { font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); }

    .rk-list { display:flex; flex-direction:column; }
    .rk-row { display:flex; align-items:center; gap:.65rem; padding:.55rem .7rem; border-top:1px solid var(--c-divider); background:transparent; border-left:0; border-right:0; border-bottom:0; width:100%; text-align:left; cursor:pointer; font:inherit; color:inherit; }
    .rk-row:first-child { border-top:none; }
    .rk-row:hover { background:var(--overlay-hover); }
    .rk-row.sel { background:var(--overlay-selected); box-shadow:inset 3px 0 0 var(--action); }
    .rk-status-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
    .rk-row-main { display:flex; flex-direction:column; gap:.1rem; flex:1 1 auto; min-width:0; }
    .rk-row-name { font-size:var(--fs-sm); font-weight:var(--fw-medium); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rk-row-sub { display:flex; gap:.4rem; align-items:center; font-size:var(--fs-micro); color:var(--c-text-3); }
    .rk-ago { font-size:var(--fs-micro); color:var(--c-text-3); font-variant-numeric:tabular-nums; white-space:nowrap; }

    .rk-detail-head { display:flex; flex-direction:column; gap:.4rem; margin-bottom:.75rem; }
    .rk-detail-head h3 { margin:0; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-kv { display:grid; grid-template-columns:1fr; gap:0; margin:0 0 .75rem; }
    .rk-kv > div { display:flex; justify-content:space-between; gap:1rem; padding:.35rem 0; border-top:1px solid var(--c-divider); }
    .rk-kv > div:first-child { border-top:none; }
    .rk-kv dt { color:var(--c-text-3); font-size:var(--fs-sm); margin:0; }
    .rk-kv dd { margin:0; font-size:var(--fs-sm); text-align:right; color:var(--c-text-1); }
    .rk-kv dd.num { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }

    .rk-link { display:flex; flex-direction:column; gap:.25rem; margin-bottom:.75rem; }
    .rk-link label { font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); }
    .rk-link select, .rk-link input { padding:.4rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); color:var(--text-1,var(--c-text-1)); font:inherit; font-size:var(--fs-sm); }
    .rk-link select:focus-visible, .rk-link input:focus-visible { outline:2px solid var(--action); outline-offset:1px; }
    .rk-hint { font-size:var(--fs-micro); color:var(--c-text-3); }

    .rk-detail-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
    .rk-adh { margin-top:.6rem; border-top:1px solid var(--c-divider); padding-top:.6rem; font-size:var(--fs-sm); }
    .rk-adh-na { color:var(--c-text-3); display:flex; gap:.4rem; align-items:flex-start; }
    .rk-adh-bar { height:6px; border-radius:99px; background:var(--c-surface-2); overflow:hidden; margin-bottom:.4rem; }
    .rk-adh-bar span { display:block; height:100%; background:var(--ok-fg); transition:width .3s ease-out; }
    .rk-adh-head { color:var(--c-text-2); }
    .rk-adh-head b { color:var(--c-text-1); font-variant-numeric:tabular-nums; }
    .rk-adh-skipped { margin-top:.4rem; display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; }
    .rk-adh-lbl { color:var(--c-text-3); font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; }
    .rk-pick { text-align:center; color:var(--c-text-3); padding:2rem 1rem; font-size:var(--fs-sm); }
    .rk-pick i { font-size:1.4rem; display:block; margin-bottom:.5rem; }

    .rk-empty { text-align:center; padding:2.5rem 1.5rem; max-width:440px; margin:0 auto; }
    .rk-empty-icon { width:56px; height:56px; margin:0 auto 1rem; border-radius:14px; background:var(--c-surface-2); color:var(--c-text-2); display:grid; place-items:center; font-size:1.5rem; }
    .rk-empty h3 { margin:0 0 .375rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-empty p { margin:0 0 .75rem; color:var(--c-text-2); font-size:var(--fs-sm); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaRastreoComponent {
  private readonly api = inject(LogisticaService);
  private readonly destroyRef = inject(DestroyRef);
  /** Alcance: 'route' (camionetas de ruta, Auditoría en Ruta) o 'logistics'. */
  readonly fleet: 'route' | 'logistics' = inject(ActivatedRoute).snapshot.data['fleet'] ?? 'logistics';
  @ViewChild('map') map?: MapComponent;

  readonly units = signal<TrackerLive[]>([]);
  readonly vehicles = signal<Vehicle[]>([]);
  readonly loading = signal(false);
  readonly syncing = signal(false);
  readonly bootstrapping = signal(false);
  readonly syncingRoutes = signal(false);
  readonly errored = signal(false);
  readonly selectedId = signal<string | number | null>(null);
  readonly showTrail = signal(false);
  readonly loadingTrail = signal(false);
  readonly trailPath = signal<{ lat: number; lng: number }[]>([]);
  private lastSynced = signal<number>(0);

  readonly selected = computed(() => this.units().find((u) => u.id === this.selectedId()) ?? null);

  readonly counts = computed(() => {
    const u = this.units();
    return {
      moving: u.filter((x) => x.last_status === 'moving').length,
      stopped: u.filter((x) => x.last_status === 'stopped').length,
      offline: u.filter((x) => x.last_status === 'offline' || x.last_status === 'unknown').length,
      linked: u.filter((x) => x.vehicle_id).length,
    };
  });

  readonly markers = computed<MapMarker[]>(() =>
    this.units()
      .filter((u) => u.last_lat != null && u.last_lng != null && !isNaN(Number(u.last_lat)))
      .map((u) => ({
        lat: Number(u.last_lat),
        lng: Number(u.last_lng),
        id: u.id,
        kind: 'truck' as const,
        color: this.statusColor(u),
        ring: u.last_status === 'moving',
        title: `${this.displayName(u)} · ${this.statusMeta(u).label}${u.last_speed_kmh ? ' · ' + u.last_speed_kmh + ' km/h' : ''}`,
      })),
  );

  readonly alerts = signal<FleetAlertRow[]>([]);

  private timer: any = null;

  constructor() {
    this.refresh();
    this.loadVehicles();
    this.timer = setInterval(() => this.refresh(), 30_000);
    this.destroyRef.onDestroy(() => { if (this.timer) clearInterval(this.timer); });
  }

  refresh() {
    this.loading.set(true);
    this.api.liveTracking(this.fleet).subscribe({
      next: (r) => { this.units.set(r || []); this.errored.set(false); this.loading.set(false); if (r?.length) this.lastSynced.set(Date.now()); },
      error: () => { this.errored.set(true); this.loading.set(false); },
    });
    this.api.fleetAlerts().subscribe({ next: (a) => this.alerts.set(a || []), error: () => {} });
  }

  ackAlert(id: string) {
    this.api.ackFleetAlert(id).subscribe({
      next: () => this.alerts.update((l) => l.filter((a) => a.id !== id)),
      error: () => {},
    });
  }
  alertLabel(kind: 'offline' | 'speed') { return kind === 'offline' ? 'Sin señal' : 'Exceso de velocidad'; }
  trackAlert = (_: number, a: FleetAlertRow) => a.id;

  private loadVehicles() {
    this.api.listVehicles({ active: true }).subscribe({ next: (v) => this.vehicles.set(v || []), error: () => {} });
  }

  syncNow() {
    this.syncing.set(true);
    this.api.trackingSyncNow().subscribe({
      next: () => { this.syncing.set(false); this.refresh(); },
      error: () => this.syncing.set(false),
    });
  }

  bootstrap() {
    this.bootstrapping.set(true);
    this.api.trackingBootstrapVehicles().subscribe({
      next: () => { this.bootstrapping.set(false); this.loadVehicles(); this.refresh(); },
      error: () => this.bootstrapping.set(false),
    });
  }

  syncRoutes() {
    this.syncingRoutes.set(true);
    this.api.trackingSyncRoutes().subscribe({
      next: () => { this.syncingRoutes.set(false); this.refresh(); },
      error: () => this.syncingRoutes.set(false),
    });
  }

  select(id: string | number | null | undefined) {
    if (id == null) return;
    this.selectedId.set(id);
    this.showTrail.set(false);
    this.trailPath.set([]);
    const u = this.units().find((x) => x.id === id);
    if (u?.last_lat != null && u.last_lng != null) this.map?.panTo(Number(u.last_lat), Number(u.last_lng));
  }

  toggleTrail(u: TrackerLive) {
    if (this.showTrail()) { this.showTrail.set(false); this.trailPath.set([]); return; }
    const from = new Date(); from.setHours(0, 0, 0, 0);
    this.loadingTrail.set(true);
    this.api.trackerHistory(u.id, from.toISOString()).subscribe({
      next: (pts) => {
        this.trailPath.set((pts || []).filter((p) => p.lat != null && p.lng != null && !isNaN(Number(p.lat))).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })));
        this.showTrail.set(true);
        this.loadingTrail.set(false);
      },
      error: () => this.loadingTrail.set(false),
    });
  }

  link(u: TrackerLive, vehicleId: string) {
    const val = vehicleId || null;
    this.api.linkTracker(u.id, val).subscribe({
      next: () => this.units.update((list) => list.map((x) => (x.id === u.id ? { ...x, vehicle_id: val, vehicle_plate: this.vehicles().find((v) => v.id === val)?.plate ?? null } : x))),
      error: () => {},
    });
  }

  setRoute(u: TrackerLive, value: number | string | null) {
    const rn = value === '' || value == null ? null : Number(value);
    this.api.setTrackerRoute(u.id, Number.isNaN(rn as number) ? null : rn).subscribe({
      next: (r) => this.units.update((list) => list.map((x) => (x.id === u.id ? { ...x, route_number: r.route_number } : x))),
      error: () => {},
    });
  }

  routeLabel(u: TrackerLive): string {
    return u.route_number != null ? `R-${u.route_number}` : (u.route_code || '—');
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  trackById = (_: number, u: TrackerLive) => u.id;
  statusMeta(u: TrackerLive) { return STATUS_META[u.last_status ?? 'unknown']; }
  statusColor(u: TrackerLive) { return this.statusMeta(u).color; }
  displayName(u: TrackerLive) { return u.vehicle_plate || u.external_name || u.imei; }

  syncedAgo() { return this.lastSynced() ? this.ago(new Date(this.lastSynced()).toISOString()) : '—'; }

  private minsSince(iso: string | null): number | null {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  }
  ago(iso: string | null): string {
    const min = this.minsSince(iso);
    if (min == null) return '—';
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} d`;
  }
}
