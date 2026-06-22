import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { MapComponent, MapMarker } from '../../../shared/components/map/map.component';
import { LiveShipment, LogisticaService } from '../logistica.service';

@Component({
  selector: 'app-logistica-live',
  standalone: true,
  imports: [CommonModule, RouterLink, ButtonModule, MapComponent],
  template: `
    <div class="surf-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <span class="live-eyebrow"><i class="pi pi-map-marker" aria-hidden="true"></i> Logística</span>
          <h1>Flota en vivo</h1>
          <p class="surf-page-sub">
            {{ units().length }} unidad{{ units().length === 1 ? '' : 'es' }} en ruta
            <span class="live-dot" [class.on]="units().length > 0" aria-hidden="true"></span>
            <span class="live-muted">· actualiza cada 30 s</span>
          </p>
        </div>
        <button pButton icon="pi pi-refresh" label="Actualizar" severity="secondary" size="small"
                [loading]="loading()" (click)="refresh()"></button>
      </header>

      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <app-map [markers]="markers()" height="520px" (markerClick)="focus($event)"></app-map>
        </article>
      </div>

      <div class="sheet cols-12" *ngIf="units().length; else empty">
        <article class="cell cell-span-12 is-flush">
          <div class="live-list">
            <div class="live-row" *ngFor="let u of units()">
              <span class="live-truck"><i class="pi pi-truck" aria-hidden="true"></i></span>
              <div class="live-row-main">
                <a [routerLink]="['/logistica/shipments', u.shipment_id]"><code class="comm-code">{{ u.folio }}</code></a>
                <span class="live-row-sub">{{ u.driver_name }}<span *ngIf="u.vehicle_plate"> · {{ u.vehicle_plate }}</span><span *ngIf="u.destination"> → {{ u.destination }}</span></span>
              </div>
              <span class="live-ago">{{ ago(u.captured_at) }}</span>
            </div>
          </div>
        </article>
      </div>

      <ng-template #empty>
        <div class="sheet cols-12">
          <article class="cell cell-span-12">
            <div class="live-empty">
              <div class="live-empty-icon"><i class="pi pi-truck" aria-hidden="true"></i></div>
              <h3>Sin unidades en ruta</h3>
              <p>Aparecerán aquí cuando un chofer con embarque en ruta esté compartiendo su ubicación desde "Mis entregas".</p>
            </div>
          </article>
        </div>
      </ng-template>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .live-eyebrow { display:inline-flex; align-items:center; gap:.35rem; font-size:var(--fs-micro); font-weight:var(--fw-bold); text-transform:uppercase; letter-spacing:.08em; color:var(--c-text-2); margin-bottom:.35rem; }
    .live-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--c-text-3,#bbb); margin-left:.35rem; vertical-align:middle; }
    .live-dot.on { background:#2e7d32; box-shadow:0 0 0 3px rgba(46,125,50,.18); }
    .live-muted { color:var(--c-text-3); }
    .live-list { display:flex; flex-direction:column; }
    .live-row { display:flex; align-items:center; gap:.75rem; padding:.625rem .75rem; border-top:1px solid var(--c-divider); }
    .live-row:first-child { border-top:none; }
    .live-truck { width:34px; height:34px; border-radius:9px; display:grid; place-items:center; background:var(--c-surface-2); color:var(--action,#d2521b); flex:0 0 auto; }
    .live-row-main { display:flex; flex-direction:column; gap:.15rem; flex:1 1 auto; min-width:0; }
    .live-row-sub { font-size:var(--fs-sm); color:var(--c-text-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .live-ago { font-size:var(--fs-micro); color:var(--c-text-3); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .live-empty { text-align:center; padding:2.5rem 1.5rem; max-width:440px; margin:0 auto; }
    .live-empty-icon { width:56px; height:56px; margin:0 auto 1rem; border-radius:14px; background:var(--c-surface-2); color:var(--c-text-2); display:grid; place-items:center; font-size:1.5rem; }
    .live-empty h3 { margin:0 0 .375rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .live-empty p { margin:0; color:var(--c-text-2); font-size:var(--fs-sm); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaLiveComponent implements OnDestroy {
  private readonly api = inject(LogisticaService);

  readonly units = signal<LiveShipment[]>([]);
  readonly loading = signal(false);
  readonly markers = computed<MapMarker[]>(() =>
    this.units().map((u) => ({
      lat: u.lat, lng: u.lng, id: u.shipment_id, kind: 'truck' as const,
      title: `${u.folio} · ${u.driver_name}${u.destination ? ' → ' + u.destination : ''}`,
    })),
  );

  private timer: any = null;

  constructor() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 30_000);
  }

  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }

  refresh() {
    this.loading.set(true);
    this.api.liveShipments().subscribe({
      next: (r) => { this.units.set(r || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  focus(_m: MapMarker) { /* el popup del marcador ya muestra folio + chofer */ }

  ago(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    return `hace ${h} h`;
  }
}
