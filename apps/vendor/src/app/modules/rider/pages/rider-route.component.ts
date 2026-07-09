import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { environment } from '../../../../environments/environment';
import { RiderRoute, RiderRouteStop, RiderService } from '../rider.service';

/**
 * LM.10 — Ruta del repartidor: sus paradas pendientes de hoy en el mejor orden
 * de visita (open-route calculado en el backend). Muestra un mapa estático con
 * los pines numerados y, por parada, botones que abren Waze / Google Maps para
 * la navegación paso a paso real (el celular hace el turn-by-turn). Las paradas
 * sin ubicación se listan aparte (se navega por dirección de texto).
 */
@Component({
  selector: 'app-rider-route',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rt">
      <header class="rt-head">
        <h1>Mi ruta</h1>
        <button class="rt-refresh" (click)="load()" [disabled]="loading()" aria-label="Actualizar">
          <i class="pi" [ngClass]="loading() ? 'pi-spin pi-spinner' : 'pi-refresh'"></i>
        </button>
      </header>

      @if (route(); as r) {
        <div class="rt-summary">
          <div><b>{{ r.stops_count }}</b><span>paradas</span></div>
          <div><b>{{ r.total_km }}</b><span>km aprox.</span></div>
          @if (r.unlocated.length) { <div><b class="warn">{{ r.unlocated.length }}</b><span>sin ubicación</span></div> }
        </div>

        @if (mapUrl(); as url) {
          <img class="rt-map" [src]="url" alt="Mapa de la ruta" loading="lazy" />
        } @else if (r.stops.length) {
          <div class="rt-nomap">No se pudo cargar el mapa. Usá la lista de abajo.</div>
        }

        @if (r.stops.length) {
          <ol class="rt-list">
            @for (s of r.stops; track s.delivery_id) {
              <li class="rt-stop">
                <span class="rt-seq">{{ s.sequence_order }}</span>
                <div class="rt-info">
                  <div class="rt-name">{{ s.customer_name }}</div>
                  <div class="rt-addr">{{ s.street || 'Sin calle' }}</div>
                  <div class="rt-meta">
                    <span class="rt-folio">{{ s.folio }}</span>
                    @if (s.collect_on_delivery) { <span class="rt-cod">Cobrar {{ money(s.amount_to_collect) }}</span> }
                    @else { <span class="rt-paid">Pagado</span> }
                  </div>
                </div>
                <div class="rt-nav">
                  <a class="rt-btn waze" [href]="wazeUrl(s)" target="_blank" rel="noopener" aria-label="Abrir en Waze">Waze</a>
                  <a class="rt-btn gmaps" [href]="gmapsUrl(s)" target="_blank" rel="noopener" aria-label="Abrir en Google Maps">Maps</a>
                </div>
              </li>
            }
          </ol>
        }

        @if (r.unlocated.length) {
          <h2 class="rt-subtitle">Sin ubicación en mapa</h2>
          <ul class="rt-list plain">
            @for (s of r.unlocated; track s.delivery_id) {
              <li class="rt-stop">
                <span class="rt-seq off"><i class="pi pi-question"></i></span>
                <div class="rt-info">
                  <div class="rt-name">{{ s.customer_name }}</div>
                  <div class="rt-addr">{{ s.street || 'Sin calle' }}</div>
                  <div class="rt-meta"><span class="rt-folio">{{ s.folio }}</span></div>
                </div>
                <div class="rt-nav">
                  <a class="rt-btn gmaps" [href]="gmapsSearchUrl(s)" target="_blank" rel="noopener">Buscar</a>
                </div>
              </li>
            }
          </ul>
        }

        @if (!r.stops.length && !r.unlocated.length) {
          <div class="rt-empty"><i class="pi pi-check-circle"></i><p>No tenés entregas pendientes hoy.</p></div>
        }
      } @else if (!loading()) {
        <div class="rt-empty"><i class="pi pi-map"></i><p>Sin ruta cargada.</p></div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rt { padding: 1rem; max-width: 640px; margin: 0 auto; }
    .rt-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: .8rem; }
    .rt-head h1 { font-size: 1.15rem; font-weight: 700; margin: 0; }
    .rt-refresh { border: 1px solid var(--border-color, #e5e5e5); background: var(--card-bg, #fff); width: 38px; height: 38px; border-radius: 10px; color: var(--text-muted, #666); }
    .rt-summary { display: flex; gap: .6rem; margin-bottom: .9rem; }
    .rt-summary > div { flex: 1; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 12px; padding: .6rem; text-align: center; }
    .rt-summary b { display: block; font-size: 1.35rem; font-variant-numeric: tabular-nums; }
    .rt-summary b.warn { color: #b45309; }
    .rt-summary span { font-size: .72rem; color: var(--text-muted, #888); }
    .rt-map { width: 100%; border-radius: 14px; border: 1px solid var(--border-color, #e5e5e5); display: block; margin-bottom: 1rem; }
    .rt-nomap, .rt-empty { text-align: center; color: var(--text-muted, #888); padding: 1.5rem; }
    .rt-empty i { font-size: 2rem; display: block; margin-bottom: .5rem; color: var(--action, #ea580c); }
    .rt-subtitle { font-size: .85rem; font-weight: 700; color: var(--text-muted, #666); margin: 1.2rem 0 .5rem; }
    .rt-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .55rem; }
    .rt-stop { display: flex; align-items: center; gap: .7rem; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 12px; padding: .6rem .7rem; }
    .rt-seq { flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%; background: var(--action, #ea580c); color: #fff; display: grid; place-items: center; font-weight: 700; font-variant-numeric: tabular-nums; }
    .rt-seq.off { background: var(--text-faint, #a8a29e); }
    .rt-info { flex: 1; min-width: 0; }
    .rt-name { font-weight: 600; font-size: .92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt-addr { font-size: .8rem; color: var(--text-muted, #777); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt-meta { display: flex; gap: .5rem; align-items: center; margin-top: .15rem; font-size: .72rem; }
    .rt-folio { color: var(--text-faint, #999); font-variant-numeric: tabular-nums; }
    .rt-cod { color: #b45309; font-weight: 600; }
    .rt-paid { color: #16a34a; }
    .rt-nav { display: flex; flex-direction: column; gap: .35rem; flex-shrink: 0; }
    .rt-btn { text-decoration: none; font-size: .74rem; font-weight: 700; padding: .35rem .6rem; border-radius: 8px; text-align: center; }
    .rt-btn.waze { background: #33ccff22; color: #0a7ea4; }
    .rt-btn.gmaps { background: var(--action, #ea580c); color: #fff; }
  `],
})
export class RiderRouteComponent implements OnInit {
  private readonly svc = inject(RiderService);

  readonly route = signal<RiderRoute | null>(null);
  readonly loading = signal(false);

  readonly mapUrl = computed(() => this.buildMapUrl(this.route()));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.svc.myRoute().subscribe({
      next: (r) => { this.route.set(r); this.loading.set(false); },
      error: () => { this.route.set(null); this.loading.set(false); },
    });
  }

  money(v: number | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  wazeUrl(s: RiderRouteStop): string {
    return `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`;
  }

  gmapsUrl(s: RiderRouteStop): string {
    return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  }

  gmapsSearchUrl(s: RiderRouteStop): string {
    const q = encodeURIComponent(s.street || s.customer_name || '');
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

  /** Imagen estática de Mapbox con origen (tienda) + paradas numeradas (≤20). */
  private buildMapUrl(r: RiderRoute | null): string | null {
    const token = environment.mapbox?.token;
    if (!token || !r?.stops?.length) return null;
    const overlays: string[] = [];
    if (r.origin) overlays.push(`pin-l-shop+2563eb(${r.origin.lng},${r.origin.lat})`);
    r.stops.slice(0, 20).forEach((s, i) => {
      if (s.lat != null && s.lng != null) {
        overlays.push(`pin-s-${s.sequence_order ?? i + 1}+f05a28(${s.lng},${s.lat})`);
      }
    });
    if (!overlays.length) return null;
    return (
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/` +
      `${overlays.join(',')}/auto/640x400@2x?access_token=${token}`
    );
  }
}
