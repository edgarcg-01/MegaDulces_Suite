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
interface CashBucket { week: string; cobros: number; pagos: number; neto: number; neto_acumulado: number; saldo_proyectado: number | null }
interface Cashflow {
  period: { from: string; to: string; bucket: string };
  opening_balance: { available: boolean; amount: number | null; as_of: string | null; source: string; reason?: string };
  totals: { cobros: number; pagos: number; neto: number };
  saldo_minimo_proyectado: number | null;
  buckets: CashBucket[];
  alerts: { week: string; saldo_proyectado: number | null; tipo: string }[];
  sources: { cobros: { source: string; as_of: string | null } };
}

interface Campaign {
  id: string; name: string; campaign_type: string; status: string; objective?: string | null; responsible?: string | null;
  channels?: string | null; start_date?: string | null; end_date?: string | null; planned_budget: number; attribution_rule?: string | null;
}
interface Contribution { id: string; supplier: string; amount: number; condition: string | null; status: string; evidence: string | null }
interface CampaignEval {
  campaign: { id: string; name: string; campaign_type: string; status: string; start_date: string | null; end_date: string | null; attribution_rule: string | null };
  partidas: number; presupuesto: number; costo: number; costo_neto_aportacion: number;
  aportaciones: { confirmada: number; incierta: number; nota: string };
  ventas_vinculadas: { available: boolean; source: string; data_as_of: string | null; attribution: string; reason?: string; ventas: number | null };
  intensidad_gasto_ventas_pct: number | null;
  retorno: { available: boolean; roi_pct: number | null; basis?: string; reason?: string };
  warnings: string[];
}

interface ImportPreview { summary: { total: number; create: number; update: number; errors: number }; rows: { i: number; concept: string; action: string; error?: string }[] }
interface Projection { authorized_vigente: number; proyeccion_firme: number; proyeccion_plena: number; actual: { exercised: number; committed: number; reserved: number; disponible: number }; note: string }
interface CompareRow { concept: string; area: string | null; line_type: string; vigente_a: number | null; vigente_b: number | null; delta: number | null; estado: string }
interface CompareResult { totals: { a: number; b: number; delta: number }; rows: CompareRow[] }

