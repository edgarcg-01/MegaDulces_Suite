import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { coincideBusqueda } from '@megadulces/ui-web';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { etiquetaFuentePrecio, netoPorUnidad, textoDescuento, tonoFuentePrecio, type PasoDesglose } from '../quote-units';
import { notaRedondeo } from '../quote-discount-breakdown';

/**
 * `[E.29]` Un renglón de cotización como lo ve el operador, YA resuelto. Lo arman el alta (la
 * bandeja, antes de guardar) y el detalle (lo guardado); esta tabla sólo lo pinta. Así la
 * cotización se ve igual antes y después de crearla — pedido explícito: «mostrar esta interfaz
 * tal cual antes de generar la cotización».
 */
export interface RenglonTabla {
  id: string;
  numero: number;
  nombre: string;
  /** `[E.30]` El SKU del catálogo (null si el renglón no casó). Va debajo del nombre. */
  sku: string | null;
  /** No casó con el catálogo: es demanda que no manejamos, sin precio. */
  sinCasar: boolean;
  /** Renglón de regalo del ERP: el número del renglón que lo trae. null = renglón normal. */
  regaloDe: number | null;
  /** Regalo que el ERP le agregará a este renglón (sólo en la bandeja, antes de guardar). */
  notaRegalo: string | null;
  unidad: string | null;
  factor: number | null;
  cantidad: number;
  editable: boolean;
  admiteFraccion: boolean;
  /**
   * Existencia de la sucursal en la unidad del renglón. `'cargando'` mientras se consulta,
   * `'sin-dato'` si el ERP no la tiene (no es cero), null = no aplica (regalo) o no se pidió.
   */
  existencia: { cantidad: number; unidad: string; faltan: number } | 'cargando' | 'sin-dato' | null;
  lista: number | null;
  precio: number | null;
  /** El precio por unidad menor: «(12 PAQ $41.82)». */
  desglose: PasoDesglose[];
  /** `price_source` del motor (código; la etiqueta la pone la tabla). */
  fuente: string;
  /** Descuento contra la lista, en % (derivado; null = sin lista o sin precio). */
  dtoPct: number | null;
  /** «lista $26.94 → volumen $24.79»; vacío si no hay pasos que explicar. */
  pasos: string;
  /** Qué descuento es, concreto: «Precio por volumen de 10 a más PAQ», «50% desde 1 PAQ · vigente hasta 22/11/2026». */
  explicacion: string;
  importe: number | null;
  /**
   * `[E.29]` El importe con el % del cliente, repartido como en la hoja (`totalesCotizacion().netos`:
   * Σ netos = total al centavo). null = sin % de cliente o renglón sin precio.
   */
  neto: number | null;
  /** `[E.29]` Precio de la presentación antes del redondeo de Kepler por unidad base; null = no se sabe. */
  sinRedondear: number | null;
  /**
   * `[GP.9.3]` Lo que el pedido de Kepler ya no trae igual que este renglón («No va en el pedido»,
   * «El pedido trae 1 CJA»). Sólo en una cotización con pedido; undefined/null = sin cambio o sin pedido.
   */
  enPedido?: string | null;
}

/** `[COT.47]` Los filtros de una lista larga de renglones. */
export type FiltroRenglones = 'todos' | 'faltan' | 'promo';
export type OrdenRenglones = 'captura' | 'importe' | 'nombre';

/**
 * `[COT.47]` Desde cuántos renglones aparece la barra de buscar y filtrar. Medido en prod (30 días,
 * 410 cotizaciones): la mediana trae 9 renglones y una de cada diez 40 o más; con menos de 10 la
 * barra sería ruido (todo cabe a la vista).
 */
export const RENGLONES_PARA_FILTRAR = 10;

const esPromo = (r: RenglonTabla): boolean => r.fuente === 'promo_qty' || r.fuente === 'promo_amount';
const falta = (r: RenglonTabla): boolean => typeof r.existencia === 'object' && r.existencia !== null && r.existencia.faltan > 0;
const nombres = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** `[COT.47]` Cuántos renglones hay detrás de cada filtro (el número va en el botón). */
export function cuentasRenglones(renglones: RenglonTabla[]): Record<FiltroRenglones, number> {
  return { todos: renglones.length, faltan: renglones.filter(falta).length, promo: renglones.filter(esPromo).length };
}

