import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { TabsModule } from 'primeng/tabs';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfigCategory, ConfigItem, LogisticaService, Route } from '../logistica.service';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * J.9.8 — Config con TabView (5 tabs).
 *
 * Migrado del repo `_imported/logistica/.../features/config/`. Reemplaza la
 * versión básica (1 tabla CRUD plano) con TabView que separa semánticamente:
 *
 *  1. Comisiones por ruta (logistics.routes) — 96 destinos reales
 *  2. Factores por zona (config_finance category=factor)
 *  3. Costos por unidad (config_finance category=costo_km)
 *  4. Tarifas de maniobra (config_finance category=tarifa_maniobra)
 *  5. Viáticos (config_finance category=viatico)
 *
 * CRUD inline en cada tab con dialog modal único reutilizado.
 */
@Component({
  selector: 'app-logistica-config',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    ButtonModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, SelectModule, TabsModule,
    TagModule, ToastModule, TooltipModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page logcfg">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>
    
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Configuración logística</h1>
          <p class="surf-page-sub">Parametrización del sistema. Cambios aplicables a próximos embarques.</p>
        </div>
      </header>
    
      <p-tabs value="routes">
        <p-tablist>
          <p-tab value="routes"><i class="pi pi-map"></i> Comisiones ({{ routes().length }})</p-tab>
          <p-tab value="factor"><i class="pi pi-percentage"></i> Factores ({{ countCat('factor') }})</p-tab>
          <p-tab value="costo_km"><i class="pi pi-car"></i> Costos km ({{ countCat('costo_km') }})</p-tab>
          <p-tab value="tarifa_maniobra"><i class="pi pi-box"></i> Maniobras ({{ countCat('tarifa_maniobra') }})</p-tab>
          <p-tab value="viatico"><i class="pi pi-wallet"></i> Viáticos ({{ countCat('viatico') }})</p-tab>
        </p-tablist>
        <p-tabpanels>
    
          <!-- ──── Tab 1: Comisiones por ruta ──── -->
          <p-tabpanel value="routes">
            <div class="tab-toolbar">
              <input pInputText type="search" [(ngModel)]="routeSearch" (input)="onRouteSearch()" placeholder="Buscar destino..."
                inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
                <button pButton (click)="openRouteDialog()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nueva ruta</span></button>
              </div>
              <section class="surf-panel">
                <div class="surf-panel-body is-flush">
                  <p-table [value]="filteredRoutes()" [loading]="loading()" styleClass="surf-table surf-table--sticky surf-table--frozen-first p-datatable-sm" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100, 200]" sortMode="single">
                    <ng-template #header>
                      <tr>
                        <th scope="col" pSortableColumn="name">Destino <p-sorticon field="name"></p-sorticon></th>
                        <th scope="col" pSortableColumn="estimated_km" class="num">Km <p-sorticon field="estimated_km"></p-sorticon></th>
                        <th scope="col" pSortableColumn="driver_commission" class="num">Chofer <p-sorticon field="driver_commission"></p-sorticon></th>
                        <th scope="col" pSortableColumn="helper_commission" class="num">Ayudante <p-sorticon field="helper_commission"></p-sorticon></th>
                        <th scope="col">Estado</th>
                        <th scope="col"><span class="sr-only">Acciones</span></th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-r>
                      <tr>
                        <td><strong>{{ r.name }}</strong>@if (r.sin_comision) { <span class="tf-fijada">· Sin comisión</span> }@if (rutaFijada(r)) { <span class="tf-fijada"><i class="pi pi-lock" aria-hidden="true"></i> Fijada</span> }</td>
                        <td class="num">{{ r.estimated_km !== null ? (r.estimated_km | number:'1.0-1') : '—' }}</td>
                        <td class="num">\${{ r.driver_commission | number:'1.2-2' }}</td>
                        <td class="num">\${{ r.helper_commission | number:'1.2-2' }}</td>
                        <td><p-tag [value]="r.active ? 'Activa' : 'Inactiva'" [severity]="r.active ? 'success' : 'secondary'"></p-tag></td>
                        <td class="actions">
                          <button pButton size="small" severity="secondary" [text]="true" (click)="openRouteDialog(r)"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span></button>
                          <button pButton size="small" severity="secondary" [text]="true" [disabled]="rutaFijada(r) && !puedeAutorizar()" (click)="confirmDeleteRoute(r)"><span class="p-button-icon p-button-icon-left pi pi-trash" aria-hidden="true"></span></button>
                        </td>
                      </tr>
                    </ng-template>
                    <ng-template #emptymessage>
                      <tr>
                        <td colspan="6" class="comm-empty-cell">
                          <div class="comm-empty">
                            <i class="pi pi-map comm-empty-icon"></i>
                            <span>Sin rutas. Corre <code>logistics_baseline.js</code> para cargar 96 destinos reales.</span>
                          </div>
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                </div>
              </section>
            </p-tabpanel>
    
            <!-- ──── Tab 2-5: config_finance por categoría ──── -->
            @for (cat of configCategories; track cat) {
              <p-tabpanel [value]="cat">
                <div class="tab-toolbar">
                  <span class="muted small">{{ countCat(cat) }} items en categoría "{{ catLabel(cat) }}"</span>
                  <button pButton (click)="openConfigDialog(undefined, cat)"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nuevo item</span></button>
                </div>
                <section class="surf-panel">
                  <div class="surf-panel-body is-flush">
                    <p-table [value]="itemsByCategory(cat)" [loading]="loading()" styleClass="surf-table surf-table--sticky surf-table--frozen-first p-datatable-sm">
                      <ng-template #header>
                        <tr>
                          <th scope="col">Clave</th>
                          <th scope="col">Descripción</th>
                          <th scope="col" class="num">Valor</th>
                          <th scope="col">Unidad</th>
                          <th scope="col">Estado</th>
                          <th scope="col"><span class="sr-only">Acciones</span></th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-c>
                        <tr>
                          <td><code>{{ c.key }}</code>@if (configFijada(c)) { <span class="tf-fijada"><i class="pi pi-lock" aria-hidden="true"></i> Fijada</span> }</td>
                          <td>{{ c.description || '—' }}</td>
                          <td class="num"><strong>{{ c.value | number:'1.2-4' }}</strong></td>
                          <td class="muted">{{ c.unit || '—' }}</td>
                          <td><p-tag [value]="c.active ? 'Activo' : 'Inactivo'" [severity]="c.active ? 'success' : 'secondary'"></p-tag></td>
                          <td class="actions">
                            <button pButton size="small" severity="secondary" [text]="true" (click)="openConfigDialog(c)"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span></button>
                            <button pButton size="small" severity="secondary" [text]="true" [disabled]="configFijada(c) && !puedeAutorizar()" (click)="confirmDeleteConfig(c)"><span class="p-button-icon p-button-icon-left pi pi-trash" aria-hidden="true"></span></button>
                          </td>
                        </tr>
                      </ng-template>
                      <ng-template #emptymessage>
                        <tr>
                          <td colspan="6" class="comm-empty-cell">
                            <div class="comm-empty">
                              <i class="pi pi-sliders-h comm-empty-icon"></i>
                              <span>Sin items en esta categoría. Crea uno con el botón de arriba.</span>
                            </div>
                          </td>
                        </tr>
                      </ng-template>
                    </p-table>
                  </div>
                </section>
              </p-tabpanel>
            }
          </p-tabpanels>
        </p-tabs>
      </div>
    
      <!-- Dialog Route -->
      <p-dialog [(visible)]="routeDialog" [modal]="true" [style]="{ width: '520px' }" [closable]="!savingRoute()"
        [header]="editingRoute() ? 'Editar ruta' : 'Nueva ruta'">
        @if (rutaBloqueada()) {
          <p class="tf-aviso" role="note"><i class="pi pi-lock" aria-hidden="true"></i> Tarifa fijada: sólo un autorizador cambia las comisiones, el nombre o la desactiva. Puedes editar kilómetros y notas.</p>
        }
        <form [formGroup]="routeForm" class="form-grid">
          <label class="full">
            Destino *
            <input pInputText formControlName="name" placeholder="Ej: ZAMORA" />
          </label>
          <label>
            Km estimados
            <p-inputnumber formControlName="estimated_km" [minFractionDigits]="0" [maxFractionDigits]="2"></p-inputnumber>
          </label>
          <label>
            @if (routeForm.value.active) {
              <p-tag value="Activa" severity="success"></p-tag>
            }
            @if (!routeForm.value.active) {
              <p-tag value="Inactiva" severity="secondary"></p-tag>
            }
            <p-button [label]="routeForm.value.active ? 'Desactivar' : 'Activar'" size="small" severity="secondary" [text]="true" type="button" [disabled]="rutaBloqueada()" (click)="toggleRouteActive()"></p-button>
          </label>
          <label class="full tf-sincom">
            <span><input type="checkbox" formControlName="sin_comision" /> No paga comisión (traslado local)</span>
            <small class="muted">La guía se completa con comisión $0: sólo cobran viáticos y cargadores.</small>
          </label>
          <label>
            Comisión chofer
            <p-inputnumber formControlName="driver_commission" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
          </label>
          <label>
            Comisión ayudante
            <p-inputnumber formControlName="helper_commission" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
          </label>
          <label class="full">
            Notas
            <input pInputText formControlName="notes" />
          </label>
        </form>
        <ng-template #footer>
          <button pButton severity="secondary" [text]="true" (click)="routeDialog = false" [disabled]="savingRoute()"><span class="p-button-label">Cancelar</span></button>
          <p-button [label]="editingRoute() ? 'Guardar' : 'Crear'" icon="pi pi-check" (click)="saveRoute()" [loading]="savingRoute()" [disabled]="routeForm.invalid"></p-button>
        </ng-template>
      </p-dialog>
    
      <!-- Dialog Config -->
      <p-dialog [(visible)]="configDialog" [modal]="true" [style]="{ width: '480px' }" [closable]="!savingConfig()"
        [header]="editingConfig() ? 'Editar config' : 'Nuevo config (' + catLabel(configForm.value.category || 'otro') + ')'">
        @if (configBloqueada()) {
          <p class="tf-aviso" role="note"><i class="pi pi-lock" aria-hidden="true"></i> Tarifa fijada: sólo un autorizador cambia el valor, la clave o la categoría. Puedes editar la unidad y la descripción.</p>
        }
        <form [formGroup]="configForm" class="form-grid">
          <label class="full">
            Clave * <i class="pi pi-info-circle" pTooltip="snake_case. Ej: costo_km_freightliner_auto"></i>
            <input pInputText formControlName="key" placeholder="costo_km_..." />
          </label>
          <label>
            Categoría *
            <p-select formControlName="category" [options]="categoryOptions" optionLabel="label" optionValue="value"></p-select>
          </label>
          <label>
            Valor *
            <p-inputnumber formControlName="value" [minFractionDigits]="0" [maxFractionDigits]="4"></p-inputnumber>
          </label>
          <label>
            Unidad
            <input pInputText formControlName="unit" placeholder="mxn/km, pct, mxn" />
          </label>
          <label class="full">
            Descripción
            <input pInputText formControlName="description" />
          </label>
        </form>
        <ng-template #footer>
          <button pButton severity="secondary" [text]="true" (click)="configDialog = false" [disabled]="savingConfig()"><span class="p-button-label">Cancelar</span></button>
          <p-button [label]="editingConfig() ? 'Guardar' : 'Crear'" icon="pi pi-check" (click)="saveConfig()" [loading]="savingConfig()" [disabled]="configForm.invalid"></p-button>
        </ng-template>
      </p-dialog>
    `,
  styles: [`
    :host { display:block; }
    .muted { color: var(--c-text-2); font-size: var(--fs-sm); }
    .small { font-size: var(--fs-xs); }
    code { background: var(--c-surface-2); padding:.1rem .35rem; border-radius:3px; font-size:.85rem; font-family: var(--font-mono); }

    .tab-toolbar { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin:0 0 1rem; flex-wrap:wrap; }
    .tab-toolbar input { min-width: 260px; }
    .num { text-align:right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }

    .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap:1rem; margin-top:1rem; }
    .form-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--c-text-2); }
    .form-grid .full { grid-column: 1 / -1; }
    .tf-sincom span { display: flex; gap: .5rem; align-items: center; color: var(--c-text-1); font-size: var(--fs-sm); }
    .tf-fijada { margin-left: .5rem; font-size: var(--fs-xs); color: var(--c-text-2); white-space: nowrap; }
    .tf-aviso { display: flex; gap: .5rem; align-items: flex-start; margin: .25rem 0 0; padding: .5rem .75rem; border-radius: 8px; background: var(--c-surface-2); color: var(--c-text-1); font-size: var(--fs-sm); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaConfigComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly perms = inject(PermissionsService);

  readonly configs = signal<ConfigItem[]>([]);
  readonly routes = signal<Route[]>([]);
  readonly loading = signal(false);
  readonly savingConfig = signal(false);
  readonly savingRoute = signal(false);
  readonly editingConfig = signal<ConfigItem | null>(null);
  readonly editingRoute = signal<Route | null>(null);
  /** `[EMB.28.1]` El diálogo abierto es de una tarifa fijada y quien edita no es autorizador. */
  readonly rutaBloqueada = signal(false);
  readonly configBloqueada = signal(false);

  configDialog = false;
  routeDialog = false;
  routeSearch = '';
  private searchTimeout: any = null;

  readonly configCategories: ConfigCategory[] = ['factor', 'costo_km', 'tarifa_maniobra', 'viatico'];
  readonly categoryOptions = [
    { label: 'Factor multiplicador', value: 'factor' as ConfigCategory },
    { label: 'Costo por km', value: 'costo_km' as ConfigCategory },
    { label: 'Tarifa maniobra', value: 'tarifa_maniobra' as ConfigCategory },
    { label: 'Viático', value: 'viatico' as ConfigCategory },
    { label: 'Otro', value: 'otro' as ConfigCategory },
  ];

  readonly filteredRoutes = computed(() => {
    const s = this.routeSearch.trim().toLowerCase();
    if (!s) return this.routes();
    return this.routes().filter((r) => r.name.toLowerCase().includes(s));
  });

  configForm: FormGroup = this.fb.group({
    key: ['', Validators.required],
    category: ['factor' as ConfigCategory, Validators.required],
    value: [0, Validators.required],
    unit: [''],
    description: [''],
  });

  routeForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    estimated_km: [null],
    driver_commission: [0],
    helper_commission: [0],
    sin_comision: [false],
    notes: [''],
    active: [true],
  });

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    let configsDone = false;
    let routesDone = false;
    const tryFinish = () => { if (configsDone && routesDone) this.loading.set(false); };

    this.api.listConfig().subscribe({
      next: (list) => { this.configs.set(list || []); configsDone = true; tryFinish(); },
      error: () => { configsDone = true; tryFinish(); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron configs' }); },
    });
    this.api.listRoutes().subscribe({
      next: (list) => { this.routes.set(list || []); routesDone = true; tryFinish(); },
      error: () => { routesDone = true; tryFinish(); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron rutas' }); },
    });
  }

  onRouteSearch(): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => {
      // computed se recalcula automáticamente al cambiar this.routeSearch
      // pero necesitamos forzar el detect change. asignamos same array:
      this.routes.set([...this.routes()]);
    }, 200);
  }

  countCat(cat: ConfigCategory): number {
    return this.configs().filter((c) => c.category === cat).length;
  }
  itemsByCategory(cat: ConfigCategory): ConfigItem[] {
    return this.configs().filter((c) => c.category === cat);
  }
  catLabel(cat: ConfigCategory): string {
    return this.categoryOptions.find((o) => o.value === cat)?.label || cat;
  }

  // ── Config CRUD ─────────────────────────────────────────────────────────

  openConfigDialog(c?: ConfigItem, prefilledCat?: ConfigCategory): void {
    this.editingConfig.set(c || null);
    this.configForm.reset({
      key: c?.key || '',
      category: c?.category || prefilledCat || 'factor',
      value: aNumero(c?.value, 0),
      unit: c?.unit || '',
      description: c?.description || '',
    });
    const bloq = !!c && this.configFijada(c) && !this.puedeAutorizar();
    this.configBloqueada.set(bloq);
    for (const k of ['key', 'category', 'value'] as const) {
      const ctl = this.configForm.get(k);
      if (bloq) ctl?.disable(); else ctl?.enable();
    }
    this.configDialog = true;
  }

  saveConfig(): void {
    if (this.configForm.invalid) return;
    this.savingConfig.set(true);
    const body = this.configForm.value as Partial<ConfigItem>;
    const editing = this.editingConfig();
    const obs$ = editing
      ? this.api.updateConfig(editing.id, body)
      : this.api.createConfig(body);
    obs$.subscribe({
      next: () => {
        this.savingConfig.set(false);
        this.configDialog = false;
        this.toast.add({ severity: 'success', summary: editing ? 'Actualizado' : 'Creado' });
        this.reload();
      },
      error: (e) => {
        this.savingConfig.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se guardó' });
      },
    });
  }

  confirmDeleteConfig(c: ConfigItem): void {
    this.confirm.confirm({
      header: 'Eliminar config',
      message: `¿Borrar la config "${c.key}"? Esta acción no se puede deshacer.`,
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.api.deleteConfig(c.id).subscribe({
          next: () => { this.toast.add({ severity: 'success', summary: 'Borrado' }); this.reload(); },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se borró' }),
        });
      },
    });
  }

  // ── Route CRUD ──────────────────────────────────────────────────────────

  openRouteDialog(r?: Route): void {
    this.editingRoute.set(r || null);
    this.routeForm.reset({
      name: r?.name || '',
      estimated_km: aNumero(r?.estimated_km, null),
      driver_commission: aNumero(r?.driver_commission, 0),
      helper_commission: aNumero(r?.helper_commission, 0),
      sin_comision: !!r?.sin_comision,
      notes: r?.notes || '',
      active: r?.active !== false,
    });
    const bloq = !!r && this.rutaFijada(r) && !this.puedeAutorizar();
    this.rutaBloqueada.set(bloq);
    for (const k of ['name', 'driver_commission', 'helper_commission', 'sin_comision'] as const) {
      const c = this.routeForm.get(k);
      if (bloq) c?.disable(); else c?.enable();
    }
    this.routeDialog = true;
  }

  toggleRouteActive(): void {
    this.routeForm.patchValue({ active: !this.routeForm.value.active });
  }

  saveRoute(): void {
    if (this.routeForm.invalid) return;
    this.savingRoute.set(true);
    const body = this.routeForm.value as Partial<Route>;
    const editing = this.editingRoute();
    const obs$ = editing
      ? this.api.updateRoute(editing.id, body)
      : this.api.createRoute(body);
    obs$.subscribe({
      next: () => {
        this.savingRoute.set(false);
        this.routeDialog = false;
        this.toast.add({ severity: 'success', summary: editing ? 'Actualizado' : 'Creado' });
        this.reload();
      },
      error: (e) => {
        this.savingRoute.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se guardó' });
      },
    });
  }

  confirmDeleteRoute(r: Route): void {
    this.confirm.confirm({
      header: 'Eliminar ruta',
      message: `¿Borrar la ruta "${r.name}"? (soft-delete)`,
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.api.deleteRoute(r.id).subscribe({
          next: () => { this.toast.add({ severity: 'success', summary: 'Borrado' }); this.reload(); },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se borró' }),
        });
      },
    });
  }

  // ── [EMB.28.1] Tarifas fijas ─────────────────────────────────────────────
  // Quien manda es el servidor (logistics-config.service + tarifas-fijas.logic): aquí sólo se
  // evita que alguien escriba algo que se va a rechazar. Misma regla, a propósito sin importarla
  // del backend (libs/logistics no entra al navegador).

  /** Autorizador = `LOGISTICS_TARIFAS_AUTORIZAR` o administrador de plataforma. */
  puedeAutorizar(): boolean {
    return this.perms.isAdmin() || this.perms.has(Permission.LOGISTICS_TARIFAS_AUTORIZAR);
  }

  rutaFijada(r: Pick<Route, 'driver_commission' | 'helper_commission' | 'sin_comision'>): boolean {
    return !!r.sin_comision || (aNumero(r.driver_commission, 0) ?? 0) > 0 || (aNumero(r.helper_commission, 0) ?? 0) > 0;
  }

  configFijada(c: Pick<ConfigItem, 'category' | 'value'>): boolean {
    return (c.category === 'viatico' || c.category === 'tarifa_maniobra') && (aNumero(c.value, 0) ?? 0) > 0;
  }
}

/**
 * Postgres devuelve los numeric como TEXTO ("0.00"). Puesto así en un p-inputnumber, el
 * control se queda con el texto y lo que la persona teclea NO llega al formulario: al guardar se
 * manda "0.00" otra vez. Medido el 2026-10-12: la comisión de CANINDO ZAMORA se editó en prod
 * y quedó en $0 sin ningún error. Por eso todo monto entra al formulario como número.
 */
export function aNumero<T extends number | null>(v: unknown, siVacio: T): number | T {
  if (v === null || v === undefined || v === '') return siVacio;
  const n = Number(v);
  return Number.isFinite(n) ? n : siVacio;
}
