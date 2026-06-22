import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { MapComponent, MapMarker } from '../../../shared/components/map/map.component';
import { LogisticaService, RoutePlan, PendingOrder, Vehicle } from '../logistica.service';

@Component({
  selector: 'app-logistica-planner',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule, ToastModule, MapComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <span class="pl-eyebrow"><i class="pi pi-compass" aria-hidden="true"></i> Logística</span>
          <h1>Planeador de ruta</h1>
          <p class="surf-page-sub">Seleccioná un embarque, optimizá el orden de las paradas y velo en el mapa.</p>
        </div>
      </header>

      <!-- Armar reparto desde pedidos pendientes -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 pl-build">
          <span class="cell-label">Armar reparto del día</span>
          <p class="comm-muted is-small" style="margin:.25rem 0 .75rem">Elegí unidad + pedidos pendientes → crea el embarque, la guía y optimiza la ruta.</p>
          <div class="pl-build-row">
            <p-select [options]="vehicleOptions()" [(ngModel)]="buildVehicle" optionLabel="label" optionValue="value"
                      [filter]="true" placeholder="Unidad" styleClass="pl-select" appendTo="body"></p-select>
            <p-multiSelect [options]="orderOptions()" [(ngModel)]="buildOrders" optionLabel="label" optionValue="value"
                           [filter]="true" placeholder="Pedidos pendientes" styleClass="pl-select" appendTo="body"
                           [maxSelectedLabels]="3" selectedItemsLabel="{0} pedidos"></p-multiSelect>
            <button pButton icon="pi pi-box" label="Crear embarque optimizado" size="small"
                    [loading]="building()" [disabled]="!buildVehicle || !buildOrders.length" (click)="build()"></button>
          </div>
          <span class="comm-muted is-small" *ngIf="!orderOptions().length">No hay pedidos pendientes por programar.</span>
        </article>
      </div>

      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush pl-toolbar">
          <p-select [options]="shipmentOptions()" [(ngModel)]="selectedId" optionLabel="label" optionValue="value"
                    [filter]="true" placeholder="Ver embarque existente" styleClass="pl-select"
                    (onChange)="loadPlan()" appendTo="body"></p-select>
          <button pButton icon="pi pi-compass" label="Optimizar ruta" size="small"
                  [loading]="optimizing()" [disabled]="!selectedId" (click)="optimize()"></button>
        </article>
      </div>

      <ng-container *ngIf="plan() as p">
        <div class="sheet cols-12">
          <article class="cell cell-span-12 is-flush">
            <div class="pl-summary">
              <span><code class="comm-code">{{ p.folio }}</code></span>
              <span class="pl-pill" [class.ok]="p.optimized">{{ p.optimized ? 'Optimizada' : 'Sin optimizar' }}</span>
              <span class="comm-muted is-small">{{ p.stops.length }} paradas<span *ngIf="p.unlocated"> · {{ p.unlocated }} sin ubicación</span></span>
            </div>
            <app-map [markers]="markers()" [path]="pathPoints()" height="500px"></app-map>
          </article>
        </div>

        <div class="sheet cols-12" *ngIf="p.stops.length">
          <article class="cell cell-span-12 is-flush">
            <ol class="pl-stops">
              <li *ngFor="let s of p.stops">
                <span class="pl-seq">{{ s.sequence_order ?? '—' }}</span>
                <span class="pl-name">{{ s.customer_name }}</span>
                <span class="pl-status" [class.done]="s.status === 'entregado'">{{ s.status }}</span>
              </li>
            </ol>
          </article>
        </div>
      </ng-container>

      <div class="sheet cols-12" *ngIf="selectedId && plan() && !plan()!.stops.length">
        <article class="cell cell-span-12">
          <p class="comm-muted">Este embarque no tiene destinatarios con ubicación. Captura lat/lng en los clientes.</p>
        </article>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .pl-eyebrow { display:inline-flex; align-items:center; gap:.35rem; font-size:var(--fs-micro); font-weight:var(--fw-bold); text-transform:uppercase; letter-spacing:.08em; color:var(--c-text-2); margin-bottom:.35rem; }
    .pl-toolbar { display:flex; gap:.75rem; align-items:center; padding:.75rem 1rem; flex-wrap:wrap; }
    .pl-build-row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
    .pl-select { min-width:280px; }
    .pl-summary { display:flex; align-items:center; gap:.75rem; padding:.5rem .25rem .75rem; flex-wrap:wrap; }
    .pl-pill { font-family:var(--mono,monospace); font-size:var(--fs-micro); padding:.15rem .5rem; border-radius:6px; background:var(--c-surface-2); color:var(--c-text-2); font-weight:600; }
    .pl-pill.ok { background:#dce5dd; color:#3f5e4e; }
    .pl-stops { list-style:none; margin:0; padding:0; }
    .pl-stops li { display:flex; align-items:center; gap:.75rem; padding:.5rem .75rem; border-top:1px solid var(--c-divider); }
    .pl-stops li:first-child { border-top:none; }
    .pl-seq { display:inline-grid; place-items:center; width:24px; height:24px; border-radius:7px; background:var(--action,#d2521b); color:#fff; font-weight:700; font-size:var(--fs-micro); font-variant-numeric:tabular-nums; flex:0 0 auto; }
    .pl-name { flex:1 1 auto; }
    .pl-status { font-size:var(--fs-micro); color:var(--c-text-3); text-transform:uppercase; letter-spacing:.05em; }
    .pl-status.done { color:#3f5e4e; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaPlannerComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  readonly shipmentOptions = signal<{ label: string; value: string }[]>([]);
  readonly plan = signal<RoutePlan | null>(null);
  readonly optimizing = signal(false);
  selectedId: string | null = null;

  // Armar reparto
  readonly vehicleOptions = signal<{ label: string; value: string }[]>([]);
  readonly orderOptions = signal<{ label: string; value: string }[]>([]);
  readonly building = signal(false);
  buildVehicle: string | null = null;
  buildOrders: string[] = [];

  readonly markers = computed<MapMarker[]>(() => {
    const p = this.plan();
    if (!p) return [];
    const m: MapMarker[] = p.stops.map((s) => ({
      lat: s.lat, lng: s.lng, id: s.recipient_id, seq: s.sequence_order ?? undefined,
      title: `${s.sequence_order ?? '—'}. ${s.customer_name}`,
      color: s.status === 'entregado' ? '#3f5e4e' : undefined,
    }));
    if (p.origin) m.unshift({ lat: p.origin.lat, lng: p.origin.lng, kind: 'truck', title: p.origin.name || 'Origen' });
    return m;
  });

  readonly pathPoints = computed(() => {
    const p = this.plan();
    if (!p) return [];
    const pts = [...p.stops].map((s) => ({ lat: s.lat, lng: s.lng }));
    return p.origin ? [{ lat: p.origin.lat, lng: p.origin.lng }, ...pts] : pts;
  });

  constructor() {
    this.reloadShipments();
    this.api.listVehicles({ active: true }).subscribe({
      next: (vs: Vehicle[]) => this.vehicleOptions.set(
        (vs || []).map((v) => ({ label: `${v.plate}${v.model ? ' · ' + v.model : ''}${v.capacity_boxes ? ' (' + v.capacity_boxes + ' cajas)' : ''}`, value: v.id })),
      ),
    });
    this.loadPendingOrders();
  }

  private reloadShipments() {
    this.api.listShipments({ pageSize: 100 }).subscribe({
      next: (page) => {
        const opts = (page.items || [])
          .filter((s) => !['cerrado', 'cancelado'].includes(s.status))
          .map((s) => ({ label: `${s.folio} · ${s.shipment_date} · ${s.status}`, value: s.id }));
        this.shipmentOptions.set(opts);
      },
    });
  }

  private loadPendingOrders() {
    this.api.listPendingOrders().subscribe({
      next: (os: PendingOrder[]) => this.orderOptions.set(
        (os || []).map((o) => ({ label: `${o.code} · ${o.customer_name || 'Cliente'} · $${o.total}`, value: o.id })),
      ),
    });
  }

  build() {
    if (!this.buildVehicle || !this.buildOrders.length) return;
    const today = new Date().toISOString().slice(0, 10);
    this.building.set(true);
    this.api.buildShipmentFromOrders({ vehicle_id: this.buildVehicle, order_ids: this.buildOrders, shipment_date: today }).subscribe({
      next: (r) => {
        this.building.set(false);
        this.toast.add({
          severity: r.over_capacity ? 'warn' : 'success',
          summary: `Embarque ${r.folio} creado`,
          detail: `${r.recipients} paradas · ${r.optimized_km} km${r.over_capacity ? ` · ⚠ excede capacidad (${r.total_units}/${r.capacity_boxes})` : ''}${r.unlocated ? ` · ${r.unlocated} sin ubicación` : ''}`,
        });
        this.buildOrders = [];
        this.reloadShipments();
        this.loadPendingOrders();
        this.selectedId = r.shipment_id;
        this.loadPlan();
      },
      error: (err) => {
        this.building.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se creó el embarque' });
      },
    });
  }

  loadPlan() {
    if (!this.selectedId) return;
    this.api.shipmentRoutePlan(this.selectedId).subscribe({
      next: (p) => this.plan.set(p),
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se cargó el plan' }),
    });
  }

  optimize() {
    if (!this.selectedId) return;
    this.optimizing.set(true);
    this.api.optimizeShipmentRoute(this.selectedId).subscribe({
      next: (r) => {
        this.optimizing.set(false);
        this.toast.add({
          severity: r.located ? 'success' : 'warn',
          summary: r.located ? 'Ruta optimizada' : 'Sin paradas localizables',
          detail: r.located ? `${r.located} paradas · ${r.total_km} km` : 'Captura lat/lng en los clientes.',
        });
        this.loadPlan();
      },
      error: (err) => {
        this.optimizing.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se optimizó' });
      },
    });
  }
}
