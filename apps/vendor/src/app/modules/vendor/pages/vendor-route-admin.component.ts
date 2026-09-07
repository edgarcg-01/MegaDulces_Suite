import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import {
  SupervisorRoutesService,
  AssignableVendor,
  RouteCatalogRow,
  DailyAssignment,
  Warehouse,
} from '../supervisor-routes.service';

const DAY_LABELS: Record<number, string> = { 1: 'L', 2: 'M', 3: 'M', 4: 'J', 5: 'V', 6: 'S', 7: 'D' };
const WORK_DAYS = [1, 2, 3, 4, 5, 6];
const DAY_OPTIONS = WORK_DAYS.map((d) => ({ label: DAY_LABELS[d], value: d }));

/**
 * Panel de supervisor (vendor app): asigna rutas a vendedores. Escribe en
 * `daily_assignments` — lo que la cartera del vendedor lee para mostrar "Mi ruta".
 * Reemplaza el pedirlo por Thot: el supervisor lo hace él mismo desde la app.
 *
 * Alcance: el backend solo devuelve el EQUIPO del supervisor (supervisor_id = él),
 * no todo el tenant. UI PrimeNG-first + tokens (DESIGN.md Operations).
 */
@Component({
  selector: 'app-vendor-route-admin',
  standalone: true,
  imports: [FormsModule, ToastModule, SelectModule, SelectButtonModule, ButtonModule, InputTextModule, SkeletonModule],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>
    <div class="ra">
      <header class="ra-head">
        <h1><i class="pi pi-directions"></i> Asignar rutas</h1>
        <p>Elegí un vendedor de tu equipo y asignale su ruta y los días que la recorre. Aparece de inmediato en su "Mi ruta".</p>
      </header>

      @if (loading()) {
        <p-skeleton height="3rem" styleClass="mb-3"></p-skeleton>
        <p-skeleton height="10rem"></p-skeleton>
      } @else {
        <!-- Vendedor -->
        <label class="ra-lbl" for="ra-vendor">Vendedor</label>
        @if (vendors().length === 0) {
          <div class="ra-empty">
            <i class="pi pi-users"></i>
            <p>No tenés vendedores en tu equipo.</p>
            <span>Pedile a oficina que te asigne vendedores (supervisor) para poder darles ruta.</span>
          </div>
        } @else {
          <p-select
            inputId="ra-vendor"
            [options]="vendors()"
            [ngModel]="selectedVendorId()"
            (onChange)="selectVendor($event.value)"
            optionLabel="username"
            optionValue="id"
            placeholder="Elegí un vendedor…"
            styleClass="w-full"
            [filter]="vendors().length > 8"
          ></p-select>
        }

        @if (selectedVendorId()) {
          <!-- Asignaciones actuales -->
          <div class="ra-section">
            <div class="ra-section-h">Rutas asignadas</div>
            @if (loadingAssign()) {
              <p-skeleton height="4rem"></p-skeleton>
            } @else if (grouped().length === 0) {
              <div class="ra-muted">Sin rutas asignadas todavía.</div>
            } @else {
              @for (g of grouped(); track g.route_id) {
                <div class="ra-assign">
                  <div class="ra-assign-info">
                    <div class="ra-route"><i class="pi pi-map"></i> {{ g.route }}</div>
                    <div class="ra-days">
                      @for (d of workDays; track d) {
                        <span class="ra-day" [class.on]="g.days.has(d)">{{ dayLabel(d) }}</span>
                      }
                    </div>
                  </div>
                  <button
                    pButton
                    type="button"
                    icon="pi pi-trash"
                    severity="danger"
                    text
                    rounded
                    (click)="removeRoute(g.route_id)"
                    aria-label="Quitar ruta"
                  ></button>
                </div>
              }
            }
          </div>

          <!-- Nueva asignación -->
          <div class="ra-section">
            <div class="ra-section-h">Asignar una ruta</div>
            <p-select
              [options]="routeOptions()"
              [ngModel]="newRouteId()"
              (onChange)="newRouteId.set($event.value)"
              optionLabel="label"
              optionValue="value"
              placeholder="Elegí una ruta…"
              styleClass="w-full"
              [filter]="routeOptions().length > 8"
            ></p-select>
            <div class="ra-days-pick">
              <p-selectbutton
                [options]="dayOptions"
                [ngModel]="newDays()"
                (onChange)="newDays.set($event.value)"
                optionLabel="label"
                optionValue="value"
                [multiple]="true"
                [allowEmpty]="true"
                aria-label="Días de la ruta"
              ></p-selectbutton>
            </div>
            <button
              pButton
              type="button"
              label="Asignar ruta"
              icon="pi pi-check"
              class="w-full"
              [loading]="saving()"
              [disabled]="!newRouteId() || newDays().length === 0 || saving()"
              (click)="assign()"
            ></button>
          </div>
        }

        <!-- Sucursales: editar el nombre que ven los vendedores -->
        <div class="ra-section">
          <div class="ra-section-h">Sucursales</div>
          @for (w of warehouses(); track w.id) {
            <div class="ra-wh">
              <code class="ra-wh-code">{{ w.code }}</code>
              @if (editingWhId() === w.id) {
                <input
                  pInputText
                  class="ra-wh-input"
                  type="text"
                  [ngModel]="whDraft()"
                  (ngModelChange)="whDraft.set($event)"
                  (keyup.enter)="saveWhName(w)"
                  [attr.aria-label]="'Nombre de ' + w.code"
                />
                <button pButton type="button" icon="pi pi-check" text rounded (click)="saveWhName(w)"
                  [loading]="savingWhId() === w.id" [disabled]="savingWhId() === w.id || !whDraft().trim()" aria-label="Guardar"></button>
                <button pButton type="button" icon="pi pi-times" severity="secondary" text rounded (click)="cancelEditWh()" aria-label="Cancelar"></button>
              } @else {
                <span class="ra-wh-name">{{ w.name }}</span>
                <button pButton type="button" icon="pi pi-pencil" severity="secondary" text rounded (click)="startEditWh(w)" aria-label="Editar nombre"></button>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ra-head h1 { display: flex; align-items: center; gap: var(--sp-2); font-size: 1.25rem; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 var(--sp-1); color: var(--text-main); }
    .ra-head p { margin: 0 0 var(--sp-4); color: var(--text-muted); font-size: .85rem; line-height: 1.4; }
    .ra-lbl { display: block; font-size: .78rem; font-weight: 700; color: var(--text-muted); margin: 0 0 var(--sp-2); }
    .ra-section { margin-top: var(--sp-6); }
    .ra-section-h { font-size: .8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; margin-bottom: var(--sp-2); }
    .ra-muted { color: var(--text-muted); font-size: .85rem; padding: var(--sp-2) 0; }
    .ra-empty { text-align: center; padding: var(--sp-6) var(--sp-4); color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: var(--r-lg, 16px); }
    .ra-empty i { font-size: 1.75rem; display: block; margin-bottom: var(--sp-2); color: var(--text-faint); }
    .ra-empty p { margin: 0 0 var(--sp-1); color: var(--text-main); font-weight: 600; }
    .ra-empty span { font-size: .8rem; }
    .ra-assign { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); margin-bottom: var(--sp-2); }
    .ra-assign-info { flex: 1; min-width: 0; }
    .ra-route { display: flex; align-items: center; gap: var(--sp-1); font-weight: 700; color: var(--text-main); font-size: .92rem; }
    .ra-route i { color: var(--text-muted); font-size: .8rem; }
    .ra-days { display: flex; gap: .2rem; margin-top: var(--sp-1); }
    .ra-day { width: 1.35rem; height: 1.35rem; display: grid; place-items: center; border-radius: 50%; font-size: .68rem; font-weight: 700; background: var(--surface-ground); color: var(--text-muted); }
    .ra-day.on { background: var(--action); color: var(--action-ink, #fff); }
    .ra-days-pick { margin: var(--sp-3) 0; }
    .ra-wh { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); margin-bottom: var(--sp-2); }
    .ra-wh-code { flex-shrink: 0; font-family: var(--font-mono, monospace); font-size: .72rem; font-weight: 700; color: var(--text-muted); background: var(--surface-ground); padding: .1rem var(--sp-2); border-radius: 6px; }
    .ra-wh-name { flex: 1; font-weight: 600; color: var(--text-main); font-size: .9rem; }
    .ra-wh-input { flex: 1; min-width: 0; }
    /* p-selectbutton full-width en móvil (los 6 días reparten el ancho) — solo vendor. */
    :host ::ng-deep .ra-days-pick .p-selectbutton { display: flex; width: 100%; }
    :host ::ng-deep .ra-days-pick .p-selectbutton .p-togglebutton { flex: 1; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorRouteAdminComponent implements OnInit {
  private readonly api = inject(SupervisorRoutesService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly workDays = WORK_DAYS;
  readonly dayOptions = DAY_OPTIONS;
  readonly loading = signal(true);
  readonly vendors = signal<AssignableVendor[]>([]);
  readonly routes = signal<RouteCatalogRow[]>([]);
  readonly selectedVendorId = signal<string | null>(null);
  readonly assignments = signal<DailyAssignment[]>([]);
  readonly loadingAssign = signal(false);
  readonly newRouteId = signal<string | null>(null);
  readonly newDays = signal<number[]>([...WORK_DAYS]);
  readonly saving = signal(false);
  // Sucursales (editar nombre)
  readonly warehouses = signal<Warehouse[]>([]);
  readonly editingWhId = signal<string | null>(null);
  readonly whDraft = signal('');
  readonly savingWhId = signal<string | null>(null);

  private readonly routeName = computed(() => new Map(this.routes().map((r) => [r.route_id, r.route])));

  /** Opciones del picker de ruta (label con zona), para p-select. */
  readonly routeOptions = computed(() =>
    this.routes().map((r) => ({ label: r.route + (r.zone ? ' · ' + r.zone : ''), value: r.route_id })),
  );

  /** Asignaciones agrupadas por ruta → set de días. */
  readonly grouped = computed(() => {
    const byRoute = new Map<string, Set<number>>();
    for (const a of this.assignments()) {
      if (!byRoute.has(a.route_id)) byRoute.set(a.route_id, new Set());
      byRoute.get(a.route_id)!.add(Number(a.day_of_week));
    }
    return [...byRoute.entries()].map(([route_id, days]) => ({
      route_id,
      route: this.routeName().get(route_id) || route_id,
      days,
    }));
  });

  dayLabel(d: number): string { return DAY_LABELS[d] || String(d); }

  ngOnInit(): void {
    forkJoin({ vendors: this.api.vendors(), routes: this.api.routeCatalog(), warehouses: this.api.warehouses() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ vendors, routes, warehouses }) => {
          this.vendors.set(vendors);
          this.routes.set(routes);
          // Solo sucursales (no camionetas) — el nombre que ven los vendedores.
          this.warehouses.set((warehouses || []).filter((w) => w.kind !== 'truck'));
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar vendedores/rutas' });
        },
      });
  }

  startEditWh(w: Warehouse): void {
    this.editingWhId.set(w.id);
    this.whDraft.set(w.name);
  }
  cancelEditWh(): void {
    this.editingWhId.set(null);
    this.whDraft.set('');
  }
  saveWhName(w: Warehouse): void {
    const name = this.whDraft().trim();
    if (!name || name === w.name) { this.cancelEditWh(); return; }
    this.savingWhId.set(w.id);
    this.api.renameWarehouse(w.id, name).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.savingWhId.set(null);
        this.warehouses.update((ws) => ws.map((x) => (x.id === w.id ? { ...x, name } : x)));
        this.editingWhId.set(null);
        this.toast.add({ severity: 'success', summary: 'Nombre actualizado' });
      },
      error: (e) => { this.savingWhId.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo renombrar' }); },
    });
  }

  selectVendor(id: string): void {
    this.selectedVendorId.set(id);
    this.newRouteId.set(null);
    this.newDays.set([...WORK_DAYS]);
    this.loadAssignments();
  }

  private loadAssignments(): void {
    const id = this.selectedVendorId();
    if (!id) return;
    this.loadingAssign.set(true);
    this.api.assignmentsFor(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => { this.assignments.set(a || []); this.loadingAssign.set(false); },
      error: () => { this.assignments.set([]); this.loadingAssign.set(false); },
    });
  }

  assign(): void {
    const userId = this.selectedVendorId();
    const routeId = this.newRouteId();
    const days = this.newDays();
    if (!userId || !routeId || !days.length) return;
    // Solo crear los días que faltan (idempotente lado cliente).
    const existing = new Set(
      this.assignments().filter((a) => a.route_id === routeId).map((a) => Number(a.day_of_week)),
    );
    const toCreate = days.filter((d) => !existing.has(d));
    if (!toCreate.length) {
      this.toast.add({ severity: 'info', summary: 'Ya estaba asignada esos días' });
      return;
    }
    this.saving.set(true);
    forkJoin(toCreate.map((d) => this.api.createAssignment(userId, routeId, d)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.toast.add({ severity: 'success', summary: 'Ruta asignada' });
          this.newRouteId.set(null);
          this.newDays.set([...WORK_DAYS]);
          this.loadAssignments();
        },
        error: (e) => {
          this.saving.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo asignar' });
        },
      });
  }

  removeRoute(routeId: string): void {
    const ids = this.assignments().filter((a) => a.route_id === routeId).map((a) => a.id);
    if (!ids.length) return;
    forkJoin(ids.map((id) => this.api.deleteAssignment(id)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.toast.add({ severity: 'success', summary: 'Ruta quitada' }); this.loadAssignments(); },
        error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo quitar' }),
      });
  }
}
