import { ChangeDetectionStrategy, Component, DOCUMENT, ElementRef, HostListener, computed, inject, input, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { resaltarCoincidencias, type TramoResaltado } from '@megadulces/ui-web';
import { branchLabel } from '../../../core/constants/store-branches';
import { diaMxDe, parseLocalDate } from '../../../core/utils/mx-date';
import type { ExpedienteDelDia } from '../comprobaciones.service';
import { BuscadorGastosEstado, MINIMO_BUSQUEDA_GASTOS } from './buscador-gastos.estado';


/** Cómo se dice el estado de un vale. La clave cruda es cómo se guarda, no cómo se dice. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma', aprobada: 'Aprobado · falta ejercer', revision: 'Falta revisarla',
  validada: 'Comprobado', rechazada: 'Rechazado',
};

/**
 * Cómo se dice el estado de Kepler de una solicitud sin vale. La columna ya se llama «En Kepler»:
 * repetir «en Kepler» en cada renglón era el mismo dato nueve veces.
 */
const ESTADO_KEPLER_LABEL: Record<string, string> = {
  N: 'Sin aplicar', A: 'Autorizada', F: 'Aplicada · salió el dinero',
};

/** Los tonos que acepta `p-tag`. */
type Tono = 'success' | 'secondary' | 'info' | 'warn' | 'danger' | 'contrast';

/**
 * `[GX.103]` Un renglón de la tabla de vales: lo que se ve y por lo que se ordena, más el vale para abrirlo.
 * Los campos `…T` son el mismo texto partido en tramos, con lo que coincide con la búsqueda marcado.
 */
interface FilaVale {
  id: string;
  folio: string;
  folioT: TramoResaltado[];
  sucursal: string;
  /** ISO: ordena bien como texto. */
  fecha: string;
  dia: Date | null;
  conceptoT: TramoResaltado[];
  /** Vacío si no hay proveedor, o si es el mismo texto que el concepto. */
  proveedorT: TramoResaltado[];
  importe: number;
  status: string;
  /** La persona principal: quien lo pidió, o quien lo levantó si no hay solicitante. */
  quienT: TramoResaltado[];
  /** El resto del trámite (levantó · cerró), en la segunda línea. */
  quienMasT: TramoResaltado[];
  vale: ExpedienteDelDia;
}

interface FilaSinVale {
  llave: string;
  folio: string;
  folioT: TramoResaltado[];
  sucursal: string;
  fecha: string;
  dia: Date | null;
  conceptoT: TramoResaltado[];
  beneficiarioT: TramoResaltado[];
  importe: number;
  estado: string | null;
  /** Vacío si Kepler no dice quién la pidió. */
  solicitanteT: TramoResaltado[];
}

/**
 * `[GX.88]` — **El buscador de gastos**, compartido por Aprobación, Mis gastos, Historial y Expediente.
 *
 * Pedido del usuario (2026-10-30): *«un buscador universal para los gastos, con folios, nombre,
 * quién lo levantó, quién aprobó»*, y después *«quiero el mismo buscador en historial y
 * expediente»*. Es UNO solo a propósito: tres copias del mismo buscador se separan a la
 * primera corrección.
 *
 * ## `[GX.103]` A la par de Kepler (2026-11-09)
 * La gente encontraba un gasto «mucho más rápido» en Kepler. Lo que Kepler tiene y aquí faltaba:
 *  · **ver sin escribir**: F9 enseña los últimos documentos. Aquí, «Últimos» (o F9, o Enter con la caja
 *    vacía) trae los últimos 50 vales y las solicitudes sin vale más recientes;
 *  · **folio + Enter abre** el documento. Aquí, si el folio es de UN solo vale, se abre directo;
 *  · **una tabla densa**, no tarjetas: se lee de un vistazo y se ordena por folio, fecha o importe;
 *  · **teclado**: F9 o `/` llevan a la caja (como `/` en Calendario de pagos), ↓ baja a los
 *    resultados, ↑↓ se mueve entre renglones, Enter abre y Esc regresa a la caja;
 *  · además busca por **monto** (`1250`, `1,250.00`, `$1,250`), que Kepler no hace.
 *
 * ### Cómo se ven los resultados (2026-11-09, visto en la pantalla viva)
 * Cada lista va en su tarjeta (`surf-panel`), con su título y su conteo. Las dos tablas tienen las
 * MISMAS columnas y del mismo ancho (`table-layout: fixed`): antes cada una se acomodaba a su texto
 * y las columnas no coincidían de una tabla a la otra. El folio lleva su sucursal debajo (el folio
 * es por sucursal) y el concepto lleva debajo al proveedor, como en Mis gastos. El estado va en
 * `p-tag`. Lo que coincide con la búsqueda se resalta (`resaltarCoincidencias`): así se ve por qué
 * salió un renglón, por ejemplo el «15» dentro de «0009915».
 *
 * ## Qué hace y qué NO
 * Busca (en el servidor: `GET /finance/expenses/proofs/buscar`) y muestra lo encontrado:
 * los **vales** de cualquier fecha y estado, y aparte las **solicitudes de Kepler sin vale**.
 * Al elegir un vale lo pasa al estado (`BuscadorGastosEstado.aperturas$`): qué se puede hacer
 * con él lo decide la PÁGINA (en Aprobación se decide; en Historial y Expediente sólo se consulta).
 * Mismo criterio que el visor del vale: este componente no conoce las acciones.
 *
 * ## ⛔ Sólo para quien aprueba
 * Deja ver el gasto de toda la empresa. Sin `FINANCE_EXPENSES_COMPROBAR` no se pinta nada, y el
 * servidor además responde 403.
 *
 * ## Dónde vive
 * `[GX.101]` La caja va junto al título de cada pantalla (`parte="caja"`) y los resultados debajo del
 * encabezado (`parte="resultados"`); el estado lo provee `GastosAreaShellComponent`. Las pantallas
 * esconden lo suyo mientras `buscando()` es verdad: los resultados las reemplazan, no se mezclan.
 */
@Component({
  selector: 'app-buscador-gastos',
  standalone: true,
  imports: [CommonModule, InputTextModule, TableModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.es-caja]': "parte() === 'caja'" },
  template: `
    @if (puedeBuscar()) {
      @if (parte() !== 'resultados') {
      <div class="bg-caja" role="search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input #caja pInputText type="search" class="bg-in" [value]="busqueda()"
               (input)="escribir($any($event.target).value)" (keydown.enter)="buscarYa()"
               (keydown.escape)="limpiar()" (keydown.arrowdown)="alPrimerRenglon($event)"
               aria-keyshortcuts="F9 /"
               [placeholder]="parte() === 'caja' ? 'Buscar gastos: folio, proveedor, persona o monto…' : 'Buscar en todos los gastos: folio, proveedor, monto, quién lo levantó, quién lo aprobó, quién lo pidió…'"
               aria-label="Buscar en todos los gastos" />
        @if (busqueda()) {
          <button type="button" class="bg-x" (click)="limpiar()" aria-label="Limpiar la búsqueda">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        } @else {
          <!-- [GX.103] Los últimos gastos sin escribir nada (F9 en Kepler). Es un botón y no sólo un
               atajo: en el celular no hay F9. -->
          <button type="button" class="bg-ultimos" (click)="verRecientes()" aria-keyshortcuts="F9"
                  title="Los últimos 50 gastos (F9, o Enter con la caja vacía)">
            Últimos <kbd aria-hidden="true">F9</kbd>
          </button>
        }
      </div>
      }

      @if (parte() !== 'caja' && buscando()) {
        @if (corta()) {
          <div class="bg-muted">Escribe al menos {{ minimo }} letras, o el folio.</div>
        } @else if (cargando() && !resultado()) {
          <div class="bg-muted">{{ recientes() ? 'Cargando los últimos gastos…' : 'Buscando…' }}</div>
        } @else if (error()) {
          <!-- Un error NO se pinta como «no hay resultados»: son dos afirmaciones distintas. -->
          <div class="bg-err">{{ error() }}</div>
        } @else if (resultado(); as r) {
          <!-- [GX.103] Mientras llega la búsqueda nueva, lo de antes se atenúa: no es la respuesta a lo
               que se acaba de escribir. -->
          <div class="bg-resultados" [class.bg-viejo]="cargando()" [attr.aria-busy]="cargando()">
            <section class="surf-panel" aria-label="Vales">
              <header class="surf-panel-head bg-head">
                <h2 class="bg-t">{{ r.recientes ? 'Los últimos vales' : 'Vales' }}<span class="bg-n">{{ r.vales.length }}{{ r.vales_truncado ? '+' : '' }}</span></h2>
                @if (filasVales().length) {
                  <!-- El atajo se escribe en pantalla: si no, existe y nadie lo sabe. -->
                  <p class="bg-nota bg-teclas"><kbd>↑</kbd><kbd>↓</kbd> moverte · <kbd>Enter</kbd> abrir · <kbd>Esc</kbd> volver a la caja</p>
                }
              </header>
              @if (r.vales_truncado) {
                <div class="bg-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  @if (r.recientes) {
                    <span>Son los últimos {{ r.vales.length }}. Para los demás, escribe un folio, un nombre o un monto.</span>
                  } @else {
                    <span>Hay más vales que coinciden. Escribe algo más preciso para verlos.</span>
                  }
                </div>
              }
              @if (filasVales().length) {
                <p-table [value]="filasVales()" dataKey="id" size="small" class="surf-table surf-table--plain bg-tabla"
                         [tableStyle]="{ 'table-layout': 'fixed' }">
                  <ng-template #header>
                    <tr>
                      <th class="bg-c-folio" pSortableColumn="folio">Folio <p-sorticon field="folio" /></th>
                      <th class="bg-c-fecha" pSortableColumn="fecha">Fecha <p-sorticon field="fecha" /></th>
                      <th class="bg-c-con">Concepto · proveedor</th>
                      <th class="bg-c-imp comm-num" pSortableColumn="importe">Importe <p-sorticon field="importe" /></th>
                      <th class="bg-c-estado">Estado</th>
                      <th class="bg-c-quien">Quién</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-f>
                    <!-- Sin aria-label en el renglón: taparía sus celdas al lector de pantalla. -->
                    <tr class="bg-vale" tabindex="0"
                        (click)="abrir(f.vale)" (keydown.enter)="abrir(f.vale)"
                        (keydown.arrowdown)="mover($event, 1)" (keydown.arrowup)="mover($event, -1)"
                        (keydown.escape)="aLaCaja($event)">
                      <td class="bg-c-folio">
                        <div class="bg-folio"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: f.folioT }" /></div>
                        <div class="bg-sub">{{ f.sucursal }}</div>
                      </td>
                      <td class="bg-c-fecha bg-fecha">{{ f.dia | date: 'dd/MM/yy' }}</td>
                      <td class="bg-c-con">
                        <div class="bg-con"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: f.conceptoT }" /></div>
                        @if (f.proveedorT.length) {
                          <div class="bg-sub"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: f.proveedorT }" /></div>
                        }
                      </td>
                      <td class="bg-c-imp comm-num is-strong bg-imp">{{ money(f.importe) }}</td>
                      <td class="bg-c-estado"><p-tag [value]="estado(f.status)" [severity]="tonoEstado(f.status)" /></td>
                      <td class="bg-c-quien">
                        <div class="bg-quien">
                          <div class="bg-quien-txt">
                            <div><ng-container *ngTemplateOutlet="marcas; context: { $implicit: f.quienT }" /></div>
                            @if (f.quienMasT.length) {
                              <div class="bg-sub"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: f.quienMasT }" /></div>
                            }
                          </div>
                          <!-- Lo que se abre lo dice sin pasar el mouse; la solicitud sin vale no lo lleva. -->
                          <i class="pi pi-angle-right bg-ir" aria-hidden="true"></i>
                        </div>
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              } @else {
                <div class="bg-vacio">{{ r.recientes ? 'Todavía no hay vales.' : 'Ningún vale coincide con «' + r.q + '».' }}</div>
              }
            </section>

            <section class="surf-panel" aria-label="Solicitudes de Kepler sin vale">
              <header class="surf-panel-head bg-head">
                <h2 class="bg-t">Solicitudes de Kepler sin vale<span class="bg-n">{{ r.sin_vale.length }}{{ r.sin_vale_truncado ? '+' : '' }}</span></h2>
                <!-- Se dice desde cuándo: antes de la Suite, una solicitud «sin vale» no es pendiente. -->
                @if (r.solicitudes_desde) {
                  <p class="bg-nota">Nadie las subió a la Suite. Se buscan desde el {{ diaLocal(r.solicitudes_desde) | date: 'dd/MM/yy' }}, cuando empezó a usarse.</p>
                }
              </header>
              @if (r.sin_vale_truncado) {
                <div class="bg-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  @if (r.recientes) {
                    <span>Son las más recientes. Para las demás, escribe un folio, un nombre o un monto.</span>
                  } @else {
                    <span>Puede haber más solicitudes que coinciden. Escribe algo más preciso.</span>
                  }
                </div>
              }
              @if (filasSinVale().length) {
                <p-table [value]="filasSinVale()" dataKey="llave" size="small" class="surf-table surf-table--plain bg-tabla"
                         [tableStyle]="{ 'table-layout': 'fixed' }">
                  <ng-template #header>
                    <tr>
                      <th class="bg-c-folio" pSortableColumn="folio">Folio <p-sorticon field="folio" /></th>
                      <th class="bg-c-fecha" pSortableColumn="fecha">Fecha <p-sorticon field="fecha" /></th>
                      <th class="bg-c-con">Concepto · beneficiario</th>
                      <th class="bg-c-imp comm-num" pSortableColumn="importe">Importe <p-sorticon field="importe" /></th>
                      <th class="bg-c-estado">En Kepler</th>
                      <th class="bg-c-quien">La pidió</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-s>
                    <!-- La solicitud sin vale no se abre: no hay expediente que mirar. Se ve, no se clica. -->
                    <tr class="bg-sinvale">
                      <td class="bg-c-folio">
                        <div class="bg-folio"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: s.folioT }" /></div>
                        <div class="bg-sub">{{ s.sucursal }}</div>
                      </td>
                      <td class="bg-c-fecha bg-fecha">{{ s.dia | date: 'dd/MM/yy' }}</td>
                      <td class="bg-c-con">
                        <div class="bg-con"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: s.conceptoT }" /></div>
                        @if (s.beneficiarioT.length) {
                          <div class="bg-sub"><ng-container *ngTemplateOutlet="marcas; context: { $implicit: s.beneficiarioT }" /></div>
                        }
                      </td>
                      <td class="bg-c-imp comm-num is-strong bg-imp">{{ money(s.importe) }}</td>
                      <td class="bg-c-estado"><p-tag [value]="estadoKepler(s.estado)" [severity]="tonoKepler(s.estado)" /></td>
                      <td class="bg-c-quien">
                        @if (s.solicitanteT.length) {
                          <ng-container *ngTemplateOutlet="marcas; context: { $implicit: s.solicitanteT }" />
                        } @else {
                          <span class="bg-sub">Kepler no dice quién</span>
                        }
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              } @else {
                <div class="bg-vacio">{{ r.recientes ? 'No hay solicitudes de Kepler sin vale.' : 'Ninguna solicitud sin vale coincide.' }}</div>
              }
            </section>
          </div>
        }
      }
    }

    <!-- [GX.103] Un texto partido en tramos: lo que coincide con la búsqueda va en mark. Todo en una
         línea a propósito: un espacio entre tramos se vería como un espacio dentro de la palabra. -->
    <ng-template #marcas let-tramos>@for (x of tramos; track $index) {@if (x.m) {<mark class="bg-hit">{{ x.t }}</mark>} @else {<span>{{ x.t }}</span>}}</ng-template>
  `,
  styles: [`
    :host { display: block; }
    /* [GX.101] En el encabezado de la pantalla, junto al título: crece hasta un ancho cómodo. */
    :host(.es-caja) { flex: 1 1 18rem; max-width: 30rem; margin-left: auto; }
    .bg-caja { position: relative; display: flex; align-items: center; }
    .bg-caja > .pi-search { position: absolute; left: var(--sp-3); color: var(--fg-3); pointer-events: none; }
    .bg-in { width: 100%; padding-left: calc(var(--sp-3) * 2 + 1rem); padding-right: 6.5rem; font-size: var(--fs-sm); }
    .bg-x { position: absolute; right: var(--sp-2); display: inline-flex; align-items: center; justify-content: center;
      min-width: var(--tap-min, 2rem); min-height: var(--tap-min, 2rem); border: 0; background: none;
      color: var(--fg-3); cursor: pointer; border-radius: var(--r-sm); }
    .bg-x:hover { color: var(--fg-1); }
    /* [GX.101] La tachita propia ya borra; la del navegador (type=search) era una segunda igual al lado. */
    .bg-in::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; display: none; }
    .bg-x:focus-visible, .bg-ultimos:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* [GX.103] «Últimos»: dentro de la caja, a la derecha, mientras está vacía. */
    .bg-ultimos { position: absolute; right: var(--sp-1); display: inline-flex; align-items: center; gap: var(--sp-1);
      min-height: var(--tap-min, 2rem); padding: 0 var(--sp-2); border: 0; background: none; cursor: pointer;
      font-size: var(--fs-xs); color: var(--fg-2); border-radius: var(--r-sm); }
    .bg-ultimos:hover { color: var(--fg-1); background: var(--hover-bg); }
    kbd { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-2); background: var(--card-bg);
      border: 1px solid var(--border-color); border-bottom-width: 2px; border-radius: var(--r-sm); padding: 0 5px; line-height: 1.5; }
    kbd + kbd { margin-left: 2px; }
    .bg-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-3); }
    .bg-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); margin-top: var(--sp-2); }

    /* [GX.103] Los resultados: una tarjeta por lista. El contenedor mide el ancho para las columnas. */
    .bg-resultados { container: bg-res / inline-size; display: flex; flex-direction: column; gap: var(--sp-4);
      margin-top: var(--sp-3); transition: opacity 150ms ease; }
    .bg-resultados.bg-viejo { opacity: .55; }
    @media (prefers-reduced-motion: reduce) { .bg-resultados { transition: none; } }
    .bg-head { flex-wrap: wrap; position: static; }
    .bg-t { margin: 0; display: inline-flex; align-items: center; gap: var(--sp-2);
      font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    .bg-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs);
      font-weight: var(--fw-medium); color: var(--fg-2); background: var(--layout-bg); border-radius: var(--r-pill); padding: 0 var(--sp-2); }
    .bg-nota { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
    /* Sin teclado físico, los atajos no dicen nada. */
    @media (pointer: coarse) { .bg-teclas { display: none; } }
    /* [GX.103] Texto ámbar con el tono «soft»: el --warn-fg suelto da 2.15:1 sobre blanco y no se lee. */
    .bg-aviso { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--warn-soft-fg);
      background: var(--warn-soft-bg); border-bottom: 1px solid var(--warn-border); padding: var(--sp-2) var(--sp-4); }
    .bg-vacio { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-4); }

    /* Las dos tablas, columna por columna del mismo ancho: el concepto toma lo que sobra. */
    .bg-tabla th.bg-c-folio { width: 9.5rem; }
    .bg-tabla th.bg-c-fecha { width: 6rem; }
    .bg-tabla th.bg-c-imp { width: 8rem; }
    .bg-tabla th.bg-c-estado { width: 12rem; }
    .bg-tabla th.bg-c-quien { width: 14rem; }
    /* El texto de la primera columna arranca donde arranca el título de la tarjeta. */
    .bg-tabla th:first-child, .bg-tabla td:first-child { padding-left: var(--sp-4); }
    .bg-tabla th:last-child, .bg-tabla td:last-child { padding-right: var(--sp-4); }
    /* Renglones de dos líneas: todo se alinea a la PRIMERA línea, que es la que se lee de corrido. */
    .bg-tabla td { vertical-align: baseline; }
    /* En angosto, la persona se deja para el vale abierto: el concepto no se puede quedar sin ancho. */
    @container bg-res (max-width: 64rem) { .bg-c-quien { display: none; } }

    .bg-tabla .bg-vale { cursor: pointer; }
    .bg-tabla .bg-vale:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .bg-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); font-size: var(--fs-sm); color: var(--fg-1); white-space: nowrap; }
    .bg-fecha { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg-2); white-space: nowrap; }
    .bg-con { font-size: var(--fs-sm); color: var(--fg-1); overflow-wrap: anywhere; }
    .bg-sub { font-size: var(--fs-xs); color: var(--fg-3); margin-top: 2px; overflow-wrap: anywhere; }
    .bg-imp { white-space: nowrap; }
    .bg-quien { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--fg-2); }
    .bg-quien-txt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .bg-ir { flex: none; font-size: var(--fs-xs); color: var(--fg-3); }
    .bg-vale:hover .bg-ir, .bg-vale:focus-visible .bg-ir { color: var(--action); }
    /* Lo que coincide con la búsqueda. La sombra ensancha el fondo sin mover el texto: con relleno,
       los dígitos del folio dejarían de quedar en columna de un renglón al otro. */
    .bg-hit { background: var(--warn-soft-bg); color: inherit; border-radius: 2px; box-shadow: 0 0 0 1px var(--warn-soft-bg); }
  `],
})
export class BuscadorGastosComponent {
  /** El estado vive en el shell de Gastos: por eso lo escrito sobrevive al cambiar de pestaña. */
  private readonly e = inject(BuscadorGastosEstado);
  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /**
   * `[GX.101]` Qué pieza pinta: la caja (va junto al título de cada pantalla), los resultados (van
   * debajo del encabezado y reemplazan a la pantalla) o las dos juntas. Las dos piezas leen el MISMO
   * estado: lo escrito en la caja es lo que buscan los resultados.
   */
  readonly parte = input<'todo' | 'caja' | 'resultados'>('todo');
  private readonly caja = viewChild<ElementRef<HTMLInputElement>>('caja');

  readonly branchLabel = branchLabel;
  readonly minimo = MINIMO_BUSQUEDA_GASTOS;
  readonly puedeBuscar = this.e.puedeBuscar;
  readonly busqueda = this.e.busqueda;
  readonly recientes = this.e.recientes;
  readonly resultado = this.e.resultado;
  readonly cargando = this.e.cargando;
  readonly error = this.e.error;
  readonly buscando = this.e.buscando;
  readonly corta = this.e.corta;

  /**
   * `[GX.103]` Lo que se resalta: la búsqueda que produjo ESTOS resultados (no lo que ya se está
   * escribiendo en la caja). Con los recientes no se buscó nada, y nada se resalta.
   */
  private readonly buscado = computed(() => {
    const r = this.resultado();
    return r && !r.recientes ? r.q : '';
  });

  /** `[GX.103]` Los vales como renglones de tabla: el importe como número y la fecha ISO, para que ordenen bien. */
  readonly filasVales = computed<FilaVale[]>(() => {
    const q = this.buscado();
    const marcar = (t: string | null | undefined) => resaltarCoincidencias(t, q);
    return (this.resultado()?.vales ?? []).map((v) => {
      const folio = v.folio_solicitud || 'sin folio';
      const proveedor = v.concepto && v.proveedor && v.proveedor !== v.concepto ? v.proveedor : null;
      const levanto = `levantó ${v.created_by || '—'}`;
      return {
        id: v.id,
        folio,
        folioT: marcar(folio),
        sucursal: v.sucursal ? branchLabel(v.sucursal) || v.sucursal : '—',
        fecha: v.created_at ?? '',
        // [GX.106] El día de México: cortar la marca UTC en la T leería del día siguiente lo mandado en la noche.
        dia: parseLocalDate(diaMxDe(v.created_at)),
        conceptoT: marcar(v.concepto || v.proveedor || '—'),
        proveedorT: marcar(proveedor),
        importe: Number(v.importe) || 0,
        status: v.status,
        quienT: marcar(v.solicitante ? `pidió ${v.solicitante}` : levanto),
        quienMasT: marcar([
          v.solicitante ? levanto : null,
          v.validated_by ? `cerró ${v.validated_by}` : null,
        ].filter(Boolean).join(' · ')),
        vale: v,
      };
    });
  });

  readonly filasSinVale = computed<FilaSinVale[]>(() => {
    const q = this.buscado();
    const marcar = (t: string | null | undefined) => resaltarCoincidencias(t, q);
    return (this.resultado()?.sin_vale ?? []).map((s) => ({
      llave: `${s.sucursal}|${s.folio}`,
      folio: s.folio,
      folioT: marcar(s.folio),
      sucursal: branchLabel(s.sucursal) || s.sucursal,
      fecha: s.fecha ?? '',
      dia: parseLocalDate(diaMxDe(s.fecha)),
      conceptoT: marcar(s.concepto || s.beneficiario || '—'),
      beneficiarioT: marcar(s.concepto && s.beneficiario && s.beneficiario !== s.concepto ? s.beneficiario : null),
      importe: Number(s.importe) || 0,
      estado: s.estado,
      solicitanteT: marcar(s.solicitante),
    }));
  });

  escribir(v: string): void { this.e.escribir(v); }
  buscarYa(): void { this.e.buscarYa(); }
  limpiar(): void { this.e.limpiar(); }
  verRecientes(): void { this.e.verRecientes(); }
  /** El vale elegido. Qué se hace con él lo decide la pantalla de la pestaña activa. */
  abrir(v: ExpedienteDelDia): void { this.e.abrir(v); }

  /**
   * `[GX.103]` F9 (la tecla de buscar en Kepler) y `/` (el atajo de la Suite, como en Calendario de pagos)
   * llevan a la caja desde cualquier parte. F9 con la caja vacía, además, trae los últimos. Lo atiende sólo
   * la pieza que tiene la caja, y nunca dentro de un diálogo (el visor del vale abierto). `/` tampoco
   * mientras se escribe en otro campo: ahí es una diagonal.
   */
  @HostListener('document:keydown', ['$event'])
  atajo(ev: KeyboardEvent): void {
    if (this.parte() === 'resultados' || !this.puedeBuscar() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t?.closest?.('.p-dialog, [role="dialog"]')) return;
    if (ev.key === 'F9') {
      ev.preventDefault();
      this.enfocarCaja();
      if (!this.busqueda().trim()) this.verRecientes();
      return;
    }
    if (ev.key === '/' && !t?.closest?.('input, textarea, select, [contenteditable="true"]')) {
      ev.preventDefault();
      this.enfocarCaja();
    }
  }

  /** ↓ en la caja: al primer renglón. Con la caja vacía y sin resultados, trae los últimos. */
  alPrimerRenglon(ev: Event): void {
    const primero = this.renglones()[0];
    if (primero) { ev.preventDefault(); primero.focus(); return; }
    if (!this.busqueda().trim() && !this.buscando()) { ev.preventDefault(); this.verRecientes(); }
  }

  /** ↑↓ entre renglones; ↑ en el primero regresa a la caja. */
  mover(ev: Event, paso: 1 | -1): void {
    ev.preventDefault();
    const filas = this.renglones();
    const i = filas.indexOf(ev.currentTarget as HTMLElement);
    const destino = filas[i + paso];
    if (destino) destino.focus();
    else if (paso < 0) this.enfocarCaja();
  }

  /** Esc en un renglón: de vuelta a la caja, sin borrar lo buscado. */
  aLaCaja(ev: Event): void {
    ev.preventDefault();
    this.enfocarCaja();
  }

  /** La caja y los resultados pueden ser dos piezas distintas de la pantalla: se buscan en el documento. */
  private renglones(): HTMLElement[] {
    const propios = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('tr.bg-vale'));
    return propios.length ? propios : Array.from(this.doc.querySelectorAll<HTMLElement>('app-buscador-gastos tr.bg-vale'));
  }

  private enfocarCaja(): void {
    const el = this.caja()?.nativeElement ?? this.doc.querySelector<HTMLInputElement>('app-buscador-gastos input.bg-in');
    el?.focus();
    el?.select();
  }

  /** La fecha ISO como `Date` local, para que el pipe no corra el día. */
  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }
  estado(s: string): string { return ESTADO_LABEL[s] ?? s; }
  /**
   * `[GX.103]` El tono de la pastilla del vale. Color sólo donde dice algo: verde lo que ya cerró,
   * rojo lo rechazado, ámbar lo que se regresó a revisar. Lo demás va neutro: es el trámite normal.
   */
  tonoEstado(s: string): Tono {
    if (s === 'validada') return 'success';
    if (s === 'rechazada') return 'danger';
    if (s === 'revision') return 'warn';
    return 'secondary';
  }
  estadoKepler(e: string | null | undefined): string {
    const k = String(e ?? '').trim().toUpperCase();
    return ESTADO_KEPLER_LABEL[k] ?? (k ? `Estado ${k}` : 'Sin estado');
  }
  /**
   * `[GX.103]` Una solicitud sin vale cuyo dinero ya salió (`F`) es la que pide atención: se pagó y
   * en la Suite no hay comprobante. Autorizada o sin aplicar es el trámite normal.
   */
  tonoKepler(e: string | null | undefined): Tono {
    return String(e ?? '').trim().toUpperCase() === 'F' ? 'warn' : 'secondary';
  }
  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }
}
