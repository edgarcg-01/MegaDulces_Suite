import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  input,
  output,
  effect,
  signal,
  inject,
} from '@angular/core';
import * as L from 'leaflet';
import { environment } from '../../../../environments/environment';
import { ThemeService } from '../../../core/services/theme.service';

export interface MapMarker {
  lat: number;
  lng: number;
  title?: string;
  /** color del pin (token CSS o hex); default action (sunset). */
  color?: string;
  /** número de secuencia a mostrar dentro del pin (recorrido). */
  seq?: number;
  /** id opcional del marcador (ej. store_id / user_id) para resolver el click + sync persistente. */
  id?: string | number;
  /** 'truck' vehículo, 'user' persona (tracking), 'pin' parada. */
  kind?: 'pin' | 'truck' | 'user';
  /** anillo glow (ej. usuario "en línea" en vivo). */
  ring?: boolean;
}

/**
 * Una capa conmutable del mapa. Cada capa vive en su propio L.LayerGroup, así
 * encender/apagar una NO redibuja las demás. `persistent:true` mueve los
 * marcadores en sitio (setLatLng) en vez de limpiar+redibujar — para tracking
 * en vivo fluido (los marcadores se identifican por `MapMarker.id`).
 */
export interface MapLayer {
  id: string;
  label?: string;
  markers?: MapMarker[];
  /** trazas GPS (una polyline sólida por elemento) con color propio. */
  tracks?: { points: { lat: number; lng: number }[]; color?: string }[];
  /** recorrido por paradas (polyline punteada). */
  path?: { lat: number; lng: number }[];
  visible?: boolean;
  persistent?: boolean;
}

/**
 * Mapa Leaflet reutilizable (átomo MapKit). Dos modos coexisten:
 *  - Legacy: inputs `markers`/`path`/`tracks` → una capa redibujada por completo
 *    en cada cambio (comportamiento histórico, intacto para routes/commercial).
 *  - Capas: input `layers` → cada capa en su LayerGroup, conmutable, con modo
 *    persistente opcional para tracking en vivo (marcadores que se mueven).
 * Usa `divIcon` (marcadores por CSS). Tiles de Mapbox (style según el tema
 * claro/oscuro) con switcher Mapa/Satélite; cae a OpenStreetMap si no hay token.
 */
