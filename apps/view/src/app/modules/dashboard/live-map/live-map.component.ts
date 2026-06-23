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
import { MapComponent, MapLayer, MapMarker } from '../../../shared/components/map/map.component';
import { WebSocketService } from '../../../core/services/websocket.service';
import { LivePosition, MapLiveLayerService } from '../../../core/services/map-live-layer.service';

/**
 * Mapa en vivo del personal de campo. Tras la migración a MapKit, delega el
 * Leaflet al átomo `app-map` (capa `persistent` que mueve los marcadores en
 * sitio) y el estado a `MapLiveLayerService`. Mantiene el panel lateral, los
 * tabs móviles, la observación on-demand (watch + heartbeat) y el toggle de
 * capa vía la leyenda compartida.
 */
@Component({
  selector: 'app-live-map',
  standalone: true,
  imports: [CommonModule, MapComponent],
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
            <button class="row" [class.sel]="selected() === p.user_id" (click)="focus(p)">
              <span class="dot" [style.background]="color(p)"></span>
              <span class="who">
                <span class="name">{{ p.username }}</span>
                <span class="meta">{{ svc.ageLabel(p) }}{{ p.speed_mps != null ? ' · ' + kmh(p.speed_mps) + ' km/h' : '' }}</span>
              </span>
              @if (selected() === p.user_id) { <span class="watching">observando</span> }
            </button>
          }
        </aside>
        <div class="lm-map-col">
          <app-map
            #map
            [layers]="mapLayers()"
            autoFit="once"
            height="100%"
            (markerClick)="onMarkerClick($event)"
          ></app-map>
        </div>
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
    .lm-tabs { display:none; }
    .lm-tabs button { flex:1; padding:.6rem; border:0; background:var(--card-bg,#fff); font:600 .85rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); border-bottom:2px solid transparent; cursor:pointer; }
    .lm-tabs button.act { color:var(--action,#F05A28); border-bottom-color:var(--action,#F05A28); }
    .lm-body { flex:1; display:flex; min-height:0; }
    .lm-list { width:280px; flex:0 0 280px; overflow-y:auto; border-right:1px solid var(--divider,#e7e5e4); padding:.4rem; -webkit-overflow-scrolling:touch; }
    .lm-map-col { flex:1; min-width:0; }
    .lm-map-col app-map { display:block; height:100%; }
    .empty { font-size:.8rem; color:var(--text-dim,#78716c); padding:1rem; }
    .row { display:flex; align-items:center; gap:.55rem; width:100%; text-align:left; padding:.6rem .55rem; border:0; border-radius:8px; background:transparent; cursor:pointer; min-height:44px; }
    .row:hover { background:var(--hover,#f5f5f4); }
    .row.sel { background:var(--action-tint,#fff1ec); }
    .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; box-shadow:0 0 0 3px rgba(0,0,0,.04); }
    .who { display:flex; flex-direction:column; min-width:0; flex:1; }
    .name { font-size:.84rem; font-weight:600; color:var(--text,#1c1917); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .meta { font-size:.72rem; color:var(--text-dim,#78716c); }
    .watching { font-size:.65rem; font-weight:700; color:var(--action,#F05A28); text-transform:uppercase; }
    @media (max-width: 767px) {
      .lm-head { padding:.6rem .8rem; }
      .lm-sub { display:none; }
      .chip-lbl { display:none; }
      .lm-tabs { display:flex; border-bottom:1px solid var(--divider,#e7e5e4); }
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

  private watchTimer: any = null;
  private onResize = () => this.map?.invalidate();
  protected selected = signal<string | null>(null);
  protected mobileTab = signal<'map' | 'list'>('map');

  /** Una sola capa persistente con el personal en vivo. */
  protected mapLayers = computed<MapLayer[]>(() => [
    { id: 'live', label: 'Personal', persistent: true, visible: true, markers: this.svc.markers() },
  ]);

  ngAfterViewInit(): void {
    window.addEventListener('resize', this.onResize);
    void this.svc.start();
  }

  protected setTab(tab: 'map' | 'list'): void {
    this.mobileTab.set(tab);
    if (tab === 'map') setTimeout(() => this.map?.invalidate(), 0);
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
    const f = this.svc.freshness(p);
    return f === 'online' ? '#16a34a' : f === 'idle' ? '#d97706' : '#9ca3af';
  }

  protected kmh(mps: number): number {
    return Math.round(mps * 3.6);
  }

  protected onMarkerClick(m: MapMarker): void {
    const p = this.svc.positions().find((x) => x.user_id === m.id);
    if (p) this.focus(p);
  }

  protected focus(p: LivePosition): void {
    const id = this.selected() === p.user_id ? null : p.user_id;
    this.selected.set(id);
    this.svc.watch(id ? [id] : []);
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    if (id) {
      this.watchTimer = setInterval(() => this.svc.watch([id]), 60_000);
      if (this.mobileTab() !== 'map') { this.setTab('map'); setTimeout(() => this.map?.panTo(p.lat, p.lng), 0); }
      else this.map?.panTo(p.lat, p.lng);
    }
  }

  protected recenter(): void {
    this.map?.recenter();
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    this.svc.watch([]);
    this.svc.stop();
  }
}
