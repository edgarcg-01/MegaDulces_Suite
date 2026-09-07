import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { CarteraService, SalesRouteRow, VendorOption, RouteCustomer, RouteWarehouseRow, WarehouseOption } from '../cartera.service';

/**
 * V.0d — Cartera de ventas (supervisor_ventas). Asigna rutas de venta a vendedores
 * y define el orden de visita (visit_sequence) arrastrando los clientes de cada ruta.
 */
@Component({
  selector: 'app-comercial-cartera',
  standalone: true,
  imports: [
    FormsModule,
    TableModule,
    ButtonModule,
    SelectModule,
    TagModule,
    ToastModule,
    TooltipModule,
    SkeletonModule
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
        <div class="ca-tabs">
          <button type="button" class="ca-tab" [class.on]="view() === 'vendedores'" (click)="view.set('vendedores')"><i class="pi pi-users"></i> Vendedores</button>
          <button type="button" class="ca-tab" [class.on]="view() === 'sucursales'" (click)="showSucursales()"><i class="pi pi-building"></i> Sucursal por ruta</button>
        </div>
        <button pButton [text]="true" severity="secondary" size="small" (click)="view() === 'sucursales' ? loadRoutesWh() : load()" [loading]="loading() || loadingWh()" pTooltip="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
      </header>

      @if (view() === 'sucursales') {
        <article class="ca-panel" style="margin-bottom:1rem">
          <div class="ca-panel-head"><i class="pi pi-pencil"></i> Nombres de sucursales</div>
          <p class="surf-page-sub" style="margin:0 0 .6rem">Editá cómo se llama cada sucursal (es lo que ve el vendedor en su app).</p>
          @if (!loadingWh()) {
            <div class="ca-wh-list">
              @for (w of warehouses(); track w.id) {
                <div class="ca-wh-row">
                  <code class="comm-code">{{ w.code }}</code>
                  <input class="ca-wh-input" type="text" [(ngModel)]="whNameEdit[w.id]" [attr.aria-label]="'Nombre de ' + w.code" />
                  <button pButton size="small" severity="contrast"
                    [disabled]="savingWhName() === w.id || !whNameEdit[w.id]?.trim() || whNameEdit[w.id] === w.name"
                    [loading]="savingWhName() === w.id" (click)="saveWarehouseName(w)"
                    pTooltip="Guardar nombre"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span></button>
                </div>
              }
            </div>
          }
        </article>
        <article class="ca-panel">
          <div class="ca-panel-head"><i class="pi pi-building"></i> Sucursal de surtido por ruta</div>
          <p class="surf-page-sub" style="margin:0 0 .6rem">De qué sucursal se surte cada ruta. El vendedor ve la existencia de esta sucursal en su app. La sugerencia sale de la zona — confirmala o corregila.</p>
          @if (loadingWh()) { <p-skeleton height="220px"></p-skeleton> }
          @if (!loadingWh()) {
            <p-table [value]="routesWh()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="62vh">
              <ng-template #header>
                <tr><th scope="col">Ruta</th><th scope="col">Zona</th><th scope="col">Sucursal de surtido</th><th scope="col"><span class="sr-only">Asignar</span></th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td><i class="pi pi-directions" aria-hidden="true"></i> {{ r.route }}</td>
                  <td><span class="comm-muted is-small">{{ r.zone || '—' }}</span></td>
                  <td>
                    @if (r.warehouse_id) {
                      <span class="ca-chip">{{ r.warehouse_name }}</span>
                    } @else if (r.suggested_id) {
                      <span class="comm-muted is-small">sugerido: {{ r.suggested_name }}</span>
                    } @else {
                      <span class="comm-muted is-small">— sin asignar —</span>
                    }
                  </td>
                  <td class="ca-assign">
                    <p-select
                      [options]="warehouses()" [(ngModel)]="assignWh[r.route_id]"
                      optionLabel="name" optionValue="id" placeholder="Sucursal…"
                      [filter]="true" filterBy="name" appendTo="body" styleClass="ca-vendor-select"
                    ></p-select>
                    <button pButton size="small" severity="contrast" [disabled]="!assignWh[r.route_id] || savingWh() === r.route_id" [loading]="savingWh() === r.route_id" (click)="assignRouteWh(r.route_id)" pTooltip="Asignar sucursal a la ruta"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="4" class="comm-muted" style="padding:1.5rem;text-align:center">No hay rutas en el catálogo.</td></tr>
              </ng-template>
            </p-table>
          }
        </article>
      }

      <div class="ca-grid" [hidden]="view() !== 'vendedores'">
        <!-- RUTAS + ASIGNACION -->
        <article class="ca-panel">
          <div class="ca-panel-head"><i class="pi pi-directions"></i> Rutas de venta</div>
          @if (loading()) {
            <p-skeleton height="220px"></p-skeleton>
          }
          @if (!loading()) {
            <p-table [value]="routes()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="60vh">
              <ng-template #header>
                <tr><th scope="col">Ruta</th><th scope="col" class="comm-num">Clientes</th><th scope="col">Asignada a</th><th scope="col"><span class="sr-only">Asignar vendedor</span></th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [class.ca-row-active]="selectedRoute() === r.sales_route">
                  <td>
                    <button type="button" class="ca-route-link" (click)="selectRoute(r.sales_route)" pTooltip="Ordenar sus clientes">
                      <i class="pi pi-directions" aria-hidden="true"></i> {{ r.sales_route }}
                    </button>
                  </td>
                  <td class="comm-num">{{ r.customer_count }}</td>
                  <td>
                    @if (r.assigned_to.length === 0) {
                      <span class="comm-muted is-small">— sin asignar —</span>
                    }
                    @for (a of r.assigned_to; track a) {
                      <span class="ca-chip">
                        {{ a.username }}
                        <button type="button" class="ca-chip-x" (click)="unassign(a.id)" pTooltip="Quitar"><i class="pi pi-times"></i></button>
                      </span>
                    }
                  </td>
                  <td class="ca-assign">
                    <p-select
                      [options]="vendors()" [(ngModel)]="assignVendor[r.sales_route]"
                      optionLabel="username" optionValue="id" placeholder="Vendedor…"
                      [filter]="true" filterBy="username" appendTo="body" styleClass="ca-vendor-select"
                    ></p-select>
                    <button pButton size="small" severity="contrast" [disabled]="!assignVendor[r.sales_route] || assigningRoute() === r.sales_route" [loading]="assigningRoute() === r.sales_route" (click)="assign(r.sales_route)" pTooltip="Asignar ruta a vendedor"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="4" class="comm-muted" style="padding:1.5rem;text-align:center">No hay rutas de venta. Se generan desde la ruta (sales_route) de los clientes.</td></tr>
              </ng-template>
            </p-table>
          }
        </article>
    
        <!-- ORDEN DE VISITA (drag&drop) -->
        <article class="ca-panel">
          <div class="ca-panel-head">
            <i class="pi pi-sort-alt"></i> Orden de visita
            @if (selectedRoute()) {
              <span class="ca-route-badge">{{ selectedRoute() }}</span>
            }
            <span class="ca-spacer"></span>
            @if (selectedRoute()) {
              <button pButton size="small" [disabled]="!orderDirty() || savingOrder()" [loading]="savingOrder()" (click)="saveOrder()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar orden</span></button>
            }
          </div>
    
          @if (!selectedRoute()) {
            <div class="ca-empty">
              <i class="pi pi-arrow-left"></i>
              <p>Elegí una ruta para ordenar la secuencia de visita de sus clientes (arrastrá las filas).</p>
            </div>
          }
    
          @if (selectedRoute() && loadingCustomers()) {
            <p-skeleton height="220px"></p-skeleton>
          }
    
          @if (selectedRoute() && !loadingCustomers()) {
            <p-table [value]="customersList" styleClass="p-datatable-sm surf-table surf-table--zebra"
              [scrollable]="true" scrollHeight="60vh">
              <ng-template #header>
                <tr><th scope="col" style="width:3rem">#</th><th scope="col">Cliente</th><th scope="col">Código</th><th scope="col" style="width:5rem"><span class="sr-only">Reordenar</span></th></tr>
              </ng-template>
              <ng-template #body let-c let-i="rowIndex">
                <tr>
                  <td class="ca-seq">{{ i + 1 }}</td>
                  <td>
                    <div class="comm-cell-strong">{{ c.name }}</div>
                    @if (c.whatsapp || c.phone) {
                      <div class="comm-muted is-small">{{ c.whatsapp || c.phone }}</div>
                    }
                  </td>
                  <td><code class="comm-code">{{ c.code }}</code></td>
                  <td class="ca-move">
                    <button pButton [text]="true" size="small" severity="secondary" [disabled]="i === 0" (click)="moveUp(i)" pTooltip="Subir"><span class="p-button-icon p-button-icon-left pi pi-chevron-up" aria-hidden="true"></span></button>
                    <button pButton [text]="true" size="small" severity="secondary" [disabled]="i === customersList.length - 1" (click)="moveDown(i)" pTooltip="Bajar"><span class="p-button-icon p-button-icon-left pi pi-chevron-down" aria-hidden="true"></span></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="4" class="comm-muted" style="padding:1.5rem;text-align:center">La ruta no tiene clientes.</td></tr>
              </ng-template>
            </p-table>
          }
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
    .ca-route-badge { font-family:var(--font-mono); background:var(--c-surface-2); padding:.1rem .5rem; border-radius:6px; font-size:var(--fs-xs); }
    .ca-route-link { background:transparent; border:none; cursor:pointer; color:var(--c-text-1); font-weight:var(--fw-medium); display:inline-flex; align-items:center; gap:.35rem; padding:.2rem .35rem; border-radius:6px; }
    .ca-route-link:hover { background:var(--c-surface-2); }
    .ca-route-link i { color:var(--c-text-3); font-size:var(--fs-xs); }
    .ca-row-active { background:var(--c-surface-2); }
    .ca-chip { display:inline-flex; align-items:center; gap:.25rem; background:var(--c-surface-2); border:1px solid var(--c-divider); border-radius:6px; padding:.1rem .15rem .1rem .5rem; margin:.1rem; font-size:var(--fs-xs); }
    .ca-chip-x { background:transparent; border:none; cursor:pointer; color:var(--c-text-3); width:18px; height:18px; border-radius:4px; display:grid; place-items:center; }
    .ca-chip-x:hover { color:var(--bad-fg); background:var(--c-surface-1); }
    .ca-assign { display:flex; gap:.35rem; align-items:center; }
    :host ::ng-deep .ca-vendor-select { min-width:140px; font-size:var(--fs-sm); }
    .ca-move { display:flex; gap:.15rem; justify-content:flex-end; }
    .ca-seq { font-weight:var(--fw-bold); color:var(--c-text-2); }
    .ca-empty { padding:3rem 1.5rem; text-align:center; color:var(--c-text-2); }
    .ca-empty i { font-size:1.5rem; color:var(--c-text-3); display:block; margin-bottom:.5rem; }
    .ca-tabs { display:inline-flex; gap:.25rem; background:var(--c-surface-2); border:1px solid var(--c-divider); border-radius:8px; padding:.2rem; margin-left:auto; }
    .ca-tab { display:inline-flex; align-items:center; gap:.4rem; background:transparent; border:none; cursor:pointer; color:var(--c-text-2); font-weight:var(--fw-medium); font-size:var(--fs-sm); padding:.35rem .7rem; border-radius:6px; }
    .ca-tab.on { background:var(--c-surface-1); color:var(--c-text-1); font-weight:var(--fw-bold); box-shadow:var(--shadow-1, 0 1px 2px rgba(0,0,0,.08)); }
    .ca-tab i { font-size:var(--fs-xs); }
    .ca-wh-list { display:flex; flex-direction:column; gap:.4rem; }
    .ca-wh-row { display:flex; align-items:center; gap:.5rem; }
    .ca-wh-row .comm-code { flex-shrink:0; min-width:3.2rem; }
    .ca-wh-input { flex:1; padding:.4rem .6rem; border:1px solid var(--c-divider); border-radius:8px; background:var(--c-surface-1); color:var(--c-text-1); font-size:var(--fs-sm); }
    .ca-wh-input:focus { outline:none; border-color:var(--action); }
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

  // ── Pestaña "Sucursal por ruta" ──
  readonly view = signal<'vendedores' | 'sucursales'>('vendedores');
  readonly routesWh = signal<RouteWarehouseRow[]>([]);
  readonly warehouses = signal<WarehouseOption[]>([]);
  readonly loadingWh = signal(false);
  readonly savingWh = signal<string | null>(null);
  readonly savingWhName = signal<string | null>(null);
  private routesWhLoaded = false;
  /** route_id -> warehouse_id elegido (pre-lleno con la sugerencia). */
  assignWh: Record<string, string | null> = {};
  /** warehouse_id -> nombre editable (pre-lleno con el actual). */
  whNameEdit: Record<string, string> = {};

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

  // ── Sucursal por ruta ──
  showSucursales(): void {
    this.view.set('sucursales');
    if (!this.routesWhLoaded) this.loadRoutesWh();
  }

  loadRoutesWh(): void {
    this.loadingWh.set(true);
    this.api.routesWarehouses().subscribe({
      next: (r) => {
        this.warehouses.set(r.warehouses);
        this.routesWh.set(r.routes);
        // Pre-llenar el select con lo asignado, o la sugerencia por zona.
        const pre: Record<string, string | null> = {};
        for (const row of r.routes) pre[row.route_id] = row.warehouse_id || row.suggested_id || null;
        this.assignWh = pre;
        // Pre-llenar los nombres editables de sucursal.
        const names: Record<string, string> = {};
        for (const w of r.warehouses) names[w.id] = w.name;
        this.whNameEdit = names;
        this.routesWhLoaded = true;
        this.loadingWh.set(false);
      },
      error: (e) => { this.loadingWh.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudieron cargar las rutas' }); },
    });
  }

  assignRouteWh(routeId: string): void {
    const whId = this.assignWh[routeId];
    if (!whId) return;
    this.savingWh.set(routeId);
    this.api.setRouteWarehouse(routeId, whId).subscribe({
      next: () => { this.savingWh.set(null); this.toast.add({ severity: 'success', summary: 'Sucursal asignada' }); this.loadRoutesWh(); },
      error: (e) => { this.savingWh.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo asignar' }); },
    });
  }

  saveWarehouseName(w: WarehouseOption): void {
    const name = (this.whNameEdit[w.id] || '').trim();
    if (!name || name === w.name) return;
    this.savingWhName.set(w.id);
    this.api.renameWarehouse(w.id, name).subscribe({
      next: () => {
        this.savingWhName.set(null);
        // Reflejar el nuevo nombre en la lista local (para el select + el disabled).
        this.warehouses.update((ws) => ws.map((x) => (x.id === w.id ? { ...x, name } : x)));
        this.toast.add({ severity: 'success', summary: 'Nombre actualizado' });
      },
      error: (e) => { this.savingWhName.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo renombrar' }); },
    });
  }
}
