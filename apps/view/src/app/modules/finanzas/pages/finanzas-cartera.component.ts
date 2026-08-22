import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { CarteraService, CarteraResp, CarteraCliente, CarteraDetalle, CarteraFiltros, CarteraResumen, AgingBucket } from '../cartera.service';

/**
 * CXC (ADR-048) — Cartera de clientes / Partidas vivas (Cuentas por Cobrar).
 * Reproduce el `Reporte de partidas vivas` de Kepler: quién debe, cuánto, desde
 * cuándo (aging), por sucursal/cliente/vendedor. Read-only sobre Kepler (kdue).
 * Answer-first Operations: KPIs de saldo/vencido + aging arriba, tabla densa de
 * clientes ordenada por saldo, drill al auxiliar (partidas vivas) por cliente.
 */
@Component({
  selector: 'app-finanzas-cartera',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule, DialogModule, ToggleSwitchModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cartera de clientes</h1>
          <p class="surf-page-sub">Partidas vivas de Cuentas por Cobrar: quién debe, cuánto y desde cuándo. Estado de cuenta read-only de Kepler; el saldo es factura menos cobros y notas.</p>
        </div>
        <div class="ct-head-actions">
          <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="!showResumen()" (click)="toggleResumen()"><span class="p-button-icon p-button-icon-left pi pi-chart-bar" aria-hidden="true"></span><span class="p-button-label">Resumen</span></button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="ct-filters">
        <p-select [options]="sucursales" [(ngModel)]="sucursal" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Sucursal" styleClass="ct-sel" ariaLabel="Sucursal" />
        <p-select [options]="grupoOpts()" [(ngModel)]="grupo" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Grupo" [showClear]="true" styleClass="ct-sel" ariaLabel="Grupo" />
        <p-select [options]="zonaOpts()" [(ngModel)]="zona" (onChange)="load()" optionLabel="label" optionValue="value" placeholder="Zona" [showClear]="true" styleClass="ct-sel" ariaLabel="Zona" />
        <span class="p-input-icon-left ct-search">
          <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Cliente, código o RFC…" aria-label="Buscar cliente" />
        </span>
        <label class="ct-toggle"><p-toggleswitch [(ngModel)]="incluirSaldados" (onChange)="load()" /> <span>Incluir saldados</span></label>
        @if (data(); as d) { <span class="ct-hoy muted">saldos al {{ d.hoy }}</span> }
      </div>

      @if (error()) { <div class="ct-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo cargar la cartera. {{ error() }}</div> }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de cartera" />

        @if (showResumen() && resumen(); as rs) {
          <section class="card-premium card-flat ct-resumen">
            <h3 class="ct-card-title"><i class="pi pi-chart-bar" aria-hidden="true"></i> Resumen gerencial <span class="muted">lo que el reporte de Kepler no da</span></h3>
            <div class="ct-rs-kpis">
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ rs.dso ?? '—' }}</span><span class="ct-rs-lbl">DSO (días cartera)</span></div>
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ rs.pct_vencido }}%</span><span class="ct-rs-lbl">del saldo vencido</span></div>
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ rs.concentracion.top10_pct }}%</span><span class="ct-rs-lbl">en top-10 clientes</span></div>
              <div class="ct-rs-kpi"><span class="ct-rs-num">{{ money(rs.ventas_90d) }}</span><span class="ct-rs-lbl">ventas 90d (base DSO)</span></div>
            </div>
            <div class="ct-rs-grid">
              <div>
                <h4 class="ct-rs-h4">Cartera por vendedor</h4>
                <table class="ct-rs-table"><thead><tr><th>Vendedor</th><th class="ta-r">Clientes</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th></tr></thead>
                  <tbody>@for (v of rs.por_vendedor.slice(0, 10); track v.vendedor) {
                    <tr><td>{{ v.vendedor }}</td><td class="ta-r">{{ v.n_clientes }}</td><td class="ta-r" [class.ct-venc-num]="v.vencido > 0">{{ v.vencido | number:'1.0-0' }}</td><td class="ta-r"><b>{{ v.saldo | number:'1.0-0' }}</b></td></tr>
                  }</tbody></table>
              </div>
              <div>
                <h4 class="ct-rs-h4">Cartera por zona</h4>
                <table class="ct-rs-table"><thead><tr><th>Zona</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th></tr></thead>
                  <tbody>@for (z of rs.por_zona; track z.zona) {
                    <tr><td>{{ z.zona }}</td><td class="ta-r" [class.ct-venc-num]="z.vencido > 0">{{ z.vencido | number:'1.0-0' }}</td><td class="ta-r"><b>{{ z.saldo | number:'1.0-0' }}</b></td></tr>
                  }</tbody></table>
              </div>
            </div>
          </section>
        }

        <section class="card-premium card-flat ct-aging">
          <h3 class="ct-card-title"><i class="pi pi-hourglass" aria-hidden="true"></i> Antigüedad de saldos</h3>
          <div class="ct-aging-bar" role="img" [attr.aria-label]="'Aging total ' + money(d.kpi.total_saldo)">
            @for (b of agingSegs(d.kpi.aging); track b.key) {
              @if (b.val > 0) { <span class="ct-seg" [class]="'ct-seg-' + b.key" [style.flex]="b.val" [title]="b.label + ': ' + money(b.val)"></span> }
            }
          </div>
          <ul class="ct-aging-legend">
            @for (b of agingSegs(d.kpi.aging); track b.key) {
              <li><span class="ct-dot" [class]="'ct-seg-' + b.key"></span>{{ b.label }} <b>{{ money(b.val) }}</b></li>
            }
          </ul>
        </section>

        <section class="card-premium card-flat ct-tablewrap">
          <table class="ct-table">
            <thead>
              <tr>
                <th>Cliente</th><th>Suc</th><th>Zona</th><th>Vend</th><th class="ta-r">Partidas</th>
                <th class="ta-r">Línea</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (c of d.clientes; track c.sucursal + c.cliente_code) {
                <tr (click)="openDetalle(c)" class="ct-row" [class.ct-row-venc]="c.vencido > 0">
                  <td><b>{{ c.cliente_nombre }}</b> <span class="muted">{{ c.cliente_code }}</span></td>
                  <td>{{ c.sucursal }}</td>
                  <td>{{ c.zona || '—' }}</td>
                  <td>{{ c.vendedor || '—' }}</td>
                  <td class="ta-r">{{ c.n_partidas }}</td>
                  <td class="ta-r">
                    @if (c.uso_linea != null) { <span [class.ct-sobre]="c.sobre_linea" [title]="'Límite ' + money(c.limite_credito || 0)">{{ c.uso_linea }}%</span> } @else { <span class="muted">—</span> }
                    @if (c.sobre_linea) { <i class="pi pi-exclamation-triangle ct-sobre" title="Sobre su línea de crédito" aria-hidden="true"></i> }
                  </td>
                  <td class="ta-r" [class.ct-venc-num]="c.vencido > 0">{{ c.vencido | number:'1.2-2' }}</td>
                  <td class="ta-r"><b>{{ c.saldo | number:'1.2-2' }}</b></td>
                  <td class="ta-r"><i class="pi pi-angle-right muted" aria-hidden="true"></i></td>
                </tr>
              } @empty {
                <tr><td colspan="10" class="ct-empty">Sin cartera para el filtro. Ajustá sucursal o búsqueda.</td></tr>
              }
            </tbody>
          </table>
          @if (d.total_clientes > d.clientes.length) {
            <p class="ct-more muted">Mostrando {{ d.clientes.length }} de {{ d.total_clientes }} clientes. Afiná el filtro para ver el resto.</p>
          }
        </section>
      }
    </div>

    <p-dialog [visible]="!!detalle()" (visibleChange)="!$event && closeDetalle()" [modal]="true" [dismissableMask]="true" [style]="{ width: '820px', maxWidth: '96vw' }" [header]="detalle()?.cliente?.cliente_nombre || 'Auxiliar del cliente'">
      @if (detalle(); as det) {
        <div class="ct-det-head">
          <div>
            <span class="muted">Código</span> {{ det.cliente.cliente_code }} · <span class="muted">Suc</span> {{ det.cliente.sucursal }} @if (det.cliente.rfc) { · <span class="muted">RFC</span> {{ det.cliente.rfc }} }
            @if (det.cliente.limite_credito) { · <span class="muted">Límite</span> {{ money(det.cliente.limite_credito) }} @if (det.saldo > det.cliente.limite_credito) { <span class="ct-sobre">(sobre línea)</span> } }
            @if (det.cliente.dias_credito) { · <span class="muted">{{ det.cliente.dias_credito }}d crédito</span> }
          </div>
          <div class="ct-det-saldos">
            <span>Saldo <b>{{ money(det.saldo) }}</b></span>
            @if (det.vencido > 0) { <span class="ct-venc-num">Vencido <b>{{ money(det.vencido) }}</b></span> }
            @if (det.pagadas > 0) { <span class="muted">{{ det.pagadas }} saldadas</span> }
          </div>
          @if (det.cliente.telefono) {
            <div class="ct-det-contact">
              <a [href]="'tel:' + det.cliente.telefono" class="ct-contact-btn"><i class="pi pi-phone" aria-hidden="true"></i> {{ det.cliente.telefono }}</a>
              <a [href]="waLink(det)" target="_blank" rel="noopener" class="ct-contact-btn ct-wa"><i class="pi pi-whatsapp" aria-hidden="true"></i> Recordar por WhatsApp</a>
            </div>
          }
        </div>
        <table class="ct-det-table">
          <thead><tr><th>Documento</th><th>Folio</th><th>Fecha</th><th>Vence</th><th class="ta-r">Importe</th><th class="ta-r">Saldo</th><th>Días</th></tr></thead>
          <tbody>
            @for (p of det.partidas; track p.folio_digital) {
              <tr [class.ct-row-venc]="p.vencida">
                <td>{{ p.doc_label }}</td>
                <td class="ct-mono">{{ p.folio_digital }}</td>
                <td>{{ p.fecha }}</td>
                <td>{{ p.vencimiento || '—' }}</td>
                <td class="ta-r">{{ p.importe | number:'1.2-2' }}</td>
                <td class="ta-r"><b>{{ p.saldo_documento | number:'1.2-2' }}</b></td>
                <td>@if (p.vencida) { <span class="ct-tag-venc">{{ p.dias_vencido }}d</span> } @else { <span class="muted">al día</span> }</td>
              </tr>
              @for (a of p.aplicaciones; track a.folio) {
                <tr class="ct-app"><td class="ct-app-cell" colspan="7"><i class="pi pi-arrow-turn-down-right" aria-hidden="true"></i> {{ a.label }} {{ a.folio }} · {{ a.fecha || '—' }} <b>−{{ a.monto | number:'1.2-2' }}</b></td></tr>
              }
            } @empty { <tr><td colspan="7" class="ct-empty">Sin partidas vivas. Todo cobrado.</td></tr> }
          </tbody>
        </table>
        @if (det.abonos.length) {
          <details class="ct-abonos"><summary>{{ det.abonos.length }} cobros / notas aplicados</summary>
            <ul>@for (a of det.abonos; track a.folio) { <li>{{ a.doc_label }} {{ a.folio }} · {{ a.fecha }} <b>{{ money(a.importe) }}</b></li> }</ul>
          </details>
        }
        <p class="ct-det-note muted">Saldo por documento exacto: cada factura muestra los cobros y notas que Kepler le aplicó (kdm5). Espejo read-only del ERP.</p>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ct-filters { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: .75rem 0 1rem; }
    .ct-search input { min-width: 240px; }
    .ct-toggle { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; }
    .ct-hoy { margin-left: auto; font-size: .8rem; }
    .ct-error { color: var(--danger, #b42318); display: flex; gap: .5rem; align-items: center; padding: .75rem 0; }
    .ct-card-title { display: flex; align-items: center; gap: .5rem; font-size: .95rem; margin: 0 0 .6rem; }
    .ct-aging { padding: 1rem; margin-bottom: 1rem; }
    .ct-aging-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--surface-2, #f0efec); }
    .ct-seg { display: block; }
    .ct-seg-por_vencer { background: #6b8f71; } .ct-seg-d0_30 { background: #c9a227; }
    .ct-seg-d31_60 { background: #d98324; } .ct-seg-d61_90 { background: #c2410c; } .ct-seg-d90_plus { background: #b42318; }
    .ct-aging-legend { list-style: none; display: flex; flex-wrap: wrap; gap: 1rem; margin: .7rem 0 0; padding: 0; font-size: .82rem; }
    .ct-aging-legend li { display: flex; align-items: center; gap: .35rem; }
    .ct-aging-legend b { margin-left: .2rem; }
    .ct-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .ct-tablewrap { padding: 0; overflow-x: auto; }
    .ct-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    .ct-table th, .ct-table td { padding: .5rem .7rem; text-align: left; border-bottom: 1px solid var(--surface-border, #e7e5e0); white-space: nowrap; }
    .ct-table th { font-weight: 600; color: var(--text-2, #6b6b6b); position: sticky; top: 0; background: var(--surface-0, #fff); }
    .ct-row { cursor: pointer; } .ct-row:hover { background: var(--surface-hover, #faf9f7); }
    .ct-row-venc { background: rgba(180,35,24,.04); }
    .ct-venc-num { color: #b42318; }
    .ta-r { text-align: right !important; }
    .muted { color: var(--text-2, #8a8a8a); font-weight: 400; }
    .ct-empty { text-align: center; color: var(--text-2, #8a8a8a); padding: 1.5rem !important; }
    .ct-more { padding: .6rem .7rem; margin: 0; font-size: .8rem; }
    .ct-det-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; font-size: .85rem; margin-bottom: .8rem; }
    .ct-det-saldos { display: flex; gap: 1rem; }
    .ct-det-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .ct-det-table th, .ct-det-table td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid var(--surface-border, #eee); white-space: nowrap; }
    .ct-det-table th { color: var(--text-2, #6b6b6b); font-weight: 600; }
    .ct-mono { font-family: ui-monospace, monospace; font-size: .78rem; }
    .ct-tag-venc { background: rgba(180,35,24,.1); color: #b42318; border-radius: 4px; padding: .1rem .4rem; font-size: .75rem; font-weight: 600; }
    .ct-app td { border-bottom: none; padding-top: .1rem; padding-bottom: .1rem; }
    .ct-app-cell { padding-left: 1.6rem !important; font-size: .78rem; color: #6b8f71; }
    .ct-app-cell i { font-size: .7rem; opacity: .6; }
    .ct-app-cell b { color: var(--text-2, #6b6b6b); }
    .ct-abonos { margin-top: .8rem; font-size: .82rem; } .ct-abonos ul { margin: .4rem 0 0; padding-left: 1.1rem; }
    .ct-det-note { font-size: .78rem; margin-top: .8rem; }
    .ct-head-actions { display: flex; gap: .5rem; }
    .ct-sobre { color: #b42318; font-weight: 600; }
    .ct-resumen { padding: 1rem; margin-bottom: 1rem; }
    .ct-rs-kpis { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: .3rem 0 1rem; }
    .ct-rs-kpi { display: flex; flex-direction: column; }
    .ct-rs-num { font-size: 1.4rem; font-weight: 700; line-height: 1.1; }
    .ct-rs-lbl { font-size: .76rem; color: var(--text-2, #8a8a8a); }
    .ct-rs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 720px) { .ct-rs-grid { grid-template-columns: 1fr; } }
    .ct-rs-h4 { font-size: .82rem; margin: 0 0 .4rem; color: var(--text-2, #6b6b6b); }
    .ct-rs-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .ct-rs-table th, .ct-rs-table td { padding: .3rem .5rem; border-bottom: 1px solid var(--surface-border, #eee); text-align: left; }
    .ct-rs-table th { color: var(--text-2, #8a8a8a); font-weight: 600; }
    .ct-det-contact { display: flex; gap: .6rem; flex-basis: 100%; margin-top: .5rem; }
    .ct-contact-btn { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; text-decoration: none; padding: .3rem .7rem; border-radius: 6px; border: 1px solid var(--surface-border, #ddd); color: inherit; }
    .ct-contact-btn:hover { background: var(--surface-hover, #faf9f7); }
    .ct-wa { color: #128c7e; border-color: rgba(18,140,126,.3); }
  `],
})
export class FinanzasCarteraComponent implements OnInit {
  private readonly svc = inject(CarteraService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<CarteraResp | null>(null);
  readonly detalle = signal<CarteraDetalle | null>(null);

  sucursal: string | null = '01';
  grupo: string | null = null;
  zona: string | null = null;
  search = '';
  incluirSaldados = false;

  readonly filtros = signal<CarteraFiltros | null>(null);
  readonly grupoOpts = computed(() => (this.filtros()?.grupos || []).map((g) => ({ label: g, value: g })));
  readonly zonaOpts = computed(() => (this.filtros()?.zonas || []).map((z) => ({ label: z, value: z })));
  readonly resumen = signal<CarteraResumen | null>(null);
  readonly showResumen = signal(false);

  readonly sucursales = [
    { label: 'Todas', value: null },
    { label: '01 · Padre Hidalgo', value: '01' },
    { label: '02 · La Piedad Abastos', value: '02' },
    { label: '03 · 8 Esquinas', value: '03' },
    { label: '04 · Yurécuaro', value: '04' },
    { label: '05 · Zamora Centro', value: '05' },
    { label: '06 · Canindo', value: '06' },
  ];

  ngOnInit() {
    this.svc.filtros().subscribe({ next: (f) => this.filtros.set(f), error: () => {} });
    this.load();
  }

  load() {
    this.loading.set(true); this.error.set(null);
    this.svc.cartera({
      sucursal: this.sucursal || undefined,
      grupo: this.grupo || undefined,
      zona: this.zona || undefined,
      search: this.search.trim() || undefined,
      incluir_saldados: this.incluirSaldados ? '1' : undefined,
    }).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'error'); this.loading.set(false); },
    });
    if (this.showResumen()) this.loadResumen();
  }

  toggleResumen() {
    const next = !this.showResumen();
    this.showResumen.set(next);
    if (next) this.loadResumen();
  }
  loadResumen() {
    this.svc.resumen({ sucursal: this.sucursal || undefined, grupo: this.grupo || undefined, zona: this.zona || undefined })
      .subscribe({ next: (r) => this.resumen.set(r), error: () => this.resumen.set(null) });
  }

  /** Recordatorio de pago prellenado por WhatsApp (el operador lo revisa antes de enviar). */
  waLink(det: CarteraDetalle): string {
    const tel = (det.cliente.telefono || '').replace(/\D/g, '');
    const num = tel.length === 10 ? `52${tel}` : tel;
    const msg = `Hola ${det.cliente.cliente_nombre}, le recordamos su saldo pendiente con Mega Dulces de ${this.money(det.saldo)}` +
      (det.vencido > 0 ? ` (${this.money(det.vencido)} vencido)` : '') + '. ¡Gracias!';
    return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  }

  openDetalle(c: CarteraCliente) {
    this.detalle.set(null);
    this.svc.detalle(c.sucursal, c.cliente_code).subscribe({
      next: (d) => this.detalle.set(d),
      error: () => this.detalle.set(null),
    });
  }
  closeDetalle() { this.detalle.set(null); }

  money(v: number) { return (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' }); }

  kpiItems(d: CarteraResp): MetricStripItem[] {
    return [
      { label: 'Saldo total', value: this.money(d.kpi.total_saldo) },
      { label: 'Vencido', value: this.money(d.kpi.total_vencido), tone: d.kpi.total_vencido > 0 ? 'warn' : undefined },
      { label: 'Clientes con saldo', value: String(d.kpi.n_clientes) },
      { label: 'Sobre su línea', value: String(d.kpi.n_sobre_linea), tone: d.kpi.n_sobre_linea > 0 ? 'bad' : undefined },
      { label: 'Partidas vivas', value: String(d.kpi.n_partidas) },
    ];
  }

  agingSegs(a: AgingBucket) {
    return [
      { key: 'por_vencer', label: 'Por vencer', val: a.por_vencer },
      { key: 'd0_30', label: '1–30 días', val: a.d0_30 },
      { key: 'd31_60', label: '31–60 días', val: a.d31_60 },
      { key: 'd61_90', label: '61–90 días', val: a.d61_90 },
      { key: 'd90_plus', label: '90+ días', val: a.d90_plus },
    ];
  }
}
