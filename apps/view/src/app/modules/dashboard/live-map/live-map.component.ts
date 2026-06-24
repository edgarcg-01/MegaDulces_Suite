import {
  AfterViewInit,
  Component,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClient, HttpParams } from '@angular/common/http';
import { MapComponent, MapLayer, MapMarker } from '../../../shared/components/map/map.component';
import { MapLegendComponent, LegendLayer } from '../../../shared/components/map-legend/map-legend.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { FieldAlert, WebSocketService } from '../../../core/services/websocket.service';
import { environment } from '../../../../environments/environment';
import { LivePosition, MapLiveLayerService } from '../../../core/services/map-live-layer.service';

interface StoreGeo { id: string; nombre: string; lat: number; lng: number; }
interface VendorDayKpis {
  distance_km: number; stop_count: number; stop_min: number; moving_min: number;
  avg_speed_kmh: number | null; first_at: string | null; last_at: string | null;
}

/**
 * Mapa en Vivo — cockpit de supervisión. Sobre el tracking en vivo agrega:
 *  - clic en una persona → SidePeek con detalle + KPIs GPS de hoy + acciones,
 *  - trail del día del seleccionado (recorrido por calles + paradas) sobre el mapa,
 *  - capa de Tiendas (contexto), y estado por persona (en tienda/traslado/detenido)
 *    + búsqueda en la lista. Todo reusa el átomo app-map, MapLiveLayerService,
 *    SidePeek y el endpoint vendor-day.
 */
