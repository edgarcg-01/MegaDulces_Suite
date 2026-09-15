import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';

interface Capacity { capacity_date: string; authorized_amount: number; note: string | null; updated_by: string | null; updated_at: string }
interface CapacityHistoryRow { previous_amount: number | null; new_amount: number; reason: string | null; changed_by: string; changed_at: string }
interface ExpenseObligation {
  id: string; concept: string; beneficiary: string; area: string | null; subtype: string | null;
  original_amount: number; reserved_amount: number; paid_amount: number; available_amount: number;
  original_due_date: string | null; status: string; is_critical: boolean; critical_reason: string | null;
}

/**
 * Fase TP.3 — Presupuestos (ADR-064): capacidad de pago por fecha (con historial) + gastos
 * autorizados. Alimenta el Calendario de Pagos de Finanzas — este módulo solo AUTORIZA, no asigna.
 */
@Component({
  selector: 'app-finanzas-presupuesto',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, CheckboxModule, TagModule, ToastModule],
  providers: [MessageService],
  template: `
    <div class="surf-page in pres-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Presupuesto</h1>
          <p class="surf-page-sub">Fija la capacidad de pago autorizada por fecha (queda en historial) y autoriza los gastos operativos que alimentan el <strong>Calendario de pagos</strong>.</p>
        </div>
      </header>

      <section class="pres-section">
        <h2>Capacidad diaria</h2>
        <div class="pres-cap-form">
          <input type="date" [(ngModel)]="capDate" (change)="loadCapacity()" class="pres-date" aria-label="Fecha" />
          <input pInputText type="number" [(ngModel)]="capAmount" placeholder="Importe autorizado" class="pres-amt" />
          <input pInputText type="text" [(ngModel)]="capReason" placeholder="Motivo del cambio" class="pres-reason" />
          <button pButton type="button" (click)="saveCapacity()" [loading]="savingCap()">Guardar</button>
        </div>
        @if (currentCapacity(); as c) {
          <p class="pres-current">Capacidad actual del {{ capDate }}: <strong>{{ money(c.authorized_amount) }}</strong> · actualizado por {{ c.updated_by || '—' }}</p>
        } @else {
          <p class="pres-current pres-none">Sin capacidad definida para el {{ capDate }}.</p>
        }
        @if (history().length) {
          <table class="pres-hist-table">
            <thead><tr><th>Cambiado</th><th class="ta-r">Antes</th><th class="ta-r">Después</th><th>Motivo</th><th>Quién</th></tr></thead>
            <tbody>
              @for (h of history(); track h.changed_at) {
                <tr>
                  <td class="pres-mono">{{ h.changed_at | date:'short' }}</td>
                  <td class="ta-r pres-mono">{{ h.previous_amount == null ? '—' : money(h.previous_amount) }}</td>
                  <td class="ta-r pres-mono">{{ money(h.new_amount) }}</td>
                  <td>{{ h.reason || '—' }}</td>
                  <td>{{ h.changed_by }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>

      <section class="pres-section">
        <div class="pres-section-head">
          <h2>Gastos autorizados</h2>
          <button pButton type="button" class="p-button-sm" (click)="openNew()"><span class="pi pi-plus"></span>&nbsp;Nuevo gasto</button>
        </div>
        <p-table [value]="expenses()" [loading]="loadingExpenses()" styleClass="p-datatable-sm surf-table pres-table">
          <ng-template #header>
            <tr><th>Concepto</th><th>Beneficiario</th><th>Tipo</th><th>Vence</th><th class="ta-r">Disponible</th><th>Estado</th><th style="width:3rem"></th></tr>
          </ng-template>
          <ng-template #body let-e>
            <tr [class.pres-row-critical]="e.is_critical">
              <td>{{ e.concept }} @if (e.is_critical) { <i class="pi pi-flag pres-crit" [title]="e.critical_reason"></i> }</td>
              <td>{{ e.beneficiary }}</td>
              <td class="pres-muted">{{ e.subtype || '—' }}</td>
              <td class="pres-mono">{{ e.original_due_date || '—' }}</td>
              <td class="ta-r pres-mono">{{ money(e.available_amount) }}</td>
              <td><p-tag [value]="e.status" [severity]="e.status === 'paid' ? 'success' : e.status === 'cancelled' ? 'secondary' : 'info'" styleClass="pres-tag" /></td>
              <td>@if (e.status === 'pending') { <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="cancelExpense(e)" title="Cancelar"><span class="pi pi-times"></span></button> }</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="7" class="pres-empty">Sin gastos autorizados.</td></tr></ng-template>
        </p-table>
      </section>
    </div>

    <p-dialog [(visible)]="newVisible" [modal]="true" header="Nuevo gasto autorizado" [style]="{ width: '28rem' }">
      <label class="pres-lbl">Concepto</label>
      <input pInputText type="text" [(ngModel)]="form.concept" class="pres-full" />
      <label class="pres-lbl">Beneficiario</label>
      <input pInputText type="text" [(ngModel)]="form.beneficiary" class="pres-full" />
      <label class="pres-lbl">Tipo</label>
      <p-select [options]="subtypeOpts" [(ngModel)]="form.subtype" optionLabel="label" optionValue="value" placeholder="Tipo" styleClass="pres-full" />
      <label class="pres-lbl">Área / sucursal</label>
      <input pInputText type="text" [(ngModel)]="form.area" class="pres-full" />
      <label class="pres-lbl">Importe</label>
      <input pInputText type="number" [(ngModel)]="form.original_amount" class="pres-full" />
      <label class="pres-lbl">Vencimiento</label>
      <input type="date" [(ngModel)]="form.original_due_date" class="pres-full" />
      <label class="pres-check"><p-checkbox [(ngModel)]="form.is_critical" [binary]="true" />Crítico</label>
      @if (form.is_critical) { <input pInputText type="text" [(ngModel)]="form.critical_reason" placeholder="Motivo (obligatorio)" class="pres-full" /> }
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmNew()" [loading]="saving()">Guardar</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .pres-section { margin-top:1.4rem; }
    .pres-section-head { display:flex; justify-content:space-between; align-items:center; }
    .pres-section h2 { font-size:.95rem; margin:0 0 .5rem; }
    .pres-cap-form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
    .pres-date { padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.85rem; }
    .pres-amt { width:10rem; } .pres-reason { flex:1; min-width:12rem; }
    .pres-current { font-size:.82rem; color:var(--text-muted); margin-top:.5rem; }
    .pres-none { color:var(--warn-fg); }
    .pres-hist-table { width:100%; border-collapse:collapse; font-size:.78rem; margin-top:.6rem; }
    .pres-hist-table th, .pres-hist-table td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color); text-align:left; }
    .pres-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .ta-r { text-align:right; }
    .pres-table { font-size:.84rem; margin-top:.4rem; }
    .pres-muted { color:var(--text-muted); }
    .pres-crit { color:var(--bad-fg); margin-left:.3rem; }
    .pres-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    :host ::ng-deep .pres-tag { font-size:.64rem; }
    .pres-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .pres-lbl { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    .pres-full { width:100%; }
    .pres-check { display:flex; align-items:center; gap:.4rem; margin-top:.6rem; font-size:.82rem; }
    .pres-dlg-actions { margin-top:.8rem; }
  `],
})
export class FinanzasPresupuestoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/budget`;

  capDate = new Date().toISOString().slice(0, 10);
  capAmount: number | null = null;
  capReason = '';
  savingCap = signal(false);
  currentCapacity = signal<Capacity | null>(null);
  history = signal<CapacityHistoryRow[]>([]);

  expenses = signal<ExpenseObligation[]>([]);
  loadingExpenses = signal(false);
  saving = signal(false);

  subtypeOpts = [
    { label: 'Luz', value: 'luz' }, { label: 'Renta', value: 'renta' }, { label: 'Sueldos', value: 'sueldos' },
    { label: 'Comisiones', value: 'comisiones' }, { label: 'Operativo', value: 'operativo' }, { label: 'Otro', value: 'otro' },
  ];

  newVisible = false;
  form: any = {};

  ngOnInit(): void { this.loadCapacity(); this.loadExpenses(); }

  loadCapacity(): void {
    this.http.get<Capacity | null>(`${this.base}/capacity`, { params: { date: this.capDate } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.currentCapacity.set(c); this.capAmount = c?.authorized_amount ?? null; },
      error: () => this.currentCapacity.set(null),
    });
    this.http.get<CapacityHistoryRow[]>(`${this.base}/capacity/history`, { params: { date: this.capDate } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => this.history.set(h), error: () => this.history.set([]),
    });
  }

  saveCapacity(): void {
    if (this.capAmount == null || Number(this.capAmount) < 0) { this.toast.add({ severity: 'warn', summary: 'Falta el importe', detail: 'Captura un importe autorizado válido.' }); return; }
    this.savingCap.set(true);
    this.http.post(`${this.base}/capacity`, { date: this.capDate, amount: Number(this.capAmount), reason: this.capReason || undefined }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingCap.set(false); this.capReason = ''; this.loadCapacity(); this.toast.add({ severity: 'success', summary: 'Guardado', detail: 'Capacidad actualizada.' }); },
      error: (e) => { this.savingCap.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  loadExpenses(): void {
    this.loadingExpenses.set(true);
    this.http.get<ExpenseObligation[]>(`${this.base}/expenses`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.expenses.set(rows); this.loadingExpenses.set(false); },
      error: () => { this.loadingExpenses.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los gastos.' }); },
    });
  }

  openNew(): void { this.form = { is_critical: false }; this.newVisible = true; }
  confirmNew(): void {
    if (!this.form.concept?.trim() || !this.form.beneficiary?.trim() || !(Number(this.form.original_amount) > 0)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Concepto, beneficiario e importe son requeridos.' }); return;
    }
    this.saving.set(true);
    this.http.post(`${this.base}/expenses`, this.form).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.newVisible = false; this.loadExpenses(); this.toast.add({ severity: 'success', summary: 'Autorizado', detail: 'Gasto registrado.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  cancelExpense(e: ExpenseObligation): void {
    this.http.post(`${this.base}/expenses/${e.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadExpenses(); this.toast.add({ severity: 'info', summary: 'Cancelado', detail: 'El gasto se canceló.' }); },
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se pudo cancelar.' }),
    });
  }

  money(n: number | null | undefined): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }); }
}
