import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DispatchedDelivery, HomeDeliveryService, RiderPosition } from '../home-delivery.service';
import { MapComponent, MapLayer, MapMarker } from '../../../shared/components/map/map.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { MapLegendComponent, LegendLayer } from '../../../shared/components/map-legend/map-legend.component';
import { WebSocketService } from '../../../core/services/websocket.service';

/**
 * Reparto — SEGUIMIENTO para el personal de tienda: dónde va cada pedido
 * despachado hoy (estado + repartidor + hora de entrega). Auto-refresca cada
 * 30 s; también se puede refrescar a mano. Muestra `delivered_at` cuando el
 * repartidor cierra la entrega (§ "mostrar cuándo terminó de entregarlo").
 */
@Component({
  selector: 'app-home-delivery-tracking',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, SelectButtonModule, MapComponent, MapLegendComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="trk">
      <header class="trk-head">
        <div>
          <h1>Seguimiento de entregas</h1>
          <p class="sub">Dónde va cada pedido despachado hoy</p>
        </div>
        <div class="head-actions">
          <p-selectButton [options]="filters" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value"
                          (onChange)="load()" [allowEmpty]="false" styleClass="sb-liquid" />
          <button pButton icon="pi pi-refresh" [label]="loading() ? 'Actualizando…' : 'Actualizar'"
                  size="small" severity="secondary" (click)="load()" [disabled]="loading()"></button>
        </div>
      </header>

      <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de entregas de hoy" />


      <div class="map-wrap">
        <app-map [layers]="mapLayers()" height="360px" [autoFit]="'once'" />
        <app-map-legend [layers]="legend()" (toggle)="toggleLayer($event)" />
        <div class="map-note">
          <i class="pi pi-circle-fill live" aria-hidden="true"></i> Repartidor en vivo · posición cada ~15 s
        </div>
      </div>

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm" [scrollable]="true"
               [rowHover]="true" dataKey="delivery_id">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th>
            <th>Cliente</th>
            <th>Domicilio</th>
            <th>Repartidor</th>
            <th class="num">Cobro</th>
            <th>Estado</th>
            <th>Despachado</th>
            <th>Entregado</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-d>
          <tr>
            <td class="mono">{{ d.folio }}<div class="sub2" *ngIf="d.kepler_folio">Kepler {{ d.kepler_folio }}</div></td>
            <td>{{ d.customer_name }}<div class="sub2" *ngIf="d.phone">{{ d.phone }}</div></td>
            <td class="addr">{{ d.delivery_address?.street || '—' }}</td>
            <td>{{ d.rider_name || d.rider_username || '—' }}</td>
            <td class="num">
              @if (d.collect_on_delivery) { {{ money(d.amount_to_collect) }} }
              @else { <span class="paid">pagado</span> }
            </td>
            <td><p-tag [value]="statusLabel(d)" [severity]="statusSeverity(d.status)" /></td>
            <td class="mono">{{ time(d.dispatched_at) }}</td>
            <td class="mono">{{ d.delivered_at ? time(d.delivered_at) : '—' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="empty">Sin entregas despachadas hoy.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; padding: 1rem 1.25rem; }
    .trk-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
    h1 { font-size: 1.2rem; margin: 0; font-weight: 700; }
    .sub { margin: .1rem 0 0; color: var(--text-muted); font-size: .85rem; }
    .head-actions { display: flex; gap: .6rem; align-items: center; }
    app-metric-strip { display:block; margin:.25rem 0 1.25rem; }
    .map-wrap { margin: 0 0 1rem; }
    .map-note { font-size: .78rem; color: var(--text-muted); margin-top: .4rem; display: flex; align-items: center; gap: .35rem; }
    .map-note .live { color: #16a34a; font-size: .6rem; }
    .mono { font-variant-numeric: tabular-nums; }
    .num { text-align: right; }
    .addr { max-width: 240px; }
    .sub2 { font-size: .74rem; color: var(--text-muted); }
    .paid { color: #16a34a; font-size: .8rem; }
    .empty { text-align: center; color: var(--text-muted); padding: 1.5rem; }
  `],
})
export class HomeDeliveryTrackingComponent implements OnInit, OnDestroy {
  private readonly svc = inject(HomeDeliveryService);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<DispatchedDelivery[]>([]);
  readonly loading = signal(false);
  /** posiciones de repartidores por user_id (seed HTTP + upsert por WS). */
  readonly riders = signal<Map<string, RiderPosition>>(new Map());
  /** visibilidad de capas (toggle de leyenda). */
  readonly vis = signal<{ destinos: boolean; repartidores: boolean }>({ destinos: true, repartidores: true });
  /** ticker para recalcular frescura del pin del repartidor. */
  readonly now = signal(Date.now());

  statusFilter: '' | 'pendiente' | 'entregado' = '';
  readonly filters = [
    { label: 'Todas', value: '' },
    { label: 'En camino', value: 'pendiente' },
    { label: 'Entregadas', value: 'entregado' },
  ];

  private timer: any = null;
  private posTimer: any = null;
  private tick: any = null;

  readonly incidents = computed(() => this.rows().filter((r) => !!r.incident_type).length);

  /** KPIs de cabecera vía el componente compartido MetricStrip (sin caja). */
  readonly kpiItems = computed<MetricStripItem[]>(() => [
    { label: 'Total', value: this.rows().length },
    { label: 'En camino', value: this.countBy('pendiente'), tone: 'warn', live: true },
    { label: 'Entregadas', value: this.countBy('entregado'), tone: 'ok' },
    { label: 'Incidencias', value: this.incidents(), tone: 'bad' },
  ]);

  /** Pin de destino por entrega (con coords). Color por estado. */
  private destinoMarkers(): MapMarker[] {
    return this.rows()
      .map((d): MapMarker | null => {
        const a = d.delivery_address as any;
        const lat = Number(a?.lat), lng = Number(a?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const color = d.status === 'entregado' ? '#16a34a'
          : d.status === 'pendiente' ? 'var(--action, #F05A28)' : '#dc2626';
        return {
          id: 'd:' + d.delivery_id, lat, lng, kind: 'pin', color,
          title: `<b>${d.folio}</b><br>${d.customer_name}<br>${a?.street || ''}`,
        };
      })
      .filter((m): m is MapMarker => m !== null);
  }

  /** Pin en vivo por repartidor (persistent). Ring verde si fresco (<3 min). */
  private riderMarkers(): MapMarker[] {
    const now = this.now();
    return [...this.riders().values()]
      .map((p): MapMarker | null => {
        const lat = Number(p.lat), lng = Number(p.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const ageMin = (now - new Date(p.captured_at).getTime()) / 60000;
        const color = ageMin < 3 ? '#16a34a' : ageMin < 10 ? '#b45309' : '#78716c';
        return {
          id: 'r:' + p.rider_user_id, lat, lng, kind: 'user', color, ring: ageMin < 3,
          title: `<b>${p.full_name || p.username}</b><br>${this.relAge(ageMin)}`,
        };
      })
      .filter((m): m is MapMarker => m !== null);
  }

  readonly mapLayers = computed<MapLayer[]>(() => [
    { id: 'destinos', label: 'Destinos', markers: this.destinoMarkers(), visible: this.vis().destinos },
    { id: 'repartidores', label: 'Repartidores', markers: this.riderMarkers(), visible: this.vis().repartidores, persistent: true },
  ]);

  readonly legend = computed<LegendLayer[]>(() => [
    { id: 'destinos', label: 'Destinos', color: 'var(--action, #F05A28)', count: this.destinoMarkers().length, visible: this.vis().destinos },
    { id: 'repartidores', label: 'Repartidores', color: '#16a34a', count: this.riders().size, visible: this.vis().repartidores },
  ]);

  ngOnInit(): void {
    this.load();
    this.loadPositions();
    this.timer = setInterval(() => this.load(), 30000); // entregas
    this.posTimer = setInterval(() => this.loadPositions(), 15000); // posiciones repartidor
    this.tick = setInterval(() => this.now.set(Date.now()), 15000); // frescura

    // Vivo por WS (bonus; el poll garantiza el dato aunque el room no aplique).
    this.ws.routePing.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p: any) => {
      if (!p?.userId) return;
      const m = new Map(this.riders());
      const prev = m.get(p.userId);
      // Solo actualiza a repartidores ya conocidos (seed HTTP filtra por rol).
      if (!prev) return;
      m.set(p.userId, { ...prev, lat: p.lat, lng: p.lng, captured_at: p.capturedAt, speed_mps: p.speedMps, accuracy_m: p.accuracyM });
      this.riders.set(m);
    });
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.posTimer) clearInterval(this.posTimer);
    if (this.tick) clearInterval(this.tick);
  }

  toggleLayer(id: string): void {
    const v = this.vis();
    if (id === 'destinos') this.vis.set({ ...v, destinos: !v.destinos });
    if (id === 'repartidores') this.vis.set({ ...v, repartidores: !v.repartidores });
  }

  private relAge(min: number): string {
    if (min < 1) return 'hace segundos';
    if (min < 60) return `hace ${Math.round(min)} min`;
    return `hace ${Math.round(min / 60)} h`;
  }

  loadPositions(): void {
    this.svc.riderPositions(60).subscribe({
      next: (r) => {
        const m = new Map<string, RiderPosition>();
        for (const p of r?.positions || []) m.set(p.rider_user_id, p);
        this.riders.set(m);
      },
      error: () => {},
    });
  }

  load(): void {
    this.loading.set(true);
    this.svc.listDispatched({ status: this.statusFilter || undefined }).subscribe({
      next: (r) => { this.rows.set(r || []); this.loading.set(false); },
      error: () => { this.rows.set([]); this.loading.set(false); },
    });
  }

  countBy(status: string): number {
    return this.rows().filter((r) => r.status === status).length;
  }

  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  time(iso?: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  statusLabel(d: DispatchedDelivery): string {
    if (d.status === 'pendiente') return 'En camino';
    return { entregado: 'Entregado', no_entregado: 'No entregado', rechazado: 'Rechazado' }[d.status] || d.status;
  }

  statusSeverity(s: string): 'success' | 'warn' | 'danger' | 'info' {
    if (s === 'entregado') return 'success';
    if (s === 'rechazado') return 'danger';
    if (s === 'no_entregado') return 'warn';
    return 'info';
  }
}