type PresView = 'ejercicios' | 'flujo' | 'campanas' | 'capacidad' | 'gastos';

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
            <div class="pres-detail-bar">
              <span class="pres-summary-title">{{ b.name }} · {{ b.fiscal_year }} · <span class="pres-muted">escenario {{ b.scenario }}</span> <p-tag [value]="b.status" [severity]="budgetSeverity(b.status)" styleClass="pres-tag" /></span>
              <div class="pres-detail-actions">
                @if (b.status === 'borrador' || b.status === 'en_revision') {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="openAddLine()"><span class="pi pi-plus"></span>&nbsp;Partida</button>
                  <button pButton type="button" class="p-button-sm" (click)="lifecycle(b, 'submit')" [loading]="savingLifecycle()">Enviar a autorización</button>
                }
                @if (b.status === 'pendiente') {
                  <button pButton type="button" class="p-button-sm" (click)="lifecycle(b, 'approve')" [loading]="savingLifecycle()">Aprobar</button>
                }
                @if (b.status === 'aprobado') {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="lifecycle(b, 'close')" [loading]="savingLifecycle()">Cerrar</button>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="openProjection()" title="Proyección de cierre"><span class="pi pi-flag"></span>&nbsp;Proyección</button>
                }
                @if (b.status === 'borrador' || b.status === 'en_revision') {
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="openImport()" title="Importar partidas"><span class="pi pi-upload"></span>&nbsp;Importar</button>
                }
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openCopy()" title="Copiar ejercicio"><span class="pi pi-copy"></span>&nbsp;Copiar</button>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openCompare()" title="Comparar con otro ejercicio"><span class="pi pi-arrows-h"></span>&nbsp;Comparar</button>
              </div>
            </div>

            <!-- Answer-first: el resumen ejecutivo antes del grid (DESIGN §15) -->
            @if (summary(); as s) {
              <div class="pres-summary-head">
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
                  <th style="width:3rem"><span class="sr-only">Acciones</span></th>
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
                  <td>@if (b.status === 'aprobado' && l.status === 'activa') { <button pButton type="button" class="p-button-sm p-button-text" (click)="openMovement(l)" title="Movimiento" aria-label="Movimiento de partida"><span class="pi pi-bolt"></span></button> }</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="11" class="pres-empty">Este ejercicio no tiene partidas todavía. @if (b.status === 'borrador' || b.status === 'en_revision') { Agrega la primera con «Partida». }</td></tr></ng-template>
            </p-table>
            @if (b.status !== 'aprobado') {
              <p class="pres-hint"><span class="pi pi-info-circle"></span> Las partidas se capturan en borrador. Los movimientos (reservar / comprometer / ejercer / pagar / adecuar) se habilitan cuando el ejercicio está <strong>aprobado</strong>.</p>
            }
          }
        </section>
      }

      <!-- ══════════ FLUJO DE EFECTIVO (PU.3) ══════════ -->
      @if (view() === 'flujo') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Flujo de efectivo previsto</h2>
            <div class="pres-cf-period">
              <input type="date" [(ngModel)]="cfFrom" class="pres-date" aria-label="Desde" />
              <input type="date" [(ngModel)]="cfTo" class="pres-date" aria-label="Hasta" />
              <button pButton type="button" class="p-button-sm" (click)="loadCashflow()" [loading]="loadingCashflow()">Actualizar</button>
            </div>
          </div>

          @if (cashflow(); as cf) {
            @if (cf.sources.cobros.as_of) {
              <div class="pres-summary-head"><app-freshness-pill measures="data" [since]="cf.sources.cobros.as_of" [staleAfterSec]="86400" /></div>
            }
            <app-metric-strip [items]="cashflowKpis(cf)" mode="strip" ariaLabel="Resumen de flujo de efectivo" />

            @if (!cf.opening_balance.available) {
              <p class="pres-nodata"><span class="pi pi-info-circle"></span> Sin saldo inicial de bancos ({{ cf.opening_balance.reason || 'Fase CB' }}): el saldo proyectado y la alerta de insuficiencia se declaran (—). El neto por semana sí es real.</p>
            } @else if (cf.alerts.length) {
              <div class="pres-alert"><span class="pi pi-exclamation-triangle"></span> {{ cf.alerts.length }} semana(s) con posible falta de liquidez (saldo proyectado &lt; 0).</div>
            }

            <p-table [value]="cf.buckets" styleClass="p-datatable-sm surf-table pres-table">
              <ng-template #header>
                <tr><th>Semana</th><th class="ta-r">Cobros</th><th class="ta-r">Pagos</th><th class="ta-r">Neto</th><th class="ta-r">Neto acum.</th><th class="ta-r">Saldo proyectado</th></tr>
              </ng-template>
              <ng-template #body let-w>
                <tr>
                  <td class="pres-mono">{{ w.week }}</td>
                  <td class="ta-r pres-mono">{{ dash(w.cobros) }}</td>
                  <td class="ta-r pres-mono">{{ dash(w.pagos) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="w.neto < 0">{{ money(w.neto) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="w.neto_acumulado < 0">{{ money(w.neto_acumulado) }}</td>
                  <td class="ta-r pres-mono" [class.pres-neg]="w.saldo_proyectado != null && w.saldo_proyectado < 0">{{ w.saldo_proyectado == null ? '—' : money(w.saldo_proyectado) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6" class="pres-empty">Sin cobros ni pagos previstos en el periodo.</td></tr></ng-template>
            </p-table>
            <p class="pres-hint"><span class="pi pi-info-circle"></span> Cobros: cartera por vencimiento. Pagos: obligaciones pendientes (Presupuestos + Compras + Finanzas). Liquidez a nivel empresa, no por ejercicio.</p>
          } @else if (loadingCashflow()) {
            <p class="pres-muted">Cargando flujo…</p>
          }
        </section>
      }

      <!-- ══════════ CAMPAÑAS / MARKETING (PU.5) ══════════ -->
      @if (view() === 'campanas') {
        <section class="pres-section">
          <div class="pres-section-head">
            <h2>Campañas</h2>
            <button pButton type="button" class="p-button-sm" (click)="openNewCamp()"><span class="pi pi-plus"></span>&nbsp;Nueva campaña</button>
          </div>

          @if (campaigns().length) {
            <div class="pres-budget-chips">
              @for (c of campaigns(); track c.id) {
                <button type="button" class="pres-chip" [class.on]="selectedCampaign()?.id === c.id" (click)="selectCampaign(c)">
                  {{ c.name }} <span class="pres-chip-yr">{{ campTypeLabel(c.campaign_type) }}</span>
                  <p-tag [value]="c.status" [severity]="campSeverity(c.status)" styleClass="pres-tag" />
                </button>
              }
            </div>
          } @else if (loadingCampaigns()) {
            <p class="pres-muted">Cargando campañas…</p>
          } @else {
            <div class="pres-empty-block">
              <span class="pi pi-megaphone pres-empty-ico"></span>
              <p>Aún no hay campañas.</p>
              <button pButton type="button" class="p-button-sm" (click)="openNewCamp()"><span class="pi pi-plus"></span>&nbsp;Crear la primera</button>
            </div>
          }

          @if (campEval(); as ev) {
            <div class="pres-detail-bar">
              <span class="pres-summary-title">{{ ev.campaign.name }} · {{ campTypeLabel(ev.campaign.campaign_type) }} <p-tag [value]="ev.campaign.status" [severity]="campSeverity(ev.campaign.status)" styleClass="pres-tag" /> · <span class="pres-muted">{{ ev.partidas }} partida(s)</span></span>
              <div class="pres-detail-actions">
                @if (ev.campaign.status === 'borrador') { <button pButton type="button" class="p-button-sm" (click)="setCampStatus('activa')" [loading]="savingCampStatus()">Activar</button> }
                @if (ev.campaign.status === 'activa') { <button pButton type="button" class="p-button-sm p-button-text" (click)="setCampStatus('cerrada')" [loading]="savingCampStatus()">Cerrar</button> }
              </div>
            </div>

            @if (ev.ventas_vinculadas.available && ev.ventas_vinculadas.data_as_of) {
              <div class="pres-summary-head"><app-freshness-pill measures="data" [since]="ev.ventas_vinculadas.data_as_of" [staleAfterSec]="86400" /></div>
            }
            <app-metric-strip [items]="campKpis(ev)" mode="strip" ariaLabel="Evaluación de campaña" />

            <!-- Honestidad declarada (spec §9/§10): atribución, retorno, aportaciones, descuento -->
            <div class="pres-eval-notes">
              <p><span class="pi pi-link"></span> <strong>Ventas vinculadas:</strong>
                {{ ev.ventas_vinculadas.available ? money(ev.ventas_vinculadas.ventas) : (ev.ventas_vinculadas.reason || 'sin datos') }}
                — atribución: {{ ev.ventas_vinculadas.attribution }} <em>(no prueba efecto incremental)</em>.</p>
              <p><span class="pi pi-chart-line"></span> <strong>Retorno:</strong>
                @if (ev.retorno.available) { {{ ev.retorno.roi_pct }}% <span class="pres-muted">({{ ev.retorno.basis }})</span> }
                @else {
                  <span class="pres-muted">{{ ev.retorno.reason }}</span>
                  <span class="pres-inline-calc">
                    <input pInputText type="number" [(ngModel)]="margenInput" placeholder="Margen incremental" class="pres-margen" />
                    <button pButton type="button" class="p-button-sm p-button-text" (click)="recalcRetorno()">Calcular</button>
                  </span>
                }
              </p>
              <p><span class="pi pi-gift"></span> <strong>Aportaciones:</strong>
                confirmada <span class="pres-mono">{{ money(ev.aportaciones.confirmada) }}</span> · incierta <span class="pres-mono">{{ money(ev.aportaciones.incierta) }}</span>
                <em class="pres-muted">({{ ev.aportaciones.nota }})</em>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="openAddContrib()"><span class="pi pi-plus"></span>&nbsp;Aportación</button></p>
              @for (w of ev.warnings; track w) { <div class="pres-alert"><span class="pi pi-exclamation-triangle"></span> {{ w }}</div> }
            </div>

            @if (contributions().length) {
              <p-table [value]="contributions()" styleClass="p-datatable-sm surf-table pres-table">
                <ng-template #header><tr><th>Proveedor</th><th class="ta-r">Importe</th><th>Condición</th><th>Estado</th><th style="width:3rem"><span class="sr-only">Acciones</span></th></tr></ng-template>
                <ng-template #body let-ct>
                  <tr>
                    <td>{{ ct.supplier }}</td>
                    <td class="ta-r pres-mono">{{ money(ct.amount) }}</td>
                    <td class="pres-muted">{{ ct.condition || '—' }}</td>
                    <td><p-tag [value]="ct.status" [severity]="contribSeverity(ct.status)" styleClass="pres-tag" /></td>
                    <td>@if (ct.status === 'incierta') { <button pButton type="button" class="p-button-sm p-button-text" (click)="confirmContrib(ct)" title="Confirmar" aria-label="Confirmar aportación"><span class="pi pi-check"></span></button> }</td>
                  </tr>
                </ng-template>
              </p-table>
            }
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

    <!-- Nueva partida -->
    <p-dialog [(visible)]="addLineVisible" [modal]="true" header="Nueva partida" [style]="{ width: '26rem' }">
      <label class="pres-lbl">Concepto</label>
      <input pInputText type="text" [(ngModel)]="lineForm.concept" class="pres-full" />
      <label class="pres-lbl">Tipo</label>
      <p-select [options]="lineTypeOpts" [(ngModel)]="lineForm.line_type" optionLabel="label" optionValue="value" placeholder="Tipo" styleClass="pres-full" />
      <label class="pres-lbl">Área / centro de costo</label>
      <input pInputText type="text" [(ngModel)]="lineForm.area" class="pres-full" />
      <label class="pres-lbl">Importe autorizado (original)</label>
      <input pInputText type="number" [(ngModel)]="lineForm.original_amount" class="pres-full" />
      <label class="pres-lbl">Control</label>
      <p-select [options]="controlOpts" [(ngModel)]="lineForm.control_level" optionLabel="label" optionValue="value" placeholder="Control" styleClass="pres-full" />
      <p class="pres-lbl-hint">Bloqueo impide sobregiro; advertencia lo permite avisando; informativo no frena.</p>
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmAddLine()" [loading]="savingLine()">Agregar</button></div>
    </p-dialog>

    <!-- Movimiento de partida -->
    <p-dialog [(visible)]="movVisible" [modal]="true" [header]="'Movimiento — ' + (movLine()?.concept || '')" [style]="{ width: '30rem' }">
      @if (movLine(); as l) {
        <div class="pres-mov-state">
          <span>Vigente <b class="pres-mono">{{ money(l.vigente_amount) }}</b></span>
          <span>Reservado <b class="pres-mono">{{ money(l.reserved_amount) }}</b></span>
          <span>Comprometido <b class="pres-mono">{{ money(l.committed_amount) }}</b></span>
          <span>Ejercido <b class="pres-mono">{{ money(l.exercised_amount) }}</b></span>
          <span>Disponible <b class="pres-mono" [class.pres-neg]="l.available_amount < 0">{{ money(l.available_amount) }}</b></span>
        </div>
        <label class="pres-lbl">Acción</label>
        <p-select [options]="movOpts" [(ngModel)]="movForm.action" optionLabel="label" optionValue="value" placeholder="Acción" styleClass="pres-full" />
        <label class="pres-lbl">Importe</label>
        <input pInputText type="number" [(ngModel)]="movForm.amount" class="pres-full" />
        @if (movForm.action === 'comprometer') {
          <label class="pres-check"><p-checkbox [(ngModel)]="movForm.fromReserva" [binary]="true" />Desde una reserva previa (convierte reserva → compromiso)</label>
        }
        @if (movForm.action === 'cancelar') {
          <label class="pres-lbl">Cancelar de</label>
          <p-select [options]="cancelTargetOpts" [(ngModel)]="movForm.target" optionLabel="label" optionValue="value" placeholder="Reserva o compromiso" styleClass="pres-full" />
        }
        <label class="pres-lbl">Nota (opcional)</label>
        <input pInputText type="text" [(ngModel)]="movForm.note" class="pres-full" />
        <div class="pres-dlg-actions"><button pButton type="button" (click)="applyMovement()" [loading]="savingMov()">Aplicar</button></div>
      }
    </p-dialog>

    <!-- Nueva campaña -->
    <p-dialog [(visible)]="newCampVisible" [modal]="true" header="Nueva campaña" [style]="{ width: '28rem' }">
      <label class="pres-lbl">Nombre</label>
      <input pInputText type="text" [(ngModel)]="campForm.name" class="pres-full" />
      <label class="pres-lbl">Tipo</label>
      <p-select [options]="campTypeOpts" [(ngModel)]="campForm.campaign_type" optionLabel="label" optionValue="value" placeholder="Tipo" styleClass="pres-full" />
      <label class="pres-lbl">Objetivo</label>
      <input pInputText type="text" [(ngModel)]="campForm.objective" class="pres-full" />
      <label class="pres-lbl">Responsable</label>
      <input pInputText type="text" [(ngModel)]="campForm.responsible" class="pres-full" />
      <label class="pres-lbl">Canales / sucursales</label>
      <input pInputText type="text" [(ngModel)]="campForm.channels" class="pres-full" />
      <div class="pres-row2">
        <div><label class="pres-lbl">Inicio</label><input type="date" [(ngModel)]="campForm.start_date" class="pres-full" /></div>
        <div><label class="pres-lbl">Fin</label><input type="date" [(ngModel)]="campForm.end_date" class="pres-full" /></div>
      </div>
      <label class="pres-lbl">Inversión planeada</label>
      <input pInputText type="number" [(ngModel)]="campForm.planned_budget" class="pres-full" />
      <label class="pres-lbl">Regla de atribución (cómo se mide el resultado)</label>
      <input pInputText type="text" [(ngModel)]="campForm.attribution_rule" class="pres-full" placeholder="Ej. ventas de la ventana en sus sucursales" />
      <p class="pres-lbl-hint">Sin una regla de atribución explícita, las ventas vinculadas no prueban efecto incremental.</p>
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmNewCamp()" [loading]="savingCamp()">Crear</button></div>
    </p-dialog>

    <!-- Nueva aportación de proveedor -->
    <p-dialog [(visible)]="addContribVisible" [modal]="true" header="Aportación de proveedor" [style]="{ width: '26rem' }">
      <label class="pres-lbl">Proveedor</label>
      <input pInputText type="text" [(ngModel)]="contribForm.supplier" class="pres-full" />
      <label class="pres-lbl">Importe</label>
      <input pInputText type="number" [(ngModel)]="contribForm.amount" class="pres-full" />
      <label class="pres-lbl">Condición</label>
      <input pInputText type="text" [(ngModel)]="contribForm.condition" class="pres-full" placeholder="Ej. sujeta a exhibición" />
      <label class="pres-lbl">Estado</label>
      <p-select [options]="contribStatusOpts" [(ngModel)]="contribForm.status" optionLabel="label" optionValue="value" placeholder="Estado" styleClass="pres-full" />
      <p class="pres-lbl-hint">Solo la confirmada/aplicada reduce el gasto neto — la incierta no.</p>
      <div class="pres-dlg-actions"><button pButton type="button" (click)="confirmAddContrib()" [loading]="savingContrib()">Agregar</button></div>
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
    .pres-summary-head { display:flex; justify-content:flex-end; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.6rem 0 .4rem; }
    .pres-summary-title { font-size:.9rem; font-weight:600; display:inline-flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .pres-detail-bar { display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.4rem 0 .2rem; }
    .pres-detail-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
    .pres-mov-state { display:flex; flex-wrap:wrap; gap:.4rem 1rem; font-size:.78rem; color:var(--text-muted); padding:.5rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); margin-bottom:.6rem; }
    .pres-mov-state b { color:var(--text-main); margin-left:.25rem; }
    .pres-lbl-hint { font-size:.72rem; color:var(--text-faint); margin:.3rem 0 0; }
    .pres-cf-period { display:flex; gap:.4rem; flex-wrap:wrap; align-items:center; }
    .pres-eval-notes { margin:.6rem 0; font-size:.82rem; }
    .pres-eval-notes p { margin:.35rem 0; display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .pres-inline-calc { display:inline-flex; align-items:center; gap:.3rem; }
    .pres-margen { width:9rem; }
    .pres-row2 { display:flex; gap:.6rem; } .pres-row2 > div { flex:1; }
    .pres-alert { display:flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--warn-fg,#b45309); background:color-mix(in srgb, var(--warn-fg,#b45309) 8%, transparent); border:1px solid color-mix(in srgb, var(--warn-fg,#b45309) 25%, transparent); border-radius:var(--r-md); padding:.4rem .6rem; margin:.5rem 0; }
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
  view = signal<PresView>('ejercicios');
  viewOpts = [
    { label: 'Ejercicios', value: 'ejercicios' },
    { label: 'Flujo de efectivo', value: 'flujo' },
    { label: 'Campañas', value: 'campanas' },
    { label: 'Capacidad de pago', value: 'capacidad' },
    { label: 'Gastos autorizados', value: 'gastos' },
  ];
  setView(v: string) {
    this.view.set(v as PresView);
    if (v === 'flujo' && !this.cashflow()) this.loadCashflow();
    if (v === 'campanas' && !this.campaigns().length) this.loadCampaigns();
  }

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
  savingLifecycle = signal(false);

  // ── Partidas / movimientos (PU.1) ──
  addLineVisible = false;
  savingLine = signal(false);
  lineForm: { concept?: string; line_type?: string; area?: string; original_amount?: number; control_level?: string } = {};
  lineTypeOpts = [
    { label: 'Gasto', value: 'gasto' }, { label: 'Ingreso', value: 'ingreso' }, { label: 'Costo de ventas', value: 'costo_ventas' },
    { label: 'Compra de inventario', value: 'compra_inventario' }, { label: 'Inversión', value: 'inversion' }, { label: 'Flujo', value: 'flujo' },
  ];
  controlOpts = [{ label: 'Bloqueo', value: 'bloqueo' }, { label: 'Advertencia', value: 'advertencia' }, { label: 'Informativo', value: 'informativo' }];

  movVisible = false;
  savingMov = signal(false);
  movLine = signal<BudgetLine | null>(null);
  movForm: { action?: string; amount?: number; fromReserva?: boolean; target?: string; note?: string } = {};
  movOpts = [
    { label: 'Reservar', value: 'reservar' }, { label: 'Comprometer', value: 'comprometer' }, { label: 'Ejercer', value: 'ejercer' },
    { label: 'Pagar', value: 'pagar' }, { label: 'Cancelar', value: 'cancelar' }, { label: 'Ampliar (adecuación)', value: 'ampliar' }, { label: 'Reducir (adecuación)', value: 'reducir' },
  ];
  cancelTargetOpts = [{ label: 'Reserva', value: 'reserva' }, { label: 'Compromiso', value: 'compromiso' }];

  // ── Planeación (PU.4): copiar / comparar / importar / proyección ──
  copyVisible = false; savingCopy = signal(false);
  copyForm: { name?: string; scenario?: string; fiscal_year?: number } = {};
  importVisible = false; importText = ''; importPreviewing = signal(false); importApplying = signal(false);
  importPreview = signal<ImportPreview | null>(null);
  compareVisible = false; compareOther = ''; comparing = signal(false);
  compareResult = signal<CompareResult | null>(null);
  projVisible = false; loadingProj = signal(false);
  projection = signal<Projection | null>(null);

  // ── Flujo de efectivo (PU.3) ──
  cashflow = signal<Cashflow | null>(null);
  loadingCashflow = signal(false);
  cfFrom = new Date().toISOString().slice(0, 10);
  cfTo = (() => { const d = new Date(); d.setDate(d.getDate() + 56); return d.toISOString().slice(0, 10); })();

  // ── Campañas / Marketing (PU.5) ──
  campaigns = signal<Campaign[]>([]);
  loadingCampaigns = signal(false);
  selectedCampaign = signal<Campaign | null>(null);
  campEval = signal<CampaignEval | null>(null);
  contributions = signal<Contribution[]>([]);
  savingCampStatus = signal(false);
  newCampVisible = false;
  savingCamp = signal(false);
  campForm: { name?: string; campaign_type?: string; objective?: string; responsible?: string; channels?: string; start_date?: string; end_date?: string; planned_budget?: number; attribution_rule?: string } = {};
  campTypeOpts = [
    { label: 'Publicidad', value: 'publicidad' }, { label: 'Materiales', value: 'materiales' }, { label: 'Eventos', value: 'eventos' },
    { label: 'Promociones', value: 'promociones' }, { label: 'Descuento comercial', value: 'descuento_comercial' }, { label: 'Otro', value: 'otro' },
  ];
  addContribVisible = false;
  savingContrib = signal(false);
  contribForm: { supplier?: string; amount?: number; condition?: string; status?: string } = {};
  contribStatusOpts = [{ label: 'Incierta', value: 'incierta' }, { label: 'Confirmada', value: 'confirmada' }, { label: 'Aplicada', value: 'aplicada' }];
  margenInput: number | null = null;

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

  lifecycle(b: BudgetHeader, action: 'submit' | 'approve' | 'close'): void {
    this.savingLifecycle.set(true);
    this.http.post<BudgetHeader>(`${this.base}/budgets/${b.id}/${action}`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingLifecycle.set(false); this.loadBudgets(); this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Listo', detail: action === 'approve' ? 'Ejercicio aprobado / vigente.' : action === 'submit' ? 'Enviado a autorización.' : 'Ejercicio cerrado.' }); },
      error: (e) => { this.savingLifecycle.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo', detail: e?.error?.message || 'Acción rechazada.' }); },
    });
  }

  openAddLine(): void { this.lineForm = { line_type: 'gasto', control_level: 'bloqueo' }; this.addLineVisible = true; }
  confirmAddLine(): void {
    const b = this.selected(); if (!b) return;
    if (!this.lineForm.concept?.trim() || !(Number(this.lineForm.original_amount) >= 0)) {
      this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Concepto e importe son requeridos.' }); return;
    }
    this.savingLine.set(true);
    this.http.post(`${this.base}/budgets/${b.id}/lines`, this.lineForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingLine.set(false); this.addLineVisible = false; this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Agregada', detail: 'Partida creada.' }); },
      error: (e) => { this.savingLine.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo agregar.' }); },
    });
  }

  openMovement(l: BudgetLine): void { this.movLine.set(l); this.movForm = { action: 'reservar' }; this.movVisible = true; }
  applyMovement(): void {
    const l = this.movLine(); const action = this.movForm.action;
    if (!l || !action) return;
    if (!(Number(this.movForm.amount) > 0)) { this.toast.add({ severity: 'warn', summary: 'Importe', detail: 'Captura un importe > 0.' }); return; }
    if (action === 'cancelar' && !this.movForm.target) { this.toast.add({ severity: 'warn', summary: 'Falta destino', detail: 'Elige reserva o compromiso.' }); return; }
    const body: Record<string, unknown> = { amount: Number(this.movForm.amount), note: this.movForm.note || undefined };
    if (action === 'comprometer') body['fromReserva'] = !!this.movForm.fromReserva;
    if (action === 'cancelar') body['target'] = this.movForm.target;
    this.savingMov.set(true);
    this.http.post<{ warning?: string | null }>(`${this.base}/lines/${l.id}/${action}`, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.savingMov.set(false); this.movVisible = false; this.reloadDetail();
        if (res?.warning) this.toast.add({ severity: 'warn', summary: 'Aplicado con aviso', detail: res.warning });
        else this.toast.add({ severity: 'success', summary: 'Aplicado', detail: 'Movimiento registrado.' });
      },
      error: (e) => { this.savingMov.set(false); this.toast.add({ severity: 'error', summary: 'Rechazado', detail: e?.error?.message || 'No se pudo aplicar.' }); },
    });
  }

  private reloadDetail(): void { const b = this.selected(); if (b) this.selectBudget(b); }

  // ── Planeación (PU.4) ──
  openCopy(): void { const b = this.selected(); this.copyForm = { name: b?.name, scenario: b?.scenario, fiscal_year: b?.fiscal_year }; this.copyVisible = true; }
  confirmCopy(): void {
    const b = this.selected(); if (!b) return;
    this.savingCopy.set(true);
    this.http.post<{ budget: BudgetHeader; copied_lines: number }>(`${this.base}/budgets/${b.id}/copy`, this.copyForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.savingCopy.set(false); this.copyVisible = false; this.loadBudgets(); if (r?.budget) this.selectBudget(r.budget); this.toast.add({ severity: 'success', summary: 'Copiado', detail: `Nuevo ejercicio en borrador (${r?.copied_lines ?? 0} partidas, sin autorizaciones).` }); },
      error: (e) => { this.savingCopy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo copiar.' }); },
    });
  }

  openImport(): void { this.importText = ''; this.importPreview.set(null); this.importVisible = true; }
  /** Cada renglón: `concepto; tipo; area; importe` (tipo/area opcionales). */
  private parseImport(): { concept: string; line_type: string; area: string | null; original_amount: number }[] {
    return this.importText.split('\n').map((ln) => ln.trim()).filter(Boolean).map((ln) => {
      const [concept, tipo, area, imp] = ln.split(';').map((s) => s.trim());
      return { concept: concept || '', line_type: tipo || 'gasto', area: area || null, original_amount: Number(imp) };
    });
  }
  doPreview(): void {
    const b = this.selected(); if (!b) return;
    const rows = this.parseImport();
    if (!rows.length) { this.toast.add({ severity: 'warn', summary: 'Sin filas', detail: 'Pega al menos una partida.' }); return; }
    this.importPreviewing.set(true);
    this.http.post<ImportPreview>(`${this.base}/budgets/${b.id}/import/preview`, { rows }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.importPreview.set(p); this.importPreviewing.set(false); },
      error: (e) => { this.importPreviewing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo previsualizar.' }); },
    });
  }
  doApply(): void {
    const b = this.selected(); if (!b) return;
    const rows = this.parseImport();
    this.importApplying.set(true);
    this.http.post<{ created: number; updated: number; skipped: number }>(`${this.base}/budgets/${b.id}/import/apply`, { rows }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.importApplying.set(false); this.importVisible = false; this.reloadDetail(); this.toast.add({ severity: 'success', summary: 'Importado', detail: `${r.created} creadas · ${r.updated} actualizadas · ${r.skipped} omitidas.` }); },
      error: (e) => { this.importApplying.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo importar.' }); },
    });
  }

  openCompare(): void { this.compareOther = ''; this.compareResult.set(null); this.compareVisible = true; }
  runCompare(): void {
    const b = this.selected(); if (!b || !this.compareOther) { this.toast.add({ severity: 'warn', summary: 'Falta', detail: 'Elige el ejercicio a comparar.' }); return; }
    this.comparing.set(true);
    this.http.get<CompareResult>(`${this.base}/compare`, { params: { a: b.id, b: this.compareOther } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.compareResult.set(r); this.comparing.set(false); },
      error: (e) => { this.comparing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo comparar.' }); },
    });
  }
  otherBudgets(): BudgetHeader[] { const id = this.selected()?.id; return this.budgets().filter((x) => x.id !== id); }

  openProjection(): void {
    const b = this.selected(); if (!b) return;
    this.projection.set(null); this.loadingProj.set(true); this.projVisible = true;
    this.http.get<Projection>(`${this.base}/budgets/${b.id}/projection`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.projection.set(p); this.loadingProj.set(false); },
      error: () => { this.loadingProj.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo calcular la proyección.' }); },
    });
  }
  compareSeverity(estado: string): 'secondary' | 'info' | 'warn' { return estado === 'igual' ? 'secondary' : estado === 'cambio' ? 'warn' : 'info'; }

  // ── Flujo de efectivo ──
  loadCashflow(): void {
    this.loadingCashflow.set(true);
    this.http.get<Cashflow>(`${this.base}/cashflow`, { params: { from: this.cfFrom, to: this.cfTo } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cf) => { this.cashflow.set(cf); this.loadingCashflow.set(false); },
      error: (e) => { this.loadingCashflow.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el flujo.' }); },
    });
  }
  /** «Sin datos» del saldo inicial se DECLARA (texto), nunca 0 (ADR-056). */
  cashflowKpis(cf: Cashflow): MetricStripItem[] {
    return [
      cf.opening_balance.available
        ? { label: 'Saldo inicial', value: cf.opening_balance.amount as number, format: 'currency-short' }
        : { label: 'Saldo inicial', value: 'sin datos', format: 'text', tone: 'warn' },
      { label: 'Cobros previstos', value: cf.totals.cobros, format: 'currency-short', tone: 'ok' },
      { label: 'Pagos previstos', value: cf.totals.pagos, format: 'currency-short' },
      { label: 'Neto', value: cf.totals.neto, format: 'currency-short', tone: cf.totals.neto < 0 ? 'bad' : 'ok' },
      cf.opening_balance.available && cf.saldo_minimo_proyectado != null
        ? { label: 'Saldo mín. proyectado', value: cf.saldo_minimo_proyectado, format: 'currency-short', tone: cf.saldo_minimo_proyectado < 0 ? 'bad' : 'ok' }
        : { label: 'Saldo mín. proyectado', value: 'sin base', format: 'text' },
    ];
  }

  // ── Campañas ──
  loadCampaigns(): void {
    this.loadingCampaigns.set(true);
    this.http.get<Campaign[]>(`${this.base}/campaigns`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.campaigns.set(rows ?? []); this.loadingCampaigns.set(false); if (!this.selectedCampaign() && rows?.length) this.selectCampaign(rows[0]); },
      error: () => { this.loadingCampaigns.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las campañas.' }); },
    });
  }
  selectCampaign(c: Campaign): void {
    this.selectedCampaign.set(c); this.campEval.set(null); this.contributions.set([]); this.margenInput = null;
    this.reloadCampaign(c.id);
  }
  private reloadCampaign(id: string, margen?: number | null): void {
    const evalParams = margen != null ? { params: { margen_incremental: String(margen) } } : {};
    forkJoin({
      ev: this.http.get<CampaignEval>(`${this.base}/campaigns/${id}/evaluate`, evalParams),
      contribs: this.http.get<Contribution[]>(`${this.base}/campaigns/${id}/contributions`),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ ev, contribs }) => { this.campEval.set(ev); this.contributions.set(contribs ?? []); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo evaluar la campaña.' }),
    });
  }
  openNewCamp(): void { this.campForm = { campaign_type: 'publicidad' }; this.newCampVisible = true; }
  confirmNewCamp(): void {
    if (!this.campForm.name?.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el nombre', detail: 'La campaña necesita un nombre.' }); return; }
    this.savingCamp.set(true);
    this.http.post<Campaign>(`${this.base}/campaigns`, this.campForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.savingCamp.set(false); this.newCampVisible = false; this.loadCampaigns(); if (c) this.selectCampaign(c); this.toast.add({ severity: 'success', summary: 'Creada', detail: 'Campaña creada.' }); },
      error: (e) => { this.savingCamp.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' }); },
    });
  }
  setCampStatus(status: string): void {
    const c = this.selectedCampaign(); if (!c) return;
    this.savingCampStatus.set(true);
    this.http.post(`${this.base}/campaigns/${c.id}/status`, { status }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingCampStatus.set(false); this.loadCampaigns(); this.reloadCampaign(c.id); this.toast.add({ severity: 'success', summary: 'Listo', detail: 'Estado actualizado.' }); },
      error: (e) => { this.savingCampStatus.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo.' }); },
    });
  }
  recalcRetorno(): void {
    const c = this.selectedCampaign(); if (!c) return;
    if (!(Number(this.margenInput) > 0)) { this.toast.add({ severity: 'warn', summary: 'Margen', detail: 'Captura un margen incremental > 0.' }); return; }
    this.reloadCampaign(c.id, Number(this.margenInput));
  }
  openAddContrib(): void { this.contribForm = { status: 'incierta' }; this.addContribVisible = true; }
  confirmAddContrib(): void {
    const c = this.selectedCampaign(); if (!c) return;
    if (!this.contribForm.supplier?.trim() || !(Number(this.contribForm.amount) > 0)) { this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Proveedor e importe son requeridos.' }); return; }
    this.savingContrib.set(true);
    this.http.post(`${this.base}/campaigns/${c.id}/contributions`, this.contribForm).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.savingContrib.set(false); this.addContribVisible = false; this.reloadCampaign(c.id, this.margenInput); this.toast.add({ severity: 'success', summary: 'Agregada', detail: 'Aportación registrada.' }); },
      error: (e) => { this.savingContrib.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo.' }); },
    });
  }
  confirmContrib(ct: Contribution): void {
    const c = this.selectedCampaign(); if (!c) return;
    this.http.post(`${this.base}/campaigns/${c.id}/contributions/${ct.id}/status`, { status: 'confirmada' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reloadCampaign(c.id, this.margenInput); this.toast.add({ severity: 'success', summary: 'Confirmada', detail: 'La aportación ahora reduce el gasto neto.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo.' }),
    });
  }
  campKpis(ev: CampaignEval): MetricStripItem[] {
    return [
      { label: 'Presupuesto', value: ev.presupuesto, format: 'currency-short' },
      { label: 'Costo (ejercido)', value: ev.costo, format: 'currency-short' },
      { label: 'Costo neto', value: ev.costo_neto_aportacion, format: 'currency-short', sub: 'menos aportación confirmada' },
      ev.ventas_vinculadas.available
        ? { label: 'Ventas vinculadas', value: ev.ventas_vinculadas.ventas as number, format: 'currency-short' }
        : { label: 'Ventas vinculadas', value: 'sin datos', format: 'text', tone: 'warn' },
      ev.intensidad_gasto_ventas_pct != null
        ? { label: 'Gasto / ventas', value: ev.intensidad_gasto_ventas_pct, format: 'percent' }
        : { label: 'Gasto / ventas', value: 'sin base', format: 'text' },
    ];
  }
  campTypeLabel(t: string): string {
    return ({ publicidad: 'Publicidad', materiales: 'Materiales', eventos: 'Eventos', promociones: 'Promociones', descuento_comercial: 'Descuento com.', otro: 'Otro' } as Record<string, string>)[t] || t;
  }
  campSeverity(s: string): 'success' | 'info' | 'secondary' { return s === 'activa' ? 'success' : s === 'cerrada' ? 'secondary' : 'info'; }
  contribSeverity(s: string): 'success' | 'info' | 'warn' { return s === 'confirmada' || s === 'aplicada' ? 'success' : 'warn'; }

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
