import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, map, of, switchMap, tap } from 'rxjs';
import { TableModule } from 'primeng/table';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import {
  ExistenciaHistorico,
  ExistenciaHistoricoDetalle,
  HISTORICO_DIAS_POR_VISTA,
  HistoricoAlmacen,
  HistoricoCelda,
  HistoricoDetalleProducto,
  HistoricoDia,
  HistoricoTotal,
  HistoricoVista,
  cierresDeVista,
  sumarDias,
  warehouseName,
} from '@megadulces/contracts';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ExistenciaHistoricoApiService } from '../existencia-historico.service';

/** Una fila de la tabla: una sucursal con sus celdas en el orden de las columnas. */
interface FilaSucursal {
  almacen: HistoricoAlmacen;
  nombre: string;
  celdas: HistoricoCelda[];
  /** Renglones sin valuar en el último cierre con valor: se dice UNA vez por sucursal, no en cada celda. */
  sinValuar: number | null;
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const MXN2 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 });
const DIA_CORTO = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
const DIA_CORTO_ANIO = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
const DIA_LARGO = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const DIA_LARGO_ANIO = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** `YYYY-MM-DD` de hoy en la zona de México: el día del negocio, no el del navegador. */
function hoyMx(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}
/** Un `Date` local del selector → `YYYY-MM-DD` (la fecha que eligió la persona, sin zona). */
function aIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** `YYYY-MM-DD` → `Date` local a medianoche, para el selector. */
function aDate(f: string): Date {
  const [y, m, d] = f.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** Lo que no tiene foto ese día: no se sabe, no es cero. */
function sinFoto(c: HistoricoCelda): boolean {
  return c.estado === 'sin_foto' || c.estado === 'pendiente';
}

/**
 * `[EX.H2]` «Consulta históricos» — cuánto valía el inventario de cada sucursal al cierre de cada
 * día, a costo estándar de Kepler sin impuesto (D1 de Francisco, 2026-11-06). Se abre desde el botón
 * de Existencia y reemplaza la hoja de Google de Compras: el MISMO acomodo (sucursal en renglones,
 * cierres en columnas, total abajo) para que se reconozca a la primera.
 *
 * Las doce preguntas de `diseno` §0a, contestadas por escrito en el tracker (`[EX.H2]`). Lo que
 * gobierna la plantilla:
 *  · Nivel 0: la franja (valor al último cierre, cambio en el rango, cierres completos, renglones sin
 *    valuar) y la tabla. Nada que no decida se ve: ni unidades sumadas, ni el valor con IEPS, ni
 *    códigos de sucursal (se NOMBRAN con el resolvedor común), ni MD-32.
 *  · Cada cifra se abre: una celda → el panel con sus productos (el mismo dato, mismo total).
 *  · Lo que no se sabe se DICE en la celda: sin foto, pendiente (hoy antes de las 23:50), no
 *    confiable (CEDIS antes de que la foto leyera el ERP), sin valor. Nunca $0 en su lugar.
 *  · El total del día suma sólo lo medido y NOMBRA lo que quedó fuera (texto, no sólo color).
 *  · ⛔ Revisión adversarial (2026-11-06): las columnas se arman con la vista CON LA QUE SE PIDIÓ el
 *    dato (no la recién elegida), la recarga se ve («Actualizando…»), la franja declara lo
 *    reconstruido y lo parcial, y el paginador del panel lleva su total y su página.
 */
@Component({
  selector: 'app-almacen-existencia-historico',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, TableModule, DatePickerModule, MultiSelectModule, InputTextModule, IconFieldModule,
    InputIconModule, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent, SidePeekComponent,
    LoadStateComponent, SegmentedComponent,
  ],
  template: `
    <section class="surf-page hx">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <a class="hx-volver" [routerLink]="volverA" aria-label="Volver a Existencia">
            <i class="pi pi-arrow-left" aria-hidden="true"></i> Existencia
          </a>
          <h1>Consulta históricos</h1>
          <p class="surf-page-sub">
            Cuánto valía el inventario de cada sucursal al cierre de cada día, a costo estándar de Kepler sin impuesto.
          </p>
        </div>
        <div class="hx-acciones">
          @if (ultimaFotoTs(); as ts) {
            <app-freshness-pill measures="data" [since]="ts" label="Última foto" [staleAfterSec]="129600" />
          }
          <app-context-help topic="existencia-historico" />
        </div>
      </header>

      <div class="hx-filtros" role="group" aria-label="Filtros de la consulta">
        <app-segmented [options]="vistas" [value]="vista()" (valueChange)="cambiarVista($event)" ariaLabel="Ver por" />
        <p-datepicker selectionMode="range" [ngModel]="rangoSel()" (ngModelChange)="cambiarRango($event)"
                      (onClose)="alCerrarRango()" dateFormat="dd/mm/yy" [maxDate]="hoyDate" [readonlyInput]="true"
                      [showIcon]="true" appendTo="body" inputId="hx-rango" ariaLabel="Rango de fechas" />
        <p-multiselect [options]="opcionesSucursal()" [ngModel]="sucursalesSel()" (ngModelChange)="cambiarSucursales($event)"
                       optionLabel="label" optionValue="value" placeholder="Todas las sucursales"
                       [showToggleAll]="true" [filter]="false" appendTo="body" ariaLabel="Sucursales"
                       selectedItemsLabel="{0} sucursales" [maxSelectedLabels]="2" class="hx-suc" />
        @if (cargando() && datos()) {
          <span class="hx-actualizando-txt" role="status">
            <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Actualizando…
          </span>
        }
      </div>

      @if (fotoFallida(); as nota) {
        <p class="hx-aviso hx-aviso--mal" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>La última foto de inventario no se tomó bien: {{ nota }}</span>
        </p>
      }

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!!datos() && !filas().length"
                      emptyIcon="pi-history" emptyTitle="Sin fotos de inventario en este rango"
                      [emptyHint]="pistaVacio()" (retry)="cargar()">
        @if (datos(); as d) {
          <div [class.hx-actualizando]="cargando()" [attr.aria-busy]="cargando()">
            <app-metric-strip [items]="kpis()" ariaLabel="Resumen del rango" />

            <div class="hx-avisos">
              <p class="hx-aviso">
                <i class="pi pi-dollar" aria-hidden="true"></i>
                <span>{{ textoMetodo() }}</span>
              </p>
              @if (hayNoConfiable()) {
                <p class="hx-aviso">
                  <i class="pi pi-ban" aria-hidden="true"></i>
                  <span>CEDIS: antes de que la foto leyera la existencia del ERP repetía un saldo congelado. Esos días se marcan «no confiable» y no entran al total.</span>
                </p>
              }
              @if (d.rango.ajustado && d.rango.motivo) {
                <p class="hx-aviso" role="status">
                  <i class="pi pi-info-circle" aria-hidden="true"></i>
                  <span>Se ajustó el rango: {{ d.rango.motivo }}.</span>
                </p>
              }
            </div>

            <p-table [value]="filas()" [scrollable]="true" dataKey="almacen.code"
                     class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first hx-tabla"
                     [tableStyle]="{ 'min-width': 'max-content' }">
              <ng-template #header>
                <tr>
                  <th scope="col" class="hx-col-suc">Sucursal</th>
                  @for (col of columnas(); track col.fecha) {
                    <th scope="col" class="comm-num">
                      {{ etiquetaColumna(col.fecha) }}
                      @if (col.cierre_mes) { <span class="hx-marca">fin de mes</span> }
                    </th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-fila>
                <tr>
                  <th scope="row" class="hx-suc-nombre">
                    {{ fila.nombre }}
                    @if (fila.sinValuar) { <span class="hx-sv hx-sv--izq">{{ fila.sinValuar }} sin valuar</span> }
                  </th>
                  @for (c of fila.celdas; track $index) {
                    <td class="comm-num">
                      @switch (c.estado) {
                        @case ('medido') {
                          <button type="button" class="hx-cel" (click)="abrir(fila, columnas()[$index], $event)"
                                  [attr.aria-label]="etiquetaCelda(fila.nombre, columnas()[$index].fecha, c)">
                            @if (c.valor_estandar !== null) {
                              {{ dinero(c.valor_estandar) }}
                            } @else {
                              <span class="hx-estado">sin valor</span>
                            }
                          </button>
                        }
                        @case ('no_confiable') {
                          <button type="button" class="hx-cel hx-cel--tenue" (click)="abrir(fila, columnas()[$index], $event)"
                                  [attr.aria-label]="fila.nombre + ', ' + fechaLarga(columnas()[$index].fecha) + ': no confiable, no entra al total. Abrir el desglose.'">
                            <i class="pi pi-ban" aria-hidden="true"></i> no confiable
                          </button>
                        }
                        @case ('pendiente') {
                          <span class="hx-estado">pendiente<span class="hx-sr">: {{ c.motivo }}</span></span>
                        }
                        @default {
                          <span class="hx-estado">sin foto<span class="hx-sr">: {{ c.motivo }}</span></span>
                        }
                      }
                    </td>
                  }
                </tr>
              </ng-template>
              <ng-template #footer>
                <tr class="hx-total">
                  <th scope="row" class="hx-suc-nombre">Total</th>
                  @for (t of totales(); track $index) {
                    <td class="comm-num">
                      @if (t.valor_estandar !== null) {
                        <strong>{{ dinero(t.valor_estandar) }}</strong>
                        @if (!t.todos_los_almacenes) {
                          <span class="hx-parcial">
                            <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ textoFueraCorto(t) }}
                          </span>
                        }
                        @if (t.productos_sin_valuar) {
                          <span class="hx-sv">+{{ t.productos_sin_valuar }} sin valuar</span>
                        }
                      } @else {
                        <span class="hx-estado">—<span class="hx-sr">sin total: ninguna sucursal medida</span></span>
                      }
                    </td>
                  }
                </tr>
              </ng-template>
            </p-table>
          </div>
        }
      </app-load-state>

      <app-side-peek [open]="peekAbierto()" (openChange)="alCambiarPanel($event)"
                     [title]="peekTitulo()" [subtitle]="peekSub()" [width]="760">
        <app-load-state [loading]="cargandoDetalle()" [error]="errorDetalle()"
                        [isEmpty]="!!detalle() && !detalle()!.productos.length"
                        emptyIcon="pi-inbox" emptyTitle="Sin productos con existencia ese día"
                        [emptyHint]="detalle()?.motivo ?? null" (retry)="recargarDetalle()">
          @if (detalle(); as det) {
            @if (det.motivo) {
              <p class="hx-aviso"><i class="pi pi-info-circle" aria-hidden="true"></i><span>{{ det.motivo }}</span></p>
            }
            <p class="hx-resumen">
              @if (det.estado === 'no_confiable') {
                <strong class="hx-estado"><i class="pi pi-ban" aria-hidden="true"></i> no confiable</strong>
                @if (det.valor_estandar !== null) {
                  <span>saldo congelado valuado en {{ dinero(det.valor_estandar) }}: no es su existencia de ese día</span>
                }
              } @else {
                <strong class="comm-num">{{ det.valor_estandar !== null ? dinero(det.valor_estandar) : 'sin valor' }}</strong>
              }
              <span>{{ numero(det.productos.length) }} productos con existencia</span>
              @if (det.productos_sin_valuar) { <span>· {{ det.productos_sin_valuar }} sin valuar (no suman)</span> }
              @if (det.costo_reconstruido) { <span>· costo reconstruido con la historia del estándar</span> }
            </p>
            <div class="hx-det-filtros">
              @if (det.productos_sin_valuar) {
                <app-segmented [options]="opcionesDetalle()" [value]="soloSinValuar() ? 'sin' : 'todos'"
                               (valueChange)="filtrarSinValuar($event === 'sin')" ariaLabel="Qué productos ver" />
              }
              <p-iconfield class="hx-buscar">
                <p-inputicon class="pi pi-search" />
                <input pInputText type="search" [ngModel]="busqueda()" (ngModelChange)="buscar($event)"
                       placeholder="Buscar por SKU o nombre" aria-label="Buscar producto" />
              </p-iconfield>
            </div>
            <p-table [value]="productosVisibles()" [paginator]="productosVisibles().length > 50" [rows]="50"
                     [totalRecords]="productosVisibles().length" [first]="primeraFila()" (firstChange)="primeraFila.set($event ?? 0)"
                     dataKey="product_id" class="surf-table surf-table--plain surf-table--sticky hx-tabla-det">
              <ng-template #header>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Producto</th>
                  <th scope="col" class="comm-num">Existencia</th>
                  <th scope="col" class="comm-num">Costo estándar</th>
                  <th scope="col" class="comm-num">Valor</th>
                </tr>
              </ng-template>
              <ng-template #body let-p>
                <tr>
                  <td class="hx-sku">{{ p.sku }}</td>
                  <td>{{ p.nombre }}</td>
                  <td class="comm-num hx-nowrap">
                    {{ numero(p.unidades) }}
                    @if (p.unidad) { <span class="hx-unidad">{{ p.unidad }}</span> }
                  </td>
                  <td class="comm-num">
                    @if (p.costo_estandar !== null) {
                      {{ dinero2(p.costo_estandar) }}
                      @if (p.costo_posterior) {
                        <i class="pi pi-history hx-posterior" aria-hidden="true"></i>
                        <span class="hx-sr">estándar posterior a ese día</span>
                      }
                    } @else {
                      <span class="hx-estado">—</span>
                    }
                  </td>
                  <td class="comm-num">
                    @if (p.valor !== null) { {{ dinero2(p.valor) }} }
                    @else { <span class="hx-estado">{{ textoSinValor(p) }}</span> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="5" class="hx-estado">Ningún producto coincide con «{{ busqueda() }}».</td></tr>
              </ng-template>
            </p-table>
          }
        </app-load-state>
      </app-side-peek>
    </section>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .hx-volver { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); text-decoration: none; margin-bottom: var(--sp-1); }
    .hx-volver:hover { color: var(--text-main); }
    .hx-volver:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .hx-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .hx-filtros { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin: var(--sp-3) 0; }
    .hx-actualizando-txt { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .hx-actualizando { opacity: .55; pointer-events: none; }
    .hx-avisos { display: grid; gap: var(--sp-1); margin: var(--sp-3) 0; }
    .hx-aviso { display: flex; align-items: flex-start; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .hx-aviso .pi { margin-top: 2px; }
    .hx-aviso--mal { color: var(--bad-soft-fg); }
    .hx-col-suc, .hx-suc-nombre { text-align: left; font-weight: 600; white-space: nowrap; }
    .hx-cel { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 0; background: none; border: 0; padding: var(--sp-1); margin: calc(-1 * var(--sp-1)); font: inherit; color: var(--text-main); cursor: pointer; border-radius: var(--r-sm); }
    .hx-cel:hover { background: var(--overlay-hover); }
    .hx-cel:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .hx-cel--tenue { color: var(--text-muted); flex-direction: row; gap: var(--sp-1); align-items: center; }
    .hx-sv { display: block; font-size: var(--fs-micro); color: var(--text-muted); }
    .hx-estado { color: var(--text-muted); font-size: var(--fs-sm); }
    .hx-marca { display: block; font-size: var(--fs-micro); font-weight: 400; color: var(--text-muted); }
    .hx-total th, .hx-total td { border-top: 1px solid var(--border-color); }
    /* El tema de PrimeNG pisa el text-align de comm-num (medido: «start»): cifras y fechas a la derecha. */
    :host ::ng-deep .hx-tabla .p-datatable-thead > tr > th.comm-num,
    :host ::ng-deep .hx-tabla .p-datatable-tbody > tr > td.comm-num,
    :host ::ng-deep .hx-tabla .p-datatable-tfoot > tr > td.comm-num,
    :host ::ng-deep .hx-tabla-det .p-datatable-thead > tr > th.comm-num,
    :host ::ng-deep .hx-tabla-det .p-datatable-tbody > tr > td.comm-num { text-align: right; }
    .hx-sv--izq { font-weight: 400; }
    .hx-parcial { display: flex; justify-content: flex-end; align-items: center; gap: var(--sp-1); font-size: var(--fs-micro); color: var(--warn-soft-fg); white-space: nowrap; }
    .hx-parcial .pi { color: var(--warn-fg); }
    /* La columna Sucursal es un <th scope=row> (encabezado de fila, para lectores de pantalla); las
       reglas globales de frozen-first congelan td:first-child, así que se congela aquí. */
    :host ::ng-deep .hx-tabla tbody > tr > th,
    :host ::ng-deep .hx-tabla tfoot > tr > th,
    :host ::ng-deep .hx-tabla thead > tr > th.hx-col-suc {
      position: sticky; left: 0; z-index: 1; background: var(--card-bg); box-shadow: inset -1px 0 0 var(--border-color);
    }
    /* En teléfono, la regla global de tablas fija ancho y relleno a thead/tbody td pero NO al encabezado
       de fila ni al pie: sin esto el Total y las sucursales quedan desalineados de sus fechas. */
    @media (max-width: 48rem) {
      :host ::ng-deep .hx-tabla tbody > tr > th,
      :host ::ng-deep .hx-tabla tfoot > tr > th,
      :host ::ng-deep .hx-tabla tfoot > tr > td {
        padding: .5rem .75rem !important; font-size: .75rem !important; min-width: 120px !important;
      }
    }
    .hx-resumen { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .hx-resumen strong { font-size: var(--fs-lg); color: var(--text-main); }
    .hx-resumen strong.hx-estado { font-size: var(--fs-body); color: var(--text-muted); }
    .hx-det-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .hx-buscar { flex: 1 1 14rem; display: block; }
    .hx-buscar input { width: 100%; }
    .hx-sku { white-space: nowrap; color: var(--text-muted); }
    .hx-nowrap { white-space: nowrap; }
    .hx-unidad { margin-left: var(--sp-1); font-size: var(--fs-micro); color: var(--text-muted); }
    .hx-posterior { margin-left: var(--sp-1); color: var(--text-muted); font-size: var(--fs-xs); }
    /* En angosto (sidebar abierto, tablet): los filtros apilados a todo el ancho; la tabla conserva la
       columna de sucursal fija y se recorre de lado. */
    @container (max-width: 640px) {
      .hx-filtros { flex-direction: column; align-items: stretch; }
      .hx-acciones { width: 100%; }
    }
    .hx-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  `],
})
export class AlmacenExistenciaHistoricoComponent implements OnInit {
  private readonly api = inject(ExistenciaHistoricoApiService);
  private readonly destroyRef = inject(DestroyRef);
  /** Existencia vive en dos proyectos (Almacén y Compras): se vuelve a la MISMA de la que se vino. */
  readonly volverA = inject(Router).url.split(/[?#]/)[0].replace(/\/historico$/, '') || '/';

  readonly vistas: SegOption[] = [
    { label: 'Días', value: 'dias' },
    { label: 'Semanas', value: 'semanas' },
    { label: 'Meses', value: 'meses' },
  ];
  readonly hoyDate = aDate(hoyMx());

  /** La vista ELEGIDA (lo que se va a pedir)… */
  readonly vista = signal<HistoricoVista>('dias');
  /** …y la vista CON LA QUE SE PIDIÓ el dato que está en pantalla: las columnas salen de ésta. */
  private readonly vistaDatos = signal<HistoricoVista>('dias');
  /** Por defecto, los 7 cierres que terminan AYER: el de hoy se fotografía a las 23:50. */
  readonly hasta = signal(sumarDias(hoyMx(), -1));
  readonly desde = signal(sumarDias(sumarDias(hoyMx(), -1), -(HISTORICO_DIAS_POR_VISTA.dias - 1)));
  /** Lo que muestra el selector de fechas; puede ir a medias mientras se elige. */
  readonly rangoSel = signal<Date[] | null>([aDate(this.desde()), aDate(this.hasta())]);
  readonly sucursalesSel = signal<string[]>([]);

  readonly datos = signal<ExistenciaHistorico | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /** Las sucursales de la primera carga sin filtro: el filtro no puede ofrecer sólo lo ya filtrado. */
  private readonly todas = signal<HistoricoAlmacen[]>([]);

  readonly peekAbierto = signal(false);
  private readonly peekCelda = signal<{ fecha: string; code: string; nombre: string } | null>(null);
  /** La celda que abrió el panel: al cerrarlo, el foco vuelve ahí y no al principio de la página. */
  private disparador: HTMLElement | null = null;
  readonly detalle = signal<ExistenciaHistoricoDetalle | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly soloSinValuar = signal(false);
  /** La página del panel, explícita: PrimeNG 22 no la reinicia al cambiar la lista (se quedaba en blanco). */
  readonly primeraFila = signal(0);

  private readonly pedir$ = new Subject<void>();
  private readonly pedirDetalle$ = new Subject<{ fecha: string; code: string }>();

  readonly opcionesSucursal = computed(() =>
    this.todas().map((a) => ({ label: this.nombreDe(a), value: a.code })));

  readonly columnas = computed<HistoricoDia[]>(() => {
    const vista = this.vistaDatos();
    const d = this.datos();
    return d ? cierresDeVista(d.dias, vista) : [];
  });

  readonly filas = computed<FilaSucursal[]>(() => {
    const d = this.datos();
    const cols = this.columnas();
    if (!d) return [];
    const ultimoConValor = [...cols].reverse().find((c) => c.total.valor_estandar !== null);
    return d.almacenes.map((a, i) => ({
      almacen: a,
      nombre: this.nombreDe(a),
      celdas: cols.map((c) => c.celdas[i]),
      // Sólo de una celda MEDIDA: el «sin valuar» de una foto no confiable (CEDIS) no informa nada.
      sinValuar: ultimoConValor && ultimoConValor.celdas[i].estado === 'medido'
        ? ultimoConValor.celdas[i].productos_sin_valuar : null,
    }));
  });

  readonly totales = computed<HistoricoTotal[]>(() => this.columnas().map((c) => c.total));

  /** ¿Las columnas cruzan de año, o es la vista por meses? Entonces la fecha lleva el año. */
  private readonly conAnio = computed(() => {
    const cols = this.columnas();
    if (this.vistaDatos() === 'meses') return true;
    return cols.length > 1 && cols[0].fecha.slice(0, 4) !== cols[cols.length - 1].fecha.slice(0, 4);
  });

  /** La hora REAL en que terminó la última foto (su latido), no una hora supuesta. */
  readonly ultimaFotoTs = computed<string | null>(() => this.datos()?.ultima_foto.hecha_en ?? null);

  /** Si el latido de la foto dice error, se dice arriba: la pantalla no puede verse «al día» sin foto. */
  readonly fotoFallida = computed<string | null>(() => {
    const u = this.datos()?.ultima_foto;
    return u && u.estado === 'error' ? (u.nota || 'la corrida terminó en error.') : null;
  });

  readonly hayNoConfiable = computed(() =>
    this.columnas().some((c) => c.celdas.some((x) => x.estado === 'no_confiable')));

  readonly textoMetodo = computed(() => {
    const d = this.datos();
    const cols = this.columnas();
    const reconstruido = cols.some((c) => c.celdas.some((x) => x.estado === 'medido' && x.costo_reconstruido));
    let t = 'Valor a costo estándar de Kepler, sin impuesto. Las unidades no se suman entre productos.';
    if (reconstruido) {
      const desde = d?.metodo.historia_estandar_desde;
      t += ' En los días anteriores a que la foto guardara su costo, el valor se reconstruye con la historia del estándar'
        + (desde ? ` (existe desde el ${this.fechaLarga(desde)}; antes se usa el primero conocido)` : '')
        + ' y puede moverse un poco si se vuelve a consultar.';
    }
    return t;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const cols = this.columnas();
    const conValor = cols.filter((c) => c.total.valor_estandar !== null);
    const ultimo = conValor[conValor.length - 1];
    const primero = conValor[0];
    const items: MetricStripItem[] = [];
    if (!ultimo) {
      items.push({ label: 'Valor del inventario', value: 'sin cierres medidos', format: 'text', state: 'no_medido', stateNote: 'Ningún cierre del rango tiene una sucursal medida.' });
      return items;
    }
    const tu = ultimo.total;
    const valor: MetricStripItem = {
      label: `Valor al ${this.fechaLarga(ultimo.fecha)}`,
      value: tu.valor_estandar as number,
      format: 'currency',
      sub: `${tu.almacenes_sumados} sucursales`,
    };
    if (!tu.todos_los_almacenes) {
      valor.state = 'parcial';
      valor.stateNote = this.textoFuera(tu);
    } else if (tu.costo_reconstruido) {
      valor.state = 'derivado';
      valor.method = 'costo reconstruido';
      valor.stateNote = 'Costo estándar reconstruido con su historia; puede moverse un poco si se vuelve a consultar.';
    } else {
      valor.state = 'medido';
    }
    items.push(valor);

    if (primero && primero !== ultimo) {
      const tp = primero.total;
      const label = `Cambio desde el ${this.fechaLarga(primero.fecha)}`;
      if (tp.almacenes_fuera.join(',') !== tu.almacenes_fuera.join(',')) {
        items.push({ label, value: 'no comparable', format: 'text', state: 'no_medido',
          stateNote: 'Los dos cierres no suman las mismas sucursales.' });
      } else {
        const dif = (tu.valor_estandar as number) - (tp.valor_estandar as number);
        const pct = tp.valor_estandar ? (dif / (tp.valor_estandar as number)) * 100 : null;
        // Sin «delta»: la franja lo pintaría verde al subir y rojo al bajar, y en inventario subir no es
        // bueno por sí mismo. El porcentaje va como texto neutro.
        const cambio: MetricStripItem = {
          label, value: dif, format: 'currency',
          sub: pct === null ? 'contra un cierre en cero' : `${dif >= 0 ? '+' : '−'}${PCT.format(Math.abs(pct))} % sobre ese cierre`,
        };
        const universoDistinto = tp.productos_sin_valuar !== tu.productos_sin_valuar;
        if (tp.costo_reconstruido || tu.costo_reconstruido || universoDistinto) {
          cambio.state = 'derivado';
          cambio.method = tp.costo_reconstruido || tu.costo_reconstruido ? 'costo reconstruido' : 'universo distinto';
          cambio.stateNote = [
            tp.costo_reconstruido || tu.costo_reconstruido ? 'Uno o los dos cierres se valúan con el estándar reconstruido.' : '',
            universoDistinto ? `Los dos cierres no dejan fuera los mismos renglones sin valuar (${tp.productos_sin_valuar} y ${tu.productos_sin_valuar}).` : '',
          ].filter(Boolean).join(' ');
        } else {
          cambio.state = 'medido';
        }
        items.push(cambio);
      }
    }

    const hoy = hoyMx();
    const pasados = cols.filter((c) => c.fecha < hoy);
    const completos = pasados.filter((c) => c.celdas.length > 0 && !c.celdas.some(sinFoto));
    const incompletos = pasados.filter((c) => !completos.includes(c));
    items.push({
      label: 'Cierres completos',
      value: `${completos.length} de ${pasados.length}`,
      format: 'text',
      state: incompletos.length ? 'parcial' : 'medido',
      stateNote: incompletos.length
        ? 'Sin foto de todas las sucursales: ' + incompletos.map((c) => {
          const faltan = c.celdas.filter(sinFoto).length;
          return `${this.fechaLarga(c.fecha)} (${faltan === c.celdas.length ? 'ninguna' : `faltan ${faltan}`})`;
        }).join(', ')
        : undefined,
    });
    items.push({
      label: 'Renglones sin valuar',
      value: tu.productos_sin_valuar,
      format: 'number',
      sub: `producto × sucursal al ${this.fechaLarga(ultimo.fecha)}; no entran a la suma`,
      tone: tu.productos_sin_valuar ? 'warn' : 'default',
    });
    return items;
  });

  readonly opcionesDetalle = computed<SegOption[]>(() => {
    const d = this.detalle();
    if (!d) return [];
    return [
      { label: 'Todos', value: 'todos', count: d.productos.length },
      { label: 'Sin valuar', value: 'sin', count: d.productos_sin_valuar },
    ];
  });

  readonly productosVisibles = computed<HistoricoDetalleProducto[]>(() => {
    const d = this.detalle();
    const q = this.busqueda();
    const sinValor = this.soloSinValuar();
    if (!d) return [];
    const base = sinValor ? d.productos.filter((p) => p.valor === null) : d.productos;
    return filtrarPorBusqueda(base, q, (p) => [p.sku, p.nombre]);
  });

  readonly peekTitulo = computed(() => this.peekCelda()?.nombre ?? '');
  readonly peekSub = computed(() => {
    const c = this.peekCelda();
    return c ? `Cierre del ${this.fechaLarga(c.fecha)}` : null;
  });

  readonly pistaVacio = computed(() => {
    const d = this.datos();
    return d?.metodo.foto_desde
      ? `La foto diaria de inventario empezó el ${this.fechaLarga(d.metodo.foto_desde)}.`
      : 'Todavía no hay fotos de inventario.';
  });

  ngOnInit(): void {
    this.pedir$.pipe(
      // Un tecleo de flechas en el segmentado o varias casillas seguidas en sucursales = UN pedido.
      debounceTime(250),
      tap(() => { this.cargando.set(true); this.error.set(null); }),
      switchMap(() => {
        const vista = this.vista();
        return this.api.historico({ desde: this.desde(), hasta: this.hasta(), almacenes: this.sucursalesSel() }).pipe(
          map((r) => ({ r, vista })),
          catchError((e) => {
            this.error.set(e?.error?.message ?? 'No se pudo cargar la consulta.');
            return of(null);
          }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((res) => {
      this.cargando.set(false);
      if (!res) return;
      const { r, vista } = res;
      // El dato y la vista con que se pidió entran JUNTOS: las columnas nunca mezclan uno con otro.
      this.datos.set(r);
      this.vistaDatos.set(vista);
      // El rango que respondió el servidor manda (si ajustó lo pedido, lo dice en el aviso).
      this.desde.set(r.desde);
      this.hasta.set(r.hasta);
      this.rangoSel.set([aDate(r.desde), aDate(r.hasta)]);
      if (!this.sucursalesSel().length) this.todas.set(r.almacenes);
    });

    this.pedirDetalle$.pipe(
      tap(() => { this.cargandoDetalle.set(true); this.errorDetalle.set(null); this.detalle.set(null); }),
      switchMap((c) => this.api.detalle(c.fecha, c.code).pipe(
        catchError((e) => {
          this.errorDetalle.set(e?.error?.message ?? 'No se pudo cargar el desglose.');
          return of(null);
        }),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.cargandoDetalle.set(false);
      if (r) this.detalle.set(r);
    });

    this.cargar();
  }

  cargar(): void {
    this.pedir$.next();
  }

  cambiarVista(v: string): void {
    const vista = (['dias', 'semanas', 'meses'] as const).find((x) => x === v) ?? 'dias';
    this.vista.set(vista);
    // El rango de la vista empieza, como muy atrás, donde empieza la foto: antes no hay nada que
    // mostrar, y 6 columnas «sin foto» del verano harían que «Cierres completos» acusara fotos que
    // nunca existieron. Una fecha anterior elegida A MANO sí se respeta (y se ve «sin foto»).
    let desde = sumarDias(this.hasta(), -(HISTORICO_DIAS_POR_VISTA[vista] - 1));
    const fotoDesde = this.datos()?.metodo.foto_desde;
    if (fotoDesde && desde < fotoDesde) desde = fotoDesde;
    this.desde.set(desde);
    this.cargar();
  }

  cambiarRango(r: Date[] | null): void {
    this.rangoSel.set(r);
    // El selector emite primero [inicio, null]: se espera a que haya las dos puntas.
    if (!r || !r[0] || !r[1]) return;
    this.desde.set(aIso(r[0]));
    this.hasta.set(aIso(r[1]));
    this.cargar();
  }

  /** Si se cerró el calendario con el rango a medias, vuelve a mostrar el rango que SÍ está cargado. */
  alCerrarRango(): void {
    const r = this.rangoSel();
    if (!r || !r[0] || !r[1]) this.rangoSel.set([aDate(this.desde()), aDate(this.hasta())]);
  }

  cambiarSucursales(codigos: string[] | null): void {
    this.sucursalesSel.set(codigos ?? []);
    this.cargar();
  }

  abrir(fila: FilaSucursal, col: HistoricoDia, ev?: Event): void {
    this.disparador = (ev?.currentTarget as HTMLElement | null) ?? null;
    this.peekCelda.set({ fecha: col.fecha, code: fila.almacen.code, nombre: fila.nombre });
    this.busqueda.set('');
    this.soloSinValuar.set(false);
    this.primeraFila.set(0);
    this.peekAbierto.set(true);
    this.pedirDetalle$.next({ fecha: col.fecha, code: fila.almacen.code });
  }

  alCambiarPanel(abierto: boolean): void {
    this.peekAbierto.set(abierto);
    if (!abierto && this.disparador) {
      const el = this.disparador;
      this.disparador = null;
      setTimeout(() => { if (el.isConnected) el.focus(); });
    }
  }

  recargarDetalle(): void {
    const c = this.peekCelda();
    if (c) this.pedirDetalle$.next({ fecha: c.fecha, code: c.code });
  }

  buscar(q: string): void {
    this.busqueda.set(q);
    this.primeraFila.set(0);
  }

  filtrarSinValuar(solo: boolean): void {
    this.soloSinValuar.set(solo);
    this.primeraFila.set(0);
  }

  /** El nombre común de la sucursal; si el resolvedor no la conoce, el que mandó el servidor (nunca el código). */
  nombreDe(a: HistoricoAlmacen): string {
    const n = warehouseName(a.code);
    return n && n !== a.code ? n : (a.name || a.label || a.code);
  }

  dinero(v: number): string { return MXN.format(Number(v)); }
  dinero2(v: number): string { return MXN2.format(Number(v)); }
  numero(v: number): string { return NUM.format(Number(v)); }
  etiquetaColumna(f: string): string {
    const d = new Date(`${f}T00:00:00Z`);
    return this.conAnio() ? DIA_CORTO_ANIO.format(d) : DIA_CORTO.format(d);
  }
  fechaLarga(f: string): string {
    const d = new Date(`${f}T00:00:00Z`);
    return this.conAnio() ? DIA_LARGO_ANIO.format(d) : DIA_LARGO.format(d);
  }

  /** Los nombres de lo que no sumó, completos (para lectores de pantalla y la nota de la franja). */
  textoFuera(t: HistoricoTotal): string {
    return 'No suma: ' + t.almacenes_fuera.map((c) => warehouseName(c) || c).join(', ');
  }
  /** Lo mismo, corto y legible en la celda del total: los nombres si son uno o dos; si no, cuántas. */
  textoFueraCorto(t: HistoricoTotal): string {
    const n = t.almacenes_fuera.length;
    return n <= 2
      ? 'sin ' + t.almacenes_fuera.map((c) => warehouseName(c) || c).join(' ni ')
      : `sin ${n} sucursales`;
  }

  textoSinValor(p: HistoricoDetalleProducto): string {
    return p.sin_valor === 'unidad_dudosa' ? 'unidad dudosa' : 'sin estándar';
  }

  etiquetaCelda(nombre: string, fecha: string, c: HistoricoCelda): string {
    const valor = c.valor_estandar !== null ? this.dinero(c.valor_estandar) : 'sin valor';
    const n = c.productos_sin_valuar ?? 0;
    const sv = n ? `, ${n} producto${n === 1 ? '' : 's'} sin valuar` : '';
    return `${nombre}, ${this.fechaLarga(fecha)}: ${valor}${sv}. Abrir el desglose.`;
  }
}
