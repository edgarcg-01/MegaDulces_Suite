import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  LiquidationStatus, Liquidation, LogisticaService, PayrollPeriod, PeriodStatus,
} from '../logistica.service';

const PERIOD_STATUS_OPTIONS: { label: string; value: PeriodStatus }[] = [
  { label: 'Abierto', value: 'abierto' },
  { label: 'Calculado', value: 'calculado' },
  { label: 'Pagado', value: 'pagado' },
  { label: 'Cerrado', value: 'cerrado' },
];

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
function severityPeriod(s: PeriodStatus): Severity {
  return s === 'abierto' ? 'info' : s === 'calculado' ? 'warn' : s === 'pagado' ? 'success' : 'secondary';
}
function severityLiq(s: LiquidationStatus): Severity {
  return s === 'calculado' ? 'info' : s === 'revisado' ? 'warn' : s === 'pagado' ? 'success' : 'danger';
}

@Component({
  selector: 'app-logistica-payroll',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, DatePickerModule, SelectModule,
    TagModule, ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row">
      <div>
        <h2>Liquidaciones por período</h2>
        <p class="muted">Catorcenas, cálculo automático de comisiones + viáticos por colaborador.</p>
      </div>
      <button pButton icon="pi pi-plus" label="Nuevo período" (click)="openCreatePeriod()"></button>
    </div>

    <div class="grid">
      <p-card class="periods-card" header="Períodos">
        <p-table [value]="periods()" [loading]="loadingP()" responsiveLayout="scroll" styleClass="p-datatable-sm"
                 selectionMode="single" [(selection)]="selectedPeriod" (onRowSelect)="onPeriodSelect()"
                 [dataKey]="'id'">
          <ng-template pTemplate="header">
            <tr>
              <th>Período</th><th>Rango</th><th>Pago</th><th>Estado</th><th></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-p>
            <tr [pSelectableRow]="p">
              <td><strong>{{ p.year }}/{{ p.number }}</strong></td>
              <td class="muted">{{ p.start_date | date:'shortDate' }} → {{ p.end_date | date:'shortDate' }}</td>
              <td>{{ p.payment_date | date:'shortDate' }}</td>
              <td><p-tag [severity]="sevPeriod(p.status)" [value]="p.status"></p-tag></td>
              <td class="actions">
                <button pButton icon="pi pi-cog" size="small" severity="info" [text]="true"
                        pTooltip="Calcular liquidaciones" (click)="calculate(p)"
                        [loading]="calculatingId() === p.id"></button>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="5" class="muted">Sin períodos. Crear el primero.</td></tr>
          </ng-template>
        </p-table>
      </p-card>

      <p-card class="liq-card" [header]="liqHeader()">
        <p-table [value]="liquidations()" [loading]="loadingL()" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Colaborador</th><th>Tipo</th>
              <th class="num">Comisiones</th><th class="num">Viáticos</th><th class="num">Carga/desc</th>
              <th class="num">Bonos</th><th class="num">Deducciones</th>
              <th class="num">Neto</th><th>Estado</th><th></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr>
              <td class="strong">{{ l.driver_name }}</td>
              <td>{{ l.employee_type }}</td>
              <td class="num">\${{ l.commissions_amount | number:'1.2-2' }}</td>
              <td class="num">\${{ l.per_diem_amount | number:'1.2-2' }}</td>
              <td class="num">\${{ l.load_unload_amount | number:'1.2-2' }}</td>
              <td class="num">\${{ l.bonuses | number:'1.2-2' }}</td>
              <td class="num">\${{ l.deductions | number:'1.2-2' }}</td>
              <td class="num grand">\${{ l.net_amount | number:'1.2-2' }}</td>
              <td><p-tag [severity]="sevLiq(l.status)" [value]="l.status"></p-tag></td>
              <td class="actions">
                <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEditLiquidation(l)"></button>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="10" class="muted">{{ selectedPeriod ? 'Sin liquidaciones para este período. Calcular para generar.' : 'Selecciona un período.' }}</td></tr>
          </ng-template>
        </p-table>
      </p-card>
    </div>

    <!-- Period dialog -->
    <p-dialog [(visible)]="periodDialog" [modal]="true" [draggable]="false" [style]="{ width: '500px' }" header="Nuevo período">
      <form [formGroup]="periodForm" class="form">
        <div class="row">
          <label><span>Año <em>*</em></span><p-inputNumber formControlName="year" [useGrouping]="false"></p-inputNumber></label>
          <label><span>Número de catorcena <em>*</em></span><p-inputNumber formControlName="number"></p-inputNumber></label>
        </div>
        <label><span>Inicio <em>*</em></span><p-datePicker formControlName="start_date" dateFormat="yy-mm-dd" appendTo="body"></p-datePicker></label>
        <label><span>Fin <em>*</em></span><p-datePicker formControlName="end_date" dateFormat="yy-mm-dd" appendTo="body"></p-datePicker></label>
        <label><span>Pago <em>*</em></span><p-datePicker formControlName="payment_date" dateFormat="yy-mm-dd" appendTo="body"></p-datePicker></label>
        <label><span>Notas</span><input pInputText formControlName="notes" /></label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="periodDialog = false"></button>
        <button pButton label="Crear" icon="pi pi-check" [loading]="savingP()" [disabled]="periodForm.invalid" (click)="createPeriod()"></button>
      </ng-template>
    </p-dialog>

    <!-- Liquidation edit dialog -->
    <p-dialog [(visible)]="liqDialog" [modal]="true" [draggable]="false" [style]="{ width: '480px' }"
              [header]="'Liquidación: ' + (editingLiq()?.driver_name || '')">
      <form [formGroup]="liqForm" class="form" *ngIf="editingLiq() as l">
        <div class="info-grid">
          <div><span class="label">Comisiones</span><strong class="num">\${{ l.commissions_amount | number:'1.2-2' }}</strong></div>
          <div><span class="label">Viáticos</span><strong class="num">\${{ l.per_diem_amount | number:'1.2-2' }}</strong></div>
          <div><span class="label">Carga/desc</span><strong class="num">\${{ l.load_unload_amount | number:'1.2-2' }}</strong></div>
        </div>
        <div class="row">
          <label><span>Bonos</span><p-inputNumber formControlName="bonuses" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
          <label><span>Deducciones</span><p-inputNumber formControlName="deductions" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
        </div>
        <label><span>Estado</span>
          <p-select formControlName="status" [options]="liqStatusOptions" optionLabel="label" optionValue="value" appendTo="body"></p-select>
        </label>
        <label><span>Notas</span><input pInputText formControlName="notes" /></label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="liqDialog = false"></button>
        <button pButton label="Guardar" icon="pi pi-check" [loading]="savingL()" (click)="saveLiquidation()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .grid { display:grid; grid-template-columns: 1fr 2fr; gap:1rem; align-items: flex-start; }
    @media (max-width: 1024px) { .grid { grid-template-columns: 1fr; } }
    .strong { font-weight:600; }
    .num { font-variant-numeric: tabular-nums; text-align:right; }
    .grand { color: var(--primary-color); font-weight: 700; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    .form { display:flex; flex-direction:column; gap:.85rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form em { color:#ef4444; font-style:normal; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .info-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:.75rem; padding:.75rem; background: var(--surface-100); border-radius:6px; }
    .info-grid > div { display:flex; flex-direction:column; }
    .info-grid .label { font-size:.7rem; color: var(--text-color-secondary); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaPayrollComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);

  readonly periods = signal<PayrollPeriod[]>([]);
  readonly liquidations = signal<Liquidation[]>([]);
  readonly loadingP = signal(false);
  readonly loadingL = signal(false);
  readonly savingP = signal(false);
  readonly savingL = signal(false);
  readonly calculatingId = signal<string | null>(null);
  readonly editingLiq = signal<Liquidation | null>(null);

  selectedPeriod: PayrollPeriod | null = null;
  periodDialog = false;
  liqDialog = false;

  readonly liqHeader = computed(() => {
    const p = this.selectedPeriod;
    return p ? `Liquidaciones · ${p.year}/${p.number}` : 'Liquidaciones';
  });

  readonly liqStatusOptions = [
    { label: 'Calculado', value: 'calculado' },
    { label: 'Revisado', value: 'revisado' },
    { label: 'Pagado', value: 'pagado' },
    { label: 'Anulado', value: 'anulado' },
  ];

  periodForm: FormGroup = this.fb.group({
    year: [new Date().getFullYear(), Validators.required],
    number: [1, Validators.required],
    start_date: [null, Validators.required],
    end_date: [null, Validators.required],
    payment_date: [null, Validators.required],
    notes: [''],
  });

  liqForm: FormGroup = this.fb.group({
    bonuses: [0], deductions: [0],
    status: ['calculado' as LiquidationStatus],
    notes: [''],
  });

  constructor() { this.loadPeriods(); }

  sevPeriod(s: PeriodStatus): Severity { return severityPeriod(s); }
  sevLiq(s: LiquidationStatus): Severity { return severityLiq(s); }

  loadPeriods() {
    this.loadingP.set(true);
    this.api.listPeriods().subscribe({
      next: (r) => { this.periods.set(r || []); this.loadingP.set(false); },
      error: () => { this.loadingP.set(false); this.toast.add({ severity:'error', summary:'Error', detail:'No se cargaron períodos' }); },
    });
  }

  onPeriodSelect() {
    if (!this.selectedPeriod) return;
    this.loadingL.set(true);
    this.api.listLiquidations(this.selectedPeriod.id).subscribe({
      next: (r) => { this.liquidations.set(r || []); this.loadingL.set(false); },
      error: () => { this.loadingL.set(false); this.toast.add({ severity:'error', summary:'Error', detail:'No se cargaron liquidaciones' }); },
    });
  }

  openCreatePeriod() {
    const y = new Date().getFullYear();
    this.periodForm.reset({ year: y, number: 1, start_date: null, end_date: null, payment_date: null, notes: '' });
    this.periodDialog = true;
  }

  createPeriod() {
    if (this.periodForm.invalid) return;
    this.savingP.set(true);
    const raw = this.periodForm.value;
    const fmt = (d: Date | null) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
    this.api.createPeriod({
      ...raw,
      start_date: fmt(raw.start_date),
      end_date: fmt(raw.end_date),
      payment_date: fmt(raw.payment_date),
    }).subscribe({
      next: () => {
        this.savingP.set(false); this.periodDialog = false;
        this.toast.add({ severity:'success', summary:'Período creado' });
        this.loadPeriods();
      },
      error: (err) => {
        this.savingP.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' });
      },
    });
  }

  calculate(p: PayrollPeriod) {
    this.calculatingId.set(p.id);
    this.api.calculatePeriod(p.id).subscribe({
      next: (r) => {
        this.calculatingId.set(null);
        this.toast.add({
          severity:'success',
          summary:'Cálculo completado',
          detail:`${r.liquidations_processed} liquidaciones procesadas`,
        });
        if (this.selectedPeriod?.id === p.id) this.onPeriodSelect();
      },
      error: (err) => {
        this.calculatingId.set(null);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo calcular' });
      },
    });
  }

  openEditLiquidation(l: Liquidation) {
    this.editingLiq.set(l);
    this.liqForm.reset({
      bonuses: l.bonuses, deductions: l.deductions,
      status: l.status, notes: l.notes || '',
    });
    this.liqDialog = true;
  }
  saveLiquidation() {
    const l = this.editingLiq(); if (!l) return;
    this.savingL.set(true);
    this.api.updateLiquidation(l.id, this.liqForm.value).subscribe({
      next: () => {
        this.savingL.set(false); this.liqDialog = false;
        this.toast.add({ severity:'success', summary:'Liquidación actualizada' });
        this.onPeriodSelect();
      },
      error: (err) => {
        this.savingL.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' });
      },
    });
  }
}
