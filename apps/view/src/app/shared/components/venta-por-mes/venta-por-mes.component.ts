import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import type { MonthlySalesResponse } from '@megadulces/contracts';

/** Una barra de la película: un mes de este año contra el mismo mes del año anterior. */
export interface BarraVentaMes {
  mes: string;
  label: string;
  venta: number;
  /** `null` = ese mes no tiene ningún renglón con la unidad medida: no se dibuja como 0. */
  cajas: number | null;
  parcial: boolean;
  ly: number;
  lyCajas: number | null;
  actual: boolean;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Los últimos 13 meses (12 cerrados + el en curso), cada uno con su mismo mes del año anterior.
 * Es la cuenta del globo de `/compras/pedido` (RA-PRO.65), sacada a una función pura para que la
 * use cualquier pantalla y se pruebe sin montar Angular.
 */
export function barrasVentaPorMes(d: MonthlySalesResponse | null, hoy: Date = new Date()): BarraVentaMes[] {
  if (!d) return [];
  const by = new Map(d.months.map((m) => [m.mes, m]));
  const out: BarraVentaMes[] = [];
  for (let i = 12; i >= 0; i--) {
    const dt = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const kl = `${dt.getFullYear() - 1}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const m = by.get(k), l = by.get(kl);
    out.push({
      mes: k, label: MESES[dt.getMonth()] + (dt.getMonth() === 0 ? ` ${String(dt.getFullYear()).slice(2)}` : ''),
      venta: m?.venta ?? 0, cajas: m ? m.cajas : 0, parcial: !!m?.cajas_parcial,
      ly: l?.venta ?? 0, lyCajas: l ? l.cajas : null, actual: i === 0,
    });
  }
  return out;
}

/**
 * `[AB.41]` **Venta por mes** de un producto: 13 meses en barras (dinero) con las cajas encima,
 * contra el año anterior, más las dos ventanas de referencia (últimos 30 días reales, próximos 30
 * del año anterior, prorrateo 60/40).
 *
 * Es el CONTENIDO del globo; quien lo usa pone el `p-popover` y pide los datos. Nace de copiar el
 * globo de `/compras/pedido` (RA-PRO.65) para Autoabasto: Compras todavía tiene su versión dentro
 * de `compras-pedido-real.component.ts` (deuda con nombre en el tracker, AB.41: adoptar esta pieza).
 */
@Component({
  selector: 'app-venta-por-mes',
  standalone: true,
  imports: [DecimalPipe, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vm">
      <div class="vm-head">
        <strong>Venta por mes</strong>
        <span class="vm-muted">{{ titulo() }}</span>
      </div>
      @if (cargando()) {
        <div class="vm-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando…</div>
      } @else if (error() || !data()) {
        <div class="vm-msg">No se pudo leer la venta por mes. Vuelve a intentar.</div>
      } @else if (!data()!.months.length) {
        <div class="vm-msg">Sin venta registrada en los últimos 24 meses.</div>
      } @else {
        <div class="vm-bars" role="img" [attr.aria-label]="'Venta por mes, 13 meses, de ' + titulo()">
          @for (bar of barras(); track bar.mes) {
            <div class="vm-col" [class.vm-now]="bar.actual" [title]="tituloBarra(bar)">
              <div class="vm-track">
                <span class="vm-ly" [style.height.%]="pct(bar.ly)"></span>
                <span class="vm-cy" [style.height.%]="pct(bar.venta)"></span>
              </div>
              <span class="vm-cj">@if (bar.cajas != null) { {{ bar.cajas | number:'1.0-0' }}@if (bar.parcial) {*} } @else { ? }</span>
              <span class="vm-lbl">{{ bar.label }}</span>
            </div>
          }
        </div>
        <div class="vm-leg">
          <span><i class="vm-sw vm-sw-cy"></i>este año</span>
          <span><i class="vm-sw vm-sw-ly"></i>año anterior</span>
          <span class="vm-muted">barra = venta en $ · número = cajas</span>
        </div>
        @if (data()!.window; as w) {
          <dl class="vm-kv">
            <dt pTooltip="La venta real de los últimos 30 días naturales, sumada día por día, de todos los canales. No es el mismo número que la columna de la tabla: ésa es la demanda del motor, que mide una ventana propia por sucursal (anclada a su última venta) y reconstruye las piezas por precio." tooltipPosition="left">Últimos 30 días (venta real)</dt>
            <dd>{{ w.v30_cajas | number:'1.0-1' }} cj@if (w.v30_parcial) {*}</dd>
            @if (vta() != null) {
              <dt pTooltip="Lo que muestra la columna: la demanda diaria del motor, por 30. Difiere de la venta real por la ventana (propia de cada sucursal), por reconstruir las piezas por precio y por el freno de fin de pico." tooltipPosition="left">{{ rotuloColumna() }}</dt>
              <dd>{{ vta() | number:'1.0-1' }} cj</dd>
            }
            <dt>Próximos 30 días, año anterior</dt>
            <dd>@if (w.ly_next30_cajas != null) { {{ w.ly_next30_cajas | number:'1.0-1' }} cj } @else { <span class="vm-muted">{{ lyMotivo(w.ly_motivo) }}</span> }</dd>
            <dt pTooltip="Regla del sistema anterior: 60% de lo vendido en los últimos 30 días + 40% de lo que se vendió los próximos 30 días del año pasado. Es una referencia: el pedido lo calcula el motor." tooltipPosition="left">Prorrateo 60/40 (sistema anterior)</dt>
            <dd>@if (w.prorrateo_60_40 != null) { <strong>{{ w.prorrateo_60_40 | number:'1.0-1' }} cj</strong> } @else { — }</dd>
            @if (data()!.warehouse) {
              <dt>Máximo de la sucursal</dt>
              <dd>@if (mx() != null) { {{ mx() | number:'1.0-1' }} cj } @else { <span class="vm-muted">sin política de reorden</span> }</dd>
            }
          </dl>
        }
        @if (parcial()) {
          <p class="vm-note">* parte de la venta de ese mes no trae la unidad medida (Wincaja): las cajas salen cortas; la barra en $ sí está completa.</p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .vm { width: min(30rem, 86vw); font-size: var(--fs-sm); }
    .vm-head { display: flex; flex-direction: column; gap: .1rem; margin-bottom: .6rem; }
    .vm-muted { color: var(--text-muted); }
    .vm-msg { color: var(--text-muted); padding: 1rem 0; }
    .vm-bars { display: grid; grid-template-columns: repeat(13, 1fr); gap: .25rem; align-items: end; }
    .vm-col { display: flex; flex-direction: column; align-items: center; gap: .15rem; min-width: 0; }
    .vm-track { position: relative; width: 100%; height: 5.5rem; display: flex; align-items: flex-end; justify-content: center; }
    .vm-ly, .vm-cy { position: absolute; bottom: 0; border-radius: 3px 3px 0 0; }
    .vm-ly { width: 100%; background: var(--border-color); }
    .vm-cy { width: 55%; background: var(--action); }
    .vm-now .vm-cy { opacity: .55; }   /* mes en curso: incompleto, se ve más tenue */
    .vm-cj { font-size: var(--fs-nano); font-variant-numeric: tabular-nums; color: var(--text-main); }
    .vm-lbl { font-size: var(--fs-nano); color: var(--text-faint); white-space: nowrap; }
    .vm-leg { display: flex; gap: .75rem; flex-wrap: wrap; margin: .5rem 0; font-size: var(--fs-micro); }
    .vm-sw { display: inline-block; width: .6rem; height: .6rem; border-radius: 2px; margin-right: .25rem; vertical-align: -1px; }
    .vm-sw-cy { background: var(--action); } .vm-sw-ly { background: var(--border-color); }
    .vm-kv { display: grid; grid-template-columns: 1fr auto; gap: .2rem .75rem; margin: .25rem 0 0;
      padding-top: .5rem; border-top: 1px solid var(--border-color); }
    .vm-kv dt { color: var(--text-muted); } .vm-kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .vm-note { font-size: var(--fs-micro); color: var(--text-faint); margin: .5rem 0 0; }
  `],
})
export class VentaPorMesComponent {
  /** Producto y lugar, p. ej. «97245 · Padre Hidalgo». */
  readonly titulo = input<string>('');
  readonly data = input<MonthlySalesResponse | null>(null);
  readonly cargando = input(false);
  readonly error = input(false);
  /** Lo que dice la columna de la que se abrió (cajas), para mostrar las dos medidas lado a lado. */
  readonly vta = input<number | null>(null);
  readonly rotuloColumna = input('Venta 30 d de la tabla (demanda × 30)');
  /** Máximo de la política del almacén, en cajas. */
  readonly mx = input<number | null>(null);

  readonly barras = computed(() => barrasVentaPorMes(this.data()));
  private readonly maximo = computed(() => Math.max(1, ...this.barras().flatMap((b) => [b.venta, b.ly])));
  readonly parcial = computed(() => this.barras().some((b) => b.parcial) || !!this.data()?.window?.v30_parcial);

  /** Altura de barra en % del mes más alto de la ventana (este año o el anterior). */
  pct(v: number): number { return Math.round((v / this.maximo()) * 100); }

  tituloBarra(b: BarraVentaMes): string {
    const $ = (v: number) => v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
    const cj = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 1 });
    return `${b.label}: ${$(b.venta)}${b.cajas != null ? ` · ${cj(b.cajas)} cj` : ' · cajas sin medir'}${b.parcial ? ' (parcial)' : ''}`
      + ` — año anterior ${$(b.ly)}${b.lyCajas != null ? ` · ${cj(b.lyCajas)} cj` : ''}${b.actual ? ' — mes en curso' : ''}`;
  }

  lyMotivo(m: string | null | undefined): string {
    return m === 'peldano_no_medido' ? 'el año anterior no tiene la unidad medida' : 'sin venta registrada el año anterior';
  }
}
