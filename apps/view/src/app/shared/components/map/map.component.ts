import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  input,
  effect,
  signal,
} from '@angular/core';
import * as L from 'leaflet';

export interface MapMarker {
  lat: number;
  lng: number;
  title?: string;
  /** color del pin (token CSS o hex); default brand. */
  color?: string;
  /** número de secuencia a mostrar dentro del pin (recorrido). */
  seq?: number;
}

/**
 * Mapa Leaflet reutilizable. Usa `divIcon` (marcadores por CSS) para evitar el
 * problema clásico de los iconos PNG de Leaflet bajo bundler. Tiles de
 * OpenStreetMap. Redibuja marcadores + polyline cuando cambian los inputs.
 */
@Component({
  selector: 'app-map',
  standalone: true,
  template: `<div #host [style.height]="height()" class="w-full rounded-lg overflow-hidden border border-divider"></div>`,
})
export class MapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  readonly markers = input<MapMarker[]>([]);
  /** puntos ordenados del recorrido; se dibuja una polyline que los une. */
  readonly path = input<{ lat: number; lng: number }[]>([]);
  readonly height = input<string>('420px');

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
      const color = m.color || 'var(--brand, #f97316)';
      const html = `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:11px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff">${m.seq ?? ''}</span>`;
      const icon = L.divIcon({ html, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
      const marker = L.marker([m.lat, m.lng], { icon });
      if (m.title) marker.bindPopup(m.title);
      marker.addTo(this.layer);
    }

    if (line.length >= 2) {
      L.polyline(
        line.map((p) => [p.lat, p.lng] as [number, number]),
        { color: 'var(--brand, #f97316)', weight: 3, opacity: 0.7, dashArray: '6 6' },
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
