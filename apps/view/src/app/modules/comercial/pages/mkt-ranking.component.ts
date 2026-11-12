import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, forkJoin, of } from 'rxjs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { PopoverModule } from 'primeng/popover';
import { DatePickerModule } from 'primeng/datepicker';
import { warehouseName } from '@megadulces/contracts';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { coincideBusqueda } from '@megadulces/ui-web';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarPdf } from '../../../shared/util/abrir-pdf';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PROMOS_TABS } from '../promos-tabs';
import {
  CANALES, CANAL_CORTO, CANAL_LARGO, Canal, MktRankingService, ParticipanteRanking, RankingSemana, moverSemana, pct, textoSemana,
  textoVentaProducto, textoProductos, EstadoVenta, PromoEnRanking, RenglonRanking, estadoDe, VendedoraEnRanking,
} from '../mkt-ranking.service';
import { SUCURSALES_VENTA } from './mkt-ranking-promos.component';
import { pdfRanking } from '../mkt-ranking-pdf';

/**
 * `[MKT.11]` **Ranking de promociones** — reemplaza el Excel «RANKING SEMANA NN» de Mercadotecnia.
 *
 * Propósito (una pregunta): ¿quién cumplió las promociones de la semana y quién no?
 * Entra Mercadotecnia el lunes con la semana cerrada; Dirección consulta.
 *
 * Jerarquía: primario = el lugar y el cubrimiento de cada fila; secundario = cumplidas, sin venta y
 * sin objetivo; terciario = la clave del vendedor y la nota del método.
 *
 * Desglose: la fila abre el detalle por promoción (objetivo, venta, cubrimiento, regalos en
 * existencia y el aviso de un código que Kepler reutilizó). «Sin objetivo» lleva a capturarlos.
 * Dar de alta y fijar objetivos vive en «Objetivos» (otra pregunta: qué se mide y contra qué).
 */
