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
      <h1>Inventario de ruta</h1>
      <p class="ir-sub">
        Lo que trae cada camión, reconstruido del embarque de su sucursal menos lo que vendió.
        Kepler no guarda el saldo de una ruta: guarda los papeles.
      </p>
    </div>
    <app-context-help topic="inventario-de-ruta" />
  </header>

  <app-page-tabs [tabs]="tabs" />

  <section class="ir-bar">
    <div class="ir-bar-l">
      <p-datepicker [(ngModel)]="rango" selectionMode="range" dateFormat="dd/mm/yy"
                    placeholder="Toda la ventana" [readonlyInput]="true" [showClear]="true"
                    [showIcon]="true" appendTo="body" />
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
                  emptyTitle="Ninguna ruta con movimiento en este periodo"
                  emptyHint="Probá con «Toda la ventana»: la carga documentada arranca el 15-jul en Padre Hidalgo y el 14-ago en Canindo."
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
          {{ d.desde === TODO ? 'desde la primera carga de cada una' : d.desde + ' → ' + d.hasta }} ·
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
                 size="small" [rowHover]="true" [tableStyle]="{ 'min-width': '70rem' }">
          <ng-template #header>
            <tr>
              <th>Ruta</th>
              <th>Plaza</th>
              <th class="num">Cargado</th>
              <th class="num">{{ metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente' }}</th>
              <th class="num">Inventario</th>
              <th class="num">A favor</th>
              <th class="num">En contra</th>
              <th class="num">Días</th>
              <th class="num">Sin mover</th>
              <th class="num">Δ</th>
              <th class="num"><span class="ir-sr">Detalle</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr [class.ir-fila-mal]="!cierra(r)" [class.ir-fila-parada]="parada(r)">
              <td class="dt-id ir-mono" role="cell"><strong>{{ r.route_no }}</strong></td>
              <td class="ir-tenue" role="cell" data-label="Plaza">{{ r.plaza }}</td>
              <td class="num ir-mono" role="cell" data-label="Cargado">{{ carga(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="num ir-mono" role="cell"
                  [attr.data-label]="metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente'">{{ vendido(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="num ir-mono ir-fuerte" role="cell" data-label="Inventario">{{ inv(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="num ir-mono ir-ok" role="cell" data-label="A favor">{{ invPos(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="num ir-mono ir-bad" role="cell" data-label="En contra">{{ invNeg(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="num ir-mono ir-tenue" role="cell" data-label="Días de venta">
                @if (dias(r) === null) { <span title="No vendió nada en el periodo: no hay con qué dividir">—</span> }
                @else { {{ dias(r) | number:'1.0-0' }} }
              </td>
              <td class="num ir-mono" role="cell" data-label="Días sin mover"
                  [class.ir-bad]="parada(r)">
                @if (sinMover(r) === null) { <span class="ir-tenue">—</span> }
                @else { {{ sinMover(r) }} }
              </td>
              <td class="num ir-mono" role="cell" data-label="Δ del cuadre">
                @if (cierra(r)) { <span class="ir-tenue">0</span> }
                @else { <strong class="ir-bad">{{ delta(r) | number:'1.2-2' }}</strong> }
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
            <strong>El ERP tiene su propio costo, y no es éste.</strong>
            Para las rutas de Padre Hidalgo, Kepler guarda además un costo en cada línea de venta:
            <strong>{{ totalCogsErp() | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong> contra los
            {{ totalVendido() | currency:'MXN':'symbol-narrow':'1.2-2' }} del embarque.
            <strong>No se suman</strong> — miden cosas distintas.
          </span>
        </p>
      }

      <section class="ir-declara">
        <p><i class="pi pi-info-circle" aria-hidden="true"></i> {{ d.declara.sin_ancla }}</p>
        <p><i class="pi pi-info-circle" aria-hidden="true"></i> {{ d.declara.fuera_de_alcance }}</p>
      </section>
    }
  </app-load-state>

  <app-side-peek [(open)]="detalleAbierto" [width]="860"
                 [title]="'Ruta ' + (rutaSel()?.route_no ?? '')"
                 [subtitle]="subtituloDetalle()">
    <div class="ir-tabs" role="tablist" aria-label="Detalle de la ruta">
      @for (t of PESTANAS; track t.value) {
        <button type="button" role="tab" [attr.aria-selected]="pestana() === t.value"
                [class.on]="pestana() === t.value" (click)="setPestana(t.value)">{{ t.label }}</button>
      }
    </div>

    @switch (pestana()) {
      @case ('productos') {
        <app-load-state [loading]="detalle() === null && !errorDetalle()" [error]="errorDetalle()"
                        [isEmpty]="detalle()?.rows?.length === 0" [skeletonRows]="8"
                        emptyIcon="pi-box" emptyTitle="Sin productos en este periodo"
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
                <tr><th>SKU</th><th>Producto</th><th>Un.</th><th class="num">Cargado</th>
                  <th class="num">Vendido</th><th class="num">Saldo</th>
                  <th class="num">{{ etiquetaMetrica() }}</th><th></th></tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td class="dt-id ir-mono" role="cell">{{ f.sku }}</td>
                  <td role="cell" data-label="Producto">{{ f.producto }}</td>
                  <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ f.unidad }}</td>
                  <td class="num ir-mono" role="cell" data-label="Cargado">{{ f.qty_carga | number:'1.0-2' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Vendido">{{ f.qty_venta | number:'1.0-2' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Saldo" [class.ir-bad]="f.saldo < 0">
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
                        emptyIcon="pi-chart-line" emptyTitle="Sin movimiento en este periodo"
                        (retry)="pedirSerie()">
          <p class="ir-nota">
            Cada día, lo que se le cargó contra lo que vendió, y el <strong>saldo acumulado</strong>
            al cierre. El día en que ese acumulado cruza a negativo es el día en que la ruta empezó
            a vender lo que ya traía.
          </p>
          <div class="dt-scope">
            <p-table [value]="serie() ?? []" [scrollable]="true" scrollHeight="52vh"
                     class="dt-stack surf-table surf-table--sticky" size="small" [rowHover]="true"
                     [tableStyle]="{ 'min-width': '42rem' }">
              <ng-template #header>
                <tr><th>Día</th><th class="num">Cargado</th><th class="num">Vendido</th>
                  <th>Proporción</th><th class="num">Saldo acum. (uds)</th></tr>
              </ng-template>
              <ng-template #body let-p>
                <tr>
                  <td class="dt-id ir-mono" role="cell">{{ p.fecha }}</td>
                  <td class="num ir-mono" role="cell" data-label="Cargado">{{ p.cargado | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="num ir-mono" role="cell" data-label="Vendido">{{ p.vendido | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td role="cell" data-label="Proporción">
                    <span class="ir-barra" [title]="'Cargado ' + (p.cargado | number:'1.0-0')">
                      <i class="ir-b-carga" [style.width.%]="pct(p.cargado)"></i>
                      <i class="ir-b-venta" [style.width.%]="pct(p.vendido)"></i>
                    </span>
                  </td>
                  <td class="num ir-mono" role="cell" data-label="Saldo acumulado"
                      [class.ir-bad]="p.saldo_qty_acum < 0">{{ p.saldo_qty_acum | number:'1.0-0' }}</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        </app-load-state>
      }

      @case ('traspasos') {
        <app-load-state [loading]="embarques() === null && !errorTab()" [error]="errorTab()"
                        [isEmpty]="embarques()?.length === 0" [skeletonRows]="8"
                        emptyIcon="pi-truck" emptyTitle="Sin embarques en este periodo"
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
                            [skeletonRows]="6" emptyIcon="pi-box" emptyTitle="Embarque sin líneas">
              <div class="dt-scope">
                <p-table [value]="lineas() ?? []" [scrollable]="true" scrollHeight="48vh"
                         class="dt-stack surf-table" size="small" [rowHover]="true"
                         [tableStyle]="{ 'min-width': '44rem' }">
                  <ng-template #header>
                    <tr><th>SKU</th><th>Producto</th><th>Un.</th><th class="num">Cantidad</th>
                      <th class="num">Costo unitario</th><th class="num">Importe</th><th></th></tr>
                  </ng-template>
                  <ng-template #body let-l>
                    <tr>
                      <td class="dt-id ir-mono" role="cell">{{ l.sku }}</td>
                      <td role="cell" data-label="Producto">{{ l.producto }}</td>
                      <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ l.unidad }}</td>
                      <td class="num ir-mono" role="cell" data-label="Cantidad">{{ l.qty | number:'1.0-2' }}</td>
                      <td class="num ir-mono" role="cell" data-label="Costo unitario">{{ l.costo_unitario | currency:'MXN':'symbol-narrow':'1.2-4' }}</td>
                      <td class="num ir-mono" role="cell" data-label="Importe">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
                  <tr><th>Fecha</th><th>Folio</th><th class="num">Líneas</th>
                    <th class="num">Unidades</th><th class="num">Importe</th><th class="num"></th></tr>
                </ng-template>
                <ng-template #body let-e>
                  <tr>
                    <td class="dt-id ir-mono" role="cell">{{ e.fecha }}</td>
                    <td class="ir-mono" role="cell" data-label="Folio">{{ e.folio }}</td>
                    <td class="num ir-mono ir-tenue" role="cell" data-label="Líneas">{{ e.lineas }}</td>
                    <td class="num ir-mono ir-tenue" role="cell" data-label="Unidades">{{ e.unidades | number:'1.0-0' }}</td>
                    <td class="num ir-mono ir-fuerte" role="cell" data-label="Importe">{{ e.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
                        emptyIcon="pi-check-circle" emptyTitle="Esta ruta no tiene números rojos"
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
                <tr><th>SKU</th><th>Producto</th><th>Un.</th><th class="num">Saldo</th>
                  <th>Familia</th><th>Desde</th><th class="num">Días</th><th class="num">A costo</th></tr>
              </ng-template>
              <ng-template #body let-n>
                <tr>
                  <td class="dt-id ir-mono" role="cell">{{ n.sku }}</td>
                  <td role="cell" data-label="Producto">{{ n.producto }}</td>
                  <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ n.unidad }}</td>
                  <td class="num ir-mono ir-bad" role="cell" data-label="Saldo"><strong>{{ n.saldo | number:'1.0-2' }}</strong></td>
                  <td role="cell" data-label="Familia">
                    <p-tag [value]="n.familia === 'se_acabo' ? 'se le acabó' : 'ya lo traía'"
                           [severity]="n.familia === 'se_acabo' ? 'danger' : 'secondary'" />
                  </td>
                  <td class="ir-mono ir-tenue" role="cell" data-label="Desde">{{ n.desde ?? '—' }}</td>
                  <td class="num ir-mono ir-tenue" role="cell" data-label="Días en rojo">{{ n.dias_en_rojo ?? '—' }}</td>
                  <td class="num ir-mono" role="cell" data-label="A costo">
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
    .ir-fila-mal { background: var(--bad-soft-bg); }
    .ir-fila-parada td { opacity: .72; }

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
    { label: 'A costo', value: 'costo' },
    { label: 'A venta', value: 'venta' },
  ];
  readonly PESTANAS: { label: string; value: Pestana }[] = [
    { label: 'Productos', value: 'productos' },
    { label: 'Movimiento', value: 'movimiento' },
    { label: 'Traspasos', value: 'traspasos' },
    { label: 'En contra', value: 'rojos' },
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
    if (f && t) this.rango = [new Date(f + 'T12:00:00'), new Date(t + 'T12:00:00')];
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
    this.pedirPestana();
  }

  setPestana(p: Pestana): void { this.pestana.set(p); this.embarqueSel.set(null); this.pedirPestana(); }

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
  pct(v: number): number {
    const max = Math.max(1, ...(this.serie() ?? []).flatMap((p) => [p.cargado, p.vendido]));
    return Math.max(1, Math.round((Number(v) || 0) / max * 100));
  }

  // ── Lecturas por valuación. Las dos columnas NUNCA se mezclan. ──
  carga = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.carga_costo : r.carga_venta;
  vendido = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.cogs_costo : r.venta_cliente;
  inv = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo : r.inventario_venta;
  invPos = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_pos : r.inventario_venta_pos;
  invNeg = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_neg : r.inventario_venta_neg;
  delta = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.delta_costo : r.delta_venta;
  cierra = (r: RouteInventoryRow) => Math.abs(Number(this.delta(r)) || 0) < 0.01;

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

  etiquetaMetrica(): string { return this.metrica() === 'costo' ? 'a costo' : 'a venta'; }

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
  readonly totalCogsErp = computed(() => this.suma((r) => Number(r.cogs_erp) || 0));
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
    if (d?.cuadra === 'no_cierra') {
      return {
        tono: 'mal', icono: 'pi-times-circle', titulo: 'La cuenta NO cierra.',
        cuerpo: 'Alguna fila se valuó con dos varas distintas: el resto de la pantalla no se '
          + 'puede usar hasta resolverlo. Mirá la columna Δ.',
      };
    }
    const pct = this.pctDeLoCargado();
    if (d?.cuadra === 'sin_medir' || pct === null) {
      return {
        tono: 'neutro', icono: 'pi-minus-circle', titulo: 'Sin movimiento en este periodo.',
        cuerpo: 'Ninguna ruta tuvo carga ni venta en la ventana elegida, así que no hay cuenta '
          + 'que cuadrar. No es que dé cero: es que no hay con qué medir.',
      };
    }
    const dias = this.diasDeVenta();
    const cola = dias === null ? '' : ` — unos ${Math.round(dias)} días de venta`;
    const cierre = '. La cuenta cierra: cargado − vendido = inventario.';
    const p = `${Math.abs(pct).toFixed(1)} %`;
    if (pct < -5) {
      return {
        tono: 'aviso', icono: 'pi-arrow-circle-down',
        titulo: 'Los camiones están vendiendo lo que ya traían.',
        cuerpo: `Vendieron ${p} más de lo que se les cargó${cola}. Es mercancía anterior al primer `
          + `embarque documentado: sin conteo inicial, no se puede saber cuánta queda${cierre}`,
      };
    }
    if (pct > 20) {
      return {
        tono: 'mal', icono: 'pi-exclamation-circle', titulo: 'Los camiones están acumulando.',
        cuerpo: `Lo que queda arriba es el ${p} de todo lo que se les cargó${cola}${cierre}`,
      };
    }
    if (pct > 5) {
      return {
        tono: 'aviso', icono: 'pi-info-circle', titulo: 'Los camiones acumulan algo.',
        cuerpo: `Lo que queda arriba es el ${p} de todo lo que se les cargó${cola}${cierre}`,
      };
    }
    return {
      tono: 'ok', icono: 'pi-check-circle', titulo: 'Los camiones no acumulan.',
      cuerpo: `Lo que queda arriba es el ${p} de todo lo que se les cargó${cola}${cierre}`,
    };
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    const inv = this.totalInv();
    const pct = this.pctDeLoCargado();
    return [
      {
        label: `Inventario ${this.etiquetaMetrica()}`,
        value: inv, format: 'currency-short',
        tone: inv < 0 ? 'bad' : 'brand',
        sub: pct === null ? 'sin base para comparar' : `${Math.abs(pct).toFixed(1)}% de lo cargado`,
      },
      { label: 'A favor', value: this.totalPos(), format: 'currency-short', tone: 'ok',
        sub: 'sigue arriba del camión' },
      { label: 'En contra', value: this.totalNeg(), format: 'currency-short', tone: 'bad',
        sub: 'ya lo traía de antes' },
      { label: 'Cargado', value: this.totalCarga(), format: 'currency-short', tone: 'default',
        sub: `${this.diasVentana()} días` },
      {
        label: 'Cuadre',
        value: d?.cuadra === 'no_cierra' ? 'NO cierra' : d?.cuadra === 'cierra' ? 'Cierra' : 'Sin medir',
        format: 'text',
        tone: d?.cuadra === 'no_cierra' ? 'bad' : d?.cuadra === 'cierra' ? 'ok' : 'default',
        sub: d?.cuadra === 'sin_medir' ? 'no hubo movimiento' : 'cargado − vendido = inventario',
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
