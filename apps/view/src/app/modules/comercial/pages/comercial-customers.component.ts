import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputSwitchModule } from 'primeng/inputswitch';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, Customer, Store } from '../comercial.service';
import { LogisticaService, Route } from '../../logistica/logistica.service';
import { debounceTime, Subject } from 'rxjs';

@Component({
  selector: 'app-comercial-customers',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    CardModule,
    TableModule,
    TagModule,
    DialogModule,
    InputTextModule,
    InputNumberModule,
    InputSwitchModule,
    IconFieldModule,
    InputIconModule,
    SelectModule,
    ToastModule,
    TooltipModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page cu">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <!-- PAGE HEAD edge-to-edge -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Clientes B2B</h1>
          <p class="surf-page-sub">
            <b>{{ total() }}</b> cliente{{ total() === 1 ? '' : 's' }} registrado{{ total() === 1 ? '' : 's' }}
          </p>
        </div>
        <div class="cu-head-actions">
          <button
            pButton
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            size="small"
            (click)="load()"
            [loading]="loading()"
            pTooltip="Refrescar"
          ></button>
          <button
            pButton
            icon="pi pi-plus"
            label="Nuevo cliente"
            size="small"
            (click)="openCreate()"
          ></button>
        </div>
      </header>

      <!-- FILTERS toolbar densa -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush cu-filters-cell">
          <div class="cu-toolbar">
            <!-- Search -->
            <div class="cu-search">
              <i class="pi pi-search cu-search-icon" aria-hidden="true"></i>
              <input
                type="search"
                [value]="searchTerm()"
                (input)="onSearchChange($any($event.target).value)"
                placeholder="Buscar por nombre, código, RFC o email…"
                inputmode="search"
                enterkeyhint="search"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                aria-label="Buscar clientes"
              />
              <button
                *ngIf="searchTerm()"
                type="button"
                class="cu-search-clear"
                (click)="clearSearch()"
                aria-label="Limpiar búsqueda"
              >
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </div>

            <!-- Spacer -->
            <div class="cu-toolbar-spacer"></div>

            <!-- Active toggle: segmented Activos / Todos -->
            <div class="cu-segment" role="group" aria-label="Filtro de estado">
              <button
                type="button"
                class="cu-seg-btn"
                [class.active]="onlyActiveValue"
                (click)="setActive(true)"
              >Activos</button>
              <button
                type="button"
                class="cu-seg-btn"
                [class.active]="!onlyActiveValue"
                (click)="setActive(false)"
              >Todos</button>
            </div>
          </div>
        </article>
      </div>

      <!-- TABLA flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table
        [value]="rows()"
        [loading]="loading()"
        [lazy]="true"
        [paginator]="true"
        [rows]="pageSize()"
        [totalRecords]="total()"
        [first]="(page() - 1) * pageSize()"
        (onLazyLoad)="onLazyLoad($event)"
        responsiveLayout="scroll"
        styleClass="p-datatable-sm"
      >
        <ng-template pTemplate="header">
          <tr>
            <th>Código</th>
            <th>Nombre</th>
            <th>Tienda enlazada</th>
            <th>Ruta</th>
            <th>RFC</th>
            <th>Email / Teléfono</th>
            <th class="comm-num">Crédito</th>
            <th class="comm-num">Días pago</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr>
            <td><code class="comm-code">{{ c.code }}</code></td>
            <td>
              <div class="comm-cell-strong">{{ c.name }}</div>
              <div class="comm-muted is-small" *ngIf="c.legal_name">{{ c.legal_name }}</div>
            </td>
            <td class="store-cell">
              <p-select
                [options]="stores()"
                [ngModel]="c.store_id"
                [ngModelOptions]="{ standalone: true }"
                (onChange)="linkStore(c, $event.value)"
                optionLabel="nombre"
                optionValue="id"
                placeholder="— Sin enlazar —"
                [filter]="true"
                filterBy="nombre,direccion"
                [showClear]="true"
                appendTo="body"
                styleClass="row-store-select"
                [disabled]="linkingId() === c.id"
              >
                <ng-template let-s pTemplate="selectedItem">
                  <div class="store-link">
                    <i class="pi pi-map-marker"></i>
                    <span>{{ s.nombre }}</span>
                  </div>
                </ng-template>
                <ng-template let-s pTemplate="item">
                  <div class="store-option">
                    <i class="pi pi-map-marker"></i>
                    <div>
                      <div>{{ s.nombre }}</div>
                      <div class="comm-muted is-small" *ngIf="s.direccion">{{ s.direccion }}</div>
                    </div>
                  </div>
                </ng-template>
              </p-select>
              <i *ngIf="linkingId() === c.id" class="pi pi-spin pi-spinner saving-spinner" aria-label="Guardando…"></i>
            </td>
            <td class="route-cell">
              <p-select
                [options]="routes()"
                [ngModel]="c.route_id"
                [ngModelOptions]="{ standalone: true }"
                (onChange)="linkRoute(c, $event.value)"
                optionLabel="name"
                optionValue="id"
                placeholder="— Sin ruta —"
                [filter]="true"
                filterBy="name"
                [showClear]="true"
                appendTo="body"
                styleClass="row-route-select"
                [disabled]="linkingRouteId() === c.id"
              >
                <ng-template let-r pTemplate="selectedItem">
                  <div class="route-link">
                    <i class="pi pi-directions"></i>
                    <span>{{ r.name }}</span>
                  </div>
                </ng-template>
                <ng-template let-r pTemplate="item">
                  <div class="route-option">
                    <i class="pi pi-directions"></i>
                    <span>{{ r.name }}</span>
                  </div>
                </ng-template>
              </p-select>
              <i *ngIf="linkingRouteId() === c.id" class="pi pi-spin pi-spinner saving-spinner" aria-label="Guardando…"></i>
            </td>
            <td>{{ c.rfc || '—' }}</td>
            <td>
              <div *ngIf="c.email">{{ c.email }}</div>
              <div class="comm-muted is-small" *ngIf="c.phone">{{ c.phone }}</div>
              <span *ngIf="!c.email && !c.phone" class="comm-muted">—</span>
            </td>
            <td class="comm-num">{{ c.credit_limit || 0 | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
            <td class="comm-num">{{ c.payment_terms_days ?? 0 }}</td>
            <td>
              <span *ngIf="c.active !== false" class="comm-pill is-active">Activo</span>
              <span *ngIf="c.active === false" class="comm-pill is-inactive">Inactivo</span>
            </td>
            <td class="comm-actions">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(c)" pTooltip="Editar"></button>
              <button pButton icon="pi pi-key" size="small" severity="success" [text]="true"
                      *ngIf="c.active !== false"
                      [disabled]="creatingAccessId() === c.id"
                      (click)="createPortalAccess(c)"
                      pTooltip="Crear acceso Portal B2B"></button>
              <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDelete(c)" *ngIf="c.active !== false" pTooltip="Soft-delete"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr>
            <td colspan="10" class="cu-empty-cell">
              <div class="cu-empty">
                <div class="cu-empty-icon"><i class="pi pi-users" aria-hidden="true"></i></div>
                <h3>Sin clientes</h3>
                <p>{{ searchTerm() ? 'No encontramos clientes con esa búsqueda.' : 'Aún no hay clientes registrados.' }}</p>
                <button
                  *ngIf="searchTerm()"
                  type="button"
                  pButton
                  icon="pi pi-refresh"
                  severity="secondary"
                  [outlined]="true"
                  size="small"
                  label="Limpiar búsqueda"
                  (click)="clearSearch()"
                ></button>
              </div>
            </td>
          </tr>
        </ng-template>
      </p-table>
        </article>
      </div>
    </div>

    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '560px' }"
      [header]="editing() ? 'Editar cliente' : 'Nuevo cliente'"
    >
      <form [formGroup]="form" class="comm-form-grid" *ngIf="form">
        <label>
          <span>Código <em>*</em></span>
          <input pInputText formControlName="code" placeholder="ej: ABARROTES-001" />
        </label>
        <label>
          <span>Nombre <em>*</em></span>
          <input pInputText formControlName="name" />
        </label>
        <label class="full">
          <span>Razón social</span>
          <input pInputText formControlName="legal_name" />
        </label>
        <label>
          <span>RFC</span>
          <input pInputText formControlName="rfc" maxlength="13" style="text-transform:uppercase" />
        </label>
        <label>
          <span>Email</span>
          <input pInputText formControlName="email" type="email" />
        </label>
        <label>
          <span>Teléfono</span>
          <input pInputText formControlName="phone" />
        </label>
        <label>
          <span>Límite de crédito (MXN)</span>
          <p-inputNumber formControlName="credit_limit" mode="currency" currency="MXN" locale="es-MX" />
        </label>
        <label>
          <span>Días de pago</span>
          <p-inputNumber formControlName="payment_terms_days" [min]="0" [max]="180" />
        </label>
        <label class="full">
          <span>Ruta de reparto</span>
          <p-select
            formControlName="route_id"
            [options]="routes()"
            optionLabel="name"
            optionValue="id"
            placeholder="— Sin ruta asignada —"
            [filter]="true"
            filterBy="name"
            [showClear]="true"
            appendTo="body"
            styleClass="store-select"
          ></p-select>
          <span class="comm-muted is-small">
            La ruta se hereda automáticamente a cada pedido del cliente,
            así logística puede armar embarques agrupados por ruta.
          </span>
        </label>
        <label class="full">
          <span>Tienda enlazada (Trade Marketing)</span>
          <p-select
            formControlName="store_id"
            [options]="stores()"
            optionLabel="nombre"
            optionValue="id"
            placeholder="Sin enlazar — solo cliente comercial"
            [filter]="true"
            filterBy="nombre,direccion"
            [showClear]="true"
            appendTo="body"
            styleClass="store-select"
          >
            <ng-template let-s pTemplate="item">
              <div class="store-option">
                <i class="pi pi-map-marker"></i>
                <div>
                  <div>{{ s.nombre }}</div>
                  <div class="comm-muted is-small" *ngIf="s.direccion">{{ s.direccion }}</div>
                </div>
              </div>
            </ng-template>
          </p-select>
          <span class="comm-muted is-small">
            Vincula este cliente al PdV físico que auditás en Trade Marketing.
            Mismo lugar, dos vistas: ejecución (exhibiciones) + venta (pedidos).
          </span>
        </label>
        <label class="full">
          <span>Notas internas</span>
          <input pInputText formControlName="notes" placeholder="Visible solo para personal interno" />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="closeDialog()"></button>
        <button pButton [label]="editing() ? 'Guardar' : 'Crear'" icon="pi pi-check"
                [loading]="saving()"
                [disabled]="form.invalid"
                (click)="save()"></button>
      </ng-template>
    </p-dialog>

    <!-- J.6.3: dialog que muestra password temporal UNA SOLA VEZ -->
    <p-dialog
      [(visible)]="accessDialogVisible"
      [modal]="true"
      [closable]="true"
      [draggable]="false"
      [style]="{ width: '460px' }"
      header="Acceso Portal B2B creado"
      (onHide)="onCloseAccessDialog()"
    >
      <div class="access-result" *ngIf="lastAccess() as a">
        <div class="warn-banner">
          <i class="pi pi-exclamation-triangle"></i>
          <span><strong>Copialo ahora.</strong> El password no se mostrará otra vez.</span>
        </div>
        <div class="access-field">
          <label>Usuario</label>
          <div class="access-value">
            <code class="comm-code">{{ a.username }}</code>
            <button pButton icon="pi pi-copy" size="small" severity="secondary" [text]="true"
                    (click)="copyToClipboard(a.username, 'Usuario copiado')"></button>
          </div>
        </div>
        <div class="access-field">
          <label>Password temporal</label>
          <div class="access-value">
            <code class="comm-code pwd">{{ a.temporary_password }}</code>
            <button pButton icon="pi pi-copy" size="small" severity="secondary" [text]="true"
                    (click)="copyToClipboard(a.temporary_password, 'Password copiado')"></button>
          </div>
        </div>
        <p class="comm-muted is-small">
          El cliente entra en <code class="comm-code">/portal/login</code> con tenant_slug <code class="comm-code">mega_dulces</code>.
          Cuando se loguee, debería cambiar el password desde su perfil.
        </p>
      </div>
      <ng-template pTemplate="footer">
        <button pButton label="Cerrar" icon="pi pi-check" (click)="accessDialogVisible = false"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }

    .cu-head-actions { display:flex; gap:.5rem; align-items:center; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── FILTERS TOOLBAR — densa, 32px alturas alineadas ── */
    .cu-filters-cell { display: flex; flex-direction: column; }
    .cu-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .cu-toolbar-spacer { flex: 1; min-width: 0; }

    .cu-search {
      display: inline-flex;
      align-items: center;
      height: 32px;
      width: 320px;
      max-width: 100%;
      flex: 1;
      min-width: 220px;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .cu-search:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px rgba(248, 180, 0, 0.15);
    }
    .cu-search-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    .cu-search input {
      flex: 1;
      border: none;
      background: transparent;
      outline: none;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      min-width: 0;
      padding: 0;
      height: 28px;
    }
    .cu-search input::placeholder { color: var(--c-text-3); }
    .cu-search-clear {
      background: transparent;
      border: none;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      color: var(--c-text-3);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      font-size: var(--fs-xs);
    }
    .cu-search-clear:hover { color: var(--c-text-1); background: var(--c-surface-2); }

    .cu-segment {
      display: inline-flex;
      align-items: stretch;
      height: 32px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }
    .cu-seg-btn {
      background: transparent;
      border: none;
      padding: 0 .75rem;
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      border-radius: 6px;
      transition: all 100ms var(--ease-standard);
      white-space: nowrap;
    }
    .cu-seg-btn:hover { color: var(--c-text-1); }
    .cu-seg-btn.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }

    /* ── INLINE SELECTS dentro de tabla — compactos, sin chrome de PrimeNG ── */
    .store-cell { min-width: 220px; display: flex; align-items: center; gap: .5rem; }
    .route-cell { min-width: 180px; display: flex; align-items: center; gap: .5rem; }

    .store-link, .route-link {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
    }
    .store-link i, .route-link i {
      color: var(--c-text-3);
      font-size: var(--fs-xs);
    }
    .store-option, .route-option {
      display: flex;
      gap: .5rem;
      align-items: flex-start;
    }
    .store-option i, .route-option i {
      color: var(--c-text-3);
      margin-top: .15rem;
    }
    :host ::ng-deep .p-select.store-select { width: 100%; }
    :host ::ng-deep .p-select.row-store-select,
    :host ::ng-deep .p-select.row-route-select {
      width: 100%;
      font-size: var(--fs-sm);
      background: transparent;
      border-color: transparent;
    }
    :host ::ng-deep .p-select.row-store-select:hover,
    :host ::ng-deep .p-select.row-route-select:hover {
      background: var(--c-surface-2);
      border-color: var(--c-divider);
    }
    :host ::ng-deep .p-select.row-store-select .p-select-label,
    :host ::ng-deep .p-select.row-route-select .p-select-label {
      padding: .35rem .55rem;
    }
    .saving-spinner { color: var(--c-accent-fg); font-size: var(--fs-sm); }

    /* ── EMPTY STATE inline en tabla ── */
    .cu-empty-cell { padding: 0 !important; }
    .cu-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      margin: 0 auto;
    }
    .cu-empty-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1rem;
      border-radius: 14px;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      display: grid;
      place-items: center;
      font-size: 1.5rem;
    }
    .cu-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .cu-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }

    /* ── DIALOG B2B access ── */
    .access-result { display: flex; flex-direction: column; gap: 1rem; }
    .warn-banner {
      display: flex;
      align-items: flex-start;
      gap: .5rem;
      background: var(--warn-soft-bg);
      color: var(--warn-soft-fg, var(--c-warn));
      padding: .6rem .8rem;
      border-radius: 8px;
      font-size: var(--fs-sm);
      border: 1px solid var(--warn-border, var(--c-divider));
    }
    .warn-banner i { margin-top: .15rem; }
    .access-field { display: flex; flex-direction: column; gap: .35rem; }
    .access-field label {
      font-size: var(--fs-micro);
      color: var(--c-text-2);
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: var(--fw-bold);
    }
    .access-value {
      display: flex;
      align-items: center;
      gap: .5rem;
      background: var(--c-surface-2);
      padding: .4rem .65rem;
      border-radius: 8px;
      border: 1px solid var(--c-divider);
    }
    .access-value code {
      font-size: var(--fs-body);
      padding: 0;
      background: transparent;
      flex: 1;
    }
    .access-value code.pwd {
      font-family: 'JetBrains Mono', 'Courier New', monospace;
      font-weight: var(--fw-bold);
      letter-spacing: .05em;
      color: var(--c-accent-fg);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialCustomersComponent {
  private readonly api = inject(ComercialService);
  private readonly logistica = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly rows = signal<Customer[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(10);
  readonly loading = signal(false);
  readonly searchTerm = signal('');
  onlyActiveValue = true;
  readonly onlyActive = signal(true);

  readonly editing = signal<Customer | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;

  // J.6.3 — Portal B2B access
  readonly creatingAccessId = signal<string | null>(null);
  readonly lastAccess = signal<{ username: string; temporary_password: string; user_id: string } | null>(null);
  accessDialogVisible = false;

  /** ID del customer cuyo enlace de tienda está guardándose ahora mismo. */
  readonly linkingId = signal<string | null>(null);

  // Tiendas de Trade Marketing — cache compartido para dropdown + lookup en lista.
  // Se carga una sola vez al montar el componente; el endpoint /api/stores
  // devuelve todas las activas del tenant en una sola llamada.
  readonly stores = signal<Store[]>([]);
  private readonly storesById = new Map<string, Store>();

  // Rutas logísticas — cache compartido para dropdown + lookup inline.
  // Asignar la ruta al cliente hace que los pedidos nuevos hereden esa ruta
  // automáticamente (snapshot a commercial.orders.route_id).
  readonly routes = signal<Route[]>([]);
  private readonly routesById = new Map<string, Route>();
  readonly linkingRouteId = signal<string | null>(null);

  form: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_-]{2,50}$/)]],
    name: ['', Validators.required],
    legal_name: [''],
    rfc: [''],
    email: ['', Validators.email],
    phone: [''],
    credit_limit: [0],
    payment_terms_days: [0],
    store_id: [null],
    route_id: [null],
    notes: [''],
  });

  private readonly search$ = new Subject<string>();

  constructor() {
    this.search$.pipe(debounceTime(250)).subscribe((value) => {
      this.searchTerm.set(value.trim());
      this.page.set(1);
      this.load();
    });
    this.loadStores();
    this.loadRoutes();
    this.load();
  }

  clearSearch(): void {
    this.searchTerm.set('');
    this.page.set(1);
    this.load();
  }

  setActive(active: boolean): void {
    if (this.onlyActiveValue === active) return;
    this.onlyActiveValue = active;
    this.onlyActive.set(active);
    this.page.set(1);
    this.load();
  }

  private loadRoutes(): void {
    this.logistica.listRoutes({ active: true }).subscribe({
      next: (list) => {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'es'));
        this.routes.set(sorted);
        this.routesById.clear();
        for (const r of sorted) this.routesById.set(r.id, r);
      },
      error: () => this.routes.set([]),
    });
  }

  routeName(id: string | null | undefined): string {
    if (!id) return '—';
    return this.routesById.get(id)?.name || '—';
  }

  private loadStores(): void {
    this.api.listStores().subscribe({
      next: (list) => {
        const sorted = [...list].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        this.stores.set(sorted);
        this.storesById.clear();
        for (const s of sorted) this.storesById.set(s.id, s);
      },
      error: () => {
        // No bloqueante: si no hay stores, el select queda vacío pero el form sigue funcional.
        this.stores.set([]);
      },
    });
  }

  storeName(id: string | null | undefined): string {
    if (!id) return '—';
    return this.storesById.get(id)?.nombre || 'Tienda no encontrada';
  }

  /**
   * Bulk linker: cambia el store_id de un customer desde la tabla sin abrir el
   * dialog completo. Optimista — actualiza la fila en memoria al instante;
   * si la API falla, revierte y muestra el toast.
   */
  /**
   * Asigna o desasigna la ruta logística del customer desde la tabla.
   * Optimista: aplica al instante; revierte y avisa si la API falla.
   * Cada pedido nuevo del cliente hereda `route_id` al crear el draft.
   */
  linkRoute(c: Customer, routeId: string | null): void {
    const prevId = c.route_id || null;
    const nextId = routeId || null;
    if (prevId === nextId) return;

    this.linkingRouteId.set(c.id);
    const next = this.rows().map((r) => (r.id === c.id ? { ...r, route_id: nextId } : r));
    this.rows.set(next);

    this.api.updateCustomer(c.id, { route_id: nextId } as any).subscribe({
      next: () => {
        this.linkingRouteId.set(null);
        const label = nextId ? this.routeName(nextId) : null;
        this.toast.add({
          severity: 'success',
          summary: label ? `Ruta: ${label}` : 'Ruta removida',
          detail: c.name,
          life: 2500,
        });
      },
      error: (err) => {
        this.linkingRouteId.set(null);
        const reverted = this.rows().map((r) => (r.id === c.id ? { ...r, route_id: prevId } : r));
        this.rows.set(reverted);
        const detail = err?.error?.message || 'No se pudo guardar la ruta';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  linkStore(c: Customer, storeId: string | null): void {
    const prevId = c.store_id || null;
    const nextId = storeId || null;
    if (prevId === nextId) return;

    this.linkingId.set(c.id);
    // Update optimista: mutamos la row en el signal para feedback inmediato.
    const next = this.rows().map((r) => (r.id === c.id ? { ...r, store_id: nextId } : r));
    this.rows.set(next);

    this.api.updateCustomer(c.id, { store_id: nextId ?? undefined as any }).subscribe({
      next: () => {
        this.linkingId.set(null);
        const storeLabel = nextId ? this.storeName(nextId) : null;
        this.toast.add({
          severity: 'success',
          summary: storeLabel ? `Enlazado a ${storeLabel}` : 'Enlace removido',
          detail: c.name,
          life: 2500,
        });
      },
      error: (err) => {
        this.linkingId.set(null);
        // Revertir update optimista.
        const reverted = this.rows().map((r) => (r.id === c.id ? { ...r, store_id: prevId } : r));
        this.rows.set(reverted);
        const detail = err?.error?.message || 'No se pudo guardar el enlace';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  load(): void {
    this.loading.set(true);
    this.api
      .listCustomers({
        page: this.page(),
        pageSize: this.pageSize(),
        search: this.searchTerm() || undefined,
        active: this.onlyActive() ? true : undefined,
      })
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar clientes' });
        },
      });
  }

  onLazyLoad(e: { first?: number | null; rows?: number | null }): void {
    const first = e.first ?? 0;
    const rows = e.rows ?? this.pageSize();
    this.page.set(Math.floor(first / rows) + 1);
    this.pageSize.set(rows);
    this.load();
  }

  onSearchChange(v: string): void {
    this.search$.next(v);
  }

  onToggleActive(): void {
    this.onlyActive.set(this.onlyActiveValue);
    this.page.set(1);
    this.load();
  }

  openCreate(): void {
    this.editing.set(null);
    this.form.reset({
      code: '', name: '', legal_name: '', rfc: '', email: '', phone: '',
      credit_limit: 0, payment_terms_days: 0, store_id: null, route_id: null, notes: '',
    });
    this.form.get('code')?.enable();
    this.dialogVisible = true;
  }

  openEdit(c: Customer): void {
    this.editing.set(c);
    this.form.reset({
      code: c.code,
      name: c.name,
      legal_name: c.legal_name || '',
      rfc: c.rfc || '',
      email: c.email || '',
      phone: c.phone || '',
      credit_limit: c.credit_limit || 0,
      payment_terms_days: c.payment_terms_days ?? 0,
      store_id: c.store_id || null,
      route_id: c.route_id || null,
      notes: c.notes || '',
    });
    this.form.get('code')?.disable();
    this.dialogVisible = true;
  }

  closeDialog(): void {
    this.dialogVisible = false;
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.set(true);
    const raw = this.form.getRawValue();
    const payload = {
      ...raw,
      rfc: raw.rfc?.trim().toUpperCase() || undefined,
      email: raw.email?.trim().toLowerCase() || undefined,
      // store_id: enviar undefined si no se seleccionó (backend lo trata como
      // "sin cambio" en update y "sin link" en create).
      store_id: raw.store_id || undefined,
      route_id: raw.route_id || null,
    };
    const editing = this.editing();
    const obs = editing
      ? this.api.updateCustomer(editing.id, payload)
      : this.api.createCustomer(payload);
    obs.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: editing ? 'Cliente actualizado' : 'Cliente creado' });
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar el cliente';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  confirmDelete(c: Customer): void {
    this.confirm.confirm({
      message: `¿Desactivar al cliente ${c.name}? Esto NO borra los pedidos históricos.`,
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, desactivar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deleteCustomer(c.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Cliente desactivado' });
            this.load();
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo desactivar' }),
        });
      },
    });
  }

  /**
   * J.6.3 — Crea user Portal B2B para el customer. El password se devuelve
   * en el response UNA SOLA VEZ; lo mostramos en un dialog con copy-to-clipboard.
   */
  createPortalAccess(c: Customer): void {
    if (this.creatingAccessId() === c.id) return;
    this.confirm.confirm({
      message: `¿Crear acceso al Portal B2B para "${c.name}"? Se generará un usuario y password temporal. El password solo se mostrará una vez — copialo y entregalo al cliente.`,
      header: 'Crear acceso Portal B2B',
      icon: 'pi pi-key',
      acceptLabel: 'Sí, crear acceso',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-success',
      accept: () => {
        this.creatingAccessId.set(c.id);
        this.api.createPortalAccess(c.id).subscribe({
          next: (res) => {
            this.creatingAccessId.set(null);
            this.lastAccess.set({
              user_id: res.user_id,
              username: res.username,
              temporary_password: res.temporary_password,
            });
            this.accessDialogVisible = true;
          },
          error: (err) => {
            this.creatingAccessId.set(null);
            this.toast.add({
              severity: 'error',
              summary: 'No se pudo crear acceso',
              detail: err?.error?.message || 'Error desconocido',
              life: 8000,
            });
          },
        });
      },
    });
  }

  onCloseAccessDialog(): void {
    // Limpia el password de memoria al cerrar — el admin ya lo copió (o lo perdió).
    this.lastAccess.set(null);
  }

  copyToClipboard(text: string, successMsg: string): void {
    if (!navigator.clipboard) {
      this.toast.add({ severity: 'warn', summary: 'Copy manual', detail: 'Tu navegador no soporta clipboard API. Seleccionar y copiar a mano.' });
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => this.toast.add({ severity: 'success', summary: successMsg, life: 2000 }),
      () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo copiar' }),
    );
  }
}
