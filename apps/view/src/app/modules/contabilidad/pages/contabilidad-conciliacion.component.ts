import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { ConciliacionService, PpdRow, ConciliacionStats, CruceStats, CfdiSinPoliza, PolizaSinCfdi, ConcFilters } from '../conciliacion.service';

/**
 * FISCAL.5 — Conciliación (Operations). Dos vistas: REP (PUE/PPD ↔ complemento de
 * pago: saldo insoluto + PPD sin REP) y Cruce CFDI ↔ póliza (heurístico, scoped a
 * periodos descargados). Vacío = esperado hasta poblar fiscal.cfdis (no error).
 *
 * Filtros (el backend ya los aceptaba): rango de fechas, RFC/proveedor y rol (REP).
 * Paginación LAZY server-side: el conteo del KPI es el `totalRecords`, así deja de
 * ocultar filas más allá de 100 (el default del endpoint).
 */
@Component({
  selector: 'app-contabilidad-conciliacion',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule, IconFieldModule, InputIconModule, SelectButtonModule, DatePickerModule, TagModule, PageTabsComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head co-head">
        <div class="surf-page-head-text">
          <h1 class="co-h1">Conciliación fiscal <app-context-help topic="conciliacion" /></h1>
          <p class="surf-page-sub">Complementos de pago (REP) y cruce de CFDI contra la póliza contable. Determinista sobre lo descargado del SAT.</p>
        </div>
        <div class="co-head-actions">
          <button pButton type="button" icon="pi pi-refresh" label="Actualizar" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"></button>
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
        </div>
      </header>

      <div class="co-viewsel">
        <p-selectButton [options]="viewOpts" [ngModel]="view()" (ngModelChange)="setView($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Vista de conciliación" />
      </div>

      <div class="co-filters">
        <p-iconfield iconPosition="left" styleClass="co-search">
          <p-inputicon styleClass="pi pi-search" />
          <input type="text" pInputText placeholder="Buscar RFC del proveedor…" [(ngModel)]="rfc" (keyup.enter)="applyFilters()" aria-label="Buscar por RFC" />
        </p-iconfield>
        <label class="co-field"><span>Desde</span>
          <p-datepicker [(ngModel)]="fromD" (onSelect)="applyFilters()" (onClear)="applyFilters()" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" />
        </label>
        <label class="co-field"><span>Hasta</span>
          <p-datepicker [(ngModel)]="toD" (onSelect)="applyFilters()" (onClear)="applyFilters()" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" />
        </label>
        @if (view() === 'rep') {
          <p-selectButton [options]="rolOpts" [ngModel]="rol()" (ngModelChange)="setRol($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Rol de los comprobantes" />
        }
        <button pButton type="button" label="Buscar" icon="pi pi-filter" class="p-button-sm p-button-outlined" (click)="applyFilters()"></button>
        @if (hasFilters()) { <button pButton type="button" label="Limpiar" icon="pi pi-times" class="p-button-sm p-button-text" (click)="clearFilters()"></button> }
      </div>

      @if (view() === 'rep') {
        @if (repStats(); as s) {
          <app-metric-strip [items]="repItems(s)" ariaLabel="Resumen REP" />
        }
        <div class="co-subseg">
          <p-selectButton [options]="repTabOpts" [ngModel]="repTab()" (ngModelChange)="setRepTab($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Sub-vista REP" />
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="repRows()" styleClass="p-datatable-sm co-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px"
                   [lazy]="true" [paginator]="total() > 50" [rows]="50" [first]="offset()" [totalRecords]="total()" (onLazyLoad)="onPage($event)">
            <ng-template pTemplate="header">
              <tr><th>Proveedor</th><th style="width:12rem">UUID</th><th style="width:7rem">Fecha</th><th class="ta-r" style="width:9rem">Total</th><th class="ta-r" style="width:9rem">Pagado</th><th class="ta-r" style="width:9rem">Saldo</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr>
                <td><div class="co-name">{{ r.emisor_nombre || r.emisor_rfc || '—' }}</div><div class="co-rfc mono">{{ r.emisor_rfc }}</div></td>
                <td class="mono co-uuid">{{ r.uuid }}</td>
                <td class="mono">{{ r.fecha ? (r.fecha | date:'dd/MM/yy') : '—' }}</td>
                <td class="ta-r mono">{{ money(r.total) }}</td>
                <td class="ta-r mono">{{ money(r.pagado) }}</td>
                <td class="ta-r strong mono" [class.bad]="+r.saldo > 0">{{ money(r.saldo) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="co-empty">{{ emptyMsg() }}@if (errored()) { <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }</td></tr></ng-template>
          </p-table>
        </div>
      } @else {
        @if (cruceStats(); as s) {
          <app-metric-strip [items]="cruceItems(s)" ariaLabel="Resumen cruce pólizas/CFDI" />
        }
        <div class="co-subseg">
          <p-selectButton [options]="cruceTabOpts" [ngModel]="cruceTab()" (ngModelChange)="setCruceTab($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Sub-vista cruce" />
        </div>
        <div class="card-premium card-flat">
          @if (cruceTab() === 'poliza') {
            <p-table [value]="polizaSinCfdi()" styleClass="p-datatable-sm co-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px"
                     [lazy]="true" [paginator]="total() > 50" [rows]="50" [first]="offset()" [totalRecords]="total()" (onLazyLoad)="onPage($event)">
              <ng-template pTemplate="header"><tr><th>Beneficiario</th><th style="width:10rem">Documento</th><th style="width:7rem">Fecha</th><th class="ta-r" style="width:10rem">Importe</th></tr></ng-template>
              <ng-template pTemplate="body" let-r>
                <tr><td><div class="co-name">{{ r.beneficiario || r.rfc || '—' }}</div><div class="co-rfc mono">{{ r.rfc }}</div></td>
                <td class="mono">{{ r.sucursal }}/{{ r.doc_tipo }}/{{ r.doc_folio }}</td>
                <td class="mono">{{ r.fecha ? (r.fecha | date:'dd/MM/yy') : '—' }}</td>
                <td class="ta-r strong mono">{{ money(r.importe) }}</td></tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="4" class="co-empty">{{ emptyMsg() }}@if (errored()) { <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }</td></tr></ng-template>
            </p-table>
          } @else {
            <p-table [value]="cfdiSinPoliza()" styleClass="p-datatable-sm co-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px"
                     [lazy]="true" [paginator]="total() > 50" [rows]="50" [first]="offset()" [totalRecords]="total()" (onLazyLoad)="onPage($event)">
              <ng-template pTemplate="header"><tr><th>Emisor</th><th style="width:12rem">UUID</th><th style="width:7rem">Fecha</th><th style="width:5rem">Método</th><th class="ta-r" style="width:10rem">Total</th></tr></ng-template>
              <ng-template pTemplate="body" let-r>
                <tr><td><div class="co-name">{{ r.emisor_nombre || r.emisor_rfc || '—' }}</div><div class="co-rfc mono">{{ r.emisor_rfc }}</div></td>
                <td class="mono co-uuid">{{ r.uuid }}</td>
                <td class="mono">{{ r.fecha ? (r.fecha | date:'dd/MM/yy') : '—' }}</td>
                <td>@if (r.metodo_pago) { <p-tag [value]="r.metodo_pago" severity="secondary" styleClass="co-chip" /> } @else { — }</td>
                <td class="ta-r strong mono">{{ money(r.total) }}</td></tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="5" class="co-empty">{{ emptyMsg() }}@if (errored()) { <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }</td></tr></ng-template>
            </p-table>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .co-head { display: flex; align-items: flex-start; gap: 1rem; }
    .co-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .co-head-actions { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: .4rem; }
    .co-viewsel { margin-bottom: 1rem; }
    .co-filters { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: 1rem; }
    .co-search input { min-width: 240px; }
    .co-field { display: flex; flex-direction: column; gap: .15rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .co-subseg { display: inline-flex; gap: .3rem; margin-bottom: .8rem; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .co-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .bad { color: var(--bad-fg); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .co-uuid { color: var(--text-muted); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .co-name { font-weight: 600; color: var(--text-main); max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .co-rfc { color: var(--text-muted); margin-top: .05rem; }
    :host ::ng-deep .co-chip .p-tag { font-size: .66rem; font-weight: 700; padding: .1rem .5rem; }
    .co-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
  `],
})
export class ContabilidadConciliacionComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(ConciliacionService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rolOpts = [{ label: 'Recibidas', value: 'recibidas' }, { label: 'Emitidas', value: 'emitidas' }, { label: 'Todos', value: 'all' }];
  readonly viewOpts = [{ label: 'PUE/PPD ↔ REP', value: 'rep' }, { label: 'CFDI ↔ póliza', value: 'cruce' }];
  readonly repTabOpts = [{ label: 'PPD sin REP', value: 'sin_rep' }, { label: 'Con saldo insoluto', value: 'saldo' }];
  readonly cruceTabOpts = [{ label: 'Gastos sin CFDI', value: 'poliza' }, { label: 'CFDI sin póliza', value: 'cfdi' }];

  readonly view = signal<'rep' | 'cruce'>('rep');
  readonly repTab = signal<'sin_rep' | 'saldo'>('sin_rep');
  readonly cruceTab = signal<'poliza' | 'cfdi'>('poliza');
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly loadedAt = signal<number | null>(null);

  // filtros (el backend ya los acepta)
  fromD: Date | null = null; toD: Date | null = null; rfc = '';
  readonly rol = signal<'recibidas' | 'emitidas' | 'all'>('recibidas');
  readonly offset = signal(0);

  readonly repStats = signal<ConciliacionStats | null>(null);
  readonly cruceStats = signal<CruceStats | null>(null);
  readonly ppdSinRep = signal<PpdRow[]>([]);
  readonly saldoInsoluto = signal<PpdRow[]>([]);
  readonly cfdiSinPoliza = signal<CfdiSinPoliza[]>([]);
  readonly polizaSinCfdi = signal<PolizaSinCfdi[]>([]);

  readonly repRows = computed(() => this.repTab() === 'sin_rep' ? this.ppdSinRep() : this.saldoInsoluto());

  /** total del KPI que corresponde a la tabla visible → totalRecords de la paginación lazy. */
  readonly total = computed(() => {
    if (this.view() === 'rep') {
      const s = this.repStats(); if (!s) return 0;
      return this.repTab() === 'sin_rep' ? s.ppd_sin_rep : s.con_saldo;
    }
    const s = this.cruceStats(); if (!s) return 0;
    return this.cruceTab() === 'poliza' ? s.poliza_sin_cfdi : s.cfdi_sin_poliza;
  });

  repItems(s: ConciliacionStats): MetricStripItem[] {
    return [
      { label: 'PPD sin REP', value: s.ppd_sin_rep, tone: s.ppd_sin_rep > 0 ? 'warn' : 'default' },
      { label: 'Con saldo insoluto', value: s.con_saldo },
      { label: 'Saldo insoluto total', value: s.saldo_total, format: 'currency' },
      { label: 'Facturas PPD', value: s.ppd_total },
    ];
  }
  cruceItems(s: CruceStats): MetricStripItem[] {
    return [
      { label: 'Gastos sin CFDI', value: s.poliza_sin_cfdi, tone: s.poliza_sin_cfdi > 0 ? 'warn' : 'default' },
      { label: '$ sin comprobante', value: s.poliza_sin_cfdi_monto, format: 'currency' },
      { label: 'CFDI sin registrar', value: s.cfdi_sin_poliza },
      { label: '$ sin registrar', value: s.cfdi_sin_poliza_monto, format: 'currency' },
    ];
  }

  ngOnInit() { this.reload(); }

  private fmt(d: Date | null): string | undefined {
    if (!d) return undefined;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  private filters(): ConcFilters {
    return { from: this.fmt(this.fromD), to: this.fmt(this.toD), rfc: this.rfc.trim() || undefined, rol: this.rol() === 'all' ? undefined : this.rol(), limit: 50, offset: this.offset() };
  }
  hasFilters(): boolean { return !!(this.fromD || this.toD || this.rfc.trim() || (this.view() === 'rep' && this.rol() !== 'recibidas')); }

  /** Recarga los stats (KPIs + totalRecords) y la tabla visible con los filtros actuales. */
  reload() {
    const f = this.filters();
    this.svc.stats(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.repStats.set(s), error: () => {} });
    this.svc.cruceStats(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.cruceStats.set(s), error: () => {} });
    this.loadVisible();
  }

  /** Carga solo la tabla visible (con limit/offset) — no re-consulta las demás. */
  private loadVisible() {
    const f = this.filters();
    this.loading.set(true); this.errored.set(false);
    const done = () => { this.loading.set(false); this.loadedAt.set(Date.now()); };
    const fail = () => { this.errored.set(true); done(); };
    if (this.view() === 'rep') {
      if (this.repTab() === 'sin_rep') this.svc.ppdSinRep(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.ppdSinRep.set(r); done(); }, error: fail });
      else this.svc.saldoInsoluto(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.saldoInsoluto.set(r); done(); }, error: fail });
    } else {
      if (this.cruceTab() === 'poliza') this.svc.polizaSinCfdi(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.polizaSinCfdi.set(r); done(); }, error: fail });
      else this.svc.cfdiSinPoliza(f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.cfdiSinPoliza.set(r); done(); }, error: fail });
    }
  }

  applyFilters() { this.offset.set(0); this.reload(); }
  clearFilters() { this.fromD = null; this.toD = null; this.rfc = ''; this.rol.set('recibidas'); this.applyFilters(); }
  onPage(e: { first?: number }) { const f = e.first ?? 0; if (f !== this.offset()) { this.offset.set(f); this.loadVisible(); } }
  setView(v: 'rep' | 'cruce') { if (v === this.view()) return; this.view.set(v); this.offset.set(0); this.loadVisible(); }
  setRepTab(t: 'sin_rep' | 'saldo') { if (t === this.repTab()) return; this.repTab.set(t); this.offset.set(0); this.loadVisible(); }
  setCruceTab(t: 'poliza' | 'cfdi') { if (t === this.cruceTab()) return; this.cruceTab.set(t); this.offset.set(0); this.loadVisible(); }
  setRol(r: 'recibidas' | 'emitidas' | 'all') { this.rol.set(r); this.applyFilters(); }

  emptyMsg(): string {
    if (this.loading()) return 'Cargando…';
    if (this.errored()) return 'No se pudo cargar la conciliación.';
    if (this.hasFilters()) return 'Sin resultados para este filtro. Ampliá el rango de fechas o quitá el RFC.';
    return 'Sin resultados. Se llena al correr la descarga masiva de CFDI del SAT.';
  }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
