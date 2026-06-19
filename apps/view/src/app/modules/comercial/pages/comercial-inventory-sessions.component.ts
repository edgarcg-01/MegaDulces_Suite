import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { InputSwitchModule } from 'primeng/inputswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, InventoryCount, Warehouse, AssignableUser } from '../comercial.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTabsComponent, PageTab } from '../../../shared/components/page-tabs/page-tabs.component';
import { forkJoin } from 'rxjs';

/**
 * Lista de folios de inventario + apertura de uno nuevo (supervisor).
 */
@Component({
  selector: 'app-comercial-inventory-sessions',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterModule,
    ButtonModule, TableModule, TagModule, SelectModule, DialogModule, InputSwitchModule, InputNumberModule, MultiSelectModule, ToastModule, PageTabsComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <app-page-tabs [tabs]="inventoryTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Inventarios físicos</h1>
          <p class="surf-page-sub"><b>{{ counts().length }}</b> folio{{ counts().length === 1 ? '' : 's' }}</p>
        </div>
        <div class="in-head-actions">
          <button pButton icon="pi pi-plus" label="Abrir folio" size="small" (click)="openDialog()"></button>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <p-table [value]="counts()" [loading]="loading()" styleClass="p-datatable-sm surf-table" [scrollable]="true">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th><th>Almacén</th><th>Tipo</th><th>Estado</th><th>Inicio</th><th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr>
            <td class="in-mono">{{ c.folio }}</td>
            <td>{{ c.warehouse_code }} · {{ c.warehouse_name }}</td>
            <td>{{ c.type === 'full' ? 'Total' : 'Cíclico' }}</td>
            <td><p-tag [value]="statusLabel(c.status)" [severity]="statusSeverity(c.status)"></p-tag></td>
            <td>{{ c.started_at ? (c.started_at | date:'short') : '—' }}</td>
            <td>
              <button pButton icon="pi pi-arrow-right" label="Abrir" size="small" [text]="true" [routerLink]="['/comercial/inventory/sessions', c.id]"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="6" class="in-empty">No hay folios. Abrí uno para empezar a contar.</td></tr>
        </ng-template>
      </p-table>

      <!-- Dialog: abrir folio -->
      <p-dialog [(visible)]="dialogVisible" header="Abrir folio de inventario" [modal]="true"
                [draggable]="false" [dismissableMask]="true"
                [style]="{ width: '92vw', maxWidth: '460px' }"
                [contentStyle]="{ maxHeight: '72vh', overflow: 'auto' }"
                [breakpoints]="{ '640px': '96vw' }">
        <div class="in-form">
          <label>Almacén</label>
          <p-select [options]="warehouses()" [(ngModel)]="formWarehouse" optionLabel="label" optionValue="id" placeholder="Elegí el almacén" styleClass="in-w-full" [filter]="true" appendTo="body"></p-select>

          <label>Tipo de conteo</label>
          <p-select [options]="typeOptions" [(ngModel)]="formType" optionLabel="label" optionValue="value" styleClass="in-w-full" appendTo="body"></p-select>

          <div class="in-toggle-row">
            <p-inputSwitch [(ngModel)]="formFreeze"></p-inputSwitch>
            <div>
              <span class="in-toggle-label">Congelar movimientos</span>
              <small>Bloquea pedidos/ajustes en este almacén durante el conteo (recomendado).</small>
            </div>
          </div>
          <div class="in-toggle-row">
            <p-inputSwitch [(ngModel)]="formBlind"></p-inputSwitch>
            <div>
              <span class="in-toggle-label">Doble conteo ciego</span>
              <small>Cada SKU lo cuentan dos personas distintas; las diferencias escalan a reconteo.</small>
            </div>
          </div>

          <label>Umbral de recuento (%)</label>
          <p-inputNumber [(ngModel)]="formThreshold" [min]="0" [max]="100" [maxFractionDigits]="2" styleClass="in-w-full"></p-inputNumber>
          <small>0 = sin umbral. Si dos conteos coinciden pero difieren del teórico más que este %, el SKU queda como discrepancia (recuento/revisión) en vez de auto-resolverse.</small>

          @if (canAssign()) {
            <label>Contadores (quiénes van a contar)</label>
            <p-multiSelect [options]="counterOpts()" [(ngModel)]="selCounters" optionLabel="label" optionValue="value"
                           placeholder="Todos los que tengan permiso (folio abierto)" [filter]="true" display="chip"
                           styleClass="in-w-full" appendTo="body" scrollHeight="45vh"
                           [panelStyle]="{ maxWidth: '92vw' }"></p-multiSelect>
            <label>Supervisores responsables</label>
            <p-multiSelect [options]="supervisorOpts()" [(ngModel)]="selSupervisors" optionLabel="label" optionValue="value"
                           placeholder="Sin asignar" [filter]="true" display="chip"
                           styleClass="in-w-full" appendTo="body" scrollHeight="45vh"
                           [panelStyle]="{ maxWidth: '92vw' }"></p-multiSelect>
          }
        </div>
        <ng-template pTemplate="footer">
          <button pButton label="Cancelar" [text]="true" severity="secondary" (click)="dialogVisible.set(false)"></button>
          <button pButton label="Abrir" icon="pi pi-check" [loading]="opening()" [disabled]="!formWarehouse()" (click)="open()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .in-mono { font-family: var(--font-mono, monospace); font-weight: 600; }
    .in-empty { text-align: center; padding: 2rem; color: var(--text-muted, #78716c); }
    .in-head-actions { display: flex; gap: .5rem; }
    .in-form { display: flex; flex-direction: column; gap: .4rem; }
    .in-form label { font-size: .8rem; font-weight: 600; color: var(--text-muted, #78716c); margin-top: .6rem; }
    :host ::ng-deep .in-w-full { width: 100%; }
    .in-toggle-row { display: flex; gap: .75rem; align-items: flex-start; margin-top: .9rem; }
    .in-toggle-label { font-weight: 600; display: block; }
    .in-toggle-row small { color: var(--text-muted, #78716c); }
  `],
})
export class ComercialInventorySessionsComponent {
  readonly inventoryTabs: PageTab[] = [
    { label: 'Existencias', route: '/comercial/inventory', icon: 'pi pi-box', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Folios', route: '/comercial/inventory/sessions', icon: 'pi pi-clipboard', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Por vencer', route: '/comercial/inventory/expiring', icon: 'pi pi-calendar-times', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Cíclico', route: '/comercial/inventory/abc', icon: 'pi pi-sync', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  counts = signal<InventoryCount[]>([]);
  warehouses = signal<{ id: string; label: string }[]>([]);
  loading = signal(false);
  opening = signal(false);
  dialogVisible = signal(false);

  formWarehouse = signal<string | null>(null);
  formType = signal<'full' | 'cycle'>('full');
  formFreeze = signal(true);
  formBlind = signal(true);
  formThreshold = signal(0);

  canAssign = signal(this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_ASIGNAR] === true);
  counterOpts = signal<{ label: string; value: string }[]>([]);
  supervisorOpts = signal<{ label: string; value: string }[]>([]);
  selCounters = signal<string[]>([]);
  selSupervisors = signal<string[]>([]);

  typeOptions = [
    { label: 'Total (todo el almacén)', value: 'full' },
    { label: 'Cíclico (parcial)', value: 'cycle' },
  ];

  constructor() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.listInventoryCounts()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (c) => { this.counts.set(c); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar folios' }); },
      });
  }

  openDialog() {
    if (!this.warehouses().length) {
      this.svc.listWarehouses()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (ws: Warehouse[]) => this.warehouses.set(ws.map((w) => ({ id: w.id, label: `${w.code} · ${w.name}` }))),
        });
    }
    if (this.canAssign() && !this.counterOpts().length) {
      const opt = (u: AssignableUser) => ({ label: `${u.nombre || u.username} (${u.role_name})`, value: u.id });
      this.svc.inventoryAssignableUsers('counter').pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (us) => this.counterOpts.set(us.map(opt)) });
      this.svc.inventoryAssignableUsers('supervisor').pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (us) => this.supervisorOpts.set(us.map(opt)) });
    }
    this.selCounters.set([]);
    this.selSupervisors.set([]);
    this.dialogVisible.set(true);
  }

  open() {
    const warehouse_id = this.formWarehouse();
    if (!warehouse_id) return;
    this.opening.set(true);
    this.svc.openInventoryCount({
      warehouse_id,
      type: this.formType(),
      freeze_movements: this.formFreeze(),
      blind_double_count: this.formBlind(),
      recount_threshold_pct: this.formThreshold(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const counters = this.selCounters();
          const supervisors = this.selSupervisors();
          const reqs: ReturnType<ComercialService['inventorySetAssignments']>[] = [];
          if (this.canAssign() && counters.length) reqs.push(this.svc.inventorySetAssignments(r.id, 'counter', counters));
          if (this.canAssign() && supervisors.length) reqs.push(this.svc.inventorySetAssignments(r.id, 'supervisor', supervisors));
          const finish = () => {
            this.opening.set(false);
            this.dialogVisible.set(false);
            const asg = counters.length || supervisors.length ? ` · ${counters.length} contadores, ${supervisors.length} supervisores` : '';
            this.toast.add({ severity: 'success', summary: `Folio ${r.folio} abierto`, detail: `${r.expected_items} SKUs${asg}` });
            this.formWarehouse.set(null);
            this.load();
          };
          if (reqs.length) {
            forkJoin(reqs).subscribe({
              next: finish,
              error: () => {
                this.opening.set(false);
                this.dialogVisible.set(false);
                this.toast.add({ severity: 'warn', summary: `Folio ${r.folio} abierto, pero falló la asignación`, detail: 'Asignalos desde el detalle del folio.' });
                this.load();
              },
            });
          } else {
            finish();
          }
        },
        error: (e) => {
          this.opening.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se abrió', detail: e?.error?.message || 'Error' });
        },
      });
  }

  statusLabel(s: string): string {
    return {
      open: 'Abierto', counting: 'Contando', review: 'Revisión',
      ready_to_reconcile: 'Por reconciliar', reconciled: 'Reconciliado', cancelled: 'Cancelado',
    }[s] || s;
  }

  statusSeverity(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (s === 'reconciled') return 'success';
    if (s === 'cancelled') return 'secondary';
    if (s === 'review' || s === 'ready_to_reconcile') return 'warn';
    return 'info';
  }
}
