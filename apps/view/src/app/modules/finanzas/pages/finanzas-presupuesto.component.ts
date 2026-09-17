import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { environment } from '../../../../environments/environment';

interface Capacity { capacity_date: string; authorized_amount: number; note: string | null; updated_by: string | null; updated_at: string }
interface CapacityHistoryRow { previous_amount: number | null; new_amount: number; reason: string | null; changed_by: string; changed_at: string }
interface ExpenseObligation {
  id: string; concept: string; beneficiary: string; area: string | null; subtype: string | null;
  original_amount: number; reserved_amount: number; paid_amount: number; available_amount: number;
  original_due_date: string | null; status: string; is_critical: boolean; critical_reason: string | null;
}
interface BudgetHeader { id: string; name: string; fiscal_year: number; scenario: string; status: string; currency: string; version: number }
interface BudgetLine {
  id: string; concept: string; line_type: string; area: string | null;
  vigente_amount: number; reserved_amount: number; committed_amount: number; exercised_amount: number;
  paid_amount: number; available_amount: number; control_level: string; status: string;
}
interface RealBlock { available: boolean; ventas: number | null; costo: number | null; margen: number | null; data_as_of: string | null; reason?: string }
interface Summary {
  budget: BudgetHeader;
  ejecucion: { vigente: number; reserved: number; committed: number; exercised: number; paid: number; disponible: number; ocupacion_pct: number | null };
  presupuesto: { ingresos: number; costo_ventas: number; gasto: number; margen: number };
  real: RealBlock;
  kpis: { cumplimiento_ventas_pct: number | null; desviacion_ventas: number | null; margen_real: number | null; ocupacion_presupuestaria_pct: number | null };
}

/**
 * Fase PU — Presupuestos (ADR-066). Surface Operations (quiet-luxury, answer-first). Tres vistas:
 *  - Ejercicios: el sistema de presupuestos (PU.1-2) — KPIs vs real + tabla de partidas (ledger de 5 estados).
 *  - Capacidad de pago + Gastos autorizados: el alimentador del Calendario de Pagos (Fase TP).
 * «Sin datos» ≠ cero: el real del ODS, si no hay, se DECLARA (no se dibuja 0).
 */