/**
 * `[COT.47]` Qué renglones se ven y en qué orden. Buscar por nombre o SKU con la misma regla que el
 * resto de la suite (palabras en cualquier orden, sin acentos); el filtro y el orden NO cambian el
 * número de renglón (es el del pedido en Kepler) ni los totales, que se calculan sobre todos.
 */
export function renglonesVisibles(
  renglones: RenglonTabla[], busqueda: string, filtro: FiltroRenglones, orden: OrdenRenglones,
): RenglonTabla[] {
  const out = renglones.filter((r) =>
    (filtro === 'todos' || (filtro === 'faltan' ? falta(r) : esPromo(r))) && coincideBusqueda(busqueda, r.nombre, r.sku));
  if (orden === 'importe') return [...out].sort((a, b) => (b.neto ?? b.importe ?? -1) - (a.neto ?? a.importe ?? -1));
  if (orden === 'nombre') return [...out].sort((a, b) => nombres.compare(a.nombre, b.nombre));
  return out;
}

export interface CambioCantidad {
  id: string;
  valor: string;
  input: HTMLInputElement;
}

@Component({
  selector: 'app-quote-lines-table',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, ButtonModule, InputTextModule, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `[E.29]` El contenedor de la consulta se declara con la clase CANÓNICA, no a mano.
  // El `:host` de abajo ya ponía `container-type`/`container-name: densetable`, así que el
  // apilado sí ocurría — pero `check:dense-tables` busca `dt-scope` y, sin él, la próxima
  // pantalla que copie ésta se lleva la forma de a mano y ahí sí queda rota en silencio.
  host: { class: 'dt-scope' },
  template: `
    <!-- rowTrackBy por id: al cambiar una cantidad la fila no se rehace y el campo no pierde el foco. -->
    <!-- [COT.35] Sin ancho mínimo: la tabla cabe en su espacio (medido: 1,326 px fijos contra 901 px
         disponibles a 1366 de ancho; ahora mide lo que su contenedor a 1280, 1366 y 1600). Sin la
         columna «Lista»: repetía lo que «De dónde sale» ya dice (lista → volumen, o el redondeo). -->
    <!-- [COT.47] En una lista larga, buscar y filtrar sin bajar a leer. Los totales y los números de
         renglón son siempre los de TODA la cotización; el filtro sólo cambia qué se ve, y lo dice. -->
    @if (renglones().length >= umbralFiltros) {
      <div class="filtros" role="search" aria-label="Buscar y filtrar renglones">
        <input pInputText pSize="small" type="search" class="filtro-buscar" [value]="busqueda()"
               (input)="busqueda.set($any($event.target).value)" (keydown.escape)="busqueda.set('')"
               placeholder="Buscar en los renglones: nombre o SKU" aria-label="Buscar en los renglones"
               [attr.aria-describedby]="filtrando() ? 'renglones-mostrando' : null" enterkeyhint="search" autocomplete="off" />
        <app-segmented [options]="opcionesFiltro()" [value]="filtro()" (valueChange)="filtro.set($any($event))" ariaLabel="Qué renglones ver" />
        <app-segmented [options]="opcionesOrden" [value]="orden()" (valueChange)="orden.set($any($event))" ariaLabel="Ordenar renglones" />
        @if (filtrando()) {
          <span id="renglones-mostrando" class="mostrando">Mostrando {{ visibles().length }} de {{ renglones().length }} ·
            <button type="button" class="quitar-filtro" (click)="quitarFiltros()">Quitar filtro</button></span>
        }
      </div>
    }
    <!-- [COT.47] Encabezado fijo al bajar (surf-table--sticky): en 40 renglones «Precio», «De dónde sale» e
         «Importe» son tres columnas de pesos y sin el encabezado no se sabe cuál es cuál. -->
    <p-table class="dt-stack surf-table--sticky" [value]="visibles()" dataKey="id" [rowTrackBy]="porId" size="small" [tableStyle]="{ width: '100%' }">
      <ng-template #header>
        <tr>
          <th scope="col" class="num fijo fijo-num">#</th>
          <th scope="col" class="fijo fijo-prod">Producto</th>
          <th scope="col">Presentación</th>
          <th scope="col" class="num">Cantidad</th>
          <th scope="col" class="num">Existencia hoy</th>
          <th scope="col" class="num">Precio</th>
          <th scope="col" class="col-fuente">De dónde sale</th>
          <th scope="col" class="num">Importe</th>
          <th scope="col"><span class="sr-only">Acciones</span></th>
        </tr>
      </ng-template>
      <ng-template #emptymessage>
        <tr><td colspan="9" class="t-none">Ningún renglón coincide con el filtro. <button type="button" class="quitar-filtro" (click)="quitarFiltros()">Quitar filtro</button></td></tr>
      </ng-template>
      <ng-template #body let-r>
        <!-- [COT.46] id para «Ver en la lista»; el último agregado lleva una franja (y texto en la
             confirmación de arriba: el color no va solo) y se resalta un momento al pedir verlo. -->
        <tr [class.row-gift]="r.regaloDe !== null" [attr.id]="'renglon-' + r.id"
            [class.row-ultimo]="r.id === marcado()" [class.row-destello]="r.id === destello()">
          <!-- [COT.31] # y Producto quedan fijos al desplazar a la derecha: al quitar (la X está al
               final) se ve QUÉ renglón se quita. Antes la tabla se corría y el nombre salía de vista. -->
          <td class="num mono dt-num fijo fijo-num" role="cell" data-label="Renglón">{{ r.numero }}</td>
          <!-- [COT.47] El producto es el encabezado de su fila: el lector anuncia de qué renglón es cada importe. -->
          <td class="dt-id fijo fijo-prod" role="rowheader">
            @if (r.regaloDe !== null) {
              <span class="gift"><i class="pi pi-gift" aria-hidden="true"></i> regalo del {{ r.regaloDe }}</span>
            }
            <span class="p-name" [title]="r.nombre">{{ r.nombre }}</span>
            <!-- [E.30] El SKU en la misma celda: con él se dicta y se busca el artículo en Kepler. -->
            @if (r.sku) { <span class="p-sku mono">SKU {{ r.sku }}</span> }
            @if (r.sinCasar) {
              <span class="sin-casar">sin casar con el catálogo</span>
            }
            @if (r.notaRegalo) {
              <span class="gift-nota"><i class="pi pi-gift" aria-hidden="true"></i> {{ r.notaRegalo }}</span>
            }
            @if (r.enPedido) {
              <span class="en-pedido"><i class="pi pi-minus-circle" aria-hidden="true"></i> {{ r.enPedido }}</span>
            }
          </td>
          <td role="cell" data-label="Presentación">
            @if (r.unidad) {
              {{ r.unidad }}
              @if (r.factor) { <span class="factor">x{{ r.factor }}</span> }
            } @else {
              <span class="t-none">sin registrar</span>
            }
          </td>
          <td class="num dt-num" role="cell" data-label="Cantidad">
            @if (r.editable && r.regaloDe === null) {
              <div class="inline-qty-box">
                <!-- Se guarda al CONFIRMAR (Enter o salir del campo), no con cada tecla (E.20). -->
                <input
                  pInputText
                  pSize="small"
                  type="text"
                  class="qty-inline"
                  [value]="r.cantidad"
                  (change)="cantidad.emit({ id: r.id, valor: $any($event.target).value, input: $any($event.target) })"
                  (keydown.enter)="$any($event.target).blur()"
                  (keydown.arrowdown)="moverFoco($event, 1)"
                  (keydown.arrowup)="moverFoco($event, -1)"
                  (focus)="$any($event.target).select()"
                  [attr.inputmode]="r.admiteFraccion ? 'decimal' : 'numeric'"
                  [disabled]="bloqueado()"
                  [attr.aria-label]="'Cantidad del renglón ' + r.numero"
                />
              </div>
            } @else {
              {{ r.cantidad }}
            }
          </td>
          <td class="num dt-num" role="cell" data-label="Existencia hoy">
            @switch (tipoExistencia(r)) {
              @case ('cargando') { <span class="t-none">…</span> }
              @case ('sin-dato') { <span class="t-none">sin dato</span> }
              @case ('dato') {
                <span [class.falta]="r.existencia.faltan > 0">{{ r.existencia.cantidad | number:'1.0-2' }} {{ r.existencia.unidad }}</span>
                @if (r.existencia.faltan > 0) { <span class="falta-nota">faltan {{ r.existencia.faltan | number:'1.0-2' }}</span> }
              }
            }
          </td>
          <td class="num dt-num" role="cell" data-label="Precio">
            @if (r.precio !== null) {
              <div class="p-unit-cell">
                <span class="p-unit-main">{{ r.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                @if (r.desglose.length) {
                  <span class="p-unit-sub-breakdown">(@for (p of r.desglose; track p.unidad; let ultimo = $last) {<span>{{ p.cantidad }} {{ p.unidad }} {{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>@if (!ultimo) { · }})</span>
                }
                <!-- [COT.43] Lo que paga el cliente por unidad con el % del cliente ya aplicado (importe neto ÷ cantidad). -->
                @if (netoUnidad(r); as nu) {
                  <span class="p-neto">Con −{{ clientePct() }} %: <strong>{{ nu.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>@if (r.unidad) { {{ r.unidad }}}@for (p of nu.pasos; track p.unidad) { · {{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2' }} {{ p.unidad }}}</span>
                }
              </div>
            } @else {
              <span class="t-none">sin precio</span>
            }
          </td>
          <td class="col-fuente" role="cell" data-label="De dónde sale">
            <p-tag [value]="etiqueta(r.fuente)" [severity]="tono(r.fuente)" />
            @if (r.dtoPct) { <span class="dto" [class.recargo]="r.dtoPct < 0">{{ textoDto(r.dtoPct) }}</span> }
            @if (r.explicacion) { <span class="explica">{{ r.explicacion }}</span> }
            @if (r.pasos) { <span class="pasos">{{ r.pasos }}</span> }
            @if (redondeo(r); as nota) { <span class="pasos">{{ nota }}</span> }
            <!-- [E.29] El % del cliente también es de dónde sale el importe: se dice en el renglón. -->
            @if (r.neto !== null && r.neto !== r.importe) {
              <span class="cliente">
                <p-tag [value]="etiqueta('customer_terms')" [severity]="tono('customer_terms')" />
                <span class="dto">−{{ clientePct() }}%</span>
              </span>
            }
          </td>
          <!-- [E.29] Con % de cliente, el importe es el de la hoja (ya con su parte del descuento) y
               dice de dónde sale: el renglón de Kepler, antes del %, es el de abajo. -->
          <td class="num dt-num" role="cell" data-label="Importe">
            @if (r.neto !== null && r.neto !== r.importe) {
              <span class="p-unit-main">{{ r.neto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              <span class="imp-antes">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }} <span class="junto">− {{ clientePct() }} % cliente</span></span>
            } @else {
              {{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}
            }
          </td>
          <td class="num dt-actions" role="cell">
            @if (r.editable && r.regaloDe === null) {
              <p-button
                icon="pi pi-times"
                severity="danger"
                size="small"
                [text]="true"
                [disabled]="bloqueado()"
                (onClick)="quitar.emit(r.id)"
                [ariaLabel]="'Quitar el renglón ' + r.numero + ': ' + r.nombre"
                [attr.title]="'Quitar ' + r.nombre"
              />
            }
          </td>
        </tr>
      </ng-template>
    </p-table>
  `,
  styles: [
    `
      /* El contenedor de la tabla apilable (dense-table.css): apila por debajo de 34rem. */
      :host { display: block; overflow-x: auto; container-type: inline-size; container-name: densetable; }
      /* Sin cortes de línea sólo cuando la tabla NO está apilada. */
      @container densetable (min-width: 34rem) {
        :is(th, td) { white-space: nowrap; padding: 0.3rem 0.35rem; font-size: var(--fs-sm); }
        /* [COT.35] El encabezado parte en dos («Existencia / hoy») para no ensanchar su columna. */
        th { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); white-space: normal; }
        /* [COT.35] El nombre del producto parte en renglones en vez de cortarse con «…» o empujar la tabla. */
        td.dt-id { white-space: normal; min-width: 9rem; }
        /* [COT.31] Columnas fijas a la izquierda; el fondo tapa lo que pasa por debajo. */
        .fijo { position: sticky; z-index: 1; background: var(--surface-card); }
        .row-gift .fijo { background: var(--surface-ground); }
        th.fijo { background: var(--p-datatable-header-cell-background, var(--surface-card)); }
        .fijo-num { left: 0; width: 2.5rem; min-width: 2.5rem; }
        .fijo-prod { left: 2.5rem; box-shadow: 1px 0 0 var(--surface-border); }
        /* «De dónde sale» parte en renglones: era la que empujaba la tabla fuera de la pantalla. */
        .col-fuente { white-space: normal; min-width: 9rem; max-width: 16rem; }
      }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); }
      .muted { color: var(--text-muted); }
      .row-gift { background: var(--surface-ground); }
      /* [COT.47] La esquina fija (encabezado de # y Producto) por encima de las celdas fijas que pasan debajo. */
      th.fijo { z-index: 3; }
      .filtros {
        display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3);
        padding: var(--sp-2) 0 var(--sp-3);
      }
      .filtro-buscar { flex: 1 1 14rem; min-width: 0; max-width: 24rem; }
      .mostrando { font-size: var(--fs-sm); color: var(--text-muted); }
      .quitar-filtro {
        background: none; border: 0; padding: 0; font: inherit; color: var(--text-main);
        text-decoration: underline; cursor: pointer;
      }
      .quitar-filtro:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 2px; }
      /* [COT.46] El último agregado: franja en el número. Al pedir verlo, una capa sobre el fondo de CADA
         celda (las fijas traen el suyo y taparían un fondo de fila); se quita sola, sin animación. */
      .row-ultimo > td.fijo-num { box-shadow: inset 3px 0 0 var(--action); }
      .row-destello > td { background-image: linear-gradient(var(--overlay-selected), var(--overlay-selected)); }
      .p-name { display: block; }
      .p-sku { display: block; font-size: var(--fs-micro); color: var(--text-muted); }
      .gift { font-size: 0.7rem; color: var(--ok-soft-fg); margin-right: 0.35rem; }
      .gift-nota { display: block; font-size: 0.7rem; color: var(--ok-soft-fg); }
      .en-pedido { display: block; font-size: var(--fs-micro); font-weight: var(--fw-medium); color: var(--bad-soft-fg); }
      .sin-casar { font-size: 0.7rem; color: var(--warn-soft-fg); margin-left: 0.35rem; }
      .factor { margin-left: 0.25rem; font-size: 0.7rem; color: var(--text-muted); }
      .dto { font-size: 0.7rem; color: var(--ok-soft-fg); margin-left: 0.3rem; }
      .dto.recargo { color: var(--bad-fg); }
      .explica { display: block; font-size: var(--fs-xs); color: var(--text-main); }
      .cliente { display: block; margin-top: 0.25rem; }
      .pasos { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
      .falta { color: var(--bad-fg); font-weight: 600; }
      .falta-nota { display: block; font-size: var(--fs-xs); color: var(--bad-fg); }
      .t-none { font-style: italic; color: var(--text-muted); }
      /* [COT.35] El desglose («12 PAQ $34.99») va DEBAJO del precio: en la misma línea ensanchaba la columna. */
      .p-unit-cell { display: flex; flex-direction: column; align-items: flex-end; white-space: nowrap; }
      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 500; }
      .imp-antes { display: block; font-size: var(--fs-micro); color: var(--text-muted); white-space: normal; }
      /* [COT.43] El neto por unidad: debajo del desglose, mismo tamaño, el precio en el color del texto principal. */
      .p-neto { display: block; font-size: var(--fs-micro); color: var(--text-muted); white-space: normal; }
      .p-neto strong { color: var(--text); font-weight: 600; }
      .imp-antes .junto { white-space: nowrap; }
      .inline-qty-box { display: flex; justify-content: flex-end; }
      .qty-inline { width: 4rem; text-align: right; font-variant-numeric: tabular-nums; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    `,
  ],
})
export class QuoteLinesTableComponent {
  /**
   * [COT.33] ↑/↓ en la cantidad pasan a la del renglón de al lado. Salir del campo dispara su
   * `change`: lo tecleado se guarda igual que con Enter.
   */
  moverFoco(ev: Event, delta: number): void {
    const input = ev.target as HTMLInputElement;
    const todos = Array.from(input.closest('tbody')?.querySelectorAll<HTMLInputElement>('input.qty-inline') ?? []);
    const sig = todos[todos.indexOf(input) + delta];
    if (!sig) return;
    ev.preventDefault();
    sig.focus();
  }

