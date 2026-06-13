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
} from '@angular/core';
import * as L from 'leaflet';

export interface MapMarker {
  lat: number;
  lng: number;
  title?: string;
  /** color del pin (token CSS o hex); default action (sunset). */
  color?: string;
  /** número de secuencia a mostrar dentro del pin (recorrido). */
  seq?: number;
  /** id opcional del marcador (ej. store_id) para resolver el click en el padre. */
  id?: string | number;
}

/**
 * Mapa Leaflet reutilizable. Usa `divIcon` (marcadores por CSS) para evitar el
 * problema clásico de los iconos PNG de Leaflet bajo bundler. Tiles de
 * OpenStreetMap. Redibuja marcadores + polyline cuando cambian los inputs.
 */
@Component({
  selector: 'app-map',
  standalone: true,
  // `isolate` (isolation: isolate) confina los z-index internos de Leaflet
  // (controles llegan a ~1000) a este contenedor para que NO pisen el sidebar.
  template: `<div #host [style.height]="height()" class="w-full rounded-lg overflow-hidden border border-divider isolate"></div>`,
})
export class MapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  readonly markers = input<MapMarker[]>([]);
  /** puntos ordenados del recorrido; se dibuja una polyline que los une. */
  readonly path = input<{ lat: number; lng: number }[]>([]);
  readonly height = input<string>('420px');
  /** emite al hacer click en un marcador (para master-detail en el padre). */
  readonly markerClick = output<MapMarker>();

  private map: L.Map | null = null;
  private layer: L.LayerGroup | null = null;
  private ready = signal(false);

  constructor() {
    // Redibuja cuando hay mapa listo y cambian markers/path.
    effect(() => {
      this.markers();
      this.path();
      if (this.ready()) this.render();
    });
  }

  ngAfterViewInit(): void {
    this.map = L.map(this.host.nativeElement, {
      center: [19.7033, -101.1949], // Morelia (fallback hasta fitBounds)
      zoom: 12,
      scrollWheelZoom: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
    this.ready.set(true);
    // Leaflet calcula mal el tamaño si el contenedor se montó oculto/animando.
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private render(): void {
    if (!this.map || !this.layer) return;
    this.layer.clearLayers();

    const pts = this.markers().filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
    const line = this.path().filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    for (const m of pts) {
      const color = m.color || 'var(--action, #F05A28)';
      const html = `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff">${m.seq ?? ''}</span>`;
      const icon = L.divIcon({ html, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
      const marker = L.marker([m.lat, m.lng], { icon });
      if (m.title) marker.bindPopup(m.title);
      marker.on('click', () => this.markerClick.emit(m));
      marker.addTo(this.layer);
    }

    if (line.length >= 2) {
      L.polyline(
        line.map((p) => [p.lat, p.lng] as [number, number]),
        { color: 'var(--action, #F05A28)', weight: 3, opacity: 0.7, dashArray: '6 6' },
      ).addTo(this.layer);
    }

    const all = [...pts.map((m) => [m.lat, m.lng] as [number, number]), ...line.map((p) => [p.lat, p.lng] as [number, number])];
    if (all.length === 1) {
      this.map.setView(all[0], 15);
    } else if (all.length > 1) {
      this.map.fitBounds(L.latLngBounds(all).pad(0.15));
    }
  }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }
}
