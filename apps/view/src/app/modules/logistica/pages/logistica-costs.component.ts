import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
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
    ButtonModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, TextareaModule, DatePickerModule, SelectModule,
    TagModule, TooltipModule, ToastModule,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page logc">
    <p-toast></p-toast>

    <header class="surf-page-head">
      <div class="surf-page-head-text">
        <h1>Control de Costos</h1>
        <p class="surf-page-sub">Desglose financiero por embarque. Combustible, casetas, viáticos, maniobras.</p>
      </div>
      <div class="filter-bar">
        <p-datepicker [(ngModel)]="from" dateFormat="yy-mm-dd" placeholder="Desde" [showButtonBar]="true"></p-datepicker>
        <p-datepicker [(ngModel)]="to" dateFormat="yy-mm-dd" placeholder="Hasta" [showButtonBar]="true"></p-datepicker>
        <button pButton icon="pi pi-refresh" label="Aplicar" (click)="reload()" [loading]="loading()"></button>
      </div>
    </header>

    <!-- KPIs -->
    <div class="surf-grid">
      <div class="metric-tile panel-col-2"><span class="metric-label">Embarques con costos</span><span class="metric-value">{{ summary()?.count || 0 }}</span></div>
      <div class="metric-tile panel-col-3 is-brand"><span class="metric-label">Total costos</span><span class="metric-value">{{ (summary()?.total_cost || totalAcumulado()) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
      <div class="metric-tile panel-col-2 is-info"><span class="metric-label">Combustible</span><span class="metric-value">{{ (summary()?.fuel || 0) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
      <div class="metric-tile panel-col-2 is-warn"><span class="metric-label">Casetas</span><span class="metric-value">{{ (summary()?.tolls || 0) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
      <div class="metric-tile panel-col-3"><span class="metric-label">Viáticos chofer</span><span class="metric-value">{{ (summary()?.driver_per_diem || 0) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
    </div>

    <!-- Tabla -->
    <div class="filter-row">
      <input pInputText type="search" [(ngModel)]="search" placeholder="Buscar por folio o destino"
             inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
      <span class="muted small">{{ filtered().length }} / {{ expenses().length }}</span>
    </div>

    <section class="surf-panel">
      <div class="surf-panel-body is-flush">
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
            <th class="num">$/km</th>
            <th class="num">TOTAL</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-e>
          <tr>
            <td><code class="comm-code">{{ e.shipment_folio }}</code></td>
            <td>{{ e.shipment_date | date:'shortDate' }}</td>
            <td>{{ e.destination || '—' }}</td>
            <td>{{ e.vehicle_plate || '—' }}</td>
            <td class="num">{{ e.actual_km || 0 | number:'1.0-0' }}</td>
            <td class="num">{{ e.fuel | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ e.tolls | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ e.driver_per_diem | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ e.handling | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ e.operating_subtotal | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ e.fixed_cost_per_km | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num strong">{{ e.total_cost | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
          <tr>
            <td colspan="14">
              <div class="empty-state">
                <i class="pi pi-receipt empty-state-icon" aria-hidden="true"></i>
                <div class="empty-state-text">
                  <strong>Sin costos en este rango.</strong>
                  <span class="muted small">Los costos (combustible, casetas, viáticos) se cargan desde cada embarque cerrado. Probá ampliar el rango de fechas o abrir un embarque.</span>
                </div>
              </div>
            </td>
          </tr>
        </ng-template>
      </p-table>
      </div>
    </section>
    </div>

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
    .muted { color: var(--c-text-2); font-size: var(--fs-sm); margin:0; }
    .small { font-size: var(--fs-xs); }
    .filter-bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }

    .empty-state { display:flex; gap:.875rem; align-items:flex-start; padding:1.5rem 1rem; }
    .empty-state-icon { font-size:1.75rem; color: var(--c-text-2); margin-top:.125rem; }
    .empty-state-text { display:flex; flex-direction:column; gap:.25rem; line-height:1.4; }
    .empty-state-text strong { font-size:.9rem; }

    .filter-row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
    .filter-row input { min-width: 240px; }

    .num { text-align:right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
    .num.strong { font-weight: var(--fw-bold); color: var(--c-text-1); }
    th.num { white-space: nowrap; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }

    .edit-header { margin: .5rem 0 1rem; padding:.5rem .75rem; background: var(--c-surface-2); border-radius:6px; }
    .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap:.75rem 1rem; }
    .form-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--c-text-2); }
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