  readonly renglones = input.required<RenglonTabla[]>();
  /** Mientras se guarda: la cantidad y el quitar quedan deshabilitados. */
  readonly bloqueado = input(false);
  /** `[E.29]` El % del cliente de la cotización (para rotular el neto); null = sin descuento. */
  readonly clientePct = input<number | null>(null);
  /** `[COT.46]` Id del último renglón agregado (lleva la franja). */
  readonly marcado = input<string | null>(null);
  /** `[COT.46]` Id del renglón resaltado un momento por «Ver en la lista». */
  readonly destello = input<string | null>(null);
  /** `[COT.47]` Nombre accesible de la tabla («Renglones de la cotización COT-2026-00472»). */
  readonly titulo = input<string>('Renglones de la cotización');

  // ── [COT.47] Buscar, filtrar y ordenar una lista larga ──────────────────────────────────────
  readonly umbralFiltros = RENGLONES_PARA_FILTRAR;
  readonly busqueda = signal('');
  readonly filtro = signal<FiltroRenglones>('todos');
  readonly orden = signal<OrdenRenglones>('captura');
  readonly visibles = computed(() => renglonesVisibles(this.renglones(), this.busqueda(), this.filtro(), this.orden()));
  readonly filtrando = computed(() => this.busqueda().trim() !== '' || this.filtro() !== 'todos');
  readonly opcionesFiltro = computed<SegOption[]>(() => {
    const n = cuentasRenglones(this.renglones());
    return [
      { label: 'Todos', value: 'todos', count: n.todos },
      { label: 'Faltan existencias', value: 'faltan', count: n.faltan },
      { label: 'Con promoción', value: 'promo', count: n.promo },
    ];
  });
  /** El de captura va primero: el número de renglón es el del pedido en Kepler. */
  readonly opcionesOrden: SegOption[] = [
    { label: 'Como se capturó', value: 'captura' },
    { label: 'Importe mayor', value: 'importe' },
    { label: 'Nombre', value: 'nombre' },
  ];
  quitarFiltros(): void {
    this.busqueda.set('');
    this.filtro.set('todos');
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  constructor() {
    // PrimeNG no deja nombrar su <table>: se le pone el nombre accesible ya pintada.
    afterRenderEffect(() => {
      const t = this.host.nativeElement.querySelector('table');
      if (t) t.setAttribute('aria-label', this.titulo());
    });
    // «Ver en la lista» de un renglón que el filtro esconde: se quita el filtro para poder llegar a él.
    effect(() => {
      const d = this.destello();
      if (d && !this.visibles().some((r) => r.id === d)) untracked(() => this.quitarFiltros());
    });
  }
  readonly cantidad = output<CambioCantidad>();
  readonly quitar = output<string>();

  readonly porId = (_: number, r: RenglonTabla): string => r.id;

  tipoExistencia(r: RenglonTabla): 'cargando' | 'sin-dato' | 'dato' | null {
    const e = r.existencia;
    if (e === null || r.regaloDe !== null) return null;
    return typeof e === 'string' ? e : 'dato';
  }

  etiqueta(s: string): string { return etiquetaFuentePrecio(s); }
  tono(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' { return tonoFuentePrecio(s); }
  textoDto(p: number): string { return textoDescuento(p); }

  dinero(v: number | null): string {
    return v === null ? '—' : v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  /** `[COT.43]` Precio por unidad con el % del cliente; null sin % de cliente (el precio ya es el neto). */
  netoUnidad(r: RenglonTabla): { precio: number; pasos: PasoDesglose[] } | null {
    return netoPorUnidad(r.neto, r.importe, r.cantidad, r.desglose);
  }

  /** `[E.29]` «Kepler redondea por PAQ a centavos: …» cuando el precio no es el de su último paso. */
  redondeo(r: RenglonTabla): string {
    return notaRedondeo(r.sinRedondear, r.precio, r.desglose[r.desglose.length - 1], (n) => this.dinero(n));
  }
}
