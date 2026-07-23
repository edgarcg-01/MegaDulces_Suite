import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { ComercialService, ExpenseRequestRow, ExpenseRequestsReport } from '../../comercial/comercial.service';
import { ComprobacionesService } from '../comprobaciones.service';

/**
 * GX.6 — "Solicitudes de gasto": lista de solicitudes (Kepler XA1501) con su estado
 * y si ya se aplicaron a un gasto (XA1001). Foco de control: las pendientes (pedidas/
 * aprobadas y no ejecutadas). Fuente analytics.expense_requests (feed import-expense-requests).
 */
@Component({
  selector: 'app-finanzas-solicitudes',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule, SelectModule, DatePickerModule, TagModule, InputTextModule, ButtonModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, ContextHelpComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <div style="display:inline-flex;align-items:center;gap:.4rem"><h1>Solicitudes de gasto</h1><app-context-help topic="solicitudes" /></div>
          <p class="surf-page-sub">Solicitudes (XA1501) y su aplicación a gasto (XA1001) · estado, solicitante y días de proceso · fuente Kepler</p>
        </div>
      </header>

      <!-- Filtros -->
      <div class="so-filters card-premium card-flat">
        <div class="so-field"><label>Rango</label>
          <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="queue()" /></div>
        <div class="so-field"><label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code" placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queue()" /></div>
        <div class="so-field"><label>Estado</label>
          <app-segmented [options]="aplicadaOpts" [value]="aplicadaSel()" (valueChange)="setAplicada($event)" ariaLabel="Aplicación" /></div>
        <div class="so-field"><label>Estatus doc</label>
          <p-select [options]="estadoOpts" [(ngModel)]="estado" optionLabel="label" optionValue="value" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="queue()" styleClass="w-full" /></div>
        <div class="so-field"><label>Solicitante</label>
          <p-select [options]="solicitantes()" [(ngModel)]="solicitante" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="queue()" styleClass="w-full" [filter]="true" /></div>
        <div class="so-field so-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Folio, beneficiario, concepto…" (keyup.enter)="load()" (blur)="queue()" /></div>
      </div>

      <!-- KPIs -->
      @if (report(); as r) {
        <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen de solicitudes" />
      }

      <!-- Tabla -->
      @if (error()) {
        <app-load-state [error]="error()" (retry)="load()"></app-load-state>
      } @else {
      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm so-table" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
                 [paginator]="rows().length > 100" [rows]="100" [loading]="loading()"
                 sortField="fecha" [sortOrder]="-1">
          <ng-template pTemplate="header">
            <tr>
              <th pSortableColumn="fecha" style="width:6rem">Fecha <p-sortIcon field="fecha" /></th>
              <th pSortableColumn="folio" style="width:6rem">Folio <p-sortIcon field="folio" /></th>
              <th>Sucursal</th>
              <th pSortableColumn="solicitante">Solicitante <p-sortIcon field="solicitante" /></th>
              <th>Beneficiario</th>
              <th>Concepto</th>
              <th class="ta-r" pSortableColumn="importe" style="width:9rem">Importe <p-sortIcon field="importe" /></th>
              <th style="width:7rem">Estatus</th>
              <th style="width:9rem">Aplicación</th>
              <th class="ta-r" pSortableColumn="lead_days" style="width:5rem">Días <p-sortIcon field="lead_days" /></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td>{{ r.fecha | date:'dd/MM/yy' }}</td>
              <td class="mono">{{ r.folio }}</td>
              <td>{{ r.sucursal_nombre || r.sucursal }}</td>
              <td>{{ r.solicitante || '—' }}</td>
              <td>{{ r.beneficiario || '—' }}</td>
              <td class="muted">{{ r.concepto || '—' }}</td>
              <td class="ta-r strong">{{ money(r.importe) }}</td>
              <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)" /></td>
              <td>
                @if (r.aplicada) {
                  <button type="button" class="so-link" (click)="verGasto(r)" [title]="'Ver gasto ' + r.gasto_folio">
                    <i class="pi pi-check-circle"></i> {{ r.gasto_folio || 'Aplicada' }}
                  </button>
                } @else if (!proofStatus()[r.folio]) {
                  <button type="button" class="so-link so-comprobar" (click)="comprobar(r)" title="Subir comprobantes de esta solicitud">
                    <i class="pi pi-upload"></i> Comprobar
                  </button>
                }
                @if (proofStatus()[r.folio]; as ps) {
                  <div class="so-proof" [ngClass]="'ps-' + ps"><i class="pi" [ngClass]="proofIcon(ps)"></i> Comprobante {{ proofLabel(ps) }}</div>
                }
              </td>
              <td class="ta-r muted">{{ r.lead_days != null ? r.lead_days : '—' }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="10" class="so-empty">Sin solicitudes para el filtro. (¿corrió el feed?)</td></tr></ng-template>
        </p-table>
      </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .so-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .so-field { display: flex; flex-direction: column; gap: .3rem; }
    .so-field > label { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .so-field.so-grow { flex: 1 1 16rem; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .so-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .so-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .so-table .strong { font-weight: 600; color: var(--text-main); }
    .so-table .muted { color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-size: .85em; }
    .so-link { border: none; background: transparent; color: var(--action); cursor: pointer; padding: .1rem .2rem; display: inline-flex; align-items: center; gap: .3rem; font-size: .82rem; }
    .so-link:hover { text-decoration: underline; }
    .so-link i { font-size: .78rem; color: var(--ok-fg); }
    .so-empty { text-align: center; color: var(--text-muted); padding: 2rem; }
    .so-proof { font-size: .72rem; display: inline-flex; align-items: center; gap: .3rem; margin-top: .15rem; }
    .so-proof i { font-size: .72rem; }
    .so-proof.ps-recibida { color: var(--warn-fg); }
    .so-proof.ps-validada { color: var(--ok-fg); }
    .so-proof.ps-rechazada { color: var(--bad-fg); }
  `],
})
export class FinanzasSolicitudesComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly comprobaciones = inject(ComprobacionesService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<ExpenseRequestsReport | null>(null);
  readonly proofStatus = signal<Record<string, string>>({});

  kpiItems(r: ExpenseRequestsReport): MetricStripItem[] {
    return [
      { label: 'Solicitudes', value: r.kpis.total, sub: this.money(r.kpis.importe) },
      { label: 'Sin aplicar', value: r.kpis.pendientes, tone: 'bad', sub: this.money(r.kpis.pendientes_importe) },
      { label: 'Aplicadas', value: r.kpis.aplicadas, tone: 'ok', sub: `${this.pct(r.kpis.aplicadas, r.kpis.total)}%` },
    ];
  }
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly solicitantes = signal<string[]>([]);
  readonly aplicadaSel = signal<string>('');

  readonly aplicadaOpts = [{ label: 'Todas', value: '' }, { label: 'Sin aplicar', value: 'pend' }, { label: 'Aplicadas', value: 'apl' }];
  readonly estadoOpts = [
    { label: 'Finalizada', value: 'F' }, { label: 'Autorizada', value: 'A' },
    { label: 'Cancelada', value: 'C' }, { label: 'Nueva', value: 'N' },
  ];

  sucursal: string[] = [];
  estado: string | null = null;
  solicitante: string | null = null;
  search = '';
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.svc.expensesSucursales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code }))));
    this.svc.expensesFilters().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((f) => this.solicitantes.set(f.areas || []));
    this.comprobaciones.statusByFolio().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((m) => this.proofStatus.set(m || {}));
    this.load();
  }

  setAplicada(v: string) { this.aplicadaSel.set(v); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    const ap = this.aplicadaSel();
    this.loading.set(true);
    this.error.set(null);
    this.svc.expenseRequests({
      from: fmt(a), to: fmt(b),
      sucursal: this.sucursal, estado: this.estado || undefined,
      solicitante: this.solicitante || undefined, search: this.search || undefined,
      aplicada: ap === 'pend' ? false : ap === 'apl' ? true : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar las solicitudes de gasto.'); this.loading.set(false); },
      });
  }

  /** Atajo a Reembolsos con el folio de la solicitud + proveedor pre-llenados. */
  comprobar(r: ExpenseRequestRow) {
    this.router.navigate(['/finanzas/comprobaciones'], {
      queryParams: { open: '1', folio_solicitud: r.folio || '', proveedor: r.beneficiario || '' },
    });
  }

  proofLabel(s: string): string { return ({ recibida: 'recibido', validada: 'validado', rechazada: 'rechazado' } as Record<string, string>)[s] || s; }
  proofIcon(s: string): string { return ({ recibida: 'pi-clock', validada: 'pi-check-circle', rechazada: 'pi-times-circle' } as Record<string, string>)[s] || 'pi-file'; }

  /** Abre el gasto ligado en el detalle de egresos. */
  verGasto(r: ExpenseRequestRow) {
    if (!r.gasto_folio) return;
    this.router.navigate(['/finanzas/egresos/detalle'], {
      queryParams: { type: 'beneficiario', key: r.beneficiario || '', label: r.beneficiario || '',
        doc_sucursal: r.sucursal, doc_tipo: 'XA1001', doc_folio: r.gasto_folio },
    });
  }

  estadoLabel(e: string | null): string {
    return ({ F: 'Finalizada', A: 'Autorizada', C: 'Cancelada', N: 'Nueva' } as Record<string, string>)[e || ''] || (e || '—');
  }
  estadoSev(e: string | null): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return ({ F: 'success', A: 'info', C: 'danger', N: 'warn' } as Record<string, 'success' | 'info' | 'warn' | 'danger'>)[e || ''] || 'secondary';
  }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  pct(a: number, b: number): number { return b ? Math.round((a / b) * 100) : 0; }
}
