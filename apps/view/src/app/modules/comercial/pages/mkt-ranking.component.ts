import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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
  CANALES, CANAL_CORTO, Canal, MktRankingService, ParticipanteRanking, RankingSemana, moverSemana, pct, textoSemana,
  textoVentaProducto, textoProductos, EstadoVenta, PromoEnRanking, RenglonRanking, estadoDe,
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
  imports: [CommonModule, FormsModule, RouterLink, TableModule, TagModule, ButtonModule, InputTextModule, SelectModule, MultiSelectModule, ToastModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page rk">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ranking de promociones <app-context-help topic="mkt-ranking" /></h1>
          <p class="surf-page-sub">Quién cumplió las promociones de la semana. Sale solo de Kepler: ya no hay que capturar la venta.</p>
        </div>
        <div class="rk-acciones">
          <app-freshness-pill measures="fetch" [since]="datos()?.consultado_at ?? null" [staleAfterSec]="900"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm" (click)="pdf()" [disabled]="generando() || !datos()" [loading]="generando()">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">Reporte PDF</span>
          </button>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" />

      <div class="rk-filtros">
        <div class="rk-semana" role="group" aria-label="Semana">
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(-1)" aria-label="Semana anterior">
            <span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="rk-semana-txt">{{ datos() ? semanaTexto() : 'Cargando semana…' }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(1)" [disabled]="datos()?.semana?.en_curso" aria-label="Semana siguiente">
            <span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        <app-segmented [options]="opcionesCanal()" [value]="canal()" (valueChange)="elegirCanal($event)" ariaLabel="Canal"></app-segmented>
        <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="elegirVista($event)" ariaLabel="Ver el ranking por"></app-segmented>
      </div>
      <div class="rk-filtros rk-filtros--2">
        <p-select [options]="datos()?.promos_lista ?? []" optionLabel="mecanica" optionValue="id" [ngModel]="promo()" (ngModelChange)="elegirPromo($event)"
                  [filter]="true" filterBy="mecanica,code" [showClear]="true" placeholder="Todas las promociones" appendTo="body"
                  class="rk-promo-sel" ariaLabel="Filtrar por promoción">
          <ng-template #item let-o><span>{{ o.mecanica }}</span> <span class="rk-tenue rk-inline">{{ o.code }}</span></ng-template>
        </p-select>
        <p-multiselect [options]="opcionesSucursal" optionLabel="label" optionValue="value" [ngModel]="sucursales()" (ngModelChange)="elegirSucursales($event)"
                       placeholder="Todas las sucursales" [showClear]="true" display="comma" [maxSelectedLabels]="2" selectedItemsLabel="{0} sucursales"
                       appendTo="body" ariaLabel="Filtrar por sucursal"></p-multiselect>
        <app-segmented [options]="opcionesEstado" [value]="estado()" (valueChange)="elegirEstado($event)" ariaLabel="Filtrar por venta"></app-segmented>
        <input pInputText type="search" class="rk-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               [placeholder]="vista() === 'promociones' ? 'Buscar promoción o producto' : canal() === 'mostrador' ? 'Buscar sucursal' : 'Buscar vendedor o sucursal'" aria-label="Buscar en el ranking" />
        @if (hayFiltros()) {
          <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarFiltros()">
            <span class="p-button-icon p-button-icon-left pi pi-filter-slash" aria-hidden="true"></span><span class="p-button-label">Quitar filtros</span></button>
        }
      </div>
      @if (datos()?.promo_filtrada; as pf) {
        <p class="rk-nota" role="status"><i class="pi pi-filter" aria-hidden="true"></i> El lugar se calcula sólo con «{{ nombrePromo(pf) }}».</p>
      }

      @if (datos(); as d) {
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen de la semana" (drill)="drill($event)"></app-metric-strip>
        @if (d.semana.en_curso) {
          <p class="rk-nota" role="status"><i class="pi pi-clock" aria-hidden="true"></i> La semana está en curso: la venta llega hasta hoy y el lugar todavía puede cambiar.</p>
        }
      }

      @if (vista() === 'vendedoras') {
      @if (datos()?.vendedoras) {
        <p class="rk-nota" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i>
          {{ coberturaTexto() }}</p>
      }
      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !filasVendedora().length"
                      emptyIcon="pi-user-edit" [emptyTitle]="'Nadie tiene ventas atribuidas esta semana'"
                      emptyHint="Las cajeras escriben quién vendió cada ticket en «Arqueo › Promociones vendidas». Kepler no lo sabe en el mostrador." (retry)="res.reload()">
        <p-table [value]="filasVendedora()" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack">
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
            <tr>
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
              <th class="comm-num">Sin venta</th>
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
                  <div class="rk-barra" aria-hidden="true"><span [style.width.%]="x.puntaje * 100" [class.ok]="x.puntaje >= 0.9" [class.bajo]="x.puntaje < 0.5"></span></div>
                  <span class="rk-pct">{{ pct(x.puntaje) }}</span>
                } @else {
                  <span class="rk-tenue">Sin objetivos: no se puede medir</span>
                }
              </td>
              <td class="comm-num" data-label="Cumplieron">{{ x.cumplidas }} <span class="rk-tenue">de {{ x.con_objetivo }}</span></td>
              <td class="comm-num" data-label="Venta">{{ x.venta_total | number:'1.0-2' }}</td>
              <td class="comm-num" data-label="Sin venta">{{ x.sin_venta }} <span class="rk-tenue">de {{ x.participantes }}</span></td>
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
              <th class="comm-num">Sin venta</th>
              <th class="comm-num">Sin objetivo</th>
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
                  <div class="rk-barra" aria-hidden="true"><span [style.width.%]="p.puntaje * 100" [class.ok]="p.puntaje >= 0.9" [class.bajo]="p.puntaje < 0.5"></span></div>
                  <span class="rk-pct">{{ pct(p.puntaje) }}</span>
                } @else {
                  <span class="rk-tenue">Sin objetivos: no se puede medir</span>
                }
              </td>
              <td class="comm-num" data-label="Cumplidas">{{ p.cumplidas }} <span class="rk-tenue">de {{ p.con_objetivo }}</span></td>
              <td class="comm-num" data-label="Sin venta">{{ p.sin_venta }}</td>
              <td class="comm-num" data-label="Sin objetivo">@if (p.sin_objetivo) { <p-tag [value]="'' + p.sin_objetivo" severity="warn"></p-tag> } @else { <span class="rk-tenue">—</span> }</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
      }

      @if (datos(); as d) {
        <p class="rk-metodo">{{ d.criterio }}</p>
      }

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
    .rk-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: var(--sp-4) 0 var(--sp-3); }
    .rk-semana { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .rk-semana-txt { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; min-width: 15rem; text-align: center; }
    .rk-filtros--2 { margin-top: 0; }
    .rk-promo-sel { min-width: 18rem; max-width: 26rem; }
    .rk-inline { display: inline; }
    .rk-buscar { min-width: 14rem; margin-left: auto; }
    .rk-nota { display: flex; gap: var(--sp-2); align-items: center; color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-2) 0; }
    .rk-col-lugar { width: 4.5rem; }
    .rk-col-cub { min-width: 14rem; }
    .rk-lugar { font-size: var(--fs-lg); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .rk-nombre { display: block; font-weight: var(--fw-bold); }
    .rk-producto { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    .rk-tenue { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .rk-col-cub { white-space: nowrap; }
    .rk-barra { display: inline-block; vertical-align: middle; width: 8rem; height: 0.5rem; border-radius: var(--r-pill); background: var(--overlay-hover); overflow: hidden; margin-right: var(--sp-2); }
    .rk-barra > span { display: block; height: 100%; background: var(--text-muted); border-radius: var(--r-pill); }
    .rk-barra > span.ok { background: var(--ok-fg); }
    .rk-barra > span.bajo { background: var(--warn-fg); }
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
  readonly datos = computed<RankingSemana | undefined>(() => (this.res.hasValue() ? this.res.value() : undefined));
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
  readonly coberturaTexto = computed(() => {
    const v = this.datos()?.vendedoras;
    if (!v) return '';
    const filas = v.por_sucursal.filter((x) => this.enSucursal(x.warehouse_code));
    const t = filas.reduce((a, x) => a + x.tickets_con_promo, 0);
    const c = filas.reduce((a, x) => a + x.tickets_con_vendedora, 0);
    if (!t) return 'Esta semana no hay tickets de mostrador con estas promociones.';
    const sin = filas.filter((x) => x.tickets_con_vendedora === 0).map((x) => warehouseName(x.warehouse_code));
    return `${c} de ${t} tickets con promoción tienen vendedora (${Math.round((100 * c) / t)} %). El ranking cuenta sólo ésos.`
      + (sin.length ? ` Sin captura: ${sin.join(', ')}.` : '');
  });
  elegirPromo(id: string | null): void { this.cerrarDetalles(); this.promo.set(id || null); }
  elegirSucursales(v: string[] | null): void { this.cerrarDetalles(); this.sucursales.set(v ?? []); }
  elegirEstado(v: string): void { this.estado.set(v as EstadoVenta); }
  abrirPromo(x: PromoEnRanking): void { this.abiertaPromo.set(x); }
  limpiarFiltros(): void {
    this.cerrarDetalles();
    this.promo.set(null); this.sucursales.set([]); this.estado.set('todas'); this.busqueda.set('');
  }
  private cerrarDetalles(): void { this.abierto.set(null); this.abiertaPromo.set(null); }

  readonly opcionesCanal = computed<SegOption[]>(() => CANALES.map((c) => ({ label: CANAL_CORTO[c], value: c })));

  readonly semanaTexto = computed(() => { const d = this.datos(); return d ? textoSemana(d.semana) : ''; });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const sinObj = d.participantes.reduce((a, p) => a + p.sin_objetivo, 0);
    const primero = d.participantes.find((p) => p.lugar === 1);
    return [
      d.promedio_general === null
        ? { label: 'Promedio general', value: 'Sin medir', format: 'text', tone: 'muted', state: 'no_medido', stateNote: 'Ninguna promoción tiene objetivo esta semana.' }
        // `percent` del MetricStrip espera 0–100 (no la fracción).
        : { label: 'Promedio general', value: Math.round(d.promedio_general * 1000) / 10, format: 'percent', tone: d.promedio_general >= 0.9 ? 'ok' : d.promedio_general < 0.5 ? 'warn' : 'default', sub: 'con tope de 100 % por promoción' },
      { label: 'Promociones vigentes', value: d.promos_vigentes, format: 'number', drill: 'promos' } as MetricStripItem,
      { label: 'Sin objetivo', value: sinObj, format: 'number', tone: sinObj ? 'warn' : 'ok', sub: sinObj ? 'no cuentan para el lugar' : 'todas medidas', drill: sinObj ? 'objetivos' : undefined } as MetricStripItem,
      { label: 'Primer lugar', value: primero ? primero.nombre : '—', format: 'text', sub: primero ? pct(primero.puntaje) : 'nadie medible' },
    ];
  });

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
      const otros = CANALES.filter((c) => c !== d.canal);
      const resto = await firstValueFrom(forkJoin(otros.map((c) => this.api.ranking(d.semana.lunes, c).pipe(catchError(() => of(null))))));
      const todos = [d, ...resto.filter((x): x is RankingSemana => !!x)]
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
