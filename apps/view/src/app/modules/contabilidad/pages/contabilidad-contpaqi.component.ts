import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import {
  ContabilidadContpaqiService, BalanzaResp, BankResp, EfosResp, LibrosVsOpResp, BalanzaGroupBy, BankGroupBy, CfdiVsContabResp,
} from '../contabilidad-contpaqi.service';

type View = 'balanza' | 'bancos' | 'efos' | 'libros' | 'cfdi';

/**
 * Fase CP (ADR-040) — ContPAQi en el proyecto Contabilidad. Los LIBROS FISCALES reales
 * (SQL Server ContPAQi): balanza, auxiliar bancario por banco, proveedores en lista negra
 * SAT (EFOS) y contraste libros-vs-operación. Superficie directa (no vía el chat de Maat).
 * Operations: denso, tokens, dark-safe, answer-first. Carga perezosa por vista.
 */
@Component({
  selector: 'app-contabilidad-contpaqi',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cp-page">
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>ContPAQi — Libros fiscales</h1>
          <p class="surf-page-sub">Los libros de la contabilidad (ContPAQi) dentro de la plataforma: balanza, bancos, riesgo SAT y contraste con la operación. Verdad fiscal consolidada.</p>
        </div>
      </header>

      <div class="cp-seg" role="tablist">
        @for (v of VIEWS; track v.key) {
          <button role="tab" [attr.aria-selected]="view()===v.key" [class.active]="view()===v.key" (click)="go(v.key)">
            <i [class]="v.icon"></i> {{ v.label }}
          </button>
        }
      </div>

      @if (view() === 'cfdi') {
        <div class="cp-controls">
          <label>Periodo
            <p-select [options]="periodOpts" [ngModel]="period()" (ngModelChange)="setPeriod($event)" appendTo="body" styleClass="cp-sel" [style]="{ minWidth: '9rem' }"></p-select>
          </label>
        </div>
      }

      @if (loading()) {
        <div class="cp-skel" aria-busy="true">@for (i of [1,2,3,4,5]; track i) { <div class="cp-skel-row"></div> }</div>
      } @else {

      <!-- ── BALANZA ── -->
      @if (view() === 'balanza') {
        <div class="cp-controls">
          <label>Agrupar por
            <p-select [options]="balanzaGroups" [ngModel]="balanzaBy()" (ngModelChange)="setBalanzaBy($event)" appendTo="body" styleClass="cp-sel" [style]="{ minWidth: '11rem' }"></p-select>
          </label>
        </div>
        @if (balanza(); as b) {
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="b.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh" [paginator]="b.rows.length > 50" [rows]="50">
              <ng-template #header><tr><th>{{ balanzaBy() }}</th><th class="ta-r">Cargos</th><th class="ta-r">Abonos</th><th class="ta-r">Neto</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="cp-key">{{ r[balanzaBy()] }}</td>
                  <td class="ta-r mono">{{ r.cargos | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ r.abonos | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono" [class.bad]="r.neto < 0">{{ r.neto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos. ¿Corriste el importer de balanza?</p></div></td></tr></ng-template>
            </p-table>
            <p class="cp-note muted">{{ b.fuente }} · {{ b.from_mes }} → {{ b.to_mes }}</p>
          </div>
        }
      }

      <!-- ── BANCOS (auxiliar por banco) ── -->
      @if (view() === 'bancos') {
        <div class="cp-controls">
          <label>Agrupar por
            <p-select [options]="bankGroups" [ngModel]="bankBy()" (ngModelChange)="setBankBy($event)" appendTo="body" styleClass="cp-sel" [style]="{ minWidth: '9rem' }"></p-select>
          </label>
        </div>
        @if (bank(); as b) {
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="b.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
              <ng-template #header><tr><th>{{ bankBy()==='mes' ? 'Mes' : 'Banco' }}</th><th class="ta-r">Depósitos</th><th class="ta-r">Retiros</th><th class="ta-r">Neto</th><th class="ta-r">Movs</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="cp-key">{{ bankBy()==='mes' ? r.mes : r.banco }}</td>
                  <td class="ta-r mono">{{ r.depositos | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ r.retiros | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono" [class.bad]="r.neto < 0">{{ r.neto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono muted">{{ r.movs | number }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos bancarios importados.</p></div></td></tr></ng-template>
            </p-table>
            <p class="cp-note muted">Resuelve el "17 bancos comparten el 102" de Kepler · {{ b.from_mes }} → {{ b.to_mes }}</p>
          </div>
        }
      }

      <!-- ── EFOS (proveedores en lista negra SAT) ── -->
      @if (view() === 'efos') {
        @if (efos(); as e) {
          <div class="card-premium card-flat cp-verdict" [class.bad]="e.en_69b > 0">
            <i [class]="e.en_69b > 0 ? 'pi pi-exclamation-triangle' : 'pi pi-shield'"></i>
            <div>
              <div class="cp-verdict-h">{{ e.total }} proveedor(es) de la contabilidad en listas del SAT — <b [class.bad]="e.en_69b>0">{{ e.en_69b }} en 69B (EFOS)</b></div>
              <p class="cp-note muted">{{ e.nota }}</p>
            </div>
            <label class="cp-check"><input type="checkbox" [ngModel]="soloEfos()" (ngModelChange)="setSoloEfos($event)"> Solo EFOS (69B)</label>
          </div>
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="e.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="55vh" [paginator]="e.rows.length > 50" [rows]="50">
              <ng-template #header><tr><th class="col-lista">Lista</th><th>RFC</th><th>Proveedor</th><th>Situación SAT</th></tr></ng-template>
              <ng-template #body let-r>
                <tr [class.cp-efos]="r.lista==='69B'">
                  <td><span class="cp-tag" [class.crit]="r.lista==='69B'">{{ r.lista }}</span></td>
                  <td class="mono">{{ r.rfc }}</td>
                  <td>{{ r.nombre }}</td>
                  <td class="muted">{{ r.situacion }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-check-circle"></i><p>Ningún proveedor en listas del SAT.</p></div></td></tr></ng-template>
            </p-table>
          </div>
        }
      }

      <!-- ── LIBROS vs OPERACIÓN ── -->
      @if (view() === 'libros') {
        @if (libros(); as l) {
          <div class="card-premium card-flat cp-verdict">
            <i class="pi pi-chart-line"></i>
            <div>
              <div class="cp-verdict-h">Ingresos {{ l.from_mes }} → {{ l.to_mes }}: operación (Kepler) <b class="mono">{{ l.operacion_kepler_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> vs libros (ContPAQi) <b class="mono">{{ l.libros_contpaqi_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> · ratio <b>{{ l.ratio_pct }}%</b></div>
              <p class="cp-note muted">{{ l.nota }}</p>
            </div>
          </div>
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="l.rows" styleClass="p-datatable-sm" [rowHover]="true">
              <ng-template #header><tr><th>Mes</th><th class="ta-r">Operación (Kepler)</th><th class="ta-r">Libros (ContPAQi)</th><th class="ta-r">Δ</th><th class="ta-r">Ratio</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="mono">{{ r.mes }}</td>
                  <td class="ta-r mono">{{ r.operacion_kepler | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ r.libros_contpaqi | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono muted">{{ r.delta | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ r.ratio_pct }}%</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos para el contraste.</p></div></td></tr></ng-template>
            </p-table>
          </div>
        }
      }

      <!-- ── CFDI vs CONTABILIDAD (materialidad / deducibilidad) ── -->
      @if (view() === 'cfdi') {
        @if (cfdi(); as d) {
          <div class="cp-kpis">
            <div class="cp-kpi">
              <span class="cp-kpi-label">CFDI recibidos</span>
              <span class="cp-kpi-val mono">{{ d.summary.cfdi_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.cfdi_count }} CFDIs · {{ d.summary.proveedores }} proveedores</span>
            </div>
            <div class="cp-kpi" [class.bad]="d.summary.efos_count > 0">
              <span class="cp-kpi-label">EFOS (69B) — no deducible</span>
              <span class="cp-kpi-val mono" [class.bad]="d.summary.efos_count > 0">{{ d.summary.efos_monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.efos_count }} proveedor(es) en lista negra</span>
            </div>
            <div class="cp-kpi" [class.warn]="d.summary.lista69_count > 0">
              <span class="cp-kpi-label">Art. 69 CFF — riesgo</span>
              <span class="cp-kpi-val mono">{{ d.summary.lista69_monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.lista69_count }} incumplido/no localizado</span>
            </div>
            <div class="cp-kpi" [class.warn]="d.summary.no_registrados > 0">
              <span class="cp-kpi-label">Sin registrar en ContPAQi</span>
              <span class="cp-kpi-val mono">{{ d.summary.no_registrados_monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.no_registrados }} proveedor(es) sin alta</span>
            </div>
          </div>

          <div class="card-premium card-flat cp-tablewrap">
            <div class="cp-tabletop">
              <h3 class="cp-h3">Proveedores con CFDI recibido</h3>
              <label class="cp-check"><input type="checkbox" [ngModel]="soloRiesgoCfdi()" (ngModelChange)="setSoloRiesgoCfdi($event)"> Solo riesgo</label>
            </div>
            <p-table [value]="cfdiRows(d)" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="52vh" [paginator]="cfdiRows(d).length > 50" [rows]="50">
              <ng-template #header>
                <tr>
                  <th class="col-riesgo">Riesgo</th><th>RFC</th><th>Proveedor</th>
                  <th class="ta-r">CFDIs</th><th class="ta-r">Total</th>
                  <th class="ta-c">En ContPAQi</th><th>Situación SAT</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [class.cp-efos]="r.riesgo==='efos'">
                  <td>
                    @switch (r.riesgo) {
                      @case ('efos') { <span class="cp-tag crit" title="Proveedor EFOS (69B): CFDI NO deducible">EFOS</span> }
                      @case ('lista69') { <span class="cp-tag warn" title="Art. 69 CFF: incumplido / no localizado">Art.69</span> }
                      @case ('no_registrado') { <span class="cp-tag warn" title="CFDI de proveedor no dado de alta en ContPAQi">Sin alta</span> }
                      @default { <i class="pi pi-check-circle ok" title="Sin riesgo"></i> }
                    }
                  </td>
                  <td class="mono">{{ r.rfc }}</td>
                  <td>{{ r.nombre }}</td>
                  <td class="ta-r mono muted">{{ r.num_cfdis }}</td>
                  <td class="ta-r mono">{{ r.total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-c">
                    @if (r.en_contpaqi) { <i class="pi pi-check ok" title="Registrado como proveedor en ContPAQi"></i> }
                    @else { <i class="pi pi-times bad" title="No está de alta en ContPAQi"></i> }
                  </td>
                  <td class="muted">{{ r.sat_situacion || '—' }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin CFDI recibidos en {{ d.period }}.</p></div></td></tr></ng-template>
            </p-table>
            <p class="cp-note muted"><i class="pi pi-info-circle"></i> Cruza los CFDI recibidos ({{ d.period }}) contra el padrón de proveedores de ContPAQi y la lista negra del SAT. Un CFDI de proveedor <b>EFOS (69B) no es deducible</b> ni acreditable de IVA.</p>
          </div>
        }
      }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); }
    .ok { color: var(--ok-fg); }
    .cp-tablewrap { padding: 0; overflow: hidden; }
    .cp-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .cp-kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); border-left: 3px solid var(--border-color); }
    .cp-kpi.bad { border-left-color: var(--bad-fg); }
    .cp-kpi.warn { border-left-color: var(--warn-fg, #d97706); }
    .cp-kpi-label { font-size: var(--fs-2xs, .7rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    .cp-kpi-val { font-size: var(--fs-lg, 1.15rem); font-weight: 700; color: var(--text-main); }
    .cp-kpi-sub { font-size: var(--fs-xs); }
    .cp-tabletop { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-3) 0; }
    .cp-h3 { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0; }
    .cp-tag.warn { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-fg, #d97706); }
    .col-riesgo { width: 5.5rem; }
    .cp-key { font-weight: 500; color: var(--text-main); }
    .cp-note { font-size: var(--fs-xs); margin: var(--sp-2) var(--sp-3) var(--sp-3); }
    .cp-controls { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
    .cp-controls label { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    :host ::ng-deep .cp-sel.p-select { font-size: var(--fs-sm); }
    .cp-seg { display: flex; gap: 2px; margin: var(--sp-3) 0; padding: 4px; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill); overflow-x: auto; }
    .cp-seg button { display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none; border-radius: var(--r-pill); color: var(--text-muted); font: inherit; font-size: var(--fs-sm); font-weight: 500; padding: var(--sp-1) var(--sp-3); cursor: pointer; white-space: nowrap; transition: background-color 200ms ease, color 200ms ease; }
    .cp-seg button:not(.active):hover { color: var(--text-main); }
    .cp-seg button.active { color: var(--action); background: var(--card-bg); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
    .cp-seg button:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .cp-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); margin-bottom: var(--sp-3); border-left: 3px solid var(--border-color); }
    .cp-verdict.bad { border-left-color: var(--bad-fg); }
    .cp-verdict > i { font-size: 1.4rem; color: var(--text-faint); margin-top: 2px; }
    .cp-verdict.bad > i { color: var(--bad-fg); }
    .cp-verdict-h { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .cp-check { margin-left: auto; display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .cp-tag { display: inline-block; font-size: var(--fs-2xs, .7rem); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    .cp-tag.crit { background: color-mix(in srgb, var(--bad-fg) 15%, transparent); color: var(--bad-fg); }
    .cp-efos > td { background: color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    .cp-skel { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
    .cp-skel-row { height: var(--row-h-md, 40px); border-radius: var(--r-sm); background: var(--hover-bg); animation: cp-pulse 1.4s ease-in-out infinite; }
    @keyframes cp-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .cp-skel-row { animation: none; } }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
    .col-lista { width: 5rem; }
  `],
})
export class ContabilidadContpaqiComponent implements OnInit {
  private readonly api = inject(ContabilidadContpaqiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = CONTABILIDAD_TABS;
  readonly VIEWS: { key: View; label: string; icon: string }[] = [
    { key: 'balanza', label: 'Balanza', icon: 'pi pi-book' },
    { key: 'bancos', label: 'Bancos', icon: 'pi pi-wallet' },
    { key: 'efos', label: 'Proveedores SAT', icon: 'pi pi-shield' },
    { key: 'cfdi', label: 'CFDI vs Contab.', icon: 'pi pi-file-check' },
    { key: 'libros', label: 'Libros vs Operación', icon: 'pi pi-chart-line' },
  ];

  readonly view = signal<View>('balanza');
  readonly loading = signal(false);
  readonly balanza = signal<BalanzaResp | null>(null);
  readonly bank = signal<BankResp | null>(null);
  readonly efos = signal<EfosResp | null>(null);
  readonly libros = signal<LibrosVsOpResp | null>(null);
  readonly cfdi = signal<CfdiVsContabResp | null>(null);
  readonly balanzaBy = signal<BalanzaGroupBy>('familia');
  readonly bankBy = signal<BankGroupBy>('banco');
  readonly soloEfos = signal(false);
  readonly soloRiesgoCfdi = signal(false);
  readonly period = signal<string>(this.currentPeriod());
  readonly periodOpts = this.buildPeriods();

  readonly balanzaGroups = [
    { label: 'Familia', value: 'familia' }, { label: 'Cuenta', value: 'cuenta' },
    { label: 'Mes', value: 'mes' }, { label: 'Agrupador SAT', value: 'agrupador_sat' },
  ];
  readonly bankGroups = [{ label: 'Banco', value: 'banco' }, { label: 'Mes', value: 'mes' }];

  ngOnInit(): void { this.load(); }

  go(v: View): void { if (v === this.view()) return; this.view.set(v); this.load(); }
  setBalanzaBy(v: BalanzaGroupBy): void { this.balanzaBy.set(v); this.load(); }
  setBankBy(v: BankGroupBy): void { this.bankBy.set(v); this.load(); }
  setSoloEfos(v: boolean): void { this.soloEfos.set(v); this.load(); }
  setPeriod(v: string): void { this.period.set(v); this.load(); }
  setSoloRiesgoCfdi(v: boolean): void { this.soloRiesgoCfdi.set(v); }

  cfdiRows(d: CfdiVsContabResp) {
    return this.soloRiesgoCfdi() ? d.rows.filter((r) => r.riesgo !== 'ok') : d.rows;
  }

  private currentPeriod(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  private buildPeriods(): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ label: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`, value: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}` });
    }
    return out;
  }

  private load(): void {
    this.loading.set(true);
    const done = () => this.loading.set(false);
    const v = this.view();
    if (v === 'balanza') {
      this.api.balanza({ group_by: this.balanzaBy() }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.balanza.set(r); done(); }, error: done });
    } else if (v === 'bancos') {
      this.api.bank({ group_by: this.bankBy() }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.bank.set(r); done(); }, error: done });
    } else if (v === 'efos') {
      this.api.efos({ solo_69b: this.soloEfos() }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.efos.set(r); done(); }, error: done });
    } else if (v === 'cfdi') {
      this.api.cfdiVsContab(this.period()).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.cfdi.set(r); done(); }, error: done });
    } else {
      this.api.librosVsOperacion().pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.libros.set(r); done(); }, error: done });
    }
  }
}
