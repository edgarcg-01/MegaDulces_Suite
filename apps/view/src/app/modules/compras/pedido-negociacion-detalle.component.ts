import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type PedidoNegociacionDto, warehouseName } from '@megadulces/contracts';

/**
 * `[RA-NEG.3]` El detalle del panel «Costo y negociación», DENTRO de `/compras/pedido` (panel lateral).
 *
 * Pedido del PM (2026-10-22): *«si quiero ver historial o descuentos me saca del pedido y eso hace que
 * mi pedido se pierda; todo debe ser accesible desde la interfaz principal»* y *«desglósame un poco más
 * qué es el costo estándar»*. Antes, «Historial ›» y «Descuentos ›» eran rutas a otras pantallas.
 *
 * Sólo PRESENTA lo que ya trae `GET commercial/replenishment/negociacion/:productId`: no pide nada.
 */
@Component({
  selector: 'app-pedido-negociacion-detalle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (vista() === 'historial') {
      <section class="nd" aria-labelledby="nd-costos">
        <h3 id="nd-costos" class="nd-h">Los tres costos de este producto</h3>
        <dl class="nd-tres">
          <div>
            <dt>Costo estándar <span class="num">{{ dinero(d().costo.estandar_base) }}{{ u() }}</span>@if (bpc()) { <span class="nd-dim">· {{ dinero(caja(d().costo.estandar_base)) }} la caja</span> }</dt>
            <dd>Es el costo que tiene <b>capturado la ficha del producto en Kepler</b>. No es un promedio ni cambia con cada
              compra: cambia de golpe cuando alguien edita la ficha. <b>Es el que fija el precio:</b>
              precio = estándar × (1 + margen de la ficha) × (1 + impuesto).
              @if (formula(); as f) { <span class="nd-formula num">{{ f }}</span> }
              Por eso, si el estándar se queda abajo de lo que pagas, la ficha anuncia un margen que no existe.</dd>
          </div>
          <div>
            <dt>Costo de hoy (reposición) <span class="num">{{ dinero(d().costo.reposicion_base) }}{{ u() }}</span></dt>
            <dd>Lo que costó la <b>última entrada</b> en Kepler. Es con el que se valúa este pedido y contra el que se
              calcula el margen real.</dd>
          </div>
          <div>
            <dt>Lo pagado <span class="num">{{ promedio() }}{{ u() }}</span> <span class="nd-dim">promedio de 12 meses</span></dt>
            <dd>El promedio de lo que le pagaste al proveedor en sus entradas, abajo una por una.</dd>
          </div>
        </dl>
        @if (brecha(); as b) {
          <p class="nd-aviso">Hoy pagas <b class="num">{{ b.pct }}</b> más que el estándar: la ficha calcula
            <b>{{ pct(d().costo.margen_ficha_pct) }}</b> de margen y el real es <b>{{ pct(b.margenReal) }}</b>.</p>
        }

        <h3 class="nd-h">Lo pagado por mes</h3>
        <table class="nd-t">
          <thead><tr><th>Mes</th><th class="r">Recibido</th><th class="r">Promedio</th><th class="r">Mín.</th><th class="r">Máx.</th></tr></thead>
          <tbody>
            @for (m of mesesDesc(); track m.mes) {
              <tr><td>{{ mes(m.mes) }}</td><td class="r num">{{ cant(m.base) }} {{ ub() }}</td><td class="r num">{{ dinero(m.promedio) }}</td>
                <td class="r num">{{ dinero(m.min) }}</td><td class="r num">{{ dinero(m.max) }}</td></tr>
            } @empty { <tr><td colspan="5" class="nd-dim">Sin compras a este proveedor en 12 meses.</td></tr> }
          </tbody>
        </table>

        <h3 class="nd-h">Las últimas entradas <span class="nd-dim">({{ d().pagado.entradas.length }} de {{ d().pagado.renglones }} renglones)</span></h3>
        <table class="nd-t">
          <thead><tr><th>Fecha</th><th>Sucursal</th><th class="r">Cantidad</th><th class="r">Costo{{ u() }}</th><th class="r">vs estándar</th></tr></thead>
          <tbody>
            @for (e of d().pagado.entradas; track $index) {
              <tr [class.nd-est]="vsEst(e.costo_base) === 0">
                <td>{{ fecha(e.fecha) }}</td><td>{{ suc(e.sucursal) }}</td>
                <td class="r num">{{ cant(e.base) }} {{ ub() }}</td><td class="r num">{{ dinero(e.costo_base) }}</td>
                <td class="r num">{{ vsEstTxt(e.costo_base) }}</td>
              </tr>
            } @empty { <tr><td colspan="5" class="nd-dim">Sin entradas en 12 meses.</td></tr> }
          </tbody>
        </table>
        @if (d().pagado.renglones_sin_unidad || d().pagado.renglones_atipicos) {
          <p class="nd-dim">Fuera de la lista y de los promedios: {{ d().pagado.renglones_sin_unidad }} en una unidad que la ficha no
            conoce y {{ d().pagado.renglones_atipicos }} con un costo atípico (bonificación o captura).</p>
        }
      </section>
    } @else {
      @if (d().proveedor; as p) {
        <section class="nd" aria-labelledby="nd-desc">
          <h3 id="nd-desc" class="nd-h">Lo que te descontó {{ p.nombre }} en 12 meses</h3>
          <dl class="nd-kv">
            <div><dt>Compras</dt><dd class="num">{{ dinero(p.compras_12m) }}</dd></div>
            <div><dt>Descuento por pronto pago</dt><dd class="num">{{ dinero(p.descuento_pago_12m) }}</dd></div>
            <div><dt>Notas de crédito comerciales</dt><dd class="num">{{ dinero(p.descuento_notas_12m) }}</dd></div>
            <div><dt>Descuento total</dt><dd class="num"><b>{{ pct(p.descuento_pct) }}</b> de lo comprado</dd></div>
          </dl>
          @if (p.pronto_pago; as pp) {
            <h3 class="nd-h">Pronto pago que no se tomó</h3>
            <p>De <b>{{ pp.pagos }}</b> pagos, <b>{{ pp.sin_descuento }}</b> salieron sin descuento por
              <b class="num">{{ dinero(pp.monto_sin_descuento) }}</b>. Con la tasa de <b>{{ pct(pp.tasa * 100) }}</b> eso son
              <b class="num">≈ {{ dinero(pp.estimado_perdido) }}</b>.</p>
            <p class="nd-dim">{{ pp.fuente === 'observed' ? 'La tasa es OBSERVADA: sale de los pagos que sí llevaron descuento, no de un contrato. Es un estimado.' : 'La tasa está capturada en la política del proveedor.' }}</p>
            @if (pp.ultimos_sin_descuento; as l) {
              <table class="nd-t">
                <thead><tr><th>Fecha</th><th>Sucursal</th><th>Folio</th><th class="r">Pago</th><th class="r">Descuento esperado</th></tr></thead>
                <tbody>
                  @for (x of l; track x.folio + x.sucursal) {
                    <tr><td>{{ fecha(x.fecha) }}</td><td>{{ suc(x.sucursal) }}</td><td class="num">{{ x.folio }}</td>
                      <td class="r num">{{ dinero(x.monto) }}</td><td class="r num">{{ dinero(x.monto * pp.tasa) }}</td></tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="nd-dim">La lista de pagos la ve quien tiene permiso de Descuentos.</p>
            }
          } @else {
            <p class="nd-dim">Este proveedor no tiene tasa de pronto pago: o no la da, o nadie la ha medido.</p>
          }
        </section>
      } @else {
        <p class="nd-dim">El producto no tiene proveedor en el catálogo.</p>
      }
    }
  `,
  styles: [`
    :host { display: block; }
    .nd { display: grid; gap: .6rem; font-size: var(--fs-sm); color: var(--text-main); }
    .nd-h { margin: .4rem 0 0; font-size: var(--fs-sm); font-weight: 600; }
    .nd-dim { color: var(--text-muted); font-weight: 400; font-size: var(--fs-xs); }
    .num { font-variant-numeric: tabular-nums; }
    .r { text-align: right; }
    .nd-tres { margin: 0; display: grid; gap: .6rem; }
    .nd-tres dt { font-weight: 600; }
    .nd-tres dd { margin: .15rem 0 0; color: var(--text-muted); line-height: 1.45; }
    .nd-tres dd b { color: var(--text-main); font-weight: 600; }
    .nd-formula { display: block; margin: .3rem 0; padding: .3rem .5rem; border-radius: 6px; background: var(--surface-ground); color: var(--text-main); }
    .nd-aviso { margin: 0; padding: .45rem .6rem; border-left: 3px solid var(--warn-fg); background: var(--surface-ground); border-radius: 0 6px 6px 0; }
    .nd-t { width: 100%; border-collapse: collapse; }
    .nd-t th { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 600;
      text-align: left; padding: .25rem .35rem; border-bottom: 1px solid var(--border-color); }
    .nd-t th.r { text-align: right; }
    .nd-t td { padding: .25rem .35rem; border-bottom: 1px solid var(--border-color); }
    .nd-t tr.nd-est td { color: var(--info-fg); }
    .nd-kv { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: .4rem .8rem; }
    .nd-kv dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
    .nd-kv dd { margin: 0; }
  `],
})
export class PedidoNegociacionDetalleComponent {
  readonly d = input.required<PedidoNegociacionDto>();
  readonly vista = input<'historial' | 'descuentos'>('historial');

  readonly bpc = computed(() => (this.d().base_por_caja && this.d().base_por_caja! > 1 ? this.d().base_por_caja! : null));
  readonly ub = computed(() => (this.d().unidad_base ?? '').toLowerCase());
  readonly u = computed(() => (this.d().unidad_base ? '/' + this.ub() : ''));
  readonly mesesDesc = computed(() => [...this.d().pagado.meses].reverse());
  readonly promedio = computed(() => {
    const p = this.d().pagado;
    return p.total_base > 0 ? this.dinero(p.total_valor / p.total_base) : '—';
  });
  /** La fórmula de Kepler con los números de ESTE producto, para que se vea de dónde sale el precio. */
  readonly formula = computed(() => {
    const c = this.d().costo;
    if (c.estandar_base == null || c.margen_ficha_pct == null || c.impuesto_pct == null || c.precio_ficha == null) return null;
    const m = 1 + c.margen_ficha_pct / 100, i = 1 + c.impuesto_pct / 100;
    return `${this.dinero(c.estandar_base)} × ${m.toFixed(4)} × ${i.toFixed(2)} = ${this.dinero(c.estandar_base * m * i)} (la ficha dice ${this.dinero(c.precio_ficha)})`;
  });
  readonly brecha = computed(() => {
    const c = this.d().costo;
    if (c.estandar_base == null || c.reposicion_base == null || !(c.estandar_base > 0) || c.reposicion_base - c.estandar_base <= 0.005) return null;
    const margenReal = c.precio_ficha != null && c.impuesto_pct != null ? (c.precio_ficha / (1 + c.impuesto_pct / 100) / c.reposicion_base - 1) * 100 : null;
    return { pct: ((c.reposicion_base / c.estandar_base - 1) * 100).toFixed(1) + ' %', margenReal };
  });

  caja(v: number | null): number | null { return v == null || !this.bpc() ? null : v * this.bpc()!; }
  vsEst(costo: number): number | null {
    const e = this.d().costo.estandar_base;
    if (e == null || !(e > 0)) return null;
    return Math.abs(costo - e) <= 0.005 ? 0 : (costo / e - 1) * 100;
  }
  vsEstTxt(costo: number): string {
    const v = this.vsEst(costo);
    return v == null ? '—' : v === 0 ? 'igual' : (v > 0 ? '+' : '') + v.toFixed(1) + ' %';
  }
  dinero(v: number | null | undefined): string {
    return v == null ? '—' : '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  pct(v: number | null | undefined): string { return v == null ? '—' : v.toLocaleString('es-MX', { maximumFractionDigits: 1 }) + ' %'; }
  cant(v: number): string { return v.toLocaleString('es-MX', { maximumFractionDigits: 2 }); }
  mes(m: string): string {
    return ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  }
  fecha(f: string): string { return `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(2, 4)}`; }
  /** La plaza por su NOMBRE. `00` acá es lo capturado en oficinas sin plaza resuelta, no el CEDIS. */
  suc(code: string): string { return code === '00' ? 'oficinas' : warehouseName(code) || code; }
}
