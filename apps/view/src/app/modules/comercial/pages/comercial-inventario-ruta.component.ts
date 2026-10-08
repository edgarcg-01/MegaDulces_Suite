import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  RouteInventoryDetail,
  RouteInventoryDetailRow,
  RouteInventoryReport,
  RouteInventoryRow,
  RouteDayBreakdown,
  RouteDayLine,
  RouteNegativeRow,
  RouteSeriesPoint,
  RouteShipment,
  RouteShipmentLine,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { REPORTS_TABS } from '../reports-tabs';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

/** La valuacion con la que se lee TODA la pantalla. No se mezclan: son dos cuentas distintas. */
type Metrica = 'costo' | 'venta';
/** Las pestanas del detalle de una ruta. */
type Pestana = 'productos' | 'movimiento' | 'traspasos' | 'rojos';

/**
 * `[RD.13]`+`[RD.17-21]` **Inventario de los camiones de Ruta Directa.**
 *
 * DESIGN §15 (answer-first): lo primero que se lee no es una cifra, es el veredicto, y el texto
 * SALE DEL NUMERO (ver `veredicto()`), no es un rotulo fijo.
 *
 * El detalle de una ruta vive en el panel lateral con cuatro pestanas, siguiendo el patron ya
 * vigente en `comercial-ventas-por-ruta` (tabs locales + `@switch`); no hay componente compartido
 * para esto en el repo. Cuando se promueva a pagina propia, el salto tendra que ser un
 * `<a routerLink>` por la compuerta `drilldown-links.spec.ts` (ADR-078).
 *
 * ⚠️ Lo que la pantalla DECLARA en vez de callar (ADR-056): no hay conteo inicial; el costo es el
 * del embarque y el del ERP viaja aparte; la cobertura; el cuadre ternario; y el rojo partido en
 * sus dos familias, porque son dos problemas distintos.
 */
