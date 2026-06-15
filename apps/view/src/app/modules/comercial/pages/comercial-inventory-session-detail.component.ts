import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { SelectButtonModule } from 'primeng/selectbutton';
import { MultiSelectModule } from 'primeng/multiselect';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, InventoryCountItem, InventorySupervisorProgress, AssignableUser } from '../comercial.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * Detalle del folio para supervisor/reconciliador (Fase I.3): tablero (avance,
 * discrepancias, valor en riesgo) + tabla de items con teórico/varianza +
 * acciones (calcular discrepancias, resolver item, reconciliar, cancelar).
 */
@Component({
  selector: 'app-comercial-inventory-session-detail',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterModule,
    ButtonModule, TableModule, TagModule, DialogModule, InputNumberModule, InputTextModule,
    ToastModule, ConfirmDialogModule, SelectButtonModule, MultiSelectModule,
  ],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>{{ progress()?.folio || 'Folio' }}</h1>
          <p class="surf-page-sub">
            <p-tag [value]="statusLabel(progress()?.status)" [severity]="statusSeverity(progress()?.status)"></p-tag>
          </p>
        </div>
        <div class="in-head-actions">
          <button pButton icon="pi pi-arrow-left" label="Volver" [text]="true" severity="secondary" size="small" routerLink="/comercial/inventory/sessions"></button>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <!-- KPIs -->
      <div class="in-kpis">
        <div class="in-kpi"><span class="in-kpi-v">{{ progress()?.coverage_pct ?? 0 }}%</span><span class="in-kpi-l">Cobertura</span></div>
        <div class="in-kpi"><span class="in-kpi-v">{{ progress()?.counted_once ?? 0 }}/{{ progress()?.total ?? 0 }}</span><span class="in-kpi-l">Contados</span></div>
        <div class="in-kpi" [class.in-kpi-bad]="(progress()?.uncounted ?? 0) > 0"><span class="in-kpi-v">{{ progress()?.uncounted ?? 0 }}</span><span class="in-kpi-l">Sin contar</span></div>
        <div class="in-kpi" [class.in-kpi-warn]="(progress()?.discrepancies ?? 0) > 0"><span class="in-kpi-v">{{ progress()?.discrepancies ?? 0 }}</span><span class="in-kpi-l">Discrepancias</span></div>
        <div class="in-kpi"><span class="in-kpi-v">{{ (+(progress()?.value_at_variance ?? 0)) | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="in-kpi-l">Valor en riesgo</span></div>
      </div>

      <!-- Acciones -->
      @if (!isTerminal()) {
        <div class="in-actions">
          <button pButton icon="pi pi-calculator" label="Calcular discrepancias" size="small" severity="secondary" [loading]="computing()" (click)="compute()"></button>
          @if (canReconcile()) {
            <button pButton icon="pi pi-check-circle" label="Reconciliar" size="small" severity="success" [loading]="reconciling()" (click)="confirmReconcile()"></button>
          }
          @if (canReconcile()) {
            <button pButton icon="pi pi-times" label="Cancelar folio" size="small" [text]="true" severity="danger" (click)="confirmCancel()"></button>
          }
        </div>
      }

      <!-- Asignación de personas (Fase I.4) -->
      @if (canAssign() && !isTerminal()) {
        <div class="in-assign">
          <div class="in-assign-col">
            <label>Contadores asignados</label>
            <p-multiSelect [options]="counterOpts()" [(ngModel)]="selCounters" optionLabel="label" optionValue="value"
                           placeholder="Todos (folio abierto)" [filter]="true" display="chip" styleClass="in-ms"
                           appendTo="body" scrollHeight="45vh" [panelStyle]="{ maxWidth: '92vw' }"
                           (onPanelHide)="saveAssign('counter')"></p-multiSelect>
            <small>Si no asignás ninguno, cualquiera con permiso de contar puede contar este folio.</small>
          </div>
          <div class="in-assign-col">
            <label>Supervisores asignados</label>
            <p-multiSelect [options]="supervisorOpts()" [(ngModel)]="selSupervisors" optionLabel="label" optionValue="value"
                           placeholder="Sin asignar" [filter]="true" display="chip" styleClass="in-ms"
                           appendTo="body" scrollHeight="45vh" [panelStyle]="{ maxWidth: '92vw' }"
                           (onPanelHide)="saveAssign('supervisor')"></p-multiSelect>
            <small>Responsables de este inventario (informativo).</small>
          </div>
        </div>
      }

      <!-- Filtro -->
      <div class="in-filter">
        <p-selectButton [options]="filterOptions" [(ngModel)]="filter" (onChange)="load()" optionLabel="label" optionValue="value"></p-selectButton>
      </div>

      <!-- Tabla de items -->
      <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="flex">
        <ng-template pTemplate="header">
          <tr>
            <th>SKU</th><th>Producto</th><th>Ubic.</th>
            <th class="in-num">Teórico</th><th class="in-num">C1</th><th class="in-num">C2</th><th class="in-num">C3</th>
            <th class="in-num">Final</th><th class="in-num">Var.</th><th>Estado</th><th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-it>
          <tr [class.in-row-disc]="it.status === 'discrepancy'">
            <td class="in-mono">{{ it.sku || '—' }}</td>
            <td class="in-name">{{ it.product_name || '—' }}</td>
            <td class="in-mono">{{ it.location || '—' }}</td>
            <td class="in-num">{{ it.expected_qty }}</td>
            <td class="in-num">{{ it.count_1 ?? '·' }}</td>
            <td class="in-num">{{ it.count_2 ?? '·' }}</td>
            <td class="in-num">{{ it.count_3 ?? '·' }}</td>
            <td class="in-num"><b>{{ it.final_qty ?? '·' }}</b></td>
            <td class="in-num" [class.in-var-neg]="+(it.variance ?? 0) < 0" [class.in-var-pos]="+(it.variance ?? 0) > 0">
              {{ it.variance != null ? (+it.variance > 0 ? '+' : '') + it.variance : '·' }}
            </td>
            <td><p-tag [value]="itemStatusLabel(it.status)" [severity]="itemStatusSeverity(it.status)"></p-tag></td>
            <td>
              @if (!isTerminal() && it.status !== 'resolved') {
                <button pButton icon="pi pi-pencil" [text]="true" size="small" (click)="openResolve(it)" pTooltip="Resolver"></button>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="11" class="in-empty">Sin items para este filtro.</td></tr>
        </ng-template>
      </p-table>

      <!-- Dialog resolver -->
      <p-dialog [(visible)]="resolveVisible" header="Resolver item" [modal]="true" [style]="{ width: '420px' }">
        @if (resolveItem()) {
          <div class="in-form">
            <p class="in-resolve-name">{{ resolveItem()?.product_name }}</p>
            <p class="in-resolve-meta">Teórico: <b>{{ resolveItem()?.expected_qty }}</b> · C1: {{ resolveItem()?.count_1 ?? '—' }} · C2: {{ resolveItem()?.count_2 ?? '—' }} · C3: {{ resolveItem()?.count_3 ?? '—' }}</p>
            <label>Cantidad física final</label>
            <p-inputNumber [(ngModel)]="resolveQty" [min]="0" styleClass="in-w-full"></p-inputNumber>
            <label>Motivo (merma, dañado, error de captura…)</label>
            <input pInputText [(ngModel)]="resolveNotes" class="in-w-full" placeholder="Opcional" />
          </div>
        }
        <ng-template pTemplate="footer">
          <button pButton label="Cancelar" [text]="true" severity="secondary" (click)="resolveVisible.set(false)"></button>
          <button pButton label="Guardar" icon="pi pi-check" [loading]="resolving()" [disabled]="resolveQty() === null" (click)="saveResolve()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .in-head-actions { display: flex; gap: .5rem; }
    .in-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
    .in-kpi { background: var(--surface-card, #fff); border: 1px solid var(--surface-200, #e7e5e4); border-radius: 12px; padding: .85rem 1rem; display: flex; flex-direction: column; }
    .in-kpi-v { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .in-kpi-l { font-size: .75rem; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .in-kpi-bad .in-kpi-v { color: var(--red-600, #dc2626); }
    .in-kpi-warn .in-kpi-v { color: var(--orange-500, #f97316); }
    .in-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .in-assign { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .85rem 1rem; background: var(--surface-card,#fff); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 12px; }
    .in-assign-col { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: .3rem; }
    .in-assign-col label { font-size: .8rem; font-weight: 600; color: var(--text-muted,#78716c); }
    .in-assign-col small { color: var(--text-muted,#78716c); }
    :host ::ng-deep .in-ms { width: 100%; }
    .in-filter { margin-bottom: .75rem; }
    .in-mono { font-family: var(--font-mono, monospace); }
    .in-name { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .in-num { text-align: right; font-variant-numeric: tabular-nums; }
    .in-var-neg { color: var(--red-600, #dc2626); font-weight: 600; }
    .in-var-pos { color: var(--green-600, #16a34a); font-weight: 600; }
    .in-row-disc { background: color-mix(in srgb, var(--orange-500, #f97316) 8%, transparent); }
    .in-empty { text-align: center; padding: 2rem; color: var(--text-muted, #78716c); }
    .in-form { display: flex; flex-direction: column; gap: .4rem; }
    .in-form label { font-size: .8rem; font-weight: 600; color: var(--text-muted, #78716c); margin-top: .6rem; }
    :host ::ng-deep .in-w-full { width: 100%; }
    .in-resolve-name { font-weight: 600; margin: 0; }
    .in-resolve-meta { color: var(--text-muted, #78716c); font-size: .85rem; margin: .25rem 0 0; }
  `],
})
export class ComercialInventorySessionDetailComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  countId = this.route.snapshot.paramMap.get('id')!;
  progress = signal<InventorySupervisorProgress | null>(null);
  items = signal<InventoryCountItem[]>([]);
  loading = signal(false);
  computing = signal(false);
  reconciling = signal(false);
  resolving = signal(false);

  filter = signal<string>('all');
  filterOptions = [
    { label: 'Todos', value: 'all' },
    { label: 'Discrepancias', value: 'discrepancy' },
    { label: 'Pendientes', value: 'pending' },
  ];

  resolveVisible = signal(false);
  resolveItem = signal<InventoryCountItem | null>(null);
  resolveQty = signal<number | null>(null);
  resolveNotes = signal<string>('');

  isTerminal = computed(() => {
    const s = this.progress()?.status;
    return s === 'reconciled' || s === 'cancelled';
  });

  canReconcile = computed(() => this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_RECONCILIAR] === true);
  canAssign = computed(() => this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_ASIGNAR] === true);

  counterOpts = signal<{ label: string; value: string }[]>([]);
  supervisorOpts = signal<{ label: string; value: string }[]>([]);
  selCounters = signal<string[]>([]);
  selSupervisors = signal<string[]>([]);

  constructor() {
    this.load();
    if (this.canAssign()) this.loadAssignments();
  }

  private loadAssignments() {
    const opt = (u: AssignableUser) => ({ label: u.nombre || u.username, value: u.id });
    this.svc.inventoryAssignableUsers('counter').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => this.counterOpts.set(us.map(opt)) });
    this.svc.inventoryAssignableUsers('supervisor').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => this.supervisorOpts.set(us.map(opt)) });
    this.svc.inventoryListAssignments(this.countId).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (as) => {
          this.selCounters.set(as.filter((a) => a.assignment_role === 'counter').map((a) => a.user_id));
          this.selSupervisors.set(as.filter((a) => a.assignment_role === 'supervisor').map((a) => a.user_id));
        },
      });
  }

  saveAssign(role: 'counter' | 'supervisor') {
    const ids = role === 'counter' ? this.selCounters() : this.selSupervisors();
    this.svc.inventorySetAssignments(this.countId, role, ids)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.toast.add({ severity: 'success', summary: `Asignados ${r.count} ${role === 'counter' ? 'contadores' : 'supervisores'}` }),
        error: (e) => this.toast.add({ severity: 'warn', summary: 'No se guardó', detail: e?.error?.message }),
      });
  }

  load() {
    this.loading.set(true);
    this.svc.inventorySupervisorProgress(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (p) => this.progress.set(p), error: () => this.toast.add({ severity: 'error', summary: 'Error al cargar avance' }) });

    const status = this.filter() === 'all' ? undefined : this.filter();
    this.svc.inventoryCountItems(this.countId, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (its) => { this.items.set(its); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar items' }); },
      });
  }

  compute() {
    this.computing.set(true);
    this.svc.inventoryComputeDiscrepancies(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.computing.set(false);
          this.toast.add({ severity: 'info', summary: 'Discrepancias calculadas', detail: `${r.resolved} resueltos · ${r.discrepancies} discrepancias` });
          this.load();
        },
        error: (e) => { this.computing.set(false); this.toast.add({ severity: 'warn', summary: 'Error', detail: e?.error?.message }); },
      });
  }

  confirmReconcile() {
    this.confirm.confirm({
      header: 'Reconciliar inventario',
      message: 'Esto ajusta el stock teórico al físico contado y genera los movimientos. No se puede deshacer. ¿Continuar?',
      acceptLabel: 'Reconciliar', rejectLabel: 'Cancelar',
      accept: () => this.reconcile(),
    });
  }

  reconcile() {
    this.reconciling.set(true);
    this.svc.inventoryReconcile(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.reconciling.set(false);
          this.toast.add({ severity: 'success', summary: `Folio ${r.folio} reconciliado`, detail: `${r.items_adjusted} ajustes · delta neto ${r.net_delta}` });
          this.load();
        },
        error: (e) => { this.reconciling.set(false); this.toast.add({ severity: 'warn', summary: 'No se reconcilió', detail: e?.error?.message }); },
      });
  }

  confirmCancel() {
    this.confirm.confirm({
      header: 'Cancelar folio',
      message: '¿Cancelar este folio de inventario? No se aplicará ningún ajuste.',
      acceptLabel: 'Sí, cancelar', rejectLabel: 'No',
      accept: () => {
        this.svc.inventoryCancelCount(this.countId)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => { this.toast.add({ severity: 'info', summary: 'Folio cancelado' }); this.load(); },
            error: (e) => this.toast.add({ severity: 'warn', summary: 'Error', detail: e?.error?.message }),
          });
      },
    });
  }

  openResolve(it: InventoryCountItem) {
    this.resolveItem.set(it);
    this.resolveQty.set(it.final_qty != null ? +it.final_qty : (it.count_1 != null ? +it.count_1 : null));
    this.resolveNotes.set('');
    this.resolveVisible.set(true);
  }

  saveResolve() {
    const it = this.resolveItem();
    const qty = this.resolveQty();
    if (!it || qty === null) return;
    this.resolving.set(true);
    this.svc.inventoryResolveItem(this.countId, it.id, { final_qty: qty, notes: this.resolveNotes() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.resolving.set(false);
          this.resolveVisible.set(false);
          this.toast.add({ severity: 'success', summary: 'Item resuelto' });
          this.load();
        },
        error: (e) => { this.resolving.set(false); this.toast.add({ severity: 'warn', summary: 'Error', detail: e?.error?.message }); },
      });
  }

  statusLabel(s?: string): string {
    return { open: 'Abierto', counting: 'Contando', review: 'Revisión', ready_to_reconcile: 'Por reconciliar', reconciled: 'Reconciliado', cancelled: 'Cancelado' }[s || ''] || s || '';
  }
  statusSeverity(s?: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (s === 'reconciled') return 'success';
    if (s === 'cancelled') return 'secondary';
    if (s === 'review' || s === 'ready_to_reconcile') return 'warn';
    return 'info';
  }
  itemStatusLabel(s: string): string {
    return { pending: 'Pendiente', counted: 'Contado', discrepancy: 'Discrepancia', resolved: 'Resuelto' }[s] || s;
  }
  itemStatusSeverity(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (s === 'resolved') return 'success';
    if (s === 'discrepancy') return 'danger';
    if (s === 'counted') return 'info';
    return 'secondary';
  }
}
