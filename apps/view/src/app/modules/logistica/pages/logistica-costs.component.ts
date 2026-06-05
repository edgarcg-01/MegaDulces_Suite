import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ExpenseRow,
  ExpenseSummary,
  LogisticaService,
  Shipment,
} from '../logistica.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * J.9.4 — Costs page.
 *
 * Migrado del repo `_imported/logistica/.../features/costs/`.
 * Listado global de costos por embarque con KPIs agregados + edit dialog.
 */
@Component({
  selector: 'app-logistica-costs',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule, RouterLink,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, TextareaModule, DatePickerModule, SelectModule,
    TagModule, TooltipModule, ToastModule,
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>

    <div class="header-row">
      <div>
        <h2>Control de Costos</h2>
        <p class="muted">Desglose financiero por embarque. Combustible, casetas, viáticos, maniobras.</p>
      </div>
      <div class="filter-bar">
        <p-datepicker [(ngModel)]="from" dateFormat="yy-mm-dd" placeholder="Desde" [showButtonBar]="true"></p-datepicker>
        <p-datepicker [(ngModel)]="to" dateFormat="yy-mm-dd" placeholder="Hasta" [showButtonBar]="true"></p-datepicker>
        <button pButton icon="pi pi-refresh" label="Aplicar" (click)="reload()" [loading]="loading()"></button>
      </div>
    </div>

    <!-- KPIs -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Embarques con costos</div>
        <div class="kpi-value">{{ summary()?.count || 0 }}</div>
      </div>
      <div class="kpi-card kpi-orange">
        <div class="kpi-label">Total costos</div>
        <div class="kpi-value">\${{ summary()?.total_cost || totalAcumulado() | number:'1.2-2' }}</div>
      </div>
      <div class="kpi-card kpi-info">
        <div class="kpi-label">Combustible</div>
        <div class="kpi-value">\${{ summary()?.fuel || 0 | number:'1.2-2' }}</div>
      </div>
      <div class="kpi-card kpi-warn">
        <div class="kpi-label">Casetas</div>
        <div class="kpi-value">\${{ summary()?.tolls || 0 | number:'1.2-2' }}</div>
      </div>
      <div class="kpi-card kpi-purple">
        <div class="kpi-label">Viáticos chofer</div>
        <div class="kpi-value">\${{ summary()?.driver_per_diem || 0 | number:'1.2-2' }}</div>
      </div>
    </div>

    <!-- Tabla -->
    <p-card>
      <div class="filter-row">
        <input pInputText type="search" [(ngModel)]="search" placeholder="Buscar por folio o destino"
               inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
        <span class="muted small">{{ filtered().length }} / {{ expenses().length }}</span>
      </div>

      <p-table [value]="filtered()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm" [paginator]="true" [rows]="15">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th>
            <th>Fecha</th>
            <th>Destino</th>
            <th>Placa</th>
            <th class="num">Km</th>
            <th class="num">Combustible</th>
            <th class="num">Casetas</th>
            <th class="num">Viáticos</th>
            <th class="num">Maniobras</th>
            <th class="num">Operativo</th>
            <th class="num">Costo / km</th>
            <th class="num">TOTAL</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-e>
          <tr>
            <td><code>{{ e.shipment_folio }}</code></td>
            <td>{{ e.shipment_date | date:'shortDate' }}</td>
            <td>{{ e.destination || '—' }}</td>
            <td>{{ e.vehicle_plate || '—' }}</td>
            <td class="num">{{ e.actual_km || 0 | number:'1.0-0' }}</td>
            <td class="num">\${{ e.fuel | number:'1.2-2' }}</td>
            <td class="num">\${{ e.tolls | number:'1.2-2' }}</td>
            <td class="num">\${{ e.driver_per_diem | number:'1.2-2' }}</td>
            <td class="num">\${{ e.handling | number:'1.2-2' }}</td>
            <td class="num">\${{ e.operating_subtotal | number:'1.2-2' }}</td>
            <td class="num">\${{ e.fixed_cost_per_km | number:'1.2-2' }}</td>
            <td class="num strong">\${{ e.total_cost | number:'1.2-2' }}</td>
            <td><p-tag [severity]="severityStatus(e.shipment_status)" [value]="e.shipment_status"></p-tag></td>
            <td class="actions">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true"
                      (click)="openEdit(e)" pTooltip="Editar costos"></button>
              <a pButton icon="pi pi-eye" size="small" severity="secondary" [text]="true"
                 [routerLink]="['/logistica/shipments', e.shipment_id]"></a>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="14" class="muted">Sin costos registrados en el período.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <!-- Edit Dialog -->
    <p-dialog [(visible)]="editDialog" [modal]="true" [style]="{ width: '720px' }"
              header="Editar costos del embarque" [closable]="!saving()">
      <div *ngIf="editing()" class="edit-header">
        <strong><code>{{ editing()?.shipment_folio }}</code></strong>
        <span class="muted">· {{ editing()?.destination || '—' }} · {{ editing()?.shipment_date | date:'shortDate' }}</span>
      </div>
      <form [formGroup]="form" class="form-grid">
        <label>
          Combustible
          <p-inputnumber formControlName="fuel" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Casetas
          <p-inputnumber formControlName="tolls" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Hospedaje
          <p-inputnumber formControlName="lodging" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Pensiones
          <p-inputnumber formControlName="parking" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Permisos
          <p-inputnumber formControlName="permits" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Reparaciones
          <p-inputnumber formControlName="repairs" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Ayudantes externos
          <p-inputnumber formControlName="external_helpers" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Maniobras
          <p-inputnumber formControlName="handling" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Viáticos chofer
          <p-inputnumber formControlName="driver_per_diem" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label>
          Otros
          <p-inputnumber formControlName="other" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
        </label>
        <label class="full">
          Aplicar costo $/km del catálogo (intenta match por modelo del vehículo: HINO 500, INTERNATIONAL, etc. — si no encuentra, usa <code>costo_km_estandar</code>)
          <p-select formControlName="apply_config_km" [options]="boolOptions" optionLabel="label" optionValue="value"></p-select>
        </label>
        <label class="full">
          Notas
          <textarea pTextarea rows="2" formControlName="notes"></textarea>
        </label>
      </form>

      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="editDialog = false" [disabled]="saving()"></button>
        <button pButton label="Guardar" icon="pi pi-check" (click)="save()" [loading]="saving()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .small { font-size:.75rem; }
    .filter-bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }

    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:1rem; margin-bottom:1rem; }
    .kpi-card { background: var(--surface-card, var(--surface-50)); border-left: 4px solid var(--surface-300); border-radius: 8px; padding:.75rem 1rem; }
    .kpi-orange { border-left-color: #f5a623; }
    .kpi-info { border-left-color: #0ea5e9; }
    .kpi-warn { border-left-color: #eab308; }
    .kpi-purple { border-left-color: #9333ea; }
    .kpi-label { font-size:.7rem; text-transform: uppercase; letter-spacing:.05em; color: var(--text-color-secondary); }
    .kpi-value { font-size:1.5rem; font-weight:700; margin-top:.25rem; }

    .filter-row { display:flex; gap:.75rem; align-items:center; margin-bottom:1rem; flex-wrap:wrap; }
    .filter-row input { min-width: 240px; }

    .num { text-align:right; }
    .num.strong { font-weight: 600; color: var(--primary-color); }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:3px; font-size:.85rem; }

    .edit-header { margin: .5rem 0 1rem; padding:.5rem .75rem; background: var(--surface-50); border-radius:6px; }
    .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap:.75rem 1rem; }
    .form-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--text-color-secondary); }
    .form-grid .full { grid-column: 1 / -1; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaCostsComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);

  from: Date | null = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
  to: Date | null = new Date();

  readonly expenses = signal<ExpenseRow[]>([]);
  readonly summary = signal<ExpenseSummary | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly editing = signal<ExpenseRow | null>(null);

  search = '';
  editDialog = false;

  readonly boolOptions = [
    { label: 'Sí', value: true },
    { label: 'No', value: false },
  ];

  form = this.fb.group({
    fuel: [0],
    tolls: [0],
    lodging: [0],
    parking: [0],
    permits: [0],
    repairs: [0],
    external_helpers: [0],
    handling: [0],
    driver_per_diem: [0],
    other: [0],
    apply_config_km: [false],
    notes: [''],
  });

  readonly filtered = computed(() => {
    const s = this.search.toLowerCase();
    if (!s) return this.expenses();
    return this.expenses().filter((e) =>
      e.shipment_folio.toLowerCase().includes(s) ||
      (e.destination || '').toLowerCase().includes(s),
    );
  });

  readonly totalAcumulado = computed(() =>
    this.expenses().reduce((acc, e) => acc + Number(e.total_cost || 0), 0)
  );

  constructor() {
    this.reload();
  }

  fmtDate(d: Date | null): string | undefined {
    if (!d) return undefined;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  reload(): void {
    this.loading.set(true);
    const f = this.fmtDate(this.from);
    const t = this.fmtDate(this.to);
    this.api.listExpenses({ from: f, to: t, limit: 500 }).subscribe({
      next: (list) => { this.expenses.set(list || []); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron costos' });
      },
    });
    this.api.expensesSummary(f, t).subscribe({
      next: (s) => this.summary.set(s),
      error: () => { /* silent fallback a computed local */ },
    });
  }

  openEdit(e: ExpenseRow): void {
    this.editing.set(e);
    this.form.patchValue({
      fuel: e.fuel || 0,
      tolls: e.tolls || 0,
      lodging: e.lodging || 0,
      parking: e.parking || 0,
      permits: e.permits || 0,
      repairs: e.repairs || 0,
      external_helpers: e.external_helpers || 0,
      handling: e.handling || 0,
      driver_per_diem: e.driver_per_diem || 0,
      other: e.other || 0,
      apply_config_km: false,
      notes: '',
    });
    this.editDialog = true;
  }

  save(): void {
    const e = this.editing();
    if (!e) return;
    this.saving.set(true);
    const body = this.form.value as any;
    this.api.upsertExpense(e.shipment_id, body).subscribe({
      next: () => {
        this.saving.set(false);
        this.editDialog = false;
        this.toast.add({ severity: 'success', summary: 'Guardado', detail: 'Costos actualizados' });
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se guardó' });
      },
    });
  }

  severityStatus(s: string): Severity {
    if (s === 'cerrado') return 'success';
    if (s === 'cancelado') return 'danger';
    if (s === 'en_ruta' || s === 'costos_pendientes') return 'warn';
    return 'info';
  }
}