@Component({
  selector: 'app-mkt-ranking',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, TagModule, ButtonModule, InputTextModule, SelectModule, MultiSelectModule, PopoverModule, DatePickerModule, ToastModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page rk">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ranking de promociones <app-context-help topic="mkt-ranking" /></h1>
          <p class="surf-page-sub">Quién cumplió las promociones de la semana.</p>
        </div>
        <div class="rk-acciones">
          <app-freshness-pill measures="fetch" [since]="datos()?.consultado_at ?? null" [staleAfterSec]="900"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm" (click)="pdf()" [disabled]="generando() || !datos()" [loading]="generando()">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">Reporte PDF</span>
          </button>
        </div>
      </header>

      <!-- Una sola barra: semana · canal · vista, y los filtros detrás de un botón (auditoría 2026-11-12:
           13 controles antes de la primera fila abrumaban). Lo filtrado nunca queda escondido: se ve como etiqueta. -->
      <div class="rk-filtros">
        <app-page-tabs [tabs]="tabs" variant="menu" ariaLabel="Secciones de Mercadotecnia" />
        <div class="rk-semana" role="group" aria-label="Semana">
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(-1)" aria-label="Semana anterior">
            <span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <!-- Calendario: cualquier semana en dos clics (abrir y elegir un día), no N clics de flecha. -->
          <button type="button" class="rk-semana-btn" (click)="calendario.toggle($event)" aria-haspopup="dialog"
                  [attr.aria-label]="'Semana: ' + (datos() ? semanaTexto() : 'cargando') + '. Elegir otra en el calendario'" [disabled]="!datos()">
            <i class="pi pi-calendar" aria-hidden="true"></i>
            <span class="rk-semana-txt">{{ datos() ? semanaTexto() : 'Cargando semana…' }}
              @if (actualizando()) { <span class="rk-actualizando-txt" role="status">Actualizando…</span> }</span>
          </button>
          <p-popover #calendario appendTo="body" ariaLabel="Elegir semana">
            <p-datepicker [inline]="true" [showWeek]="true" [firstDayOfWeek]="1" [maxDate]="hoy" [ngModel]="lunesFecha()"
                          (onSelect)="elegirDia($event); calendario.hide()" ariaLabel="Elige un día: se abre su semana (lunes a domingo)" />
            <p class="rk-cal-pista">Elige cualquier día: se abre su semana, de lunes a domingo.</p>
          </p-popover>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(1)" [disabled]="datos()?.semana?.en_curso" aria-label="Semana siguiente">
            <span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        <app-segmented [options]="opcionesCanal()" [value]="canal()" (valueChange)="elegirCanal($event)" ariaLabel="Canal"></app-segmented>
        <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="elegirVista($event)" ariaLabel="Ver el ranking por"></app-segmented>
        <button pButton type="button" class="p-button-sm p-button-text rk-btn-filtros" (click)="filtrosAbiertos.set(!filtrosAbiertos())"
                [attr.aria-expanded]="filtrosAbiertos()" aria-controls="rk-panel-filtros">
          <span class="p-button-icon p-button-icon-left pi pi-filter" aria-hidden="true"></span>
          <span class="p-button-label">Filtros{{ chips().length ? ' (' + chips().length + ')' : '' }}</span>
        </button>
      </div>
      @if (filtrosAbiertos()) {
        <div class="rk-filtros rk-filtros--2" id="rk-panel-filtros">
          <p-select [options]="datos()?.promos_lista ?? []" optionLabel="mecanica" optionValue="id" [ngModel]="promo()" (ngModelChange)="elegirPromo($event)"
                    [filter]="true" filterBy="mecanica,code" [showClear]="true" placeholder="Todas las promociones" appendTo="body"
                    class="rk-promo-sel" ariaLabel="Filtrar por promoción">
            <ng-template #item let-o><span>{{ o.mecanica }}</span> <span class="rk-tenue rk-inline">{{ o.code }}</span></ng-template>
          </p-select>
          <p-multiselect [options]="opcionesSucursal" optionLabel="label" optionValue="value" [ngModel]="sucursales()" (ngModelChange)="elegirSucursales($event)"
                         placeholder="Todas las sucursales" [showClear]="true" display="comma" [maxSelectedLabels]="2" selectedItemsLabel="{0} sucursales"
                         appendTo="body" ariaLabel="Filtrar por sucursal"></p-multiselect>
          @if (vista() !== 'vendedoras') {
            <!-- Una vendedora no tiene objetivo: «cumplida / no cumplida» no aplica y no se ofrece. -->
            <app-segmented [options]="opcionesEstado" [value]="estado()" (valueChange)="elegirEstado($event)" ariaLabel="Filtrar por venta"></app-segmented>
          }
          <input pInputText type="search" class="rk-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                 [placeholder]="textoBuscar()" aria-label="Buscar en el ranking" />
        </div>
      }
      @if (chips().length) {
        <div class="rk-chips" role="group" aria-label="Filtros activos">
          @for (c of chips(); track c.id) {
            <button type="button" class="rk-chip" (click)="quitarFiltro(c.id)" [attr.aria-label]="'Quitar filtro ' + c.texto">
              {{ c.texto }} <i class="pi pi-times" aria-hidden="true"></i></button>
          }
          @if (chips().length > 1) {
            <button type="button" class="rk-chip rk-chip--todos" (click)="limpiarFiltros()">Quitar todos</button>
          }
        </div>
      }
      @if (datos()?.promo_filtrada; as pf) {
        <p class="rk-nota" role="status"><i class="pi pi-filter" aria-hidden="true"></i> El lugar se calcula sólo con «{{ nombrePromo(pf) }}».</p>
      }

      <!-- Mientras recarga se queda lo último, atenuado y dicho («Actualizando…»): nunca vuelve a cero. -->
      <div class="rk-cuerpo" [class.rk-actualizando]="actualizando()" [attr.aria-busy]="actualizando()">
      @if (datos(); as d) {
        <app-metric-strip [items]="kpis()" [instant]="true" density="compact" ariaLabel="Resumen de la semana" (drill)="drill($event)"></app-metric-strip>
        @if (d.semana.en_curso) {
          <p class="rk-nota" role="status"><i class="pi pi-clock" aria-hidden="true"></i> La semana está en curso: la venta llega hasta hoy y el lugar todavía puede cambiar.</p>
        }
      }

      @if (vista() === 'vendedoras') {
      @if (datos()?.vendedoras && coberturaTexto()) {
        <p class="rk-nota" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i>
          {{ coberturaTexto() }}
          @if (puedeCapturar) { <a routerLink="/tienda/arqueo/promociones" class="rk-liga">Capturar en el arqueo</a> }</p>
      }
      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !filasVendedora().length"
                      emptyIcon="pi-user-edit" [emptyTitle]="'Nadie tiene ventas atribuidas esta semana'"
                      emptyHint="Las cajeras escriben quién vendió cada ticket en «Arqueo › Promociones vendidas». Kepler no lo sabe en el mostrador." (retry)="res.reload()">
        <p-table [value]="filasVendedora()" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrirVendedora($any($event).data)">
          <ng-template #header>
            <tr>
              <th class="comm-num rk-col-lugar">Lugar</th>
              <th>Vendedora</th>
              <th class="comm-num">Promociones aplicadas</th>
              <th class="comm-num">Tickets</th>
              <th>Lo que más vendió</th>
            </tr>
          </ng-template>
          <ng-template #body let-x>
            <tr [pSelectableRow]="x" [attr.aria-label]="'Ver todo lo que vendió ' + x.nombre">
              <td class="comm-num rk-lugar" data-label="Lugar">{{ x.lugar }}</td>
              <td data-label="Vendedora"><span class="rk-nombre">{{ x.nombre }}</span><span class="rk-tenue">{{ x.warehouse_name }}</span></td>
              <td class="comm-num rk-pct" data-label="Aplicadas">{{ x.aplicaciones | number:'1.0-2' }}</td>
              <td class="comm-num" data-label="Tickets">{{ x.tickets }}</td>
              <td data-label="Lo que más vendió">
                @for (p of x.promos.slice(0, 2); track p.code) { <span class="rk-producto">{{ p.mecanica }} × {{ p.cantidad | number:'1.0-2' }}</span> }
                @if (x.promos.length > 2) { <span class="rk-tenue">y {{ x.promos.length - 2 }} más</span> }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
      } @else if (vista() === 'promociones') {
      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !filasPromo().length"
                      emptyIcon="pi-search" [emptyTitle]="datos()?.promos_vigentes ? 'Ninguna promoción coincide con los filtros' : 'Sin promociones dadas de alta para esta semana'"
                      [emptyHint]="datos()?.promos_vigentes ? 'Cambia o quita los filtros.' : null" (retry)="res.reload()">
        <p-table [value]="filasPromo()" dataKey="promo_id" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrirPromo($any($event).data)">
          <ng-template #header>
            <tr>
              <th class="comm-num rk-col-lugar">Lugar</th>
              <th>Promoción</th>
              <th class="rk-col-cub">Cubrimiento</th>
              <th class="comm-num">Cumplieron</th>
              <th class="comm-num">Venta</th>
              @if (colSinVentaPromo()) { <th class="comm-num">Sin venta</th> }
            </tr>
          </ng-template>
          <ng-template #body let-x>
            <tr [pSelectableRow]="x" [attr.aria-label]="'Ver quién vendió ' + x.nombre">
              <td class="comm-num rk-lugar" data-label="Lugar">{{ x.lugar ?? '—' }}</td>
              <td data-label="Promoción">
                <span class="rk-nombre">{{ x.nombre }}</span>
                <span class="rk-tenue">{{ x.code }}@if (x.productos.length) { · {{ x.productos.join(' · ') }} }</span>
              </td>
              <td class="rk-col-cub" data-label="Cubrimiento">
                @if (x.puntaje !== null) {
                  <div class="rk-barra" aria-hidden="true"><span [style.width.%]="x.puntaje * 100"></span></div>
                  <span class="rk-pct">{{ pct(x.puntaje) }}</span>
                } @else {
                  <span class="rk-tenue">Sin objetivos: no se puede medir</span>
                }
              </td>
              <td class="comm-num" data-label="Cumplieron">{{ x.cumplidas }} <span class="rk-de">de {{ x.con_objetivo }}</span></td>
              <td class="comm-num" data-label="Venta">{{ x.venta_total | number:'1.0-2' }}</td>
              @if (colSinVentaPromo()) { <td class="comm-num" data-label="Sin venta">{{ x.sin_venta }} <span class="rk-de">de {{ x.participantes }}</span></td> }
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
      } @else {
      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !filas().length"
                      [emptyIcon]="datos()?.promos_vigentes ? 'pi-search' : 'pi-megaphone'"
                      [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()"
                      [emptyCta]="!datos()?.promos_vigentes && puedeGestionar ? 'Dar de alta una promoción' : null"
                      (cta)="irAObjetivos()" (retry)="res.reload()">
        <p-table [value]="filas()" dataKey="clave" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th class="comm-num rk-col-lugar">Lugar</th>
              <th>{{ canal() === 'mostrador' ? 'Sucursal' : 'Vendedor' }}</th>
              <th class="rk-col-cub">Cubrimiento</th>
              <th class="comm-num">Cumplidas</th>
              @if (colSinVenta()) { <th class="comm-num">Sin venta</th> }
              @if (colSinObjetivo()) { <th class="comm-num">Sin objetivo</th> }
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p" [attr.aria-label]="'Ver las promociones de ' + p.nombre">
              <td class="comm-num rk-lugar" data-label="Lugar">{{ p.lugar ?? '—' }}</td>
              <td data-label="Quién">
                <span class="rk-nombre">{{ p.nombre }}</span>
                @if (canal() !== 'mostrador') { <span class="rk-tenue">{{ p.warehouse_name }}</span> }
              </td>
              <td class="rk-col-cub" data-label="Cubrimiento">
                @if (p.puntaje !== null) {
                  <div class="rk-barra" aria-hidden="true"><span [style.width.%]="p.puntaje * 100"></span></div>
                  <span class="rk-pct">{{ pct(p.puntaje) }}</span>
                } @else {
                  <span class="rk-tenue">Sin objetivos: no se puede medir</span>
                }
              </td>
              <td class="comm-num" data-label="Cumplidas">{{ p.cumplidas }} <span class="rk-de">de {{ p.con_objetivo }}</span></td>
              @if (colSinVenta()) { <td class="comm-num" data-label="Sin venta">{{ p.sin_venta }}</td> }
              @if (colSinObjetivo()) { <td class="comm-num" data-label="Sin objetivo">@if (p.sin_objetivo) { <p-tag [value]="'' + p.sin_objetivo" severity="warn"></p-tag> } @else { <span class="rk-tenue">—</span> }</td> }
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
      }

      @if (datos(); as d) {
        <p class="rk-metodo">{{ d.criterio }}</p>
      }
      </div>

      <app-side-peek [open]="!!abiertaVendedora()" (openChange)="$event ? null : abiertaVendedora.set(null)" [width]="640"
                     [title]="abiertaVendedora()?.nombre ?? ''" [subtitle]="subtituloVendedora()">
        @if (abiertaVendedora(); as v) {
          <p class="rk-peek-frase">
            Aplicó <strong>{{ v.aplicaciones | number:'1.0-2' }}</strong> promociones en <strong>{{ v.tickets }}</strong>
            {{ v.tickets === 1 ? 'ticket' : 'tickets' }} de {{ v.warehouse_name }}. Cuenta sólo los tickets que la cajera le asignó en el arqueo.
          </p>
          <p-table [value]="v.promos" size="small" class="surf-table surf-table--plain">
            <ng-template #header>
              <tr><th>Promoción</th><th class="comm-num">Aplicadas</th></tr>
            </ng-template>
            <ng-template #body let-p>
              <tr>
                <td><span class="rk-promo">{{ p.mecanica }}</span><span class="rk-tenue">{{ p.code }}</span></td>
                <td class="comm-num rk-pct">{{ p.cantidad | number:'1.0-2' }}</td>
              </tr>
            </ng-template>
          </p-table>
          @if (puedeCapturar) {
            <div class="rk-peek-acciones">
              <a pButton class="p-button-sm p-button-outlined" routerLink="/tienda/arqueo/promociones">
                <span class="p-button-icon p-button-icon-left pi pi-user-edit" aria-hidden="true"></span><span class="p-button-label">Corregir quién vendió</span></a>
            </div>
          }
        }
      </app-side-peek>

      <app-side-peek [open]="!!abiertaPromo()" (openChange)="$event ? null : abiertaPromo.set(null)" [width]="760"
                     [title]="abiertaPromo()?.nombre ?? ''" [subtitle]="subtituloPromo()">
        @if (abiertaPromo(); as x) {
          <p class="rk-peek-frase">
            @if (x.puntaje !== null) {
              Cubrimiento promedio <strong>{{ pct(x.puntaje) }}</strong>: {{ x.cumplidas }} de {{ x.con_objetivo }} llegaron a su objetivo.
            } @else { Nadie tiene objetivo en esta promoción. }
            @if (x.sin_venta) { {{ x.sin_venta }} sin venta. }
          </p>
          <p-table [value]="filasDePromo()" size="small" class="surf-table surf-table--plain">
            <ng-template #header>
              <tr>
                <th>{{ canal() === 'mostrador' ? 'Sucursal' : 'Vendedor' }}</th>
                <th class="comm-num">Objetivo</th>
                <th class="comm-num">Venta</th>
                <th class="comm-num">Cubrimiento</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td>
                  <span class="rk-promo">{{ f.nombre }}</span>
                  @if (canal() !== 'mostrador') { <span class="rk-tenue">{{ f.warehouse_name }}</span> }
                  @for (pr of f.renglon.productos; track pr.sku) { <span class="rk-producto">{{ textoVentaProducto(pr) }}</span> }
                </td>
                <td class="comm-num">@if (f.renglon.objetivo !== null) { {{ f.renglon.objetivo | number:'1.0-2' }} @if (f.renglon.objetivo_fuente === 'dinamico') { <span class="rk-tenue">dinámico</span> } } @else { <p-tag value="Sin objetivo" severity="warn"></p-tag> }</td>
                <td class="comm-num">{{ f.renglon.venta | number:'1.0-2' }}</td>
                <td class="comm-num rk-pct">{{ pct(f.renglon.cubrimiento) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="4" class="rk-tenue">Nadie coincide con los filtros.</td></tr></ng-template>
          </p-table>
        }
      </app-side-peek>

      <app-side-peek [open]="!!abierto()" (openChange)="$event ? null : abierto.set(null)" [width]="760"
                     [title]="abierto()?.nombre ?? ''" [subtitle]="subtitulo()">
        @if (abierto(); as p) {
          <p class="rk-peek-frase">
            @if (p.puntaje !== null) {
              Cubrió en promedio <strong>{{ pct(p.puntaje) }}</strong> de sus objetivos y cumplió <strong>{{ p.cumplidas }} de {{ p.con_objetivo }}</strong> promociones.
            } @else {
              Ninguna de sus promociones tiene objetivo: no tiene lugar en el ranking hasta capturarlos.
            }
            @if (p.sin_objetivo) { {{ p.sin_objetivo }} sin objetivo no cuentan. }
          </p>
          <p-table [value]="promosVisibles(p)" size="small" class="surf-table surf-table--plain">
            <ng-template #header>
              <tr>
                <th>Promoción</th>
                <th class="comm-num">Objetivo</th>
                <th class="comm-num">Venta</th>
                <th class="comm-num">Cubrimiento</th>
                @if (canal() === 'mostrador') { <th class="comm-num">Regalos en existencia</th> }
              </tr>
            </ng-template>
            <ng-template #body let-x>
              <tr>
                <td>
                  <span class="rk-promo">{{ x.mecanica }}</span>
                  <span class="rk-tenue">{{ x.code }}</span>
                  @for (pr of x.productos; track pr.sku) {
                    <span class="rk-producto">{{ textoVentaProducto(pr) }}</span>
                  } @empty {
                    <span class="rk-tenue" [title]="x.productos_nota">{{ textoProductos(x.productos_metodo, []) }}</span>
                  }
                  @if (x.descripcion_distinta) {
                    <span class="rk-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Kepler vendió este código con otra descripción: puede ser otra promoción.</span>
                  }
                </td>
                <td class="comm-num">
                  @if (x.objetivo !== null) {
                    {{ x.objetivo | number:'1.0-2' }}
                    @if (x.objetivo_fuente === 'dinamico') { <span class="rk-tenue">dinámico</span> }
                  } @else { <p-tag value="Sin objetivo" severity="warn"></p-tag> }
                </td>
                <td class="comm-num">{{ x.venta | number:'1.0-2' }}</td>
                <td class="comm-num rk-pct">{{ pct(x.cubrimiento) }}</td>
                @if (canal() === 'mostrador') { <td class="comm-num">{{ x.existencia === null ? '—' : (x.existencia | number:'1.0-2') }}</td> }
              </tr>
            </ng-template>
          </p-table>
          @if (puedeGestionar) {
            <div class="rk-peek-acciones">
              <a pButton class="p-button-sm p-button-outlined" routerLink="/mkt/ranking/promociones">
                <span class="p-button-icon p-button-icon-left pi pi-sliders-h" aria-hidden="true"></span><span class="p-button-label">Ajustar objetivos</span></a>
            </div>
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rk-acciones { display: flex; align-items: center; gap: var(--sp-3); }
    .rk-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: var(--sp-3) 0 var(--sp-2); }
    .rk-cuerpo { transition: opacity var(--dur-short) ease; }
    .rk-cuerpo app-metric-strip { display: block; margin-bottom: var(--sp-3); }
    .rk-actualizando { opacity: 0.55; }
    .rk-actualizando-txt { display: block; font-size: var(--fs-xs); font-weight: var(--fw-regular); color: var(--text-muted); }
    .rk-de { color: var(--text-muted); font-size: var(--fs-xs); margin-left: var(--sp-1); }
    .rk-liga { margin-left: var(--sp-2); color: var(--action); text-decoration: underline; }
    .rk-btn-filtros { margin-left: auto; }
    .rk-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0 0 var(--sp-2); }
    .rk-chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--surface-border);
               border-radius: var(--r-pill); background: transparent; color: var(--fg-1); font: inherit; font-size: var(--fs-xs); cursor: pointer; }
    .rk-chip:hover { background: var(--overlay-hover); }
    .rk-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .rk-chip--todos { border-style: dashed; color: var(--text-muted); }
    .rk-semana { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .rk-semana-txt { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; min-width: 13rem; text-align: left; }
    .rk-semana-btn { display: inline-flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-3); border: 1px solid var(--surface-border);
                     border-radius: var(--r-pill); background: transparent; color: var(--fg-1); font: inherit; cursor: pointer; }
    .rk-semana-btn:hover { background: var(--overlay-hover); }
    .rk-semana-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .rk-cal-pista { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 18rem; }
    .rk-filtros--2 { margin-top: 0; }
    .rk-promo-sel { min-width: 18rem; max-width: 26rem; }
    .rk-inline { display: inline; }
    .rk-buscar { min-width: 14rem; }
    .rk-nota { display: flex; gap: var(--sp-2); align-items: center; color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-2) 0; }
    .rk-col-lugar { width: 4.5rem; }
    .rk-col-cub { min-width: 14rem; }
    .rk-lugar { font-size: var(--fs-lg); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .rk-nombre { display: block; font-weight: var(--fw-bold); }
    .rk-producto { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    .rk-tenue { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .rk-col-cub { white-space: nowrap; }
    .rk-barra { display: inline-block; vertical-align: middle; width: 8rem; height: 0.5rem; border-radius: var(--r-pill); background: var(--overlay-hover); overflow: hidden; margin-right: var(--sp-2); }
    /* Neutra: el lugar ya ordena. Los umbrales 90 % / 50 % no eran regla de negocio de nadie. */
    .rk-barra > span { display: block; height: 100%; background: var(--fg-2); border-radius: var(--r-pill); }
    .rk-pct { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .rk-metodo { color: var(--text-muted); font-size: var(--fs-xs); margin-top: var(--sp-3); max-width: 70rem; }
    .rk-peek-frase { margin: 0 0 var(--sp-4); }
    .rk-promo { display: block; }
    .rk-aviso { display: flex; gap: var(--sp-1); align-items: flex-start; color: var(--warn-fg); font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .rk-peek-acciones { margin-top: var(--sp-4); display: flex; justify-content: flex-end; }
    @media (max-width: 48rem) { .rk-buscar { margin-left: 0; width: 100%; } .rk-semana-txt { min-width: 0; } }
  `],
})
export class MktRankingComponent {
  private readonly api = inject(MktRankingService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  readonly tabs = PROMOS_TABS;
  readonly pct = pct;
  readonly textoVentaProducto = textoVentaProducto;
  readonly textoProductos = textoProductos;
  readonly puedeGestionar = this.perms.has(Permission.MKT_AGREEMENTS_GESTIONAR);
  /** Liga al arqueo, donde la cajera escribe quién vendió: sólo a quien puede capturar ahí. */
  readonly puedeCapturar = this.perms.has(Permission.STORE_ARQUEO_CAPTURAR);

  /** NULL = la última semana cerrada (la decide el servidor). */
  readonly semana = signal<string | null>(null);
  readonly canal = signal<Canal>('mostrador');
  readonly busqueda = signal('');
  readonly abierto = signal<ParticipanteRanking | null>(null);
  readonly generando = signal(false);

  // ── `[MKT.16]` filtros ──
  readonly vista = signal<'participantes' | 'promociones' | 'vendedoras'>('participantes');
  /** Promo del filtro: el SERVIDOR recalcula el lugar sólo con ella (una sola implementación de la regla). */
  readonly promo = signal<string | null>(null);
  /** Sucursales: filtran filas aquí; el ranking de promociones lo recalcula el servidor con ellas. */
  readonly sucursales = signal<string[]>([]);
  readonly estado = signal<EstadoVenta>('todas');
  readonly abiertaPromo = signal<PromoEnRanking | null>(null);
  readonly abiertaVendedora = signal<VendedoraEnRanking | null>(null);

  readonly opcionesSucursal = SUCURSALES_VENTA.map((c) => ({ value: c, label: warehouseName(c) }));
  readonly opcionesEstado: SegOption[] = [
    { label: 'Todas', value: 'todas' }, { label: 'Cumplidas', value: 'cumplida' },
    { label: 'No cumplidas', value: 'no_cumplida' }, { label: 'Sin venta', value: 'sin_venta' },
  ];
  readonly opcionesVista = computed<SegOption[]>(() => [
    { label: this.canal() === 'mostrador' ? 'Por sucursal' : 'Por vendedor', value: 'participantes' },
    { label: 'Por promoción', value: 'promociones' },
    // [MKT.18] Sólo el mostrador: ahí Kepler no sabe quién vendió y lo escriben las cajeras.
    ...(this.canal() === 'mostrador' ? [{ label: 'Por vendedora', value: 'vendedoras' }] : []),
  ]);

  readonly res = rxResource({
    params: () => ({ semana: this.semana(), canal: this.canal(), promo: this.promo(), sucursales: this.sucursales() }),
    stream: ({ params }) => this.api.ranking(params.semana, params.canal, params.promo, params.sucursales),
  });
  /**
   * Lo último que llegó. Al cambiar semana, canal o filtro el recurso se vacía mientras carga; antes
   * eso borraba la franja y el contador volvía a subir desde cero: se leía «Promedio general 0.0 %»
   * y «0 promociones» por un par de segundos (medido en la auditoría del 2026-11-12). Ahora se queda
   * lo anterior, atenuado y con «Actualizando…»; si la carga FALLA, se suelta (no se finge vigente).
   */
  readonly datos = linkedSignal<{ v: RankingSemana | undefined; cargando: boolean }, RankingSemana | undefined>({
    source: () => ({ v: this.res.hasValue() ? this.res.value() : undefined, cargando: this.res.isLoading() }),
    computation: (s, prev) => s.v ?? (s.cargando ? prev?.value : undefined),
  });
  readonly actualizando = computed(() => this.res.isLoading() && !!this.datos());
  readonly error = computed(() => (this.res.error() ? 'No se pudo cargar el ranking. Revisa tu conexión y vuelve a intentar.' : null));

  private readonly enSucursal = (w: string) => !this.sucursales().length || this.sucursales().includes(w);
  private readonly conEstado = (x: RenglonRanking) => this.estado() === 'todas' || estadoDe(x) === this.estado();

  readonly filas = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.participantes ?? []).filter((p) =>
      coincideBusqueda(q, p.nombre, p.warehouse_name) && this.enSucursal(p.warehouse_code)
      && (this.estado() === 'todas' || p.promos.some(this.conEstado)));
  });

  /** Ranking de promociones: con el estado elegido, sólo las que tienen algún participante en él. */
  readonly filasPromo = computed(() => {
    const d = this.datos();
    if (!d) return [];
    const q = this.busqueda();
    return d.promos_ranking.filter((x) =>
      coincideBusqueda(q, x.nombre, x.code, ...x.productos)
      && (this.estado() === 'todas' || this.renglonesDe(x.promo_id).some((f) => this.conEstado(f.renglon))));
  });

  /** Los participantes de la promo abierta, con su renglón, según los filtros. */
  readonly filasDePromo = computed(() => {
    const x = this.abiertaPromo();
    return x ? this.renglonesDe(x.promo_id).filter((f) => this.conEstado(f.renglon)) : [];
  });

  private renglonesDe(promoId: string): Array<{ nombre: string; warehouse_name: string; renglon: RenglonRanking }> {
    return (this.datos()?.participantes ?? [])
      .filter((p) => this.enSucursal(p.warehouse_code))
      .flatMap((p) => p.promos.filter((r) => r.promo_id === promoId).map((renglon) => ({ nombre: p.nombre, warehouse_name: p.warehouse_name, renglon })))
      .sort((a, b) => (b.renglon.cubrimiento ?? -1) - (a.renglon.cubrimiento ?? -1) || b.renglon.venta - a.renglon.venta);
  }

  promosVisibles(p: ParticipanteRanking): RenglonRanking[] { return p.promos.filter(this.conEstado); }

  readonly hayFiltros = computed(() => !!this.promo() || this.sucursales().length > 0 || this.estado() !== 'todas' || !!this.busqueda());
  /** Los filtros viven plegados; abren solos si llegas con uno puesto (nunca se filtra a escondidas: ver `chips`). */
  readonly filtrosAbiertos = signal(false);

  /** Lo filtrado, siempre a la vista como etiqueta quitable — aunque el panel esté cerrado. */
  readonly chips = computed<Array<{ id: 'promo' | 'sucursales' | 'estado' | 'busqueda'; texto: string }>>(() => {
    const c: Array<{ id: 'promo' | 'sucursales' | 'estado' | 'busqueda'; texto: string }> = [];
    const pr = this.promo();
    if (pr) c.push({ id: 'promo', texto: this.nombrePromo(pr) });
    const ss = this.sucursales();
    if (ss.length) c.push({ id: 'sucursales', texto: ss.length <= 2 ? ss.map((x) => warehouseName(x)).join(', ') : `${ss.length} sucursales` });
    if (this.estado() !== 'todas' && this.vista() !== 'vendedoras') {
      c.push({ id: 'estado', texto: this.opcionesEstado.find((o) => o.value === this.estado())?.label ?? '' });
    }
    if (this.busqueda().trim()) c.push({ id: 'busqueda', texto: `«${this.busqueda().trim()}»` });
    return c;
  });
  quitarFiltro(id: 'promo' | 'sucursales' | 'estado' | 'busqueda'): void {
    if (id === 'promo') this.elegirPromo(null);
    else if (id === 'sucursales') this.elegirSucursales([]);
    else if (id === 'estado') this.estado.set('todas');
    else this.busqueda.set('');
  }

  /** Una columna que es cero en todas las filas no informa nada: se muestra sólo si alguien la tiene. */
  readonly colSinVenta = computed(() => this.filas().some((p) => p.sin_venta > 0));
  readonly colSinObjetivo = computed(() => this.filas().some((p) => p.sin_objetivo > 0));
  readonly colSinVentaPromo = computed(() => this.filasPromo().some((x) => x.sin_venta > 0));

  readonly subtituloPromo = computed(() => {
    const x = this.abiertaPromo();
    const d = this.datos();
    if (!x || !d) return null;
    const lugar = x.lugar === null ? 'Sin lugar' : `Lugar ${x.lugar} de ${d.promos_ranking.filter((y) => y.lugar !== null).length}`;
    return `${x.code} · ${lugar} · ${textoSemana(d.semana)}`;
  });

  nombrePromo(id: string): string { return this.datos()?.promos_lista.find((p) => p.id === id)?.mecanica ?? 'la promoción elegida'; }
  elegirVista(v: string): void {
    this.cerrarDetalles();
    this.vista.set(v === 'promociones' || v === 'vendedoras' ? v : 'participantes');
  }

  /** [MKT.18] Vendedoras del mostrador, con los filtros de búsqueda y sucursal. */
  readonly filasVendedora = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.vendedoras?.personas ?? []).filter((x) =>
      this.enSucursal(x.warehouse_code) && coincideBusqueda(q, x.nombre, x.warehouse_name, ...x.promos.map((p) => p.mecanica)));
  });

  /** Cuánto de la venta está atribuido: el ranking por vendedora sólo cuenta eso, y se dice. */
  /** Lo atribuido con los filtros de sucursal: alimenta la franja y la nota (una sola cuenta). */
  readonly cobertura = computed(() => {
    const v = this.datos()?.vendedoras;
    if (!v) return null;
    const filas = v.por_sucursal.filter((x) => this.enSucursal(x.warehouse_code));
    const t = filas.reduce((a, x) => a + x.tickets_con_promo, 0);
    const c = filas.reduce((a, x) => a + x.tickets_con_vendedora, 0);
    const sin = filas.filter((x) => x.tickets_con_promo > 0 && x.tickets_con_vendedora === 0).map((x) => warehouseName(x.warehouse_code));
    return { t, c, sin };
  });
  /** La cifra «c de t» ya va en la franja: la nota dice qué IMPLICA y dónde falta, sin repetirla. */
  readonly coberturaTexto = computed(() => {
    const k = this.cobertura();
    if (!k) return '';
    if (!k.t) return 'Esta semana no hay tickets de mostrador con estas promociones.';
    return (k.c < k.t ? 'El ranking cuenta sólo los tickets que ya tienen vendedora.' : 'Todos los tickets con promoción tienen vendedora.')
      + (k.sin.length ? ` Sin captura: ${k.sin.join(', ')}.` : '');
  });

  readonly textoBuscar = computed(() => {
    if (this.vista() === 'promociones') return 'Buscar promoción o producto';
    if (this.vista() === 'vendedoras') return 'Buscar vendedora, sucursal o promoción';
    return this.canal() === 'mostrador' ? 'Buscar sucursal' : 'Buscar vendedor o sucursal';
  });

  abrirVendedora(v: VendedoraEnRanking): void { this.abiertaVendedora.set(v); }
  readonly subtituloVendedora = computed(() => {
    const v = this.abiertaVendedora();
    const d = this.datos();
    if (!v || !d?.vendedoras) return null;
    return `Lugar ${v.lugar} de ${d.vendedoras.personas.length} · ${textoSemana(d.semana)}`;
  });
  elegirPromo(id: string | null): void { this.cerrarDetalles(); this.promo.set(id || null); }
  elegirSucursales(v: string[] | null): void { this.cerrarDetalles(); this.sucursales.set(v ?? []); }
  elegirEstado(v: string): void { this.estado.set(v as EstadoVenta); }
  abrirPromo(x: PromoEnRanking): void { this.abiertaPromo.set(x); }
  limpiarFiltros(): void {
    this.cerrarDetalles();
    this.promo.set(null); this.sucursales.set([]); this.estado.set('todas'); this.busqueda.set('');
  }
  private cerrarDetalles(): void { this.abierto.set(null); this.abiertaPromo.set(null); this.abiertaVendedora.set(null); }

  readonly opcionesCanal = computed<SegOption[]>(() => CANALES.map((c) => ({ label: CANAL_CORTO[c], value: c })));

  readonly semanaTexto = computed(() => { const d = this.datos(); return d ? textoSemana(d.semana) : ''; });

  /**
   * La franja habla de LO QUE SE ESTÁ VIENDO. Antes era una sola para las tres vistas: en «Por
   * vendedora» decía «Primer lugar: Canindo» (una sucursal) sobre una tabla cuyo primer lugar era
   * una vendedora. Contesta primero la pregunta de la vista (quién va arriba) y luego su contexto.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    if (this.vista() === 'promociones') return this.kpisPromociones(d);
    if (this.vista() === 'vendedoras') return this.kpisVendedoras();
    const sinObj = d.participantes.reduce((a, p) => a + p.sin_objetivo, 0);
    const primero = d.participantes.find((p) => p.lugar === 1);
    const medibles = d.participantes.filter((p) => p.lugar !== null);
    const todas = medibles.filter((p) => p.con_objetivo > 0 && p.cumplidas === p.con_objetivo).length;
    const k: MetricStripItem[] = [
      { label: 'Primer lugar', value: primero ? primero.nombre : '—', format: 'text', sub: primero ? pct(primero.puntaje) : 'nadie medible' },
      d.promedio_general === null
        ? { label: 'Promedio general', value: 'Sin medir', format: 'text', tone: 'muted', state: 'no_medido', stateNote: 'Ninguna promoción tiene objetivo esta semana.' }
        // `percent` del MetricStrip espera 0–100 (no la fracción).
        : { label: 'Promedio general', value: Math.round(d.promedio_general * 1000) / 10, format: 'percent',
            ...(this.sucursales().length ? { sub: 'de todas, no sólo las filtradas' } : {}) },
      { label: 'Cumplieron todas', value: `${todas} de ${medibles.length}`, format: 'text' },
    ];
    // Lo que pide acción aparece SÓLO cuando hay algo: un «0 · todas medidas» no decide nada.
    if (sinObj) k.push({ label: 'Sin objetivo', value: sinObj, format: 'number', tone: 'warn', sub: 'no cuentan para el lugar', drill: 'objetivos' });
    return k;
  });

  private kpisPromociones(d: RankingSemana): MetricStripItem[] {
    const medidas = d.promos_ranking.filter((x) => x.lugar !== null).sort((a, b) => (a.lugar ?? 0) - (b.lugar ?? 0));
    const mejor = medidas[0];
    const peor = medidas.length > 1 ? medidas[medidas.length - 1] : undefined;
    const sinVenta = d.promos_ranking.reduce((a, x) => a + x.sin_venta, 0);
    const k: MetricStripItem[] = [
      { label: 'Mejor promoción', value: mejor ? mejor.nombre : '—', format: 'text', sub: mejor ? pct(mejor.puntaje) : 'ninguna con objetivo' },
      { label: 'La más baja', value: peor ? peor.nombre : '—', format: 'text', sub: peor ? pct(peor.puntaje) : 'sólo hay una medida' },
    ];
    if (sinVenta) k.push({ label: 'Sin venta', value: sinVenta, format: 'number', tone: 'warn', sub: d.canal === 'mostrador' ? 'sucursal × promoción' : 'vendedor × promoción' });
    return k;
  }

  private kpisVendedoras(): MetricStripItem[] {
    const k = this.cobertura();
    const arriba = this.filasVendedora()[0];
    const items: MetricStripItem[] = [
      { label: arriba && arriba.lugar !== 1 ? 'Arriba en el filtro' : 'Primer lugar', value: arriba ? arriba.nombre : '—', format: 'text',
        sub: arriba ? arriba.warehouse_name : 'nadie atribuido' },
      k && k.t
        ? { label: 'Tickets con vendedora', value: `${k.c} de ${k.t}`, format: 'text', sub: `${Math.round((100 * k.c) / k.t)} %`,
            ...(k.c < k.t ? { state: 'parcial' as const, stateNote: 'El ranking cuenta sólo los tickets que la cajera ya asignó.' } : {}) }
        : { label: 'Tickets con vendedora', value: 'Sin tickets', format: 'text', tone: 'muted' },
    ];
    if (k?.sin.length) items.push({ label: 'Sucursales sin captura', value: k.sin.length, format: 'number', tone: 'warn' });
    return items;
  }

  readonly vacioTitulo = computed(() => (this.datos()?.promos_vigentes ? 'Nadie coincide con la búsqueda' : 'Sin promociones dadas de alta para esta semana'));
  readonly vacioPista = computed(() => (this.datos()?.promos_vigentes
    ? 'Prueba con otro nombre o limpia la búsqueda.'
    : 'El ranking mide sólo las promociones que Mercadotecnia da de alta, con su vigencia. Kepler no guarda la vigencia y reutiliza los códigos.'));

  readonly subtitulo = computed(() => {
    const p = this.abierto();
    const d = this.datos();
    if (!p || !d) return null;
    const lugar = p.lugar === null ? 'Sin lugar' : `Lugar ${p.lugar} de ${d.participantes.filter((x) => x.lugar !== null).length}`;
    return `${lugar} · ${textoSemana(d.semana)}`;
  });

  /** Hoy: el calendario no ofrece semanas futuras (no hay venta que medir). */
  readonly hoy = new Date();
  /** El lunes de la semana en pantalla, como fecha local para marcarlo en el calendario. */
  readonly lunesFecha = computed(() => {
    const l = this.datos()?.semana.lunes;
    if (!l) return null;
    const [y, m, d] = l.split('-').map(Number);
    return new Date(y, m - 1, d);
  });
  /** Un día cualquiera del calendario abre SU semana: se lleva al lunes (ISO, lunes a domingo). */
  elegirDia(dia: Date): void {
    const l = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate());
    l.setDate(l.getDate() - ((l.getDay() + 6) % 7));
    const p2 = (n: number) => String(n).padStart(2, '0');
    this.cerrarDetalles();
    this.semana.set(l.getFullYear() + '-' + p2(l.getMonth() + 1) + '-' + p2(l.getDate()));
  }

  cambiarSemana(delta: number): void {
    const d = this.datos();
    if (!d) return;
    this.cerrarDetalles();
    this.semana.set(moverSemana(d.semana.lunes, delta));
  }

  elegirCanal(v: string): void {
    this.cerrarDetalles();
    if (v !== 'mostrador' && this.vista() === 'vendedoras') this.vista.set('participantes');
    this.promo.set(null); // las promos de otro canal son otras
    this.canal.set(v as Canal);
  }

  abrir(p: ParticipanteRanking): void { this.abierto.set(p); }

  drill(id: string): void {
    if (id === 'objetivos' || id === 'promos') this.irAObjetivos();
  }

  irAObjetivos(): void { void this.router.navigate(['/mkt/ranking/promociones']); }

  /** El reporte de la semana con los CUATRO canales (sólo los que tienen promociones). */
  async pdf(): Promise<void> {
    const d = this.datos();
    if (!d || this.generando()) return;
    this.generando.set(true);
    const win = abrirPestanaParaPdf('Preparando el ranking…');
    try {
      // [MKT.16] El reporte es la semana COMPLETA: los 4 canales se piden SIN los filtros de la
      // pantalla. Reusar `d` mezclaba un canal filtrado (p. ej. una sola promoción) con tres completos.
      // Si un canal no llega, NO se arma el reporte: un PDF sin un canal se lee como «ese canal no vendió».
      const todosLos = await firstValueFrom(forkJoin(CANALES.map((c) => this.api.ranking(d.semana.lunes, c).pipe(catchError(() => of(null))))));
      const falto = CANALES.filter((_, i) => !todosLos[i]);
      if (falto.length) {
        cerrarPestanaDePdf(win);
        this.toast.add({ severity: 'error', summary: 'Reporte incompleto: no se generó', detail: `No se pudo traer ${falto.map((c) => CANAL_LARGO[c]).join(', ')}. Intenta de nuevo.` });
        return;
      }
      const todos = todosLos.filter((x): x is RankingSemana => !!x)
        .filter((r) => r.promos_vigentes > 0 && r.participantes.length > 0)
        .sort((a, b) => CANALES.indexOf(a.canal) - CANALES.indexOf(b.canal));
      if (!todos.length) {
        cerrarPestanaDePdf(win);
        this.toast.add({ severity: 'info', summary: 'Sin datos', detail: 'No hay promociones vigentes en esta semana.' });
        return;
      }
      const { blob, archivo } = await pdfRanking({
        semana: d.semana, rankings: todos, elaboro: this.auth.user()?.username ?? 'Mercadotecnia', consultado: new Date(d.consultado_at),
      });
      const donde = entregarPdf(win, blob, archivo);
      if (donde === 'descarga') this.toast.add({ severity: 'success', summary: 'Reporte descargado', detail: archivo });
    } catch {
      cerrarPestanaDePdf(win);
      this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF', detail: 'Intenta de nuevo.' });
    } finally {
      this.generando.set(false);
    }
  }
}
