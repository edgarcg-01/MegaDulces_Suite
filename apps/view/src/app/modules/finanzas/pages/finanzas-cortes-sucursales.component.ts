import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TagModule } from 'primeng/tag';
import type {
  CorteCuadre, CorteEstadoCobro, CorteRow, CorteSucursalResumen, CortesSucursalesResponse,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

const COBRO: Record<CorteEstadoCobro, { label: string; sev: Sev }> = {
  sin_cobro: { label: 'Sin cobro', sev: 'secondary' },
  parcial: { label: 'Cobro parcial', sev: 'warn' },
  cobrado: { label: 'Cobrado', sev: 'success' },
  sobrecobrado: { label: 'Cobrado de más', sev: 'danger' },
};
const CUADRE: Record<CorteCuadre, { label: string; sev: Sev }> = {
  cuadra: { label: 'Cuadra', sev: 'success' },
  faltante_arqueo: { label: 'Faltante en arqueo', sev: 'danger' },
  sobrante_arqueo: { label: 'Sobrante en arqueo', sev: 'warn' },
  corte_distinto: { label: 'Corte distinto', sev: 'warn' },
  sin_arqueo: { label: 'Sin arqueo', sev: 'info' },
};

/** El corte de caja POS (U-D-23) arrancó en Kepler con el cambio del 1-oct-2026. */
const INICIO_CORTES = '2026-10-01';

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * `[CSU.2]` Cortes/Sucursales — el dinero de mostrador por turno de caja.
 *
 * Corte de caja POS (Kepler `U-D-23`, cliente CONTADO) → cobros aplicados (`U-A-5`) → arqueo del
 * turno. Responde "¿cuánto vendió cada caja, cuánto ya se cobró y qué falta?". Sólo lectura: el
 * cobro se captura en Kepler. El paso al banco (y el tramo del efectivo por Caja Fuerte) es la
 * entrega 2 y se DECLARA en el detalle, no se dibuja como pendiente.
 */
@Component({
  selector: 'app-finanzas-cortes-sucursales',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, DatePickerModule, ToggleSwitchModule, TagModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cortes / Sucursales</h1>
          <p class="surf-page-sub">Lo que vendió cada caja (corte de caja POS, cliente <b>CONTADO</b>), cuánto ya se cobró en Kepler y cuánto sigue pendiente. Se cuadra contra el arqueo del mismo turno.</p>
        </div>
        <div class="cs-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cs-filters">
        <div class="cs-field"><label for="cs-mes">Mes</label>
          <p-select inputId="cs-mes" [options]="mesOpts" optionLabel="label" optionValue="value" [ngModel]="mes()" (onChange)="pickMes($event.value)" placeholder="Rango" appendTo="body" class="cs-sel" /></div>
        <div class="cs-field"><label for="cs-rango">Rango específico</label>
          <p-datepicker inputId="cs-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Elegir fechas" (onClose)="onRange()" /></div>
        <div class="cs-field cs-toggle"><label for="cs-saldo">Sólo con saldo</label>
          <p-toggleswitch inputId="cs-saldo" [ngModel]="soloSaldo()" (ngModelChange)="soloSaldo.set($event)" /></div>
      </div>

      @if (err(); as e) { <div class="cs-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="cs-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <p class="cs-periodo">Periodo {{ dmy(d.periodo.from) }} – {{ dmy(d.periodo.to) }}@if (d.ultimo_corte) { · último corte {{ dmy(d.ultimo_corte) }} }@if (d.cortes_en_blanco) { · {{ d.cortes_en_blanco }} corte(s) en blanco (menos de $1) no se listan }</p>
        @if (antesDeCortes(d)) {
          <div class="cs-note" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i><span>El corte de caja POS en Kepler arrancó el <b>01/10/2026</b>. Antes de esa fecha casi no hay cortes; un periodo anterior se ve vacío por eso, no porque no haya habido venta.</span></div>
        }

        <app-metric-strip [items]="kpis(d)" ariaLabel="Resumen de cortes del periodo" />

        <section class="cs-block dt-scope" aria-labelledby="cs-h-suc">
          <div class="cs-bh"><h2 id="cs-h-suc">Por sucursal</h2>
            <span class="cs-hint">@if (selSuc(); as s) { Viendo {{ s.sucursal }} {{ s.sucursal_nombre }} · <button type="button" class="cs-link" (click)="pickSuc(null)">ver todas</button> } @else { Elige una sucursal para ver sus cortes }</span></div>
          <p-table [value]="d.sucursales" size="small" class="surf-table dt-stack" [rowHover]="true" selectionMode="single" [selection]="selSuc()" (selectionChange)="pickSuc($event)" dataKey="sucursal">
            <ng-template #header><tr><th>Sucursal</th><th class="ta-r">Cortes</th><th class="ta-r">Vendido</th><th class="ta-r">Cobrado</th><th class="ta-r">Pendiente</th><th class="ta-r">% cobrado</th><th>Abierto desde</th><th>Revisar</th></tr></ng-template>
            <ng-template #body let-s>
              <tr [pSelectableRow]="s">
                <td role="cell" data-label="Sucursal"><span class="cs-mono muted">{{ s.sucursal }}</span> {{ s.sucursal_nombre }}</td>
                <td class="ta-r num" role="cell" data-label="Cortes">{{ s.cortes }}</td>
                <td class="ta-r num" role="cell" data-label="Vendido">{{ money(s.vendido) }}</td>
                <td class="ta-r num" role="cell" data-label="Cobrado" [class.muted]="!s.cobrado">{{ s.cobrado ? money(s.cobrado) : '—' }}</td>
                <td class="ta-r num cs-strong" role="cell" data-label="Pendiente">{{ money(s.pendiente) }}</td>
                <td class="ta-r num" role="cell" data-label="% cobrado">{{ pct(s.cobrado, s.vendido) }}</td>
                <td role="cell" data-label="Abierto desde">@if (s.abierto_desde) { {{ dmy(s.abierto_desde) }} <span class="muted">· {{ dias(s.abierto_desde) }} d</span> } @else { <span class="muted">—</span> }</td>
                <td role="cell" data-label="Revisar">
                  @if (s.con_diferencia) { <p-tag [value]="s.con_diferencia + ' con diferencia'" severity="warn" styleClass="cs-tag" /> }
                  @if (s.sin_arqueo) { <p-tag [value]="s.sin_arqueo + ' sin arqueo'" severity="info" styleClass="cs-tag" /> }
                  @if (!s.con_diferencia && !s.sin_arqueo) { <span class="muted">—</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="cs-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin cortes de caja en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        </section>

        <div class="cs-split">
          <section class="cs-block dt-scope" aria-labelledby="cs-h-cortes">
            <div class="cs-bh"><h2 id="cs-h-cortes">Cortes @if (selSuc(); as s) { · {{ s.sucursal_nombre }} }</h2><span class="cs-hint">{{ cortes().length }} corte(s) · pendiente {{ money(pendienteVisible()) }}</span></div>
            <p-table [value]="cortes()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" selectionMode="single" [selection]="selCorte()" (selectionChange)="selCorte.set($event)" dataKey="clave" [paginator]="cortes().length > 200" [rows]="200">
              <ng-template #header><tr><th>Corte</th><th>Fecha</th>@if (!selSuc()) { <th>Suc</th> }<th>Caja</th><th class="ta-r">Monto</th><th class="ta-r">Cobrado</th><th class="ta-r">Saldo</th><th>Cobro</th><th>Cuadre</th></tr></ng-template>
              <ng-template #body let-c>
                <tr [pSelectableRow]="c">
                  <td class="cs-mono" role="cell" data-label="Corte">{{ c.documento }}</td>
                  <td class="cs-mono" role="cell" data-label="Fecha">{{ dmy(c.fecha) }}</td>
                  @if (!selSuc()) { <td class="cs-mono muted" role="cell" data-label="Suc">{{ c.sucursal }}</td> }
                  <td class="cs-mono" role="cell" data-label="Caja">{{ c.caja && c.turno ? c.caja + '-' + c.turno : c.referencia }}</td>
                  <td class="ta-r num" role="cell" data-label="Monto">{{ money(c.monto) }}</td>
                  <td class="ta-r num" role="cell" data-label="Cobrado" [class.muted]="!c.cobrado">{{ c.cobrado ? money(c.cobrado) : '—' }}</td>
                  <td class="ta-r num cs-strong" role="cell" data-label="Saldo">{{ money(c.saldo) }}</td>
                  <td role="cell" data-label="Cobro"><p-tag [value]="cobroLabel(c.estado_cobro)" [severity]="cobroSev(c.estado_cobro)" styleClass="cs-tag" /></td>
                  <td role="cell" data-label="Cuadre"><p-tag [value]="cuadreLabel(c)" [severity]="cuadreSev(c.cuadre)" styleClass="cs-tag" /></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td [attr.colspan]="selSuc() ? 8 : 9"><div class="cs-empty"><i class="pi pi-check-circle" aria-hidden="true"></i><span>{{ soloSaldo() ? 'Ningún corte con saldo pendiente.' : 'Sin cortes en el periodo.' }}</span></div></td></tr></ng-template>
            </p-table>
          </section>

          <section class="cs-block cs-detail" aria-labelledby="cs-h-det" aria-live="polite">
            @if (selCorte(); as c) {
              <div class="cs-bh"><h2 id="cs-h-det">{{ c.documento }} · {{ c.referencia }}</h2><p-tag [value]="cobroLabel(c.estado_cobro)" [severity]="cobroSev(c.estado_cobro)" styleClass="cs-tag" /></div>
              <p class="cs-hint cs-pad">{{ c.sucursal }} {{ c.sucursal_nombre }} · {{ dmy(c.fecha) }}@if (c.arqueo?.cajero) { · cerró {{ c.arqueo?.cajero }} }</p>

              <div class="cs-step">
                <h3><span class="cs-n">1</span> Corte contra el arqueo del turno</h3>
                @if (c.arqueo; as a) {
                  <table class="cs-mini">
                    <thead><tr><th></th><th class="ta-r">Esperado</th><th class="ta-r">Contado</th></tr></thead>
                    <tbody>
                      <tr><td>Efectivo</td><td class="ta-r num">{{ money(a.efectivo_esperado) }}</td><td class="ta-r num" [class.cs-bad]="a.efectivo_contado < a.efectivo_esperado - 1">{{ money(a.efectivo_contado) }}</td></tr>
                      <tr><td>Tarjeta</td><td class="ta-r num">{{ money(a.tarjeta_esperado) }}</td><td class="ta-r num">{{ money(a.tarjeta_contado) }}</td></tr>
                      <tr><td>Transferencia</td><td class="ta-r num">{{ money(a.transfer_esperado) }}</td><td class="ta-r num">{{ money(a.transfer_contado) }}</td></tr>
                      <tr class="cs-tot"><td>Total</td><td class="ta-r num">{{ money(a.esperado_total) }}</td><td class="ta-r num">{{ money(a.contado_total) }}</td></tr>
                    </tbody>
                  </table>
                  <div class="cs-row"><span>Monto del corte en Kepler</span><span class="num cs-strong">{{ money(c.monto) }}</span></div>
                  <div class="cs-row"><span>{{ cuadreLabel(c) }}</span><span class="num" [class.cs-bad]="c.cuadre !== 'cuadra'">{{ c.diferencia === null ? '—' : money(c.diferencia) }}</span></div>
                } @else {
                  <p class="cs-hint">No se encontró el arqueo del turno {{ c.referencia }}. El cuadre queda <b>sin medir</b>; no es lo mismo que cuadrar.</p>
                }
              </div>

              <div class="cs-step">
                <h3><span class="cs-n">2</span> Cobros aplicados en Kepler</h3>
                @for (b of c.cobros; track b.doc_prefix + b.folio) {
                  <div class="cs-row"><span>{{ b.doc_prefix }}-{{ b.folio }} · {{ b.forma_pago || 'sin forma' }}@if (b.fecha) { · {{ dmy(b.fecha) }} }@if (b.concepto) { <span class="muted"> · {{ b.concepto }}</span> }</span><span class="num">{{ money(b.monto) }}</span></div>
                } @empty {
                  <p class="cs-hint">Ningún cobro aplicado a este corte.</p>
                }
                <div class="cs-row cs-tot"><span>Saldo del corte</span><span class="num" [class.cs-bad]="c.saldo > 0.005">{{ money(c.saldo) }}</span></div>
              </div>

              <div class="cs-step">
                <h3><span class="cs-n">3</span> Llegó a la empresa</h3>
                <p class="cs-hint">Entrega 2: aquí se verá el abono en el estado de cuenta (tarjeta y transferencia) y el paso del efectivo por Caja Fuerte y Caja General hasta su depósito. Hoy <b>no se mide</b>.</p>
              </div>
            } @else {
              <div class="cs-empty cs-pad"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Elige un corte para ver su arqueo y sus cobros.</span></div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cs-actions { display:flex; gap:.5rem; align-items:center; }
    .cs-filters { display:flex; flex-wrap:wrap; gap:.8rem; align-items:flex-end; margin:.4rem 0 .6rem; }
    .cs-field { display:flex; flex-direction:column; gap:.25rem; }
    .cs-field label { font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); }
    :host ::ng-deep .cs-sel { min-width:11rem; }
    .cs-toggle { align-items:flex-start; }
    .cs-periodo { margin:.2rem 0 .4rem; font-size:.78rem; color:var(--text-muted); }
    .cs-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:.82rem; }
    .cs-note .pi { color:var(--text-muted); margin-top:.15rem; }
    app-metric-strip { display:block; margin:.6rem 0; }
    .cs-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; margin-bottom:1rem; }
    .cs-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .cs-bh h2 { font-size:.95rem; font-weight:700; margin:0; }
    .cs-hint { font-size:.76rem; color:var(--text-muted); margin:0; }
    .cs-pad { padding:.5rem .85rem 0; }
    .cs-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .cs-split { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:1rem; align-items:start; }
    @media (max-width:1100px) { .cs-split { grid-template-columns:minmax(0,1fr); } }
    .cs-detail { position:sticky; top:.5rem; }
    .cs-step { padding:.7rem .85rem; border-top:1px solid var(--border-color); }
    .cs-step:first-of-type { border-top:0; }
    .cs-step h3 { display:flex; align-items:center; gap:.45rem; font-size:.82rem; font-weight:700; margin:0 0 .45rem; }
    .cs-n { display:inline-grid; place-items:center; width:1.3rem; height:1.3rem; border-radius:50%; background:var(--hover-bg); font-size:.7rem; }
    .cs-row { display:flex; justify-content:space-between; gap:.8rem; font-size:.8rem; padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .cs-row span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .cs-tot { font-weight:600; border-bottom:0; }
    .cs-mini { width:100%; border-collapse:collapse; font-size:.8rem; margin-bottom:.4rem; }
    .cs-mini th { font-size:.66rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; padding:.2rem 0; text-align:left; }
    .cs-mini td { padding:.2rem 0; border-bottom:1px dashed var(--border-color); }
    .cs-mini tr.cs-tot td { border-bottom:0; }
    .ta-r { text-align:right !important; }
    .num, .cs-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cs-strong { font-weight:600; }
    .cs-bad { color:var(--bad-fg); }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .cs-tag { font-size:.64rem; margin-right:.25rem; }
    .cs-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cs-errbox .pi { color:var(--bad-fg); } .cs-errbox-txt { flex:1; font-size:.84rem; }
    .cs-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .cs-empty .pi { font-size:1.3rem; }
  `],
})
export class FinanzasCortesSucursalesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/cortes-sucursales`;

  readonly skel = Array.from({ length: 8 });
  readonly money = money;
  readonly dmy = dmy;

  /** Los 12 meses hasta el actual; el default es el mes en curso. */
  readonly mesOpts: { label: string; value: string }[] = (() => {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ label: `${MESES[x.getMonth()]} ${x.getFullYear()}`, value: `${x.getFullYear()}-${pad(x.getMonth() + 1)}` });
    }
    return out;
  })();

  readonly mes = signal<string | null>(this.mesOpts[0].value);
  rangeDates: Date[] | null = null;
  readonly soloSaldo = signal(false);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<CortesSucursalesResponse | null>(null);
  readonly selSuc = signal<CorteSucursalResumen | null>(null);
  readonly selCorte = signal<CorteRow | null>(null);

  readonly cortes = computed<CorteRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    const s = this.selSuc();
    return d.cortes.filter((c) => (!s || c.sucursal === s.sucursal) && (!this.soloSaldo() || c.saldo > 0.005));
  });
  readonly pendienteVisible = computed(() => this.cortes().reduce((t, c) => t + Math.max(c.saldo, 0), 0));

  ngOnInit(): void { this.reload(); }

  pickMes(v: string | null): void {
    if (!v) return;
    this.mes.set(v);
    this.rangeDates = null;
    this.reload();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: no se consulta todavía
    this.mes.set(null);
    this.reload();
  }

  pickSuc(s: CorteSucursalResumen | null): void {
    this.selSuc.set(s);
    const c = this.selCorte();
    if (s && c && c.sucursal !== s.sucursal) this.selCorte.set(null);
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    const p = new URLSearchParams();
    const [a, b] = this.rangeDates || [];
    if (!this.mes() && a && b) { p.set('from', iso(a)); p.set('to', iso(b)); }
    else if (this.mes()) p.set('month', this.mes() as string);
    this.http.get<CortesSucursalesResponse>(`${this.base}?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        const s = this.selSuc();
        this.selSuc.set(s ? d.sucursales.find((x) => x.sucursal === s.sucursal) ?? null : null);
        const c = this.selCorte();
        this.selCorte.set(c ? d.cortes.find((x) => x.clave === c.clave) ?? null : null);
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los cortes.'); },
    });
  }

  kpis(d: CortesSucursalesResponse): MetricStripItem[] {
    const t = d.totales;
    return [
      { label: 'Vendido en cortes', value: t.vendido, format: 'currency2', tone: 'default', sub: `${t.cortes} cortes · ${d.sucursales.length} sucursales` },
      { label: 'Cobrado en Kepler', value: t.cobrado, format: 'currency2', tone: 'ok', sub: `${this.pct(t.cobrado, t.vendido)} de lo vendido` },
      { label: 'Pendiente de cobro', value: t.pendiente, format: 'currency2', tone: t.pendiente > 0.005 ? 'bad' : 'ok', sub: `${t.sin_cobro} cortes sin ningún cobro` },
      { label: 'Corte vs arqueo', value: t.con_diferencia, format: 'number', tone: t.con_diferencia ? 'warn' : 'ok', sub: t.sin_arqueo ? `con diferencia · ${t.sin_arqueo} sin arqueo` : 'con diferencia' },
    ];
  }

  /** El periodo empieza antes de que existieran los cortes POS en Kepler. */
  antesDeCortes(d: CortesSucursalesResponse): boolean { return d.periodo.from < INICIO_CORTES; }
  pct(a: number, b: number): string { return b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—'; }
  dias(desde: string): number {
    const hoy = new Date();
    const [y, m, d] = desde.split('-').map(Number);
    return Math.max(0, Math.floor((Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - Date.UTC(y, m - 1, d)) / 86400000));
  }
  cobroLabel(e: CorteEstadoCobro): string { return COBRO[e].label; }
  cobroSev(e: CorteEstadoCobro): Sev { return COBRO[e].sev; }
  cuadreSev(q: CorteCuadre): Sev { return CUADRE[q].sev; }
  cuadreLabel(c: CorteRow): string {
    const base = CUADRE[c.cuadre].label;
    return c.cuadre === 'cuadra' || c.cuadre === 'sin_arqueo' || c.diferencia === null ? base : `${base} ${money(c.diferencia)}`;
  }
}
