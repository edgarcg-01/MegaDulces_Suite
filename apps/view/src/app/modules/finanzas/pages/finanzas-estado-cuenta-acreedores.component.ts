import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TagModule } from 'primeng/tag';
import type {
  AcreedorDocEstado, AcreedorEstadoCuentaResponse, AcreedorResumen, AcreedorTipo, AcreedorTipoTotal, AcreedoresResponse,
} from '@megadulces/contracts';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

/** Los tipos que se eligen en la pantalla. `interno` (traspasos TI) no se lista: no es deuda. */
const TIPOS: { tipo: AcreedorTipo; label: string }[] = [
  { tipo: 'mercancia', label: 'Mercancía' },
  { tipo: 'servicios', label: 'Servicios' },
  { tipo: 'financiero', label: 'Financieros' },
  { tipo: 'sin_clasificar', label: 'Sin clasificar' },
];

const ESTADO: Record<AcreedorDocEstado, { label: string; sev: Sev }> = {
  pendiente: { label: 'Pendiente', sev: 'warn' },
  parcial: { label: 'Parcial', sev: 'info' },
  pagado: { label: 'Pagado', sev: 'success' },
  sobreaplicado: { label: 'Pagado de más', sev: 'danger' },
};

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * `[ECA.2]` Estado de cuenta de acreedores — el reporte "Estado de cuenta del proveedor" de Kepler,
 * para todos los acreedores y separado por tipo (mercancía, servicios, financieros).
 *
 * Cada documento que sube la deuda (p. ej. "Aplica Orden Entrada") sale con los pagos y notas de
 * crédito que Kepler le aplicó, y su saldo. El casamiento es el de Kepler (`kdxf`), no una
 * estimación. Sólo lectura: los pagos se siguen capturando y aplicando en Kepler.
 */
