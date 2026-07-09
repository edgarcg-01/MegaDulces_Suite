import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { environment } from '../../../environments/environment';

export interface RiderMapPoint {
  lat: number;
  lng: number;
  label?: string; // número de secuencia o texto
  title?: string; // popup
  current?: boolean; // parada actual (resaltada)
}

/**
 * Fase LM.11 — Mapa INTERACTIVO del repartidor (Leaflet). Reemplaza la imagen
 * estática en la ruta guiada: dibuja el origen (tienda), las paradas numeradas,
 * la ruta y — clave — la POSICIÓN EN VIVO del repartidor (se actualiza con cada
 * fix del GPS). Así se orienta sin salir de la app; Waze/GMaps queda solo para
 * el trayecto manejado. Tiles Mapbox si hay token, si no OpenStreetMap.
 */
@Component({
  selector: 'app-rider-map',
  standalone: true,
  template: `<div #host class="rider-map" [style.height]="height"></div>`,
  styles: [`
    .rider-map { width: 100%; border-radius: 14px; overflow: hidden; border: 1px solid var(--border-color, #e5e5e5); z-index: 0; }
    :host ::ng-deep .rm-pin { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; color: #fff; font-weight: 700; font-size: .8rem; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
    :host ::ng-deep .rm-live { width: 18px; height: 18px; border-radius: 50%; background: #2563eb; border: 3px solid #fff; box-shadow: 0 0 0 4px rgba(37,99,235,.3); }
    :host ::ng-deep .rm-origin { background: #2563eb; }
  `],
})
export class RiderMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  @Input() height = '280px';
  @Input() origin: { lat: number; lng: number } | null = null;

  private _stops: RiderMapPoint[] = [];
  @Input() set stops(v: RiderMapPoint[]) { this._stops = v || []; this.redraw(); }
  get stops(): RiderMapPoint[] { return this._stops; }

  private _live: { lat: number; lng: number } | null = null;
  @Input() set live(v: { lat: number; lng: number } | null) { this._live = v; this.updateLive(); }

  private map: L.Map | null = null;
  private routeLayer: L.LayerGroup | null = null;
  private liveMarker: L.Marker | null = null;
  private fitted = false;

  ngAfterViewInit(): void {
    this.map = L.map(this.host.nativeElement, { zoomControl: true, attributionControl: false });
    const token = environment.mapbox?.token;
    const tiles = token
      ? L.tileLayer(
          `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`,
          { tileSize: 512, zoomOffset: -1, maxZoom: 19 },
        )
      : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
    tiles.addTo(this.map);
    this.map.setView([20.35, -102.03], 13); // La Piedad por default
    this.redraw();
    this.updateLive();
  }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }

  private pin(label: string, current: boolean): L.DivIcon {
    const bg = current ? 'var(--action, #ea580c)' : '#78716c';
    return L.divIcon({
      className: '',
      html: `<div class="rm-pin" style="background:${bg}">${label}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  private redraw(): void {
    if (!this.map) return;
    if (this.routeLayer) { this.routeLayer.remove(); this.routeLayer = null; }
    const group = L.layerGroup();
    const pts: L.LatLngExpression[] = [];

    if (this.origin) {
      const icon = L.divIcon({ className: '', html: `<div class="rm-pin rm-origin">🏪</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      L.marker([this.origin.lat, this.origin.lng], { icon }).addTo(group);
      pts.push([this.origin.lat, this.origin.lng]);
    }
    this._stops.forEach((s, i) => {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
      const m = L.marker([s.lat, s.lng], { icon: this.pin(s.label ?? String(i + 1), !!s.current) }).addTo(group);
      if (s.title) m.bindPopup(s.title);
      pts.push([s.lat, s.lng]);
    });
    if (pts.length >= 2) {
      L.polyline(pts, { color: '#ea580c', weight: 3, opacity: 0.6, dashArray: '6 6' }).addTo(group);
    }
    group.addTo(this.map);
    this.routeLayer = group;

    if (pts.length && !this.fitted) {
      this.map.fitBounds(L.latLngBounds(pts as L.LatLngTuple[]), { padding: [40, 40], maxZoom: 16 });
      this.fitted = true;
    }
  }

  private updateLive(): void {
    if (!this.map) return;
    if (!this._live) { this.liveMarker?.remove(); this.liveMarker = null; return; }
    const ll: L.LatLngExpression = [this._live.lat, this._live.lng];
    if (this.liveMarker) {
      this.liveMarker.setLatLng(ll);
    } else {
      const icon = L.divIcon({ className: '', html: `<div class="rm-live"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
      this.liveMarker = L.marker(ll, { icon, zIndexOffset: 1000 }).addTo(this.map);
    }
  }
}