@Component({
  selector: 'app-finanzas-presupuesto',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule,
    CheckboxModule, TagModule, ToastModule, SegmentedComponent, MetricStripComponent, FreshnessPillComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in pres-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Presupuesto</h1>
          <p class="surf-page-sub">Planea y controla ejercicios (partidas, reservas, compromisos, ejercido) y alimenta el <strong>Calendario de pagos</strong> con la capacidad diaria y los gastos autorizados.</p>
        </div>
        <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista de presupuesto" />
      </header>

      <!-- ══════════ EJERCICIOS (sistema de presupuestos) ══════════ -->
      @if (view() === 'ejercicios') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Ejercicios</h2>
            <button pButton type="button" class="p-button-sm" (click)="openNewBudget()"><span class="pi pi-plus"></span>&nbsp;Nuevo ejercicio</button>
          </div>

          @if (budgets().length) {
            <div class="pres-budget-chips">
              @for (b of budgets(); track b.id) {
                <button type="button" class="pres-chip" [class.on]="selected()?.id === b.id" (click)="selectBudget(b)">
                  {{ b.name }} <span class="pres-chip-yr pres-mono">{{ b.fiscal_year }}</span>
                  <p-tag [value]="b.status" [severity]="budgetSeverity(b.status)" styleClass="pres-tag" />
                </button>
              }
            </div>
          } @else if (loadingBudgets()) {
            <p class="pres-muted">Cargando ejercicios…</p>
          } @else {
            <div class="pres-empty-block">
              <span class="pi pi-chart-pie pres-empty-ico"></span>
              <p>Aún no hay ejercicios presupuestales.</p>
              <button pButton type="button" class="p-button-sm" (click)="openNewBudget()"><span class="pi pi-plus"></span>&nbsp;Crear el primero</button>
            </div>
          }

          @if (selected(); as b) {
            <!-- Answer-first: el resumen ejecutivo antes del grid (DESIGN §15) -->
            @if (summary(); as s) {
              <div class="pres-summary-head">
                <span class="pres-summary-title">{{ b.name }} · {{ b.fiscal_year }} · <span class="pres-muted">escenario {{ b.scenario }}</span></span>
                @if (s.real.available && s.real.data_as_of) {
                  <app-freshness-pill measures="data" [since]="s.real.data_as_of" [staleAfterSec]="86400" />
                } @else {
                  <span class="pres-nodata"><span class="pi pi-info-circle"></span> Real del ODS: {{ s.real.reason || 'sin datos' }}</span>
                }
              </div>
              <app-metric-strip [items]="kpiItems(s)" mode="strip" ariaLabel="Resumen ejecutivo del presupuesto" />
            }

            <p-table [value]="lines()" [loading]="loadingDetail()" styleClass="p-datatable-sm surf-table pres-table" [scrollable]="true">
              <ng-template #header>
                <tr>
                  <th>Partida</th><th>Tipo</th><th>Área</th>
                  <th class="ta-r">Vigente</th><th class="ta-r">Reservado</th><th class="ta-r">Comprometido</th>
                  <th class="ta-r">Ejercido</th><th class="ta-r">Disponible</th><th class="ta-r">Ocupación</th><th>Estado</th>
                </tr>
              </ng-template>
              <ng-template #body let-l>
                <tr>
                  <td>{{ l.concept }}</td>
                  <td class="pres-muted">{{ tipoLabel(l.line_type) }}</td>
                  <td class="pres-muted">{{ l.area || '—' }}</td>
                  <td class="ta-r pres-mono">{{ money(l.vigente_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.reserved_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.committed_amount) }}</td>
                  <td class="ta-r pres-mono">{{ dash(l.exercised_amount) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="l.available_amount < 0">{{ money(l.available_amount) }}</td>
                  <td class="ta-r pres-mono">{{ ocupacion(l) }}</td>
                  <td><p-tag [value]="l.status" [severity]="l.status === 'activa' ? 'info' : 'secondary'" styleClass="pres-tag" /></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="10" class="pres-empty">Este ejercicio no tiene partidas todavía.</td></tr></ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> Reservar, comprometer, ejercer y las adecuaciones se operan desde el detalle de cada partida (próxima entrega). Hoy esta vista es de lectura.</p>
          }
        </section>
      }

      <!-- ══════════ CAPACIDAD DE PAGO (Fase TP) ══════════ -->
      @if (view() === 'capacidad') {
        <section class="pres-section">
          <h2>Capacidad diaria</h2>
          <div class="pres-cap-form">
            <input type="date" [(ngModel)]="capDate" (change)="loadCapacity()" class="pres-date" aria-label="Fecha" />
            <input pInputText type="number" [(ngModel)]="capAmount" placeholder="Importe autorizado" class="pres-amt" />
            <input pInputText type="text" [(ngModel)]="capReason" placeholder="Motivo del cambio" class="pres-reason" />
            <button pButton type="button" (click)="saveCapacity()" [loading]="savingCap()">Guardar</button>
          </div>
          @if (currentCapacity(); as c) {
            <p class="pres-current">Capacidad actual del {{ capDate }}: <strong class="pres-mono">{{ money(c.authorized_amount) }}</strong> · actualizado por {{ c.updated_by || '—' }}</p>
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
      }

      <!-- ══════════ GASTOS AUTORIZADOS (Fase TP) ══════════ -->
      @if (view() === 'gastos') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Gastos autorizados</h2>
            <button pButton type="button" class="p-button-sm" (click)="openNew()"><span class="pi pi-plus"></span>&nbsp;Nuevo gasto</button>
          </div>
          <p-table [value]="expenses()" [loading]="loadingExpenses()" styleClass="p-datatable-sm surf-table pres-table">
            <ng-template #header>
              <tr><th>Concepto</th><th>Beneficiario</th><th>Tipo</th><th>Vence</th><th class="ta-r">Disponible</th><th>Estado</th><th style="width:3rem"><span class="sr-only">Acciones</span></th></tr>
            </ng-template>
            <ng-template #body let-e>
              <tr [class.pres-row-critical]="e.is_critical">
                <td>{{ e.concept }} @if (e.is_critical) { <i class="pi pi-flag pres-crit" [title]="e.critical_reason"></i> }</td>
                <td>{{ e.beneficiary }}</td>
                <td class="pres-muted">{{ e.subtype || '—' }}</td>
                <td class="pres-mono">{{ e.original_due_date || '—' }}</td>
                <td class="ta-r pres-mono">{{ money(e.available_amount) }}</td>
                <td><p-tag [value]="e.status" [severity]="e.status === 'paid' ? 'success' : e.status === 'cancelled' ? 'secondary' : 'info'" styleClass="pres-tag" /></td>
                <td>@if (e.status === 'pending') { <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="cancelExpense(e)" title="Cancelar" aria-label="Cancelar gasto"><span class="pi pi-times"></span></button> }</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7" class="pres-empty">Sin gastos autorizados.</td></tr></ng-template>
          </p-table>
        </section>
      }
    </div>

    <!-- Nuevo ejercicio -->
    <p-dialog [(visible)]="newBudgetVisible" [modal]="true" header="Nuevo ejercicio presupuestal" [style]="{ width: '26rem' }">
      <label class="pres-lbl">Nombre</label>
      <input pInputText type="text" [(ngModel)]="budgetForm.name" class="pres-full" placeholder="Ej. Presupuesto operativo" />
      <label class="pres-lbl">Año fiscal</label>
      <input pInputText type="number" [(ngModel)]="budgetForm.fiscal_year" class="pres-full" />
      <label class="pres-lbl">Escenario</label>
      <p-select [options]="scenarioOpts" [(ngModel)]="budgetForm.scenario" optionLabel="label" optionValue="value" placeholder="Escenario" styleClass="pres-full" />
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmNewBudget()" [loading]="savingBudget()">Crear</button></div>
    </p-dialog>

    <!-- Nuevo gasto (Fase TP) -->
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
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .pres-section { margin-top:1.4rem; }
    .pres-section-head { display:flex; justify-content:space-between; align-items:center; }
    .pres-section h2 { font-size:.95rem; margin:0 0 .5rem; }
    .pres-budget-chips { display:flex; gap:.5rem; flex-wrap:wrap; margin:.4rem 0 1rem; }
    .pres-chip { display:inline-flex; align-items:center; gap:.4rem; padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.82rem; cursor:pointer; }
    .pres-chip.on { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pres-chip-yr { color:var(--text-muted); }
    .pres-summary-head { display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.6rem 0 .4rem; }
    .pres-summary-title { font-size:.9rem; font-weight:600; }
    .pres-nodata { font-size:.76rem; color:var(--warn-fg,#b45309); display:inline-flex; align-items:center; gap:.3rem; }
    .pres-cap-form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
    .pres-date { padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.85rem; }
    .pres-amt { width:10rem; } .pres-reason { flex:1; min-width:12rem; }
    .pres-current { font-size:.82rem; color:var(--text-muted); margin-top:.5rem; }
    .pres-none { color:var(--warn-fg); }
    .pres-hist-table { width:100%; border-collapse:collapse; font-size:.78rem; margin-top:.6rem; }
    .pres-hist-table th, .pres-hist-table td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color); text-align:left; }
    .pres-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .ta-r { text-align:right; }
    .pres-neg { color:var(--bad-fg,#b42318); }
    .pres-table { font-size:.84rem; margin-top:.4rem; }
    .pres-muted { color:var(--text-muted); }
    .pres-hint { font-size:.76rem; color:var(--text-muted); margin-top:.5rem; display:flex; align-items:center; gap:.35rem; }
    .pres-crit { color:var(--bad-fg); margin-left:.3rem; }
    .pres-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    .pres-empty-block { text-align:center; padding:1.6rem; color:var(--text-muted); display:flex; flex-direction:column; align-items:center; gap:.5rem; }
    .pres-empty-ico { font-size:1.6rem; color:var(--text-faint); }
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

  // ── Sub-navegación ──
  view = signal<'ejercicios' | 'capacidad' | 'gastos'>('ejercicios');
  viewOpts = [
    { label: 'Ejercicios', value: 'ejercicios' },
    { label: 'Capacidad de pago', value: 'capacidad' },
    { label: 'Gastos autorizados', value: 'gastos' },
  ];
  setView(v: string) { this.view.set(v as 'ejercicios' | 'capacidad' | 'gastos'); }

  // ── Ejercicios (PU) ──
  budgets = signal<BudgetHeader[]>([]);
  loadingBudgets = signal(false);
  selected = signal<BudgetHeader | null>(null);
  summary = signal<Summary | null>(null);
  lines = signal<BudgetLine[]>([]);
  loadingDetail = signal(false);
  newBudgetVisible = false;
  savingBudget = signal(false);
  budgetForm: { name?: string; fiscal_year?: number; scenario?: string } = {};
  scenarioOpts = [{ label: 'Base', value: 'base' }, { label: 'Conservador', value: 'conservador' }, { label: 'Expansión', value: 'expansion' }];

  // ── Capacidad (TP) ──
  capDate = new Date().toISOString().slice(0, 10);
  capAmount: number | null = null;
  capReason = '';
  savingCap = signal(false);
  currentCapacity = signal<Capacity | null>(null);
  history = signal<CapacityHistoryRow[]>([]);

  // ── Gastos (TP) ──
  expenses = signal<ExpenseObligation[]>([]);
  loadingExpenses = signal(false);
  saving = signal(false);
  subtypeOpts = [
    { label: 'Luz', value: 'luz' }, { label: 'Renta', value: 'renta' }, { label: 'Sueldos', value: 'sueldos' },
    { label: 'Comisiones', value: 'comisiones' }, { label: 'Operativo', value: 'operativo' }, { label: 'Otro', value: 'otro' },
  ];
  newVisible = false;
  form: { concept?: string; beneficiary?: string; subtype?: string; area?: string; original_amount?: number; original_due_date?: string; is_critical?: boolean; critical_reason?: string } = {};

  ngOnInit(): void { this.loadBudgets(); this.loadCapacity(); this.loadExpenses(); }

  // ── Ejercicios ──
  loadBudgets(): void {
    this.loadingBudgets.set(true);
    this.http.get<BudgetHeader[]>(`${this.base}/budgets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        this.budgets.set(rows ?? []);
        this.loadingBudgets.set(false);
        if (!this.selected() && rows?.length) this.selectBudget(rows[0]);
      },
      error: () => { this.loadingBudgets.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los ejercicios.' }); },
    });
  }

  selectBudget(b: BudgetHeader): void {
    this.selected.set(b);
    this.summary.set(null); this.lines.set([]);
    this.loadingDetail.set(true);
    forkJoin({
      summary: this.http.get<Summary>(`${this.base}/budgets/${b.id}/summary`),
      lines: this.http.get<BudgetLine[]>(`${this.base}/budgets/${b.id}/lines`),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ summary, lines }) => { this.summary.set(summary); this.lines.set(lines ?? []); this.loadingDetail.set(false); },
      error: () => { this.loadingDetail.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el ejercicio.' }); },
    });
  }

  openNewBudget(): void { this.budgetForm = { fiscal_year: new Date().getFullYear(), scenario: 'base' }; this.newBudgetVisible = true; }
  confirmNewBudget(): void {
    if (!this.budgetForm.name?.trim() || !(Number(this.budgetForm.fiscal_year) >= 2000)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Nombre y año fiscal son requeridos.' }); return;
    }
    this.savingBudget.set(true);
    this.http.post<BudgetHeader>(`${this.base}/budgets`, this.budgetForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => { this.savingBudget.set(false); this.newBudgetVisible = false; this.loadBudgets(); if (b) this.selectBudget(b); this.toast.add({ severity: 'success', summary: 'Creado', detail: 'Ejercicio creado en borrador.' }); },
      error: (e) => { this.savingBudget.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' }); },
    });
  }

  /** Resumen ejecutivo → KPI strip. «Sin datos» del real se DECLARA (texto), no se dibuja 0. */
  kpiItems(s: Summary): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Vigente', value: s.ejecucion.vigente, format: 'currency-short' },
      { label: 'Disponible', value: s.ejecucion.disponible, format: 'currency-short', tone: s.ejecucion.disponible < 0 ? 'bad' : 'ok' },
      { label: 'Ocupación', value: s.ejecucion.ocupacion_pct ?? 0, format: s.ejecucion.ocupacion_pct == null ? 'text' : 'percent', sub: s.ejecucion.ocupacion_pct == null ? 'sin base' : undefined },
    ];
    if (s.real.available) {
      items.push({ label: 'Ventas real', value: s.real.ventas as number, format: 'currency-short' });
      items.push(s.kpis.cumplimiento_ventas_pct != null
        ? { label: 'Cumplimiento', value: s.kpis.cumplimiento_ventas_pct, format: 'percent', tone: s.kpis.cumplimiento_ventas_pct >= 100 ? 'ok' : 'warn' }
        : { label: 'Cumplimiento', value: 'sin base', format: 'text' });
    } else {
      items.push({ label: 'Ventas real', value: 'sin datos', format: 'text', tone: 'warn' });
    }
    return items;
  }

  ocupacion(l: BudgetLine): string {
    const v = Number(l.vigente_amount);
    if (!(v > 0)) return '—';
    const used = Number(l.reserved_amount) + Number(l.committed_amount) + Number(l.exercised_amount);
    return `${Math.round((used / v) * 1000) / 10}%`;
  }
  tipoLabel(t: string): string {
    return ({ ingreso: 'Ingreso', costo_ventas: 'Costo vta.', gasto: 'Gasto', compra_inventario: 'Compra inv.', inversion: 'Inversión', flujo: 'Flujo' } as Record<string, string>)[t] || t;
  }
  budgetSeverity(status: string): 'success' | 'info' | 'warn' | 'secondary' {
    return status === 'aprobado' ? 'success' : status === 'cerrado' ? 'secondary' : status === 'pendiente' ? 'warn' : 'info';
  }
  dash(n: number | null | undefined): string { return Number(n) > 0 ? this.money(n) : '—'; }

  // ── Capacidad (TP) ──
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

  // ── Gastos (TP) ──
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
