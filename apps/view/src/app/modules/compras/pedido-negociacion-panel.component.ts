import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ContextHelpComponent } from '../../shared/context-help/context-help.component';
import { margenSobreCosto, type PedidoNegociacionDto, warehouseName } from '@megadulces/contracts';

/** A qué pantallas puede saltar quien mira el panel (cada enlace pide su propio permiso). */
export interface EnlacesNegociacion { costos: boolean; descuentos: boolean; proveedores: boolean }

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * `[RA-NEG.1]` Panel «Costo y negociación» del desglose de `/compras/pedido`.
 *
 * Pedido del PM (2026-10-22): *«donde vemos costo, margen, precio, todas las herramientas que nos
 * servirían para negociar con el proveedor»*. Sólo PRESENTA: los datos los carga el desglose
 * (`GET commercial/replenishment/negociacion/:productId`) y las ACCIONES («Negocia…», «Pide…») las
 * pinta el desglose arriba, en la rejilla de acciones, con la misma regla del contrato
 * (`accionesNegociacion`). Aquí viven las cifras que las sostienen y la calculadora.
 *
 * Jerarquía (DESIGN §Q.5): primario = costo de hoy y margen real; secundario = lo pagado y la
 * calculadora; terciario = el proveedor.
 *
 * ⚠️ Sin validación visual en la app: el acomodo se midió en la maqueta
 * `docs/IMPLEMENTACION/FASES/prototipos/pedido-desglose-compacta.html` (cabe sin desplazar desde
 * 1366×657 de área útil), no en la pantalla desplegada.
 */
