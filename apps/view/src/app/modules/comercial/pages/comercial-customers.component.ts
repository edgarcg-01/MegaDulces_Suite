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
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, Customer, Store } from '../comercial.service';
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
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row">
      <div>
        <h2>Clientes B2B</h2>
        <p class="muted">Gestión de cuentas comerciales. {{ total() }} registros.</p>
      </div>
      <button pButton icon="pi pi-plus" label="Nuevo cliente" (click)="openCreate()"></button>
    </div>

    <p-card>
      <div class="filters">
        <p-iconField iconPosition="left">
          <p-inputIcon styleClass="pi pi-search" />
          <input pInputText type="search" placeholder="Buscar por nombre, código, RFC, email…"
                 [value]="searchTerm()"
                 (input)="onSearchChange($any($event.target).value)"
                 inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
        </p-iconField>
        <div class="active-toggle">
          <label>Solo activos</label>
          <p-inputSwitch [(ngModel)]="onlyActiveValue" [ngModelOptions]="{ standalone: true }" (onChange)="onToggleActive()"></p-inputSwitch>
        </div>
      </div>

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
            <th>RFC</th>
            <th>Email / Teléfono</th>
            <th class="num">Crédito</th>
            <th class="num">Días pago</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr>
            <td><code>{{ c.code }}</code></td>
            <td>
              <div class="cell-strong">{{ c.name }}</div>
              <div class="muted" *ngIf="c.legal_name">{{ c.legal_name }}</div>
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
                      <div class="muted small" *ngIf="s.direccion">{{ s.direccion }}</div>
                    </div>
                  </div>
                </ng-template>
              </p-select>
              <i *ngIf="linkingId() === c.id" class="pi pi-spin pi-spinner saving-spinner" aria-label="Guardando…"></i>
            </td>
            <td>{{ c.rfc || '—' }}</td>
            <td>
              <div *ngIf="c.email">{{ c.email }}</div>
              <div class="muted" *ngIf="c.phone">{{ c.phone }}</div>
              <span *ngIf="!c.email && !c.phone" class="muted">—</span>
            </td>
            <td class="num">{{ c.credit_limit || 0 | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
            <td class="num">{{ c.payment_terms_days ?? 0 }}</td>
            <td>
              <p-tag *ngIf="c.active !== false" severity="success" value="Activo"></p-tag>
              <p-tag *ngIf="c.active === false" severity="danger" value="Inactivo"></p-tag>
            </td>
            <td class="actions">
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
          <tr><td colspan="9" class="muted">Sin clientes que mostrar.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '560px' }"
      [header]="editing() ? 'Editar cliente' : 'Nuevo cliente'"
    >
      <form [formGroup]="form" class="form-grid" *ngIf="form">
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
                  <div class="muted small" *ngIf="s.direccion">{{ s.direccion }}</div>
                </div>
              </div>
            </ng-template>
          </p-select>
          <span class="muted small">
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
            <code>{{ a.username }}</code>
            <button pButton icon="pi pi-copy" size="small" severity="secondary" [text]="true"
                    (click)="copyToClipboard(a.username, 'Usuario copiado')"></button>
          </div>
        </div>
        <div class="access-field">
          <label>Password temporal</label>
          <div class="access-value">
            <code class="pwd">{{ a.temporary_password }}</code>
            <button pButton icon="pi pi-copy" size="small" severity="secondary" [text]="true"
                    (click)="copyToClipboard(a.temporary_password, 'Password copiado')"></button>
          </div>
        </div>
        <p class="muted small">
          El cliente entra en <code>/portal/login</code> con tenant_slug <code>mega_dulces</code>.
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
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .filters { display:flex; gap:1rem; align-items:center; margin-bottom:1rem; flex-wrap:wrap; }
    .active-toggle { display:flex; align-items:center; gap:.5rem; font-size:.875rem; color:var(--text-color-secondary); }
    .num { text-align:right; }
    .cell-strong { font-weight:600; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-size:.85rem; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:.875rem; }
    .form-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form-grid label.full { grid-column: span 2; }
    .form-grid em { color: var(--bad-fg); font-style: normal; }
    .muted.small { font-size:.75rem; }
    .store-link { display:inline-flex; align-items:center; gap:.35rem; }
    .store-link i { color: var(--primary-color); font-size:.85rem; }
    .store-option { display:flex; gap:.5rem; align-items:flex-start; }
    .store-option i { color: var(--primary-color); margin-top: .15rem; }
    :host ::ng-deep .p-select.store-select { width: 100%; }
    /* Inline editor en la columna "Tienda enlazada" — compacto */
    .store-cell { min-width: 240px; display:flex; align-items:center; gap:.5rem; }
    :host ::ng-deep .p-select.row-store-select { width: 100%; font-size: .85rem; }
    :host ::ng-deep .p-select.row-store-select .p-select-label { padding: .35rem .65rem; }
    .saving-spinner { color: var(--primary-color); font-size: .9rem; }
    /* J.6.3 — dialog acceso B2B */
    .access-result { display:flex; flex-direction:column; gap: 1rem; }
    .warn-banner { display:flex; align-items:flex-start; gap:.5rem; background: var(--warn-soft-bg); color: var(--warn-soft-fg); padding:.6rem .8rem; border-radius:6px; font-size:.85rem; }
    .warn-banner i { margin-top:.15rem; }
    .access-field { display:flex; flex-direction:column; gap:.25rem; }
    .access-field label { font-size:.75rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing:.05em; }
    .access-value { display:flex; align-items:center; gap:.5rem; background: var(--surface-100); padding:.4rem .65rem; border-radius:6px; }
    .access-value code { font-size:.95rem; padding:0; background:transparent; flex:1; }
    .access-value code.pwd { font-family: 'Courier New', monospace; font-weight:700; letter-spacing:.05em; color: var(--primary-color); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialCustomersComponent {
  private readonly api = inject(ComercialService);
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
    this.load();
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
      credit_limit: 0, payment_terms_days: 0, store_id: null, notes: '',
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