@Component({
  selector: 'app-comercial-inventario-ruta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, DatePickerModule, MultiSelectModule,
    ToastModule, TagModule, PageTabsComponent, SidePeekComponent, MetricStripComponent,
    LoadStateComponent, SegmentedComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
<p-toast />
<div class="ir-page">
  <header class="ir-head">
    <div>
      <h1>Qué trae cada camión</h1>
      <p class="ir-sub">
        <!--
          ⛔ RD.43 — este párrafo decía "lo que su sucursal le cargó, menos lo que ya vendió …
          esta pantalla los resta", y eso dejó de ser cierto con RD.34. Desde entonces el número
          NO se reconstruye: lo declara la propia camioneta, de su Kepler local, y lo que la
          pantalla resta es el ajuste contra el papel. Es la frase que le dice al lector de dónde
          sale la cifra, y describía el método anterior: quien la leyera defendería el número por
          una razón equivocada.
        -->
        Lo que cada ruta tiene arriba <strong>hoy</strong>, según <strong>su propia camioneta</strong>:
        cada una manda su existencia y eso es lo que se publica. Lo que la sucursal le cargó y lo
        que vendió se usan para <em>contrastarla</em>, no para calcularla.
        <strong>Kepler no guarda el saldo de un camión</strong> — por eso el saldo lo pone el
        camión y el papel lo audita. Para ver todo su historial, abrí la ruta.
      </p>
    </div>
    <app-context-help topic="inventario-de-ruta" />
  </header>

  <app-page-tabs [tabs]="tabs" />

  <section class="ir-bar">
    <div class="ir-bar-l">
      <p-multiselect [options]="plazaOpts()" [ngModel]="plazasSel()"
                     (ngModelChange)="setPlazas($event)" placeholder="Todas las plazas"
                     [showClear]="true" appendTo="body" [maxSelectedLabels]="2"
                     selectedItemsLabel="{0} plazas" ariaLabel="Filtrar por plaza" />
      <p-multiselect [options]="rutaOpts()" [ngModel]="rutasSel()"
                     (ngModelChange)="setRutas($event)" placeholder="Todas las rutas"
                     [showClear]="true" [filter]="true" appendTo="body" [maxSelectedLabels]="3"
                     selectedItemsLabel="{0} rutas" ariaLabel="Filtrar por ruta" />
      <p-button label="Aplicar" icon="pi pi-filter" size="small" severity="secondary"
                (onClick)="cargar()" [loading]="cargando()" />
    </div>
    <app-segmented [options]="VALUACIONES" [value]="metrica()"
                   ariaLabel="Valuación" (valueChange)="setMetrica($event)" />
  </section>

  <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!filas().length"
                  [skeletonRows]="11" emptyIcon="pi-truck"
                  emptyTitle="Ningún camión cargó ni vendió en estas fechas"
                  emptyHint="Quitá el filtro de fechas: el primer embarque documentado es del 15-jul en Padre Hidalgo y del 14-ago en Canindo."
                  (retry)="cargar()">
    @if (data(); as d) {
      <p class="ir-veredicto" [class]="'ir-v-' + veredicto().tono">
        <i class="pi" [class]="veredicto().icono" aria-hidden="true"></i>
        <span><strong>{{ veredicto().titulo }}</strong> {{ veredicto().cuerpo }}</span>
      </p>

      <app-metric-strip [items]="kpis()" [ariaLabel]="'Inventario de ruta ' + etiquetaMetrica()" />

      <div class="ir-sub-bar">
        <span>
          {{ filas().length }}@if (filas().length !== d.routes.length) { de {{ d.routes.length }}} rutas ·
          al día de hoy, desde la primera carga de cada una ·
          @if (sinTope()) { <strong>{{ sinTope() }} sin tope declarado</strong> · }
          dato al {{ d.data_as_of ?? 'sin medir' }}
        </span>
        <span>
          copia {{ d.copia_status === 'sin_medir' ? 'sin medir' : (d.copia_al ?? 'sin medir') }}
          @if (d.copia_status === 'error') { <strong class="ir-bad">(el refresco falló)</strong> }
          @else if ((d.copia_edad_min ?? 0) > 90) { <strong class="ir-bad">(hace {{ d.copia_edad_min }} min)</strong> }
          · {{ sinCosto() }} sin costo · {{ sinPrecio() }} sin precio
        </span>
      </div>

      <div class="dt-scope">
        <p-table [value]="filas()" dataKey="route_no" [scrollable]="true" scrollHeight="46vh"
                 class="dt-stack surf-table surf-table--sticky surf-table--frozen-first"
                 size="small" [rowHover]="true" [tableStyle]="{ 'min-width': '64rem' }">
          <ng-template #header>
            <tr>
              <!--
                La portada es el ESTADO DE HOY, no la historia. Las columnas de acumulado
                (todo lo cargado y todo lo vendido desde la primera carga de cada ruta) se
                mudaron al desglose: sumaban la vida entera del camión y al lado del saldo
                actual se leían como si fueran lo que trae encima.
              -->
              <th>Ruta</th>
              <th>Plaza</th>
              <th class="num" title="Lo que el camión tiene arriba hoy. NO se le resta la mercancía previa: eso se declara aparte">Trae hoy</th>
              <th class="num" title="El tope que tiene declarado. Si lo pasa, está acumulando capital arriba de la camioneta">Tope</th>
              <th class="num" title="La última vez que se le cargó, y cuánto. No se pregunta por «ayer»: el domingo es inhábil y la respuesta sería siempre cero">Última carga</th>
              <th class="num" title="La última vez que vendió, y cuánto">Última venta</th>
              <th class="num" title="Mercancía que ya traía antes de su primer embarque y fue vendiendo. Se declara, no se resta">Traía sin contar</th>
              <th class="num" title="Mercancía que el camión trae y el documento de embarque no explica. Positivo = trae de más. «no medible» = a esa ruta le falta uno de los dos lados del periodo, así que el hueco de medición es más grande que la cifra y publicarla sería inventarla">Llegó sin embarque</th>
              <th class="num"><span class="ir-sr">Detalle</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <!--
              La fila ya NO se pinta de rojo por el descuadre. Con el ancla de RD.34 puesta,
              saldo = carga + conteo - venta, asi que (carga - venta) - saldo = -conteo y
              NUNCA da 0 en una ruta anclada. Pintarlo rojo convertia el exito de la fase en
              una alarma: las 10 camionetas salian en rojo el dia que empezaron a medirse.
            -->
            <tr [class.ir-fila-parada]="parada(r)">
              <td class="dt-id ir-mono" role="cell"><strong>{{ r.route_no }}</strong></td>
              <td class="ir-tenue" role="cell" data-label="Plaza">{{ r.plaza }}</td>
              <td class="num ir-mono ir-fuerte" role="cell" data-label="Trae hoy"
                  [class.ir-bad]="excede(r)"
                  [title]="excede(r) ? 'Pasa su tope por ' + money(inv(r) - (r.tope_inventario ?? 0)) : ''">{{ inv(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <!--
                Se muestra QUE TAN CERCA esta del tope, no solo si lo paso. Medido: con 80,000
                ninguna de las 11 lo pasa, asi que un semaforo binario estaria siempre verde y
                no diria nada. El porcentaje si: la 504 va al 75% y la 505 al 25%.
                Sin tope declarado se dice, no se asume un default escondido (ADR-056).
              -->
              <td class="num ir-mono" role="cell" data-label="Tope">
                @if (r.tope_inventario === null) { <span class="ir-tenue" title="Sin tope declarado">sin tope</span> }
                @else {
                  <span [class.ir-bad]="excede(r)" [class.ir-aviso]="!excede(r) && pctTope(r) >= 80"
                        [title]="'Tope ' + (r.tope_inventario | currency:'MXN':'symbol-narrow':'1.0-0')">{{ pctTope(r) | number:'1.0-0' }}%</span>
                }
              </td>
              <td class="num ir-mono" role="cell" data-label="Última carga">
                @if (r.ultima_carga) {
                  <span [title]="'El ' + r.ultima_carga">{{ r.ultima_carga_imp | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                  <small class="ir-tenue"> · {{ r.ultima_carga }}</small>
                } @else { <span class="ir-tenue">nunca</span> }
              </td>
              <td class="num ir-mono" role="cell" data-label="Última venta">
                @if (r.ultima_venta) {
                  <span [title]="'El ' + r.ultima_venta">{{ r.ultima_venta_imp | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                  <small class="ir-tenue"> · {{ r.ultima_venta }}</small>
                } @else { <span class="ir-tenue">nunca</span> }
              </td>
              <!--
                Se declara, no se resta. Va en tono tenue y no en rojo: no es un faltante ni un
                error -- es mercancia real que se vendio y se cobro, de antes del primer embarque.
              -->
              <td class="num ir-mono ir-tenue" role="cell" data-label="Traía sin contar"
                  [title]="'Neto si se restara: ' + (invNeto(r) | currency:'MXN':'symbol-narrow':'1.2-2')">{{ invNeg(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <!--
                RD.40 — la cifra se publica SOLO si el artefacto de medición no la tapa. Antes
                salía siempre, y en 8 de 11 rutas el artefacto la explicaba entera: el número se
                leía como mercancía perdida cuando era cómo medimos.
              -->
              <td class="num ir-mono" role="cell" data-label="Llegó sin embarque"
                  [title]="tituloSinEmbarque(r)">
                @if (!medible(r)) {
                  <span class="ir-tenue">no medible</span>
                } @else if (cierra(r)) { <span class="ir-tenue">0</span> }
                @else { <strong>{{ sinEmbarque(r) | number:'1.2-2' }}</strong> }
              </td>
              <td class="num" role="cell" data-label="">
                <p-button icon="pi pi-list" severity="secondary" [text]="true" size="small"
                          [ariaLabel]="'Ver el detalle de la ruta ' + r.route_no"
                          (onClick)="abrirDetalle(r)" />
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>

      @if (metrica() === 'costo' && totalCogsErp() > 0) {
        <p class="ir-contraste">
          <i class="pi pi-flag" aria-hidden="true"></i>
          <span>
            <strong>El ERP tiene su propio costo, y sólo alcanza para una parte.</strong>
            Kepler guarda además un costo en cada línea de venta, pero el ticket de la sucursal
            no ve toda la venta de ruta: ese costo cubre
            <strong>{{ coberturaContraste() === null ? 'una parte sin medir' : (coberturaContraste()! | number:'1.1-1') + '% del dinero vendido' }}</strong>,
            y en Canindo no cubre nada.
            Suma {{ totalCogsErp() | currency:'MXN':'symbol-narrow':'1.2-2' }} contra los
            {{ totalCogs() | currency:'MXN':'symbol-narrow':'1.2-2' }} del embarque.
            <strong>No se suman ni se sustituyen</strong>: tomarlo como el costo de lo vendido
            publicaría un margen del 79% en vez del real.
          </span>
        </p>
      }

      <section class="ir-declara">
        <p><i class="pi pi-info-circle" aria-hidden="true"></i> {{ d.declara.sin_ancla }}</p>
        <!-- Lo que la pantalla NO puede contestar, dicho antes de que alguien lo suponga. -->
        <p><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ d.declara.faltante }}</p>
        <p><i class="pi pi-info-circle" aria-hidden="true"></i> {{ d.declara.fuera_de_alcance }}</p>
      </section>
    }
  </app-load-state>

  <app-side-peek [(open)]="detalleAbierto" [width]="860"
                 [title]="'Ruta ' + (rutaSel()?.route_no ?? '')"
                 [subtitle]="subtituloDetalle()">
    <!--
      El ACUMULADO vive acá, no en la portada. Son las cifras de toda la vida de la ruta
      (desde su primera carga documentada): al lado del saldo actual se leían como si fueran
      lo que el camión trae encima, y son dos órdenes de magnitud distintos.
    -->
    @if (rutaSel(); as rs) {
      <dl class="ir-hist">
        <div><dt>Cargado</dt><dd>{{ carga(rs) | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
        <div><dt>{{ metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente' }}</dt>
             <dd>{{ vendido(rs) | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
        <div><dt>Trae hoy</dt>
             <dd [class.ir-bad]="inv(rs) < 0">{{ inv(rs) | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
        <div><dt>Días de venta</dt>
             <dd>@if (dias(rs) === null) { <span class="ir-tenue" title="No vendió nada: no hay con qué dividir">—</span> }
                 @else { {{ dias(rs) | number:'1.0-0' }} }</dd></div>
      </dl>
    }

    <div class="ir-tabs" role="radiogroup" aria-label="Detalle de la ruta">
      @for (t of PESTANAS; track t.value) {
        <button type="button" role="radio" [attr.aria-checked]="pestana() === t.value"
                [class.on]="pestana() === t.value" (click)="setPestana(t.value)">{{ t.label }}</button>
      }
    </div>

    @switch (pestana()) {
      @case ('productos') {
        <app-load-state [loading]="detalle() === null && !errorDetalle()" [error]="errorDetalle()"
                        [isEmpty]="detalle()?.rows?.length === 0" [skeletonRows]="8"
                        emptyIcon="pi-box" emptyTitle="Este camión no movió ningún producto en estas fechas"
                        (retry)="pedirDetalle()">
          @if (detalle()?.truncado) {
            <p class="ir-contraste">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span>Mostrando <strong>{{ detalle()!.rows.length }}</strong> de
                <strong>{{ detalle()!.total }}</strong> productos — esta tabla
                <strong>no suma</strong> el total de la ruta.</span>
            </p>
          }
          <div class="dt-scope">
            <p-table [value]="detalle()?.rows ?? []" [scrollable]="true" scrollHeight="56vh"
                     class="dt-stack surf-table" size="small" [rowHover]="true"
                     [tableStyle]="{ 'min-width': '46rem' }">
              <ng-template #header>
                <tr><th>SKU</th><th>Producto</th><th title="Unidad en que se movió">Unidad</th>
                  <th class="num">Se le cargó</th>
                  <th class="num">Vendió</th><th class="num">Trae</th>
                  <th class="num">{{ etiquetaMetrica() }}</th><th></th></tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td class="dt-id ir-mono" role="cell">{{ f.sku }}</td>
                  <td role="cell" data-label="Producto">{{ f.producto }}</td>
                  <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ f.unidad }}</td>
                  <td class="num ir-mono" role="cell" data-label="Se le cargó">{{ f.qty_carga | number:'1.0-2' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Vendió">{{ f.qty_venta | number:'1.0-2' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Trae" [class.ir-bad]="f.saldo < 0">
                    <strong>{{ f.saldo | number:'1.0-2' }}</strong>
                  </td>
                  <td class="num ir-mono" role="cell" [attr.data-label]="etiquetaMetrica()">
                    @if (valorFila(f) === null) { <span class="ir-tenue" title="No hay con qué valuarlo">—</span> }
                    @else { {{ valorFila(f) | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                  </td>
                  <td role="cell" data-label="">
                    @if (f.ya_lo_traia) { <p-tag value="ya lo traía" severity="warn" /> }
                    @if (f.veredicto !== 'ok') { <p-tag [value]="etiqueta(f.veredicto)" severity="secondary" /> }
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        </app-load-state>
      }

      @case ('movimiento') {
        <app-load-state [loading]="serie() === null && !errorTab()" [error]="errorTab()"
                        [isEmpty]="serie()?.length === 0" [skeletonRows]="8"
                        emptyIcon="pi-chart-line" emptyTitle="Este camión no tuvo ni carga ni venta en estas fechas"
                        (retry)="pedirSerie()">

        <!-- ─────────── Un día abierto: qué entró y qué salió (RD.48) ─────────── -->
        @if (diaSel(); as d) {
          <div class="ir-sub-head">
            <button type="button" class="ir-volver" (click)="cerrarDia()">
              <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a los días
            </button>
            <span class="ir-tenue">
              <strong class="ir-mono">{{ d.fecha }}</strong>
              · se le cargó {{ dCarga(d) | currency:'MXN':'symbol-narrow':'1.2-2' }}
              · vendió {{ dVenta(d) | currency:'MXN':'symbol-narrow':'1.2-2' }}
            </span>
          </div>

          <!--
            El cuadre del drill-down. Si las dos tablas no suman lo que decia la fila que el
            usuario toco, la pantalla lo DICE: un desglose que no cuadra con su total no
            explica nada. No deberia pasar -- las dos cifras salen del mismo resolvedor -- y
            por eso mismo, si pasa, hay que enterarse.
          -->
          @if (descuadreDia(); as x) {
            <p class="ir-aviso ir-aviso-mal">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              El desglose suma {{ x.desglose | currency:'MXN':'symbol-narrow':'1.2-2' }} y la fila
              del día decía {{ x.fila | currency:'MXN':'symbol-narrow':'1.2-2' }}. No tomes
              ninguna de las dos como buena hasta saber por qué.
            </p>
          }
          @if (d.sin_valuar > 0 || d.sin_nombre > 0) {
            <p class="ir-aviso">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              @if (d.sin_valuar > 0) {
                <strong>{{ d.sin_valuar }}</strong> renglón(es) sin con qué valuarse: aparecen con
                su cantidad pero <strong>no entran en los totales</strong>.
              }
              @if (d.sin_nombre > 0) {
                {{ d.sin_valuar > 0 ? ' · ' : '' }}<strong>{{ d.sin_nombre }}</strong> sin nombre en
                el catálogo: se muestran con su código.
              }
            </p>
          }

          <!-- Filtros del desglose. Client-side sobre lo ya traído: instantáneos. -->
          <div class="ir-filtros" role="group" aria-label="Filtros del desglose del día">
            <span class="ir-buscar">
              <i class="pi pi-search" aria-hidden="true"></i>
              <input type="search" [ngModel]="buscaDia()" (ngModelChange)="buscaDia.set($event)"
                     placeholder="Buscar producto o código" aria-label="Buscar producto o código" />
            </span>
            <!-- La UNIDAD es filtro de primera clase, no un adorno: el mismo SKU entra en PZA y
                 en PAQ, y mirarlos juntos es el error que ADR-055/057 documentan en todo el
                 proyecto. Acá se puede aislar un peldaño. -->
            <span class="ir-chips" role="radiogroup" aria-label="Unidad">
              @for (u of unidadesDia(); track u) {
                <button type="button" role="radio" [attr.aria-checked]="unidadDia() === u"
                        [class.on]="unidadDia() === u" (click)="unidadDia.set(u)">{{ u === '' ? 'Todas' : u }}</button>
              }
            </span>
          </div>

          <div class="ir-dos-tablas">
            @for (bloque of bloquesDia(); track bloque.clase) {
              <section class="ir-bloque">
                <h4 class="ir-bloque-h">
                  <i [class]="bloque.icono" aria-hidden="true"></i> {{ bloque.titulo }}
                  <span class="ir-tenue">{{ bloque.filas.length }} de {{ bloque.total }} ·
                    {{ bloque.suma | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                </h4>
                @if (bloque.filas.length === 0) {
                  <p class="ir-vacio">{{ bloque.vacio }}</p>
                } @else {
                  <div class="dt-scope">
                    <p-table [value]="bloque.filas" [scrollable]="true" scrollHeight="34vh"
                             class="dt-stack surf-table surf-table--sticky" size="small" [rowHover]="true"
                             [tableStyle]="{ 'min-width': '34rem' }">
                      <ng-template #header>
                        <tr><th>Producto</th><th>Unidad</th><th class="num">Cantidad</th>
                          <th class="num">{{ metrica() === 'costo' ? 'Le costó' : 'A precio' }}</th></tr>
                      </ng-template>
                      <ng-template #body let-l>
                        <tr>
                          <td role="cell" data-label="Producto">
                            {{ l.producto }}
                            @if (l.producto === l.sku) { <span class="ir-tenue" title="El catálogo no le da nombre">sin nombre</span> }
                            @else { <small class="ir-mono ir-tenue">{{ l.sku }}</small> }
                          </td>
                          <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ l.unidad }}</td>
                          <td class="num ir-mono" role="cell" data-label="Cantidad">{{ l.qty | number:'1.0-3' }}</td>
                          <td class="num ir-mono" role="cell" [attr.data-label]="metrica() === 'costo' ? 'Le costó' : 'A precio'">
                            @if (valorLinea(l) === null) {
                              <span class="ir-tenue" title="No hay con qué valuarlo: no entra en el total">—</span>
                            } @else { {{ valorLinea(l) | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                          </td>
                        </tr>
                      </ng-template>
                    </p-table>
                  </div>
                }
              </section>
            }
          </div>
        } @else {

          <p class="ir-nota">
            Cada día, lo que se le cargó contra lo que vendió, y <strong>lo que queda</strong> al
            cierre. El día en que eso cruza a negativo es el día en que la ruta empezó a vender lo
            que ya traía. Las tres cifras en pesos van en la
            <strong>{{ metrica() === 'costo' ? 'misma valuación: el costo del embarque' : 'misma valuación: el precio al cliente' }}</strong>,
            para que restarlas signifique algo; las unidades van en su propia columna.
            <strong>Tocá un día</strong> para ver qué productos entraron y cuáles salieron.
          </p>

          <!-- Filtros de la serie. Client-side: narran lo ya traído, sin volver al servidor. -->
          <div class="ir-filtros" role="group" aria-label="Qué días mostrar">
            <span class="ir-chips" role="radiogroup" aria-label="Qué días mostrar">
              @for (f of FILTROS_DIA; track f.value) {
                <button type="button" role="radio" [attr.aria-checked]="filtroDia() === f.value"
                        [class.on]="filtroDia() === f.value" (click)="filtroDia.set(f.value)"
                        [title]="f.ayuda">{{ f.label }}</button>
              }
            </span>
            <span class="ir-tenue">{{ serieFiltrada().length }} de {{ serie()?.length ?? 0 }} días</span>
          </div>

          <div class="dt-scope">
            <p-table [value]="serieFiltrada()" [scrollable]="true" scrollHeight="52vh"
                     class="dt-stack surf-table surf-table--sticky" size="small" [rowHover]="true"
                     [tableStyle]="{ 'min-width': '42rem' }">
              <ng-template #header>
                <!--
                  Las tres columnas de dinero van en la MISMA valuación, la que elige el
                  conmutador. Antes «Cargado» iba al costo y «Vendido» a precio: restarlas con
                  el ojo daba el margen, no el saldo — la lectura A de VERDAD_ABSOLUTA §19,
                  dentro de la pantalla que existe para denunciarla.
                -->
                <tr><th>Día</th>
                  <th class="num">Se le cargó</th>
                  <th class="num" title="Lo que vendió ese día, valuado en la misma moneda que la carga">Vendió</th>
                  <th title="Carga contra venta del día, a la misma escala">Carga vs venta</th>
                  <th class="num" title="Lo que le queda arriba al cierre de ese día">Trae al cierre</th>
                  <th class="num" title="El mismo saldo, en piezas">Piezas</th>
                  <th></th></tr>
              </ng-template>
              <ng-template #body let-p>
                <tr>
                  <td class="dt-id ir-mono" role="cell">{{ p.fecha }}</td>
                  <td class="num ir-mono" role="cell" data-label="Se le cargó">{{ sCarga(p) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Vendió">{{ sVendido(p) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td role="cell" data-label="Carga vs venta">
                    <span class="ir-barra"
                          [title]="'Cargado ' + (sCarga(p) | currency:'MXN':'symbol-narrow':'1.0-0') + ' · vendido ' + (sVendido(p) | currency:'MXN':'symbol-narrow':'1.0-0')">
                      <i class="ir-b-carga" [style.width.%]="pct(sCarga(p))"></i>
                      <i class="ir-b-venta" [style.width.%]="pct(sVendido(p))"></i>
                    </span>
                  </td>
                  <td class="num ir-mono ir-fuerte" role="cell" data-label="Trae al cierre"
                      [class.ir-bad]="sSaldo(p) < 0">{{ sSaldo(p) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <!-- Las unidades van APARTE y rotuladas, no mezcladas en la fila de pesos. -->
                  <td class="num ir-mono ir-tenue" role="cell" data-label="Piezas"
                      [class.ir-bad]="p.saldo_qty_acum < 0">{{ p.saldo_qty_acum | number:'1.0-0' }}</td>
                  <!-- Mismo patrón que los embarques: un botón real, alcanzable con teclado.
                       Una fila con (click) suelto no la alcanza nadie que no use mouse. -->
                  <td class="num" role="cell" data-label="">
                    <p-button icon="pi pi-angle-right" severity="secondary" [text]="true" size="small"
                              [ariaLabel]="'Ver qué se cargó y qué se vendió el ' + p.fecha"
                              (onClick)="abrirDia(p)" />
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        }
        </app-load-state>
      }

      @case ('traspasos') {
        <app-load-state [loading]="embarques() === null && !errorTab()" [error]="errorTab()"
                        [isEmpty]="embarques()?.length === 0" [skeletonRows]="8"
                        emptyIcon="pi-truck" emptyTitle="A este camión no se le cargó nada en estas fechas"
                        (retry)="pedirEmbarques()">
          @if (embarqueSel(); as e) {
            <div class="ir-sub-head">
              <button type="button" class="ir-volver" (click)="cerrarEmbarque()">
                <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a los embarques
              </button>
              <span class="ir-tenue">Folio <strong class="ir-mono">{{ e.folio }}</strong> · {{ e.fecha }}
                · {{ e.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            </div>
            <app-load-state [loading]="lineas() === null" [isEmpty]="lineas()?.length === 0"
                            [skeletonRows]="6" emptyIcon="pi-box" emptyTitle="Este embarque no trae productos">
              <div class="dt-scope">
                <p-table [value]="lineas() ?? []" [scrollable]="true" scrollHeight="48vh"
                         class="dt-stack surf-table" size="small" [rowHover]="true"
                         [tableStyle]="{ 'min-width': '44rem' }">
                  <ng-template #header>
                    <tr><th>SKU</th><th>Producto</th><th>Unidad</th><th class="num">Cantidad</th>
                      <th class="num" title="A cuánto se le cobró cada una">Costo por unidad</th>
                      <th class="num">Le costó</th><th></th></tr>
                  </ng-template>
                  <ng-template #body let-l>
                    <tr>
                      <td class="dt-id ir-mono" role="cell">{{ l.sku }}</td>
                      <td role="cell" data-label="Producto">{{ l.producto }}</td>
                      <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ l.unidad }}</td>
                      <td class="num ir-mono" role="cell" data-label="Cantidad">{{ l.qty | number:'1.0-2' }}</td>
                      <td class="num ir-mono" role="cell" data-label="Costo por unidad">{{ l.costo_unitario | currency:'MXN':'symbol-narrow':'1.2-4' }}</td>
                      <td class="num ir-mono" role="cell" data-label="Le costó">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td role="cell" data-label="">
                        @if (l.salto_peldano) {
                          <span [title]="'Se cargó a ' + (l.costo_unitario | number:'1.2-2') + ' contra un histórico de ' + (l.costo_mediano | number:'1.2-2') + ': el salto es >= 2x, y el factor de caja mínimo del catálogo es 2.00'">
                            <p-tag value="salto de unidad" severity="warn" />
                          </span>
                        }
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            </app-load-state>
          } @else {
            <p class="ir-nota">
              Cada embarque que la sucursal le mandó al camión. Abrí uno para ver
              <strong>a qué costo se le cargó cada producto</strong>.
            </p>
            <div class="dt-scope">
              <p-table [value]="embarques() ?? []" [scrollable]="true" scrollHeight="52vh"
                       class="dt-stack surf-table surf-table--sticky" size="small" [rowHover]="true"
                       [tableStyle]="{ 'min-width': '40rem' }">
                <ng-template #header>
                  <tr><th>Fecha</th><th>Folio</th><th class="num" title="Renglones del documento">Productos</th>
                    <th class="num">Piezas</th><th class="num" title="Lo que el embarque le cobró al camión">Le costó</th><th class="num"></th></tr>
                </ng-template>
                <ng-template #body let-e>
                  <tr>
                    <td class="dt-id ir-mono" role="cell">{{ e.fecha }}</td>
                    <td class="ir-mono" role="cell" data-label="Folio">{{ e.folio }}</td>
                    <td class="num ir-mono ir-tenue" role="cell" data-label="Productos">{{ e.lineas }}</td>
                    <td class="num ir-mono ir-tenue" role="cell" data-label="Piezas">{{ e.unidades | number:'1.0-0' }}</td>
                    <td class="num ir-mono ir-fuerte" role="cell" data-label="Le costó">{{ e.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    <td class="num" role="cell" data-label="">
                      <p-button icon="pi pi-angle-right" severity="secondary" [text]="true" size="small"
                                [ariaLabel]="'Ver las líneas del embarque ' + e.folio"
                                (onClick)="abrirEmbarque(e)" />
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }
        </app-load-state>
      }

      @case ('rojos') {
        <app-load-state [loading]="rojos() === null && !errorTab()" [error]="errorTab()"
                        [isEmpty]="rojos()?.length === 0" [skeletonRows]="8"
                        emptyIcon="pi-check-circle" emptyTitle="Este camión no vendió nada que no se le haya cargado"
                        (retry)="pedirRojos()">
          <p class="ir-nota">
            Son <strong>dos problemas distintos</strong>.
            <strong>Ya lo traía</strong>: lo vendió sin que nadie se lo cargara en la ventana —
            mercancía anterior al primer embarque, y <strong>no se puede valuar</strong> porque sin
            carga no hay costo. <strong>Se le acabó</strong>: sí se le cargó, lo vendió todo y
            siguió vendiendo. Ésta última es la accionable.
          </p>
          <div class="ir-chips">
            <span class="ir-chip ir-chip-bad">se le acabó: {{ cuenta('se_acabo') }}</span>
            <span class="ir-chip">ya lo traía: {{ cuenta('nunca_cargado') }}</span>
          </div>
          <div class="dt-scope">
            <p-table [value]="rojos() ?? []" [scrollable]="true" scrollHeight="48vh"
                     class="dt-stack surf-table surf-table--sticky" size="small" [rowHover]="true"
                     [tableStyle]="{ 'min-width': '48rem' }">
              <ng-template #header>
                <tr><th>SKU</th><th>Producto</th><th>Unidad</th>
                  <th class="num" title="Lo que vendió de más">De más</th>
                  <th title="Si nunca se le cargó, o si se le cargó y se le acabó">Por qué</th>
                  <th>Desde</th><th class="num">Días así</th>
                  <th class="num" title="Valuado al costo del embarque. Si nunca se le cargó, no hay con qué valuarlo">Cuánto costó</th></tr>
              </ng-template>
              <ng-template #body let-n>
                <tr>
                  <td class="dt-id ir-mono" role="cell">{{ n.sku }}</td>
                  <td role="cell" data-label="Producto">{{ n.producto }}</td>
                  <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ n.unidad }}</td>
                  <td class="num ir-mono ir-bad" role="cell" data-label="Trae"><strong>{{ n.saldo | number:'1.0-2' }}</strong></td>
                  <td role="cell" data-label="Por qué">
                    <p-tag [value]="n.familia === 'se_acabo' ? 'se le acabó' : 'ya lo traía'"
                           [severity]="n.familia === 'se_acabo' ? 'danger' : 'secondary'" />
                  </td>
                  <td class="ir-mono ir-tenue" role="cell" data-label="Desde">{{ n.desde ?? '—' }}</td>
                  <td class="num ir-mono ir-tenue" role="cell" data-label="Días así">{{ n.dias_en_rojo ?? '—' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Cuánto costó">
                    @if (n.valor_costo === null) {
                      <span class="ir-tenue" title="Sin carga no hay costo con qué valuarlo">—</span>
                    } @else { {{ n.valor_costo | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        </app-load-state>
      }
    }
  </app-side-peek>
</div>
  `,
  styles: [`
    .ir-page { padding: 1rem 1.25rem 2rem; display: flex; flex-direction: column; gap: .9rem; }
    .ir-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .ir-head h1 { font-size: 1.35rem; font-weight: 700; margin: 0; color: var(--c-text-1); }
    .ir-sub { margin: .25rem 0 0; color: var(--c-text-3); font-size: .85rem; max-width: 72ch; }
    .ir-bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .ir-bar-l { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

    .ir-veredicto { display: flex; gap: .55rem; align-items: flex-start; margin: 0;
      font-size: .9rem; color: var(--c-text-1); line-height: 1.45;
      background: var(--c-surface-1); border: 1px solid var(--border);
      border-left: 3px solid var(--ok); border-radius: var(--radius-md); padding: .7rem .9rem; }
    .ir-veredicto i { color: var(--ok); margin-top: .15rem; }
    .ir-veredicto.ir-v-mal { border-left-color: var(--bad); }
    .ir-veredicto.ir-v-mal i { color: var(--bad); }
    .ir-veredicto.ir-v-aviso { border-left-color: var(--warn); }
    .ir-veredicto.ir-v-aviso i { color: var(--warn); }
    .ir-veredicto.ir-v-neutro { border-left-color: var(--c-divider); }
    .ir-veredicto.ir-v-neutro i { color: var(--c-text-3); }

    .ir-sub-bar { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
      font-size: .76rem; color: var(--c-text-3); }

    .ir-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: .82rem; }
    .ir-fuerte { color: var(--c-text-1); font-weight: 600; }
    .ir-tenue { color: var(--c-text-3); }
    .ir-ok { color: var(--ok-fg); }
    .ir-bad { color: var(--bad-fg); }
    /* El escalon que falta: 80% del tope no es un error todavia, pero conviene mirarlo. */
    .ir-aviso { color: var(--warn-fg); }
    .ir-fila-mal { background: var(--bad-soft-bg); }
    .ir-fila-parada td { opacity: .72; }

    .ir-hist { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem;
      margin: 0 0 .75rem; padding: .5rem .6rem; border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: var(--c-surface-2); }
    .ir-hist dt { font-size: .68rem; color: var(--c-text-3); text-transform: uppercase;
      letter-spacing: .03em; margin-bottom: .1rem; }
    .ir-hist dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600;
      font-size: .82rem; color: var(--c-text-1); }
    @media (max-width: 40rem) { .ir-hist { grid-template-columns: repeat(2, 1fr); } }
    .ir-tabs { display: flex; gap: .2rem; border-bottom: 1px solid var(--border); margin-bottom: .75rem; }
    .ir-tabs button { background: none; border: 0; border-bottom: 2px solid transparent;
      padding: .45rem .8rem; font: inherit; font-size: .85rem; font-weight: 600;
      color: var(--c-text-3); cursor: pointer; }
    .ir-tabs button.on { color: var(--c-text-1); border-bottom-color: var(--action); }
    .ir-tabs button:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }

    .ir-nota { font-size: .8rem; color: var(--c-text-2); background: var(--c-surface-2);
      border-radius: var(--radius-sm); padding: .6rem .8rem; margin: 0 0 .7rem; line-height: 1.5; }
    .ir-sub-head { display: flex; justify-content: space-between; align-items: center;
      gap: .75rem; flex-wrap: wrap; margin-bottom: .6rem; font-size: .8rem; }
    .ir-volver { background: none; border: 0; color: var(--action); font: inherit;
      font-size: .82rem; cursor: pointer; padding: 0; }
    .ir-volver:hover { text-decoration: underline; }

    .ir-chips { display: flex; gap: .4rem; margin-bottom: .6rem; }
    .ir-chip { font-size: .74rem; padding: .15rem .55rem; border-radius: 999px;
      background: var(--c-surface-2); color: var(--c-text-2); border: 1px solid var(--border); }
    .ir-chip-bad { background: var(--bad-soft-bg); color: var(--bad-fg); border-color: transparent; }

    .ir-barra { display: flex; flex-direction: column; gap: 2px; min-width: 90px; }
    .ir-barra i { display: block; height: 5px; border-radius: 2px; min-width: 1px; }
    .ir-b-carga { background: var(--action); }
    .ir-b-venta { background: var(--ok); }

    .ir-contraste, .ir-declara { font-size: .8rem; color: var(--c-text-2);
      background: var(--c-surface-2); border-radius: var(--radius-sm); padding: .65rem .85rem; margin: 0; }
    .ir-contraste { display: flex; gap: .55rem; align-items: flex-start;
      border-left: 3px solid var(--c-divider); margin-bottom: .6rem; }
    .ir-contraste i { color: var(--c-text-3); margin-top: .15rem; }
    .ir-declara p { margin: 0 0 .3rem; }
    .ir-declara p:last-child { margin: 0; }
    .ir-declara i { color: var(--c-text-3); margin-right: .3rem; }

    .ir-sr { position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap; }

    /* RD.48 - la barra de filtros de la comparativa y del dia abierto. */
    .ir-filtros { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
      margin: 0 0 .6rem; }
    .ir-filtros .ir-chips { margin: 0; }
    /* Los chips de filtro son BOTONES, no las pildoras de solo lectura que ya vivian en
       .ir-chip. Comparten la forma a proposito: la misma cosa se ve igual. */
    .ir-chips button { font-size: var(--fs-xs); padding: .2rem .6rem; border-radius: 999px;
      background: var(--c-surface-2); color: var(--c-text-2); border: 1px solid var(--border);
      cursor: pointer; }
    .ir-chips button.on { background: var(--action); color: #fff; border-color: transparent; }
    .ir-chips button:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ir-buscar { display: flex; align-items: center; gap: .35rem; padding: .18rem .5rem;
      border: 1px solid var(--border); border-radius: 8px; background: var(--c-surface-2); }
    .ir-buscar i { color: var(--c-text-3); font-size: var(--fs-xs); }
    .ir-buscar input { border: 0; background: transparent; color: var(--c-text-1);
      font-size: var(--fs-sm); min-width: 13rem; padding: .15rem 0; }
    .ir-buscar input:focus { outline: none; }
    .ir-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    /* Las dos tablas del dia. En pantalla ancha van lado a lado -- comparar lo que entro
       contra lo que salio es el punto -- y en angosto se apilan. */
    .ir-dos-tablas { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; }
    @media (max-width: 60rem) { .ir-dos-tablas { grid-template-columns: 1fr; } }
    .ir-bloque { min-width: 0; }
    .ir-bloque-h { display: flex; align-items: baseline; gap: .4rem; flex-wrap: wrap;
      margin: 0 0 .4rem; font-size: var(--fs-h3); }
    .ir-bloque-h .ir-tenue { font-weight: 400; font-size: var(--fs-xs); }
    .ir-vacio { font-size: var(--fs-xs); color: var(--c-text-3); font-style: italic;
      padding: .6rem 0; }
    .ir-aviso-mal { color: var(--bad-fg); font-weight: 600; }
  `],
})
export class ComercialInventarioRutaComponent {
  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly ruta = inject(ActivatedRoute);

  readonly tabs = REPORTS_TABS;
  /** Centinela que el backend devuelve cuando no se acotó el rango. */
  readonly TODO = '2000-01-01';
  readonly VALUACIONES = [
    // Medido: el embarque se valua al costo estandar de la ficha (razon 1.0000 sobre 1,095
    // pares) y queda 23.5% debajo de lo que la ruta cobra. Los rotulos nombran ese hecho.
    { label: 'Lo que costó', value: 'costo' },
    { label: 'Lo que vale al cliente', value: 'venta' },
  ];
  readonly PESTANAS: { label: string; value: Pestana }[] = [
    { label: 'Qué trae', value: 'productos' },
    { label: 'Día por día', value: 'movimiento' },
    { label: 'Embarques', value: 'traspasos' },
    { label: 'Vendió de más', value: 'rojos' },
  ];
  /** Días sin un solo movimiento a partir de los cuales la ruta se marca como parada. */
  private readonly PARADA_DIAS = 7;

  rango: Date[] | null = null;
  readonly metrica = signal<Metrica>('costo');
  readonly plazasSel = signal<string[]>([]);
  readonly rutasSel = signal<string[]>([]);
  readonly data = signal<RouteInventoryReport | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly detalleAbierto = signal(false);
  readonly rutaSel = signal<RouteInventoryRow | null>(null);
  readonly pestana = signal<Pestana>('productos');
  readonly detalle = signal<RouteInventoryDetail | null>(null);
  readonly errorDetalle = signal<string | null>(null);
  readonly errorTab = signal<string | null>(null);
  readonly serie = signal<RouteSeriesPoint[] | null>(null);
  readonly embarques = signal<RouteShipment[] | null>(null);
  readonly embarqueSel = signal<RouteShipment | null>(null);
  readonly lineas = signal<RouteShipmentLine[] | null>(null);
  readonly rojos = signal<RouteNegativeRow[] | null>(null);

  // ── `[RD.48]` Un día de la comparativa, abierto ────────────────────────────────────────
  /** El día que el usuario tocó, ya resuelto. `null` = se está viendo la lista de días. */
  readonly diaSel = signal<RouteDayBreakdown | null>(null);
  /** La fila de la serie que originó el clic: es contra ella que se cuadra el desglose. */
  readonly diaOrigen = signal<RouteSeriesPoint | null>(null);
  readonly buscaDia = signal('');
  readonly unidadDia = signal('');
  readonly filtroDia = signal<'todos' | 'carga' | 'venta' | 'rojo'>('todos');

  /**
   * Los filtros de la serie. Son de VISTA —actúan sobre lo ya traído, sin volver al servidor—
   * así que responden al instante y no gastan una consulta por clic. Mismo criterio que los
   * filtros de `comercial-ventas-por-ruta`.
   */
  readonly FILTROS_DIA = [
    { value: 'todos' as const, label: 'Todos', ayuda: 'Todos los días de la ventana' },
    { value: 'carga' as const, label: 'Con carga', ayuda: 'Sólo los días en que se le subió mercancía' },
    { value: 'venta' as const, label: 'Con venta', ayuda: 'Sólo los días en que vendió' },
    { value: 'rojo' as const, label: 'En rojo', ayuda: 'Días en que el camión cerró con saldo negativo: vendía lo que ya traía' },
  ];

  readonly serieFiltrada = computed<RouteSeriesPoint[]>(() => {
    const s = this.serie() ?? [];
    switch (this.filtroDia()) {
      case 'carga': return s.filter((p) => this.sCarga(p) > 0);
      case 'venta': return s.filter((p) => this.sVendido(p) > 0);
      case 'rojo': return s.filter((p) => this.sSaldo(p) < 0);
      default: return s;
    }
  });

  /** Las unidades presentes en el día abierto, con «Todas» al frente. */
  readonly unidadesDia = computed<string[]>(() => {
    const d = this.diaSel();
    if (!d) return [''];
    const us = new Set<string>();
    for (const l of [...d.cargado, ...d.vendido]) us.add(l.unidad);
    return ['', ...[...us].sort()];
  });

  /** El valor de un renglón en la valuación que el conmutador eligió. `null` = sin valuar. */
  valorLinea = (l: RouteDayLine): number | null =>
    this.metrica() === 'costo' ? l.costo : l.precio;

  dCarga = (d: RouteDayBreakdown) => this.metrica() === 'costo' ? d.carga_costo : d.carga_precio;
  dVenta = (d: RouteDayBreakdown) => this.metrica() === 'costo' ? d.venta_costo : d.venta_precio;

  /**
   * Las dos tablas del día, ya filtradas. Se arma una sola vez por cambio de filtro y no dos
   * veces en la plantilla: con `@for` sobre esto, agregar una tercera clase algún día es
   * agregar un elemento, no copiar un bloque de markup.
   */
  readonly bloquesDia = computed(() => {
    const d = this.diaSel();
    if (!d) return [];
    const t = this.buscaDia().trim().toLowerCase();
    const u = this.unidadDia();
    const filtra = (xs: RouteDayLine[]) => xs.filter((l) =>
      (!u || l.unidad === u)
      && (!t || l.producto.toLowerCase().includes(t) || l.sku.toLowerCase().includes(t)));
    const arma = (clase: 'carga' | 'venta', xs: RouteDayLine[], titulo: string, icono: string, vacio: string) => {
      const filas = filtra(xs);
      return {
        clase, titulo, icono, filas, total: xs.length, vacio,
        // La suma es la de lo FILTRADO, no la del día: si dice otra cosa que lo que hay en
        // pantalla, el usuario no tiene forma de saber cuál de las dos mirar.
        suma: filas.reduce((a, l) => a + (this.valorLinea(l) ?? 0), 0),
      };
    };
    return [
      arma('carga', d.cargado, 'Se le cargó', 'pi pi-arrow-down-left',
        d.cargado.length ? 'Ningún producto cargado coincide con el filtro' : 'Ese día no se le cargó nada'),
      arma('venta', d.vendido, 'Vendió', 'pi pi-arrow-up-right',
        d.vendido.length ? 'Ningún producto vendido coincide con el filtro' : 'Ese día no vendió nada'),
    ];
  });

  /**
   * ⭐ El cuadre del drill-down: ¿el desglose suma lo que decía la fila que se tocó?
   *
   * No debería fallar nunca —las dos cifras salen del mismo resolvedor, que es justo por qué
   * este endpoint no usa `costo_doc`— y por eso vale comprobarlo: el día que falle, significa
   * que alguien cambió una de las dos fuentes y la pantalla estaría abriendo un total que sus
   * propios renglones no explican. Devuelve `null` cuando cuadra.
   */
  readonly descuadreDia = computed<{ desglose: number; fila: number } | null>(() => {
    const d = this.diaSel(); const p = this.diaOrigen();
    if (!d || !p) return null;
    // Sólo se compara lo que SE PUEDE valuar: los renglones sin valuación se declaran aparte
    // y restarlos acá convertiría una ausencia conocida en un descuadre falso.
    if (d.sin_valuar > 0) return null;
    const desglose = this.dCarga(d) + this.dVenta(d);
    const fila = this.sCarga(p) + this.sVendido(p);
    return Math.abs(desglose - fila) < 0.01 ? null : { desglose, fila };
  });

  abrirDia(p: RouteSeriesPoint): void {
    const r = this.rutaSel();
    if (!r) return;
    this.diaOrigen.set(p);
    this.diaSel.set(null);
    this.buscaDia.set('');
    this.unidadDia.set('');
    this.api.routeDayBreakdown(r.route_no, p.fecha)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.diaSel.set(d),
        error: (e) => {
          this.diaOrigen.set(null);
          this.errorTab.set(e?.error?.message ?? 'No se pudo abrir ese día.');
        },
      });
  }

  cerrarDia(): void { this.diaSel.set(null); this.diaOrigen.set(null); }

  constructor() {
    // Estado de filtros en la URL (DESIGN §10): se comparte por link y sobrevive un refresh.
    const q = this.ruta.snapshot.queryParamMap;
    const m = q.get('v');
    if (m === 'venta' || m === 'costo') this.metrica.set(m);
    const pl = q.get('plaza');
    if (pl) this.plazasSel.set(pl.split(',').filter(Boolean));
    const rt = q.get('ruta');
    if (rt) this.rutasSel.set(rt.split(',').filter(Boolean));
    const f = q.get('from');
    const t = q.get('to');
    // ⛔ La PORTADA no toma ventana: muestra lo que los camiones traen HOY. Un rango de
    // fechas en la portada contestaba "cuanto movio en esos dias", que es otra pregunta --
    // y con una ventana corta la cifra de inventario deja de significar nada.
    // El rango sigue vivo en el desglose de cada ruta, que es donde vive el historial.
    this.rango = null;
    this.cargar();
  }

  // ── Filtros ──
  setMetrica(v: string): void {
    this.metrica.set(v === 'venta' ? 'venta' : 'costo');
    this.sincronizarUrl();
  }
  setPlazas(v: string[]): void { this.plazasSel.set(v ?? []); this.sincronizarUrl(); }
  setRutas(v: string[]): void { this.rutasSel.set(v ?? []); this.sincronizarUrl(); }

  private sincronizarUrl(): void {
    const [f, t] = this.rangoIso();
    this.router.navigate([], {
      relativeTo: this.ruta,
      queryParams: {
        v: this.metrica() === 'costo' ? null : 'venta',
        plaza: this.plazasSel().length ? this.plazasSel().join(',') : null,
        ruta: this.rutasSel().length ? this.rutasSel().join(',') : null,
        from: f ?? null, to: t ?? null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.sincronizarUrl();
    const [f, t] = this.rangoIso();
    this.api.routeInventory(f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.data.set(d); this.cargando.set(false); },
        error: (e) => {
          this.cargando.set(false);
          // Empty ≠ error de red (DESIGN §6): el error va al estado, no a un vacío silencioso.
          this.error.set(e?.error?.message ?? 'No se pudo leer el inventario de ruta.');
        },
      });
  }

  // ── Detalle ──
  abrirDetalle(r: RouteInventoryRow): void {
    this.rutaSel.set(r);
    this.detalleAbierto.set(true);
    this.embarqueSel.set(null);
    // [RD.48] Sin esto, abrir otra ruta deja en pantalla el desglose de un dia de la anterior.
    this.cerrarDia();
    this.pedirPestana();
  }

  setPestana(p: Pestana): void { this.pestana.set(p); this.embarqueSel.set(null); this.cerrarDia(); this.pedirPestana(); }

  private pedirPestana(): void {
    this.errorTab.set(null);
    switch (this.pestana()) {
      case 'productos': this.pedirDetalle(); break;
      case 'movimiento': this.pedirSerie(); break;
      case 'traspasos': this.pedirEmbarques(); break;
      case 'rojos': this.pedirRojos(); break;
    }
  }

  pedirDetalle(): void {
    const r = this.rutaSel();
    if (!r) return;
    this.detalle.set(null);
    this.errorDetalle.set(null);
    const [f, t] = this.rangoIso();
    this.api.routeInventoryDetail(r.route_no, f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.detalle.set(d),
        error: (e) => this.errorDetalle.set(e?.error?.message ?? 'No se pudo leer el detalle.'),
      });
  }

  pedirSerie(): void {
    const r = this.rutaSel();
    if (!r) return;
    this.serie.set(null);
    const [f, t] = this.rangoIso();
    this.api.routeSeries(r.route_no, f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.serie.set(d),
        error: (e) => this.errorTab.set(e?.error?.message ?? 'No se pudo leer el movimiento.'),
      });
  }

  pedirEmbarques(): void {
    const r = this.rutaSel();
    if (!r) return;
    this.embarques.set(null);
    const [f, t] = this.rangoIso();
    this.api.routeShipments(r.route_no, f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.embarques.set(d),
        error: (e) => this.errorTab.set(e?.error?.message ?? 'No se pudieron leer los embarques.'),
      });
  }

  abrirEmbarque(e: RouteShipment): void {
    const r = this.rutaSel();
    if (!r) return;
    this.embarqueSel.set(e);
    this.lineas.set(null);
    this.api.routeShipmentLines(r.route_no, e.folio, e.serie)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.lineas.set(d),
        error: () => {
          this.lineas.set([]);
          this.toast.add({ severity: 'error', summary: 'No se pudieron leer las líneas del embarque' });
        },
      });
  }
  cerrarEmbarque(): void { this.embarqueSel.set(null); }

  pedirRojos(): void {
    const r = this.rutaSel();
    if (!r) return;
    this.rojos.set(null);
    const [f, t] = this.rangoIso();
    this.api.routeNegatives(r.route_no, f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.rojos.set(d),
        error: (e) => this.errorTab.set(e?.error?.message ?? 'No se pudieron leer los números rojos.'),
      });
  }

  cuenta(f: RouteNegativeRow['familia']): number {
    return (this.rojos() ?? []).filter((r) => r.familia === f).length;
  }

  /** Ancho de la barra de proporción: contra el día más grande de la serie. */
  // ── La serie, leída en la valuación elegida. Nunca una columna de cada moneda. ──
  sCarga = (p: RouteSeriesPoint) => this.metrica() === 'costo' ? p.cargado_costo : p.cargado_venta;
  sVendido = (p: RouteSeriesPoint) => this.metrica() === 'costo' ? p.vendido_costo : p.vendido_venta;
  sSaldo = (p: RouteSeriesPoint) => this.metrica() === 'costo' ? p.saldo_costo_acum : p.saldo_venta_acum;

  /**
   * La barra normaliza contra el máximo de la MISMA valuación. Con las dos monedas mezcladas
   * dibujaba el margen como si fuera sobreventa: todos los días la barra de venta salía ~28%
   * más larga que la de carga, y eso era el margen, no mercancía de más.
   */
  pct(v: number): number {
    const s = this.serie() ?? [];
    const max = Math.max(1, ...s.flatMap((p) => [this.sCarga(p), this.sVendido(p)]));
    return Math.max(1, Math.round((Number(v) || 0) / max * 100));
  }

  // ── Lecturas por valuación. Las dos columnas NUNCA se mezclan. ──
  carga = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.carga_costo : r.carga_venta;
  vendido = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.cogs_costo : r.venta_cliente;
  /**
   * ⭐ **Lo que el camión TRAE es sólo el lado positivo, y el negativo NO se le resta.**
   *
   * Auditada la ruta 21 de punta a punta contra Kepler: vendió **$179,044 entre el 6 y el 14 de
   * julio, antes de su primer embarque documentado**. Esa mercancía existió, se vendió y cobró,
   * pero nadie la contó — y al restarla el camión aparecía con **−$11,693** cuando de verdad
   * tiene **$20,981** arriba.
   *
   * No es un faltante: es un arranque sin contar. Restarlo mezcla dos cosas distintas —lo que
   * hay y lo que hubo— y publica la segunda como si fuera la primera.
   *
   * Medido sobre las 11 rutas: el neto decía **$84,389** y lo que de verdad traen arriba son
   * **$389,165**, con **$304,776** de mercancía previa que se estaba restando. Cinco rutas se
   * publicaban en negativo y **ninguna de las once está vacía**.
   *
   * ⚠️ El neto NO desaparece: sigue viajando y es el que cierra el cuadre
   * (`cargado − vendido = positivo + negativo`). Lo que cambia es cuál es el titular.
   */
  inv = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_pos : r.inventario_venta_pos;
  /** El neto, el que cuadra contra `cargado − vendido`. Vive en el desglose, no en la portada. */
  invNeto = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo : r.inventario_venta;
  invPos = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_pos : r.inventario_venta_pos;
  invNeg = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_neg : r.inventario_venta_neg;
  delta = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.delta_costo : r.delta_venta;
  cierra = (r: RouteInventoryRow) => Math.abs(Number(this.delta(r)) || 0) < 0.01;

  /**
   * ⭐ **Lo que llegó al camión sin documento de embarque.**
   *
   * El backend publica `delta = (carga − venta) − saldo`, y desde `[RD.34]` el saldo lleva el
   * ancla de la foto: `saldo = carga + conteo − venta`. Haciendo la cuenta, `delta = −conteo`.
   *
   * O sea que ese número **no es un descuadre contable** —la igualdad con el ancla es cierta por
   * construcción— sino la mercancía que el camión declara y el embarque no explica. Se invierte
   * el signo para que se lea natural: **positivo = trae de más, negativo = salió sin papel**.
   *
   * Las dos pruebas de que es real y no un artefacto, medidas el 2026-10-07: el saldo acumulado
   * `carga − venta` se vuelve negativo en 10 de 11 rutas (un camión no puede vender lo que nunca
   * recibió), y la sucursal sólo tiene 2 a 6 recepciones `U-A-50` en toda la vida de cada ruta.
   *
   * ⚠️ Las rutas 21 y 26 salen en negativo desde `[RD.37]`: tienen 9 y 7 días al arranque sin una
   *    sola venta registrada en ninguna fuente. El signo lo está diciendo, no es un error.
   */
  sinEmbarque = (r: RouteInventoryRow) => -(Number(this.delta(r)) || 0);

  /**
   * RD.40 — ¿se puede creer el descuadre de esta ruta? El servidor lo decide contra
   * `analytics.v_rd_route_opening`; acá NO se recalcula. `undefined` (una respuesta vieja en
   * caché) se trata como NO medible: ante la duda se declara, no se publica.
   */
  medible = (r: RouteInventoryRow) => r.descuadre_medible === true;

  /**
   * ⛔ Devuelve `null` —NO cero— cuando el servidor no informó la exposición.
   *
   * La primera versión hacía `Number(r.sin_medir_costo) || 0`, y contra una API que todavía no
   * manda el campo eso pintó **«$0 que ninguna fuente cubre»** donde lo medido son $413,464, y
   * degeneró el piso al bruto dejando la etiqueta «lo que no explica cómo medimos» encima de
   * justo lo contrario. Un cero dibujado es indistinguible de un cero medido: es el defecto que
   * esta misma entrega existe para matar (ADR-056).
   */
  sinMedir = (r: RouteInventoryRow): number | null =>
    r.sin_medir_costo === null || r.sin_medir_costo === undefined ? null : Number(r.sin_medir_costo);

  /** Lo que la celda explica al pasar el cursor. Sin esto, "no medible" se lee como un error. */
  tituloSinEmbarque(r: RouteInventoryRow): string {
    if (this.medible(r)) {
      return 'Mercancía que el camión trae y el documento de embarque no explica.';
    }
    const exp = this.sinMedir(r);
    // Sin exposición informada no se puede decir CUÁNTO falta; decir "$0" sería inventar el dato
    // que justifica no publicar el otro. Se dice lo único cierto: que no se sabe.
    if (exp === null) {
      return 'No se puede medir: el servidor no informa cuánto de este descuadre lo explica cómo '
        + 'medimos. En bruto son ' + this.money(Math.abs(this.sinEmbarque(r)))
        + ', pero publicarlo como mercancía perdida sería afirmar de más.';
    }
    const motivo = r.sin_medir_motivo || 'faltan las dos mitades del periodo';
    return 'No se puede medir: ' + motivo + '. La cuenta tendría que restar '
      + this.money(exp) + ' que ninguna fuente cubre, contra un descuadre de '
      + this.money(Math.abs(this.sinEmbarque(r))) + ' — el hueco es más grande que la cifra, '
      + 'así que publicarla sería inventarla.';
  }

  /**
   * Días desde el último movimiento. `null` si no hay dato del día.
   * ⚠️ Es la columna que delata a una ruta parada: medido, la 505 lleva 22 días sin cargar ni
   * vender y hasta ahora se veía igual que las diez vivas.
   */
  sinMover(r: RouteInventoryRow): number | null {
    const d = this.data();
    if (!d?.data_as_of || !r.carga_desde) return null;
    const ms = Date.parse(d.data_as_of) - Date.parse(this.ultimoMovimiento(r));
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : null;
  }
  parada(r: RouteInventoryRow): boolean {
    const n = this.sinMover(r);
    return n !== null && n >= this.PARADA_DIAS;
  }
  /** Sin serie cargada, lo mejor que se sabe de la fila es su última actividad implícita. */
  private ultimoMovimiento(r: RouteInventoryRow): string {
    return r.ultimo_movimiento ?? this.data()?.data_as_of ?? '';
  }

  dias(r: RouteInventoryRow): number | null {
    const porDia = Number(this.vendido(r)) / Math.max(1, this.diasVentana());
    return porDia > 0 ? Number(this.inv(r)) / porDia : null;
  }

  valorFila = (f: RouteInventoryDetailRow): number | null =>
    this.metrica() === 'costo' ? f.saldo_costo : f.saldo_venta;

  etiqueta(v: RouteInventoryDetailRow['veredicto']): string {
    return v === 'sin_costo' ? 'sin costo' : v === 'sin_precio' ? 'sin precio' : '';
  }

  /** Qué tanto de su tope lleva ocupado. NULL sin tope: no se inventa un 0 ni un 100. */
  pctTope = (r: RouteInventoryRow) =>
    r.tope_inventario ? this.inv(r) / Number(r.tope_inventario) * 100 : 0;

  /** ¿Este camión pasa su tope? Sin tope declarado la respuesta es NO, nunca "sí por las dudas". */
  excede = (r: RouteInventoryRow) =>
    r.tope_inventario !== null && this.inv(r) > Number(r.tope_inventario);

  /** Pesos para los textos que se arman en TS, donde el pipe de Angular no llega. */
  money(v: number): string {
    return Number(v || 0).toLocaleString('es-MX',
      { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }

  etiquetaMetrica(): string {
    return this.metrica() === 'costo' ? 'a lo que costó' : 'a lo que vale al cliente';
  }

  subtituloDetalle(): string {
    return this.metrica() === 'costo'
      ? 'Saldo valuado al costo del embarque'
      : 'Saldo valuado al precio al que de verdad se vendió';
  }

  // ── Filtrado en memoria: la lista son 11 filas, no se pagina ni se pide de nuevo ──
  readonly todasLasFilas = computed(() => this.data()?.routes ?? []);
  readonly filas = computed(() => {
    const pl = this.plazasSel();
    const rt = this.rutasSel();
    return this.todasLasFilas().filter((r) =>
      (!pl.length || pl.includes(r.plaza)) && (!rt.length || rt.includes(r.route_no)));
  });
  readonly plazaOpts = computed(() =>
    [...new Set(this.todasLasFilas().map((r) => r.plaza))].sort()
      .map((p) => ({ label: p, value: p })));
  readonly rutaOpts = computed(() =>
    this.todasLasFilas().map((r) => ({ label: `${r.route_no} — ${r.plaza}`, value: r.route_no })));

  private suma(f: (r: RouteInventoryRow) => number): number {
    return this.filas().reduce((a, r) => a + (Number(f(r)) || 0), 0);
  }
  readonly totalCarga = computed(() => this.suma((r) => this.carga(r)));
  readonly totalVendido = computed(() => this.suma((r) => this.vendido(r)));
  readonly totalInv = computed(() => this.suma((r) => this.inv(r)));
  readonly totalPos = computed(() => this.suma((r) => this.invPos(r)));
  readonly totalNeg = computed(() => this.suma((r) => this.invNeg(r)));
  /**
   * ⛔ **El NETO de esta columna NO es el titular: se cancela.** Medido el 2026-10-07:
   * $140,030 llegaron sin papel y $169,003 salieron sin papel, y el neto da **−$28,972** —
   * que se lee como "casi resuelto" cuando lo que de verdad no está explicado son **$309,033**.
   *
   * Por eso el mosaico publica el BRUTO (la suma de los valores absolutos) y el neto queda
   * como nota. Un agregado que se cancela esconde justo lo que hay que mirar.
   */
  readonly brutoSinEmbarque = computed(() => this.suma((r) => Math.abs(this.sinEmbarque(r))));

  /**
   * RD.40 — **el piso defendible**: la parte del descuadre que el artefacto de medición NO
   * puede explicar. Se calcula POR RUTA y recién después se suma; restarle la exposición total
   * al descuadre total mezclaría una ruta donde el artefacto sobra con otra donde falta y
   * dejaría pasar la diferencia como si fuera real.
   *
   * Medido contra prod el 2026-10-07: bruto $301,834 · exposición $413,464 · piso $94,096.
   * El servidor lo manda calculado en `totales.descuadre_piso`; esto es el mismo cálculo sobre
   * las filas que la pantalla tiene a la vista, para que respete el filtro.
   */
  readonly pisoSinEmbarque = computed<number | null>(() => {
    const f = this.filas();
    if (!f.length || f.some((r) => this.sinMedir(r) === null)) return null;
    return f.reduce((a, r) => a + Math.max(0, Math.abs(this.sinEmbarque(r)) - (this.sinMedir(r) as number)), 0);
  });

  /** `null` = el servidor no informó la exposición. No es cero: es que no se sabe. */
  readonly expuestoSinMedir = computed<number | null>(() => {
    const f = this.filas();
    if (!f.length || f.some((r) => this.sinMedir(r) === null)) return null;
    return f.reduce((a, r) => a + (this.sinMedir(r) as number), 0);
  });

  readonly rutasSinMedir = computed(() => this.filas().filter((r) => !this.medible(r)).length);

  /** En cuántas rutas la mercancía previa ASOMA como saldo negativo. Hoy: una. */
  readonly rutasConPrevio = computed(() => this.filas().filter((r) => this.invNeg(r) < 0).length);
  readonly llegoSinEmbarque = computed(() => this.suma((r) => Math.max(0, this.sinEmbarque(r))));
  readonly salioSinEmbarque = computed(() => this.suma((r) => Math.min(0, this.sinEmbarque(r))));
  readonly totalCogsErp = computed(() => this.suma((r) => Number(r.cogs_erp) || 0));
  /** El COGS que SÍ se publica: valuado al costo del embarque, cobertura 100% de las cargas. */
  /** Camiones que pasan su tope, y por cuánto. Es la pregunta del negocio, no un adorno. */
  readonly excedidos = computed(() => this.filas().filter((r) => this.excede(r)).length);
  readonly sobreTope = computed(() => this.filas().reduce(
    (a, r) => a + (this.excede(r) ? this.inv(r) - Number(r.tope_inventario) : 0), 0));
  /** El camión que va más cerca de su tope, en porcentaje. Es lo que importa cuando nadie lo pasa. */
  readonly masCargado = computed(() =>
    this.filas().reduce((mx, r) => Math.max(mx, this.pctTope(r)), 0));
  readonly sinTope = computed(() => this.filas().filter((r) => r.tope_inventario === null).length);

  readonly totalCogs = computed(() => this.suma((r) => Number(r.cogs_costo) || 0));
  /**
   * Lo cargado ayer. Suma sólo las rutas que tuvieron embarque; las que no, no entran.
   * Sumar un null como 0 no cambia el total pero sí cambia el denominador de la lectura,
   * y la sub-leyenda dice "N de M rutas", no "$X repartidos entre todas".
   */
  readonly totalAyer = computed(() =>
    this.filas().reduce((a, r) => a + (r.cargado_ayer_costo ?? 0), 0));
  readonly rutasConCargaAyer = computed(() =>
    this.filas().filter((r) => r.cargado_ayer_costo !== null).length);
  /** La venta que el contraste del ERP no alcanza a explicar, en pesos. */
  readonly ventaSinContraste = computed(() =>
    this.filas().reduce((a, r) => a + (r.venta_sin_cogs_erp ?? 0), 0));
  /**
   * Cobertura del contraste EN DINERO. Se publica ésta y no la de pares: medido contra prod,
   * por pares el contraste "cubre" el 77.7% y en dinero el 31.6%. Un par con una sola línea
   * con costo contaba como cubierto entero.
   */
  readonly coberturaContraste = computed<number | null>(() => {
    const v = this.suma((r) => Number(r.venta_cliente) || 0);
    return v > 0 ? (1 - this.ventaSinContraste() / v) * 100 : null;
  });
  readonly sinCosto = computed(() => this.filas().reduce((a, r) => a + (r.pares_sin_costo || 0), 0));
  readonly sinPrecio = computed(() => this.filas().reduce((a, r) => a + (r.pares_sin_precio || 0), 0));

  readonly pctDeLoCargado = computed<number | null>(() => {
    const c = this.totalCarga();
    return c > 0 ? this.totalInv() / c * 100 : null;
  });
  readonly diasDeVenta = computed<number | null>(() => {
    const porDia = this.totalVendido() / Math.max(1, this.diasVentana());
    return porDia > 0 ? Math.abs(this.totalInv()) / porDia : null;
  });

  /**
   * El titular SALE DEL NUMERO. Umbrales declarados: |saldo| <= 5 % rota · +5 a +20 acumula algo ·
   * > +20 acumula · < -5 consume lo que ya traía.
   */
  readonly veredicto = computed<{ tono: string; icono: string; titulo: string; cuerpo: string }>(() => {
    const d = this.data();
    // ⛔ Se retiró el veredicto "la cuenta no cierra: no te fíes de estas cifras". Desde `[RD.34]`
    // el saldo de una ruta anclada ES lo que su camión declara, así que `(carga − venta) − saldo`
    // no puede dar 0 y ese aviso salía SIEMPRE — diciendo que no te fiaras justo cuando las
    // cifras pasaron a ser medidas en vez de reconstruidas. Lo que esa diferencia mide vive
    // ahora en la columna "Llegó sin embarque", que es información y no una falla.
    const pct = this.pctDeLoCargado();
    if (d?.cuadra === 'sin_medir' || pct === null) {
      return {
        tono: 'neutro', icono: 'pi-minus-circle', titulo: 'Ningún camión se movió en estas fechas.',
        cuerpo: 'Ninguna ruta tuvo carga ni venta en la ventana elegida, así que no hay cuenta '
          + 'que cuadrar. No es que dé cero: es que no hay con qué medir.',
      };
    }
    const dias = this.diasDeVenta();
    const cola = dias === null ? '' : ` — unos ${Math.round(dias)} días de venta`;
    // ⛔ Antes decía "la cuenta cierra al centavo contra lo cargado y lo vendido". Con el ancla
    // de `[RD.34]` dejó de ser cierto, y además es lo contrario de lo interesante: lo que el
    // camión trae es lo que él mismo mide, y lo que NO cuadra contra el embarque es el dato.
    // ⚠️ Se dicen las DOS mitades, nunca el neto: se cancelan y el titular quedaria en una
    //    fraccion de lo que de verdad no esta explicado.
    // ⛔ RD.40 — y nunca sin decir cuánto de eso no se puede medir. Antes el titular afirmaba
    //    $309,033 "sin documento" cuando el artefacto de medición explicaba $413,464: la frase
    //    era cierta en aritmética y falsa en significado.
    const entro = this.llegoSinEmbarque();
    const salio = Math.abs(this.salioSinEmbarque());
    const piso = this.pisoSinEmbarque();
    const expuesto = this.expuestoSinMedir();
    const sinMedir = this.rutasSinMedir();
    const cierre = piso === null
      // El servidor no informó la exposición: se dice el bruto y se dice que no se pudo acotar.
      ? `. Sin documento que lo explique: ${this.money(this.brutoSinEmbarque())} en bruto — y no `
        + 'se pudo descontar cuánto de eso lo explica cómo medimos, porque el servidor no informa '
        + 'la exposición. Tomarlo como mercancía perdida sería afirmar de más.'
      : sinMedir > 0
        ? `. Sin documento que lo explique: de ${this.money(this.brutoSinEmbarque())} que no `
          + `cuadran, ${this.money(expuesto as number)} los explica cómo medimos, así que lo que `
          + `se sostiene son ${this.money(piso)} — y en ${sinMedir} de ${this.filas().length} `
          + 'rutas ni eso es medible, porque les falta uno de los dos lados del periodo.'
        : (entro + salio) > 0
          ? `. Sin documento que lo explique: ${this.money(entro)} que llegó y ${this.money(salio)} que salió.`
          : '.';
    const p = `${Math.abs(pct).toFixed(1)} %`;
    const previa = Math.abs(this.totalNeg());
    // Lo que el camion ya traia, dicho SIEMPRE: es la cifra que antes se restaba en silencio.
    // ⛔ RD.43 — decía "vendieron $X de mercancía que ya traían", a secas, y esa cifra sólo
    //    cuenta lo que ASOMÓ como saldo negativo: hoy, UNA ruta. El lector la tomaba como el
    //    total de mercancía previa de la flota, que es la otra —y es 17 veces más grande—.
    const nota = previa > 0
      ? ` Aparte, en ${this.rutasConPrevio()} de ${this.filas().length} rutas asomaron `
        + `${this.money(previa)} de mercancía que ya traían antes de su primer embarque: existió `
        + 'y se cobró, pero nadie la contó, así que se declara y no se resta. En las demás no '
        + 'asoma porque su cuenta arranca donde las dos mitades son observables — lo que traían '
        + 'de antes está en lo no medible, no acá.'
      : '';
    if (pct > 20) {
      return {
        tono: 'mal', icono: 'pi-exclamation-circle',
        titulo: 'Se les está quedando mercancía arriba.',
        cuerpo: `Traen el ${p} de todo lo que se les cargó${cola}${cierre}${nota}`,
      };
    }
    if (pct > 5) {
      return {
        tono: 'aviso', icono: 'pi-info-circle', titulo: 'Se les queda algo arriba.',
        cuerpo: `Traen el ${p} de todo lo que se les cargó${cola}${cierre}${nota}`,
      };
    }
    return {
      tono: 'ok', icono: 'pi-check-circle', titulo: 'Venden casi todo lo que se les carga.',
      cuerpo: `Traen apenas el ${p} de todo lo que se les cargó${cola}${cierre}${nota}`,
    };
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    const inv = this.totalInv();
    const pct = this.pctDeLoCargado();
    const rutas = this.filas().length;
    const conCarga = this.rutasConCargaAyer();
    return [
      /**
       * El orden es el de las preguntas que se hacen en la mañana: qué traen, a qué costo
       * vendieron, qué se les subió ayer y a quién le falta. `currency2` y no `currency-short`:
       * esta pantalla se para en que la cuenta cierra AL CENTAVO, y el formato corto los
       * esconde — `money.util` ya advierte que no va en una celda que alguien vaya a cuadrar.
       */
      {
        label: `Traen hoy ${this.etiquetaMetrica()}`,
        value: inv, format: 'currency2',
        tone: inv < 0 ? 'bad' : 'brand',
        sub: pct === null
          ? 'sin carga con que compararlo'
          : `${Math.abs(pct).toFixed(1)}% de lo cargado · sin restar lo previo`,
      },
      // Es la única cifra ACUMULADA que queda arriba, y lo dice: el resto de la portada es el
      // estado de hoy. El acumulado completo vive en el desglose de cada ruta.
      { label: 'Lo vendido les costó', value: this.totalCogs(), format: 'currency2', tone: 'default',
        sub: 'desde su primera carga, al precio del embarque' },
      {
        /**
         * El KPI que pidió el negocio: cuántos camiones pasan su tope. Reemplaza al de «cargado
         * ayer», que no era la pregunta — el domingo es inhábil y el sábado tampoco cargan, así
         * que daba 0 de 11 y no decía nada.
         */
        label: 'Pasan su tope',
        value: `${this.excedidos()} de ${rutas}`,
        format: 'text',
        tone: this.excedidos() > 0 ? 'bad' : this.masCargado() >= 80 ? 'warn' : 'ok',
        // Cuando nadie lo pasa, el dato util es cuanto le falta al que va adelante.
        sub: this.excedidos() > 0
          ? `${this.money(this.sobreTope())} arriba del tope`
          : `el más cargado va al ${this.masCargado().toFixed(0)}%`,
      },
      /**
       * Tono neutro a propósito: NO es un faltante ni un error. Es mercancía real, vendida y
       * cobrada, de antes del primer embarque. Se declara para que no desaparezca, pero pintarla
       * en rojo la convertiría en una alarma que nadie puede accionar.
       *
       * ⛔ `[RD.43]` — el subtítulo decía sólo «vendido de antes del primer embarque», y en la
       * misma pantalla la declaración dice que lo que ninguna fuente cubre son **$413,464**. Dos
       * cifras del mismo concepto, 17× apartadas, sin nada que las relacione: el lector concluye
       * que la flota traía $24 mil. No es lo mismo —ésta sólo ve lo que **asomó** como saldo
       * negativo, y desde que `[RD.40]` devolvió la ventana al `GREATEST` eso pasó a ocurrir en
       * una sola ruta— pero si no se dice, la cifra chica tapa a la grande.
       */
      { label: 'Traían sin contar', value: this.totalNeg(), format: 'currency2', tone: 'default',
        sub: this.rutasConPrevio() > 0 && this.expuestoSinMedir() !== null
          ? `sólo donde asomó en negativo · ${this.rutasConPrevio()} de ${rutas} rutas — el resto va en lo no medible`
          : 'vendido de antes del primer embarque — no se resta' },
      {
        // El mosaico ya no anuncia si "la cuenta cierra": con el ancla puesta esa igualdad es
        // cierta por construcción y publicarla sería teatro. Lo que sí vale decir es cuánta
        // mercancía llegó sin documento de embarque.
        // RD.40 — el mosaico publica el PISO, no el bruto. Medido el 2026-10-07: el bruto era
        // $301,834 y el artefacto de medición explicaba $413,464 de él. Publicar el bruto
        // afirmaba que faltaban tres pesos donde a lo sumo se puede sostener uno.
        // ⛔ Si el servidor no informó la exposición, el piso NO es calculable y el mosaico
        //    publica el BRUTO diciendo que es el bruto. Antes degeneraba a `piso = bruto` con
        //    la etiqueta del piso encima: la cifra correcta con el rótulo equivocado.
        label: this.pisoSinEmbarque() === null ? 'Sin documento (bruto)' : 'Sin documento',
        value: this.pisoSinEmbarque() ?? this.brutoSinEmbarque(),
        format: 'currency2',
        tone: 'default',
        sub: d?.cuadra === 'sin_medir'
          ? 'ninguna ruta se movió: no hay qué medir'
          : this.pisoSinEmbarque() === null
            ? 'no se pudo descontar lo que explica cómo medimos: el servidor no informa la exposición'
            : this.rutasSinMedir() > 0
              // ⛔ RD.43 — el BRUTO vuelve a decirse. Publicar sólo el piso es correcto pero
              //    deja fuera la cifra que alguien va a querer auditar: de cuánto se descontó.
              //    Sin el minuendo, el descuento es una afirmación sin comprobante.
              ? `de ${this.money(this.brutoSinEmbarque())} que no cuadran, ${this.money(this.expuestoSinMedir() as number)} los explica cómo medimos · ${this.rutasSinMedir()} de ${this.filas().length} rutas sin medir`
              : `${this.money(this.llegoSinEmbarque())} llegó · ${this.money(Math.abs(this.salioSinEmbarque()))} salió`,
      },
    ];
  });

  private diasVentana(): number {
    const d = this.data();
    if (!d) return 1;
    const desde = d.desde === this.TODO
      ? this.filas().reduce(
        (m, r) => (r.carga_desde && r.carga_desde < m ? r.carga_desde : m), '9999-12-31')
      : d.desde;
    if (!desde || desde === '9999-12-31') return 1;
    const ms = Date.parse(d.hasta) - Date.parse(desde);
    return Math.max(1, Math.round(ms / 86400000));
  }

  private rangoIso(): [string | undefined, string | undefined] {
    const r = this.rango;
    if (!r || !r[0]) return [undefined, undefined];
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [iso(r[0]), r[1] ? iso(r[1]) : iso(r[0])];
  }
}
