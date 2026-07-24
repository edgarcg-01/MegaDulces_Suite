import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ReconTasksService, ReconTask, ReconTaskStats, ReconTaskStatus, FinanceUser } from '../recon-tasks.service';

/**
 * MA — Tareas de conciliación (Maat). Superficie Operations: los movimientos sin
 * conciliar en Kepler, agrupados por proveedor y repartidos a Finanzas. El humano
 * los captura EN KEPLER; aquí solo se rastrea. El motor asigna (automático) y el
 * líder puede reasignar (manual). Cierre verificado por re-match.
 */
@Component({
  selector: 'app-finanzas-tareas',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, DialogModule, SelectModule,
    InputTextModule, TooltipModule, ToastModule, PageTabsComponent, MetricStripComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ft-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Tareas de conciliación</h1>
          <p class="surf-page-sub">Retiros del banco que no cruzan con ningún pago del 102 en Kepler, agrupados por proveedor. Resuélvelos capturando la póliza <strong>en Kepler</strong>; aquí solo se rastrea el avance.</p>
        </div>
        <div class="ft-head-actions">
          <label class="ft-period">
            <span>Periodo</span>
            <input type="month" [ngModel]="periodo()" (ngModelChange)="setPeriodo($event)" />
          </label>
          @if (canAssign()) {
            <button pButton type="button" label="Correr motor" icon="pi pi-bolt" class="p-button-sm p-button-outlined"
                    [loading]="running()" (click)="runEngine()"
                    pTooltip="Construye tareas del periodo (agrupa por proveedor), verifica cierres y reparte a Finanzas." tooltipPosition="bottom"></button>
          }
        </div>
      </header>

      @if (stats(); as s) {
        <app-metric-strip [items]="kpiItems(s)" ariaLabel="Resumen de tareas de conciliación" />
      }

      <!-- Vistas -->
      <div class="ft-viewseg" role="tablist">
        <button role="tab" [attr.aria-selected]="view()==='me'" [class.active]="view()==='me'" (click)="setView('me')"><i class="pi pi-user"></i> Mis tareas</button>
        <button role="tab" [attr.aria-selected]="view()==='all'" [class.active]="view()==='all'" (click)="setView('all')"><i class="pi pi-list"></i> Todas</button>
        <button role="tab" [attr.aria-selected]="view()==='pool'" [class.active]="view()==='pool'" (click)="setView('pool')"><i class="pi pi-inbox"></i> Sin repartir</button>
        <div class="ft-seg-spacer"></div>
        <button role="tab" [attr.aria-selected]="statusFilter()==='abiertas'" [class.active]="statusFilter()==='abiertas'" (click)="setStatusFilter('abiertas')">Abiertas</button>
        <button role="tab" [attr.aria-selected]="statusFilter()==='resuelto'" [class.active]="statusFilter()==='resuelto'" (click)="setStatusFilter('resuelto')">Resueltas</button>
      </div>

      <!-- Carga por usuario (líder) -->
      @if (canAssign() && stats()?.por_usuario?.length) {
        <div class="ft-load">
          <span class="ft-load-lbl">Carga abierta</span>
          @for (u of stats()!.por_usuario; track u.user_id) {
            <span class="ft-load-chip"><span class="ft-load-name">{{ u.username || '—' }}</span><span class="ft-load-n">{{ u.n }}</span></span>
          }
        </div>
      }

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!tasks().length"
        emptyIcon="pi-check-circle"
        [emptyTitle]="emptyTitle()"
        emptyHint="Corre el motor para construir y repartir las tareas del periodo, o cambia de vista/periodo."
        (retry)="reload()">
        <p-table [value]="tasks()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true">
          <ng-template pTemplate="header">
            <tr>
              <th>Proveedor / concepto</th>
              <th style="width:6rem" class="ta-c">Movs</th>
              <th style="width:9rem" class="ta-r">Importe</th>
              <th style="width:11rem">Asignado a</th>
              <th style="width:8rem">Estado</th>
              <th style="width:14rem"></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-t>
            <tr>
              <td>
                <div class="ft-prov">{{ t.proveedor_label }}</div>
                <div class="ft-meta">{{ t.periodo }}@if (t.kepler_ref) { · <span class="mono">{{ t.kepler_ref }}</span> }</div>
              </td>
              <td class="ta-c mono">{{ t.n_movimientos }}</td>
              <td class="ta-r mono">{{ t.importe_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td>
                @if (t.assigned_to_username) {
                  <span class="ft-assignee">{{ t.assigned_to_username }}</span>
                  @if (t.assigned_by === 'maat') { <span class="ft-by" pTooltip="Repartida por el motor">auto</span> }
                } @else { <span class="muted">— sin repartir —</span> }
              </td>
              <td><p-tag [value]="statusLabel(t.status)" [severity]="statusSeverity(t.status)" [rounded]="true" /></td>
              <td class="ta-r">
                <div class="ft-row-acts">
                  @if (canManage() && t.status === 'pendiente') {
                    <button pButton type="button" label="Tomar" icon="pi pi-play" class="p-button-text p-button-sm" (click)="quickStatus(t, 'en_proceso')"></button>
                  }
                  @if (canManage() && (t.status === 'pendiente' || t.status === 'en_proceso')) {
                    <button pButton type="button" label="Resolver" icon="pi pi-check" class="p-button-text p-button-sm ft-ok" (click)="openResolve(t)"></button>
                  }
                  @if (canAssign()) {
                    <button pButton type="button" icon="pi pi-user-edit" class="p-button-text p-button-sm" [attr.aria-label]="'Asignar ' + t.proveedor_label" pTooltip="Asignar / reasignar" (click)="openAssign(t)"></button>
                  }
                </div>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <!-- Dialog: resolver -->
    <p-dialog [visible]="!!resolveTask()" (visibleChange)="onResolveVisible($event)" [modal]="true" [style]="{ width: '30rem' }"
      [header]="'Resolver tarea'" [dismissableMask]="true">
      @if (resolveTask(); as t) {
        <div class="ft-dlg">
          <p class="ft-dlg-prov">{{ t.proveedor_label }} <span class="muted">· {{ t.n_movimientos }} mov · {{ t.importe_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></p>
          <p class="ft-dlg-hint">Marca la tarea como resuelta una vez capturada en Kepler. El motor la confirmará al re-cruzar (cierre verificado).</p>
          <label class="ft-field"><span>Folio / póliza en Kepler <span class="muted">(opcional)</span></span>
            <input pInputText [(ngModel)]="keplerRef" placeholder="ej. XD2601-0000722" /></label>
          <label class="ft-field"><span>Nota <span class="muted">(opcional)</span></span>
            <input pInputText [(ngModel)]="note" placeholder="Detalle de la resolución" /></label>
        </div>
      }
      <ng-template pTemplate="footer">
        <button pButton type="button" label="No aplica" class="p-button-text p-button-sm" (click)="submitResolve('no_aplica')"></button>
        <button pButton type="button" label="Resuelto" icon="pi pi-check" class="p-button-sm" [loading]="saving()" (click)="submitResolve('resuelto')"></button>
      </ng-template>
    </p-dialog>

    <!-- Dialog: asignar -->
    <p-dialog [visible]="!!assignTask()" (visibleChange)="onAssignVisible($event)" [modal]="true" [style]="{ width: '26rem' }"
      header="Asignar tarea" [dismissableMask]="true">
      @if (assignTask(); as t) {
        <div class="ft-dlg">
          <p class="ft-dlg-prov">{{ t.proveedor_label }}</p>
          <label class="ft-field"><span>Usuario de Finanzas</span>
            <p-select [options]="userOptions()" [(ngModel)]="selectedUser" optionLabel="label" optionValue="value"
              placeholder="Elegir usuario" [filter]="true" appendTo="body" styleClass="ft-select" /></label>
        </div>
      }
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Devolver al pool" class="p-button-text p-button-sm" (click)="submitAssign(null)"></button>
        <button pButton type="button" label="Asignar" icon="pi pi-check" class="p-button-sm" [loading]="saving()" [disabled]="!selectedUser" (click)="submitAssign(selectedUser)"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ft-head-actions { display: flex; align-items: flex-end; gap: .6rem; }
    .ft-period { display: flex; flex-direction: column; gap: .2rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .ft-period input { font: inherit; font-family: var(--font-mono); padding: .3rem .5rem; border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); }
    .ft-viewseg { display: flex; align-items: center; gap: .25rem; margin: 1rem 0 .75rem; border-bottom: 1px solid var(--border-color); }
    .ft-viewseg .ft-seg-spacer { flex: 1; }
    .ft-viewseg button { background: none; border: none; border-bottom: 2px solid transparent; padding: .5rem .7rem; font: inherit; font-size: var(--fs-sm); color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: .35rem; }
    .ft-viewseg button.active { color: var(--action); border-bottom-color: var(--action); }
    .ft-viewseg button:hover:not(.active) { color: var(--text-main); }
    .ft-load { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; margin-bottom: .75rem; }
    .ft-load-lbl { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); margin-right: .2rem; }
    .ft-load-chip { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--border-color); border-radius: var(--r-pill); padding: .1rem .5rem; font-size: var(--fs-xs); }
    .ft-load-name { color: var(--text-muted); }
    .ft-load-n { font-family: var(--font-mono); font-weight: 600; color: var(--text-main); }
    .ft-prov { font-weight: 500; color: var(--text-main); }
    .ft-meta { font-size: var(--fs-xs); color: var(--text-faint); font-family: var(--font-mono); }
    .ft-assignee { color: var(--text-main); }
    .ft-by { font-size: var(--fs-xs); color: var(--text-faint); border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 0 .25rem; margin-left: .35rem; }
    .ft-row-acts { display: inline-flex; gap: .1rem; justify-content: flex-end; }
    .ft-ok { color: var(--ok-fg); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .muted { color: var(--text-muted); }
    .ft-dlg { display: flex; flex-direction: column; gap: .7rem; }
    .ft-dlg-prov { font-weight: 600; color: var(--text-main); }
    .ft-dlg-hint { font-size: var(--fs-sm); color: var(--text-muted); }
    .ft-field { display: flex; flex-direction: column; gap: .3rem; font-size: var(--fs-sm); }
    .ft-field input, .ft-field :where(.ft-select) { width: 100%; }
  `],
})
export class FinanzasTareasComponent implements OnInit {
  private readonly svc = inject(ReconTasksService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = FINANZAS_TABS;
  readonly canAssign = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_RECON_ASIGNAR] === true);
  readonly canManage = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_BANK_GESTIONAR] === true);

  readonly periodo = signal('2026-01');
  readonly view = signal<'me' | 'all' | 'pool'>('all');
  readonly statusFilter = signal<'abiertas' | 'resuelto'>('abiertas');
  readonly tasks = signal<ReconTask[]>([]);
  readonly stats = signal<ReconTaskStats | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly running = signal(false);
  readonly saving = signal(false);

  readonly financeUsers = signal<FinanceUser[]>([]);
  readonly userOptions = computed(() => this.financeUsers().map((u) => ({ label: u.full_name ? `${u.full_name} (${u.username})` : u.username, value: u.id })));

  readonly resolveTask = signal<ReconTask | null>(null);
  readonly assignTask = signal<ReconTask | null>(null);
  keplerRef = '';
  note = '';
  selectedUser: string | null = null;

  readonly emptyTitle = computed(() =>
    this.view() === 'me' ? 'No tienes tareas asignadas' :
    this.view() === 'pool' ? 'Nada en el pool' : 'Sin tareas de conciliación');

  ngOnInit(): void {
    if (this.canAssign()) {
      this.svc.financeUsers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (u) => this.financeUsers.set(u), error: () => {} });
    }
    this.reload();
  }

  setPeriodo(p: string) { this.periodo.set(p); this.reload(); }
  setView(v: 'me' | 'all' | 'pool') { this.view.set(v); this.reload(); }
  setStatusFilter(s: 'abiertas' | 'resuelto') { this.statusFilter.set(s); this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter() === 'resuelto' ? 'resuelto' : undefined;
    this.svc.stats(this.periodo()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.list({ scope: this.view(), status, periodo: this.periodo() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.tasks.set(rows); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || 'No se pudieron cargar las tareas.'); this.loading.set(false); },
    });
  }

  runEngine(): void {
    this.running.set(true);
    this.svc.run(this.periodo()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.running.set(false);
        this.toast.add({ severity: 'success', summary: 'Motor ejecutado', detail: `${r.upserted} tareas · ${r.assigned} repartidas · ${r.cerradas_verificadas} cerradas por re-match` });
        this.reload();
      },
      error: (e) => { this.running.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo correr el motor.' }); },
    });
  }

  quickStatus(t: ReconTask, status: ReconTaskStatus): void {
    this.svc.setStatus(t.id, status).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Actualizado', detail: this.statusLabel(status) }); this.reload(); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo actualizar.' }),
    });
  }

  openResolve(t: ReconTask): void { this.keplerRef = t.kepler_ref || ''; this.note = t.resolution_note || ''; this.resolveTask.set(t); }
  onResolveVisible(v: boolean): void { if (!v) this.resolveTask.set(null); }
  submitResolve(status: 'resuelto' | 'no_aplica'): void {
    const t = this.resolveTask();
    if (!t) return;
    this.saving.set(true);
    this.svc.setStatus(t.id, status, this.note || undefined, this.keplerRef || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.resolveTask.set(null); this.toast.add({ severity: 'success', summary: 'Guardado', detail: this.statusLabel(status) }); this.reload(); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  openAssign(t: ReconTask): void { this.selectedUser = t.assigned_to; this.assignTask.set(t); }
  onAssignVisible(v: boolean): void { if (!v) this.assignTask.set(null); }
  submitAssign(userId: string | null): void {
    const t = this.assignTask();
    if (!t) return;
    this.saving.set(true);
    this.svc.assignManual(t.id, userId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.assignTask.set(null); this.toast.add({ severity: 'success', summary: userId ? 'Asignada' : 'Devuelta al pool', detail: t.proveedor_label }); this.reload(); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo asignar.' }); },
    });
  }

  kpiItems(s: ReconTaskStats): MetricStripItem[] {
    return [
      { label: 'Pendientes', value: s.pendientes, format: 'number', tone: s.pendientes ? 'warn' : 'default' },
      { label: 'En proceso', value: s.en_proceso, format: 'number' },
      { label: 'Resueltas', value: s.resueltas, format: 'number', tone: 'ok' },
      { label: '$ abierto', value: s.monto_abierto, format: 'currency-short', tone: 'brand' },
      { label: 'Sin repartir', value: s.pool, format: 'number', tone: s.pool ? 'bad' : 'default' },
    ];
  }

  statusLabel(s: ReconTaskStatus): string {
    return { pendiente: 'Pendiente', en_proceso: 'En proceso', resuelto: 'Resuelto', no_aplica: 'No aplica' }[s] || s;
  }
  statusSeverity(s: ReconTaskStatus): 'success' | 'warn' | 'info' | 'secondary' | 'danger' {
    return s === 'resuelto' ? 'success' : s === 'en_proceso' ? 'info' : s === 'no_aplica' ? 'secondary' : 'warn';
  }
}
