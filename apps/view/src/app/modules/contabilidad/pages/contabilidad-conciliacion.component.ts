import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { ConciliacionService, PpdRow, ConciliacionStats, CruceStats, CfdiSinPoliza, PolizaSinCfdi } from '../conciliacion.service';

/**
 * FISCAL.5 — Conciliación (Operations). Dos vistas: REP (PUE/PPD ↔ complemento de
 * pago: saldo insoluto + PPD sin REP) y Cruce CFDI ↔ póliza (heurístico, scoped a
 * periodos descargados). Vacío = esperado hasta poblar fiscal.cfdis (no error).
 */
@Component({
  selector: 'app-contabilidad-conciliacion',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, ToastModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head co-head">
        <div class="surf-page-head-text">
          <h1>Conciliación fiscal</h1>
          <p class="surf-page-sub">Complementos de pago (REP) y cruce de CFDI contra la póliza contable. Determinista sobre lo descargado del SAT.</p>
        </div>
      </header>

      <div class="co-seg" role="tablist">
        <button role="tab" [attr.aria-selected]="view()==='rep'" [class.active]="view()==='rep'" (click)="view.set('rep')">PUE/PPD ↔ REP</button>
        <button role="tab" [attr.aria-selected]="view()==='cruce'" [class.active]="view()==='cruce'" (click)="view.set('cruce')">CFDI ↔ póliza</button>
      </div>

      @if (view() === 'rep') {
        @if (repStats(); as s) {
          <app-metric-strip [items]="repItems(s)" ariaLabel="Resumen REP" />
        }
        <div class="co-subseg">
          <button [class.active]="repTab()==='sin_rep'" (click)="repTab.set('sin_rep')">PPD sin REP</button>
          <button [class.active]="repTab()==='saldo'" (click)="repTab.set('saldo')">Con saldo insoluto</button>
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="repRows()" styleClass="p-datatable-sm co-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px" [paginator]="repRows().length > 50" [rows]="50">
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
            <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="co-empty">{{ emptyMsg() }}</td></tr></ng-template>
          </p-table>
        </div>
      } @else {
        @if (cruceStats(); as s) {
          <app-metric-strip [items]="cruceItems(s)" ariaLabel="Resumen cruce pólizas/CFDI" />
        }
        <div class="co-subseg">
          <button [class.active]="cruceTab()==='poliza'" (click)="cruceTab.set('poliza')">Gastos sin CFDI</button>
          <button [class.active]="cruceTab()==='cfdi'" (click)="cruceTab.set('cfdi')">CFDI sin póliza</button>
        </div>
        <div class="card-premium card-flat">
          @if (cruceTab() === 'poliza') {
            <p-table [value]="polizaSinCfdi()" styleClass="p-datatable-sm co-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px" [paginator]="polizaSinCfdi().length > 50" [rows]="50">
              <ng-template pTemplate="header"><tr><th>Beneficiario</th><th style="width:10rem">Documento</th><th style="width:7rem">Fecha</th><th class="ta-r" style="width:10rem">Importe</th></tr></ng-template>
              <ng-template pTemplate="body" let-r>
                <tr><td><div class="co-name">{{ r.beneficiario || r.rfc || '—' }}</div><div class="co-rfc mono">{{ r.rfc }}</div></td>
                <td class="mono">{{ r.sucursal }}/{{ r.doc_tipo }}/{{ r.doc_folio }}</td>
                <td class="mono">{{ r.fecha ? (r.fecha | date:'dd/MM/yy') : '—' }}</td>
                <td class="ta-r strong mono">{{ money(r.importe) }}</td></tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="4" class="co-empty">{{ emptyMsg() }}</td></tr></ng-template>
            </p-table>
          } @else {
            <p-table [value]="cfdiSinPoliza()" styleClass="p-datatable-sm co-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px" [paginator]="cfdiSinPoliza().length > 50" [rows]="50">
              <ng-template pTemplate="header"><tr><th>Emisor</th><th style="width:12rem">UUID</th><th style="width:7rem">Fecha</th><th style="width:5rem">Método</th><th class="ta-r" style="width:10rem">Total</th></tr></ng-template>
              <ng-template pTemplate="body" let-r>
                <tr><td><div class="co-name">{{ r.emisor_nombre || r.emisor_rfc || '—' }}</div><div class="co-rfc mono">{{ r.emisor_rfc }}</div></td>
                <td class="mono co-uuid">{{ r.uuid }}</td>
                <td class="mono">{{ r.fecha ? (r.fecha | date:'dd/MM/yy') : '—' }}</td>
                <td>@if (r.metodo_pago) { <span class="co-tag">{{ r.metodo_pago }}</span> } @else { — }</td>
                <td class="ta-r strong mono">{{ money(r.total) }}</td></tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="5" class="co-empty">{{ emptyMsg() }}</td></tr></ng-template>
            </p-table>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .co-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; margin-bottom: 1rem; }
    .co-seg button { border: none; background: var(--card-bg); padding: .4rem 1rem; font-size: .85rem; cursor: pointer; color: var(--text-muted); }
    .co-seg button.active { background: var(--action); color: var(--action-ink, #fff); font-weight: 600; }
    .co-subseg { display: inline-flex; gap: .3rem; margin-bottom: .8rem; }
    .co-subseg button { border: 1px solid var(--border-color); background: var(--card-bg); border-radius: var(--r-pill, 999px); padding: .25rem .8rem; font-size: .78rem; cursor: pointer; color: var(--text-muted); }
    .co-subseg button.active { border-color: var(--action); color: var(--action); font-weight: 600; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .co-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .bad { color: var(--bad-fg, #dc2626); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .co-uuid { color: var(--text-muted); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .co-name { font-weight: 600; color: var(--text-main); max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .co-rfc { color: var(--text-muted); margin-top: .05rem; }
    .co-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .7rem; font-weight: 600; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .co-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
  `],
})
export class ContabilidadConciliacionComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(ConciliacionService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly view = signal<'rep' | 'cruce'>('rep');
  readonly repTab = signal<'sin_rep' | 'saldo'>('sin_rep');
  readonly cruceTab = signal<'poliza' | 'cfdi'>('poliza');
  readonly loading = signal(false);
  readonly errored = signal(false);

  readonly repStats = signal<ConciliacionStats | null>(null);

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
  readonly ppdSinRep = signal<PpdRow[]>([]);
  readonly saldoInsoluto = signal<PpdRow[]>([]);
  readonly cruceStats = signal<CruceStats | null>(null);
  readonly cfdiSinPoliza = signal<CfdiSinPoliza[]>([]);
  readonly polizaSinCfdi = signal<PolizaSinCfdi[]>([]);

  readonly repRows = computed(() => this.repTab() === 'sin_rep' ? this.ppdSinRep() : this.saldoInsoluto());

  ngOnInit() { this.reload(); }

  reload() {
    this.loading.set(true); this.errored.set(false);
    let pending = 5;
    const done = () => { if (--pending <= 0) this.loading.set(false); };
    const fail = () => { this.errored.set(true); done(); };
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => { this.repStats.set(s); done(); }, error: fail });
    this.svc.ppdSinRep().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.ppdSinRep.set(r); done(); }, error: fail });
    this.svc.saldoInsoluto().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.saldoInsoluto.set(r); done(); }, error: fail });
    this.svc.cruceStats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => { this.cruceStats.set(s); done(); }, error: fail });
    this.svc.polizaSinCfdi().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.polizaSinCfdi.set(r); done(); }, error: fail });
    this.svc.cfdiSinPoliza().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.cfdiSinPoliza.set(r), error: () => {} });
  }

  emptyMsg(): string {
    if (this.loading()) return 'Cargando…';
    if (this.errored()) return 'No se pudo cargar la conciliación.';
    return 'Sin resultados. Se llena al correr la descarga masiva de CFDI del SAT.';
  }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