@Component({
  selector: 'app-pedido-negociacion-panel',
  standalone: true,
  imports: [RouterLink, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ng" aria-labelledby="ng-t">
      <div class="ng-h">
        <h3 id="ng-t">Costo y negociación</h3>
        <app-context-help topic="negociacion-costos"></app-context-help>
        <span class="ng-sp"></span>
        <!-- [RA-NEG.3] Se abren AQUÍ, en el panel lateral: antes eran rutas y salir del pedido perdía la requisición. -->
        <button type="button" class="ng-lnk" (click)="abrir.emit('historial')">Historial y costos ›</button>
        @if (d().proveedor) { <button type="button" class="ng-lnk" (click)="abrir.emit('descuentos')">Descuentos ›</button> }
      </div>

      <div class="ng-cifras">
        <div><div class="ng-k">Costo hoy</div><div class="ng-v num">{{ dinero(cajaHoy()) }}</div>
          <div class="ng-s">{{ porBase(d().costo.reposicion_base) }}</div></div>
        <div><div class="ng-k">Estándar</div><div class="ng-v num">{{ dinero(cajaEst()) }}</div>
          <div class="ng-s">{{ porBase(d().costo.estandar_base) }}</div></div>
        <div><div class="ng-k">Precio</div><div class="ng-v num">{{ dinero(d().costo.precio_ficha) }}</div>
          <div class="ng-s">{{ unidad() }}@if (d().costo.impuesto_pct) { con imp. } @if (!d().costo.precio_igual_en_todas) { · <b>distinto por sucursal</b> }</div></div>
        <div [title]="'Margen sobre costo, como lo expresa Kepler: precio sin impuesto ÷ costo de reposición − 1. La ficha lo calcula contra el estándar.'">
          <div class="ng-k">Margen real</div>
          <div class="ng-v num" [class.ng-warn]="margenBajo()">{{ pct(margenReal()) }}</div>
          <div class="ng-s">ficha {{ pct(d().costo.margen_ficha_pct) }}</div></div>
      </div>

      @if (d().pagado.meses.length) {
        <div class="ng-hist">
          <svg class="ng-spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" [attr.aria-label]="sparkLabel()">
            @if (spark().est != null) {
              <line x1="0" x2="100" [attr.y1]="spark().est" [attr.y2]="spark().est" class="ng-l-est" vector-effect="non-scaling-stroke"></line>
            }
            <polyline [attr.points]="spark().pts" class="ng-l-pag" vector-effect="non-scaling-stroke"></polyline>
          </svg>
          <div class="ng-hist-l">
            <span><i class="ng-ln ng-ln-pag"></i>pagado {{ unidad() }}: {{ sparkRango() }}</span>
            <span><i class="ng-ln ng-ln-est"></i>estándar</span>
            @if (d().pagado.minimo; as m) {
              <span class="ng-faint">mín. <span class="num">{{ dinero(m.costo_base) }}</span> {{ fecha(m.fecha) }} {{ dondeTxt(m.sucursal) }}</span>
            }
          </div>
          @if (d().pagado.renglones_sin_unidad || d().pagado.renglones_atipicos) {
            <div class="ng-faint ng-decl">Fuera del cálculo: {{ excluidosTxt() }}.</div>
          }
        </div>
      } @else {
        <div class="ng-faint ng-decl">Sin compras a este proveedor en 12 meses: no hay lo pagado contra qué negociar.</div>
      }

      <div class="ng-calc">
        <div class="ng-calc-in">
          <label for="ng-caja-{{ d().product_id }}">{{ bpc() ? 'Caja a $' : 'A $' }}</label>
          <input id="ng-caja-{{ d().product_id }}" type="number" min="0" step="0.01" inputmode="decimal"
                 [value]="costoProbado() ?? redondo(cajaHoy())" (input)="probar($event)"
                 [attr.aria-describedby]="'ng-out-' + d().product_id" />
          @if (cajaEst() != null) { <button type="button" class="ng-chip" (click)="fijar(cajaEst())" [title]="dinero(cajaEst())">estándar</button> }
          @if (cajaMin() != null) { <button type="button" class="ng-chip" (click)="fijar(cajaMin())" [title]="dinero(cajaMin())">mín. del año</button> }
          <button type="button" class="ng-chip" (click)="costoProbado.set(null)">hoy</button>
        </div>
        <div class="ng-calc-out" [id]="'ng-out-' + d().product_id" aria-live="polite">
          <div><div class="ng-k">Margen</div><div class="ng-v num" [class.ng-ok]="(calc().margen ?? 0) >= (d().costo.margen_ficha_pct ?? 999)">{{ pct(calc().margen) }}</div></div>
          <div><div class="ng-k">Este pedido ({{ cajasTxt(cajas()) }})</div>
            <div class="ng-v num" [class.ng-ok]="calc().dif > 0" [class.ng-bad]="calc().dif < 0"><span class="ng-verbo">{{ verbo(calc().dif) }}</span>{{ monto(calc().dif * cajas()) }}</div></div>
          <div><div class="ng-k">Un año ({{ cajasTxt(cajasAnio()) }})</div>
            <div class="ng-v num" [class.ng-ok]="calc().dif > 0" [class.ng-bad]="calc().dif < 0"><span class="ng-verbo">{{ verbo(calc().dif) }}</span>{{ monto(calc().dif * cajasAnio()) }}</div></div>
        </div>
      </div>

      @if (d().proveedor; as p) {
        <dl class="ng-prov">
          <div [title]="'Recepciones de 12 meses, sin la doble captura de oficinas. Este producto: lo pagado en 12 meses ÷ compras al proveedor.'">
            <dt>Compras 12 meses</dt><dd><b class="num">{{ dineroCorto(p.compras_12m) }}</b>
            <span class="ng-s">este producto {{ pct(participacion()) }}</span></dd></div>
          <div [title]="'Descuento por pronto pago + notas de crédito comerciales, contra lo comprado.'">
            <dt>Descuento</dt><dd><b class="num">{{ pct(p.descuento_pct) }}</b>
            <span class="ng-s num">{{ dineroCorto(p.descuento_pago_12m + p.descuento_notas_12m) }}</span></dd></div>
          <div><dt>Plazo</dt><dd>
            @if (p.plazo_dias != null) { <b>{{ p.plazo_dias }} días</b> <span class="ng-s">{{ p.plazo_base === 'recepcion' ? 'de recepción' : 'de factura' }}</span> }
            @else { <span class="ng-faint">sin capturar</span> }
            @if (plazoKepler(); as pk) { <span class="ng-s">Kepler: {{ pk }}</span> }
          </dd></div>
          <div [title]="tipicoTitle()"><dt>Pedido típico</dt><dd>
            @if (tipico(); as t) { <b class="num">{{ t }}</b> } @else { <span class="ng-faint">sin dato</span> }
          </dd></div>
          <div><dt>Surte</dt><dd>
            @if (surte() != null) { <b class="num">{{ pct(surte()! * 100) }}</b> <span class="ng-s">de lo pedido, en dinero</span> }
            @else { <span class="ng-faint">sin medir</span> }
          </dd></div>
          <div><dt>Entrega</dt><dd>
            @if (p.tiempo_entrega_dias != null) { <b>{{ p.tiempo_entrega_dias }} días</b> }
            @else if (links().proveedores) { <span class="ng-faint">no capturado</span> <a class="ng-s" [routerLink]="['/compras/proveedores']" [queryParams]="{ q: p.nombre }" target="_blank" rel="noopener"
                 title="Se abre en otra pestaña: tu pedido no se pierde. Mientras no se capture, el cálculo supone 7 días.">capturarlo en otra pestaña <i class="pi pi-external-link" aria-hidden="true"></i></a> }
            @else { <span class="ng-faint" title="El cálculo supone 7 días mientras no se capture">no capturado</span> }
          </dd></div>
          <div><dt>Reclamos</dt><dd>
            @if (p.reclamos.en_la_base === 0) { <span class="ng-faint" title="Nadie ha capturado un reclamo de recepción en toda la base: un cero aquí no quiere decir que no haya faltado nada.">sin registro</span> }
            @else { <b class="num">{{ p.reclamos.del_proveedor }}</b> <span class="ng-s">de {{ p.reclamos.en_la_base }} en la base</span> }
          </dd></div>
        </dl>
      } @else {
        <div class="ng-faint ng-decl">El producto no tiene proveedor en el catálogo.</div>
      }
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .ng { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .65rem .75rem; background: var(--surface-ground); }
    .num { font-variant-numeric: tabular-nums; }
    .ng-h { display: flex; align-items: baseline; gap: .6rem; margin-bottom: .5rem; }
    .ng-h h3 { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ng-sp { flex: 1; }
    .ng-h a, .ng-prov a { font-size: var(--fs-xs); color: var(--text-muted); text-underline-offset: 3px; }
    .ng-h a:hover, .ng-prov a:hover { color: var(--text-main); }
    .ng-lnk { font-family: inherit; font-size: var(--fs-xs); color: var(--text-muted); background: none; border: 0; padding: .2rem .1rem; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
    .ng-lnk:hover { color: var(--text-main); }
    .ng-lnk:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ng-h a:focus-visible, .ng-prov a:focus-visible, .ng-chip:focus-visible, .ng-calc input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ng-cifras { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .5rem; }
    .ng-k { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ng-v { font-size: var(--fs-body); font-weight: 600; color: var(--text-main); }
    .ng-s { font-size: var(--fs-xs); color: var(--text-muted); }
    .ng-faint { color: var(--text-faint); }
    .ng-warn { color: var(--warn-fg); } .ng-ok { color: var(--ok-fg); } .ng-bad { color: var(--bad-fg); }
    .ng-hist { margin-top: .5rem; }
    .ng-spark { display: block; width: 100%; height: 44px; }
    .ng-l-pag { fill: none; stroke: var(--text-main); stroke-width: 1.75; stroke-linejoin: round; }
    .ng-l-est { stroke: var(--info-fg); stroke-width: 1.5; stroke-dasharray: 4 4; }
    .ng-hist-l { display: flex; flex-wrap: wrap; gap: .1rem .7rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .ng-ln { display: inline-block; width: 14px; height: 0; border-top: 2px solid; vertical-align: middle; margin-right: 4px; }
    .ng-ln-pag { border-color: var(--text-main); } .ng-ln-est { border-color: var(--info-fg); border-top-style: dashed; }
    .ng-decl { font-size: var(--fs-xs); margin-top: .25rem; }
    .ng-calc { margin-top: .5rem; padding-top: .5rem; border-top: 1px solid var(--border-color); }
    .ng-calc-in { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .4rem; font-size: var(--fs-sm); font-weight: 500; }
    .ng-calc input { width: 6rem; height: 1.75rem; padding: .1rem .4rem; text-align: right; font: 600 var(--fs-sm) var(--font-mono);
      font-variant-numeric: tabular-nums; color: var(--text-main); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; }
    .ng-chip { font-family: inherit; font-size: var(--fs-xs); font-weight: 500; color: var(--text-muted); background: transparent; border: 1px solid var(--border-color);
      border-radius: 999px; padding: .1rem .6rem; min-height: 24px; cursor: pointer; }
    .ng-chip:hover { color: var(--text-main); background: var(--overlay-hover); }
    .ng-verbo { font-size: var(--fs-xs); font-weight: 500; font-family: var(--font-body, inherit); }
    .ng-calc-out { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; margin-top: .4rem; }
    .ng-prov { margin: .5rem 0 0; padding-top: .5rem; border-top: 1px solid var(--border-color);
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem .75rem; }
    .ng-prov dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
    .ng-prov dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .ng-prov dd b { font-weight: 600; } .ng-prov dd .ng-s { display: block; }
    @media (pointer: coarse) { .ng-chip { min-height: 44px; } .ng-calc input { height: 44px; } }
    @container (max-width: 40rem) { .ng-cifras, .ng-prov { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `],
})
export class PedidoNegociacionPanelComponent {
  readonly d = input.required<PedidoNegociacionDto>();
  /** Cajas que lleva ESTE producto en el pedido (la suma viva del desglose). */
  readonly cajas = input(0);
  /** «$667 K de $1.28 M» — el pedido típico que ya publica la fila (`[RA-PRO.69]`), no un segundo cálculo. */
  readonly tipico = input<string | null>(null);
  readonly tipicoTitle = input('');
  /** Surtido del proveedor (0–1), el mismo de la fila. */
  readonly surte = input<number | null>(null);
  readonly links = input<EnlacesNegociacion>({ costos: false, descuentos: false, proveedores: false });
  /** `[RA-NEG.3]` Qué detalle abrir en el panel lateral del pedido. */
  readonly abrir = output<'historial' | 'descuentos'>();

  /** El costo por caja que se está probando en la calculadora. `null` = el de hoy. */
  readonly costoProbado = signal<number | null>(null);

  readonly bpc = computed(() => (this.d().base_por_caja && this.d().base_por_caja! > 0 ? this.d().base_por_caja! : null));
  private enCaja(vBase: number | null | undefined): number | null { return vBase == null ? null : vBase * (this.bpc() ?? 1); }
  readonly cajaHoy = computed(() => this.enCaja(this.d().costo.reposicion_base ?? this.d().pagado.ultimo?.costo_base));
  readonly cajaEst = computed(() => this.enCaja(this.d().costo.estandar_base));
  readonly cajaMin = computed(() => this.enCaja(this.d().pagado.minimo?.costo_base));
  readonly unidad = computed(() => '/' + (this.d().unidad_base ?? 'u').toLowerCase());
  readonly margenReal = computed(() => margenSobreCosto(this.d().costo.precio_ficha, this.d().costo.impuesto_pct, this.d().costo.reposicion_base));
  readonly margenBajo = computed(() => {
    const r = this.margenReal(), f = this.d().costo.margen_ficha_pct;
    return r != null && f != null && f - r > 1;
  });
  /** Cajas compradas en 12 meses: lo que pesa «en un año». */
  readonly cajasAnio = computed(() => this.d().pagado.total_base / (this.bpc() ?? 1));
  readonly participacion = computed(() => {
    const c = this.d().proveedor?.compras_12m ?? 0;
    return c > 0 ? (this.d().pagado.total_valor / c) * 100 : null;
  });
  readonly calc = computed(() => {
    const hoy = this.cajaHoy() ?? 0;
    const caja = this.costoProbado() ?? hoy;
    const margen = margenSobreCosto(this.d().costo.precio_ficha, this.d().costo.impuesto_pct, caja > 0 ? caja / (this.bpc() ?? 1) : null);
    return { margen, dif: hoy - caja };
  });

  /** La línea de lo pagado: promedio de cada mes, contra el estándar, en una caja de 100×40. */
  readonly spark = computed(() => {
    const ms = this.d().pagado.meses;
    const est = this.d().costo.estandar_base;
    const vals = [...ms.map((m) => m.promedio), ...(est != null ? [est] : [])];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.15 || 1;
    const y = (v: number) => Math.round((2 + ((hi + pad - v) / (hi - lo + 2 * pad)) * 36) * 100) / 100;
    const x = (i: number) => (ms.length > 1 ? Math.round((i / (ms.length - 1)) * 10000) / 100 : 50);
    return { pts: ms.map((m, i) => `${x(i)},${y(m.promedio)}`).join(' '), est: est != null ? y(est) : null };
  });
  readonly sparkRango = computed(() => {
    const ms = this.d().pagado.meses;
    if (!ms.length) return '';
    const a = ms[0], b = ms[ms.length - 1];
    return ms.length === 1 ? `${this.dinero(a.promedio)} (${this.mes(a.mes)})`
      : `${this.dinero(a.promedio)} (${this.mes(a.mes)}) → ${this.dinero(b.promedio)} (${this.mes(b.mes)})`;
  });
  readonly sparkLabel = computed(() => `Promedio pagado ${this.unidad()} por mes: ${this.sparkRango()}. Estándar ${this.dinero(this.d().costo.estandar_base)}.`);
  readonly plazoKepler = computed(() => {
    const k = (this.d().proveedor?.plazo_kepler ?? []).filter((x) => x.dias != null).map((x) => x.dias as number);
    if (!k.length) return null;
    const lo = Math.min(...k), hi = Math.max(...k);
    return lo === hi ? `${lo} d` : `${lo}–${hi} d`;
  });
  readonly excluidosTxt = computed(() => {
    const p = this.d().pagado, out: string[] = [];
    if (p.renglones_sin_unidad) out.push(`${p.renglones_sin_unidad} renglón(es) con una unidad que la ficha no conoce`);
    if (p.renglones_atipicos) out.push(`${p.renglones_atipicos} con un costo atípico (bonificación o captura)`);
    return out.join(' y ');
  });

  probar(ev: Event): void {
    const v = Number((ev.target as HTMLInputElement).value);
    this.costoProbado.set(Number.isFinite(v) && v > 0 ? v : null);
  }
  fijar(v: number | null): void { this.costoProbado.set(v != null ? Math.round(v * 100) / 100 : null); }

  redondo(v: number | null): number | null { return v == null ? null : Math.round(v * 100) / 100; }
  dinero(v: number | null | undefined): string {
    return v == null ? '—' : '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  dineroCorto(v: number): string {
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + ' M';
    if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3).toLocaleString('es-MX') + ' mil';
    return '$' + Math.round(v).toLocaleString('es-MX');
  }
  /** El ahorro se DICE: «−$5,359» no se entiende solo (DESIGN §Q.2). */
  verbo(dif: number): string { return dif > 0.005 ? 'ahorras ' : dif < -0.005 ? 'pagas de más ' : ''; }
  monto(v: number): string { return '$' + Math.round(Math.abs(v)).toLocaleString('es-MX'); }
  pct(v: number | null | undefined): string { return v == null ? '—' : v.toLocaleString('es-MX', { maximumFractionDigits: 1 }) + ' %'; }
  porBase(v: number | null | undefined): string { return v == null || !this.bpc() ? '' : this.dinero(v) + this.unidad(); }
  cajasTxt(v: number): string { return (Math.round(v * 10) / 10).toLocaleString('es-MX') + (this.bpc() ? ' cj' : ''); }
  mes(m: string): string { return MESES[Number(m.slice(5, 7)) - 1] ?? m; }
  fecha(f: string): string { return `${Number(f.slice(8, 10))}-${this.mes(f.slice(0, 7))}`; }
  /** La plaza por su NOMBRE. `00` acá es lo capturado en oficinas sin plaza resuelta, no el CEDIS. */
  dondeTxt(code: string): string { return code === '00' ? '(oficinas)' : 'en ' + (warehouseName(code) || code); }
}
