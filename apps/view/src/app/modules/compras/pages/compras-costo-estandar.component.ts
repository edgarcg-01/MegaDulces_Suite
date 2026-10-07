import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { bajarAlPrimerRenglon, volverAlBuscador } from '@megadulces/ui-web';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTEXT_HELP } from '../../../shared/context-help/context-help.dictionary';
import {
  CostoEstandarService,
  FilaCostoEstandar,
  ResumenCostoEstandar,
  VeredictoCostoEstandar,
} from '../costo-estandar.service';

/**
 * `[CE.6]` — **Costo estándar**: con qué costo está poniendo precio Kepler, y si se parece a lo
 * que cuesta reponer hoy.
 *
 * ── Qué decide esta pantalla ────────────────────────────────────────────────────────────────
 * El costo estándar es el de la ficha del producto (`kdii.c77`) y **es el que fija el precio**:
 * `PV = costo × (1 + margen%) × (1 + impuesto%)`. Si ese costo quedó viejo, el precio se calculó
 * sobre una base que ya no existe. Esta pantalla lo pone al lado del costo de reposición del ERP
 * y ordena por el dinero en juego.
 *
 * ── ⛔ Las tres cosas que la pantalla tiene que DECIR, no esconder ───────────────────────────
 *
 *  1. **El peldaño.** El testigo no siempre viene en la misma unidad que el costo estándar
 *     (4.17 % de los pares no cae en ningún peldaño). Esas filas salen como `no_comparable`
 *     **sin cifra de desviación** — no se restan. La columna «Peldaño» está a la vista para que
 *     nadie confunda un cambio de unidad con un rezago de costo.
 *  2. **Lo no valorado acompaña al total.** El pie de los KPIs dice cuántas filas quedaron fuera
 *     de la suma. Un total sin ese acompañante afirma más de lo que el dato sostiene.
 *  3. **Hasta cuándo llega la ventana.** `actividad_al` viene del servidor y se imprime. Si la
 *     vista materializada no se refrescó, «últimos 30 días» deja de ser cierto y hay que verlo
 *     en pantalla, no en un log (ADR-056 / la falla de VP.0.1).
 *
 * Operations: sin Fraunces, sin ilustraciones, tabla densa + detalle maestro-detalle.
 *
 * ── `[CE.9]` Lo que se corrigió contra DESIGN.md, todo medido ────────────────────────────────
 *
 *  · **§553 / UIM.1** — 62 rem de anchos de columna fijos contra un teléfono de 430 px. Ahora
 *    `.dt-scope` + `.dt-stack` + `data-label`/`role="cell"` en cada celda, y el `min-width` se
 *    DECLARA para que la compuerta lo vea (lo medía por `min-width` y acá el ancho venía por CSS).
 *  · **D.0** — `.ta-r` inventada era `(0,1,0)` y perdía contra el `text-align:start` de PrimeNG:
 *    el dato a la derecha y su título a la izquierda. Pasa a `.num`, que gana por elemento.
 *  · **D.2 / §P / §Q.7** — la jerga («Peldaño», «Desv.», «Impacto 30 d») no tenía afordancia, y
 *    las definiciones vivían sueltas en este archivo. Van al diccionario versionado, que §P
 *    declara fuente única, y el `title` del `<th>` las trae de ahí (`.surf-def` las subraya sola).
 *  · **D.4a/b** — siete chips eran siete paradas de tabulador; ahora es un radiogroup con
 *    flechas. Y la barra de filtros dice cuántos hay activos y se limpia de un gesto.
 *  · **§datos densos 7** — `limite: 300` clavado y `desplazamiento` nunca enviado: de las 424
 *    filas de «sin costo en el ERP» —el hueco REAL que esta fase existe para exponer— se veían
 *    300 y no había página dos. Paginación de servidor.
 *  · **§Q.2** — sólo se publicaba el COGS subdeclarado. El servicio ya calculaba la otra mitad
 *    y el neto; publicar la mitad que asusta es una cifra de una sola cara.
 *  · **§Q.5** — `font-size` en literales contra la escala `--fs-*`, que es estricta.
 */

type Veredicto = VeredictoCostoEstandar;

const ROTULO: Record<Veredicto, string> = {
  estandar_bajo: 'Estándar por debajo',
  estandar_alto: 'Estándar por encima',
  no_comparable: 'No comparable',
  sin_testigo: 'Sin costo en el ERP',
  al_dia: 'Al día',
  sin_estandar: 'Sin costo estándar',
  sin_operacion: 'Sin operación en la plaza',
  testigo_inverosimil: 'Costo del ERP vacío',
};

/**
 * ⛔ DESIGN §P: *"La descripción NO se inventa: se consume de un diccionario de negocio
 * predefinido y versionado… Si falta la entrada, se agrega al diccionario, no un texto suelto."*
 * Acá había un `Record` con los textos escritos a mano — o sea la copia que §P prohíbe, y que en
 * cuanto alguien edita una de las dos se vuelve otra versión de la verdad.
 *
 * El rótulo de cada veredicto **es** el `term` de su entrada, así que el tooltip se LEE del
 * diccionario. ⚠️ Si una entrada se borra o se le cambia el nombre, el tooltip queda vacío y se
 * pierde el atajo de escritorio — la definición sigue completa en el cajón, que según D.2 es el
 * canal, no el atajo.
 */
const DEFS = new Map<string, string>(
  (CONTEXT_HELP['costo-estandar']?.groups ?? [])
    .flatMap((g) => g.entries)
    .map((e) => [e.term, e.def] as const),
);

const SEVERIDAD: Record<Veredicto, 'success' | 'warn' | 'danger' | 'info' | 'secondary'> = {
  estandar_bajo: 'danger',
  estandar_alto: 'warn',
  no_comparable: 'info',
  sin_testigo: 'warn',
  al_dia: 'success',
  sin_estandar: 'secondary',
  sin_operacion: 'secondary',
  testigo_inverosimil: 'warn',
};

