import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { CarteraService, SalesRouteRow, VendorOption, RouteCustomer } from '../cartera.service';

/**
 * V.0d — Cartera de ventas (supervisor_ventas). Asigna rutas de venta a vendedores
 * y define el orden de visita (visit_sequence) arrastrando los clientes de cada ruta.
 */
@Component({
  selector: 'app-comercial-cartera',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, ButtonModule, SelectModule,
    TagModule, ToastModule, TooltipModule, SkeletonModule,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page ca">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cartera de ventas</h1>
          <p class="surf-page-sub">Asigná rutas de venta a cada vendedor y ordená la secuencia de visita de sus clientes.</p>
        </div>
        <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()" pTooltip="Refrescar"></button>
      </header>

      <div class="ca-grid">
        <!-- RUTAS + ASIGNACION -->
        <article class="ca-panel">
          <div class="ca-panel-head"><i class="pi pi-directions"></i> Rutas de venta</div>
          <p-skeleton *ngIf="loading()" height="220px"></p-skeleton>
          <p-table *ngIf="!loading()" [value]="routes()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="60vh">
            <ng-template pTemplate="header">
              <tr><th>Ruta</th><th class="ca-num">Clientes</th><th>Asignada a</th><th></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr [class.ca-row-active]="selectedRoute() === r.sales_route">
                <td>
                  <button type="button" class="ca-route-link" (click)="selectRoute(r.sales_route)" pTooltip="Ordenar sus clientes">
                    <i class="pi pi-directions" aria-hidden="true"></i> {{ r.sales_route }}
                  </button>
                </td>
                <td class="ca-num">{{ r.customer_count }}</td>
                <td>
                  <span *ngIf="r.assigned_to.length === 0" class="comm-muted is-small">— sin asignar —</span>
                  <span *ngFor="let a of r.assigned_to" class="ca-chip">
                    {{ a.username }}
                    <button type="button" class="ca-chip-x" (click)="unassign(a.id)" pTooltip="Quitar"><i class="pi pi-times"></i></button>
                  </span>
                </td>
                <td class="ca-assign">
                  <p-select
                    [options]="vendors()" [(ngModel)]="assignVendor[r.sales_route]"
                    optionLabel="username" optionValue="id" placeholder="Vendedor…"
                    [filter]="true" filterBy="username" appendTo="body" styleClass="ca-vendor-select"
                  ></p-select>
                  <button pButton icon="pi pi-plus" size="small" severity="contrast"
                          [disabled]="!assignVendor[r.sales_route] || assigningRoute() === r.sales_route"
                          [loading]="assigningRoute() === r.sales_route"
                          (click)="assign(r.sales_route)" pTooltip="Asignar ruta a vendedor"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="4" class="comm-muted" style="padding:1.5rem;text-align:center">No hay rutas de venta. Se generan desde la ruta (sales_route) de los clientes.</td></tr>
            </ng-template>
          </p-table>
        </article>

        <!-- ORDEN DE VISITA (drag&drop) -->
        <article class="ca-panel">
          <div class="ca-panel-head">
            <i class="pi pi-sort-alt"></i> Orden de visita
            <span *ngIf="selectedRoute()" class="ca-route-badge">{{ selectedRoute() }}</span>
            <span class="ca-spacer"></span>
            <button *ngIf="selectedRoute()" pButton label="Guardar orden" icon="pi pi-check" size="small"
                    [disabled]="!orderDirty() || savingOrder()" [loading]="savingOrder()" (click)="saveOrder()"></button>
          </div>

          <div *ngIf="!selectedRoute()" class="ca-empty">
            <i class="pi pi-arrow-left"></i>
            <p>Elegí una ruta para ordenar la secuencia de visita de sus clientes (arrastrá las filas).</p>
          </div>

          <p-skeleton *ngIf="selectedRoute() && loadingCustomers()" height="220px"></p-skeleton>

          <p-table *ngIf="selectedRoute() && !loadingCustomers()" [value]="customersList" styleClass="p-datatable-sm"
                   [scrollable]="true" scrollHeight="60vh">
            <ng-template pTemplate="header">
              <tr><th style="width:3rem">#</th><th>Cliente</th><th>Código</th><th style="width:5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-c let-i="rowIndex">
              <tr>
                <td class="ca-seq">{{ i + 1 }}</td>
                <td>
                  <div class="comm-cell-strong">{{ c.name }}</div>
                  <div class="comm-muted is-small" *ngIf="c.whatsapp || c.phone">{{ c.whatsapp || c.phone }}</div>
                </td>
                <td><code class="comm-code">{{ c.code }}</code></td>
                <td class="ca-move">
                  <button pButton icon="pi pi-chevron-up" [text]="true" size="small" severity="secondary" [disabled]="i === 0" (click)="moveUp(i)" pTooltip="Subir"></button>
                  <button pButton icon="pi pi-chevron-down" [text]="true" size="small" severity="secondary" [disabled]="i === customersList.length - 1" (click)="moveDown(i)" pTooltip="Bajar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="4" class="comm-muted" style="padding:1.5rem;text-align:center">La ruta no tiene clientes.</td></tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .ca-grid { display:grid; grid-template-columns: 1fr 1fr; gap:1rem; align-items:start; }
    @media (max-width: 900px) { .ca-grid { grid-template-columns: 1fr; } }
    .ca-panel { background:var(--c-surface-1); border:1px solid var(--c-divider); border-radius:12px; overflow:hidden; }
    .ca-panel-head { display:flex; align-items:center; gap:.5rem; padding:.75rem 1rem; font-weight:var(--fw-bold); border-bottom:1px solid var(--c-divider); }
    .ca-panel-head i { color:var(--c-text-3); }
    .ca-spacer { flex:1; }
    .ca-route-badge { font-family:'Geist Mono','JetBrains Mono',monospace; background:var(--c-surface-2); padding:.1rem .5rem; border-radius:6px; font-size:var(--fs-xs); }
    .ca-num { text-align:right; }
    .ca-route-link { background:transparent; border:none; cursor:pointer; color:var(--c-text-1); font-weight:var(--fw-medium); display:inline-flex; align-items:center; gap:.35rem; padding:.2rem .35rem; border-radius:6px; }
    .ca-route-link:hover { background:var(--c-surface-2); }
    .ca-route-link i { color:var(--c-text-3); font-size:var(--fs-xs); }
    .ca-row-active { background:var(--c-surface-2); }
    .ca-chip { display:inline-flex; align-items:center; gap:.25rem; background:var(--c-surface-2); border:1px solid var(--c-divider); border-radius:6px; padding:.1rem .15rem .1rem .5rem; margin:.1rem; font-size:var(--fs-xs); }
    .ca-chip-x { background:transparent; border:none; cursor:pointer; color:var(--c-text-3); width:18px; height:18px; border-radius:4px; display:grid; place-items:center; }
    .ca-chip-x:hover { color:var(--c-bad,#c0392b); background:var(--c-surface-1); }
    .ca-assign { display:flex; gap:.35rem; align-items:center; }
    :host ::ng-deep .ca-vendor-select { min-width:140px; font-size:var(--fs-sm); }
    .ca-move { display:flex; gap:.15rem; justify-content:flex-end; }
    .ca-seq { font-weight:var(--fw-bold); color:var(--c-text-2); }
    .ca-empty { padding:3rem 1.5rem; text-align:center; color:var(--c-text-2); }
    .ca-empty i { font-size:1.5rem; color:var(--c-text-3); display:block; margin-bottom:.5rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialCarteraComponent implements OnInit {
  private readonly api = inject(CarteraService);
  private readonly toast = inject(MessageService);

  readonly routes = signal<SalesRouteRow[]>([]);
  readonly vendors = signal<VendorOption[]>([]);
  readonly loading = signal(false);

  readonly selectedRoute = signal<string | null>(null);
  readonly loadingCustomers = signal(false);
  readonly orderDirty = signal(false);
  readonly savingOrder = signal(false);
  readonly assigningRoute = signal<string | null>(null);

  /** Array plano (no signal) que PrimeNG reordena in-place con reorderableRows. */
  customersList: RouteCustomer[] = [];
  /** route -> vendorId seleccionado en el select de asignación. */
  assignVendor: Record<string, string | null> = {};

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listVendors().subscribe({ next: (v) => this.vendors.set(v), error: () => this.vendors.set([]) });
    this.api.listSalesRoutes().subscribe({
      next: (r) => { this.routes.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las rutas' }); },
    });
  }

  assign(route: string): void {
    const userId = this.assignVendor[route];
    if (!userId) return;
    this.assigningRoute.set(route);
    this.api.assign(userId, route).subscribe({
      next: () => { this.assigningRoute.set(null); this.assignVendor[route] = null; this.toast.add({ severity: 'success', summary: 'Ruta asignada' }); this.load(); },
      error: (e) => { this.assigningRoute.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo asignar' }); },
    });
  }

  unassign(id: string): void {
    this.api.unassign(id).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Asignación quitada' }); this.load(); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo quitar' }),
    });
  }

  selectRoute(route: string): void {
    this.selectedRoute.set(route);
    this.orderDirty.set(false);
    this.loadingCustomers.set(true);
    this.api.customersByRoute(route).subscribe({
      next: (c) => { this.customersList = c; this.loadingCustomers.set(false); },
      error: () => { this.customersList = []; this.loadingCustomers.set(false); },
    });
  }

  moveUp(i: number): void {
    if (i <= 0) return;
    const arr = [...this.customersList];
    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    this.customersList = arr;
    this.orderDirty.set(true);
  }

  moveDown(i: number): void {
    if (i >= this.customersList.length - 1) return;
    const arr = [...this.customersList];
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    this.customersList = arr;
    this.orderDirty.set(true);
  }

  saveOrder(): void {
    const route = this.selectedRoute();
    if (!route) return;
    this.savingOrder.set(true);
    const ids = this.customersList.map((c) => c.id);
    this.api.setOrder(route, ids).subscribe({
      next: () => { this.savingOrder.set(false); this.orderDirty.set(false); this.toast.add({ severity: 'success', summary: 'Orden guardado' }); },
      error: () => { this.savingOrder.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el orden' }); },
    });
  }
}