@Component({
  selector: 'app-live-map',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, MapComponent, MapLegendComponent, SidePeekComponent],
  providers: [MapLiveLayerService],
  template: `
    <div class="lm-wrap">
      <header class="lm-head">
        <div class="lm-headline">
          <h1 class="lm-title">Mapa en vivo</h1>
          <p class="lm-sub">Personal de campo en tiempo real</p>
        </div>
        <div class="lm-stats">
          <span class="chip on">{{ svc.counts().online }} <span class="chip-lbl">en línea</span></span>
          <span class="chip idle">{{ svc.counts().idle }} <span class="chip-lbl">inactivos</span></span>
          <span class="chip stale">{{ svc.counts().stale }} <span class="chip-lbl">sin señal</span></span>
          <span class="ws" [class.ok]="ws.connected()" [title]="ws.connected() ? 'WS conectado' : 'WS desconectado'"></span>
          <button class="recenter" (click)="recenter()">Centrar</button>
        </div>
      </header>

      <nav class="lm-tabs">
        <button [class.act]="mobileTab() === 'map'" (click)="setTab('map')">Mapa</button>
        <button [class.act]="mobileTab() === 'list'" (click)="setTab('list')">Lista ({{ svc.counts().total }})</button>
      </nav>

      <div class="lm-body" [class.tab-map]="mobileTab() === 'map'" [class.tab-list]="mobileTab() === 'list'">
        <aside class="lm-list">
          @if (activeAlerts().length) {
            <div class="lm-alerts">
              @for (a of activeAlerts(); track a.userId + a.type) {
                <button class="al" [class.off]="a.type === 'offline'" (click)="focusAlert(a)">
                  <i class="pi" [class.pi-clock]="a.type === 'idle'" [class.pi-wifi]="a.type === 'offline'" aria-hidden="true"></i>
                  <span class="al-txt"><b>{{ a.username }}</b> {{ a.type === 'idle' ? 'detenido' : 'sin señal' }} {{ a.minutes }} min</span>
                  <i class="pi pi-times al-x" (click)="dismissAlert(a, $event)" aria-hidden="true"></i>
                </button>
              }
            </div>
          }
          <input class="lm-search" type="search" placeholder="Buscar persona…" [ngModel]="search()" (ngModelChange)="search.set($event)" />
          @if (filtered().length === 0) {
            <p class="empty">{{ svc.positions().length === 0 ? 'Sin personal reportando posición.' : 'Sin coincidencias.' }}</p>
          }
          @for (p of filtered(); track p.user_id) {
            <button class="row" [class.sel]="selected() === p.user_id" (click)="focus(p)">
              <span class="dot" [style.background]="color(p)"></span>
              <span class="who">
                <span class="name">
                  @if (alertedUsers().has(p.user_id)) { <i class="pi pi-exclamation-triangle al-flag" aria-hidden="true"></i> }
                  {{ p.username }}
                </span>
                <span class="meta">{{ statusOf(p).label }} · {{ svc.ageLabel(p) }}</span>
              </span>
              @if (selected() === p.user_id) { <span class="watching">observando</span> }
            </button>
          }
        </aside>
        <div class="lm-map-col">
          <div class="lm-legend">
            <app-map-legend [layers]="legend()" (toggle)="onToggle($event)"></app-map-legend>
          </div>
          <app-map #map [layers]="mapLayers()" autoFit="once" height="100%" (markerClick)="onMarkerClick($event)"></app-map>
        </div>
      </div>
    </div>

    <app-side-peek [open]="!!selected()" [title]="selectedName()" [subtitle]="selectedSubtitle()" (openChange)="onPeekChange($event)">
      @if (selectedPos(); as p) {
        <div class="sp-status" [class]="'st-' + statusOf(p).cls">{{ statusOf(p).label }}</div>
        <dl class="sp-grid">
          <div><dt>Última señal</dt><dd>{{ svc.ageLabel(p) }}</dd></div>
          <div><dt>Velocidad</dt><dd>{{ p.speed_mps != null ? kmh(p.speed_mps) + ' km/h' : '—' }}</dd></div>
        </dl>
        <h4 class="sp-h">Hoy (GPS)</h4>
        @if (trailLoading()) {
          <p class="sp-muted">Calculando recorrido…</p>
        } @else {
          @if (selectedKpis(); as k) {
            <dl class="sp-grid">
              <div><dt>Distancia</dt><dd>{{ k.distance_km }} km</dd></div>
              <div><dt>Paradas</dt><dd>{{ k.stop_count }}</dd></div>
              <div><dt>En movimiento</dt><dd>{{ fmtMin(k.moving_min) }}</dd></div>
              <div><dt>En paradas</dt><dd>{{ fmtMin(k.stop_min) }}</dd></div>
            </dl>
          } @else {
            <p class="sp-muted">Sin recorrido GPS hoy.</p>
          }
        }
        <a class="sp-action" [routerLink]="['/dashboard/field-map']" [queryParams]="{ view: 'vendedor', user_id: p.user_id, date: today }">
          <i class="pi pi-history" aria-hidden="true"></i>&nbsp;Ver recorrido del día
        </a>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display:block; }
    .lm-wrap { display:flex; flex-direction:column; height:calc(100vh - var(--app-header-h, 56px)); min-height:420px; }
    .lm-head { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-3) var(--sp-4); padding:var(--sp-3) var(--sp-4); border-bottom:1px solid var(--border-color); flex-wrap:wrap; }
    .lm-headline { min-width:0; }
    .lm-title { font:700 1.05rem/1.2 'Hanken Grotesk',sans-serif; margin:0; color:var(--text-main); }
    .lm-sub { margin:.1rem 0 0; font-size:.78rem; color:var(--text-muted); }
    .lm-stats { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .chip { font-size:.72rem; font-weight:600; padding:.2rem var(--sp-2); border-radius:999px; white-space:nowrap; }
    .chip.on { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .chip.idle { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .chip.stale { background:var(--neutral-100); color:var(--text-muted); }
    .ws { width:9px; height:9px; border-radius:50%; background:var(--bad-fg); flex:0 0 auto; }
    .ws.ok { background:var(--ok-fg); }
    .recenter { font-size:.72rem; padding:var(--sp-1) var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-sm); background:var(--card-bg); color:var(--text-main); cursor:pointer; }
    .recenter:hover { background:var(--surface-hover-bg); }
    .lm-tabs { display:none; }
    .lm-tabs button { flex:1; padding:var(--sp-2); border:0; background:var(--card-bg); font:600 .85rem 'Hanken Grotesk',sans-serif; color:var(--text-muted); border-bottom:2px solid transparent; cursor:pointer; }
    .lm-tabs button.act { color:var(--action); border-bottom-color:var(--action); }
    .lm-body { flex:1; display:flex; min-height:0; }
    .lm-list { width:280px; flex:0 0 280px; overflow-y:auto; border-right:1px solid var(--border-color); padding:var(--sp-2); -webkit-overflow-scrolling:touch; }
    .lm-search { width:100%; box-sizing:border-box; margin-bottom:var(--sp-2); padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-sm); background:var(--card-bg); color:var(--text-main); font-size:.82rem; }
    .lm-search:focus-visible { outline:none; border-color:var(--action); box-shadow:0 0 0 3px var(--action-ring); }
    .lm-alerts { display:flex; flex-direction:column; gap:var(--sp-1); margin-bottom:var(--sp-2); }
    .al { display:flex; align-items:center; gap:var(--sp-2); width:100%; text-align:left; padding:var(--sp-2); border:1px solid var(--warn-border); border-radius:var(--r-sm); background:var(--warn-soft-bg); color:var(--warn-soft-fg); font-size:.76rem; cursor:pointer; }
    .al.off { border-color:var(--bad-border); background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .al-txt { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .al-x { opacity:.6; }
    .al-x:hover { opacity:1; }
    .al-flag { color:var(--warn-fg); font-size:.7rem; margin-right:.15rem; }
    .lm-map-col { flex:1; min-width:0; display:flex; flex-direction:column; }
    .lm-legend { padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border-color); }
    .lm-map-col app-map { display:block; flex:1; min-height:0; }
    .empty { font-size:.8rem; color:var(--text-muted); padding:var(--sp-4); }
    .row { display:flex; align-items:center; gap:var(--sp-2); width:100%; text-align:left; padding:var(--sp-2); border:0; border-radius:var(--r-sm); background:transparent; cursor:pointer; min-height:44px; }
    .row:hover { background:var(--surface-hover-bg); }
    .row.sel { background:var(--surface-selected-bg); }
    .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; box-shadow:0 0 0 3px rgba(0,0,0,.04); }
    .who { display:flex; flex-direction:column; min-width:0; flex:1; }
    .name { font-size:.84rem; font-weight:600; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .meta { font-size:.72rem; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .watching { font-size:.65rem; font-weight:700; color:var(--action); text-transform:uppercase; }
    /* SidePeek */
    .sp-status { display:inline-block; font:700 .8rem 'Hanken Grotesk',sans-serif; padding:var(--sp-1) var(--sp-3); border-radius:999px; margin-bottom:var(--sp-4); }
    .sp-status.st-moving { background:var(--info-soft-bg); color:var(--info-soft-fg); }
    .sp-status.st-instore { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .sp-status.st-idle { background:var(--neutral-100); color:var(--text-muted); }
    .sp-grid { display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-3); margin:0 0 var(--sp-4); }
    .sp-grid dt { font-size:.7rem; color:var(--text-muted); }
    .sp-grid dd { margin:.1rem 0 0; font:700 1rem 'Hanken Grotesk',sans-serif; color:var(--text-main); font-variant-numeric:tabular-nums; }
    .sp-h { margin:var(--sp-3) 0 var(--sp-2); font:700 .8rem 'Hanken Grotesk',sans-serif; color:var(--text-main); }
    .sp-muted { font-size:.8rem; color:var(--text-muted); }
    .sp-action { display:inline-flex; align-items:center; margin-top:var(--sp-2); padding:var(--sp-2) var(--sp-3); border-radius:var(--r-sm); background:var(--btn-primary-bg); color:var(--btn-primary-ink); font:600 .82rem 'Hanken Grotesk',sans-serif; text-decoration:none; }
    .sp-action:hover { background:var(--btn-primary-bg-hover); }
    @media (max-width: 767px) {
      .lm-head { padding:var(--sp-2) var(--sp-3); }
      .lm-sub { display:none; }
      .chip-lbl { display:none; }
      .lm-tabs { display:flex; border-bottom:1px solid var(--border-color); }
      .lm-body.tab-map .lm-list { display:none; }
      .lm-body.tab-list .lm-map-col { display:none; }
      .lm-list { width:100%; flex:1 1 auto; border-right:0; }
    }
  `],
})
export class LiveMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('map') map!: MapComponent;
  protected svc = inject(MapLiveLayerService);
  protected ws = inject(WebSocketService);
  private http = inject(HttpClient);
  readonly today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

  private watchTimer: any = null;
  private onResize = () => this.map?.invalidate();
  private alertSub: { unsubscribe(): void } | null = null;
  protected selected = signal<string | null>(null);
  protected mobileTab = signal<'map' | 'list'>('map');
  protected search = signal('');

  // Alertas en vivo (detenido demasiado / sin señal), upsert por usuario+tipo.
  private static readonly ALERT_TTL_MS = 20 * 60_000;
  private rawAlerts = signal<FieldAlert[]>([]);
  protected activeAlerts = computed(() => {
    const cutoff = this.svc.now() - LiveMapComponent.ALERT_TTL_MS;
    return this.rawAlerts()
      .filter((a) => new Date(a.at).getTime() >= cutoff)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  });
  protected alertedUsers = computed(() => new Set(this.activeAlerts().map((a) => a.userId)));

  // Capas de contexto.
  private stores = signal<StoreGeo[]>([]);
  protected showStores = signal(false);
  protected showPersonal = signal(true);
  // Trail del seleccionado (recorrido de hoy).
  private trail = signal<{ points: { lat: number; lng: number }[]; color?: string }[]>([]);
  private trailStops = signal<MapMarker[]>([]);
  protected trailLoading = signal(false);
  protected selectedKpis = signal<VendorDayKpis | null>(null);

  protected selectedPos = computed(() => this.svc.positions().find((p) => p.user_id === this.selected()) || null);
  protected selectedName = computed(() => this.selectedPos()?.username || '');
  protected selectedSubtitle = computed(() => {
    const p = this.selectedPos();
    return p ? `${this.statusOf(p).label} · ${this.svc.ageLabel(p)}` : null;
  });

  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const order = { online: 0, idle: 1, stale: 2 };
    return [...this.svc.positions()]
      .filter((p) => !q || p.username.toLowerCase().includes(q))
      .sort((a, b) => order[this.svc.freshness(a)] - order[this.svc.freshness(b)] || a.username.localeCompare(b.username));
  });

  protected legend = computed<LegendLayer[]>(() => [
    { id: 'personal', label: 'Personal', color: 'var(--ok-fg, #16a34a)', count: this.svc.counts().total, visible: this.showPersonal() },
    { id: 'stores', label: 'Tiendas', color: 'var(--neutral-400, #9ca3af)', count: this.stores().length, visible: this.showStores() },
  ]);

  private storeMarkers = computed<MapMarker[]>(() =>
    this.stores().map((s) => ({ id: 's:' + s.id, lat: s.lat, lng: s.lng, kind: 'pin', color: 'var(--neutral-400, #9ca3af)', title: s.nombre })),
  );

  protected mapLayers = computed<MapLayer[]>(() => {
    const layers: MapLayer[] = [];
    if (this.showStores()) layers.push({ id: 'stores', visible: true, markers: this.storeMarkers() });
    if (this.selected() && (this.trail().length || this.trailStops().length))
      layers.push({ id: 'trail', visible: true, tracks: this.trail(), markers: this.trailStops() });
    if (this.showPersonal()) layers.push({ id: 'live', persistent: true, visible: true, markers: this.svc.markers() });
    return layers;
  });

  ngAfterViewInit(): void {
    window.addEventListener('resize', this.onResize);
    void this.svc.start();
    this.loadStores();
    // Alertas en vivo: upsert por (usuario, tipo); el TTL las purga vía activeAlerts().
    this.alertSub = this.ws.fieldAlert.subscribe((a) => {
      const key = (x: FieldAlert) => `${x.userId}:${x.type}`;
      const next = this.rawAlerts().filter((x) => key(x) !== key(a));
      next.push(a);
      this.rawAlerts.set(next.slice(-20));
    });
  }

  /** Foco desde una alerta: si la persona está en el mapa la selecciona; si no, paneo. */
  protected focusAlert(a: FieldAlert): void {
    const p = this.svc.positions().find((x) => x.user_id === a.userId);
    if (p) this.focus(p);
    else if (a.lat != null && a.lng != null) { this.setTab('map'); this.map?.panTo(a.lat, a.lng); }
  }

  protected dismissAlert(a: FieldAlert, ev: Event): void {
    ev.stopPropagation();
    const key = `${a.userId}:${a.type}`;
    this.rawAlerts.set(this.rawAlerts().filter((x) => `${x.userId}:${x.type}` !== key));
  }

  protected setTab(tab: 'map' | 'list'): void {
    this.mobileTab.set(tab);
    if (tab === 'map') setTimeout(() => this.map?.invalidate(), 0);
  }

  protected color(p: LivePosition): string {
    const f = this.svc.freshness(p);
    return f === 'online' ? 'var(--ok-fg)' : f === 'idle' ? 'var(--warn-fg)' : 'var(--neutral-400)';
  }

  protected kmh(mps: number): number {
    return Math.round(mps * 3.6);
  }

  protected fmtMin(min: number | null | undefined): string {
    const m = Math.round(min || 0);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /** Estado en vivo: en traslado (con velocidad) / en tienda (geofence) / detenido. */
  protected statusOf(p: LivePosition): { label: string; cls: 'moving' | 'instore' | 'idle' } {
    if (p.speed_mps != null && p.speed_mps > 1.4) return { label: 'En traslado', cls: 'moving' };
    const near = this.nearestStore(p.lat, p.lng);
    if (near && near.d <= 80) return { label: 'En ' + near.name, cls: 'instore' };
    return { label: 'Detenido', cls: 'idle' };
  }

  private nearestStore(lat: number, lng: number): { name: string; d: number } | null {
    let best: { name: string; d: number } | null = null;
    for (const s of this.stores()) {
      const d = LiveMapComponent.haversineM(lat, lng, s.lat, s.lng);
      if (!best || d < best.d) best = { name: s.nombre, d };
    }
    return best;
  }

  protected onMarkerClick(m: MapMarker): void {
    if (m.kind !== 'user') return; // tiendas/paradas no abren detalle
    const p = this.svc.positions().find((x) => x.user_id === m.id);
    if (p) this.focus(p);
  }

  protected onToggle(id: string): void {
    if (id === 'stores') this.showStores.update((v) => !v);
    else if (id === 'personal') this.showPersonal.update((v) => !v);
  }

  protected focus(p: LivePosition): void {
    const id = this.selected() === p.user_id ? null : p.user_id;
    this.selected.set(id);
    this.svc.watch(id ? [id] : []);
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    if (id) {
      this.watchTimer = setInterval(() => this.svc.watch([id]), 60_000);
      this.loadTrail(id);
      if (this.mobileTab() !== 'map') { this.setTab('map'); setTimeout(() => this.map?.panTo(p.lat, p.lng), 0); }
      else this.map?.panTo(p.lat, p.lng);
    } else {
      this.clearTrail();
    }
  }

  protected onPeekChange(open: boolean): void {
    if (!open && this.selected()) {
      this.selected.set(null);
      this.svc.watch([]);
      if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
      this.clearTrail();
    }
  }

  protected recenter(): void {
    this.map?.recenter();
  }

  private loadStores(): void {
    this.http.get<{ stores: StoreGeo[] }>(`${environment.apiUrl}/reports/stores-geo`).subscribe({
      next: (r) => this.stores.set(r?.stores || []),
      error: () => this.stores.set([]),
    });
  }

  private loadTrail(userId: string): void {
    this.trailLoading.set(true);
    this.clearTrail();
    const params = new HttpParams().set('user_id', userId).set('date', this.today);
    this.http.get<any>(`${environment.apiUrl}/reports/vendor-day`, { params }).subscribe({
      next: (r) => {
        const coords = r?.snapped?.geometry?.coordinates as [number, number][] | undefined;
        if (coords?.length)
          this.trail.set([{ points: coords.map((c) => ({ lat: c[1], lng: c[0] })), color: 'var(--action, #F05A28)' }]);
        this.trailStops.set(
          (r?.snapped?.stops || []).map((s: any, i: number) => ({
            lat: s.lat, lng: s.lng, seq: i + 1, color: 'var(--warn-fg, #d97706)',
            title: `Parada ${i + 1} · ${s.minutes} min${s.store_name ? ' · ' + s.store_name : ''}`,
          })),
        );
        this.selectedKpis.set(r?.kpis || null);
        this.trailLoading.set(false);
      },
      error: () => { this.trailLoading.set(false); },
    });
  }

  private clearTrail(): void {
    this.trail.set([]);
    this.trailStops.set([]);
    this.selectedKpis.set(null);
  }

  private static haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    this.alertSub?.unsubscribe();
    this.svc.watch([]);
    this.svc.stop();
  }
}