@Component({
  selector: 'app-compras-costo-estandar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, SelectModule, CheckboxModule, SkeletonModule, TagModule, MetricStripComponent,
    SegmentedComponent, ContextHelpComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo estándar</h1>
          <p class="surf-page-sub">
            El costo de la <strong>ficha del producto en Kepler</strong> — el que fija el precio
            (<code>PV = costo × (1 + margen) × (1 + impuesto)</code>) — contra el
            <strong>costo del ERP</strong> en esa plaza. Ordenado por el dinero en juego.
          </p>
        </div>
        <div class="ce-head-actions">
          <!-- DESIGN §P + §Q.7: la jerga se consulta sin salir de la pantalla, y sale del
               diccionario versionado. En táctil no hay hover: éste es el canal, el title es el atajo. -->
          <app-context-help topic="costo-estandar" />
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="cargando()" (click)="recargar()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (error(); as e) {
        <div class="ce-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="ce-err-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="recargar()" label="Reintentar"></button>
        </div>
      }

      @if (resumen(); as r) {
        @if (r.bajo_costo.fichas > 0) {
          <!-- [CE.9] La respuesta primero. La brecha de costo es el diagnostico; ESTO es el hecho:
               al precio de hoy, contra el costo real, estas fichas pierden dinero en cada venta.
               El catalogo no lo muestra porque calcula el margen contra un costo que ya no se paga. -->
          <div class="ce-titular" role="status">
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
            <div>
              <strong>{{ n(r.bajo_costo.fichas) }} fichas se venden bajo costo al precio de hoy</strong>
              — {{ money(r.bajo_costo.venta_30d) }} de venta en 30 días
              @if (r.bajo_costo.peor_margen_pct !== null) { · el peor margen es {{ pct(r.bajo_costo.peor_margen_pct) }} }
              <button pButton type="button" class="p-button-sm p-button-text ce-titular-cta"
                      (click)="onSoloBajoCosto(!soloBajoCosto())">
                <span class="p-button-label">{{ soloBajoCosto() ? 'Ver todas' : 'Ver sólo ésas' }}</span>
              </button>
            </div>
          </div>
        }
        <!-- [CE.9] Capturar el costo nuevo NO es higiene de datos: Kepler conserva el margen y
             recalcula el precio. Medido sobre 6,501 cambios reales: el precio siguio al costo en
             el 74.02 % y solo en el 1.28 % se quedo quieto. La pantalla no puede proponer una
             captura sin decir eso. -->
        <p class="ce-aviso">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Capturar un costo nuevo <strong>mueve el precio de venta</strong>: Kepler conserva el margen y lo recalcula
          (medido, el precio siguió al costo en el <strong>74 %</strong> de 6,501 cambios reales).
          Por eso cada fila muestra <strong>las dos salidas</strong> y no una instrucción.
        </p>
        <app-metric-strip [items]="kpis(r)" ariaLabel="Costo estándar contra costo de reposición" />
        <p class="ce-proc">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Ventana de actividad hasta <strong>{{ r.actividad_al ?? 'sin medir' }}</strong>.
          @if (!r.actividad_al) { <span class="ce-warn">La vista materializada nunca se refrescó: «últimos 30 días» no es verificable.</span> }
          De {{ n(r.cobertura.filas_con_operacion) }} filas con operación,
          <strong>{{ n(r.cobertura.filas_comparables) }}</strong> se pudieron comparar
          ({{ r.cobertura.pct_comparable !== null ? pct(r.cobertura.pct_comparable) : 'sin medir' }})
          y <strong>{{ n(r.cobertura.filas_sin_valorar) }}</strong> quedaron fuera de las sumas de dinero.
          <span class="ce-alcance">Los mosaicos y los chips miden la plaza y el texto del buscador, igual que la tabla; el chip de veredicto no se aplica a los conteos.</span>
          @if (r.oficinas_excluidas > 0) {
            <span class="ce-alcance">La plaza <strong>00 es Oficinas y no vende</strong>: {{ n(r.oficinas_excluidas) }} fichas suyas quedan fuera de todo lo de arriba.</span>
          }
        </p>
      }

      <!-- DESIGN D.4(b): la barra dice cuántos filtros hay puestos y se limpia de un gesto.
           El botón EXISTE sólo si hay algo que limpiar — uno deshabilitado para siempre es ruido. -->
      <div class="ce-filtros">
        <p-iconfield styleClass="ce-buscar">
          <p-inputicon styleClass="pi pi-search" />
          <!-- [KBD.1] El salto buscador -> lista. Existia en 1 de 153 pantallas y es el gesto que
               separa "tiene teclado" de "se siente rapido": escribis, mirás, y con una flecha ya
               estás en la primera fila. La vuelta es Escape, abajo. -->
          <input pInputText #buscador type="text" placeholder="SKU o nombre…" [ngModel]="q()" (ngModelChange)="onBuscar($event)"
                 (keydown.arrowdown)="aLaLista($event)"
                 class="p-inputtext-sm" aria-label="Buscar por SKU o nombre (flecha abajo entra a la lista)" />
        </p-iconfield>
        <p-select class="ce-sel" [options]="opcionesSucursal" [ngModel]="sucursal()" (onChange)="onSucursal($event.value)"
                  optionLabel="label" optionValue="value" placeholder="Todas las plazas" [showClear]="true"
                  ariaLabel="Sucursal" appendTo="body" />
        <label class="ce-chk">
          <p-checkbox [ngModel]="incluirSinOperacion()" (ngModelChange)="onSinOperacion($event)" [binary]="true" inputId="ce-sinop" />
          <span>Incluir fichas sin operación en la plaza</span>
        </label>
        <label class="ce-chk">
          <p-checkbox [ngModel]="soloBajoCosto()" (ngModelChange)="onSoloBajoCosto($event)" [binary]="true" inputId="ce-bc" />
          <span>Sólo las que venden bajo costo</span>
        </label>
        @if (filtrosActivos(); as act) {
          <span class="ce-activos">{{ act }} {{ act === 1 ? 'filtro activo' : 'filtros activos' }}</span>
          <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="limpiar()"
                  label="Limpiar filtros"></button>
        }
      </div>

      @if (opcionesVeredicto().length > 1) {
        <!-- DESIGN D.1 + D.4(a): los veredictos son MUTUAMENTE EXCLUYENTES, o sea un selector de
             valor, y como chips sueltos se veían igual que un toggle y costaban un tab stop cada
             uno. app-segmented es el radiogroup canónico: UN stop, flechas, Home/End.
             NO PONER ACENTOS GRAVES ACÁ: esto vive dentro de un template literal de TS. -->
        <app-segmented class="ce-seg" [options]="opcionesVeredicto()" [value]="veredicto()"
                       (valueChange)="onVeredicto($any($event))" ariaLabel="Filtrar por veredicto" />
      }

      @if (cargando()) {
        <div class="ce-skel">@for (i of filasSkel; track i) { <p-skeleton height="2rem" styleClass="ce-skel-row" /> }</div>
      } @else {
        <div class="ce-split">
          <!-- [UIM.1] El .dt-scope va en el CONTENEDOR, no en la tabla: un elemento no puede ser
               su propio container-query. Sin esto dense-table.css queda inerte, y una pantalla
               inerte se ve igual que una rota pero con el build en verde. -->
          <!-- [KBD.1] NO PONER ACENTOS GRAVES ACA (template literal de TS).
               El #grid acota a DONDE baja la flecha: esta pantalla tiene una segunda tabla
               en el panel de detalle, y sin acotar el foco se iria a esa. Escape vuelve al
               buscador con el texto seleccionado, para que teclear lo reemplace. -->
          <div class="ce-grid dt-scope" #grid (keydown.escape)="aBuscador(buscador)">
          <p-table [value]="filas()" class="surf-table surf-table--sticky ce-tabla dt-stack"
                   size="small" [rowHover]="true"
                   [scrollable]="true" scrollHeight="calc(100vh - 28rem)"
                   [tableStyle]="{ 'min-width': '79rem' }"
                   [lazy]="true" (onLazyLoad)="paginar($event)" [paginator]="true"
                   [totalRecords]="total()" [rows]="tam()" [first]="primerRenglon()"
                   [rowsPerPageOptions]="[50, 100, 200]" [showCurrentPageReport]="true"
                   currentPageReportTemplate="{first} a {last} de {totalRecords} fichas"
                   [(selection)]="seleccion" selectionMode="single" dataKey="ce_id"
                   (selectionChange)="onSeleccion($event)">
            <ng-template #header>
              <tr>
                <th class="ce-w-sku">SKU</th>
                <th>Producto</th>
                <th class="ce-w-suc">Plaza</th>
                <th class="ce-w-u">Unidad</th>
                <th class="num ce-w-money" [title]="def('Costo estándar')">Estándar</th>
                <th class="num ce-w-money" [title]="def('Costo de reposición')">Reposición</th>
                <th class="ce-w-peld" [title]="def('Peldaño')">Peldaño</th>
                <th class="num ce-w-pct" [title]="def('Desviación')">Desv.</th>
                <th class="num ce-w-money" [title]="def('Impacto 30 d')">Impacto 30 d</th>
                <th class="num ce-w-pct" title="Si el precio NO se mueve, éste es el margen que de verdad estás sacando hoy, contra el costo real del ERP. En rojo, el producto pierde dinero en cada venta.">Margen real hoy</th>
                <th class="num ce-w-precio" title="Si capturás el costo nuevo, Kepler conserva el margen y recalcula el precio a esto. Es un cambio de precio al público.">Precio si capturás</th>
                <th class="ce-w-ver">Veredicto</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr [pSelectableRow]="f" class="ce-fila" [class.is-mal]="f.vende_bajo_costo">
                <td class="ce-mono" role="cell" data-label="SKU">{{ f.sku }}</td>
                <td class="ce-nom dt-id" role="cell" [title]="f.nombre">{{ f.nombre ?? '—' }}</td>
                <td class="ce-mono" role="cell" data-label="Plaza">{{ f.sucursal }}</td>
                <td class="ce-u" role="cell" data-label="Unidad">{{ f.unidad_base ?? '—' }}</td>
                <!-- aria-label además del data-label: el rótulo apilado se pinta con ::before y su
                     anuncio no es uniforme entre navegadores; una cifra suelta no se entiende sin él. -->
                <td class="num dt-num" role="cell" data-label="Estándar"
                    [attr.aria-label]="'Costo estándar ' + money(f.costo_estandar)">{{ money(f.costo_estandar) }}</td>
                <td class="num dt-num" role="cell" data-label="Reposición"
                    [attr.aria-label]="'Costo de reposición ' + money(f.costo_reposicion_base ?? f.costo_reposicion)">{{ money(f.costo_reposicion_base ?? f.costo_reposicion) }}</td>
                <td role="cell" data-label="Peldaño">
                  @if (f.peldano_reposicion === 'base') { <span class="ce-peld-ok">base</span> }
                  @else if (f.peldano_reposicion) { <span class="ce-peld-mal">{{ etiquetaPeldano(f) }}</span> }
                  @else { <span class="ce-nd">—</span> }
                </td>
                <td class="num dt-num" role="cell" data-label="Desviación">
                  @if (f.desviacion_pct !== null) {
                    <span [class.ce-neg]="f.desviacion_pct > 0" [class.ce-pos]="f.desviacion_pct < 0">{{ pct(f.desviacion_pct) }}</span>
                  } @else { <span class="ce-nd" [title]="ayuda(f.veredicto)">sin medir</span> }
                </td>
                <td class="num dt-num" role="cell" data-label="Impacto 30 d"
                    [attr.aria-label]="f.impacto_cogs_30d !== null ? 'Impacto 30 días ' + money(f.impacto_cogs_30d) : 'Impacto 30 días sin valorar'">
                  @if (f.impacto_cogs_30d !== null) { {{ money(f.impacto_cogs_30d) }} } @else { <span class="ce-nd">—</span> }
                </td>
                <td class="num dt-num" role="cell" data-label="Margen real hoy"
                    [attr.aria-label]="f.margen_real_pct !== null ? 'Margen real hoy ' + pct(f.margen_real_pct) : 'Margen real hoy sin medir'">
                  @if (f.margen_real_pct !== null) {
                    <span [class.ce-neg]="f.vende_bajo_costo">{{ pct(f.margen_real_pct) }}</span>
                    <!-- ⛔ Acá decía class="ce-sr", que NO EXISTE en ningún archivo del repo. Una
                         clase inventada no esconde nada: el texto se pintaba VISIBLE, dentro de una
                         columna de 6rem con nowrap, en cada fila que vende bajo costo. La utilidad
                         de verdad es .sr-only, global en styles.css.
                         NO PONER ACENTOS GRAVES ACÁ: esto vive dentro de un template literal. -->
                    @if (f.vende_bajo_costo) { <span class="sr-only">vende bajo costo</span> }
                  } @else { <span class="ce-nd">—</span> }
                </td>
                <td class="num dt-num" role="cell" data-label="Precio si capturás"
                    [attr.aria-label]="f.precio_si_conserva_margen !== null ? 'Precio si capturás ' + money(f.precio_si_conserva_margen) : 'Precio si capturás sin medir'">
                  <!-- La flecha sólo si LLEVA a algún lado. Medido sobre 4,000 filas reales, la
                       peor cadena era "$1,523.93 → $1,523.93": el MISMO precio de los dos lados,
                       164 px dentro de una columna de 128 px con nowrap. El panel de detalle ya
                       exigía que difirieran; la tabla no, y gastaba su columna más ancha en una
                       flecha que no decide nada. -->
                  @if (f.precio_si_conserva_margen !== null && f.precio_ficha !== null) {
                    @if (f.precio_si_conserva_margen !== f.precio_ficha) {
                      <span class="ce-precio-de">{{ money(f.precio_ficha) }} →</span> {{ money(f.precio_si_conserva_margen) }}
                    } @else { <span class="ce-nd">sin cambio</span> }
                  } @else { <span class="ce-nd">—</span> }
                </td>
                <td role="cell" data-label="Veredicto"><p-tag [value]="rotulo(f.veredicto)" [severity]="severidad(f.veredicto)" styleClass="ce-tag" /></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="12" role="cell">
                <div class="ce-empty">
                  <i class="pi pi-inbox" aria-hidden="true"></i>
                  <span class="ce-empty-t">Sin filas</span>
                  <span class="ce-empty-s">Ningún producto coincide con los filtros actuales.</span>
                  @if (filtrosActivos()) {
                    <button pButton type="button" class="p-button-sm p-button-outlined" (click)="limpiar()" label="Quitar filtros"></button>
                  }
                </div>
              </td></tr>
            </ng-template>
          </p-table>
          </div>

          @if (detalle(); as d) {
            <aside class="ce-detalle" aria-label="Detalle del producto">
              <header class="ce-det-head">
                <div>
                  <h2>{{ d.nombre ?? d.sku }}</h2>
                  <p class="ce-det-sub"><span class="ce-mono">{{ d.sku }}</span> · plaza <span class="ce-mono">{{ d.sucursal }}</span></p>
                </div>
                <button pButton type="button" class="p-button-text p-button-sm" (click)="cerrarDetalle()" aria-label="Cerrar detalle">
                  <span class="p-button-icon pi pi-times" aria-hidden="true"></span>
                </button>
              </header>

              <h3 class="ce-det-h3">La escalera de la ficha</h3>
              <table class="ce-esc">
                <thead><tr><th>Peldaño</th><th>Unidad</th><th class="num">Factor</th><th class="num">Costo estándar</th></tr></thead>
                <tbody>
                  <tr><td>base</td><td>{{ d.unidad_base ?? '—' }}</td><td class="num">1</td><td class="num">{{ money(d.costo_estandar) }}</td></tr>
                  <tr><td>dos</td><td>{{ d.unidad_dos ?? '—' }}</td><td class="num">{{ num(d.factor_dos) }}</td><td class="num">{{ money(d.costo_estandar_u2) }}</td></tr>
                  <tr><td>tres</td><td>{{ d.unidad_tres ?? '—' }}</td><td class="num">{{ num(d.factor_tres) }}</td><td class="num">{{ money(d.costo_estandar_u3) }}</td></tr>
                </tbody>
              </table>

              <h3 class="ce-det-h3">Cómo sale el precio</h3>
              <p class="ce-formula">
                {{ money(d.costo_estandar) }} × (1 + {{ d.margen_ficha_pct !== null ? num(d.margen_ficha_pct) + '%' : '?' }})
                × (1 + {{ d.impuesto_pct !== null ? num(d.impuesto_pct) + '%' : '?' }})
                = <strong>{{ money(d.precio_reconstruido) }}</strong>
              </p>
              <p class="ce-cuadre">
                Precio en la ficha: <strong>{{ money(d.precio_ficha) }}</strong>.
                @if (d.precio_cuadra === true) { <span class="ce-ok">Cuadra.</span> }
                @else if (d.precio_cuadra === false) { <span class="ce-mal">No cuadra.</span> }
                @else { <span class="ce-nd">No medible — {{ d.precio_cuadra_motivo ?? 'sin motivo declarado' }}.</span> }
                @if (d.impuesto_tasas_distintas !== null && d.impuesto_tasas_distintas > 1) {
                  <span class="ce-warn">El SKU cobró {{ d.impuesto_tasas_distintas }} tasas distintas en la ventana: el impuesto usado es la moda.</span>
                }
              </p>

              <!-- [CE.11] POR QUÉ el costo del ERP está donde está. La pantalla afirmaba que
                   reponer cuesta más y dejaba la causa a la imaginación. Y la causa cómoda
                   -«esa plaza compró más caro»- es FALSA en la mayoría de los casos: medido,
                   el 71.3 % de los costos los fijó un conteo de inventario físico. -->
              <h3 class="ce-det-h3">Por qué cuesta eso reponer acá</h3>
              @if (d.origen_familia) {
                <p class="ce-origen" [class.is-inv]="d.origen_familia === 'inventario_fisico'">
                  Este costo lo dejó <strong>{{ d.origen_nombre ?? d.origen_doctype }}</strong>
                  del <strong>{{ d.origen_fecha_txt }}</strong>
                  <!-- [CE.12] El folio SOLO no identifica un documento: Kepler lo numera por
                       (sucursal, ALMACEN, doctype), y el doctype lleva CUATRO componentes. Acá se
                       imprime el número tal cual lo escribe el ERP -NA3001-0000001- para que se
                       pueda buscar en Kepler sin traducir nada. -->
                  @if (d.origen_doc_id) {
                    <span class="ce-doc">{{ d.origen_doc_id }}</span>
                  } @else if (d.origen_folio) {
                    <span class="ce-nd">(folio {{ d.origen_folio }})</span>
                  }
                  @if (d.origen_almacen) { <span class="ce-nd">· almacén {{ d.origen_almacen }}</span> }
                  @if (d.origen_cantidad !== null) { · <strong>{{ num(d.origen_cantidad) }} {{ d.origen_unidad ?? '' }}</strong> }
                  a <strong>{{ money(d.origen_precio) }}</strong>.
                  <!-- [CE.12] Sin esto, «1 PAQ a $189.07» se lee como si el movimiento entero
                       hubiera sido de una pieza. Es UN RENGLON de un conteo de 897 partidas. -->
                  @if (d.origen_doc_renglones && d.origen_doc_renglones > 1) {
                    <span class="ce-origen-nota">Es <strong>un renglón</strong> de ese documento, que
                    trae {{ num(d.origen_doc_renglones) }} partidas
                    @if (d.origen_doc_total) { por {{ money(d.origen_doc_total) }} }.</span>
                  }
                  @if (d.origen_familia === 'inventario_fisico') {
                    <span class="ce-origen-nota">No fue una compra: fue un movimiento de inventario físico. Es lo más común — el 71 % de los costos de reposición los fija un conteo, no una orden de compra.</span>
                  } @else if (d.origen_familia === 'compra') {
                    <span class="ce-origen-nota">Es una compra real: ése es el costo que el proveedor cobró.</span>
                  } @else {
                    <span class="ce-origen-nota">Es un traspaso u otro movimiento de almacén, no una compra.</span>
                  }
                  @if (d.origen_nombre_ambiguo) {
                    <span class="ce-warn">⚠ El catálogo del ERP trae más de un nombre para este mismo código: el rótulo puede no ser exacto.</span>
                  }
                </p>
              } @else if (d.origen_familia === null) {
                <p class="ce-origen is-nd">
                  <strong>No se pudo atribuir.</strong> Ningún movimiento de los últimos 180 días coincide
                  con este costo dentro del 1 %. Pasa en el 24.7 % de los casos y se declara así en vez de
                  suponer una causa.
                </p>
              } @else {
                <!-- [CE.11] ⛔ El tercer estado, que faltaba. Acá el else decía "No se pudo atribuir …
                     ningún movimiento coincide", que es el resultado de una MEDICIÓN — y cuando la
                     columna no viaja esa medición NUNCA CORRIÓ. Medido hoy: la vista no tiene las
                     columnas origen_*, así que la pantalla publicaba ese texto para el 100 % de las
                     fichas. Dos ausencias distintas con la misma cara es lo que ADR-056 prohíbe, y
                     ademas mandan a personas distintas: ésta la arregla Sistemas, la otra no la
                     arregla nadie. -->
                <p class="ce-origen is-nd">
                  <strong>Sin medir.</strong> Esta base todavía no trae la atribución del costo
                  (la vista no expone <code>origen_*</code>). No es que no se haya encontrado el
                  movimiento: es que la pregunta no se hizo. Pendiente de Sistemas.
                </p>
              }

              <h3 class="ce-det-h3">Los testigos del ERP</h3>
              <dl class="ce-dl">
                <dt>Costo de reposición</dt><dd class="ce-mono">{{ money(d.costo_reposicion) }} <span class="ce-nd">({{ d.peldano_reposicion ?? 'sin testigo' }})</span></dd>
                @if (d.ultimo_costo !== null) {
                  <!-- [CE.9] Sólo se pinta si existe: Kepler no tiene último costo en el 56 % de las
                       fichas, y antes acá salía «1800-01-01», su centinela de nulo. -->
                  <dt>Último costo</dt><dd class="ce-mono">{{ money(d.ultimo_costo) }} <span class="ce-nd">{{ d.ultimo_costo_al ?? 'sin fecha' }}</span></dd>
                }
                <dt>Vendido 30 d</dt><dd class="ce-mono">{{ num(d.unidades_base_30d) }} {{ d.unidad_base ?? '' }} · {{ money(d.venta_bruta_30d) }}</dd>
                @if (d.margen_real_pct !== null) {
                  <dt>Margen real hoy</dt>
                  <dd class="ce-mono" [class.ce-neg]="d.vende_bajo_costo">
                    {{ pct(d.margen_real_pct) }}
                    <span class="ce-nd">contra {{ pct(d.margen_ficha_pct) }} que dice la ficha</span>
                  </dd>
                }
              </dl>

              @if (d.precio_si_conserva_margen !== null && d.precio_ficha !== null
                   && d.precio_si_conserva_margen !== d.precio_ficha) {
                <!-- [CE.9] La decisión, con sus dos salidas. Capturar el costo nuevo NO es
                     higiene de datos: Kepler conserva el margen y recalcula el precio (medido,
                     74 % de 6,501 cambios reales). -->
                <h3 class="ce-det-h3">Si capturás el costo nuevo</h3>
                <p class="ce-decision">
                  <span class="ce-decision-a">
                    <strong>A ·</strong> Kepler conserva el margen y el precio pasa de
                    <strong>{{ money(d.precio_ficha) }}</strong> a <strong>{{ money(d.precio_si_conserva_margen) }}</strong>.
                    Es un cambio de precio al público.
                  </span>
                  <span class="ce-decision-b">
                    <strong>B ·</strong> Si dejás el precio, el margen real es
                    <strong [class.ce-neg]="d.vende_bajo_costo">{{ pct(d.margen_real_pct) }}</strong>
                    @if (d.vende_bajo_costo) { — este producto <strong>pierde dinero en cada venta</strong>. }
                  </span>
                </p>
              }

              <h3 class="ce-det-h3">El mismo SKU en todas las plazas</h3>
              @if (cargandoPlazas()) { <p-skeleton height="5rem" /> }
              @else {
                <div class="dt-scope">
                <table class="ce-plazas dt-stack">
                  <thead><tr><th>Plaza</th><th class="num">Estándar</th><th class="num">Reposición</th><th class="num">Desv.</th><th>Veredicto</th></tr></thead>
                  <tbody>
                    @for (p of plazas(); track p.sucursal) {
                      <tr [class.is-actual]="p.sucursal === d.sucursal">
                        <td class="ce-mono dt-id" role="cell">Plaza {{ p.sucursal }}</td>
                        <td class="num dt-num" role="cell" data-label="Estándar">{{ money(p.costo_estandar) }}</td>
                        <td class="num dt-num" role="cell" data-label="Reposición">{{ money(p.costo_reposicion_base ?? p.costo_reposicion) }}</td>
                        <td class="num dt-num" role="cell" data-label="Desviación">{{ p.desviacion_pct !== null ? pct(p.desviacion_pct) : '—' }}</td>
                        <td role="cell" data-label="Veredicto"><span class="ce-mini">{{ rotulo(p.veredicto) }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
                </div>
                @if (estandarDifiere()) {
                  <p class="ce-warn ce-plazas-nota">El costo estándar <strong>no es el mismo en todas las plazas</strong>. La ficha se mantiene por sucursal y ésta divergió.</p>
                }
              }
            </aside>
          }
        </div>

        <!-- DESIGN O.2 pide totales en una rejilla de Compras. NO van en un tfoot: dense-table.css
             esconde thead y tfoot al apilar, así que en el teléfono el total desaparecería justo
             donde más falta. Acá vive fuera de la tabla y se lee en los dos modos. Y dice QUÉ suma:
             la página, no el universo — un total sin su alcance afirma de más. -->
        <p class="ce-pie">
          Esta página suma <strong>{{ money(impactoPagina()) }}</strong> de impacto a 30 días
          en {{ n(valoradasPagina()) }} de {{ n(filas().length) }} filas
          @if (filas().length - valoradasPagina() > 0) {
            <span class="ce-nd">({{ n(filas().length - valoradasPagina()) }} sin valorar, no se suman)</span>
          }.
          El costo estándar se corrige <strong>en Kepler</strong>: esta pantalla es de sólo lectura sobre el ODS.
        </p>
      }
    </div>
  `,
  styles: [`
    /* DESIGN Q.5 / antipatrón "font-size con literal": la escala --fs-* es ESTRICTA. Acá había
       ocho tamaños inventados (.72 .74 .76 .78 .8 .84 .98rem) que no son ningún peldaño de la
       escala; un tamaño fuera de ella es un bug, no una preferencia. */
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .ce-head-actions { display:flex; gap:.5rem; align-items:center; }
    .ce-err { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem;
              border:1px solid var(--border-color); border-left:3px solid var(--bad-fg);
              border-radius:var(--r-md); background:var(--card-bg); }
    .ce-err .pi { color:var(--bad-fg); }
    .ce-err-txt { flex:1; font-size:var(--fs-body); color:var(--text-main); }
    app-metric-strip { display:block; margin:.9rem 0 .4rem; }
    .ce-titular { display:flex; gap:.6rem; align-items:flex-start; padding:.75rem .9rem; margin:.2rem 0 .5rem;
                  border:1px solid var(--border-color); border-left:3px solid var(--bad-fg);
                  border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); line-height:1.55; }
    .ce-titular .pi { color:var(--bad-fg); margin-top:.15rem; }
    /* Sin ::ng-deep (antipatrón de DESIGN). El botón vive en ESTE template, así que lleva el
       atributo de encapsulación y una clase propia lo alcanza directo — y además gana por
       especificidad (0,2,0) contra el (0,1,0) de .p-button de PrimeNG. ::ng-deep hacía falta
       sólo si hubiera que entrar a un hijo que renderiza la librería, que no es el caso. */
    .ce-titular-cta { margin-left:.4rem; padding-block:0; }
    .ce-aviso { display:flex; gap:.5rem; align-items:flex-start; font-size:var(--fs-xs); color:var(--text-muted);
                line-height:1.55; margin:.1rem 0 .7rem; }
    .ce-aviso .pi { color:var(--text-faint); margin-top:.15rem; }
    .ce-precio-de { color:var(--text-faint); }
    .ce-proc { font-size:var(--fs-xs); color:var(--text-muted); line-height:1.6; margin:.1rem 0 .9rem;
               display:flex; gap:.4rem; align-items:baseline; flex-wrap:wrap; }
    .ce-proc .pi { color:var(--text-faint); }
    .ce-alcance { flex-basis:100%; color:var(--text-faint); }
    .ce-filtros { display:flex; flex-wrap:wrap; gap:.8rem; align-items:center; margin:.4rem 0 .6rem; }
    .ce-buscar input { min-width:230px; }
    .ce-sel { display:inline-block; min-width:12rem; }
    .ce-chk { display:inline-flex; align-items:center; gap:.45rem; font-size:var(--fs-xs); color:var(--text-muted); cursor:pointer; }
    .ce-activos { font-size:var(--fs-xs); color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .ce-seg { display:block; margin:.2rem 0 .7rem; }
    .ce-split { display:grid; grid-template-columns:minmax(0,1fr); gap:1rem; }
    .ce-split:has(.ce-detalle) { grid-template-columns:minmax(0,1fr) 25rem; }
    @media (max-width: 68.75rem) { .ce-split:has(.ce-detalle) { grid-template-columns:minmax(0,1fr); } }
    .ce-grid { min-width:0; }
    .ce-tabla { margin-top:.2rem; }
    .ce-fila.is-mal > td:first-child { box-shadow:inset 3px 0 0 var(--bad-fg); }
    /* La clase .num (global, calificada por elemento) hace alineación + mono + tabular: D.0. Acá
       sólo se agrega lo que .num no da — que la cifra no se parta en dos renglones. */
    .ce-tabla td.num, .ce-tabla th.num { white-space:nowrap; }
    .ce-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .ce-nom { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ce-u { font-size:var(--fs-xs); color:var(--text-muted); }
    .ce-nd { color:var(--text-faint); font-style:italic; font-size:var(--fs-xs); }
    .ce-neg { color:var(--bad-fg); font-weight:600; }
    .ce-pos { color:var(--warn-fg); }
    .ce-peld-ok { font-size:var(--fs-xs); color:var(--text-muted); }
    .ce-peld-mal { font-size:var(--fs-xs); color:var(--warn-fg); font-weight:600; }
    .ce-w-sku { width:6rem; } .ce-w-suc { width:4rem; } .ce-w-u { width:4.5rem; }
    .ce-w-money { width:8rem; } .ce-w-pct { width:6rem; } .ce-w-peld { width:6.5rem; } .ce-w-ver { width:11rem; }
    /* «Precio si capturás» lleva DOS importes y una flecha. Compartía .ce-w-money (8rem = 128 px)
       y la cadena más larga medida sobre 4,000 filas reales pide 164 px. 11rem = 176 px. */
    .ce-w-precio { width:11rem; }
    /* Apilado: los anchos de columna y el recorte del nombre dejan de tener sentido cuando ya no
       hay columnas. Sin esto el nombre —que es la IDENTIDAD del renglón— seguiría cortado a 260px
       justo en la pantalla donde es lo único que orienta. */
    @container densetable (max-width: 34rem) {
      .ce-nom { max-width:none; overflow:visible; white-space:normal; text-overflow:clip; }
      .ce-tabla td.num { white-space:normal; }
    }
    .ce-detalle { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg);
                  padding:.9rem 1rem 1.2rem; align-self:start; position:sticky; top:1rem; max-height:calc(100vh - 3rem); overflow:auto; }
    .ce-det-head { display:flex; justify-content:space-between; align-items:flex-start; gap:.5rem; }
    .ce-det-head h2 { font-size:var(--fs-h3); margin:0 0 .15rem; line-height:1.3; }
    .ce-det-sub { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .ce-det-h3 { font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint);
                 margin:1.1rem 0 .4rem; font-weight:600; }
    .ce-esc, .ce-plazas { width:100%; border-collapse:collapse; font-size:var(--fs-xs); }
    .ce-esc th, .ce-plazas th { text-align:left; color:var(--text-faint); font-weight:600; padding:.25rem .3rem;
                                border-bottom:1px solid var(--border-color); }
    .ce-esc th.num, .ce-plazas th.num, .ce-esc td.num, .ce-plazas td.num { text-align:right; }
    .ce-esc td, .ce-plazas td { padding:.25rem .3rem; border-bottom:1px solid var(--border-color); }
    .ce-plazas tr.is-actual { background:var(--surface-hover); }
    .ce-formula { font-size:var(--fs-sm); font-family:var(--font-mono); line-height:1.6; margin:.2rem 0; }
    .ce-cuadre { font-size:var(--fs-xs); line-height:1.6; margin:.4rem 0 0; color:var(--text-muted); }
    .ce-ok { color:var(--ok-fg); font-weight:600; }
    .ce-mal { color:var(--bad-fg); font-weight:600; }
    .ce-warn { color:var(--warn-fg); }
    .ce-plazas-nota { font-size:var(--fs-xs); margin-top:.5rem; line-height:1.5; }
    .ce-origen { font-size:var(--fs-xs); line-height:1.6; margin:.2rem 0 0; padding:.6rem .7rem;
                 border-radius:var(--r-sm); background:var(--surface-hover, rgba(127,127,127,.06));
                 border-left:3px solid var(--border-color); }
    .ce-origen.is-inv { border-left-color:var(--warn-fg); }
    .ce-origen.is-nd { color:var(--text-muted); font-style:italic; }
    .ce-origen-nota { display:block; margin-top:.35rem; color:var(--text-muted); font-style:normal; }
    .ce-doc { font-family:var(--font-mono, monospace); font-size:var(--fs-micro);
      padding:.05rem .3rem; border-radius:var(--r-sm); background:var(--layout-bg);
      border:1px solid var(--border-color); }
    .ce-decision { display:flex; flex-direction:column; gap:.45rem; font-size:var(--fs-xs);
                   line-height:1.6; margin:.2rem 0 0; }
    .ce-decision-a, .ce-decision-b { padding:.5rem .65rem; border-radius:var(--r-sm);
                                     background:var(--surface-hover, rgba(127,127,127,.06)); }
    .ce-dl { display:grid; grid-template-columns:auto 1fr; gap:.25rem .8rem; font-size:var(--fs-xs); margin:.2rem 0 0; }
    .ce-dl dt { color:var(--text-faint); }
    .ce-dl dd { margin:0; }
    .ce-mini { font-size:var(--fs-micro); color:var(--text-muted); }
    .ce-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .ce-empty .pi { font-size:var(--fs-h2); color:var(--text-faint); }
    .ce-empty-t { font-weight:600; color:var(--text-main); }
    .ce-empty-s { font-size:var(--fs-body); color:var(--text-muted); max-width:32rem; }
    .ce-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1rem; }
    .ce-pie { margin-top:1rem; font-size:var(--fs-xs); color:var(--text-faint); line-height:1.55; }
  `],
})
export class ComprasCostoEstandarComponent implements OnInit {
  private readonly svc = inject(CostoEstandarService);
  private readonly destroyRef = inject(DestroyRef);

  readonly resumen = signal<ResumenCostoEstandar | null>(null);
  readonly filas = signal<(FilaCostoEstandar & { ce_id: string })[]>([]);
  readonly total = signal(0);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly q = signal('');
  readonly sucursal = signal<string>('');
  readonly veredicto = signal<Veredicto | ''>('');
  readonly incluirSinOperacion = signal(false);
  /** `[CE.9]` Las que pierden dinero en cada venta HOY: la lista que importa mañana. */
  readonly soloBajoCosto = signal(false);

  /**
   * `[CE.9]` **Paginación de servidor** (DESIGN §datos densos 7: lo auditable se pagina).
   * Antes `limite` estaba clavado en 300 y `desplazamiento` no se mandaba nunca, así que de las
   * **424 filas de «Sin costo en el ERP»** —el hueco real que esta fase existe para exponer— se
   * veían 300 y **no había página dos**. El pie lo declaraba con honestidad y seguía sin haber
   * forma de llegar a las otras 124.
   */
  readonly pagina = signal(1);
  readonly tam = signal(100);
  readonly primerRenglon = computed(() => (this.pagina() - 1) * this.tam());

  /** D.4(b): cuántos filtros hay puestos. El botón de limpiar EXISTE sólo si esto es > 0. */
  readonly filtrosActivos = computed(() =>
    (this.q().trim() ? 1 : 0) + (this.sucursal() ? 1 : 0) +
    (this.veredicto() ? 1 : 0) + (this.incluirSinOperacion() ? 1 : 0) +
    (this.soloBajoCosto() ? 1 : 0));

  /**
   * Lo que suma **la página**, con cuántas de sus filas entraron a la suma. El alcance va escrito
   * al lado: un total sin decir sobre qué universo corre afirma más de lo que el dato sostiene.
   */
  readonly valoradasPagina = computed(() =>
    this.filas().filter((f) => f.impacto_cogs_30d !== null).length);
  readonly impactoPagina = computed(() =>
    this.filas().reduce((s, f) => s + (f.impacto_cogs_30d !== null ? Number(f.impacto_cogs_30d) : 0), 0));

  /**
   * Las opciones del radiogroup de veredictos. Se esconden los que valen cero (un segmento que
   * no puede devolver nada es ruido) y `sin_operacion` salvo que se pida — son más de la mitad
   * de las filas y no son un hueco, es el maestro replicado en las 9 plazas.
   */
  readonly opcionesVeredicto = computed<SegOption[]>(() => {
    const r = this.resumen();
    if (!r) return [];
    const opts: SegOption[] = [{ label: `Todos · ${this.n(this.totalVisible(r))}`, value: '' }];
    for (const b of r.reparto) {
      if (b.filas <= 0) continue;
      if (!this.incluirSinOperacion() && b.veredicto === 'sin_operacion') continue;
      opts.push({ label: `${ROTULO[b.veredicto]} · ${this.n(b.filas)}`, value: b.veredicto });
    }
    return opts;
  });

  readonly detalle = signal<FilaCostoEstandar | null>(null);
  readonly plazas = signal<FilaCostoEstandar[]>([]);
  readonly cargandoPlazas = signal(false);
  seleccion: (FilaCostoEstandar & { ce_id: string }) | null = null;

  /**
   * `[KBD.1]` El contenedor de la tabla, para acotar a dónde baja la flecha.
   *
   * ⛔ Va por `viewChild` y no como referencia de plantilla pasada al input: el `#grid` vive
   * dentro del bloque `@else` del esqueleto de carga, y una referencia declarada dentro de un
   * `@if` **no se ve desde afuera** — el compilador tira `TS2339: Property 'grid' does not exist`.
   * Devuelve `undefined` mientras la tabla no está montada, que es exactamente lo correcto:
   * durante la carga no hay lista a la que bajar.
   */
  readonly grid = viewChild<ElementRef<HTMLElement>>('grid');

  readonly filasSkel = [1, 2, 3, 4, 5, 6, 7, 8];
  readonly opcionesSucursal = ['00', '01', '02', '03', '04', '05', '06', '07', '08']
    .map((s) => ({ label: `Plaza ${s}`, value: s }));

  /** El mismo SKU con costo estándar distinto entre plazas: el hallazgo de 1,004 SKUs. */
  readonly estandarDifiere = computed(() => {
    const vals = this.plazas()
      .map((p) => p.costo_estandar)
      .filter((v): v is number => v !== null);
    return vals.length > 1 && new Set(vals.map((v) => Number(v).toFixed(4))).size > 1;
  });

  private debounce?: ReturnType<typeof setTimeout>;

  ngOnInit(): void { this.recargar(); }

  recargar(resetPagina = true): void {
    // Cambiar un FILTRO vuelve a la página 1; cambiar de PÁGINA no. Sin esta distinción, filtrar
    // parado en la página 4 pide un desplazamiento que el nuevo universo ya no tiene y la tabla
    // sale vacía sobre un total que dice que hay filas.
    if (resetPagina) this.pagina.set(1);
    this.cargando.set(true);
    this.error.set(null);

    // `q` viaja también al resumen: si no, los conteos de los segmentos contradicen a la tabla.
    this.svc.resumen(this.sucursal() || undefined, this.q())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.resumen.set(r),
        error: () => this.error.set('No se pudo leer el resumen de costo estándar.'),
      });

    this.svc.listar({
      sucursal: this.sucursal() || undefined,
      veredicto: this.veredicto() || undefined,
      q: this.q(),
      incluir_sin_operacion: this.incluirSinOperacion(),
      solo_bajo_costo: this.soloBajoCosto(),
      limite: this.tam(),
      desplazamiento: this.primerRenglon(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.filas.set(r.filas.map((f) => ({ ...f, ce_id: `${f.sucursal}|${f.sku}` })));
          this.total.set(r.total);
          this.cargando.set(false);
        },
        error: () => {
          this.error.set('No se pudo leer el costo estándar.');
          this.cargando.set(false);
        },
      });
  }

  /**
   * Un filtro cambió. Dos cosas pasan siempre y una sola vez:
   *
   *  1. **Se cierra el detalle.** Antes sólo lo hacía el cambio de plaza: buscabas otra cosa y el
   *     panel de la derecha seguía mostrando un producto que ya no estaba en la tabla.
   *  2. **Se recarga con `debounce`.** Los veredictos son un radiogroup y ahí la selección sigue
   *     al foco — cruzarlos con las flechas dispararía una consulta por tecla.
   */
  private aplicar(ms = 0): void {
    this.cerrarDetalle();
    if (this.debounce) clearTimeout(this.debounce);
    if (ms <= 0) { this.recargar(); return; }
    this.debounce = setTimeout(() => this.recargar(), ms);
  }

  onBuscar(v: string): void { this.q.set(v); this.aplicar(280); }

  /**
   * `[KBD.1]` Flecha abajo desde el buscador: entra a la lista.
   *
   * ⛔ No hay navegación propia acá: `pSelectableRow` de PrimeNG ya mueve entre filas con las
   * flechas, va a los extremos con Home/End y activa con Enter, y su tabindex ya es roving (la
   * tabla entera es UN stop de tabulador). Lo único que faltaba era el PUENTE desde el buscador.
   *
   * El `preventDefault` sólo si de verdad se bajó: si la lista está vacía, la tecla sigue siendo
   * del input y el cursor se queda donde estaba — mandar el foco a la nada deja sin salida.
   */
  aLaLista(ev: Event): void {
    if (bajarAlPrimerRenglon(this.grid()?.nativeElement)) ev.preventDefault();
  }

  /** `[KBD.1]` Escape desde la lista: vuelve al buscador con el texto seleccionado. */
  aBuscador(buscador: HTMLInputElement): void { volverAlBuscador(buscador); }
  onSucursal(v: string | null): void { this.sucursal.set(v ?? ''); this.aplicar(); }
  onVeredicto(v: Veredicto | ''): void { this.veredicto.set(v); this.aplicar(200); }
  onSinOperacion(v: boolean): void { this.incluirSinOperacion.set(v); this.aplicar(); }
  onSoloBajoCosto(v: boolean): void { this.soloBajoCosto.set(v); this.aplicar(); }

  limpiar(): void {
    this.q.set(''); this.sucursal.set(''); this.veredicto.set(''); this.incluirSinOperacion.set(false);
    this.soloBajoCosto.set(false);
    this.aplicar();
  }

  /**
   * Cambio de página o de tamaño: el servidor manda el renglón, no el navegador. `first` viene en
   * renglones y la API pagina por desplazamiento. La guarda evita la consulta de más que PrimeNG
   * dispara al montar la tabla, que repetiría la de `ngOnInit`.
   */
  paginar(ev: TableLazyLoadEvent): void {
    const tam = ev.rows || this.tam();
    const pag = Math.floor((ev.first || 0) / tam) + 1;
    if (pag === this.pagina() && tam === this.tam()) return;
    this.tam.set(tam);
    this.pagina.set(pag);
    this.recargar(false);
  }

  onSeleccion(f: (FilaCostoEstandar & { ce_id: string }) | null): void {
    if (!f) { this.cerrarDetalle(); return; }
    this.detalle.set(f);
    this.cargandoPlazas.set(true);
    this.plazas.set([]);
    this.svc.porSku(f.sku)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => { this.plazas.set(p); this.cargandoPlazas.set(false); },
        error: () => this.cargandoPlazas.set(false),
      });
  }

  cerrarDetalle(): void { this.detalle.set(null); this.plazas.set([]); this.seleccion = null; }

  /**
   * ⛔ `[CE.9]` **Las DOS caras del dinero, no la que asusta.** Acá salía sólo el COGS
   * subdeclarado, que es el número grande; el servicio ya calculaba la mitad que compensa y el
   * neto — los computa precisamente para que nadie lea una sola cara— y la pantalla los tiraba.
   *
   * Se fue el mosaico de «No comparables»: ahora es un segmento con su conteo, y repetirlo acá
   * gastaba un mosaico en un número que ya estaba dos centímetros más abajo.
   */
  kpis(r: ResumenCostoEstandar): MetricStripItem[] {
    const bajo = r.reparto.find((x) => x.veredicto === 'estandar_bajo')?.filas ?? 0;
    return [
      {
        label: 'COGS subdeclarado 30 d',
        value: this.money(r.dinero.cogs_subdeclarado_30d),
        tone: r.dinero.cogs_subdeclarado_30d > 0 ? 'bad' : 'default',
        // El acompañante va EN el KPI, no en una nota al pie: un total sin cuántas filas
        // quedaron fuera afirma más de lo que el dato sostiene.
        sub: `${this.n(r.cobertura.filas_sin_valorar)} filas sin valorar`,
      },
      {
        label: 'COGS sobredeclarado 30 d',
        value: this.money(r.dinero.cogs_sobredeclarado_30d),
        sub: 'la mitad que compensa',
      },
      {
        label: 'Neto 30 d',
        value: this.money(r.dinero.neto_30d),
        tone: r.dinero.neto_30d > 0 ? 'warn' : 'default',
        sub: 'lo que de verdad se movería',
      },
      {
        label: 'Fichas por debajo del costo real',
        value: this.n(bajo),
        tone: bajo > 0 ? 'warn' : 'default',
        sub: 'inflan el margen publicado',
      },
      {
        label: 'Precio que no cuadra',
        value: this.n(r.precio.no_cuadran),
        tone: r.precio.no_cuadran > 0 ? 'warn' : 'default',
        sub: `de ${this.n(r.precio.filas_evaluadas)} evaluadas · ${this.n(r.precio.no_medibles)} sin medir`,
      },
    ];
  }

  totalVisible(r: ResumenCostoEstandar): number {
    return this.incluirSinOperacion() ? r.cobertura.filas_totales : r.cobertura.filas_con_operacion;
  }

  etiquetaPeldano(f: FilaCostoEstandar): string {
    if (f.peldano_reposicion === 'unidad_dos') return `${f.unidad_dos ?? 'u2'} ×${this.num(f.factor_dos)}`;
    if (f.peldano_reposicion === 'unidad_tres') return `${f.unidad_tres ?? 'u3'} ×${this.num(f.factor_tres)}`;
    return 'no resuelve';
  }

  rotulo(v: Veredicto): string { return ROTULO[v] ?? v; }
  /**
   * La definición canónica sale del diccionario versionado (§P). Si la entrada faltara, se pierde
   * el ATAJO de escritorio, no la explicación: el cajón de ayuda sigue siendo el canal (D.2).
   */
  def(term: string): string { return DEFS.get(term) ?? ''; }
  ayuda(v: Veredicto): string { return this.def(ROTULO[v]); }
  severidad(v: Veredicto) { return SEVERIDAD[v] ?? 'secondary'; }

  money(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(v));
  }
  pct(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
  }
  num(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(Number(v));
  }
  n(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return new Intl.NumberFormat('es-MX').format(Number(v));
  }
}
