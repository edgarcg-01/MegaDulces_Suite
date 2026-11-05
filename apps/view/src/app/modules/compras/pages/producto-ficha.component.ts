import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { esNombreDescontinuado, warehouseName } from '@megadulces/contracts';
import { CatalogoProductosService, FichaProducto } from '../catalogo-productos.service';
import { nombrePropio, nombreProveedor } from '../catalogo-proveedor';
import { CantidadEnUnidad, UnidadFactor, componerEnUnidades } from '../unidades-composicion';
import { ProductoLanzamientoComponent, type VentaPeriodoSucursal } from './producto-lanzamiento.component';
import { PeriodoFichaComponent } from '../components/periodo-ficha.component';
import { PeriodoFicha, fechaCortaPeriodo, textoPeriodo } from '../periodo-ficha';

/**
 * Ficha de un producto, vista Sencillo del Catálogo de Compras. En este orden:
 *   1. Identidad: SKU (copiable), estado, códigos de barras (el principal marcado), proveedor legible.
 *   2. Unidades y precio: una fila por unidad, «Sin precio» donde no hay lista, y si la red coincide.
 *   3. Venta y existencia por sucursal, en unidades compuestas (65 CJA 5 PAQ), con total.
 *   4. Última entrada; su costo sin IVA ni IEPS lo ve quien ve el catálogo (`[PF.12.3]`, la regla de la lista).
 *   `[NP.22]` Entre 2 y 3, si el producto es NUEVO: «Lanzamiento» (`app-producto-lanzamiento`, lo que era el panel
 *   de la pantalla Productos nuevos). Si no lo es, no pinta nada.
 *
 * Jerarquía: primario = el precio por unidad; secundario = venta y existencia por sucursal;
 * terciario = códigos, proveedor, última entrada.
 *
 * Lo que no se midió se declara: «Sin precio», «Sin dato», nunca un cero.
 */

const numFmt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const dineroFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const fechaFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Los numeric de Postgres pueden llegar como string: Number() antes de formatear. */
export const dineroFicha = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? null : dineroFmt.format(Number(v)));
export const numeroFicha = (v: number) => numFmt.format(Number(v));
/** '2026-10-21' (o ISO completo) → «21 oct 2026», sin corrimiento de zona. */
export function fechaFicha(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  return Number.isNaN(d.getTime()) ? null : fechaFmt.format(d);
}

type Existencia =
  | { tipo: 'sin_dato' }
  | { tipo: 'agotado' }
  | { tipo: 'cero'; unidad: string }
  | { tipo: 'partes'; partes: CantidadEnUnidad[] };

interface FilaSucursalVm {
  codigo: string;
  nombre: string;
  monto: string | null;
  vendido: CantidadEnUnidad[];
  existencia: Existencia;
  /** `[PF.23]` Por qué no hay venta que mostrar (nunca un $0): antes de su corte a Kepler, o sin corte. */
  sinVentaPor: string;
}

