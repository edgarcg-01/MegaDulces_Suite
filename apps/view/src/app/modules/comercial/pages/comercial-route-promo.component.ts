import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TableModule } from 'primeng/table';
import { ComercialService, RoutePromoResult, RoutePromoBody, PromoClientRow } from '../comercial.service';

/**
 * RR-PROMO — Agente AI de incentivos de ruta. Pegás el ENUNCIADO de la mecánica en lenguaje
 * natural (ej "RD: $6.00 por cada venta de choyitas /40 cód:97192, solo clientes distintos…") y
 * Haiku lo traduce a una regla; el backend calcula el pago por ruta con SQL determinista.
 * El LLM nunca hace la aritmética (ADR-016). Card embebida en /comercial/ventas-por-ruta.
 */
@Component({
  selector: 'app-comercial-route-promo',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, DatePickerModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rp card-premium card-flat">
      <button type="button" class="rp-head" (click)="open.set(!open())" [attr.aria-expanded]="open()">
        <span class="rp-title"><i class="pi pi-sparkles" aria-hidden="true"></i> Incentivo por enunciado (AI)</span>
        <span class="rp-hint">Pegá la mecánica de la promo tal cual — calcula el pago por ruta</span>
        <i class="pi rp-caret" [class.pi-chevron-down]="!open()" [class.pi-chevron-up]="open()" aria-hidden="true"></i>
      </button>

      @if (open()) {
        <div class="rp-body">
          <div class="rp-input">
            <!-- rows=4: una mecánica real trae Proveedor / Fecha / Participan / Dinámica y
                 con 2 renglones se cortaba justo donde dice quién participa. -->
            <textarea [(ngModel)]="enunciado" rows="4" class="rp-ta"
              placeholder='Ej: Proveedor: Vidis · del 01/06/2026 al 31/08/2026 · Participan: vendedores de RD, ruta vecinal y mayoreo · Bono de $50 por cliente distinto al que se le venda $500 de mercancía'></textarea>
            <div class="rp-controls">
              <button pButton size="small" [loading]="loading()" (click)="run()" [disabled]="!enunciado.trim() || loading()">
                <span class="p-button-icon p-button-icon-left pi pi-calculator" aria-hidden="true"></span>
                <span class="p-button-label">{{ loading() ? 'Calculando…' : 'Calcular' }}</span>
              </button>
              <!-- El picker es un OVERRIDE y estorbaba: el enunciado casi siempre trae la
                   vigencia. Se muestra sólo si se pide forzarla. -->
              @if (forzarPeriodo()) {
                <div class="rp-field">
                  <label>Forzar mes</label>
                  <p-datepicker [ngModel]="monthDate" (ngModelChange)="monthDate = $event; dateTouched.set(true)" view="month" dateFormat="MM yy" [showIcon]="true" appendTo="body" />
                </div>
                <button type="button" class="rp-link" (click)="forzarPeriodo.set(false); dateTouched.set(false)">Usar la del enunciado</button>
              }
            </div>

            @if (loading()) {
              <!-- Sin esto no se distingue "sigue trabajando" de "se trabó". Se dice en qué
                   etapa va, cuánto lleva y cuánto suele tardar. -->
              <div class="rp-prog" role="status" aria-live="polite">
                <div class="rp-progbar"><span [style.width.%]="progPct()"></span></div>
                <p class="rp-progtxt">
                  <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
                  {{ etapa() }} · <b>{{ elapsed() }}s</b>
                  <span class="rp-progaux">de ~{{ ESTIMADO }}s típicos — una promo de marca con varios canales barre meses de venta</span>
                </p>
              </div>
            } @else {
              <p class="rp-datehint">
                @if (dateTouched()) {
                  <i class="pi pi-lock" aria-hidden="true"></i> Forzando el mes elegido.
                  <button type="button" class="rp-link" (click)="forzarPeriodo.set(false); dateTouched.set(false)">Usar la fecha del enunciado</button>
                } @else {
                  <i class="pi pi-sparkles" aria-hidden="true"></i> La <b>vigencia se lee del enunciado</b> (ej "del 01/06/2026 al 31/08/2026").
                  <button type="button" class="rp-link" (click)="forzarPeriodo.set(true)">Forzar un mes</button>
                }
              </p>
            }
          </div>

          @if (res(); as r) {
            <!-- Regla interpretada (transparencia: el usuario valida lo que entendió el AI) -->
            <div class="rp-rule">
              <div class="rp-chips">
                <span class="rp-chip">
                  @if (r.rule.alcance === 'marca') { <i class="pi pi-tag" title="Alcance: toda la marca" aria-hidden="true"></i> }
                  <b>{{ r.product?.nombre || r.rule.marca_texto || r.rule.producto_texto || '—' }}</b>@if (r.product && r.rule.alcance !== 'marca') { · {{ r.product.sku }} }
                </span>
                <span class="rp-chip">\${{ r.rule.rate | number:'1.2-2' }} / {{ r.base_label.toLowerCase() }}</span>
                <!-- Quiénes participan: se muestra lo que el AI entendió, no lo que se supone. -->
                <span class="rp-chip">{{ canalesLbl(r) }}</span>
                <span class="rp-chip rp-chip-mut">@if (r.rule.date_from) { <i class="pi pi-sparkles" title="Detectado del enunciado" aria-hidden="true"></i> }{{ r.period.label }}</span>
              </div>
              @if (r.rule.supuestos) { <p class="rp-note"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ r.rule.supuestos }}</p> }

              <!-- La unidad se declara SIEMPRE. La cantidad se normaliza al peldaño real del ERP
                   (pieza/paquete/caja) por el precio cobrado; lo que no resuelve no se suma. -->
              @if (r.product) {
                <p class="rp-unit" [class.rp-unit-warn]="!r.unit.confiable">
                  <i class="pi" [class.pi-check-circle]="r.unit.confiable" [class.pi-exclamation-triangle]="!r.unit.confiable" aria-hidden="true"></i>
                  {{ r.unit.nota }}
                </p>
              }

              @if (r.candidates?.length) {
                <div class="rp-amb">
                  <span>Producto ambiguo — elegí el SKU:</span>
                  <p-select [options]="r.candidates" optionLabel="nombre" optionValue="sku" [(ngModel)]="pickSku"
                            placeholder="Seleccioná" appendTo="body" styleClass="w-full" />
                  <button pButton size="small" severity="secondary" (click)="run(pickSku)" [disabled]="!pickSku">Recalcular</button>
                </div>
              }
            </div>

            @if (r.rows.length) {
              <div class="rp-topbar">
                <div class="rp-totals">
                  <div class="rp-kpi"><span class="k-lbl">Pago total</span><span class="k-val">{{ r.total_payout | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                  <div class="rp-kpi"><span class="k-lbl">Clientes</span><span class="k-val">{{ r.total_clientes | number }}</span>
                    @if (r.total_clientes_indeterminados) { <em class="k-aux">+{{ r.total_clientes_indeterminados }} sin determinar</em> }
                  </div>
                  <!-- Si el alcance mezcla unidades (una marca con globos en PAQ y velas en
                       PZA), el total NO se publica: sumarlas no significa nada. -->
                  @if (r.unit.unidades_sumables) {
                    <div class="rp-kpi"><span class="k-lbl">Cantidad <b>{{ unitLbl(r) }}</b></span><span class="k-val">{{ r.total_unidades | number:'1.0-2' }}</span></div>
                  } @else {
                    <div class="rp-kpi"><span class="k-lbl">Cantidad</span><span class="k-val k-na" title="El alcance mezcla unidades distintas (p. ej. PAQ y PZA): un total no significa nada. El desglose por producto sí trae cada cantidad con su unidad.">—</span><em class="k-aux">unidades mezcladas</em></div>
                  }
                  <div class="rp-kpi"><span class="k-lbl">Importe</span><span class="k-val">{{ r.total_importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
                  <div class="rp-kpi"><span class="k-lbl">Vendedores</span><span class="k-val">{{ r.rows.length }}</span></div>
                </div>
                <div class="rp-dl">
                  <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl()==='xlsx'" (click)="download('xlsx')"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">XLSX</span></button>
                  <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl()==='pdf'" (click)="download('pdf')"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF</span></button>
                </div>
              </div>

              <table class="rp-tbl">
                <thead><tr><th>Vendedor</th><th class="n">Clientes</th>
                  @if (r.unit.unidades_sumables) { <th class="n">Cantidad {{ unitLbl(r) }}</th> }
                  <th class="n">Importe</th><th class="n">Pago</th></tr></thead>
                <tbody>
                  @for (row of r.rows; track row.canal + row.source_branch + row.vendedor) {
                    <tr>
                      <td>{{ row.label }}</td>
                      <td class="n">{{ row.clientes | number }}@if (row.clientes_indeterminados) { <span class="rp-indet" [title]="row.clientes_indeterminados + ' cliente(s) con línea sin peldaño identificable'">+{{ row.clientes_indeterminados }}?</span> }</td>
                      @if (r.unit.unidades_sumables) {
                        <td class="n">{{ row.unidades | number:'1.0-2' }}@if (row.unidades_sin_resolver) { <span class="rp-indet" [title]="row.unidades_sin_resolver + ' sin resolver — no sumadas'">+{{ row.unidades_sin_resolver | number:'1.0-2' }}?</span> }</td>
                      }
                      <td class="n">{{ row.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
                      <td class="n b">{{ row.payout | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    </tr>
                  }
                </tbody>
                <tfoot><tr><td>TOTAL</td><td class="n">{{ r.total_clientes | number }}</td>
                  @if (r.unit.unidades_sumables) { <td class="n">{{ r.total_unidades | number:'1.0-2' }}</td> }
                  <td class="n">{{ r.total_importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td><td class="n b">{{ r.total_payout | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr></tfoot>
              </table>

              <button type="button" class="rp-detog" (click)="toggleDesglose()" [disabled]="detLoading()">
                <i class="pi" [class.pi-chevron-right]="!showDetail()" [class.pi-chevron-down]="showDetail()" aria-hidden="true"></i>
                @if (detLoading()) {
                  <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Trayendo el desglose de clientes…
                } @else if (r.clientes_detalle.length) {
                  Desglose de clientes ({{ califican(r).length }} con bono@if (noCalifican(r).length) { · {{ noCalifican(r).length }} sin llegar })
                } @else {
                  Ver el desglose de clientes <span class="rp-lazy">(tarda unos segundos más)</span>
                }
              </button>
              @if (showDetail() && r.clientes_detalle.length) {
                  <!-- Se listan también los que NO llegaron al umbral: un desglose que sólo
                       muestra a los que cobran no deja auditar por qué el resto no. -->
                  <div class="rp-cfilter" role="group" aria-label="Qué clientes mostrar">
                    <button type="button" [class.on]="!soloBono()" (click)="soloBono.set(false)">Todos ({{ r.clientes_detalle.length }})</button>
                    <button type="button" [class.on]="soloBono()" (click)="soloBono.set(true)">Solo con bono ({{ califican(r).length }})</button>
                  </div>
                  <table class="rp-tbl rp-det">
                    <thead><tr>
                      <th></th><th>Vendedor</th><th>Cliente</th><th class="n">Tickets</th>
                      <th class="n">Importe</th><th class="n">Bono</th>
                    </tr></thead>
                    <tbody>
                      @for (c of visibleClientes(r); track c.canal + c.vendedor + c.cliente) {
                        <tr class="rp-crow" [class.rp-crow-no]="!c.califica" (click)="toggleCli(c)">
                          <td class="rp-cexp">
                            <i class="pi" [class.pi-chevron-right]="!isOpen(c)" [class.pi-chevron-down]="isOpen(c)" aria-hidden="true"></i>
                          </td>
                          <td>{{ c.route_label }}</td>
                          <td>
                            {{ c.nombre }}
                            @if (c.nombre_ambiguo) {
                              <i class="pi pi-exclamation-triangle rp-amb-i"
                                 title="Este código de cliente existe en más de una sucursal: el nombre puede ser de otro cliente" aria-hidden="true"></i>
                            }
                            <span class="mono rp-ccode">{{ c.cliente }}</span>
                          </td>
                          <td class="n">{{ c.tickets | number }}</td>
                          <td class="n">{{ c.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
                          <td class="n b">
                            @if (c.califica) { {{ r.rule.rate | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                            @else { <span class="rp-nobono">—</span> }
                          </td>
                        </tr>
                        @if (isOpen(c)) {
                          <tr class="rp-citems">
                            <td colspan="6">
                              <table class="rp-tbl rp-itbl">
                                <thead><tr><th>Producto</th><th>SKU</th><th class="n">Cantidad</th><th class="n">Importe</th></tr></thead>
                                <tbody>
                                  @for (it of c.items; track it.sku) {
                                    <tr>
                                      <td>{{ it.nombre }}</td>
                                      <td class="mono">{{ it.sku }}</td>
                                      <!-- La cantidad viaja SIEMPRE con su unidad: en el mismo
                                           cliente conviven PAQ y PZA y sumarlas no significa nada. -->
                                      <td class="n">{{ it.unidades | number:'1.0-2' }} <span class="rp-u">{{ it.unidad || '?' }}</span>
                                        @if (it.unidades_sin_resolver) {
                                          <span class="rp-indet" [title]="it.unidades_sin_resolver + ' sin peldaño identificable — no sumadas'">+{{ it.unidades_sin_resolver | number:'1.0-2' }}?</span>
                                        }
                                      </td>
                                      <td class="n">{{ it.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        }
                      }
                    </tbody>
                  </table>
              }
            } @else {
              <p class="rp-empty">{{ r.note }}</p>
            }
          } @else if (err()) {
            <p class="rp-err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ err() }}</p>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; margin-bottom:1rem; }
    .rp { overflow:hidden; }
    .rp-head { display:flex; align-items:center; gap:.75rem; width:100%; padding:.85rem 1.1rem; background:none; border:none;
      cursor:pointer; text-align:left; color:var(--text-main); }
    .rp-title { font-weight:700; font-size:.9rem; display:inline-flex; align-items:center; gap:.5rem; white-space:nowrap; }
    .rp-title .pi-sparkles { color:var(--action); }
    .rp-hint { flex:1; font-size:.78rem; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rp-caret { color:var(--text-muted); font-size:.75rem; }
    .rp-body { padding:0 1.1rem 1.1rem; display:flex; flex-direction:column; gap:1rem; }
    .rp-input { display:flex; flex-direction:column; gap:.6rem; }
    .rp-ta { width:100%; resize:vertical; font-size:.85rem; padding:.6rem .7rem; border:1px solid var(--border-color);
      border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-family:inherit; }
    .rp-ta:focus { outline:none; border-color:var(--action); box-shadow:0 0 0 2px var(--action-ring); }
    .rp-controls { display:flex; align-items:flex-end; gap:1rem; }
    .rp-field { display:flex; flex-direction:column; gap:.3rem; }
    .rp-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .rp-field-aux { font-weight:500; text-transform:none; letter-spacing:0; color:var(--text-faint); font-size:.66rem; }
    .rp-datehint { margin:0; font-size:.76rem; color:var(--text-muted); display:flex; align-items:baseline; gap:.35rem; flex-wrap:wrap; }
    .rp-datehint .pi-sparkles { color:var(--action); }
    .rp-datehint b { color:var(--text-main); font-weight:600; }
    .rp-link { background:none; border:none; padding:0; color:var(--action); font-weight:600; font-size:.76rem; cursor:pointer; text-decoration:underline; }
    .rp-chip .pi-sparkles { color:var(--action); font-size:.72rem; margin-right:.15rem; }
    .rp-rule { display:flex; flex-direction:column; gap:.5rem; }
    .rp-chips { display:flex; flex-wrap:wrap; gap:.4rem; }
    .rp-chip { font-size:.78rem; padding:.2rem .55rem; border-radius:var(--r-sm); background:var(--layout-bg);
      border:1px solid var(--border-color); color:var(--text-main); }
    .rp-chip-mut { color:var(--text-muted); }
    .rp-note { font-size:.76rem; color:var(--text-muted); display:flex; gap:.4rem; align-items:baseline; margin:0; }
    /* Declaración de unidad: discreta cuando está limpia, ámbar cuando el pago no es confiable. */
    .rp-unit { font-size:.76rem; color:var(--text-muted); display:flex; gap:.4rem; align-items:baseline; margin:0;
      padding:.4rem .6rem; border-radius:var(--r-sm); background:var(--layout-bg); border:1px solid var(--border-color); }
    .rp-unit .pi-check-circle { color:var(--good-fg, var(--text-faint)); }
    .rp-unit-warn { background:var(--warn-bg, var(--layout-bg)); border-color:var(--warn-fg, var(--border-color)); color:var(--warn-fg, var(--text-main)); }
    .rp-unit-warn .pi-exclamation-triangle { color:var(--warn-fg, var(--text-main)); }
    .rp-indet { margin-left:.25rem; font-size:.7rem; color:var(--text-faint); font-weight:600; cursor:help; }
    .rp-kpi .k-aux { font-size:.66rem; color:var(--text-faint); font-style:normal; }
    .rp-kpi .k-na { color:var(--text-faint); cursor:help; }
    /* Progreso: barra + etapa + cronómetro. */
    .rp-prog { display:flex; flex-direction:column; gap:.35rem; }
    .rp-progbar { height:3px; border-radius:2px; background:var(--layout-bg); overflow:hidden; }
    .rp-progbar > span { display:block; height:100%; background:var(--action); transition:width .25s linear; }
    .rp-progtxt { margin:0; font-size:.78rem; color:var(--text-muted); display:flex; align-items:baseline; gap:.4rem; flex-wrap:wrap; }
    .rp-progtxt b { color:var(--text-main); font-variant-numeric:tabular-nums; }
    .rp-progaux { font-size:.72rem; color:var(--text-faint); }
    .rp-lazy { color:var(--text-faint); font-weight:400; }
    .rp-detog[disabled] { opacity:.6; cursor:default; }
    .rp-amb { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; font-size:.82rem; padding:.6rem .7rem;
      background:var(--layout-bg); border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .rp-amb p-select { min-width:16rem; }
    .rp-topbar { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; flex-wrap:wrap; padding:.4rem 0; }
    .rp-dl { display:flex; gap:.5rem; }
    .rp-detog { margin-top:.5rem; background:none; border:none; color:var(--action); font-size:.82rem; font-weight:600;
      cursor:pointer; display:inline-flex; align-items:center; gap:.4rem; padding:.3rem 0; }
    .rp-det { margin-top:.4rem; }
    .rp-tbl .mono { font-family:var(--font-mono); font-size:.76rem; }
    /* Desglose de clientes: fila clickeable → qué se le vendió y en qué unidad. */
    .rp-cfilter { display:flex; gap:.35rem; margin:.5rem 0 .1rem; }
    .rp-cfilter button { font-size:.74rem; padding:.2rem .6rem; border-radius:var(--r-sm); cursor:pointer;
      border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-muted); }
    .rp-cfilter button.on { background:var(--surface-selected-bg); color:var(--text-main); font-weight:600; border-color:var(--text-faint); }
    .rp-crow { cursor:pointer; }
    .rp-crow:hover { background:var(--surface-selected-bg); }
    .rp-crow-no td { color:var(--text-muted); }
    .rp-cexp { width:1.4rem; color:var(--text-faint); font-size:.7rem; }
    .rp-ccode { margin-left:.4rem; color:var(--text-faint); }
    .rp-amb-i { color:var(--warn-fg, var(--text-faint)); font-size:.72rem; margin-left:.25rem; cursor:help; }
    .rp-nobono { color:var(--text-faint); }
    .rp-citems > td { padding:0 0 .5rem 1.4rem !important; background:var(--layout-bg); }
    .rp-itbl { font-size:.76rem; }
    .rp-itbl thead th { background:transparent; font-size:.66rem; }
    .rp-u { color:var(--text-faint); font-size:.7rem; margin-left:.15rem; }
    .rp-totals { display:flex; gap:1.5rem; padding:.4rem 0; flex-wrap:wrap; }
    .rp-kpi { display:flex; flex-direction:column; gap:.15rem; }
    .rp-kpi .k-lbl { font-size:.7rem; color:var(--text-faint); text-transform:uppercase; letter-spacing:.03em; }
    .rp-kpi .k-val { font-size:1.35rem; font-weight:700; color:var(--text-main); line-height:1.1; }
    .rp-tbl { width:100%; border-collapse:separate; border-spacing:0; font-size:.82rem; }
    .rp-tbl th, .rp-tbl td { padding:.34rem .6rem; border-bottom:1px solid var(--border-color); text-align:left; }
    .rp-tbl thead th { background:var(--layout-bg); font-weight:700; font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); }
    .rp-tbl .n { text-align:right; font-variant-numeric:tabular-nums; }
    .rp-tbl .b { font-weight:700; }
    .rp-tbl tfoot td { font-weight:700; background:var(--surface-selected-bg); border-top:2px solid var(--border-color); }
    .rp-empty, .rp-err { font-size:.82rem; color:var(--text-muted); margin:0; display:flex; gap:.4rem; align-items:baseline; }
    .rp-err { color:var(--bad-fg); }
  `],
})
export class RoutePromoComponent {
  private readonly svc = inject(ComercialService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // El cronómetro es un setInterval: si el componente muere mientras corre, queda vivo.
    this.destroyRef.onDestroy(() => this.stopProgress());
  }

  readonly open = signal(false);
  readonly loading = signal(false);
  readonly dl = signal<'' | 'xlsx' | 'pdf'>('');
  readonly showDetail = signal(false);
  /** Desglose de clientes: qué filas están expandidas y si se filtra a los que cobran. */
  readonly openCli = signal<ReadonlySet<string>>(new Set<string>());
  readonly soloBono = signal(false);
  readonly detLoading = signal(false);
  /** Progreso: sin esto no se distingue "sigue trabajando" de "se trabó". */
  readonly elapsed = signal(0);
  readonly etapa = signal('');
  /** El picker de mes es override; sólo aparece si se pide forzar el periodo. */
  readonly forzarPeriodo = signal(false);
  private t0 = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly res = signal<RoutePromoResult | null>(null);
  readonly err = signal<string | null>(null);
  enunciado = '';
  pickSku: string | null = null;
  private lastBody: RoutePromoBody | null = null;
  // Fecha AUTO-inteligente: por default el periodo lo lee el AI del enunciado. El picker (mes anterior
  // cerrado) es solo un OVERRIDE manual: se envía from/to únicamente si el usuario lo toca.
  readonly dateTouched = signal(false);
  monthDate: Date = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);

  private iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  /**
   * Rótulo de la unidad para las cabeceras. La cantidad viene normalizada a la unidad BASE
   * del SKU en el ERP (PZA / PAQ / CJA…), que NO siempre es la pieza: nombrarla es el punto.
   */
  unitLbl(r: RoutePromoResult): string { return r.unit?.unit_base ? `(${r.unit.unit_base})` : ''; }

  /** Clientes que generan bono / los que no llegaron al umbral. */
  califican(r: RoutePromoResult): PromoClientRow[] { return r.clientes_detalle.filter((c) => c.califica); }
  noCalifican(r: RoutePromoResult): PromoClientRow[] { return r.clientes_detalle.filter((c) => !c.califica); }
  visibleClientes(r: RoutePromoResult): PromoClientRow[] {
    return this.soloBono() ? this.califican(r) : r.clientes_detalle;
  }

  private cliKey(c: PromoClientRow) { return `${c.canal}|${c.vendedor}|${c.cliente}`; }
  isOpen(c: PromoClientRow): boolean { return this.openCli().has(this.cliKey(c)); }
  toggleCli(c: PromoClientRow): void {
    const k = this.cliKey(c);
    const next = new Set(this.openCli());
    if (next.has(k)) next.delete(k); else next.add(k);
    this.openCli.set(next);
  }

  /** Quiénes participan, tal como los entendió el AI — para que se pueda desmentir de un vistazo. */
  canalesLbl(r: RoutePromoResult): string {
    const L: Record<string, string> = {
      ruta: 'RD / reparto', vecinal: 'Ruta vecinal', mayoreo: 'Mayoreo', mostrador: 'Mostrador',
    };
    const cs = r.rule.canales ?? [];
    if (cs.length) return cs.map((c) => L[c] ?? c).join(' + ');
    return r.rule.canal === 'ruta' ? 'RD / reparto' : 'Todos los canales';
  }

  /** Segundos típicos de una corrida (medido en prod: ~3 s el AI + ~6 s el agregado). */
  readonly ESTIMADO = 12;

  /** Arranca el cronómetro y la narración de etapas mientras corre la petición. */
  private startProgress(): void {
    this.t0 = Date.now();
    this.elapsed.set(0);
    this.etapa.set('Interpretando el enunciado con AI');
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const s = Math.round((Date.now() - this.t0) / 1000);
      this.elapsed.set(s);
      // Las etapas son honestas respecto de lo que hace el backend, no un teatro.
      if (s >= this.ESTIMADO * 2) this.etapa.set('Tardando más de lo normal — sigue corriendo');
      else if (s >= 4) this.etapa.set('Calculando sobre la venta del periodo');
      else this.etapa.set('Interpretando el enunciado con AI');
    }, 250);
  }
  private stopProgress(): void { clearInterval(this.timer); this.timer = undefined; }

  /** % de la barra: avanza hacia el estimado y se frena en 95 para no mentir que terminó. */
  progPct(): number { return Math.min(95, Math.round((this.elapsed() / this.ESTIMADO) * 100)); }

  run(sku?: string | null): void {
    const enunciado = this.enunciado.trim();
    if (!enunciado) return;
    const body: RoutePromoBody = { enunciado, sku: sku || undefined };
    // Solo forzamos el periodo si el usuario tocó el picker; si no, gana la vigencia que el AI lea del enunciado.
    if (this.dateTouched()) {
      const d = this.monthDate;
      body.from = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
      body.to = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    }
    this.lastBody = body;
    this.loading.set(true);
    this.err.set(null);
    this.showDetail.set(false);
    this.openCli.set(new Set<string>());
    this.startProgress();
    // Sin `detalle`: el desglose de clientes cuesta ~9 s y se pide sólo al abrirlo.
    this.svc.routePromo(body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.res.set(r); this.pickSku = null; this.loading.set(false); this.stopProgress();
          // Reusa la regla ya interpretada (incl. vigencia auto) en XLSX/PDF → mismo periodo, sin re-llamar al LLM.
          this.lastBody = { ...body, rule: r.rule };
        },
        error: (e) => {
          this.res.set(null); this.loading.set(false); this.stopProgress();
          const s = this.elapsed();
          this.err.set(e?.status === 0
            ? `Se perdió la conexión con el servidor a los ${s}s (o se agotó el tiempo de espera).`
            : e?.status === 429 ? 'Demasiadas corridas seguidas: esperá un minuto.'
            : (e?.error?.message || `No se pudo calcular (error ${e?.status ?? '?'} a los ${s}s)`));
        },
      });
  }

  /**
   * Abre el desglose y, la primera vez, lo pide al servidor. Se separa de la corrida
   * principal porque es la mitad del tiempo total y no todo el mundo lo abre.
   */
  toggleDesglose(): void {
    const abrir = !this.showDetail();
    this.showDetail.set(abrir);
    if (!abrir || this.res()?.clientes_detalle?.length || this.detLoading() || !this.lastBody) return;
    this.detLoading.set(true);
    this.svc.routePromo({ ...this.lastBody, detalle: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.res.set(r); this.detLoading.set(false); },
        error: (e) => {
          this.detLoading.set(false);
          this.err.set(e?.error?.message || 'No se pudo traer el desglose de clientes');
        },
      });
  }

  download(fmt: 'xlsx' | 'pdf'): void {
    if (!this.lastBody || !this.res()?.rows.length) return;
    this.dl.set(fmt);
    // El documento SIEMPRE lleva el desglose, aunque en pantalla no se haya abierto.
    this.svc.routePromoDownload({ ...this.lastBody, detalle: true }, fmt)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set('');
          const cd = resp.headers.get('content-disposition') || '';
          const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const plain = /filename="?([^";]+)"?/i.exec(cd);
          const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `incentivo.${fmt}`;
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a');
          a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(''); },
      });
  }
}
