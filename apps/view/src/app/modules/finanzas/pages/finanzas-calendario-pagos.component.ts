import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

type ObligationSource = 'budget_expense' | 'financial_commitment' | 'supplier_payable';
type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';

interface Obligation {
  obligation_source: ObligationSource; obligation_id: string; beneficiary: string; concept: string;
  classification: string; subtype: string | null; area_code: string | null;
  original_due_date: string | null; negotiated_date: string | null;
  original_amount: number; reserved_amount: number; paid_amount: number; available_amount: number;
  is_critical: boolean; critical_reason: string | null; status: string;
}
interface DaySummary {
  date: string; capacity_defined: boolean; authorized_amount: number | null; assigned_amount: number;
  remaining_amount: number | null; executed_amount: number; pending_execution_amount: number;
  exceeded: boolean; lot_status: string | null;
}
interface AllocationItem { id: string; obligation_source: ObligationSource; obligation_id: string; applied_amount: number; beneficiary: string; concept: string; supplier_id: string | null }
interface Allocation {
  id: string; classification: string; priority_rank: number | null; amount_assigned: number; status: string;
  payment_method: string | null; bank_account_id: string | null; destination_account_text: string | null;
  cash_register_text: string | null; reference_text: string | null; notes: string | null;
  failure_reason: string | null; folio: string | null; supplier_payment_account_id: string | null;
  items: AllocationItem[];
}
interface PaymentAccount { id: string; bank_name: string; account_number: string | null; clabe: string | null; alias: string | null; es_favorita: boolean }

const CLASSIFICATION_LABEL: Record<string, string> = {
  compromiso_financiero: 'Compromiso financiero', gasto: 'Gasto', proveedor_mercancia: 'Proveedor',
};
const STATUS_SEVERITY: Record<string, 'success' | 'warn' | 'danger' | 'secondary' | 'info'> = {
  pending: 'info', executed: 'success', failed: 'danger', cancelled: 'secondary',
};
const REPROGRAM_REASON_OPTS: { label: string; value: ReprogramReason }[] = [
  { label: 'Cuenta bancaria errónea', value: 'cuenta_erronea' },
  { label: 'Falla del sistema del banco', value: 'falla_sistema_banco' },
  { label: 'El pago se devolvió', value: 'pago_devuelto' },
  { label: 'Presupuesto recortado', value: 'presupuesto_recortado' },
  { label: 'Otro', value: 'otro' },
];

/**
 * Fase TP.3 — Calendario de Pagos (ADR-064). Consumidor: asigna obligaciones YA autorizadas
 * (Compras/Presupuestos/Finanzas) a un día, dentro de la capacidad que Presupuestos fija.
 * Vive en /finanzas (NO subordinado a Tesorería — Tesorería es una de las responsables).
 */