@Component({
  selector: 'app-producto-ficha',
  standalone: true,
  imports: [TableModule, TagModule, LoadStateComponent, FreshnessPillComponent, ProductoLanzamientoComponent, PeriodoFichaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" [skeletonRows]="8"
                    errorTitle="No se pudo cargar la ficha del producto" (retry)="recargar()">
      @if (vm(); as v) {
        <article class="ficha" [attr.aria-label]="'Ficha de ' + v.nombre">
          <!-- [PF.23] El periodo, arriba de todo (pedido de David). Dice a qué aplica: precio y existencia son de hoy. -->
          <div class="periodo-top">
            <app-periodo-ficha porOmision="mes" [valor]="periodo()" etiqueta="Periodo de la venta" (cambio)="periodo.set($event)" />
            <small class="nota">Aplica a la venta por sucursal · precio y existencia son de hoy</small>
          </div>
          <dl class="ident">
            <div>
              <dt>SKU</dt>
              <dd>
                @if (v.sku) {
                  <span class="mono">{{ v.sku }}</span>
                  <button type="button" class="copiar" (click)="copiar(v.sku)" [attr.aria-label]="'Copiar SKU ' + v.sku">
                    <i class="pi" [class.pi-copy]="copiado() !== v.sku" [class.pi-check]="copiado() === v.sku" aria-hidden="true"></i>
                    {{ copiado() === v.sku ? 'copiado' : 'copiar' }}
                  </button>
                } @else {
                  <span class="sin">Sin SKU</span>
                }
              </dd>
            </div>
            <div>
              <dt>Estado</dt>
              <!-- [PF.20] Kepler marca el descontinuado en el NOMBRE («* DESCONTINUADO»), no en su campo Obsoleto: manda sobre «Activo». -->
              <dd><p-tag [severity]="v.descontinuado || !v.activo ? 'secondary' : 'success'" [value]="v.descontinuado ? 'Descontinuado' : v.activo ? 'Activo' : 'Inactivo'" [rounded]="true" /></dd>
            </div>
            <div>
              <dt>{{ v.codigos.length > 1 ? 'Códigos de barras' : 'Código de barras' }}</dt>
              <dd>
                @if (v.codigos.length) {
                  <span class="cods">
                    @for (c of v.codigos; track c; let i = $index) {
                      <span class="mono">{{ c }}@if (i === 0 && v.codigos.length > 1) {&ngsp;<small class="nota">principal</small> }</span>
                    }
                  </span>
                } @else {
                  <span class="sin">Sin código</span>
                }
              </dd>
            </div>
            <div>
              <dt>Proveedor</dt>
              <dd>
                @if (v.proveedor) { {{ v.proveedor }} } @else { <span class="sin">Sin proveedor</span> }
              </dd>
            </div>
            <!-- [PF.12.3] El costo junto a la identidad: el de la ultima entrada, la misma regla y el mismo numero que la columna Ultimo costo. -->
            @if (v.costoVisible) {
              <div>
                <dt>Último costo</dt>
                <dd>
                  <!-- [PF.22] Por cada unidad (paquete y caja), como el renglon de la lista; sin escalera, el de la entrada. -->
                  @if (v.entrada?.costo && v.entrada!.costos.length) {
                    <span class="costos">@for (c of v.entrada!.costos; track c.unidad) { <span><span class="mono">{{ c.monto }}</span>&ngsp;<span class="ud">por {{ c.unidad }}</span></span>&ngsp;}</span>&ngsp;
                    <small class="nota">{{ v.entrada!.costoNota }}</small>
                  } @else if (v.entrada?.costo; as k) { <span class="mono">{{ k }}</span>&ngsp;<span class="ud">por {{ v.entrada!.unidad }}</span>&ngsp;<small class="nota">{{ v.entrada!.costoNota }}</small> }
                  @else if (v.entrada) { <span class="sin">Sin costo en la entrada</span> }
                  @else { <span class="sin">Sin entradas</span> }
                </dd>
              </div>
            }
            @if (v.descripcion) {
              <div class="ancho"><dt>Descripción</dt><dd>{{ v.descripcion }}</dd></div>
            }
          </dl>

          <!-- [PF.23] «Última entrada» arriba, junto al Último costo que sale de ella (pedido de David, 2026-11-04). -->
          <section class="bloque" aria-labelledby="ficha-ent-t">
            <h3 class="bloque-t" id="ficha-ent-t">Última entrada</h3>
            @if (v.entrada; as e) {
              <dl class="ident ent">
                <div><dt>Fecha</dt><dd>{{ e.fecha }}</dd></div>
                <div><dt>Sucursal</dt><dd>{{ e.sucursal }}</dd></div>
                <div><dt>Cantidad</dt><dd><span class="mono">{{ e.cantidad }}</span>&ngsp;<span class="ud">{{ e.unidad }}</span></dd></div>
              </dl>
            } @else {
              <p class="sin">Sin entradas registradas.</p>
            }
          </section>

          <section class="bloque" aria-labelledby="ficha-up-t">
            <h3 class="bloque-t" id="ficha-up-t">Unidades y precio</h3>
            @if (v.unidades.length) {
              <p-table [value]="v.unidades" class="surf-table surf-table--plain" styleClass="ficha-tabla ficha-up" [tableStyle]="{ width: '100%' }">
                <ng-template #header>
                  <tr class="cab">
                    <th scope="col">Unidad</th>
                    <th scope="col">Equivale a</th>
                    <th scope="col" class="r comm-num">Precio</th>
                    <th scope="col" class="r comm-num">Mayoreo</th>
                  </tr>
                </ng-template>
                <ng-template #body let-u>
                  <tr>
                    <td role="cell" class="c-ud"><span class="ud">{{ u.unidad }}</span></td>
                    <td role="cell" class="equiv" data-label="Equivale a">{{ u.equivale }}</td>
                    <td role="cell" class="r comm-num" data-label="Precio">
                      @if (u.precio) { <span class="precio">{{ u.precio }}</span> } @else { <span class="sin">Sin precio</span> }
                    </td>
                    <td role="cell" class="r comm-num" data-label="Mayoreo">
                      @if (u.mayoreo) {
                        <span class="may">{{ u.mayoreo.precio }}<small class="nota">desde {{ u.mayoreo.desde }}</small></span>
                      } @else {
                        <span class="sin" aria-label="Sin mayoreo">—</span>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="red" [class.red--varia]="v.red.tipo === 'varia'" [class.red--sin]="v.red.tipo === 'sin'">{{ v.red.texto }}</p>
            } @else {
              <p class="sin">Sin unidades registradas.</p>
            }
          </section>

          <!-- [NP.22] Si es un producto nuevo: su lanzamiento (lo que era el panel de Productos nuevos). Si no, no pinta nada. -->
          <!-- [PF.23] Opción A (David, 2026-11-04): en un producto nuevo, sus tarjetas «Por sucursal» llevan la venta del periodo
               y la tabla de abajo (que repetía venta y existencia por sucursal) no se pinta. -->
          <app-producto-lanzamiento [productId]="productId()" [esNuevo]="esNuevo()"
                                    [ventaPeriodo]="ventaPeriodo()" [periodoTexto]="v.periodoTexto"
                                    (conDetalle)="lanzamientoConDetalle.set($event)" />

          @if (!lanzamientoConDetalle()) {

          <section class="bloque" aria-labelledby="ficha-suc-t" [attr.aria-busy]="actualizando() ? 'true' : null" [class.is-act]="actualizando()">
            <div class="bloque-cab">
              <h3 class="bloque-t" id="ficha-suc-t">Venta y existencia por sucursal</h3>
              <!-- [PF.23] El periodo de la VENTA. La existencia es de hoy y no lo sigue (se dice abajo). -->
              <app-freshness-pill measures="fetch" [since]="v.calculadoAl" />
            </div>
            <p class="nota-bloque">Vendido {{ v.periodoTexto }}@if (v.corteVenta) { · última venta el {{ v.corteVenta }}} · la existencia es la de hoy</p>
            @if (v.sucursales.length) {
              <p-table [value]="v.sucursales" class="surf-table surf-table--plain" styleClass="ficha-tabla ficha-suc" [tableStyle]="{ width: '100%' }">
                <ng-template #header>
                  <tr class="cab">
                    <th scope="col">Sucursal</th>
                    <th scope="col" class="r comm-num">Vendido</th>
                    <th scope="col" class="r comm-num">Existencia</th>
                  </tr>
                </ng-template>
                <ng-template #body let-s>
                  <tr>
                    <td role="cell" class="c-suc">{{ s.nombre }}</td>
                    <td role="cell" class="r comm-num" data-label="Vendido">
                      @if (s.monto) {
                        <span class="pila">
                          <span class="precio">{{ s.monto }}</span>
                          @if (s.vendido.length) {
                            <span class="comp comp--bajo">@for (p of s.vendido; track p.unidad) {&ngsp;<span class="cu"><b>{{ num(p.cantidad) }}</b> {{ p.unidad }}</span> }</span>
                          }
                        </span>
                      } @else {
                        <span class="sin">{{ s.sinVentaPor }}</span>
                      }
                    </td>
                    <td role="cell" class="r comm-num" data-label="Existencia">
                      @switch (s.existencia.tipo) {
                        @case ('sin_dato') { <span class="sin">Sin dato</span> }
                        @case ('agotado') { <span class="agotado">Agotado</span> }
                        @case ('cero') { <span class="comp"><span class="cu"><b>0</b> {{ $any(s.existencia).unidad }}</span></span> }
                        @default {
                          <span class="comp">@for (p of $any(s.existencia).partes; track p.unidad) {&ngsp;<span class="cu"><b>{{ num(p.cantidad) }}</b> {{ p.unidad }}</span> }</span>
                        }
                      }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #footer>
                  <tr class="tot">
                    <td role="cell" class="c-suc">Total</td>
                    <td role="cell" class="r comm-num" data-label="Vendido">
                      @if (v.total.monto) {
                        <span class="pila">
                          <span class="precio">{{ v.total.monto }}</span>
                          @if (v.total.vendido.length) {
                            <span class="comp comp--bajo">@for (p of v.total.vendido; track p.unidad) {&ngsp;<span class="cu"><b>{{ num(p.cantidad) }}</b> {{ p.unidad }}</span> }</span>
                          }
                        </span>
                      } @else {
                        <span class="sin">Sin dato</span>
                      }
                    </td>
                    <td role="cell" class="r comm-num" data-label="Existencia">
                      @if (v.total.existencia === null) {
                        <span class="sin">Sin dato</span>
                      } @else if (v.total.existencia.length) {
                        <span class="comp">@for (p of v.total.existencia; track p.unidad) {&ngsp;<span class="cu"><b>{{ num(p.cantidad) }}</b> {{ p.unidad }}</span> }</span>
                      } @else {
                        <span class="comp"><span class="cu"><b>0</b> {{ v.base }}</span></span>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              <!-- [PF.23] El total de venta suma SÓLO las sucursales medibles: se dice cuáles faltan (antes no se decía). -->
              @if (v.total.faltanVenta) {
                <p class="red red--sin">La venta total no incluye {{ v.total.faltanVenta === 1 ? '1 sucursal sin dato' : v.total.faltanVenta + ' sucursales sin dato' }} en el periodo: {{ v.total.faltanVentaNombres }}</p>
              }
              @if (v.total.faltan) {
                <p class="red red--sin">La existencia total no incluye {{ v.total.faltan === 1 ? '1 sucursal sin dato' : v.total.faltan + ' sucursales sin dato' }}: {{ v.total.faltanNombres }}</p>
              }
              @if (v.agotadas) {
                <p class="red red--alerta">Agotado en {{ v.agotadas }} {{ v.agotadas > 1 ? 'sucursales que sí lo venden' : 'sucursal que sí lo vende' }}</p>
              }
            } @else {
              <p class="sin">Sin sucursales con dato de venta o existencia.</p>
            }
          </section>
          }

        </article>
      }
    </app-load-state>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; container-name: ficha; }
    .ficha { display: flex; flex-direction: column; gap: var(--sp-6); color: var(--text-main); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .sin { color: var(--text-faint); font-size: var(--fs-sm); }
    .nota { font-size: var(--fs-xs); color: var(--text-muted); margin-left: var(--sp-1); font-family: var(--font-body); }

    /* 1. Identidad */
    .ident { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4) var(--sp-5); margin: 0; }
    .ident > div { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .ident > div.ancho { grid-column: 1 / -1; }
    .ident dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .ident dd { margin: 0; font-size: var(--fs-body); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; overflow-wrap: anywhere; }
    .cods { display: flex; flex-direction: column; gap: var(--sp-1); }
    .copiar {
      display: inline-flex; align-items: center; gap: var(--sp-1);
      font-size: var(--fs-xs); color: var(--text-muted); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 0 var(--sp-2);
      min-height: 1.5rem; cursor: pointer;
    }
    .copiar:hover { color: var(--text-main); background: var(--overlay-hover); }
    .copiar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .copiar .pi { font-size: var(--fs-xs); }

    /* Bloques */
    .bloque { display: flex; flex-direction: column; min-width: 0; }
    .bloque.is-act p-table { opacity: .55; transition: opacity var(--dur-micro) ease; }
    .periodo-top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
    .periodo-top .nota { margin: 0; }
    .bloque-cab { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
    .bloque-t {
      margin: 0 0 var(--sp-2); font-size: var(--fs-micro); letter-spacing: .07em; text-transform: uppercase;
      color: var(--text-faint); font-weight: var(--fw-bold);
    }
    .nota-bloque { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }

    /* Tablas */
    .r { text-align: right; white-space: nowrap; }
    .costos { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-3); }
    .ud {
      font-family: var(--font-mono); font-weight: var(--fw-bold); font-size: var(--fs-xs);
      padding: 0 var(--sp-2); border-radius: var(--r-sm); background: var(--overlay-hover); border: 1px solid var(--border-color);
    }
    .equiv { color: var(--text-muted); font-size: var(--fs-sm); }
    .precio { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); font-size: var(--fs-body); }
    .may { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pila { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 0; }
    .comp { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 0 var(--sp-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cu { white-space: nowrap; color: var(--text-muted); font-size: var(--fs-xs); }
    .cu b { color: var(--text-main); font-weight: var(--fw-bold); font-size: var(--fs-sm); }
    .comp--bajo .cu b { font-weight: var(--fw-medium); font-size: var(--fs-xs); }
    .agotado { color: var(--bad-fg); font-weight: var(--fw-bold); font-size: var(--fs-sm); }
    .tot td { font-weight: var(--fw-bold); border-top: 1px solid var(--border-color); }

    .red { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); display: flex; align-items: center; gap: var(--sp-2); }
    .red::before { content: ""; flex: none; width: .42rem; height: .42rem; border-radius: var(--r-pill); background: var(--ok-fg); }
    .red--varia::before { background: var(--warn-fg); }
    .red--sin::before { background: transparent; box-shadow: inset 0 0 0 1px var(--text-faint); }
    .red--alerta { color: var(--bad-fg); }
    .red--alerta::before { background: var(--bad-fg); }

    /* Ancho: identidad en 4 columnas */
    @container ficha (min-width: 30rem) {
      .ident { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .ident.ent { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    /* Angosto: un dato por renglón y las tablas apiladas con su etiqueta por celda */
    @container ficha (max-width: 24rem) {
      .ident { grid-template-columns: 1fr; gap: 0; }
      .ident > div {
        flex-direction: row; justify-content: space-between; align-items: center; gap: var(--sp-3);
        padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color);
      }
      .ident > div:last-child { border-bottom: 0; }
      .ident dd { justify-content: flex-end; text-align: right; }
      .ident > div.ancho { flex-direction: column; align-items: flex-start; }
      .ident > div.ancho dd { justify-content: flex-start; text-align: left; }
      .cods { align-items: flex-end; }

      :host ::ng-deep .ficha-tabla table,
      :host ::ng-deep .ficha-tabla tbody,
      :host ::ng-deep .ficha-tabla tfoot { display: block; width: 100%; }
      .cab { display: none; }
      tr:not(.cab) {
        display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--sp-1) var(--sp-3);
        padding: var(--sp-3) 0; border-bottom: 1px solid var(--border-color);
      }
      tr:not(.cab) > td { padding: 0; border: 0; }
      td[data-label] { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); }
      td[data-label]::before { content: attr(data-label); color: var(--text-muted); font-size: var(--fs-xs); font-family: var(--font-body); font-weight: var(--fw-regular); }
      td.equiv[data-label] { grid-column: auto; justify-content: flex-end; }
      td.equiv[data-label]::before { content: none; }
      .tot { border-bottom: 0; }
      .tot td { border-top: 0; }
    }
  `],
})
export class ProductoFichaComponent {
  readonly productId = input.required<string>();
  readonly sucursal = input<string | null>(null);
  /** `[NP.22]` ¿El renglón dice que es nuevo? null = no se sabe (la sección «Lanzamiento» lo pregunta). */
  readonly esNuevo = input<boolean | null>(null);

  private readonly api = inject(CatalogoProductosService);
  private readonly recarga = signal(0);
  readonly copiado = signal<string | null>(null);
  /** `[PF.23]` El periodo de la venta por sucursal; null = el mes en curso (lo de siempre, lo decide el servidor). */
  readonly periodo = signal<PeriodoFicha | null>(null);

  private readonly res = rxResource({
    params: () => ({ id: this.productId(), sucursal: this.sucursal(), periodo: this.periodo(), v: this.recarga() }),
    stream: ({ params }) => (params.periodo
      ? this.api.ficha(params.id, params.sucursal, params.periodo)
      : this.api.ficha(params.id, params.sucursal)),
  });

  /**
   * `[PF.23]` La última ficha recibida DE ESTE producto: al cambiar el periodo, la ficha (y su selector) no se
   * desmonta mientras llega la nueva — si se desmontara, el selector renacería en «Este mes» con los datos de otro
   * periodo. De OTRO producto nunca se conserva (no se muestra la ficha anterior).
   */
  private readonly ultima = linkedSignal<{ f: FichaProducto | undefined; id: string }, FichaProducto | null>({
    source: () => ({ f: this.res.hasValue() ? this.res.value() : undefined, id: this.productId() }),
    computation: (nuevo, previo) => nuevo.f ?? (previo?.value && previo.value.id === nuevo.id ? previo.value : null),
  });
  /** Recargando con datos a la vista (otro periodo): se marca el bloque, no se borra la ficha. */
  readonly actualizando = computed(() => this.res.isLoading() && !!this.ultima());
  readonly cargando = computed(() => this.res.isLoading() && !this.ultima());
  readonly error = computed(() => {
    const e = this.res.error();
    if (!e) return null;
    const msg = (e as { error?: { message?: unknown }; message?: unknown })?.error?.message ?? (e as { message?: unknown })?.message;
    return typeof msg === 'string' && msg ? msg : 'Error de red o del servidor. Intenta de nuevo.';
  });

  readonly vm = computed(() => {
    const f = this.ultima();
    return f ? armarFicha(f) : null;
  });

  /** `[PF.23]` La sección «Lanzamiento» tiene detalle (producto nuevo): su «Por sucursal» reemplaza a la tabla. */
  readonly lanzamientoConDetalle = signal(false);
  /** La venta del periodo por sucursal, ya dicha, para las tarjetas de «Lanzamiento». */
  readonly ventaPeriodo = computed<VentaPeriodoSucursal[] | null>(() => {
    const v = this.vm();
    if (!v) return null;
    return v.sucursales.map((s) => ({
      codigo: s.codigo,
      monto: s.monto,
      unidades: s.vendido.map((p) => `${numeroFicha(p.cantidad)} ${p.unidad}`).join(' '),
      sinVentaPor: s.sinVentaPor,
    }));
  });

  readonly num = numeroFicha;

  recargar(): void {
    this.recarga.update((n) => n + 1);
  }

  copiar(texto: string): void {
    const portapapeles = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!portapapeles?.writeText) return;
    portapapeles.writeText(texto).then(
      () => {
        this.copiado.set(texto);
        setTimeout(() => { if (this.copiado() === texto) this.copiado.set(null); }, 1500);
      },
      () => this.copiado.set(null),
    );
  }
}

/** Todo lo que la plantilla pinta, ya dicho en texto: la plantilla no decide nada. */
export function armarFicha(f: FichaProducto) {
  const factores: UnidadFactor[] = (f.unidades ?? []).map((u) => ({ unidad: u.unidad, factorBase: Number(u.factorBase) }));
  const base = f.unidadBase ?? f.unidades?.find((u) => Number(u.factorBase) === 1)?.unidad ?? '';
  const comp = (q: number) => componerEnUnidades(Number(q), factores);

  const unidades = (f.unidades ?? []).map((u) => ({
    unidad: u.unidad,
    equivale: u.equivale ? `${numeroFicha(u.equivale.cantidad)} ${u.equivale.unidad}` : 'unidad base',
    precio: dineroFicha(u.precio),
    mayoreo: u.mayoreo ? { precio: dineroFicha(u.mayoreo.precio) ?? '', desde: numeroFicha(u.mayoreo.desde) } : null,
  }));

  const pr = f.precioRed;
  const red: { tipo: 'igual' | 'varia' | 'sin'; texto: string } =
    !pr || pr.min === null || pr.max === null || !pr.sucursales
      ? { tipo: 'sin', texto: 'Sin precio de lista en las sucursales para comparar' }
      : Number(pr.min) === Number(pr.max)
        ? { tipo: 'igual', texto: pr.sucursales === 1 ? 'Precio de 1 sucursal' : `Mismo precio en las ${pr.sucursales} sucursales` }
        : { tipo: 'varia', texto: `Varía entre sucursales: ${dineroFicha(pr.min)} a ${dineroFicha(pr.max)}` };

  const sucursales: FilaSucursalVm[] = (f.sucursales ?? []).map((s) => {
    const vendidas = s.vendidoMes ? Number(s.vendidoMes.unidadesBase) : 0;
    const ex = s.existenciaBase === null || s.existenciaBase === undefined ? null : Number(s.existenciaBase);
    const existencia: Existencia =
      ex === null ? { tipo: 'sin_dato' }
        : ex === 0 ? (vendidas > 0 ? { tipo: 'agotado' } : { tipo: 'cero', unidad: base })
          : { tipo: 'partes', partes: comp(ex) };
    return {
      codigo: s.codigo,
      nombre: s.nombre ? nombrePropio(s.nombre) : `Sucursal ${s.codigo}`,
      monto: s.vendidoMes ? dineroFicha(s.vendidoMes.monto) : null,
      vendido: s.vendidoMes ? comp(vendidas) : [],
      existencia,
      sinVentaPor: s.sinCorte ? 'Sin dato: sin corte a Kepler'
        : s.corteKepler ? `Sin dato: en Kepler desde el ${fechaCortaPeriodo(s.corteKepler)}` : 'Sin dato',
    };
  });

  const conVenta = (f.sucursales ?? []).filter((s) => s.vendidoMes);
  const sinExistencia = (f.sucursales ?? []).filter((s) => s.existenciaBase === null || s.existenciaBase === undefined);
  const conExistencia = (f.sucursales ?? []).filter((s) => !sinExistencia.includes(s));
  const total = {
    monto: conVenta.length ? dineroFicha(conVenta.reduce((a, s) => a + Number(s.vendidoMes!.monto), 0)) : null,
    vendido: comp(conVenta.reduce((a, s) => a + Number(s.vendidoMes!.unidadesBase), 0)),
    existencia: conExistencia.length ? comp(conExistencia.reduce((a, s) => a + Number(s.existenciaBase), 0)) : null,
    faltan: sinExistencia.length && conExistencia.length ? sinExistencia.length : 0,
    faltanNombres: sinExistencia.map((s) => (s.nombre ? nombrePropio(s.nombre) : `Sucursal ${s.codigo}`)).join(', '),
    /** `[PF.23]` Sucursales sin venta medible en el periodo (sólo se dice si hay alguna con venta: si no, el total ya dice «Sin dato»). */
    faltanVenta: conVenta.length ? (f.sucursales ?? []).length - conVenta.length : 0,
    faltanVentaNombres: (f.sucursales ?? []).filter((s) => !s.vendidoMes).map((s) => (s.nombre ? nombrePropio(s.nombre) : `Sucursal ${s.codigo}`)).join(', '),
  };
  const agotadas = sucursales.filter((s) => s.existencia.tipo === 'agotado').length;

  const e = f.ultimaEntrada;
  const entrada = e
    ? {
        fecha: fechaFicha(e.fecha) ?? e.fecha,
        // `[PF.23]` Sin nombre del servidor, el resolvedor único (`warehouseName`): «00» es el CEDIS, nunca «Sucursal 00».
        sucursal: e.nombreSucursal ? nombrePropio(e.nombreSucursal) : warehouseName(e.sucursal),
        cantidad: numeroFicha(e.cantidad),
        unidad: e.unidad,
        costo: e.costo === null || e.costo === undefined ? null : dineroFicha(e.costo),
        // `[PF.12.3]` Lo dice el servidor: sin impuestos, o que no se sabe (sin tasa en el renglón).
        costoNota: e.impuesto === 'sin_dato' ? 'sin saber si trae impuestos' : 'sin IVA ni IEPS',
        /** `[PF.22]` El costo en cada unidad (por paquete Y por caja). [] = sólo el de la entrada, en su unidad. */
        costos: (e.porUnidad ?? []).map((c) => ({ unidad: c.unidad, monto: dineroFicha(c.costo) ?? '' })),
      }
    : null;

  return {
    nombre: nombrePropio(f.nombre),
    sku: f.sku,
    activo: !!f.activo,
    /** `[PF.20]` La regla única del contrato, sobre el nombre crudo de Kepler. */
    descontinuado: esNombreDescontinuado(f.nombre),
    codigos: f.codigos ?? [],
    proveedor: f.proveedor ? nombreProveedor(f.proveedor.nombre) : null,
    descripcion: f.descripcion,
    base,
    unidades,
    red,
    sucursales,
    total,
    agotadas,
    corteVenta: fechaFicha(f.corteVenta),
    /** `[PF.23]` «del 1 nov 2026 al 4 nov 2026»; un servidor anterior no lo manda: era el mes en curso. */
    periodoTexto: f.periodo ? textoPeriodo(f.periodo) : 'en el mes',
    entrada,
    /** `[PF.12.3]` Lo decide el servidor (`puedeVerCostoCatalogo`): la misma regla que la columna de la lista. */
    costoVisible: f.costo_visible === true,
    calculadoAl: f.calculado_al,
  };
}