@Component({
  selector: 'app-finanzas-estado-cuenta-acreedores',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, DatePickerModule, ToggleSwitchModule, TagModule, MetricStripComponent, SucursalPipe],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Estado de cuenta de acreedores</h1>
          <p class="surf-page-sub">Lo que se le debe a cada acreedor según Kepler, con cada factura y los pagos y notas de crédito que se le aplicaron. Sólo lectura: los pagos se aplican en Kepler.</p>
        </div>
        <div class="ec-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="ec-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="ec-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <div class="ec-seg" role="group" aria-label="Tipo de acreedor">
          @for (t of tiposVisibles(); track t.tipo) {
            <button type="button" class="ec-seg-btn" [class.on]="tipo() === t.tipo" [attr.aria-pressed]="tipo() === t.tipo" (click)="pickTipo(t.tipo)">
              {{ t.label }} <span class="ec-seg-n">{{ total(t.tipo)?.acreedores ?? 0 }}</span>
            </button>
          }
        </div>
        @if (total('interno'); as ti) { @if (ti.acreedores) {
          <p class="ec-hint ec-mt">Los traspasos entre sucursales ({{ ti.acreedores }} claves <span class="ec-mono">TI</span>) no se muestran: no son deuda con un tercero.</p>
        } }

        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del tipo de acreedor" />

        @if (totalSel(); as t) { @if (t.pendiente_sucursal_antes_corte > 0.005) {
          <div class="ec-note ec-note-warn" role="note"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span><b>{{ money(t.pendiente_sucursal_antes_corte) }}</b> de lo pendiente son facturas en el Kepler de una <b>sucursal</b> con fecha anterior al <b>01/10/2026</b>. Hasta esa fecha el 00 concentraba los pagos: muchas pudieron pagarse desde el 00 sin aplicarse en la sucursal. Revísalas antes de tratarlas como deuda.</span></div>
        } }

        <div class="ec-split">
          <section class="ec-block dt-scope" aria-labelledby="ec-h-list">
            <div class="ec-bh">
              <h2 id="ec-h-list">Acreedores</h2>
              <input pInputText type="search" class="ec-search" placeholder="Buscar clave, nombre o RFC" aria-label="Buscar acreedor" [ngModel]="q()" (ngModelChange)="q.set($event)" />
            </div>
            <p-table [value]="lista()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="62vh" selectionMode="single" [selection]="sel()" (selectionChange)="pick($event)" dataKey="codigo">
              <ng-template #header><tr><th>Acreedor</th><th class="ta-r">Pendiente</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th></tr></ng-template>
              <ng-template #body let-a>
                <tr [pSelectableRow]="a">
                  <td role="cell" data-label="Acreedor"><div class="ec-name">{{ a.nombre }}</div><div class="ec-hint"><span class="ec-mono">{{ a.codigo }}</span>@if (a.grupo_nombre) { · {{ a.grupo_nombre }} }@if (a.documentos_pendientes) { · {{ a.documentos_pendientes }} doc. pendiente(s) }</div></td>
                  <td class="ta-r num" role="cell" data-label="Pendiente" [class.muted]="!a.pendiente">{{ a.pendiente ? money(a.pendiente) : '—' }}</td>
                  <td class="ta-r num" role="cell" data-label="Vencido" [class.ec-bad]="a.vencido > 0.005" [class.muted]="!a.vencido">{{ a.vencido ? money(a.vencido) : '—' }}</td>
                  <td class="ta-r num ec-strong" role="cell" data-label="Saldo">{{ money(a.saldo) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="ec-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>{{ q() ? 'Ningún acreedor coincide con la búsqueda.' : 'Sin acreedores de este tipo.' }}</span></div></td></tr></ng-template>
            </p-table>
            <p class="ec-hint ec-pad">{{ lista().length }} acreedor(es), de mayor a menor saldo.</p>
          </section>

          <section class="ec-block ec-detail" aria-labelledby="ec-h-det" aria-live="polite">
            @if (sel(); as a) {
              <div class="ec-bh"><h2 id="ec-h-det">{{ a.nombre }}</h2><span class="ec-mono muted">{{ a.codigo }}</span></div>
              @if (det(); as e) {
                <dl class="ec-ficha">
                  @if (e.acreedor.rfc) { <div><dt>RFC</dt><dd class="ec-mono">{{ e.acreedor.rfc }}</dd></div> }
                  @if (e.acreedor.grupo) { <div><dt>Grupo</dt><dd>{{ e.acreedor.grupo_nombre }} <span class="muted ec-mono">{{ e.acreedor.grupo }}</span></dd></div> }
                  @if (e.acreedor.dias_credito) { <div><dt>Crédito</dt><dd>{{ e.acreedor.dias_credito }} días</dd></div> }
                  @if (e.acreedor.telefono) { <div><dt>Teléfono</dt><dd class="ec-mono">{{ e.acreedor.telefono }}</dd></div> }
                  @if (e.acreedor.direccion) { <div class="ec-wide"><dt>Dirección</dt><dd>{{ e.acreedor.direccion }}</dd></div> }
                  @if (!e.acreedor.grupo) { <div class="ec-wide"><dt>Grupo</dt><dd class="muted">Sin grupo en el catálogo de Kepler; el tipo sale de la clave.</dd></div> }
                </dl>
              }

              <div class="ec-filters">
                <div class="ec-field ec-toggle"><label for="ec-pend">Sólo con saldo</label>
                  <p-toggleswitch inputId="ec-pend" [ngModel]="soloPendientes()" (ngModelChange)="setSoloPendientes($event)" /></div>
                @if (!soloPendientes()) {
                  <div class="ec-field"><label for="ec-rango">Fecha del documento</label>
                    <p-datepicker inputId="ec-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Elegir fechas" (onClose)="onRange()" /></div>
                }
              </div>

              @if (detErr(); as e) { <p class="ec-hint ec-pad ec-bad">{{ e }}</p> }
              @if (detLoading()) { <div class="fb-skeleton ec-pad" aria-busy="true">@for (i of skel.slice(0, 4); track i) { <div class="fb-skel-row"></div> }</div> }
              @else if (det(); as e) {
                <div class="ec-tots">
                  <div><span>Pendiente</span><b class="num">{{ money(e.totales.pendiente) }}</b></div>
                  <div><span>Vencido</span><b class="num" [class.ec-bad]="e.totales.vencido > 0.005">{{ money(e.totales.vencido) }}</b></div>
                  <div><span>Pagos sin aplicar</span><b class="num">{{ money(e.totales.pagos_sin_aplicar) }}</b></div>
                  <div><span>Saldo</span><b class="num">{{ money(e.totales.saldo) }}</b></div>
                </div>

                <div class="ec-scroll">
                  <table class="ec-st">
                    <thead><tr><th>Suc</th><th>Documento</th><th>Folio</th><th>Fecha</th><th>Referencia</th><th class="ta-r">Cargo</th><th class="ta-r">Abono</th><th>Vence</th><th class="ta-r">Saldo</th></tr></thead>
                    @for (doc of e.documentos; track doc.sucursal + doc.tipo_doc + doc.folio) {
                      <tbody class="ec-doc">
                        <tr class="ec-doc-row">
                          <td class="ec-mono muted">{{ doc.sucursal | sucursal }}</td>
                          <td>{{ doc.documento }}</td>
                          <td class="ec-mono">{{ doc.folio }}</td>
                          <td class="ec-mono">{{ dmy(doc.fecha) }}</td>
                          <td class="ec-mono">{{ doc.referencia || '' }}</td>
                          <td></td>
                          <td class="ta-r num">{{ money(doc.importe) }}</td>
                          <td class="ec-mono" [class.ec-bad]="doc.vencido">{{ doc.vence ? dmy(doc.vence) : '—' }}</td>
                          <td class="ta-r"><p-tag [value]="estadoLabel(doc.estado)" [severity]="estadoSev(doc.estado)" styleClass="ec-tag" /></td>
                        </tr>
                        @for (ap of doc.aplicaciones; track ap.tipo_doc + ap.folio) {
                          <tr class="ec-ap-row">
                            <td></td>
                            <td class="ec-ap-name">{{ ap.documento }}</td>
                            <td class="ec-mono">{{ ap.folio }}</td>
                            <td class="ec-mono">{{ dmy(ap.fecha) }}</td>
                            <td class="ec-mono">{{ ap.referencia || '' }}</td>
                            <td class="ta-r num">{{ money(ap.importe) }}</td>
                            <td></td><td></td><td></td>
                          </tr>
                        }
                        <tr class="ec-saldo-row"><td colspan="8" class="ta-r">Saldo documento</td><td class="ta-r num" [class.ec-bad]="doc.saldo > 0.005 && doc.vencido">{{ money(doc.saldo) }}</td></tr>
                      </tbody>
                    } @empty {
                      <tbody><tr><td colspan="9"><div class="ec-empty"><i class="pi pi-check-circle" aria-hidden="true"></i><span>{{ soloPendientes() ? 'Ningún documento con saldo: todo lo facturado tiene su pago aplicado.' : 'Sin documentos en el periodo.' }}</span></div></td></tr></tbody>
                    }
                  </table>
                </div>

                @if (e.pagos_sin_aplicar.length) {
                  <div class="ec-sub">
                    <h3>Pagos y notas sin aplicar</h3>
                    <p class="ec-hint">Registrados en Kepler pero todavía no aplicados a ninguna factura: son saldo a favor (anticipos, pagos por aplicar).</p>
                    <table class="ec-st">
                      <thead><tr><th>Suc</th><th>Documento</th><th>Folio</th><th>Fecha</th><th>Referencia</th><th class="ta-r">Importe</th><th class="ta-r">Sin aplicar</th></tr></thead>
                      <tbody>
                        @for (p of e.pagos_sin_aplicar; track p.sucursal + p.tipo_doc + p.folio) {
                          <tr><td class="ec-mono muted">{{ p.sucursal }}</td><td>{{ p.documento }}</td><td class="ec-mono">{{ p.folio }}</td><td class="ec-mono">{{ dmy(p.fecha) }}</td><td class="ec-mono">{{ p.referencia || '' }}</td><td class="ta-r num">{{ money(p.importe) }}</td><td class="ta-r num ec-strong">{{ money(p.remanente) }}</td></tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
                <p class="ec-hint ec-pad">Saldo al {{ dmy(e.al) }}. Vencido = factura con saldo cuya fecha de vencimiento ya pasó; las que Kepler no trae con vencimiento no cuentan como vencidas.</p>
              }
            } @else {
              <div class="ec-empty ec-pad"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Elige un acreedor para ver su estado de cuenta.</span></div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .ec-actions { display:flex; gap:.5rem; align-items:center; }
    .ec-seg { display:inline-flex; flex-wrap:wrap; gap:0; margin:.4rem 0 .2rem; border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; background:var(--card-bg); }
    .ec-seg-btn { border:0; border-right:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); padding:.45rem .9rem; cursor:pointer; display:inline-flex; align-items:center; gap:.4rem; }
    .ec-seg-btn:last-child { border-right:0; }
    .ec-seg-btn:hover { background:var(--hover-bg); }
    .ec-seg-btn.on { background:var(--action); color:var(--action-ink); font-weight:600; }
    .ec-seg-btn:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .ec-seg-n { font-family:var(--font-mono); font-size:var(--fs-micro); opacity:.8; }
    .ec-mt { margin-top:.2rem; }
    app-metric-strip { display:block; margin:.6rem 0; }
    .ec-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .8rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .ec-note-warn { border-left:3px solid var(--warn-fg); }
    .ec-note-warn .pi { color:var(--warn-fg); margin-top:.15rem; }
    .ec-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.7fr); gap:1rem; align-items:start; }
    @media (max-width:75rem) { .ec-split { grid-template-columns:minmax(0,1fr); } }
    .ec-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; margin-bottom:1rem; }
    .ec-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .ec-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .ec-search { min-width:14rem; }
    .ec-name { font-weight:600; }
    .ec-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .ec-pad { padding:.5rem .85rem; }
    .ec-ficha { display:grid; grid-template-columns:repeat(auto-fill, minmax(10rem, 1fr)); gap:.4rem 1rem; margin:0; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .ec-ficha dt { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); }
    .ec-ficha dd { margin:0; font-size:var(--fs-sm); }
    .ec-wide { grid-column:1 / -1; }
    .ec-filters { display:flex; flex-wrap:wrap; gap:.8rem; align-items:flex-end; padding:.6rem .85rem; }
    .ec-field { display:flex; flex-direction:column; gap:.25rem; }
    .ec-field label { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); }
    .ec-tots { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:.5rem; padding:0 .85rem .6rem; }
    .ec-tots div { display:flex; flex-direction:column; gap:.1rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ec-tots b { font-size:var(--fs-sm); color:var(--text-main); }
    @media (max-width:40rem) { .ec-tots { grid-template-columns:repeat(2, minmax(0,1fr)); } }
    .ec-scroll { overflow:auto; max-height:62vh; border-top:1px solid var(--border-color); }
    .ec-st { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .ec-st thead th { position:sticky; top:0; background:var(--card-bg); font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .ec-st td { padding:.2rem .5rem; vertical-align:top; }
    .ec-doc + .ec-doc .ec-doc-row td { border-top:1px solid var(--border-color); }
    .ec-doc-row td { padding-top:.45rem; }
    .ec-ap-row td { color:var(--text-muted); }
    .ec-ap-name { padding-left:1.4rem !important; }
    .ec-saldo-row td { font-weight:600; padding-bottom:.45rem; }
    .ec-sub { padding:.6rem .85rem; border-top:1px solid var(--border-color); }
    .ec-sub h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .2rem; }
    .ec-sub .ec-st { margin-top:.4rem; }
    .ta-r { text-align:right !important; }
    .num, .ec-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .ec-strong { font-weight:600; }
    .ec-bad { color:var(--bad-fg); }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .ec-tag { font-size:var(--fs-nano); }
    .ec-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .ec-errbox .pi { color:var(--bad-fg); } .ec-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .ec-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .ec-empty .pi { font-size:var(--fs-lg); }
  `],
})
export class FinanzasEstadoCuentaAcreedoresComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/creditor-statements`;

  readonly skel = Array.from({ length: 8 });
  readonly money = money;
  readonly dmy = dmy;

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<AcreedoresResponse | null>(null);
  readonly tipo = signal<AcreedorTipo>('mercancia');
  readonly q = signal('');
  readonly sel = signal<AcreedorResumen | null>(null);

  readonly soloPendientes = signal(true);
  rangeDates: Date[] | null = null;
  readonly det = signal<AcreedorEstadoCuentaResponse | null>(null);
  readonly detLoading = signal(false);
  readonly detErr = signal<string | null>(null);

  /** "Sin clasificar" sólo aparece si hay alguno: un botón vacío no informa nada. */
  readonly tiposVisibles = computed(() => TIPOS.filter((t) => t.tipo !== 'sin_clasificar' || (this.total('sin_clasificar')?.acreedores ?? 0) > 0));
  readonly totalSel = computed<AcreedorTipoTotal | null>(() => this.total(this.tipo()));

  readonly lista = computed<AcreedorResumen[]>(() => {
    const d = this.data();
    if (!d) return [];
    const delTipo = d.acreedores.filter((a) => a.tipo === this.tipo());
    return filtrarPorBusqueda(delTipo, this.q(), (a) => [a.codigo, a.nombre, a.rfc, a.grupo_nombre]);
  });

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const t = this.totalSel();
    if (!t) return [];
    return [
      { label: 'Saldo en Kepler', value: t.saldo, format: 'currency2', tone: 'default', sub: `${t.acreedores} acreedores` },
      { label: 'Pendiente de pago', value: t.pendiente, format: 'currency2', tone: t.pendiente > 0.005 ? 'warn' : 'ok', sub: 'facturas sin pago aplicado completo' },
      { label: 'Vencido', value: t.vencido, format: 'currency2', tone: t.vencido > 0.005 ? 'bad' : 'ok', sub: t.pendiente > 0 ? `${((t.vencido / t.pendiente) * 100).toFixed(1)}% de lo pendiente` : 'nada pendiente' },
      { label: 'Pagos sin aplicar', value: t.pagos_sin_aplicar, format: 'currency2', tone: 'default', sub: 'saldo a favor por aplicar' },
    ];
  });

  ngOnInit(): void { this.reload(); }

  total(tipo: AcreedorTipo): AcreedorTipoTotal | null {
    return this.data()?.totales.find((t) => t.tipo === tipo) ?? null;
  }

  pickTipo(t: AcreedorTipo): void {
    if (t === this.tipo()) return;
    this.tipo.set(t);
    const s = this.sel();
    if (s && s.tipo !== t) { this.sel.set(null); this.det.set(null); }
  }

  pick(a: AcreedorResumen | null): void {
    this.sel.set(a);
    this.det.set(null);
    if (a) this.loadDet();
  }

  setSoloPendientes(v: boolean): void {
    this.soloPendientes.set(v);
    if (!v && !this.rangeDates) {
      // Sin rango elegido: los últimos 3 meses, como el filtro de fechas del reporte de Kepler.
      const hoy = new Date();
      this.rangeDates = [new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1), hoy];
    }
    this.loadDet();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: todavía no se consulta
    this.loadDet();
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.http.get<AcreedoresResponse>(this.base).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        const s = this.sel();
        this.sel.set(s ? d.acreedores.find((x) => x.codigo === s.codigo) ?? null : null);
        this.loading.set(false);
        if (this.sel()) this.loadDet(); else this.det.set(null);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los acreedores.'); },
    });
  }

  loadDet(): void {
    const a = this.sel();
    if (!a) return;
    const p = new URLSearchParams();
    if (!this.soloPendientes()) {
      const [f, t] = this.rangeDates || [];
      if (!f || !t) return;
      p.set('pendientes', 'false'); p.set('from', iso(f)); p.set('to', iso(t));
    }
    this.detLoading.set(true);
    this.detErr.set(null);
    const codigo = a.codigo;
    this.http.get<AcreedorEstadoCuentaResponse>(`${this.base}/${encodeURIComponent(codigo)}?${p.toString()}`)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => {
          if (this.sel()?.codigo !== codigo) return; // ya se eligió otro acreedor
          this.det.set(d);
          this.detLoading.set(false);
        },
        error: () => {
          if (this.sel()?.codigo !== codigo) return;
          this.detLoading.set(false);
          this.detErr.set('No se pudo cargar el estado de cuenta.');
        },
      });
  }

  estadoLabel(e: AcreedorDocEstado): string { return ESTADO[e].label; }
  estadoSev(e: AcreedorDocEstado): Sev { return ESTADO[e].sev; }
}
