import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { makeLazyLoad, makeDebouncedSearch } from '../../../shared/util';
import { CustomerFormDialogComponent } from '../components/customer-form-dialog.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { Customer360PanelComponent } from '../../../shared/components/customer-360-panel/customer-360-panel.component';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';

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
    CustomerFormDialogComponent,
    SidePeekComponent,
    Customer360PanelComponent,
    CountUpDirective,
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
            severity="contrast"
            (click)="openCreate()"
          ></button>
        </div>
      </header>

      <!-- KPI STRIP — resumen del total (no del paginado) -->
      <div class="sheet cols-12" *ngIf="summaryAll().length > 0">
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-users"></i></span>
          <span class="cell-label">Activos</span>
          <span class="cell-value is-headline" [appCountUp]="kpis().active" countUpFormat="int"></span>
          <span class="cell-sub">en la cartera · altas/día 30d</span>
          <div class="cu-minibars" *ngIf="newBars() as b" aria-hidden="true">
            <svg [attr.viewBox]="'0 0 ' + b.W + ' ' + b.H" preserveAspectRatio="none">
              <rect *ngFor="let r of b.rects" [attr.x]="r.x" [attr.y]="r.y" [attr.width]="r.w" [attr.height]="r.h"></rect>
            </svg>
          </div>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-directions"></i></span>
          <span class="cell-label">Con ruta</span>
          <span class="cell-value" [appCountUp]="kpis().withRoute" countUpFormat="int"></span>
          <span class="cell-sub">asignada a reparto</span>
          <div class="cu-ratio" [attr.aria-label]="routeRatio() + '% de activos con ruta'">
            <div class="cu-ratio-track"><div class="cu-ratio-fill" [style.width.%]="routeRatio()"></div></div>
            <span class="cu-ratio-pct">{{ routeRatio() }}%</span>
          </div>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-map-marker"></i></span>
          <span class="cell-label">Tienda enlazada</span>
          <span class="cell-value" [appCountUp]="kpis().withStore" countUpFormat="int"></span>
          <span class="cell-sub">visibles en Trade</span>
          <div class="cu-ratio" [attr.aria-label]="storeRatio() + '% de activos con tienda'">
            <div class="cu-ratio-track"><div class="cu-ratio-fill" [style.width.%]="storeRatio()"></div></div>
            <span class="cu-ratio-pct">{{ storeRatio() }}%</span>
          </div>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-wallet"></i></span>
          <span class="cell-label">Crédito asignado</span>
          <span class="cell-value" [appCountUp]="kpis().totalCredit" countUpFormat="money-short"></span>
          <span class="cell-sub">suma de límites activos</span>
        </article>
      </div>

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
        [rowsPerPageOptions]="[25, 50, 100, 200]"
        (onLazyLoad)="onLazyLoad($event)"
        responsiveLayout="scroll"
        styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra"
      >
        <ng-template pTemplate="header">
          <tr>
            <th scope="col">Código</th>
            <th scope="col">Cliente</th>
            <th scope="col">Tienda enlazada</th>
            <th scope="col">Ruta</th>
            <th scope="col" class="comm-num">Crédito</th>
            <th scope="col">Estado</th>
            <th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr (click)="openCustomer(c)" (keydown.enter)="openCustomer(c)" (keydown.space)="$event.preventDefault(); openCustomer(c)"
              tabindex="0" role="button"
              [attr.aria-label]="'Ver 360° de ' + c.name" class="comm-row-clickable">
            <td><code class="comm-code">{{ c.code }}</code></td>
            <td>
              <div class="comm-cell-strong">{{ c.name }}</div>
              <div class="cu-cell-meta">
                <span *ngIf="c.legal_name">{{ c.legal_name }}</span>
                <span *ngIf="c.rfc"><i class="pi pi-id-card" aria-hidden="true"></i>{{ c.rfc }}</span>
                <span *ngIf="c.email"><i class="pi pi-envelope" aria-hidden="true"></i>{{ c.email }}</span>
                <span *ngIf="c.phone"><i class="pi pi-phone" aria-hidden="true"></i>{{ c.phone }}</span>
                <span *ngIf="c.whatsapp"><i class="pi pi-whatsapp" aria-hidden="true"></i>{{ c.whatsapp }}</span>
                <span *ngIf="c.portal_username" class="cu-portal-chip" pTooltip="Acceso al Portal B2B"><i class="pi pi-key" aria-hidden="true"></i>{{ c.portal_username }}</span>
              </div>
            </td>
            <td class="cu-link-cell">
              <span *ngIf="c.store_id" class="cu-store-chip" pTooltip="Vínculo 1:1 fijado al alta de la tienda">
                <i class="pi pi-map-marker" aria-hidden="true"></i>
                <span>{{ storeName(c.store_id) }}</span>
              </span>
              <span *ngIf="!c.store_id" class="comm-muted is-small">—</span>
            </td>
            <td class="cu-link-cell">
              <span *ngIf="c.sales_route" class="cu-store-chip">
                <i class="pi pi-directions" aria-hidden="true"></i>
                <span>{{ c.sales_route }}</span>
              </span>
              <span *ngIf="!c.sales_route" class="comm-muted is-small">—</span>
            </td>
            <td class="comm-num">
              <div class="comm-cell-strong">{{ c.credit_limit || 0 | currency:'MXN':'symbol-narrow':'1.0-2' }}</div>
              <div class="comm-muted is-small">{{ c.payment_terms_days ?? 0 }}d pago</div>
            </td>
            <td>
              <span class="cu-status" [class.is-on]="c.active !== false">
                <span class="cu-status-dot" aria-hidden="true"></span>
                {{ c.active !== false ? 'Activo' : 'Inactivo' }}
              </span>
            </td>
            <td class="comm-actions" (click)="$event.stopPropagation()">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(c)" pTooltip="Editar"></button>
              @if (c.active !== false) {
                @if (c.portal_username) {
                  <button pButton icon="pi pi-refresh" size="small" severity="secondary" [text]="true"
                          [disabled]="creatingAccessId() === c.id"
                          (click)="resetPortalAccess(c)"
                          [pTooltip]="'Resetear contraseña de ' + c.portal_username"></button>
                } @else {
                  <button pButton icon="pi pi-key" size="small" severity="secondary" [text]="true"
                          [disabled]="creatingAccessId() === c.id"
                          (click)="createPortalAccess(c)"
                          pTooltip="Crear acceso Portal B2B"></button>
                }
              }
              <button pButton icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="confirmDelete(c)" *ngIf="c.active !== false" pTooltip="Desactivar"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr>
            <td colspan="7" class="comm-empty-cell">
              <div class="comm-empty">
                <div class="comm-empty-icon"><i class="pi pi-users" aria-hidden="true"></i></div>
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

    <app-customer-form-dialog
      [visible]="dialogVisible"
      (visibleChange)="dialogVisible = $event"
      [form]="form"
      [editing]="editing()"
      [saving]="saving()"
      [routes]="routes()"
      [editingStoreName]="editingStoreName()"
      (save)="save()"
      (cancel)="closeDialog()"
    ></app-customer-form-dialog>

    <!-- J.6.3: dialog que muestra password temporal UNA SOLA VEZ -->
    <p-dialog
      [(visible)]="accessDialogVisible"
      [modal]="true"
      [closable]="true"
      [draggable]="false"
      [style]="{ width: '460px' }"
      [header]="accessMode() === 'reset' ? 'Contraseña Portal B2B reseteada' : 'Acceso Portal B2B creado'"
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
          El cliente entra al Portal B2B con tenant_slug <code class="comm-code">mega_dulces</code>.
          Cuando se loguee, debería cambiar el password desde su perfil.
        </p>
      </div>
      <ng-template pTemplate="footer">
        <button pButton label="Cerrar" icon="pi pi-check" (click)="accessDialogVisible = false"></button>
      </ng-template>
    </p-dialog>

    <!-- Side-peek: drill-down 360° del cliente (DESIGN.md regla #8) -->
    <app-side-peek
      [open]="peekOpen()"
      (openChange)="peekOpen.set($event)"
      [title]="peekRow()?.name || 'Cliente'"
      [subtitle]="peekRow()?.code || null"
    >
      <app-customer-360-panel [customerId]="peekRow()?.id || null" />
    </app-side-peek>
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
      border-color: var(--action);
      box-shadow: 0 0 0 3px var(--action-ring);
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

    /* ── Sub-meta debajo del nombre del cliente ── */
    .cu-cell-meta {
      display: flex;
      flex-wrap: wrap;
      gap: .75rem;
      margin-top: .15rem;
      font-size: var(--fs-xs);
      color: var(--c-text-3);
    }
    .cu-cell-meta span {
      display: inline-flex;
      align-items: center;
      gap: .3rem;
    }
    .cu-cell-meta i { font-size: var(--fs-nano); color: var(--c-text-3); }
    /* Username del Portal B2B: chip con leve acento para distinguir "tiene acceso". */
    .cu-portal-chip {
      font-family: var(--font-mono, monospace);
      color: var(--action, var(--c-text-1));
      font-weight: 600;
    }
    .cu-portal-chip i { color: var(--action, var(--c-text-3)) !important; }

    /* ── CHIP de tienda/ruta en la lista (solo lectura) ── */
    .cu-link-cell { min-width: 160px; }
    .cu-store-chip { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .cu-store-chip i { color: var(--c-text-3); font-size: var(--fs-xs); }

    /* ── MICRO-VIZ del KPI strip: cada card según su tipo de dato ──
       Activos = mini-barras (altas/día, serie real). Cobertura = barra de ratio. */
    .cu-minibars { margin-top: auto; padding-top: .75rem; width: 100%; height: 28px; }
    .cu-minibars svg { width: 100%; height: 100%; display: block; }
    .cu-minibars rect { fill: var(--c-text-3, var(--neutral-400)); }
    .cu-minibars rect:last-of-type { fill: var(--action); }

    .cu-ratio { display: flex; align-items: center; gap: .5rem; margin-top: auto; padding-top: .75rem; }
    .cu-ratio-track {
      flex: 1; height: 6px; border-radius: 999px;
      background: var(--c-surface-2); overflow: hidden;
    }
    .cu-ratio-fill {
      height: 100%; border-radius: 999px; background: var(--action);
      transition: width 500ms var(--ease-out, cubic-bezier(.23,1,.32,1));
    }
    .cu-ratio-pct {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-2);
      min-width: 34px; text-align: right;
    }
    @media (prefers-reduced-motion: reduce) { .cu-ratio-fill { transition: none; } }

    /* ── ESTADO dot + label (sin pill llena) ── */
    .cu-status {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-3);
    }
    .cu-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--c-text-3);
    }
    .cu-status.is-on { color: var(--c-text-1); }
    .cu-status.is-on .cu-status-dot { background: var(--c-ok); }

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
      font-family: var(--font-mono);
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
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<Customer[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(25);
  readonly loading = signal(false);
  readonly searchTerm = signal('');
  onlyActiveValue = true;
  readonly onlyActive = signal(true);

  // Side-peek: drill-down 360° (contenido en Customer360PanelComponent)
  readonly peekOpen = signal(false);
  readonly peekRow = signal<Customer | null>(null);

  readonly editing = signal<Customer | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;
  readonly editingStoreName = computed(() => {
    const e = this.editing();
    return e?.store_id ? this.storeName(e.store_id) : null;
  });

  // J.6.3 — Portal B2B access
  readonly creatingAccessId = signal<string | null>(null);
  readonly lastAccess = signal<{ username: string; temporary_password: string; user_id: string } | null>(null);
  /** Modo del diálogo de revelado: acceso recién creado vs password reseteado. */
  readonly accessMode = signal<'created' | 'reset'>('created');
  accessDialogVisible = false;

  /** Resumen total cargado aparte (todas las filas) para KPI strip — independiente del paginado actual. */
  readonly summaryAll = signal<Customer[]>([]);
  readonly kpis = computed(() => {
    const list = this.summaryAll();
    const active = list.filter((c) => c.active !== false);
    return {
      active: active.length,
      withRoute: active.filter((c) => !!c.sales_route).length,
      withStore: active.filter((c) => !!c.store_id).length,
      totalCredit: active.reduce((s, c) => s + Number(c.credit_limit || 0), 0),
    };
  });

  /** Altas de clientes/día (serie real) → mini-barras de la card "Activos". */
  readonly newSeries = signal<number[]>([]);
  readonly newBars = computed(() => this.bars(this.newSeries()));

  /** Ratios de cobertura (% de activos) → barra de ratio en sus cards. */
  readonly routeRatio = computed(() => {
    const k = this.kpis();
    return k.active > 0 ? Math.round((k.withRoute / k.active) * 100) : 0;
  });
  readonly storeRatio = computed(() => {
    const k = this.kpis();
    return k.active > 0 ? Math.round((k.withStore / k.active) * 100) : 0;
  });

  /** Geometría de un mini-bar chart. viewBox 100×28, stretch. */
  private bars(values: number[]) {
    const n = values.length;
    if (n < 2) return null;
    const W = 100;
    const H = 28;
    const gap = 1.2;
    const max = Math.max(...values, 1);
    const barW = (W - gap * (n - 1)) / n;
    const rects = values.map((v, i) => {
      const h = max > 0 ? (v / max) * H : 0;
      return { x: i * (barW + gap), y: H - h, w: barW, h };
    });
    return { W, H, rects };
  }

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

  form: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_-]{2,50}$/)]],
    name: ['', Validators.required],
    legal_name: [''],
    rfc: [''],
    email: ['', Validators.email],
    phone: [''],
    credit_limit: [0],
    payment_terms_days: [0],
    whatsapp: [''],
    route_id: [null],
    notes: [''],
  });

  constructor() {
    this.loadStores();
    this.loadRoutes();
    this.load();
    this.loadSummary();
  }

  private loadSummary(): void {
    this.api.listCustomers({ pageSize: 9999 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.summaryAll.set(r.data || []),
      error: () => this.summaryAll.set([]),
    });
    this.api.newCustomersDaily(30).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => this.newSeries.set((rows || []).map((r) => r.count)),
      error: () => this.newSeries.set([]),
    });
  }

  fmtMoneyShort(n: number | undefined | null): string {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
    return '$' + v.toFixed(0);
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
    this.logistica.listRoutes({ active: true }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (list) => {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'es'));
        this.routes.set(sorted);
        this.routesById.clear();
        for (const r of sorted) this.routesById.set(r.id, r);
      },
      error: () => this.routes.set([]),
    });
  }

  private loadStores(): void {
    this.api.listStores().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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

  load(): void {
    this.loading.set(true);
    this.api
      .listCustomers({
        page: this.page(),
        pageSize: this.pageSize(),
        search: this.searchTerm() || undefined,
        active: this.onlyActive() ? true : undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
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

  readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => this.load());

  readonly onSearchChange = makeDebouncedSearch((v) => {
    this.searchTerm.set(v.trim());
    this.page.set(1);
    this.load();
  });

  /** Abre el side-peek con el 360° del cliente (clic en fila). */
  openCustomer(c: Customer): void {
    this.peekRow.set(c);
    this.peekOpen.set(true);
  }

  openCreate(): void {
    this.editing.set(null);
    this.form.reset({
      code: '', name: '', legal_name: '', rfc: '', email: '', phone: '',
      credit_limit: 0, payment_terms_days: 0, whatsapp: '', route_id: null, notes: '',
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
      whatsapp: c.whatsapp || '',
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
      route_id: raw.route_id || null,
    };
    const editing = this.editing();
    const obs = editing
      ? this.api.updateCustomer(editing.id, payload)
      : this.api.createCustomer(payload);
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: editing ? 'Cliente actualizado' : 'Cliente creado' });
        this.load();
        this.loadSummary();
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
        this.api.deleteCustomer(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Cliente desactivado' });
            this.load();
            this.loadSummary();
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
        this.accessMode.set('created');
        this.creatingAccessId.set(c.id);
        this.api.createPortalAccess(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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

  /**
   * J.6.3b — Resetea la contraseña del acceso Portal B2B existente. Reusa el
   * mismo dialog one-time-reveal que createPortalAccess (modo 'reset').
   */
  resetPortalAccess(c: Customer): void {
    if (this.creatingAccessId() === c.id) return;
    this.confirm.confirm({
      message: `¿Resetear la contraseña del Portal B2B de "${c.name}" (usuario ${c.portal_username})? La contraseña anterior dejará de funcionar y la nueva se mostrará una sola vez.`,
      header: 'Resetear contraseña Portal B2B',
      icon: 'pi pi-refresh',
      acceptLabel: 'Sí, resetear',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-warning',
      accept: () => {
        this.accessMode.set('reset');
        this.creatingAccessId.set(c.id);
        this.api.resetPortalAccess(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
              summary: 'No se pudo resetear',
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
