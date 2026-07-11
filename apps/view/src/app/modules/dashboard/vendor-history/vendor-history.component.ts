import { Component, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { HttpClient, HttpParams } from '@angular/common/http';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { environment } from '../../../../environments/environment';
import { MapComponent, MapLayer, MapMarker } from '../../../shared/components/map/map.component';

interface FieldUser { user_id: string; username: string; ping_count: number; }
interface DetectedVisit {
  lat: number; lng: number; minutes: number; arrived: string; left: string;
  store_id?: string | null; store_name?: string | null; captured?: boolean;
}
interface VendorDay {
  user_id: string;
  username: string;
  date: string;
  snapped: {
    geometry: { coordinates: [number, number][] };
    distance_m: number;
    stops: { lat: number; lng: number; minutes: number; arrived: string; left: string; store_name?: string | null }[];
    confidence: number | null;
    low_confidence?: boolean;
    point_count: number;
  } | null;
  detected_visits: DetectedVisit[];
  kpis: {
    pings: number; first_at: string | null; last_at: string | null; active_min: number;
    stop_count: number; stop_min: number; moving_min: number; distance_km: number; avg_speed_kmh: number | null;
    detected_visits: number; uncaptured_visits: number;
  };
}

/**
 * R.3/R.5 — Historial de un vendedor en un día: recorrido pegado a calles
 * (map-matching), paradas detectadas y KPIs (distancia real, tiempo en parada,
 * movimiento, velocidad media). Reusa el átomo app-map + el backend snapped.
 * Superficie Operations (DESIGN.md): denso, sin Fraunces. Gate RUTAS_VER.
 */
@Component({
  selector: 'app-vendor-history',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, SkeletonModule, MapComponent],
  template: `
    <div class="vh-wrap">
      <header class="vh-head">
        <div>
          <h1 class="vh-title">Historial de vendedor</h1>
          <p class="vh-sub">Recorrido por calles, paradas y métricas de un día.</p>
        </div>
        <div class="vh-filters">
          <input type="date" class="vh-date" [value]="date()" [max]="today" (change)="onDate($event)" />
          <p-select
            [options]="vendorOptions()"
            [ngModel]="selectedUser()"
            (ngModelChange)="onVendor($event)"
            optionLabel="label"
            optionValue="value"
            placeholder="Elegí un vendedor"
            [filter]="true"
            [showClear]="false"
            styleClass="vh-select"
            [emptyMessage]="loadingUsers() ? 'Cargando…' : 'Sin actividad ese día'"
          ></p-select>
        </div>
      </header>

      @if (!selectedUser()) {
        <div class="vh-empty">Elegí una fecha y un vendedor para ver su recorrido del día.</div>
      } @else if (loadingDay()) {
        <p-skeleton height="140px" styleClass="vh-sk"></p-skeleton>
        <p-skeleton height="60vh"></p-skeleton>
      } @else if (!day()?.snapped) {
        <div class="vh-empty">Sin recorrido GPS para {{ selectedName() }} el {{ date() }}.</div>
      } @else {
        @if (day()!.snapped?.low_confidence) {
          <div class="vh-note"><i class="pi pi-info-circle" aria-hidden="true"></i>&nbsp;Recorrido aproximado: señal GPS dispersa (cadencia baja). Mejora con más pings.</div>
        }
        <div class="vh-kpis">
          <div class="kpi"><span class="k-val">{{ day()!.snapped?.low_confidence ? '≈ ' : '' }}{{ day()!.kpis.distance_km }}</span><span class="k-lbl">km {{ day()!.snapped?.low_confidence ? '(aprox)' : 'reales' }}</span></div>
          <div class="kpi"><span class="k-val">{{ day()!.kpis.stop_count }}</span><span class="k-lbl">paradas</span></div>
          <div class="kpi"><span class="k-val">{{ fmtMin(day()!.kpis.stop_min) }}</span><span class="k-lbl">en paradas</span></div>
          <div class="kpi"><span class="k-val">{{ fmtMin(day()!.kpis.moving_min) }}</span><span class="k-lbl">en movimiento</span></div>
          <div class="kpi"><span class="k-val">{{ day()!.kpis.avg_speed_kmh ?? '—' }}</span><span class="k-lbl">km/h prom</span></div>
          <div class="kpi" [class.kpi-gap]="day()!.kpis.uncaptured_visits > 0">
            <span class="k-val">{{ day()!.kpis.detected_visits }}<small>{{ day()!.kpis.uncaptured_visits > 0 ? ' · ' + day()!.kpis.uncaptured_visits + ' s/cap' : '' }}</small></span>
            <span class="k-lbl">visitas detectadas</span>
          </div>
          <div class="kpi"><span class="k-val">{{ fmtTime(day()!.kpis.first_at) }}–{{ fmtTime(day()!.kpis.last_at) }}</span><span class="k-lbl">jornada</span></div>
        </div>
        @if (day()!.detected_visits.length) {
          <div class="vh-dv">
            <div class="vh-dv-head">
              <i class="pi pi-map-marker" aria-hidden="true"></i>&nbsp;Visitas detectadas por GPS
              <span class="vh-dv-hint">— estuvo ≥5 min cerca de la tienda</span>
            </div>
            <div class="vh-dv-list">
              @for (d of day()!.detected_visits; track d.arrived) {
                <button class="vh-dv-row" [class.gap]="!d.captured" (click)="panToVisit(d)">
                  <i class="pi" [class.pi-check-circle]="d.captured" [class.pi-exclamation-triangle]="!d.captured" aria-hidden="true"></i>
                  <span class="vh-dv-store">{{ d.store_name || 'Tienda' }}</span>
                  <span class="vh-dv-meta">{{ fmtTime(d.arrived) }} · {{ d.minutes }} min</span>
                  <span class="vh-dv-badge">{{ d.captured ? 'capturó' : 'sin captura' }}</span>
                </button>
              }
            </div>
          </div>
        }
        <div class="vh-pb">
          <button class="pb-btn" (click)="togglePlay()" [attr.aria-label]="playing() ? 'Pausar' : 'Reproducir'">
            <i class="pi" [class.pi-pause]="playing()" [class.pi-play]="!playing()" aria-hidden="true"></i>
          </button>
          <input type="range" class="pb-range" min="0" max="1000" [value]="progress() * 1000" (input)="onScrub($event)" aria-label="Línea de tiempo del recorrido" />
          <span class="pb-clock">{{ clockLabel() || '—' }}</span>
          <div class="pb-speed">
            @for (s of speeds; track s) {
              <button [class.act]="speed() === s" (click)="setSpeed(s)">{{ s }}×</button>
            }
          </div>
        </div>
        <div class="vh-map">
          <app-map #map [tracks]="mapTracks()" [markers]="stopMarkers()" [layers]="cursorLayer()" autoFit="off" height="100%"></app-map>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .vh-wrap { display:flex; flex-direction:column; height:calc(100vh - var(--app-header-h, 56px)); min-height:480px; padding:1rem; gap:.85rem; }
    .vh-head { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
    .vh-title { font:700 1.1rem/1.2 'Hanken Grotesk',sans-serif; margin:0; color:var(--text,#1c1917); }
    .vh-sub { margin:.15rem 0 0; font-size:.8rem; color:var(--text-dim,#78716c); }
    .vh-filters { display:flex; gap:.5rem; flex-wrap:wrap; }
    .vh-date { padding:.4rem .6rem; border:1px solid var(--border-color); border-radius:8px; background:var(--card-bg,#fff); color:var(--text,#1c1917); font-size:.85rem; }
    :host ::ng-deep .vh-select { min-width:220px; }
    .vh-empty { flex:1; display:flex; align-items:center; justify-content:center; color:var(--text-dim,#78716c); font-size:.9rem; text-align:center; padding:2rem; }
    .vh-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:.6rem; }
    .kpi { display:flex; flex-direction:column; gap:.1rem; padding:.7rem .85rem; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg,#fff); }
    .k-val { font:700 1.15rem/1.1 'Hanken Grotesk',sans-serif; color:var(--text,#1c1917); font-variant-numeric:tabular-nums; }
    .k-lbl { font-size:.72rem; color:var(--text-dim,#78716c); }
    .kpi-gap { border-color:#fecaca; background:#fef2f2; }
    .vh-note { font-size:.76rem; color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:.5rem .7rem; }
    .k-val small { font-size:.72rem; font-weight:600; color:#b91c1c; }
    .vh-dv { border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg,#fff); overflow:hidden; }
    .vh-dv-head { padding:.5rem .7rem; font:600 .8rem 'Hanken Grotesk',sans-serif; color:var(--text,#1c1917); border-bottom:1px solid var(--border-color); }
    .vh-dv-hint { font-weight:400; color:var(--text-dim,#78716c); font-size:.72rem; }
    .vh-dv-list { display:flex; flex-wrap:wrap; gap:.4rem; padding:.5rem .6rem; max-height:120px; overflow-y:auto; }
    .vh-dv-row { display:inline-flex; align-items:center; gap:.4rem; padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:999px; background:var(--hover,#f5f5f4); cursor:pointer; font-size:.76rem; color:var(--text,#1c1917); }
    .vh-dv-row .pi-check-circle { color:var(--ok-fg,#16a34a); }
    .vh-dv-row.gap { border-color:#fecaca; background:#fef2f2; }
    .vh-dv-row.gap .pi-exclamation-triangle { color:#d97706; }
    .vh-dv-store { font-weight:600; }
    .vh-dv-meta { color:var(--text-dim,#78716c); }
    .vh-dv-badge { font-size:.66rem; font-weight:700; text-transform:uppercase; color:var(--text-dim,#78716c); }
    .vh-dv-row.gap .vh-dv-badge { color:#b91c1c; }
    .vh-map { flex:1; min-height:0; }
    .vh-map app-map { display:block; height:100%; }
    :host ::ng-deep .vh-sk { display:block; margin-bottom:.6rem; }
    .vh-pb { display:flex; align-items:center; gap:.7rem; padding:.5rem .7rem; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg,#fff); }
    .pb-btn { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; flex:0 0 auto; border:0; border-radius:50%; background:var(--action,#F05A28); color:#fff; cursor:pointer; }
    .pb-range { flex:1; min-width:0; accent-color:var(--action,#F05A28); }
    .pb-clock { font:600 .78rem 'Hanken Grotesk',sans-serif; color:var(--text,#1c1917); font-variant-numeric:tabular-nums; min-width:58px; text-align:center; }
    .pb-speed { display:inline-flex; gap:.25rem; flex:0 0 auto; }
    .pb-speed button { font-size:.72rem; font-weight:600; padding:.2rem .45rem; border:1px solid var(--border-color); border-radius:6px; background:var(--card-bg,#fff); color:var(--text-dim,#78716c); cursor:pointer; }
    .pb-speed button.act { border-color:var(--action,#F05A28); color:var(--action,#F05A28); }
  `],
})
export class VendorHistoryComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  @ViewChild('map') map?: MapComponent;
  readonly today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  readonly speeds = [1, 2, 4];
  private static readonly DURATION_MS = 25_000; // día completo a 1× (~25s)

  readonly date = signal(this.today);
  readonly users = signal<FieldUser[]>([]);
  readonly loadingUsers = signal(false);
  readonly selectedUser = signal<string | null>(null);
  readonly day = signal<VendorDay | null>(null);
  readonly loadingDay = signal(false);

  // Playback (R.4): cursor a lo largo de la geometría por progreso 0..1.
  readonly playing = signal(false);
  readonly progress = signal(0);
  readonly speed = signal(1);
  private rafId: any = null;
  private lastTs = 0;

  readonly vendorOptions = computed(() =>
    this.users().map((u) => ({ label: `${u.username} (${u.ping_count})`, value: u.user_id })),
  );
  readonly selectedName = computed(
    () => this.users().find((u) => u.user_id === this.selectedUser())?.username || '',
  );

  /** Coordenadas [lng,lat] de la geometría snapped. */
  readonly coords = computed<[number, number][]>(
    () => (this.day()?.snapped?.geometry?.coordinates as [number, number][]) ?? [],
  );
  /** ¿El playback está en curso o scrubbeado? */
  readonly pbStarted = computed(() => this.playing() || this.progress() > 0);
  /** Índice del vértice donde está el cursor según el progreso. */
  readonly cursorIdx = computed(() => {
    const n = this.coords().length;
    if (n < 2) return 0;
    return Math.min(n - 1, Math.floor(this.progress() * (n - 1)));
  });
  /** Trazas del mapa: ruta completa; al reproducir, base tenue + tramo recorrido. */
  readonly mapTracks = computed(() => {
    const c = this.coords();
    if (!c.length) return [];
    const full = c.map((p) => ({ lat: p[1], lng: p[0] }));
    if (!this.pbStarted()) return [{ points: full, color: 'var(--action, #F05A28)' }];
    const revealed = full.slice(0, this.cursorIdx() + 1);
    return [
      { points: full, color: 'var(--neutral-300, #d6d3d1)' },
      { points: revealed, color: 'var(--action, #F05A28)' },
    ];
  });
  /** Cursor (camión) en la posición actual — capa persistente (se mueve en sitio). */
  readonly cursorLayer = computed<MapLayer[]>(() => {
    if (!this.pbStarted()) return [];
    const c = this.coords();
    if (!c.length) return [];
    const p = c[this.cursorIdx()];
    return [{
      id: 'pb',
      persistent: true,
      visible: true,
      markers: [{ id: 'cursor', lat: p[1], lng: p[0], kind: 'truck', color: 'var(--action, #F05A28)', title: this.clockLabel() }],
    }];
  });
  readonly stopMarkers = computed<MapMarker[]>(() =>
    (this.day()?.snapped?.stops || []).map((s, i) => ({
      lat: s.lat,
      lng: s.lng,
      seq: i + 1,
      color: 'var(--warn-fg, #d97706)',
      title: `Parada ${i + 1} · ${s.minutes} min${s.store_name ? ' · ' + s.store_name : ''}`,
    })),
  );
  /** Hora aproximada mapeando el progreso a [primer, último] fix. */
  readonly clockLabel = computed(() => {
    const k = this.day()?.kpis;
    if (!k?.first_at || !k?.last_at) return '';
    const f = new Date(k.first_at).getTime();
    const l = new Date(k.last_at).getTime();
    const t = f + this.progress() * (l - f);
    return '~' + new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  });

  private route = inject(ActivatedRoute);

  ngOnInit(): void {
    // Prefill por query-params (deep-link desde el SidePeek de Mapa en Vivo).
    const qp = this.route.snapshot.queryParamMap;
    const qpDate = qp.get('date');
    const qpUser = qp.get('user_id');
    if (qpDate) this.date.set(qpDate);
    this.loadUsers();
    if (qpUser) { this.selectedUser.set(qpUser); this.loadDay(); }
  }

  ngOnDestroy(): void {
    this.pause();
  }

  togglePlay(): void {
    this.playing() ? this.pause() : this.play();
  }

  private play(): void {
    if (this.coords().length < 2) return;
    if (this.progress() >= 1) this.progress.set(0); // reiniciar si terminó
    this.playing.set(true);
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.step);
  }

  private pause(): void {
    this.playing.set(false);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private step = (ts: number): void => {
    if (!this.playing()) return;
    if (!this.lastTs) this.lastTs = ts;
    const dt = ts - this.lastTs;
    this.lastTs = ts;
    const inc = dt / (VendorHistoryComponent.DURATION_MS / this.speed());
    const p = this.progress() + inc;
    if (p >= 1) { this.progress.set(1); this.pause(); return; }
    this.progress.set(p);
    this.rafId = requestAnimationFrame(this.step);
  };

  onScrub(e: Event): void {
    if (this.playing()) this.pause();
    this.progress.set(Number((e.target as HTMLInputElement).value) / 1000);
  }

  setSpeed(s: number): void {
    this.speed.set(s);
  }

  private resetPlayback(): void {
    this.pause();
    this.progress.set(0);
    this.speed.set(1);
  }

  onDate(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    if (!v) return;
    this.date.set(v);
    this.selectedUser.set(null);
    this.day.set(null);
    this.resetPlayback();
    this.loadUsers();
  }

  onVendor(userId: string): void {
    this.selectedUser.set(userId);
    if (userId) this.loadDay();
  }

  private loadUsers(): void {
    this.loadingUsers.set(true);
    const params = new HttpParams().set('date', this.date());
    this.http
      .get<{ users: FieldUser[] }>(`${environment.apiUrl}/reports/field-users`, { params })
      .subscribe({
        next: (r) => { this.users.set(r?.users || []); this.loadingUsers.set(false); },
        error: () => { this.users.set([]); this.loadingUsers.set(false); },
      });
  }

  private loadDay(): void {
    const userId = this.selectedUser();
    if (!userId) return;
    this.loadingDay.set(true);
    this.day.set(null);
    this.resetPlayback();
    const params = new HttpParams().set('user_id', userId).set('date', this.date());
    this.http
      .get<VendorDay>(`${environment.apiUrl}/reports/vendor-day`, { params })
      .subscribe({
        next: (r) => {
          this.day.set(r);
          this.loadingDay.set(false);
          // Re-encuadrar al nuevo recorrido (autoFit del átomo está en 'off').
          setTimeout(() => this.map?.recenter(), 0);
        },
        error: () => { this.loadingDay.set(false); },
      });
  }

  panToVisit(d: DetectedVisit): void {
    this.map?.panTo(d.lat, d.lng, 16);
  }

  fmtMin(min: number | null | undefined): string {
    const m = Math.round(min || 0);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  fmtTime(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}
