import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import {
  SupervisorRoutesService,
  AssignableVendor,
  RouteCatalogRow,
  DailyAssignment,
  Warehouse,
} from '../supervisor-routes.service';

const DAY_LABELS: Record<number, string> = { 1: 'L', 2: 'M', 3: 'M', 4: 'J', 5: 'V', 6: 'S', 7: 'D' };
const WORK_DAYS = [1, 2, 3, 4, 5, 6];

/**
 * Panel de supervisor (vendor app): asigna rutas a vendedores. Escribe en
 * `daily_assignments` — lo que la cartera del vendedor lee para mostrar "Mi ruta".
 * Reemplaza el pedirlo por Thot: el supervisor lo hace él mismo desde la app.
 */
@Component({
  selector: 'app-vendor-route-admin',
  standalone: true,
  imports: [FormsModule, ToastModule],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>
    <div class="ra">
      <header class="ra-head">
        <h1><i class="pi pi-directions"></i> Asignar rutas</h1>
        <p>Elegí un vendedor y asignale su ruta y los días que la recorre. Aparece de inmediato en su "Mi ruta".</p>
      </header>

      <!-- Vendedor -->
      <label class="ra-lbl">Vendedor</label>
      <select class="ra-select" [ngModel]="selectedVendorId()" (ngModelChange)="selectVendor($event)">
        <option [ngValue]="null" disabled>Elegí un vendedor…</option>
        @for (v of vendors(); track v.id) {
          <option [ngValue]="v.id">{{ v.username }}</option>
        }
      </select>

      @if (selectedVendorId()) {
        <!-- Asignaciones actuales -->
        <div class="ra-section">
          <div class="ra-section-h">Rutas asignadas</div>
          @if (loadingAssign()) {
            <div class="ra-muted">Cargando…</div>
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
                <button class="ra-rm" (click)="removeRoute(g.route_id)" aria-label="Quitar ruta">
                  <i class="pi pi-trash"></i>
                </button>
              </div>
            }
          }
        </div>

        <!-- Nueva asignación -->
        <div class="ra-section">
          <div class="ra-section-h">Asignar una ruta</div>
          <select class="ra-select" [ngModel]="newRouteId()" (ngModelChange)="newRouteId.set($event)">
            <option [ngValue]="null" disabled>Elegí una ruta…</option>
            @for (r of routes(); track r.route_id) {
              <option [ngValue]="r.route_id">{{ r.route }}{{ r.zone ? ' · ' + r.zone : '' }}</option>
            }
          </select>
          <div class="ra-days-pick">
            @for (d of workDays; track d) {
              <button type="button" class="ra-day-btn" [class.on]="newDays().has(d)" (click)="toggleDay(d)">{{ dayLabel(d) }}</button>
            }
          </div>
          <button class="ra-assign-btn" [disabled]="!newRouteId() || newDays().size === 0 || saving()" (click)="assign()">
            <i class="pi" [class.pi-spin]="saving()" [class.pi-spinner]="saving()" [class.pi-check]="!saving()"></i>
            Asignar ruta
          </button>
        </div>
      }

      <!-- Sucursales: editar el nombre que ven los vendedores -->
      <div class="ra-section">
        <div class="ra-section-h">Sucursales</div>
        @for (w of warehouses(); track w.id) {
          <div class="ra-wh">
            <code class="ra-wh-code">{{ w.code }}</code>
            @if (editingWhId() === w.id) {
              <input class="ra-wh-input" type="text" [ngModel]="whDraft()" (ngModelChange)="whDraft.set($event)"
                (keyup.enter)="saveWhName(w)" [attr.aria-label]="'Nombre de ' + w.code" />
              <button class="ra-wh-ic ok" (click)="saveWhName(w)" [disabled]="savingWhId() === w.id || !whDraft().trim()" aria-label="Guardar">
                <i class="pi" [class.pi-spin]="savingWhId() === w.id" [class.pi-spinner]="savingWhId() === w.id" [class.pi-check]="savingWhId() !== w.id"></i>
              </button>
              <button class="ra-wh-ic" (click)="cancelEditWh()" aria-label="Cancelar"><i class="pi pi-times"></i></button>
            } @else {
              <span class="ra-wh-name">{{ w.name }}</span>
              <button class="ra-wh-ic" (click)="startEditWh(w)" aria-label="Editar nombre"><i class="pi pi-pencil"></i></button>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ra-head h1 { display: flex; align-items: center; gap: .5rem; font-size: 1.2rem; margin: 0 0 .25rem; color: var(--text-main); }
    .ra-head p { margin: 0 0 1rem; color: var(--text-muted); font-size: .85rem; line-height: 1.4; }
    .ra-lbl { display: block; font-size: .78rem; font-weight: 700; color: var(--text-muted); margin: 0 0 .3rem; }
    .ra-select { width: 100%; padding: .7rem .8rem; font-size: .95rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); color: var(--text-main); }
    .ra-section { margin-top: 1.4rem; }
    .ra-section-h { font-size: .8rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; margin-bottom: .5rem; }
    .ra-muted { color: var(--text-muted); font-size: .85rem; padding: .5rem 0; }
    .ra-assign { display: flex; align-items: center; gap: .5rem; padding: .6rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); margin-bottom: .5rem; }
    .ra-assign-info { flex: 1; }
    .ra-route { display: flex; align-items: center; gap: .35rem; font-weight: 700; color: var(--text-main); font-size: .92rem; }
    .ra-route i { color: var(--text-muted); font-size: .8rem; }
    .ra-days { display: flex; gap: .2rem; margin-top: .35rem; }
    .ra-day { width: 1.35rem; height: 1.35rem; display: grid; place-items: center; border-radius: 50%; font-size: .68rem; font-weight: 700; background: var(--surface-ground); color: var(--text-muted); }
    .ra-day.on { background: var(--action); color: #fff; }
    .ra-rm { background: transparent; border: none; color: var(--bad-fg, #dc2626); width: 2.2rem; height: 2.2rem; border-radius: 8px; cursor: pointer; }
    .ra-days-pick { display: flex; gap: .4rem; margin: .6rem 0; }
    .ra-day-btn { flex: 1; padding: .55rem 0; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); color: var(--text-muted); font-weight: 800; font-size: .9rem; cursor: pointer; }
    .ra-day-btn.on { background: var(--action); color: #fff; border-color: var(--action); }
    .ra-assign-btn { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: .5rem; padding: .8rem; border: none; border-radius: var(--r-md, 10px); background: var(--action); color: #fff; font-weight: 700; font-size: .95rem; cursor: pointer; }
    .ra-assign-btn:disabled { opacity: .5; }
    .ra-wh { display: flex; align-items: center; gap: .5rem; padding: .5rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); margin-bottom: .4rem; }
    .ra-wh-code { flex-shrink: 0; font-family: var(--font-mono, monospace); font-size: .72rem; font-weight: 700; color: var(--text-muted); background: var(--surface-ground); padding: .1rem .4rem; border-radius: 6px; }
    .ra-wh-name { flex: 1; font-weight: 600; color: var(--text-main); font-size: .9rem; }
    .ra-wh-input { flex: 1; padding: .45rem .55rem; border: 1px solid var(--action); border-radius: 8px; background: var(--card-bg); color: var(--text-main); font-size: .9rem; }
    .ra-wh-ic { flex-shrink: 0; width: 2rem; height: 2rem; display: grid; place-items: center; border: none; background: transparent; color: var(--text-muted); border-radius: 8px; cursor: pointer; }
    .ra-wh-ic:active { background: var(--surface-ground); }
    .ra-wh-ic.ok { color: var(--action); }
    .ra-wh-ic:disabled { opacity: .4; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorRouteAdminComponent implements OnInit {
  private readonly api = inject(SupervisorRoutesService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly workDays = WORK_DAYS;
  readonly vendors = signal<AssignableVendor[]>([]);
  readonly routes = signal<RouteCatalogRow[]>([]);
  readonly selectedVendorId = signal<string | null>(null);
  readonly assignments = signal<DailyAssignment[]>([]);
  readonly loadingAssign = signal(false);
  readonly newRouteId = signal<string | null>(null);
  readonly newDays = signal<Set<number>>(new Set(WORK_DAYS));
  readonly saving = signal(false);
  // Sucursales (editar nombre)
  readonly warehouses = signal<Warehouse[]>([]);
  readonly editingWhId = signal<string | null>(null);
  readonly whDraft = signal('');
  readonly savingWhId = signal<string | null>(null);

  private readonly routeName = computed(() => new Map(this.routes().map((r) => [r.route_id, r.route])));

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
        },
        error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar vendedores/rutas' }),
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
    this.newDays.set(new Set(WORK_DAYS));
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

  toggleDay(d: number): void {
    this.newDays.update((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d); else n.add(d);
      return n;
    });
  }

  assign(): void {
    const userId = this.selectedVendorId();
    const routeId = this.newRouteId();
    const days = [...this.newDays()];
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
          this.newDays.set(new Set(WORK_DAYS));
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
