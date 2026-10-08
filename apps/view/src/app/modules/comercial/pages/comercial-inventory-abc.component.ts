import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  ComercialService, AbcRow, AbcListResult, AbcSummary, CycleDueResult, CountSelectionResult, CountSelectionItem, CountSelectionDetail, Warehouse,
} from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';

/**
 * Fase ABC.3b — Conteo cíclico (ABC). Surface Operations (DESIGN.md):
 * page-head Hanken bold, KPI strip + tabla densa como organismos, in-page sin sombra,
 * p-tag [severity] mapeado a tokens, tabular-nums en cifras, acción=sunset / ghost.
 *
 * Dos vistas de la misma data: AGENDA (qué toca contar, cycle-due, accionable) y
 * CLASIFICACIÓN (ABC por valor de consumo). Acciones: recalcular ABC + generar folios.
 */
@Component({
  selector: 'app-comercial-inventory-abc',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, SelectButtonModule, ToastModule, ConfirmDialogModule, TooltipModule, MetricCardComponent, ProductSearchComponent, SucursalPipe],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>


      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Conteo cíclico</h1>
          <p class="surf-page-sub">Clasificá por valor (ABC) y contá lo que toca — control continuo</p>
        </div>
        <div class="abc-head-actions">
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseFilter" optionLabel="label" optionValue="value"
                    (onChange)="load()" styleClass="abc-wh" ariaLabel="Filtrar por almacén"></p-select>
          <p-select [options]="clases" [(ngModel)]="claseFiltro" optionLabel="label" optionValue="value"
                    (onChange)="load()" styleClass="abc-cls" ariaLabel="Filtrar por clase"></p-select>
          <app-product-search (productSelected)="prodFilter.set($event)"></app-product-search>
          <button pButton type="button" [text]="true" severity="secondary" size="small" (click)="recalc()" [loading]="working()"><span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span><span class="p-button-label">Recalcular ABC</span></button>
          <button pButton type="button" size="small" (click)="confirmGenerate()" [loading]="working()" [disabled]="!isSpecific()" [pTooltip]="isSpecific() ? '' : 'Seleccioná un almacén para generar su folio cíclico'"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Generar folios</span></button>
        </div>
      </header>

      <!-- KPI BENTO: variedad por tipo de dato (DESIGN §9) -->
      <div class="surf-grid abc-bento">
        <app-metric-card class="panel-col-4"
          label="Por contar ahora" [value]="due()?.count ?? 0" format="number"
          accent="var(--action)"
          [variant]="dueSum() > 0 ? 'bars' : 'plain'"
          [series]="dueByClass()" [seriesLabels]="abcLabels" [highlightLast]="false"
          [sub]="'A ' + (due()?.by_class?.A ?? 0) + ' · B ' + (due()?.by_class?.B ?? 0) + ' · C ' + (due()?.by_class?.C ?? 0)"></app-metric-card>

        <app-metric-card class="panel-col-4"
          label="Valor clasificado (costo/año)" [value]="summary()?.total_value ?? 0" format="currency"
          accent="var(--chart-2)"
          [sub]="(summary()?.total_count ?? 0) + ' SKUs · ' + computedLabel()"></app-metric-card>

        <!-- Distribución ABC: breakdown segmentado (color semántico por clase) -->
        <article class="panel-col-4 abc-dist-card">
          <span class="abc-dist-label">Distribución ABC</span>
          <div class="abc-dist-bar" role="img" [attr.aria-label]="distAria()">
            @if (total() > 0) {
              <div class="abc-dist-seg abc-a" [style.flexBasis.%]="pct('A')" [title]="'A: ' + classCount('A')"></div>
              <div class="abc-dist-seg abc-b" [style.flexBasis.%]="pct('B')" [title]="'B: ' + classCount('B')"></div>
              <div class="abc-dist-seg abc-c" [style.flexBasis.%]="pct('C')" [title]="'C: ' + classCount('C')"></div>
            }
          </div>
          <div class="abc-dist-foot">
            <span class="abc-dot abc-a"></span>A {{ classCount('A') }}
            <span class="abc-dot abc-b"></span>B {{ classCount('B') }}
            <span class="abc-dot abc-c"></span>C {{ classCount('C') }}
          </div>
        </article>
      </div>

      <!-- Toggle de vista -->
      <p-selectbutton [options]="views" [(ngModel)]="view" optionLabel="label" optionValue="value"
                      [allowEmpty]="false" styleClass="abc-views sb-liquid" ariaLabel="Cambiar vista"></p-selectbutton>

      <!-- [ABC.6] EL CRITERIO, en pantalla. La letra sin su regla no se puede discutir: quien
           mira la tabla no tenia como saber por que un SKU es A y el de al lado es C. -->
      @if (criterio(); as cr) {
        <p class="abc-criterio">
          <b>Como se decide la clase:</b> {{ cr.metrica }}, sobre los ultimos {{ cr.ventana_dias }} dias.
          {{ cr.corte }}. Se cuenta cada <b>A {{ cr.cadencia_dias.A }} d</b> &middot;
          <b>B {{ cr.cadencia_dias.B }} d</b> &middot; <b>C {{ cr.cadencia_dias.C }} d</b>.
          <span class="abc-criterio-src">Demanda: {{ cr.demanda }} &mdash; Costo: {{ cr.costo }}</span>
        </p>
      }

      <!-- El recorte se DECLARA: una pagina recortada y un universo chico se leen igual. -->
      @if (view() === 'due' && due()?.truncado) {
        <p class="abc-trunc">
          Se muestran <b>{{ due()?.mostradas }}</b> de <b>{{ due()?.count }}</b> pendientes.
          Filtra por almacen o por clase para ver el resto &mdash; la lista corta en {{ due()?.limit }}.
        </p>
      }
      @if (view() !== 'due' && lista()?.truncado) {
        <p class="abc-trunc">
          Se muestran <b>{{ lista()?.mostradas }}</b> de <b>{{ lista()?.total }}</b> SKUs clasificados.
        </p>
      }

      @if (view() === 'seleccion') {
        <!-- [IC.24] LA SELECCION DEL CONTEO, con el porque de cada producto. -->
        @if (sel(); as s) {
          <!-- El ESFUERZO y la COBERTURA primero: son las dos cifras que deciden si la lista
               de abajo es razonable, y verlas despues de 25 renglones es verlas tarde. -->
          <div class="sel-cab">
            <div class="sel-kpi">
              <span class="sel-kpi-n">{{ s.esfuerzo.skus }}</span>
              <span class="sel-kpi-l">productos</span>
            </div>
            <div class="sel-kpi">
              <span class="sel-kpi-n">{{ s.esfuerzo.piezas | number }}</span>
              <span class="sel-kpi-l">piezas a contar</span>
            </div>
            <div class="sel-kpi">
              <span class="sel-kpi-n">{{ s.cobertura.pct ?? '—' }}<small>%</small></span>
              <span class="sel-kpi-l">del dinero que se mueve al dia</span>
            </div>
            <div class="sel-kpi sel-kpi-nm">
              <span class="sel-kpi-n">no medido</span>
              <span class="sel-kpi-l">tiempo: piezas por hora por persona no existe todavia</span>
            </div>
          </div>
          <p class="abc-criterio">
            <b>Como se eligen:</b> {{ s.criterio.orden }}, sobre {{ s.criterio.motor }}.
            @if (s.criterio.filtro_velocidad) { Filtro: {{ s.criterio.filtro_velocidad }}. }
            {{ s.criterio.cupo }}.
            <br><b>Por que no el score de prioridad:</b> {{ s.criterio.por_que_no_el_score }}.
          </p>
        }
        <div class="sel-split">
          <div class="dt-scope sel-lista">
          <p-table [value]="selItems()" [loading]="loading()" styleClass="p-datatable-sm surf-table dt-stack"
                   selectionMode="single" [(selection)]="selFila" (onRowSelect)="abrirDetalle($event.data)"
                   [scrollable]="true" scrollHeight="flex">
            <ng-template #header>
              <tr>
                <th scope="col">SKU</th><th scope="col">Producto</th>
                <th scope="col" class="abc-num">$ / dia</th>
                <th scope="col" class="abc-num">Piezas</th>
                <th scope="col" class="abc-num">Dias cob.</th>
                <th scope="col">Clase</th><th scope="col">Lugar</th><th scope="col">Ultimo conteo</th>
              </tr>
            </ng-template>
            <ng-template #body let-it>
              <tr [pSelectableRow]="it" [class.sel-activa]="detalleDe()?.product_id === it.product_id">
                <td data-label="SKU"><code>{{ it.sku }}</code></td>
                <td data-label="Producto">
                  {{ it.nombre }}
                  @if (it.location) { <small class="sel-ubi">{{ it.location }}</small> }
                </td>
                <td data-label="$ / dia" class="abc-num"><b>{{ it.cogs_dia | number:'1.0-0' }}</b></td>
                <td data-label="Piezas" class="abc-num">{{ it.on_hand | number:'1.0-0' }}</td>
                <td data-label="Dias cob." class="abc-num">
                  @if (it.cobertura_confiable) { {{ it.days_cover | number:'1.0-0' }} }
                  @else { <span class="sel-nm" pTooltip="Existencia y demanda pueden venir en peldanos distintos: la cobertura no se puede afirmar">sin medir</span> }
                </td>
                <td data-label="Clase">
                  <p-tag [value]="it.abc_class ?? '—'" [severity]="sevClase(it.abc_class)"></p-tag>
                  @if (it.tiene_testigo === false) {
                    <i class="pi pi-exclamation-triangle sel-flojo"
                       pTooltip="El costo que sostiene esta letra no tiene testigo de compra"></i>
                  }
                </td>
                <td data-label="Lugar">
                  @if (it.rango_almacen) {
                    <small>{{ it.rango_almacen | number }} de {{ it.skus_en_almacen | number }}</small>
                  } @else { — }
                </td>
                <td data-label="Ultimo conteo">
                  @if (it.last_counted_at) {
                    {{ it.last_counted_at | date:'dd/MM/yy' }}
                    <small class="sel-fuente">{{ it.reloj_fuente === 'kepler' ? 'Kepler' : 'folio propio' }}</small>
                  } @else {
                    <span class="sel-nunca">nunca contado</span>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="8">
                <div class="comm-empty">
                  <span class="comm-empty-icon"><i class="pi pi-inbox"></i></span>
                  <h3>Sin seleccion</h3>
                  <p>Elegi un almacen. Si no hay filas, ese almacen no tiene venta con costo en los ultimos 30 dias.</p>
                </div>
              </td></tr>
            </ng-template>
          </p-table>
          </div>

          <!-- EL DETALLE: el porque profundo. Vive aparte porque sus dos fuentes cuestan
               589 ms y 346 ms y no bajan al filtrar por producto. -->
          <aside class="sel-detalle">
            @if (detalleDe(); as d) {
              <h3>{{ d.sku }} <small>{{ d.nombre }}</small></h3>
              <dl class="sel-dl">
                <dt>Mueve</dt><dd><b>{{ d.cogs_dia | number:'1.0-0' }}</b> pesos de costo por dia</dd>
                <dt>Aporta</dt>
                <dd>
                  @if (d.aporte_individual != null) {
                    {{ d.aporte_individual * 100 | number:'1.0-3' }}% del valor del almacen
                  } @else { <span class="sel-nm">sin medir</span> }
                </dd>
                <dt>Sobre el piso de su clase</dt>
                <dd>
                  @if (d.distancia_al_corte != null) { {{ d.distancia_al_corte | number:'1.0-0' }} pesos }
                  @else { <span class="sel-nm">sin medir</span> }
                </dd>
              </dl>
              @if (detalle(); as det) {
                @if (det.capital; as cap) {
                  <h4>Capital parado</h4>
                  <dl class="sel-dl">
                    <dt>En piso</dt><dd><b>{{ cap.capital | number:'1.0-0' }}</b> pesos (clase {{ cap.capital_class }})</dd>
                    <dt>Costo</dt>
                    <dd>
                      {{ cap.costo_unitario | number:'1.2-2' }} / pieza
                      <small>{{ cap.costo_source }}</small>
                      @if (cap.costo_veredicto && cap.costo_veredicto !== 'confirmado') {
                        <p-tag [value]="cap.costo_veredicto" severity="warn"></p-tag>
                      }
                    </dd>
                  </dl>
                } @else {
                  <p class="sel-nm">Capital sin medir: {{ det.sin_capital_motivo }}</p>
                }
                <h4>Historia de conteos</h4>
                @if (det.sin_historia) {
                  <p class="sel-nm">Nunca se conto. No es lo mismo que cuadrar: es que no hay dato.</p>
                } @else {
                  @for (ev of det.eventos; track ev.fecha) {
                    <div class="sel-ev">
                      <div class="sel-ev-top">
                        <span>{{ ev.fecha | date:'dd/MM/yy' }}</span>
                        <p-tag [value]="ev.patron ?? 'sin patron'" [severity]="sevPatron(ev.patron)"></p-tag>
                      </div>
                      <div class="sel-ev-n">
                        {{ ev.importe_evento | number:'1.0-0' }} pesos
                        @if (ev.cantidad_evento != null) {
                          <small>{{ ev.cantidad_evento | number:'1.0-2' }} {{ ev.unidad_erp }}</small>
                        }
                      </div>
                      @if (ev.explicacion) {
                        <p class="sel-ev-exp"><i class="pi pi-info-circle"></i> {{ ev.explicacion }}</p>
                      }
                    </div>
                  }
                }
              } @else {
                <p class="sel-nm">Cargando el porque…</p>
              }
            } @else {
              <div class="comm-empty">
                <span class="comm-empty-icon"><i class="pi pi-hand-point-left"></i></span>
                <h3>Elegi un producto</h3>
                <p>La ficha muestra su capital, su historia de conteos y por que un descuadre pudo no ser merma.</p>
              </div>
            }
          </aside>
        </div>
      } @else if (view() === 'due') {
        <!-- AGENDA: qué toca contar -->
        <!-- [UIM.6] Las diez columnas son CAMPOS de un renglón (clase, SKU, producto, almacén,
             valor, fecha, cadencia, estado), así que apilar es lo correcto: el .dt-scope va en el
             contenedor porque un elemento no puede ser su propio container-query. -->
        <div class="dt-scope">
        <p-table [value]="dueItems()" [loading]="loading()" styleClass="p-datatable-sm surf-table dt-stack"
                 [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100, 200]">
          <ng-template #header>
            <tr>
              <th scope="col">Clase</th><th scope="col">Por que</th><th scope="col">SKU</th>
              <th scope="col">Producto</th><th scope="col">Almacén</th>
              <th scope="col" class="abc-num">Valor anual</th><th scope="col" class="abc-num">% del almacén</th>
              <th scope="col">Último conteo</th><th scope="col" class="abc-num">Cadencia</th><th scope="col">Estado</th>
            </tr>
          </ng-template>
          <ng-template #body let-it>
            <tr>
              <td role="cell" data-label="Clase"><p-tag [value]="it.abc_class" [severity]="classSeverity(it.abc_class)"></p-tag></td>
              <td role="cell" data-label="Por que"><p-tag [value]="motivoLabel(it)" [severity]="motivoSeverity(it)"
                         [pTooltip]="motivoTooltip(it)"></p-tag></td>
              <td class="abc-mono" role="cell" data-label="SKU">{{ it.sku || '—' }}</td>
              <td class="abc-name dt-id" role="cell">{{ it.product_name || '—' }}</td>
              <td class="abc-mono" role="cell" data-label="Almacén">{{ it.warehouse_code | sucursal }}</td>
              <!-- Guion, no $0: un valor cero por falta de demanda NO es un valor de cero. -->
              <td class="abc-num dt-num" role="cell" data-label="Valor anual">
                @if (+it.annual_value > 0) { {{ it.annual_value | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                @else { <span class="abc-nd" pTooltip="Sin demanda medida en la ventana: no es valor cero, es no medido">&mdash;</span> }
              </td>
              <td class="abc-num dt-num" role="cell" data-label="% del almacén">
                @if (+(it.value_share || 0) > 0) { {{ (+(it.value_share || 0) * 100) | number:'1.0-2' }}% }
                @else { <span class="abc-nd">&mdash;</span> }
              </td>
              <td class="abc-mono" role="cell" data-label="Último conteo">{{ it.last_counted_at ? (it.last_counted_at | date:'dd/MM/yy') : 'Nunca' }}</td>
              <td class="abc-num dt-num" role="cell" data-label="Cadencia">{{ it.cadence_days }} d</td>
              <td role="cell" data-label="Estado"><p-tag [value]="dueLabel(it)" [severity]="dueSeverity(it)"></p-tag></td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="10" class="comm-empty-cell">
              <div class="comm-empty">
                <span class="comm-empty-icon"><i class="pi pi-check-circle"></i></span>
                <h3>Nada pendiente de contar</h3>
                <p>Si no clasificaste aún, usá <b>Recalcular ABC</b>; el conteo se agenda por cadencia (A 30d · B 90d · C 365d).</p>
              </div>
            </td></tr>
          </ng-template>
        </p-table>
        </div>
      } @else {
        <!-- CLASIFICACIÓN ABC -->
        <div class="dt-scope">
        <p-table [value]="classRows()" [loading]="loading()" styleClass="p-datatable-sm surf-table dt-stack"
                 [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100, 200]">
          <ng-template #header>
            <tr>
              <th scope="col">Clase</th><th scope="col">Por que</th><th scope="col">SKU</th>
              <th scope="col">Producto</th><th scope="col">Almacén</th>
              <th scope="col" class="abc-num">Valor anual</th><th scope="col" class="abc-num">Unidades</th><th scope="col" class="abc-num">% acum.</th>
            </tr>
          </ng-template>
          <ng-template #body let-it>
            <tr>
              <td role="cell" data-label="Clase"><p-tag [value]="it.abc_class" [severity]="classSeverity(it.abc_class)"></p-tag></td>
              <td role="cell" data-label="Por que"><p-tag [value]="motivoLabel(it)" [severity]="motivoSeverity(it)"
                         [pTooltip]="motivoTooltip(it)"></p-tag></td>
              <td class="abc-mono" role="cell" data-label="SKU">{{ it.sku || '—' }}</td>
              <td class="abc-name dt-id" role="cell">{{ it.product_name || '—' }}</td>
              <td class="abc-mono" role="cell" data-label="Almacén">{{ it.warehouse_code | sucursal }}</td>
              <td class="abc-num dt-num" role="cell" data-label="Valor anual">
                @if (+it.annual_value > 0) { {{ it.annual_value | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                @else { <span class="abc-nd" pTooltip="Sin demanda medida: no es valor cero, es no medido">&mdash;</span> }
              </td>
              <td class="abc-num dt-num" role="cell" data-label="Unidades">{{ it.units_window }}</td>
              <td class="abc-num dt-num" role="cell" data-label="% acum.">{{ (+it.value_share * 100) | number:'1.0-1' }}%</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="8" class="comm-empty-cell">
              <div class="comm-empty">
                <span class="comm-empty-icon"><i class="pi pi-sort-amount-down"></i></span>
                <h3>Sin clasificación ABC</h3>
                <p>Corré <b>Recalcular ABC</b> para clasificar por valor de consumo (ventas 90d × costo).</p>
              </div>
            </td></tr>
          </ng-template>
        </p-table>
        </div>
      }
    </div>
  `,
  styles: [`
    /* [IC.24] La seleccion del conteo: maestro-detalle. */
    .sel-cab { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
               gap: .75rem; margin-bottom: .75rem; }
    .sel-kpi { background: var(--surface-2); border: 1px solid var(--border);
               border-radius: var(--radius-md); padding: .6rem .75rem; }
    .sel-kpi-n { display: block; font-size: 1.5rem; font-weight: 700; line-height: 1.1; }
    .sel-kpi-n small { font-size: .9rem; opacity: .7; }
    .sel-kpi-l { display: block; font-size: .72rem; opacity: .7; margin-top: .15rem; }
    /* Lo NO MEDIDO se ve distinto de un numero: si se pintara igual, se leeria como una cifra. */
    .sel-kpi-nm { border-style: dashed; }
    .sel-kpi-nm .sel-kpi-n { font-size: 1rem; font-weight: 600; opacity: .65; font-style: italic; }
    .sel-split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1rem;
                 align-items: start; }
    @media (max-width: 1100px) { .sel-split { grid-template-columns: 1fr; } }
    .sel-lista { min-width: 0; }
    .sel-detalle { background: var(--surface-2); border: 1px solid var(--border);
                   border-radius: var(--radius-md); padding: .9rem; position: sticky; top: .5rem;
                   max-height: calc(100vh - 7rem); overflow: auto; }
    .sel-detalle h3 { margin: 0 0 .6rem; font-size: 1rem; }
    .sel-detalle h3 small { display: block; font-weight: 400; opacity: .75; font-size: .8rem; }
    .sel-detalle h4 { margin: 1rem 0 .4rem; font-size: .8rem; text-transform: uppercase;
                      letter-spacing: .04em; opacity: .7; }
    .sel-dl { display: grid; grid-template-columns: auto 1fr; gap: .25rem .6rem; margin: 0;
              font-size: .82rem; }
    .sel-dl dt { opacity: .7; }
    .sel-dl dd { margin: 0; }
    .sel-dl dd small { display: block; opacity: .6; font-size: .72rem; }
    .sel-ev { border-left: 3px solid var(--border); padding: .4rem .6rem; margin-bottom: .5rem; }
    .sel-ev-top { display: flex; justify-content: space-between; align-items: center;
                  font-size: .76rem; opacity: .8; }
    .sel-ev-n { font-weight: 600; font-size: .9rem; }
    .sel-ev-n small { font-weight: 400; opacity: .65; margin-left: .35rem; }
    .sel-ev-exp { margin: .3rem 0 0; font-size: .75rem; opacity: .8; }
    /* Las dos ausencias se ven distinto de un dato, y distinto entre si (ADR-056). */
    .sel-nm { font-style: italic; opacity: .6; font-size: .78rem; }
    .sel-nunca { color: var(--warn-soft-fg); font-size: .78rem; }
    .sel-fuente { display: block; font-size: .68rem; opacity: .6; }
    .sel-ubi { display: block; font-size: .68rem; opacity: .6; }
    .sel-flojo { color: var(--warn-soft-fg); margin-left: .3rem; font-size: .8rem; }
    .sel-activa { background: var(--hover-bg); }
    .abc-head-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    :host ::ng-deep .abc-wh { min-width: 220px; }
    :host ::ng-deep .abc-cls { min-width: 130px; }
    /* [ABC.6] El criterio, antes de la tabla: la letra sin su regla no se puede discutir. */
    .abc-criterio {
      font-size: var(--fs-xs); color: var(--fg-3); margin: 0 0 .75rem;
      max-width: 96ch; line-height: 1.5;
    }
    .abc-criterio b { color: var(--fg-2); }
    .abc-criterio-src { display: block; font-size: var(--fs-nano); opacity: .75; margin-top: .15rem; }
    /* El recorte se declara, y se ve: no es una nota al pie. */
    .abc-trunc {
      font-size: var(--fs-xs); color: var(--warn-fg); margin: 0 0 .75rem;
      padding: .4rem .7rem; border-left: 3px solid var(--warn-fg);
      background: color-mix(in srgb, var(--warn-fg) 7%, transparent); border-radius: 4px;
    }
    /* Guion, no cero: un valor ausente por falta de demanda no es un valor de cero. */
    .abc-nd { opacity: .5; cursor: help; }
    .abc-bento { margin-bottom: 1rem; }
    .abc-dist-card {
      position: relative; display: flex; flex-direction: column; gap: .5rem;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: 12px; padding: 1rem 1.125rem; min-height: 132px; justify-content: center;
    }
    .abc-dist-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background: var(--ok-fg); border-top-left-radius:12px; border-bottom-left-radius:12px; }
    .abc-dist-label { font-size: var(--fs-micro,.6875rem); font-weight: var(--fw-bold,700); text-transform:uppercase; letter-spacing:.08em; color: var(--c-text-2,var(--text-muted)); }
    .abc-dist-foot { font-size: var(--fs-xs); color: var(--c-text-2,var(--text-muted)); display: flex; align-items: center; gap: .35rem; font-variant-numeric: tabular-nums; }
    .abc-dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; }
    .abc-dot.abc-a, .abc-dist-seg.abc-a { background: var(--ok-fg); }
    .abc-dot.abc-b, .abc-dist-seg.abc-b { background: var(--warn-fg); }
    .abc-dot.abc-c, .abc-dist-seg.abc-c { background: var(--chart-8); }
    .abc-dot:not(:first-child) { margin-left: .5rem; }
    .abc-dist-bar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: var(--c-surface-2, var(--surface-ground)); }
    .abc-dist-seg { min-width: 2px; transition: flex-basis 250ms var(--ease-standard, ease); }
    :host ::ng-deep .abc-views { margin-bottom: .75rem; }
    :host ::ng-deep .abc-views .p-button { font-size: var(--fs-sm); padding: .35rem .9rem; }
    .abc-mono { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .abc-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .abc-num { text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialInventoryAbcComponent {
  readonly views = [
    // [IC.24] Primera a propósito: es la pregunta operativa («¿qué cuento hoy y por qué?»).
    // Las otras dos contestan «¿qué está vencido?» y «¿cómo quedó clasificado el catálogo?».
    { label: 'Selección del conteo', value: 'seleccion' },
    { label: 'Agenda de conteo', value: 'due' },
    { label: 'Clasificación ABC', value: 'class' },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  loading = signal(false);
  working = signal(false);
  view = signal<'due' | 'class' | 'seleccion'>('seleccion');

  // ── [IC.24] La selección del conteo ──────────────────────────────────────────────────
  sel = signal<CountSelectionResult | null>(null);
  /**
   * El filtro de producto se aplica acá y NO con `matchProd`: esa función compara contra
   * `product_name`, y esta fila trae el nombre en `nombre`. Reusarla con un cast habría
   * compilado y filtrado SIEMPRE a vacío cuando el filtro fuera por nombre — el tipo hubiera
   * dicho que sí y la pantalla se habría vaciado sin error.
   */
  selItems = computed(() => {
    const todo = this.sel()?.items ?? [];
    const f = this.prodFilter();
    if (!f) return todo;
    return todo.filter((r) => (f.sku ? r.sku === f.sku : r.nombre === f.label));
  });
  selFila: CountSelectionItem | null = null;
  detalleDe = signal<CountSelectionItem | null>(null);
  detalle = signal<CountSelectionDetail | null>(null);

  sevClase(c: string | null): 'success' | 'info' | 'secondary' {
    return c === 'A' ? 'success' : c === 'B' ? 'info' : 'secondary';
  }

  /**
   * ⚠️ `sobra` NO es «bueno». Medido en Padre Hidalgo, el sobrante carga **3.4× el dinero de la
   * merma** ($4,246,558 contra $1,248,543): es producto que está y el sistema no sabe. Por eso
   * los dos patrones se pintan con el mismo peso visual y ninguno en verde.
   */
  sevPatron(p: string | null): 'warn' | 'danger' | 'secondary' {
    if (p === 'merma') return 'danger';
    if (p === 'sobra') return 'warn';
    return 'secondary';
  }

  abrirDetalle(it: CountSelectionItem) {
    this.detalleDe.set(it);
    this.detalle.set(null);
    const wh = this.whParam();
    if (!wh) return;
    this.svc.countSelectionDetail(it.product_id, wh).subscribe({
      next: (d) => this.detalle.set(d),
      // Fail-closed: si no se pudo leer el porqué, NO se deja la ficha anterior en pantalla
      // atribuida a otro SKU — eso sería peor que no mostrar nada.
      error: () => {
        this.detalle.set(null);
        this.toast.add({ severity: 'warn', summary: 'No se pudo leer el porqué de ese producto' });
      },
    });
  }
  readonly ALL = '__all__';
  warehouseFilter = this.ALL;
  warehouses = signal<{ label: string; value: string }[]>([]);
  warehouseOptions = computed(() => [{ label: 'Todos los almacenes', value: this.ALL }, ...this.warehouses()]);
  isSpecific(): boolean { return this.warehouseFilter !== this.ALL; }
  private whParam(): string | undefined { return this.isSpecific() ? this.warehouseFilter : undefined; }

  /** Filtro de producto (client-side por SKU). */
  prodFilter = signal<ProductHit | null>(null);
  private matchProd<T extends { sku: string | null; product_name: string | null }>(list: T[]): T[] {
    const f = this.prodFilter();
    if (!f) return list;
    return list.filter((r) => (f.sku ? r.sku === f.sku : r.product_name === f.label));
  }
  dueItems = computed(() => this.matchProd(this.due()?.items ?? []));
  classRows = computed(() => this.matchProd(this.rows()));
  readonly criterio = computed(() => this.lista()?.criterio ?? null);
  summary = signal<AbcSummary | null>(null);
  lista = signal<AbcListResult | null>(null);
  rows = computed<AbcRow[]>(() => this.lista()?.items ?? []);
  due = signal<CycleDueResult | null>(null);

  /** [ABC.6] Filtro por clase: sin esto B y C eran INALCANZABLES desde la pantalla — no por
   *  diseño, sino porque las 4,987 A se comían el LIMIT de la agenda. */
  claseFiltro = signal<'A' | 'B' | 'C' | null>(null);
  readonly clases = [
    { label: 'Todas', value: null as 'A' | 'B' | 'C' | null },
    { label: 'Sólo A', value: 'A' as const },
    { label: 'Sólo B', value: 'B' as const },
    { label: 'Sólo C', value: 'C' as const },
  ];

  total = computed(() => this.summary()?.total_count ?? 0);

  readonly abcLabels = ['A', 'B', 'C'];
  readonly dueByClass = computed(() => {
    const b = this.due()?.by_class;
    return [Number(b?.A ?? 0), Number(b?.B ?? 0), Number(b?.C ?? 0)];
  });
  readonly dueSum = computed(() => this.dueByClass().reduce((s, n) => s + n, 0));

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.warehouses.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))) });
    this.load();
  }

  load() {
    this.loading.set(true);
    const wh = this.whParam();
    forkJoin({
      summary: this.svc.abcSummary(wh),
      rows: this.svc.listAbc({ warehouse_id: wh, abc_class: this.claseFiltro() ?? undefined }),
      due: this.svc.cycleDue({
        warehouse_id: wh, only_due: true, abc_class: this.claseFiltro() ?? undefined }),
      // [IC.24] La selección del día. Va en el mismo forkJoin y no en una carga aparte porque
      // cuesta 135 ms — medido — y pedirla al cambiar de pestaña dejaría la vista en blanco
      // justo al entrar, que es cuando se la mira.
      sel: this.svc.countSelection({ warehouse_id: wh ?? '', ritmo: 'diario', limit: 25 }),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.summary.set(r.summary); this.lista.set(r.rows); this.due.set(r.due);
          this.sel.set(r.sel);
          // Cambió el almacén: la ficha abierta ya no le corresponde a esta lista.
          this.detalleDe.set(null); this.detalle.set(null); this.selFila = null;
          this.loading.set(false);
        },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar ABC' }); },
      });
  }

  recalc() {
    this.working.set(true);
    this.svc.refreshAbc(90)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.working.set(false);
          this.toast.add({ severity: 'success', summary: 'ABC recalculado', detail: `${r.classified} SKUs clasificados` });
          this.load();
        },
        error: () => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo recalcular ABC' }); },
      });
  }

  confirmGenerate() {
    const whLabel = this.warehouseOptions().find((o) => o.value === this.warehouseFilter)?.label || 'el almacén';
    this.confirm.confirm({
      header: 'Generar folios cíclicos',
      message: `Se abrirá un folio de conteo cíclico para ${whLabel} con los productos que toca contar (prioriza clase A). ¿Continuar?`,
      acceptLabel: 'Generar',
      rejectLabel: 'Cancelar',
      accept: () => this.generate(),
    });
  }

  private generate() {
    this.working.set(true);
    this.svc.generateCycleFolios({ warehouse_id: this.whParam() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.working.set(false);
          if (r.folios_created > 0)
            this.toast.add({ severity: 'success', summary: 'Folios generados', detail: `${r.folios_created} folio(s) cíclico(s) abierto(s)` });
          else if (r.skipped > 0)
            this.toast.add({ severity: 'info', summary: 'Sin cambios', detail: 'Ya hay un folio abierto para este almacén' });
          else
            this.toast.add({ severity: 'info', summary: 'Nada que contar', detail: 'No hay productos pendientes en este almacén' });
          this.load();
        },
        error: () => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudieron generar folios' }); },
      });
  }

  classCount(c: 'A' | 'B' | 'C'): number {
    return this.summary()?.by_class?.[c]?.count ?? 0;
  }
  pct(c: 'A' | 'B' | 'C'): number {
    const t = this.total();
    return t > 0 ? (this.classCount(c) / t) * 100 : 0;
  }
  distAria(): string {
    return `Distribución ABC: A ${this.classCount('A')}, B ${this.classCount('B')}, C ${this.classCount('C')}`;
  }
  computedLabel(): string {
    const at = this.summary()?.computed_at;
    if (!at) return 'sin calcular';
    const d = new Date(at);
    return `calc. ${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}`;
  }

  classSeverity(c: string): 'success' | 'warn' | 'secondary' {
    return c === 'A' ? 'success' : c === 'B' ? 'warn' : 'secondary';
  }

  /**
   * `[ABC.6]` POR QUÉ el SKU tiene esa letra.
   *
   * El motivo viene de la columna **canónica** `clase_motivo` (KE.4b) — no se deriva acá: una
   * segunda definición del mismo concepto es el defecto que KE.4 cerró cuando la pantalla
   * mostraba otra clase que el motor. Lo único que agrega el frontend es el DETALLE del Pareto
   * (top 80 / siguiente 15 / último 5), que sale de `abc_class` y no es otra regla.
   *
   * ⚠️ Y declara la contradicción medida: hay 5,865 filas con demanda CERO que el resolvedor
   * rotula `pareto`, porque su `sin_demanda` mira el almacén entero y no la fila. No se
   * re-etiquetan (esa etiqueta decide compra en `import-network-reorder`): se dice.
   */
  motivoLabel(it: { motivo_clase?: string; abc_class?: string; sin_demanda_en_fila?: boolean }): string {
    if (it.motivo_clase === 'sin_demanda') return 'Almacén sin demanda';
    if (it.motivo_clase === 'sin_costo') return 'Sin costo medido';
    if (it.sin_demanda_en_fila) return 'Sin demanda en 90 d';
    return { A: 'Top 80% del valor', B: 'Siguiente 15%', C: 'Último 5% del valor' }[it.abc_class ?? ''] ?? '—';
  }

  /** Lo no medido NO va en gris de "bajo valor": es un hueco, y se ve distinto. */
  motivoSeverity(it: { motivo_clase?: string; abc_class?: string; sin_demanda_en_fila?: boolean }):
    'success' | 'warn' | 'secondary' | 'info' {
    if (it.motivo_clase !== 'pareto' || it.sin_demanda_en_fila) return 'info';
    return it.abc_class === 'A' ? 'success' : it.abc_class === 'B' ? 'warn' : 'secondary';
  }

  /** La cuenta completa, para que la letra se pueda auditar sin salir de la fila. */
  motivoTooltip(it: {
    motivo_clase?: string; sin_demanda_en_fila?: boolean; annual_value?: number | string;
    units_window?: number | string; value_share?: number | string; window_days?: number;
  }): string {
    const v = Number(it.annual_value || 0);
    const u = Number(it.units_window || 0);
    const d = it.window_days || 90;
    if (it.motivo_clase === 'sin_demanda')
      return 'Este ALMACÉN no registra demanda: no vende, distribuye por traspaso (el CEDIS). '
        + 'La clase ABC no significa nada ahí, y su reabasto se planea aparte con demanda dependiente.';
    if (it.motivo_clase === 'sin_costo')
      return `Se movieron ${u.toLocaleString('es-MX')} unidades en ${d} días, pero el costo `
        + 'unitario no resolvió contra el ERP, así que el valor no se puede calcular.';
    if (it.sin_demanda_en_fila)
      return `Este SKU no movió una sola unidad en ${d} días en este almacén, así que su valor `
        + 'anual es $0 y no hay Pareto que lo ordene. ⚠️ El resolvedor lo rotula «pareto» porque '
        + 'su regla mira la demanda del almacén entero, no la de la fila — son 5,865 casos '
        + 'medidos. Es C por falta de medición, no por bajo valor.';
    const share = Number(it.value_share || 0) * 100;
    return `${u.toLocaleString('es-MX')} unidades en ${d} días × costo unitario = `
      + `$${v.toLocaleString('es-MX', { maximumFractionDigits: 0 })} al año, que es el `
      + `${share.toFixed(2)}% del valor de consumo de este almacén. `
      + 'El corte es Pareto POR ALMACÉN: A hasta el 80% acumulado, B hasta el 95%, C el resto.';
  }

  dueLabel(it: { is_due: boolean; last_counted_at: string | null; days_overdue: number | null }): string {
    if (!it.is_due) return 'A tiempo';
    if (it.last_counted_at == null) return 'Nunca contado';
    if ((it.days_overdue ?? 0) > 0) return `Vencido ${it.days_overdue}d`;
    return 'Toca contar';
  }
  dueSeverity(it: { is_due: boolean; days_overdue: number | null }): 'danger' | 'warn' | 'secondary' {
    if (!it.is_due) return 'secondary';
    return (it.days_overdue ?? 0) > 0 ? 'danger' : 'warn';
  }
}