@Component({
  selector: 'app-finanzas-calendario-pagos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, TagModule, CheckboxModule, ToastModule, MetricStripComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page in cal-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Calendario de pagos</h1>
          <p class="surf-page-sub">Asigna obligaciones ya autorizadas (Compras/Presupuestos/Finanzas) a un día, dentro de la capacidad que fija Presupuestos. No captura obligaciones sueltas — cada renglón viene de su módulo de origen.</p>
        </div>
        <div class="cal-nav">
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="shiftDay(-1)"><span class="pi pi-angle-left"></span></button>
          <input type="date" [(ngModel)]="date" (change)="reload()" class="cal-date-input" aria-label="Fecha" />
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="shiftDay(1)"><span class="pi pi-angle-right"></span></button>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="goToday()">Hoy</button>
        </div>
      </header>

      @if (summary(); as s) {
        <app-metric-strip [items]="kpis(s)" ariaLabel="Resumen del día" />
        @if (!s.capacity_defined) {
          <div class="cal-banner cal-banner-warn"><i class="pi pi-exclamation-triangle"></i> Este día no tiene capacidad definida por Presupuestos — no se puede liberar hasta que se fije.</div>
        } @else if (s.exceeded) {
          <div class="cal-banner cal-banner-danger"><i class="pi pi-ban"></i> Lo asignado excede la capacidad autorizada de este día. Reprograma o cancela pagos, o pide a Presupuestos ampliar la capacidad.</div>
        }
        <div class="cal-lot-row">
          <span class="cal-lot-status">
            Estado del día: <strong>{{ s.lot_status || 'sin pagos' }}</strong>
            @if (lotFolio()) { <span class="cal-folio">Folio {{ lotFolio() }}</span> }
          </span>
          <div class="cal-lot-actions">
            @if (allocations().length > 0) {
              <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="printing()" (click)="printPreliminar()" title="Documento preliminar para autorización">
                <span class="pi pi-file-pdf"></span>&nbsp;Preliminar
              </button>
            }
            @if (lotFolio()) {
              <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="printing()" (click)="printCajaGeneral()" title="Instrucción de ejecución para Caja General">
                <span class="pi pi-print"></span>&nbsp;Caja General
              </button>
            }
            @if (s.lot_status !== 'released' && s.lot_status !== 'closed' && allocations().length > 0) {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="suggestOrder()">Proponer orden</button>
            }
            @if (canAuthorize()) {
              <button pButton type="button" class="p-button-sm" [disabled]="!s.capacity_defined || s.exceeded || s.lot_status === 'released' || s.lot_status === 'closed'" (click)="releaseLot()" title="Autorizar (permiso restringido)">
                <span class="pi pi-lock"></span>&nbsp;Autorizar día
              </button>
            }
          </div>
        </div>
      }

      <div class="cal-cols">
        <!-- ── Obligaciones disponibles ─────────────────────────────────── -->
        <section class="cal-col">
          <div class="cal-col-head">
            <h2>Obligaciones disponibles</h2>
            <span class="cal-count">{{ obligations().length | number }}</span>
          </div>
          <div class="cal-filters">
            <p-select [options]="classificationOpts" [(ngModel)]="classificationFilter" (onChange)="loadObligations()" optionLabel="label" optionValue="value" placeholder="Clasificación" [showClear]="true" styleClass="cal-sel" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadObligations()" placeholder="Beneficiario / concepto…" class="p-inputtext-sm cal-search" />
            <label class="cal-check"><p-checkbox [(ngModel)]="onlyCritical" [binary]="true" (onChange)="loadObligations()" />Solo críticos</label>
          </div>
          <p-table [value]="obligations()" [loading]="loadingObligations()" [scrollable]="true" scrollHeight="26rem" styleClass="p-datatable-sm surf-table cal-table">
            <ng-template #header>
              <tr><th style="width:2rem"><span class="sr-only">Seleccionar</span></th><th>Beneficiario</th><th>Vence</th><th class="ta-r">Disponible</th><th style="width:3rem"><span class="sr-only">Acciones</span></th></tr>
            </ng-template>
            <ng-template #body let-o>
              <tr [class.cal-row-critical]="o.is_critical">
                <td><p-checkbox [ngModel]="isSelected(o)" [binary]="true" (onChange)="toggleSelect(o)" [disabled]="!canSelect(o)" /></td>
                <td>
                  <div class="cal-benef">{{ o.beneficiary }} @if (o.is_critical) { <i class="pi pi-flag cal-crit-flag" [title]="o.critical_reason || 'crítico'"></i> }</div>
                  <div class="cal-concept">{{ o.concept }} · <span class="cal-tag-mini">{{ classLabel(o.classification) }}</span></div>
                </td>
                <td class="cal-mono">{{ o.original_due_date || '—' }}</td>
                <td class="ta-r cal-num">{{ money(o.available_amount) }}</td>
                <td><button pButton type="button" class="p-button-sm p-button-text" title="Agregar sola a este día" (click)="quickAdd(o)"><span class="pi pi-plus"></span></button></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="5" class="cal-empty">Sin obligaciones disponibles con estos filtros.</td></tr></ng-template>
          </p-table>
          @if (selected().length > 0) {
            <div class="cal-selbar">
              <span>{{ selected().length }} seleccionada(s) · {{ money(selectedTotal()) }}</span>
              <button pButton type="button" class="p-button-sm" (click)="openGroupDialog()">Agrupar y agregar al día</button>
              <button pButton type="button" class="p-button-sm p-button-text" (click)="clearSelection()">Limpiar</button>
            </div>
          }
        </section>

        <!-- ── Pagos del día ────────────────────────────────────────────── -->
        <section class="cal-col">
          <div class="cal-col-head">
            <h2>Pagos del día</h2>
            <span class="cal-count">{{ allocations().length | number }}</span>
          </div>
          <p-table [value]="allocations()" [loading]="loadingAllocations()" [scrollable]="true" scrollHeight="30rem" styleClass="p-datatable-sm surf-table cal-table">
            <ng-template #header>
              <tr><th style="width:4rem">Orden</th><th>Beneficiario(s)</th><th>Clasif.</th><th class="ta-r">Importe</th><th>Estado</th><th style="width:14rem"><span class="sr-only">Acciones</span></th></tr>
            </ng-template>
            <ng-template #body let-a>
              <tr>
                <td>
                  @if (a.status === 'pending' && a.folio == null) {
                    <input pInputText type="number" min="1" [ngModel]="a.priority_rank" (change)="setPriorityRank(a, $event)" class="cal-order-input" aria-label="Orden de pago" />
                  } @else {
                    <span class="cal-mono">{{ a.folio || a.priority_rank || '—' }}</span>
                  }
                </td>
                <td>
                  @for (it of a.items; track it.id) { <div class="cal-item-row">{{ it.beneficiary }} <span class="cal-muted">— {{ it.concept }}</span> <span class="cal-mono cal-item-amt">{{ money(it.applied_amount) }}</span></div> }
                  @if (a.notes) { <div class="cal-notes">{{ a.notes }}</div> }
                  @if (a.status === 'failed' && a.failure_reason) { <div class="cal-fail">Falló: {{ a.failure_reason }}</div> }
                </td>
                <td><p-tag [value]="classLabel(a.classification)" severity="secondary" styleClass="cal-tag" /></td>
                <td class="ta-r cal-num cal-strong">{{ money(a.amount_assigned) }}</td>
                <td><p-tag [value]="a.status" [severity]="statusSeverity(a.status)" styleClass="cal-tag" /></td>
                <td class="cal-actions">
                  @if (a.status === 'pending') {
                    <button pButton type="button" class="p-button-sm p-button-text" title="Preparar (método/banco)" (click)="openPrepare(a)"><span class="pi pi-credit-card"></span></button>
                    <button pButton type="button" class="p-button-sm p-button-text" title="Reprogramar" (click)="openReprogram(a)"><span class="pi pi-calendar"></span></button>
                    <button pButton type="button" class="p-button-sm p-button-text" [disabled]="!a.payment_method" title="Ejecutar" (click)="execute(a)"><span class="pi pi-check"></span></button>
                    <button pButton type="button" class="p-button-sm p-button-text p-button-danger" title="Cancelar" (click)="cancelAllocation(a)"><span class="pi pi-times"></span></button>
                  }
                  @if (a.status === 'failed') {
                    <button pButton type="button" class="p-button-sm p-button-text" title="Reprogramar (con motivo)" (click)="openReprogram(a)"><span class="pi pi-calendar"></span></button>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="6" class="cal-empty">Sin pagos asignados este día.</td></tr></ng-template>
          </p-table>
          <p class="cal-foot">{{ paymentMethodHint }}</p>
        </section>
      </div>
    </div>

    <!-- Dialog: agrupar seleccionadas -->
    <p-dialog [(visible)]="groupDialogVisible" [modal]="true" header="Agrupar y agregar al día" [style]="{ width: '32rem' }">
      <p class="cal-dlg-p">Se creará <strong>un solo pago</strong> el {{ date }} cubriendo {{ selected().length }} documento(s). Ajusta el importe si es una parcialidad.</p>
      @for (o of selected(); track o.obligation_id) {
        <div class="cal-dlg-row">
          <span class="cal-dlg-name">{{ o.beneficiary }} <span class="cal-muted">— {{ o.concept }}</span></span>
          <input pInputText type="number" [(ngModel)]="groupAmounts[o.obligation_id]" [max]="o.available_amount" min="0.01" class="cal-dlg-amt" />
        </div>
      }
      <div class="cal-dlg-actions">
        <input pInputText type="text" [(ngModel)]="newNotes" placeholder="Observaciones (opcional)" class="cal-dlg-notes" />
        <button pButton type="button" (click)="confirmGroupAdd()" [loading]="saving()">Agregar</button>
      </div>
    </p-dialog>

    <!-- Dialog: agregar sola -->
    <p-dialog [(visible)]="quickAddVisible" [modal]="true" header="Agregar al día" [style]="{ width: '26rem' }">
      @if (quickAddTarget(); as o) {
        <p class="cal-dlg-p">{{ o.beneficiary }} — {{ o.concept }}</p>
        <label class="cal-dlg-label">Importe a asignar (disponible {{ money(o.available_amount) }})</label>
        <input pInputText type="number" [(ngModel)]="quickAddAmount" [max]="o.available_amount" min="0.01" class="cal-dlg-amt-full" />
        <div class="cal-dlg-actions">
          <button pButton type="button" (click)="confirmQuickAdd()" [loading]="saving()">Agregar</button>
        </div>
      }
    </p-dialog>

    <!-- Dialog: preparar -->
    <p-dialog [(visible)]="prepareVisible" [modal]="true" header="Preparar pago" [style]="{ width: '28rem' }">
      <label class="cal-dlg-label">Método de pago</label>
      <p-select [options]="methodOpts" [(ngModel)]="prepMethod" optionLabel="label" optionValue="value" placeholder="Método" styleClass="cal-dlg-sel" />
      @if (prepMethod === 'transferencia' || prepMethod === 'cargo_automatico') {
        @if (prepAccounts().length) {
          <label class="cal-dlg-label">Cuenta del catálogo (evita errores de captura)</label>
          <p-select [options]="prepAccounts()" [(ngModel)]="prepAccountId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [showClear]="true" styleClass="cal-dlg-sel" />
        }
        <label class="cal-dlg-label">Cuenta destino (manual, si no está en el catálogo)</label>
        <input pInputText type="text" [(ngModel)]="prepDestination" [disabled]="!!prepAccountId" placeholder="CLABE / cuenta destino" class="cal-dlg-full" />
      }
      @if (prepMethod === 'cheque') {
        <label class="cal-dlg-label">Folio del cheque</label>
        <input pInputText type="text" [(ngModel)]="prepReference" placeholder="Folio" class="cal-dlg-full" />
      }
      @if (prepMethod === 'efectivo') {
        <label class="cal-dlg-label">Caja de salida</label>
        <input pInputText type="text" [(ngModel)]="prepCash" placeholder="Caja" class="cal-dlg-full" />
      }
      <div class="cal-dlg-actions"><button pButton type="button" (click)="confirmPrepare()" [loading]="saving()">Guardar</button></div>
    </p-dialog>

    <!-- Dialog: reprogramar -->
    <p-dialog [(visible)]="reprogramVisible" [modal]="true" header="Reprogramar pago" [style]="{ width: '24rem' }">
      <label class="cal-dlg-label">Nueva fecha</label>
      <input type="date" [(ngModel)]="reprogramDate" class="cal-dlg-full" />
      <label class="cal-dlg-label">Motivo</label>
      <p-select [options]="reprogramReasonOpts" [(ngModel)]="reprogramReason" optionLabel="label" optionValue="value" placeholder="Motivo" styleClass="cal-dlg-sel" />
      @if (reprogramReason === 'otro') {
        <input pInputText type="text" [(ngModel)]="reprogramReasonDetail" placeholder="Detalle (obligatorio)" class="cal-dlg-full" />
      }
      <div class="cal-dlg-actions"><button pButton type="button" (click)="confirmReprogram()" [loading]="saving()">Mover</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cal-nav { display:flex; align-items:center; gap:.4rem; }
    .cal-date-input { padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.85rem; }
    .cal-banner { display:flex; align-items:center; gap:.5rem; padding:.5rem .8rem; margin:.5rem 0; border-radius:var(--r-md); font-size:.82rem; }
    .cal-banner-warn { background:color-mix(in srgb, var(--warn-fg) 12%, transparent); color:var(--warn-fg); border:1px solid var(--warn-fg); }
    .cal-banner-danger { background:color-mix(in srgb, var(--bad-fg) 12%, transparent); color:var(--bad-fg); border:1px solid var(--bad-fg); }
    .cal-lot-row { display:flex; align-items:center; justify-content:space-between; margin:.4rem 0 1rem; flex-wrap:wrap; gap:.5rem; }
    .cal-lot-status { font-size:.82rem; color:var(--text-muted); }
    .cal-lot-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
    .cal-folio { margin-left:.6rem; font-family:var(--font-mono); font-size:.76rem; color:var(--text-main); background:var(--card-bg); border:1px solid var(--border-color); border-radius:var(--r-sm,4px); padding:.05rem .4rem; }
    .cal-order-input { width:3.2rem; text-align:center; }
    .cal-cols { display:flex; gap:1.2rem; flex-wrap:wrap; }
    .cal-col { flex:1 1 26rem; min-width:24rem; }
    .cal-col-head { display:flex; align-items:baseline; gap:.5rem; margin-bottom:.4rem; }
    .cal-col-head h2 { font-size:.95rem; margin:0; }
    .cal-count { color:var(--text-faint); font-size:.78rem; }
    .cal-filters { display:flex; gap:.5rem; align-items:center; margin-bottom:.5rem; flex-wrap:wrap; }
    :host ::ng-deep .cal-sel { min-width:9rem; }
    .cal-search { min-width:12rem; }
    .cal-check { display:flex; align-items:center; gap:.35rem; font-size:.78rem; color:var(--text-muted); }
    .cal-table { font-size:.82rem; }
    .ta-r { text-align:right; }
    .cal-num, .cal-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cal-strong { font-weight:700; }
    .cal-benef { font-weight:600; display:flex; align-items:center; gap:.3rem; }
    .cal-concept { font-size:.74rem; color:var(--text-muted); }
    .cal-tag-mini { text-transform:uppercase; letter-spacing:.02em; font-size:.68rem; }
    .cal-crit-flag { color:var(--bad-fg); }
    .cal-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    .cal-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .cal-selbar { display:flex; align-items:center; gap:.6rem; margin-top:.5rem; padding:.5rem .7rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:.82rem; }
    .cal-item-row { font-size:.8rem; display:flex; gap:.3rem; }
    .cal-item-amt { margin-left:auto; }
    .cal-muted { color:var(--text-faint); }
    .cal-notes { font-size:.72rem; color:var(--text-faint); margin-top:.2rem; }
    .cal-fail { font-size:.72rem; color:var(--bad-fg); margin-top:.2rem; }
    :host ::ng-deep .cal-tag { font-size:.64rem; }
    .cal-actions { display:flex; gap:.15rem; }
    .cal-foot { font-size:.72rem; color:var(--text-faint); margin-top:.6rem; }
    .cal-dlg-p { font-size:.85rem; margin:0 0 .6rem; }
    .cal-dlg-row { display:flex; align-items:center; justify-content:space-between; gap:.6rem; margin-bottom:.4rem; font-size:.82rem; }
    .cal-dlg-name { flex:1; }
    .cal-dlg-amt { width:8rem; text-align:right; }
    .cal-dlg-amt-full, .cal-dlg-full { width:100%; margin-bottom:.6rem; }
    .cal-dlg-notes { width:100%; margin-right:.5rem; }
    .cal-dlg-actions { display:flex; gap:.5rem; align-items:center; margin-top:.6rem; }
    .cal-dlg-label { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    :host ::ng-deep .cal-dlg-sel { width:100%; margin-bottom:.4rem; }
  `],
})
export class FinanzasCalendarioPagosComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly base = `${environment.apiUrl}/finance/payment-calendar`;
  private readonly accountsBase = `${environment.apiUrl}/commercial/supplier-payment-accounts`;

  readonly canAuthorize = computed(() => this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR] === true);
  readonly lotFolio = computed(() => this.lot()?.folio ?? null);
  lot = signal<{ folio: string | null; status: string } | null>(null);
  printing = signal(false);
  reprogramReasonOpts = REPROGRAM_REASON_OPTS;

  date = this.today();
  classificationFilter: string | null = null;
  search = '';
  onlyCritical = false;

  summary = signal<DaySummary | null>(null);
  obligations = signal<Obligation[]>([]);
  allocations = signal<Allocation[]>([]);
  loadingObligations = signal(false);
  loadingAllocations = signal(false);
  saving = signal(false);
  selected = signal<Obligation[]>([]);
  selectedTotal = computed(() => this.selected().reduce((s, o) => s + Number(o.available_amount), 0));

  classificationOpts = [
    { label: 'Compromiso financiero', value: 'compromiso_financiero' },
    { label: 'Gasto', value: 'gasto' },
    { label: 'Proveedor de mercancía', value: 'proveedor_mercancia' },
  ];
  methodOpts = [
    { label: 'Transferencia', value: 'transferencia' },
    { label: 'Cheque', value: 'cheque' },
    { label: 'Efectivo', value: 'efectivo' },
    { label: 'Cargo automático', value: 'cargo_automatico' },
  ];
  paymentMethodHint = 'Preparar completa método/banco/caja para Caja General. Ejecutar no vuelve a liberar capacidad; un pago fallido regresa su saldo (reprograma o cancela).';

  groupDialogVisible = false;
  groupAmounts: Record<string, number> = {};
  newNotes = '';

  quickAddVisible = false;
  quickAddTarget = signal<Obligation | null>(null);
  quickAddAmount = 0;

  prepareVisible = false;
  prepAllocation: Allocation | null = null;
  prepMethod: string | null = null;
  prepDestination = '';
  prepReference = '';
  prepCash = '';
  prepAccountId: string | null = null;
  prepAccounts = signal<{ id: string; label: string }[]>([]);

  reprogramVisible = false;
  reprogramAllocation: Allocation | null = null;
  reprogramDate = this.today();
  reprogramReason: ReprogramReason | null = null;
  reprogramReasonDetail = '';

  ngOnInit(): void { this.reload(); }

  private today(): string { return new Date().toISOString().slice(0, 10); }

  shiftDay(delta: number): void {
    const d = new Date(this.date + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    this.date = d.toISOString().slice(0, 10);
    this.reload();
  }
  goToday(): void { this.date = this.today(); this.reload(); }

  reload(): void {
    this.clearSelection();
    this.http.get<DaySummary>(`${this.base}/days/${this.date}/summary`).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (s) => this.summary.set(s), error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el resumen del día.' }) });
    this.http.get<{ folio: string | null; status: string } | null>(`${this.base}/days/${this.date}/lot`).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (l) => this.lot.set(l), error: () => this.lot.set(null) });
    this.loadAllocations();
    this.loadObligations();
  }

  loadObligations(): void {
    this.loadingObligations.set(true);
    const p = new URLSearchParams();
    if (this.classificationFilter) p.set('classification', this.classificationFilter);
    if (this.search.trim()) p.set('search', this.search.trim());
    if (this.onlyCritical) p.set('onlyCritical', 'true');
    this.http.get<Obligation[]>(`${this.base}/obligations?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.obligations.set(rows); this.loadingObligations.set(false); },
      error: () => { this.loadingObligations.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las obligaciones.' }); },
    });
  }

  loadAllocations(): void {
    this.loadingAllocations.set(true);
    this.http.get<Allocation[]>(`${this.base}/days/${this.date}/allocations`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.allocations.set(rows); this.loadingAllocations.set(false); },
      error: () => { this.loadingAllocations.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los pagos del día.' }); },
    });
  }

  kpis(s: DaySummary): MetricStripItem[] {
    return [
      { label: 'Capacidad autorizada', value: s.authorized_amount ?? 0, format: 'currency-short', tone: s.capacity_defined ? 'default' : 'warn', sub: s.capacity_defined ? undefined : 'no definida' },
      { label: 'Asignado', value: s.assigned_amount, format: 'currency-short', tone: s.exceeded ? 'warn' : 'default' },
      { label: 'Restante', value: s.remaining_amount ?? 0, format: 'currency-short', tone: (s.remaining_amount ?? 0) < 0 ? 'warn' : 'ok' },
      { label: 'Ejecutado', value: s.executed_amount, format: 'currency-short', tone: 'ok' },
      { label: 'Pendiente de ejecutar', value: s.pending_execution_amount, format: 'currency-short', tone: 'default' },
    ];
  }

  classLabel(c: string): string { return CLASSIFICATION_LABEL[c] || c; }
  statusSeverity(s: string) { return STATUS_SEVERITY[s] || 'secondary'; }
  money(n: number | null | undefined): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }); }

  // ── Selección múltiple (agrupar) ──────────────────────────────────────
  isSelected(o: Obligation): boolean { return this.selected().some((s) => s.obligation_id === o.obligation_id); }
  canSelect(o: Obligation): boolean {
    const sel = this.selected();
    return sel.length === 0 || sel[0].classification === o.classification || this.isSelected(o);
  }
  toggleSelect(o: Obligation): void {
    if (this.isSelected(o)) { this.selected.set(this.selected().filter((s) => s.obligation_id !== o.obligation_id)); return; }
    this.selected.set([...this.selected(), o]);
  }
  clearSelection(): void { this.selected.set([]); }

  openGroupDialog(): void {
    this.groupAmounts = {};
    for (const o of this.selected()) this.groupAmounts[o.obligation_id] = Number(o.available_amount);
    this.newNotes = '';
    this.groupDialogVisible = true;
  }
  confirmGroupAdd(): void {
    const items = this.selected().map((o) => ({ obligation_source: o.obligation_source, obligation_id: o.obligation_id, applied_amount: Number(this.groupAmounts[o.obligation_id]) }));
    this.saving.set(true);
    this.http.post(`${this.base}/allocations`, { date: this.date, items, notes: this.newNotes || undefined }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.groupDialogVisible = false; this.clearSelection(); this.reload(); this.toast.add({ severity: 'success', summary: 'Agregado', detail: 'Pago asignado al día.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo asignar.' }); },
    });
  }

  // ── Agregar sola ──────────────────────────────────────────────────────
  quickAdd(o: Obligation): void { this.quickAddTarget.set(o); this.quickAddAmount = Number(o.available_amount); this.quickAddVisible = true; }
  confirmQuickAdd(): void {
    const o = this.quickAddTarget();
    if (!o) return;
    this.saving.set(true);
    this.http.post(`${this.base}/allocations`, { date: this.date, items: [{ obligation_source: o.obligation_source, obligation_id: o.obligation_id, applied_amount: Number(this.quickAddAmount) }] })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.saving.set(false); this.quickAddVisible = false; this.reload(); this.toast.add({ severity: 'success', summary: 'Agregado', detail: 'Pago asignado al día.' }); },
        error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo asignar.' }); },
      });
  }

  // ── Preparar ──────────────────────────────────────────────────────────
  openPrepare(a: Allocation): void {
    this.prepAllocation = a; this.prepMethod = a.payment_method; this.prepDestination = a.destination_account_text || '';
    this.prepReference = a.reference_text || ''; this.prepCash = a.cash_register_text || ''; this.prepAccountId = a.supplier_payment_account_id;
    this.prepAccounts.set([]);
    const supplierId = a.classification === 'proveedor_mercancia' ? a.items.find((i) => i.supplier_id)?.supplier_id : null;
    if (supplierId) {
      this.http.get<PaymentAccount[]>(`${this.accountsBase}/by-supplier/${supplierId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => this.prepAccounts.set(rows.map((r) => ({ id: r.id, label: `${r.bank_name}${r.clabe ? ' · ' + r.clabe : ''}${r.alias ? ' (' + r.alias + ')' : ''}${r.es_favorita ? ' ★' : ''}` }))),
        error: () => this.prepAccounts.set([]),
      });
    }
    this.prepareVisible = true;
  }
  confirmPrepare(): void {
    if (!this.prepAllocation || !this.prepMethod) return;
    this.saving.set(true);
    this.http.post(`${this.base}/allocations/${this.prepAllocation.id}/preparar`, {
      payment_method: this.prepMethod, destination_account_text: this.prepAccountId ? undefined : (this.prepDestination || undefined),
      reference_text: this.prepReference || undefined, cash_register_text: this.prepCash || undefined,
      supplier_payment_account_id: this.prepAccountId || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.prepareVisible = false; this.loadAllocations(); this.toast.add({ severity: 'success', summary: 'Preparado', detail: 'Método de pago guardado.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo preparar.' }); },
    });
  }

  // ── Orden de pago ─────────────────────────────────────────────────────
  suggestOrder(): void {
    this.http.post(`${this.base}/days/${this.date}/proponer-orden`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadAllocations(); this.toast.add({ severity: 'success', summary: 'Orden propuesto', detail: 'Ajusta manualmente si hace falta antes de autorizar.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer el orden.' }),
    });
  }
  setPriorityRank(a: Allocation, ev: Event): void {
    const value = Number((ev.target as HTMLInputElement).value);
    if (!(value > 0)) return;
    this.http.post(`${this.base}/allocations/${a.id}/orden`, { priority_rank: value }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.loadAllocations(),
      error: (e) => { this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cambiar el orden.' }); this.loadAllocations(); },
    });
  }

  // ── Reprogramar (con motivo — TP.10) ───────────────────────────────────
  openReprogram(a: Allocation): void {
    this.reprogramAllocation = a; this.reprogramDate = this.date; this.reprogramReason = null; this.reprogramReasonDetail = '';
    this.reprogramVisible = true;
  }
  confirmReprogram(): void {
    if (!this.reprogramAllocation || !this.reprogramReason) { this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'Selecciona por qué se reprograma.' }); return; }
    if (this.reprogramReason === 'otro' && !this.reprogramReasonDetail.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el detalle', detail: 'Describe el motivo "otro".' }); return; }
    this.saving.set(true);
    this.http.post(`${this.base}/allocations/${this.reprogramAllocation.id}/reprogramar`, {
      date: this.reprogramDate, reason: this.reprogramReason, reason_detail: this.reprogramReasonDetail || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.reprogramVisible = false; this.reload(); this.toast.add({ severity: 'success', summary: 'Reprogramado', detail: 'El pago se movió de fecha.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo reprogramar.' }); },
    });
  }

  // ── Documentos imprimibles (TP.8) ───────────────────────────────────────
  private openPdf(url: string): void {
    this.printing.set(true);
    this.http.get(url, { responseType: 'blob' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.printing.set(false);
        const objUrl = URL.createObjectURL(blob);
        const win = window.open(objUrl, '_blank');
        if (!win) this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la ventana', detail: 'Permite las ventanas emergentes para ver el PDF.' });
        setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      },
      error: (e) => { this.printing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo generar el documento.' }); },
    });
  }
  printPreliminar(): void { this.openPdf(`${this.base}/days/${this.date}/preliminar.pdf`); }
  printCajaGeneral(): void { this.openPdf(`${this.base}/days/${this.date}/caja-general.pdf`); }

  // ── Ejecutar / cancelar ───────────────────────────────────────────────
  execute(a: Allocation): void {
    this.http.post(`${this.base}/allocations/${a.id}/ejecutar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reload(); this.toast.add({ severity: 'success', summary: 'Ejecutado', detail: 'Pago marcado como ejecutado.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo ejecutar.' }),
    });
  }
  cancelAllocation(a: Allocation): void {
    this.http.post(`${this.base}/allocations/${a.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reload(); this.toast.add({ severity: 'info', summary: 'Cancelado', detail: 'El pago se canceló.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cancelar.' }),
    });
  }

  releaseLot(): void {
    this.http.post(`${this.base}/days/${this.date}/liberar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reload(); this.toast.add({ severity: 'success', summary: 'Liberado', detail: 'El día quedó liberado.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo liberar.' }),
    });
  }
}
