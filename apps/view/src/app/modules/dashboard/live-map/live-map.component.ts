import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as L from 'leaflet';
import { WebSocketService } from '../../../core/services/websocket.service';
import { LivePosition, LiveTrackingService } from './live-tracking.service';

const COLORS: Record<string, string> = {
  online: '#16a34a',
  idle: '#d97706',
  stale: '#9ca3af',
};

/**
 * Mapa en vivo del personal de campo (vendedores + colaboradores). Pinta un
 * marcador por usuario y lo MUEVE en sitio con cada `route_ping` (no redibuja
 * la capa entera → fluido). Color por frescura. El panel lateral permite
 * centrar y "observar" a un usuario (sube su cadencia on-demand vía WS).
 */
@Component({
  selector: 'app-live-map',
  standalone: true,
  imports: [CommonModule],
  providers: [LiveTrackingService],
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
        <button [class.act]="mobileTab() === 'list'" (click)="setTab('list')">
          Lista ({{ svc.counts().total }})
        </button>
      </nav>

      <div class="lm-body" [class.tab-map]="mobileTab() === 'map'" [class.tab-list]="mobileTab() === 'list'">
        <aside class="lm-list">
          @if (svc.positions().length === 0) {
            <p class="empty">Sin personal reportando posición en los últimos 30 min.</p>
          }
          @for (p of sorted(); track p.user_id) {
            <button
              class="row"
              [class.sel]="selected() === p.user_id"
              (click)="focus(p)"
            >
              <span class="dot" [style.background]="color(p)"></span>
              <span class="who">
                <span class="name">{{ p.username }}</span>
                <span class="meta">{{ ageLabel(p) }}{{ p.speed_mps != null ? ' · ' + kmh(p.speed_mps) + ' km/h' : '' }}</span>
              </span>
              @if (selected() === p.user_id) { <span class="watching">observando</span> }
            </button>
          }
        </aside>
        <div #host class="lm-map isolate"></div>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .lm-wrap { display:flex; flex-direction:column; height:calc(100vh - var(--app-header-h, 56px)); min-height:420px; }
    .lm-head { display:flex; align-items:center; justify-content:space-between; gap:.75rem 1rem; padding:.75rem 1rem; border-bottom:1px solid var(--divider,#e7e5e4); flex-wrap:wrap; }
    .lm-headline { min-width:0; }
    .lm-title { font:700 1.05rem/1.2 'Hanken Grotesk',sans-serif; margin:0; color:var(--text,#1c1917); }
    .lm-sub { margin:.1rem 0 0; font-size:.78rem; color:var(--text-dim,#78716c); }
    .lm-stats { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .chip { font-size:.72rem; font-weight:600; padding:.2rem .5rem; border-radius:999px; white-space:nowrap; }
    .chip.on { background:#dcfce7; color:#15803d; }
    .chip.idle { background:#fef3c7; color:#b45309; }
    .chip.stale { background:#f3f4f6; color:#6b7280; }
    .ws { width:9px; height:9px; border-radius:50%; background:#b91c1c; flex:0 0 auto; }
    .ws.ok { background:#15803d; }
    .recenter { font-size:.72rem; padding:.25rem .6rem; border:1px solid var(--divider,#d6d3d1); border-radius:6px; background:var(--card-bg,#fff); color:var(--text,#1c1917); cursor:pointer; }

    /* Toggle Mapa/Lista — solo visible en móvil. */
    .lm-tabs { display:none; }
    .lm-tabs button { flex:1; padding:.6rem; border:0; background:var(--card-bg,#fff); font:600 .85rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); border-bottom:2px solid transparent; cursor:pointer; }
    .lm-tabs button.act { color:var(--action,#F05A28); border-bottom-color:var(--action,#F05A28); }

    .lm-body { flex:1; display:flex; min-height:0; }
    .lm-list { width:280px; flex:0 0 280px; overflow-y:auto; border-right:1px solid var(--divider,#e7e5e4); padding:.4rem; -webkit-overflow-scrolling:touch; }
    .empty { font-size:.8rem; color:var(--text-dim,#78716c); padding:1rem; }
    .row { display:flex; align-items:center; gap:.55rem; width:100%; text-align:left; padding:.6rem .55rem; border:0; border-radius:8px; background:transparent; cursor:pointer; min-height:44px; }
    .row:hover { background:var(--hover,#f5f5f4); }
    .row.sel { background:var(--action-tint,#fff1ec); }
    .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; box-shadow:0 0 0 3px rgba(0,0,0,.04); }
    .who { display:flex; flex-direction:column; min-width:0; flex:1; }
    .name { font-size:.84rem; font-weight:600; color:var(--text,#1c1917); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .meta { font-size:.72rem; color:var(--text-dim,#78716c); }
    .watching { font-size:.65rem; font-weight:700; color:var(--action,#F05A28); text-transform:uppercase; }
    .lm-map { flex:1; min-width:0; }

    @media (max-width: 767px) {
      .lm-head { padding:.6rem .8rem; }
      .lm-sub { display:none; }
      .chip-lbl { display:none; }            /* solo el número en pantallas chicas */
      .lm-tabs { display:flex; border-bottom:1px solid var(--divider,#e7e5e4); }
      /* Cada panel a pantalla completa según el tab activo. */
      .lm-body.tab-map .lm-list { display:none; }
      .lm-body.tab-list .lm-map { display:none; }
      .lm-list { width:100%; flex:1 1 auto; border-right:0; }
    }
  `],
})
export class LiveMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;
  protected svc = inject(LiveTrackingService);
  protected ws = inject(WebSocketService);

  private map: L.Map | null = null;
  private markers = new Map<string, L.Marker>();
  private fittedOnce = false;
  private watchTimer: any = null;
  private onResize = () => this.map?.invalidateSize();
  protected selected = signal<string | null>(null);
  /** Vista activa en móvil (en escritorio se muestran ambos paneles). */
  protected mobileTab = signal<'map' | 'list'>('map');

  constructor() {
    effect(() => {
      const positions = this.svc.positions();
      this.svc.now(); // recolorea al pasar el tiempo
      if (this.map) this.syncMarkers(positions);
    });
  }

  ngAfterViewInit(): void {
    this.map = L.map(this.host.nativeElement, {
      center: [19.7033, -101.1949],
      zoom: 12,
      scrollWheelZoom: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(this.map);
    setTimeout(() => this.map?.invalidateSize(), 0);
    window.addEventListener('resize', this.onResize);
    void this.svc.start();
  }

  /** Cambia de panel en móvil; al volver al mapa, Leaflet recalcula su tamaño. */
  protected setTab(tab: 'map' | 'list'): void {
    this.mobileTab.set(tab);
    if (tab === 'map') setTimeout(() => this.map?.invalidateSize(), 0);
  }

  protected sorted(): LivePosition[] {
    const order = { online: 0, idle: 1, stale: 2 };
    return [...this.svc.positions()].sort(
      (a, b) =>
        order[this.svc.freshness(a)] - order[this.svc.freshness(b)] ||
        a.username.localeCompare(b.username),
    );
  }

  protected color(p: LivePosition): string {
    return COLORS[this.svc.freshness(p)];
  }

  protected kmh(mps: number): number {
    return Math.round(mps * 3.6);
  }

  protected ageLabel(p: LivePosition): string {
    const sec = Math.max(0, Math.round((this.svc.now() - new Date(p.captured_at).getTime()) / 1000));
    if (sec < 60) return `hace ${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `hace ${min} min`;
    return `hace ${Math.round(min / 60)} h`;
  }

  protected focus(p: LivePosition): void {
    const id = this.selected() === p.user_id ? null : p.user_id;
    this.selected.set(id);
    this.ws.watchUsers(id ? [id] : []);
    // Heartbeat: refresca la observación antes de que expire el TTL del server.
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    if (id) {
      this.watchTimer = setInterval(() => this.ws.watchUsers([id]), 60_000);
      const center = () =>
        this.map?.setView([p.lat, p.lng], Math.max(this.map.getZoom(), 15));
      // En móvil saltar al mapa; centrar tras el invalidateSize (panel venía oculto).
      if (this.mobileTab() !== 'map') { this.setTab('map'); setTimeout(center, 0); }
      else center();
    }
  }

  protected recenter(): void {
    const pts = this.svc.positions().map((p) => [p.lat, p.lng] as [number, number]);
    if (pts.length === 1) this.map?.setView(pts[0], 15);
    else if (pts.length > 1) this.map?.fitBounds(L.latLngBounds(pts).pad(0.15));
  }

  private iconFor(p: LivePosition): L.DivIcon {
    const c = this.color(p);
    const ring = this.svc.freshness(p) === 'online' ? `0 0 0 5px ${c}33,` : '';
    const html = `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${c};color:#fff;font-size:13px;box-shadow:${ring}0 2px 6px rgba(0,0,0,.45);border:2.5px solid #fff"><i class="pi pi-user"></i></span>`;
    return L.divIcon({ html, className: '', iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  private syncMarkers(positions: LivePosition[]): void {
    if (!this.map) return;
    const seen = new Set<string>();
    for (const p of positions) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      seen.add(p.user_id);
      const existing = this.markers.get(p.user_id);
      if (existing) {
        existing.setLatLng([p.lat, p.lng]);
        existing.setIcon(this.iconFor(p));
        existing.setPopupContent(this.popup(p));
      } else {
        const marker = L.marker([p.lat, p.lng], { icon: this.iconFor(p) })
          .bindPopup(this.popup(p))
          .addTo(this.map);
        marker.on('click', () => this.focus(p));
        this.markers.set(p.user_id, marker);
      }
    }
    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) { marker.remove(); this.markers.delete(id); }
    }
    if (!this.fittedOnce && positions.length > 0) {
      this.fittedOnce = true;
      this.recenter();
    }
  }

  private popup(p: LivePosition): string {
    return `<b>${p.username}</b><br>${this.ageLabel(p)}${p.speed_mps != null ? ` · ${this.kmh(p.speed_mps)} km/h` : ''}`;
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    this.ws.watchUsers([]);
    this.svc.stop();
    this.map?.remove();
    this.map = null;
  }
}