@Component({
  selector: 'app-map',
  standalone: true,
  // `isolate` (isolation: isolate) confina los z-index internos de Leaflet
  // (controles llegan a ~1000) a este contenedor para que NO pisen el sidebar.
  template: `
    <div class="map-shell rounded-lg overflow-hidden border border-divider" [style.height]="height()">
      <div #host class="map-host isolate"></div>
      @if (mapboxEnabled && showBasemapToggle()) {
        <div class="basemap-switch" role="group" aria-label="Tipo de mapa">
          <button type="button" [class.act]="basemapMode() === 'map'" [attr.aria-pressed]="basemapMode() === 'map'" (click)="setBasemap('map')">
            <i class="pi pi-map" aria-hidden="true"></i><span>Mapa</span>
          </button>
          <button type="button" [class.act]="basemapMode() === 'satellite'" [attr.aria-pressed]="basemapMode() === 'satellite'" (click)="setBasemap('satellite')">
            <i class="pi pi-globe" aria-hidden="true"></i><span>Satélite</span>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .map-shell { position:relative; }
    .map-host { width:100%; height:100%; }
    .basemap-switch { position:absolute; top:.5rem; right:.5rem; z-index:500; display:flex; background:var(--card-bg,#fff); border:1px solid var(--border-color); border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.18); }
    .basemap-switch button { display:flex; align-items:center; gap:.3rem; border:0; background:transparent; padding:.34rem .56rem; font:600 .72rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); cursor:pointer; }
    .basemap-switch button + button { border-left:1px solid var(--border-color); }
    .basemap-switch button:hover { color:var(--text,#1c1917); }
    .basemap-switch button.act { background:var(--action,#F05A28); color:#fff; }
  `],
})
export class MapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  readonly markers = input<MapMarker[]>([]);
  /** puntos ordenados del recorrido; se dibuja una polyline que los une. */
  readonly path = input<{ lat: number; lng: number }[]>([]);
  /** trazas GPS independientes (una polyline sólida por vendedor) con color propio. */
  readonly tracks = input<{ points: { lat: number; lng: number }[]; color?: string }[]>([]);
  /** capas conmutables (MapKit). Vacío = solo modo legacy. */
  readonly layers = input<MapLayer[]>([]);
  readonly height = input<string>('420px');
  /** 'always' = re-encuadra en cada cambio (legacy); 'once' = solo al primer dato; 'off' = nunca. */
  readonly autoFit = input<'always' | 'once' | 'off'>('always');
  /**
   * Centro inicial mientras no hay datos que encuadrar — `fitBounds` lo pisa en
   * cuanto llegan markers/tracks. Default: La Piedad, Mich. Un consumidor puede
   * pasar otra cosa (ej. la última posición del usuario seleccionado).
   */
  readonly fallbackCenter = input<[number, number]>([20.2984, -101.9884]);
  /** Zoom del centro inicial (fallback). */
  readonly fallbackZoom = input<number>(12);
  /** emite al hacer click en un marcador (para master-detail en el padre). */
  readonly markerClick = output<MapMarker>();

  /**
   * Modo picker (selección de punto): habilita click en el mapa + un pin
   * arrastrable. Cada click o arrastre emite `mapClick` con la coordenada.
   * No afecta capas ni marcadores legacy.
   */
  readonly pickable = input<boolean>(false);
  /** Punto seleccionado (controlado por el padre; ej. resultado de geocoding). */
  readonly pickedPoint = input<{ lat: number; lng: number } | null>(null);
  /** emite al hacer click en el mapa o arrastrar el pin (modo picker). */
  readonly mapClick = output<{ lat: number; lng: number }>();

  private map: L.Map | null = null;
  private layer: L.LayerGroup | null = null; // capa legacy (markers/path/tracks)
  private groups = new Map<string, { group: L.LayerGroup; markers: Map<string | number, L.Marker> }>();
  private fitted = false;
  private ready = signal(false);

  /** Tema (claro/oscuro) → elige el style del basemap para respetar DESIGN.md. */
  private theme = inject(ThemeService);
  /** Hay token Mapbox → tiles Mapbox + switcher; sin token cae a OSM. */
  protected readonly mapboxEnabled = !!environment.mapbox?.token;
  /** Muestra el switcher Mapa/Satélite (solo con Mapbox). Ocultable por consumidor. */
  readonly showBasemapToggle = input<boolean>(true);
  /** Capa base actual: mapa temático vs satélite. */
  readonly basemapMode = signal<'map' | 'satellite'>('map');
  private baseTile?: L.TileLayer;
  private appliedStyle = '';
  private pickMarker: L.Marker | null = null;

  constructor() {
    effect(() => {
      this.markers();
      this.path();
      this.tracks();
      this.layers();
      if (this.ready()) this.render();
    });
    // Picker: refleja el punto controlado por el padre (geocoding) en el pin.
    effect(() => {
      const p = this.pickedPoint();
      if (this.ready() && this.pickable() && p) this.placePickMarker(p.lat, p.lng, true);
    });
    // Basemap reactivo: cambia con el tema (claro/oscuro) y el modo (mapa/satélite).
    effect(() => {
      this.theme.isMonochrome();
      this.basemapMode();
      if (this.ready()) this.setBaseLayer();
    });
  }

  ngAfterViewInit(): void {
    this.map = L.map(this.host.nativeElement, {
      center: this.fallbackCenter(), // default La Piedad, Mich. (fitBounds lo pisa con datos)
      zoom: this.fallbackZoom(),
      scrollWheelZoom: true,
    });
    this.setBaseLayer();
    this.layer = L.layerGroup().addTo(this.map);
    if (this.pickable()) {
      this.map.on('click', (e: L.LeafletMouseEvent) => {
        this.placePickMarker(e.latlng.lat, e.latlng.lng, false);
        this.mapClick.emit({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
      const p = this.pickedPoint();
      if (p) this.placePickMarker(p.lat, p.lng, true);
    }
    this.ready.set(true);
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  /** Coloca/mueve el pin arrastrable del picker. `pan`=centra el mapa en él. */
  private placePickMarker(lat: number, lng: number, pan: boolean): void {
    if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const icon = L.divIcon({
      html: `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:var(--action,#F05A28);color:#fff;box-shadow:0 2px 7px rgba(0,0,0,.45);border:2.5px solid #fff"><i class="pi pi-map-marker" style="transform:rotate(45deg)"></i></span>`,
      className: '', iconSize: [26, 26], iconAnchor: [13, 26],
    });
    if (this.pickMarker) {
      this.pickMarker.setLatLng([lat, lng]);
    } else {
      this.pickMarker = L.marker([lat, lng], { icon, draggable: true, zIndexOffset: 1200 }).addTo(this.map);
      this.pickMarker.on('dragend', () => {
        const ll = this.pickMarker!.getLatLng();
        this.mapClick.emit({ lat: ll.lat, lng: ll.lng });
      });
    }
    if (pan) this.map.setView([lat, lng], Math.max(this.map.getZoom(), 16));
  }

  /** Re-encuadra el mapa para mostrar todos los datos visibles. Público (botón "Centrar"). */
  recenter(): void {
    if (!this.map) return;
    const all = this.allCoords();
    if (all.length === 1) this.map.setView(all[0], 15);
    else if (all.length > 1) this.map.fitBounds(L.latLngBounds(all).pad(0.15));
  }

  invalidate(): void {
    this.map?.invalidateSize();
  }

  /** Centra el mapa en una coordenada (al seleccionar/observar un elemento). */
  panTo(lat: number, lng: number, minZoom = 15): void {
    if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    this.map.setView([lat, lng], Math.max(this.map.getZoom(), minZoom));
  }

  // ── basemap ────────────────────────────────────────────────────────────────
  /** Conmuta entre mapa temático y satélite. */
  setBasemap(mode: 'map' | 'satellite'): void {
    if (mode === this.basemapMode()) return;
    this.basemapMode.set(mode);
  }

  /** Style activo según token / modo / tema. '__osm__' = fallback sin token. */
  private currentStyle(): string {
    const mb = environment.mapbox;
    if (!mb?.token) return '__osm__';
    if (this.basemapMode() === 'satellite') return mb.styleSatellite || 'mapbox/satellite-streets-v12';
    return this.theme.isMonochrome() ? (mb.styleDark || 'mapbox/dark-v11') : (mb.styleLight || 'mapbox/light-v11');
  }

  private buildBaseLayer(style: string): L.TileLayer {
    if (style === '__osm__') {
      return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      });
    }
    const token = environment.mapbox!.token;
    return L.tileLayer(
      `https://api.mapbox.com/styles/v1/${style}/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`,
      { tileSize: 512, zoomOffset: -1, minZoom: 0, maxZoom: 22, attribution: '© Mapbox © OpenStreetMap' },
    );
  }

  /** (Re)aplica la capa base. Idempotente: no rehace si el style no cambió. */
  private setBaseLayer(): void {
    if (!this.map) return;
    const style = this.currentStyle();
    if (this.baseTile && style === this.appliedStyle) return;
    this.appliedStyle = style;
    if (this.baseTile) this.map.removeLayer(this.baseTile);
    this.baseTile = this.buildBaseLayer(style).addTo(this.map);
    this.baseTile.bringToBack();
  }

  // ── icono ────────────────────────────────────────────────────────────────
  private iconFor(m: MapMarker): L.DivIcon {
    const color = m.color || 'var(--action, #F05A28)';
    if (m.kind === 'truck') {
      const html = `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:${color};color:#fff;font-size:14px;box-shadow:0 2px 7px rgba(0,0,0,.5);border:2.5px solid #fff"><i class="pi pi-truck"></i></span>`;
      return L.divIcon({ html, className: '', iconSize: [30, 30], iconAnchor: [15, 15] });
    }
    if (m.kind === 'user') {
      const ring = m.ring ? `0 0 0 5px ${color}33,` : '';
      const html = `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${color};color:#fff;font-size:13px;box-shadow:${ring}0 2px 6px rgba(0,0,0,.45);border:2.5px solid #fff"><i class="pi pi-user"></i></span>`;
      return L.divIcon({ html, className: '', iconSize: [26, 26], iconAnchor: [13, 13] });
    }
    const html = `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff">${m.seq ?? ''}</span>`;
    return L.divIcon({ html, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
  }

  private makeMarker(m: MapMarker): L.Marker {
    const marker = L.marker([m.lat, m.lng], {
      icon: this.iconFor(m),
      zIndexOffset: m.kind === 'truck' || m.kind === 'user' ? 1000 : 0,
    });
    if (m.title) marker.bindPopup(m.title);
    marker.on('click', () => this.markerClick.emit(m));
    return marker;
  }

  private drawTracks(target: L.LayerGroup, tracks: { points: { lat: number; lng: number }[]; color?: string }[]): void {
    for (const t of tracks) {
      const tp = (t.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (tp.length >= 2) {
        L.polyline(
          tp.map((p) => [p.lat, p.lng] as [number, number]),
          { color: t.color || 'var(--action, #F05A28)', weight: 4, opacity: 0.85 },
        ).addTo(target);
      }
    }
  }

  private drawPath(target: L.LayerGroup, line: { lat: number; lng: number }[]): void {
    const pts = line.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length >= 2) {
      L.polyline(
        pts.map((p) => [p.lat, p.lng] as [number, number]),
        { color: 'var(--action, #F05A28)', weight: 3, opacity: 0.7, dashArray: '6 6' },
      ).addTo(target);
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  private render(): void {
    if (!this.map || !this.layer) return;
    this.renderLegacy();
    this.renderLayers();
    this.maybeFit();
  }

  private renderLegacy(): void {
    const layer = this.layer!;
    layer.clearLayers();
    const pts = this.markers().filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
    for (const m of pts) this.makeMarker(m).addTo(layer);
    this.drawPath(layer, this.path());
    this.drawTracks(layer, this.tracks());
  }

  private renderLayers(): void {
    const incoming = this.layers();
    // Eliminar grupos que ya no existen.
    for (const [id, entry] of this.groups) {
      if (!incoming.find((l) => l.id === id)) {
        entry.group.remove();
        this.groups.delete(id);
      }
    }
    for (const layer of incoming) {
      let entry = this.groups.get(layer.id);
      if (!entry) {
        entry = { group: L.layerGroup(), markers: new Map() };
        this.groups.set(layer.id, entry);
      }
      if (layer.visible === false) {
        if (this.map!.hasLayer(entry.group)) entry.group.remove();
        continue;
      }
      if (!this.map!.hasLayer(entry.group)) entry.group.addTo(this.map!);
      if (layer.persistent) this.syncPersistent(entry, layer);
      else this.redrawLayer(entry, layer);
    }
  }

  /** Capa no-persistente: limpia y redibuja (marcadores + tracks + path). */
  private redrawLayer(entry: { group: L.LayerGroup; markers: Map<string | number, L.Marker> }, layer: MapLayer): void {
    entry.group.clearLayers();
    entry.markers.clear();
    for (const m of (layer.markers || []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng))) {
      this.makeMarker(m).addTo(entry.group);
    }
    if (layer.tracks) this.drawTracks(entry.group, layer.tracks);
    if (layer.path) this.drawPath(entry.group, layer.path);
  }

  /** Capa persistente: mueve los marcadores existentes en sitio; agrega/quita por id. */
  private syncPersistent(entry: { group: L.LayerGroup; markers: Map<string | number, L.Marker> }, layer: MapLayer): void {
    const seen = new Set<string | number>();
    for (const m of (layer.markers || []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng))) {
      const key = m.id ?? `${m.lat},${m.lng}`;
      seen.add(key);
      const existing = entry.markers.get(key);
      if (existing) {
        existing.setLatLng([m.lat, m.lng]);
        existing.setIcon(this.iconFor(m));
        if (m.title) existing.setPopupContent(m.title);
      } else {
        const marker = this.makeMarker(m);
        marker.addTo(entry.group);
        entry.markers.set(key, marker);
      }
    }
    for (const [key, marker] of entry.markers) {
      if (!seen.has(key)) {
        marker.remove();
        entry.markers.delete(key);
      }
    }
  }

  private allCoords(): [number, number][] {
    const out: [number, number][] = [];
    const push = (lat: number, lng: number) => { if (Number.isFinite(lat) && Number.isFinite(lng)) out.push([lat, lng]); };
    for (const m of this.markers()) push(m.lat, m.lng);
    for (const p of this.path()) push(p.lat, p.lng);
    for (const t of this.tracks()) for (const p of t.points || []) push(p.lat, p.lng);
    for (const layer of this.layers()) {
      if (layer.visible === false) continue;
      for (const m of layer.markers || []) push(m.lat, m.lng);
      for (const p of layer.path || []) push(p.lat, p.lng);
      for (const t of layer.tracks || []) for (const p of t.points || []) push(p.lat, p.lng);
    }
    return out;
  }

  private maybeFit(): void {
    const mode = this.autoFit();
    if (mode === 'off') return;
    if (mode === 'once' && this.fitted) return;
    const all = this.allCoords();
    if (all.length === 0) return;
    this.fitted = true;
    if (all.length === 1) this.map!.setView(all[0], 15);
    else this.map!.fitBounds(L.latLngBounds(all).pad(0.15));
  }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }
}
