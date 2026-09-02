import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { DrawerModule } from 'primeng/drawer';
import { MessageService } from 'primeng/api';
import {
  MarginBand,
  MarginLevel,
  MarginWindow,
  ProfitabilityOverview,
  ProfitabilityRow,
  ProfitabilityService,
} from '../profitability.service';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch, type LazyTableEvent } from '../../../shared/util';

// Producto primero: es el foco de la pantalla. Los agregados son el resumen.
// Sucursal y canal van al final porque cortan por DÓNDE se vendió, no por qué.
const LEVELS: { key: MarginLevel; label: string }[] = [
  { key: 'sku', label: 'Producto' },
  { key: 'brand', label: 'Marca' },
  { key: 'category', label: 'Categoría' },
  { key: 'supplier', label: 'Proveedor' },
  { key: 'warehouse', label: 'Sucursal' },
  { key: 'channel', label: 'Canal' },
];

const WINDOWS: { key: MarginWindow; label: string }[] = [
  { key: '30d', label: '30 días' },
  { key: '90d', label: '90 días' },
  { key: '365d', label: '12 meses' },
];

@Component({
  selector: 'app-comercial-rentabilidad',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    TableModule,
    TooltipModule,
    ToastModule,
    DrawerModule,
    RouterLink,
    MetricStripComponent,
    ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page rp">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Rentabilidad</h1>
          <p class="surf-page-sub">
            Margen sobre venta real
            <span class="rp-sep" aria-hidden="true">·</span>
            de dónde viene y dónde se pierde
          </p>
        </div>
        <div class="rp-head-actions">
          <div class="rp-seg" role="group" aria-label="Ventana">
            @for (w of WINDOWS; track w.key) {
              <button type="button" class="rp-seg-btn" [class.is-on]="window() === w.key"
                      [attr.aria-pressed]="window() === w.key" (click)="setWindow(w.key)">{{ w.label }}</button>
            }
          </div>
          <label class="rp-target" pTooltip="Margen objetivo contra el que se mide la brecha">
            <span>Objetivo</span>
            <input type="number" min="1" max="99" step="0.5" [value]="target()"
                   (change)="setTarget($any($event.target).value)" aria-label="Margen objetivo en porcentaje" />
            <span class="rp-target-pct">%</span>
          </label>
          <button pButton [text]="true" severity="secondary" size="small" (click)="reload()"
                  [loading]="loading()" pTooltip="Refrescar" aria-label="Refrescar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
          <app-context-help topic="rentabilidad" />
        </div>
      </header>

      <!-- ── Veredicto primero: dónde estamos y cuánto falta ──────────────── -->
      @if (overview(); as o) {
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen de rentabilidad" />

        <p class="rp-coverage">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Calculado sobre <b>{{ o.coverage.revenue_pct | number:'1.1-1' }}%</b> de la venta —
          {{ o.coverage.skus_with_cost | number }} de {{ o.coverage.skus_total | number }} SKUs traen costo con qué juzgarlos.
          @if (o.coverage.skus_total > o.coverage.skus_with_cost) {
            Los {{ o.coverage.skus_total - o.coverage.skus_with_cost | number }} restantes venden pero no se pueden evaluar.
          }
          <span class="rp-src">
            venta y costo: <code>sales_daily</code> (lo que cobró el PdV)
            @if (o.data_as_of) { · datos al {{ o.data_as_of }} }
            <!--
              [OBS.6.3] La fecha sola no dice si alcanza. "datos al 26-ago" se lee igual de bien
              un 27 que un 2 de septiembre, y en el segundo caso a la cascada le faltan seis días
              de venta y el margen sale sesgado. Se nombra el rezago.
            -->
            @if (o.freshness?.stale) {
              · <strong class="rp-stale">le faltan días de venta ({{ o.freshness?.age_human || 'sin fact' }})</strong>
            }
            @if (channels(); as ch) { · {{ ch }} }
          </span>
        </p>

        @if (o.cost_quality.conflict_skus) {
          <p class="rp-dq">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <b>{{ o.cost_quality.conflict_skus | number }} SKUs</b> tienen un costo de catálogo que contradice
            al del punto de venta — está capturado en otra unidad (caja contra pieza).
            El margen no los usa, pero <b>{{ o.inventory.unverified | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
            del capital en inventario se valúa con ese costo. Su GMROI queda en blanco.
          </p>
        }

        <!-- Bandas de salud. Cada contador es el filtro que lo abre. -->
        <div class="rp-bands" role="group" aria-label="Salud del margen">
          @for (b of o.bands; track b.key) {
            <button type="button" class="rp-band" [class.is-on]="band() === b.key"
                    [class.tone-bad]="b.tone === 'bad'" [class.tone-warn]="b.tone === 'warn'"
                    [class.tone-ok]="b.tone === 'ok'" [attr.aria-pressed]="band() === b.key"
                    (click)="toggleBand(b.key)">
              <span class="rp-band-n">{{ b.skus | number }}</span>
              <span class="rp-band-l">{{ b.label }}</span>
              <span class="rp-band-v">{{ b.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
            </button>
          }
        </div>
      }

      <!-- ── De donde viene el margen: la cascada, no solo el resultado ───── -->
      @if (overview(); as o) {
        <div class="rp-casc">
          <div class="rp-casc-head">
            <h2>De dónde viene el margen</h2>
            <span class="rp-casc-sub">
              {{ windowLabel() }} · el descuento se gana sobre <b>{{ o.purchases | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> de compras;
              a margen entra solo lo ya vendido
            </span>
          </div>

          <!-- Cascada ciega ≠ cascada en cero. Si la fuente no está cargada, se dice. -->
          @if (o.levers_source_empty) {
            <p class="rp-blind">
              <i class="pi pi-ban" aria-hidden="true"></i>
              <b>No hay ni un ajuste de compra cargado</b> (<code>erp_purchase_adjustments</code> está vacía).
              Las palancas de proveedor de abajo no valen cero: no se están midiendo.
              Falta correr el feed de descuentos.
            </p>
          }

          <div class="rp-casc-rows">
            <div class="rp-cr rp-cr-hd">
              <span></span><span class="rp-cr-a">negociado</span><span class="rp-cr-e">a margen</span><span class="rp-cr-p">pp</span>
            </div>
            <div class="rp-cr is-total">
              <span class="rp-cr-k">Margen comercial bruto</span>
              <span class="rp-cr-a"></span>
              <span class="rp-cr-e">{{ o.margin_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="rp-cr-p">{{ o.margin_pct | number:'1.2-2' }}%</span>
            </div>
            @for (lv of o.levers; track lv.key) {
              <div class="rp-cr" [class.is-zero]="!lv.amount">
                <span class="rp-cr-k">
                  + {{ lv.label }}
                  <small>
                    {{ lv.owner }} @if (lv.docs) { · {{ lv.docs }} docs }
                    @if (lv.rate) { · {{ lv.rate | number:'1.2-2' }}% sobre compras }
                  </small>
                </span>
                <span class="rp-cr-a">{{ lv.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="rp-cr-e">{{ lv.margin_effect | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="rp-cr-p">@if (lv.pp) { +{{ lv.pp | number:'1.2-2' }} }</span>
              </div>
            }
            <div class="rp-cr is-total is-final">
              <span class="rp-cr-k">Margen negociado</span>
              <span class="rp-cr-a">{{ o.levers_amount_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="rp-cr-e">{{ o.margin_negotiated_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="rp-cr-p">{{ o.margin_negotiated_pct | number:'1.2-2' }}%</span>
            </div>

            <!-- ── MR.6: los puntos que faltan, con dueño y aditivos ────────── -->
            <div class="rp-cr">
              <span class="rp-cr-k">
                − Descuento otorgado al cliente
                <small>
                  Comercial · {{ o.customer_discount.docs | number }} facturas ·
                  {{ o.customer_discount.pct_of_invoiced | number:'1.2-2' }}% de lo facturado
                </small>
              </span>
              <span class="rp-cr-a"></span>
              <span class="rp-cr-e">−{{ o.customer_discount.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="rp-cr-p rp-neg">−{{ ppOf(o, o.customer_discount.amount) | number:'1.2-2' }}</span>
            </div>

            <div class="rp-cr is-total">
              <span class="rp-cr-k">
                Margen integral
                <small>Dirección · incompleto: le faltan {{ o.integral_missing.length }} restas sin fuente</small>
              </span>
              <span class="rp-cr-a"></span>
              <span class="rp-cr-e">{{ o.margin_integral_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="rp-cr-p">{{ o.margin_integral_pct | number:'1.2-2' }}%</span>
            </div>

            @if (o.uncollected.amount > 0) {
              <div class="rp-cr">
                <span class="rp-cr-k">
                  + Descuento habitual que no se cobró
                  <small>
                    Compras · {{ o.uncollected.suppliers_below }} de
                    {{ o.uncollected.suppliers_with_policy }} proveedores por debajo de su tasa
                  </small>
                </span>
                <span class="rp-cr-a">{{ o.uncollected.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="rp-cr-e">{{ o.uncollected.margin_effect | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="rp-cr-p">+{{ ppOf(o, o.uncollected.margin_effect) | number:'1.2-2' }}</span>
              </div>
            }

            <div class="rp-cr is-total is-final">
              <span class="rp-cr-k">
                Techo con lo que hoy se puede medir
                <small>si se cobrara todo lo habitual</small>
              </span>
              <span class="rp-cr-a"></span>
              <span class="rp-cr-e"></span>
              <span class="rp-cr-p">{{ ceilingPct(o) | number:'1.2-2' }}%</span>
            </div>

            <div class="rp-cr is-gap">
              <span class="rp-cr-k">
                Sin fuente todavía, vs {{ target() }}%
                <small>Dirección · lo que ninguna palanca medible explica</small>
              </span>
              <span class="rp-cr-a"></span>
              <span class="rp-cr-e"></span>
              <span class="rp-cr-p" [class.tone-bad]="residualPp(o) > 0">
                {{ residualPp(o) > 0 ? '' : '+' }}{{ -residualPp(o) | number:'1.2-2' }} pp
              </span>
            </div>
          </div>

          <!-- Lo que el margen integral NO alcanza a restar. Se declara, no se omite. -->
          <div class="rp-missing">
            <span class="rp-nm-t">El integral está incompleto</span>
            @for (m of o.integral_missing; track m.key) {
              <span class="rp-nm-i"><b>{{ m.label }}</b><small>{{ m.reason }}</small></span>
            }
          </div>

          @if (o.overlap_risk.amount > 0) {
            <p class="rp-dq rp-dq-inline">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <b>{{ o.overlap_risk.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
              del margen negociado podría estar contado dos veces:
              {{ o.overlap_risk.suppliers }} proveedores dan pronto pago por nota de crédito
              <b>y</b> por descuento al pagar. Es el {{ o.overlap_risk.pct_of_levers | number:'1.1-1' }}% de lo negociado —
              el máximo que podría duplicarse, no una certeza.
              <a routerLink="/compras/descuentos">Verificalo en Descuentos</a>.
            </p>
          }

          @if (o.uncollected.top.length) {
            <div class="rp-uncol">
              <span class="rp-nm-t">Quién deja dinero sobre la mesa</span>
              <ul>
                @for (s of o.uncollected.top; track s.supplier_id) {
                  <li>
                    <b>{{ s.name }}</b>
                    <span>suele dar {{ s.rate_pct | number:'1.2-2' }}% y dio
                      {{ 100 * s.taken / (s.purchases || 1) | number:'1.2-2' }}%</span>
                    <em>faltan {{ s.missing | currency:'MXN':'symbol-narrow':'1.0-0' }}</em>
                  </li>
                }
              </ul>
              <p class="rp-muted">{{ o.uncollected.note }}</p>
            </div>
          }

          <!-- Lo que NO es margen. Sumarlo inflaria el resultado. -->
          <div class="rp-nomargin">
            <span class="rp-nm-t">No entra al margen</span>
            <a class="rp-nm-i" routerLink="/compras/descuentos">
              <b>{{ o.non_margin.error_captura.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
              facturas duplicadas
              <small>{{ o.non_margin.error_captura.docs }} docs · es un error a corregir</small>
            </a>
            <span class="rp-nm-i">
              <b>{{ o.non_margin.operacional.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
              fallas de servicio
              <small>{{ o.non_margin.operacional.docs }} docs · faltante, mal estado, devolución</small>
            </span>
            @if (o.promotions.skus_con_promo) {
              <span class="rp-nm-i" pTooltip="El campo benefit de kdpv_descuxq sólo toma los valores 2/3/4/5. No está confirmado que sea un porcentaje, así que no se publica como tal ni se resta del margen.">
                <b>{{ o.promotions.skus_con_promo | number }}</b> SKUs con promoción vigente
                <small>beneficio {{ o.promotions.avg_benefit | number:'1.1-1' }} promedio · unidad sin confirmar</small>
              </span>
            }
          </div>
        </div>
      }

      <!-- ── Desglose ─────────────────────────────────────────────────────── -->
      <div class="rp-toolbar">
        <div class="rp-seg" role="group" aria-label="Nivel">
          @for (l of LEVELS; track l.key) {
            <button type="button" class="rp-seg-btn" [class.is-on]="level() === l.key"
                    [attr.aria-pressed]="level() === l.key" (click)="setLevel(l.key)">{{ l.label }}</button>
          }
        </div>

        @if (crumb(); as c) {
          <button type="button" class="rp-crumb" (click)="clearDrill()">
            <i class="pi pi-filter" aria-hidden="true"></i> {{ c }}
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        }

        <div class="rp-search">
          <i class="pi pi-search rp-search-ico" aria-hidden="true"></i>
          <input type="search" [value]="search" (input)="onSearch($any($event.target).value)"
                 placeholder="Buscar proveedor, marca, SKU…" inputmode="search" autocomplete="off"
                 spellcheck="false" aria-label="Buscar" />
        </div>
      </div>

      <div class="rp-panel">
        <p-table
          [value]="rows()"
          [loading]="loadingRows()"
          [lazy]="true"
          [paginator]="true"
          [rows]="pageSize()"
          [totalRecords]="total()"
          [first]="(page() - 1) * pageSize()"
          [rowsPerPageOptions]="[25, 50, 100]"
          [sortField]="sort()"
          [sortOrder]="dir() === 'desc' ? -1 : 1"
          (onLazyLoad)="onLazy($event)"
          dataKey="id"
          currentPageReportTemplate="{first}–{last} de {totalRecords}"
          [showCurrentPageReport]="true"
          styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first">
          <ng-template #header>
            <tr>
              <th scope="col" class="rp-c-name" pSortableColumn="name">{{ levelLabel() }} <p-sorticon field="name" /></th>
              <th scope="col" class="comm-num" pSortableColumn="revenue">Venta <p-sorticon field="revenue" /></th>
              <th scope="col" class="comm-num" pSortableColumn="cost">Costo <p-sorticon field="cost" /></th>
              @if (level() === 'sku') {
                <th scope="col" class="comm-num rp-c-unit" pSortableColumn="margin_unit"
                    pTooltip="Lo que deja UNA unidad vendida: precio menos costo, los dos en la unidad en que cobra el punto de venta.">
                  Gana por unidad <p-sorticon field="margin_unit" />
                </th>
              }
              <th scope="col" class="comm-num" pSortableColumn="margin_amount">Margen $ <p-sorticon field="margin_amount" /></th>
              <th scope="col" class="comm-num" pSortableColumn="margin_pct">Margen % <p-sorticon field="margin_pct" /></th>
              <th scope="col" class="comm-num rp-c-gap" pSortableColumn="gap_pp"
                  pTooltip="Distancia al objetivo, en puntos">Brecha <p-sorticon field="gap_pp" /></th>
              <th scope="col" class="comm-num" pSortableColumn="gap_amount"
                  pTooltip="Pesos que faltaron para el objetivo. Ordena por tamaño del problema, no por porcentaje.">Brecha $ <p-sorticon field="gap_amount" /></th>
              <th scope="col" class="comm-num" pSortableColumn="inventory_value"
                  pTooltip="Capital comprometido en existencia, al mismo costo">Inventario <p-sorticon field="inventory_value" /></th>
              <th scope="col" class="comm-num" pTooltip="Margen anual generado por peso invertido en inventario. En blanco cuando el costo de valuación no es confiable.">GMROI</th>
              <th scope="col" class="comm-num rp-c-skus" pTooltip="Beneficio de la promoción vigente (kdpv_descuxq), en crudo. La unidad no está confirmada: no es un porcentaje.">Promo</th>
              <th scope="col" class="comm-num rp-c-skus" pSortableColumn="skus">SKUs <p-sorticon field="skus" /></th>
            </tr>
          </ng-template>

          <ng-template #body let-r>
            <tr [class.rp-r-click]="canDrill()" (click)="drill(r)">
              <td>
                <div class="rp-prod">{{ r.name }}</div>
                @if (level() === 'sku') {
                  <div class="rp-sub">
                    @if (r.sku) { <code class="comm-code">{{ r.sku }}</code> }
                    @if (r.brand_name) { <span>{{ r.brand_name }}</span> }
                    @if (r.supplier_name) { <span class="rp-dim">{{ r.supplier_name }}</span> }
                    @if (r.abc_class) { <span class="rp-abc">{{ r.abc_class }}</span> }
                    @if (r.units) { <span class="rp-dim">{{ r.units | number }} u vendidas</span> }
                  </div>
                } @else if (r.skus) {
                  <div class="rp-sub">{{ r.skus | number }} producto{{ r.skus === 1 ? '' : 's' }}</div>
                }
              </td>
              <td class="comm-num">
                {{ r.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}
                @if (r.coverage_pct !== null && r.coverage_pct < 95) {
                  <span class="rp-cov" [pTooltip]="coverageTip(r)">{{ r.coverage_pct | number:'1.0-0' }}%</span>
                }
              </td>
              <td class="comm-num rp-muted">{{ r.cost | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              @if (level() === 'sku') {
                <td class="comm-num rp-c-unit">
                  @if (r.margin_unit !== null) {
                    <span class="rp-unit-m">{{ r.margin_unit | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                    <span class="rp-unit-sub">
                      {{ unitLabel(r) }} · {{ r.price_unit | currency:'MXN':'symbol-narrow':'1.2-2' }}
                      − {{ r.cost_unit | currency:'MXN':'symbol-narrow':'1.2-2' }}
                      @if (r.margin_box !== null) {
                        <br />caja de {{ r.box_factor }}: {{ r.margin_box | currency:'MXN':'symbol-narrow':'1.0-0' }}
                      }
                    </span>
                  } @else { <span class="rp-none">—</span> }
                </td>
              }
              <td class="comm-num">{{ r.margin_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="comm-num">
                @if (r.margin_pct !== null) {
                  <span class="rp-pct" [class.tone-bad]="r.margin_pct < 10" [class.tone-warn]="r.margin_pct >= 10 && r.margin_pct < target()"
                        [class.tone-ok]="r.margin_pct >= target()">{{ r.margin_pct | number:'1.1-1' }}%</span>
                } @else { <span class="rp-none">—</span> }
              </td>
              <td class="comm-num rp-c-gap">
                @if (r.gap_pp !== null) {
                  <span class="rp-gap" [class.is-neg]="r.gap_pp < 0">{{ r.gap_pp > 0 ? '+' : '' }}{{ r.gap_pp | number:'1.1-1' }}</span>
                } @else { <span class="rp-none">—</span> }
              </td>
              <td class="comm-num">
                @if (r.gap_amount !== null && r.gap_amount > 0) {
                  <span class="rp-gapm">{{ r.gap_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                } @else { <span class="rp-none">—</span> }
              </td>
              <td class="comm-num rp-muted">
                @if (r.inventory_value === null) {
                  <span class="rp-none" pTooltip="El inventario no es de un canal: la existencia vive en la sucursal.">n/a</span>
                } @else { {{ r.inventory_value | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                @if (r.cost_conflict_skus) {
                  <i class="pi pi-exclamation-triangle rp-warn-ico" aria-hidden="true"
                     [pTooltip]="conflictTip(r)"></i>
                }
              </td>
              <td class="comm-num">
                @if (r.gmroi !== null) { {{ r.gmroi | number:'1.1-1' }}× }
                @else if (r.cost_conflict_skus) { <span class="rp-none" pTooltip="Sin GMROI: el costo con que se valúa el inventario no coincide con el del punto de venta.">n/d</span> }
                @else { <span class="rp-none">—</span> }
              </td>
              <td class="comm-num rp-c-skus">
                @if (r.promo_benefit !== null) { <span class="rp-promo">{{ r.promo_benefit | number:'1.0-1' }}</span> }
                @else { <span class="rp-none">—</span> }
              </td>
              <td class="comm-num rp-c-skus rp-muted">{{ r.skus | number }}</td>
            </tr>
          </ng-template>

          <ng-template #footer>
            @if (totals(); as t) {
              <tr class="rp-totals">
                <td>Total del filtro</td>
                <td class="comm-num">{{ t.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td></td>
                <!-- El margen unitario no se suma: cada renglón está en su propia unidad. -->
                @if (level() === 'sku') { <td></td> }
                <td class="comm-num">{{ t.margin_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="comm-num">
                  @if (t.margin_pct !== null) { {{ t.margin_pct | number:'1.1-1' }}% }
                </td>
                <td class="comm-num rp-c-gap">
                  @if (t.margin_pct !== null) {
                    <span class="rp-gap" [class.is-neg]="t.margin_pct - target() < 0">{{ t.margin_pct - target() > 0 ? '+' : '' }}{{ t.margin_pct - target() | number:'1.1-1' }}</span>
                  }
                </td>
                <td class="comm-num">
                  @if (t.gap_amount !== null && t.gap_amount > 0) {
                    <span class="rp-gapm">{{ t.gap_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                  }
                </td>
                <td class="comm-num rp-muted">
                  @if (t.inventory_value !== null) { {{ t.inventory_value | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                </td>
                <td colspan="3"></td>
              </tr>
            }
          </ng-template>

          <ng-template #emptymessage>
            <tr>
              <td [attr.colspan]="colCount()" class="comm-empty-cell">
                <div class="comm-empty">
                  <div class="comm-empty-icon"><i class="pi pi-chart-line" aria-hidden="true"></i></div>
                  <h3>{{ hasFilters() ? 'Sin resultados' : 'Sin venta en la ventana' }}</h3>
                  <p>
                    @if (hasFilters()) { Ningún renglón cumple el filtro actual. }
                    @else { No hay venta con costo en los últimos {{ windowLabel() }}. }
                  </p>
                  @if (hasFilters()) {
                    <button type="button" pButton severity="secondary" size="small" [outlined]="true" (click)="clearFilters()">
                      <span class="p-button-label">Quitar filtros</span>
                    </button>
                  }
                </div>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>

      <!-- ── Palancas del proveedor (side-peek) ───────────────────────────── -->
      <p-drawer [visible]="leverOpen()" (visibleChange)="onLeverVisible($event)" position="right"
                styleClass="rp-drawer" [style]="{ width: '520px' }" [header]="levers()?.supplier?.name || 'Proveedor'">
        @if (levers(); as l) {
          <div class="rp-lv">
            <div class="rp-lv-cascade">
              <div class="rp-lv-row">
                <span class="rp-lv-k">Venta {{ windowLabel() }}</span>
                <span class="rp-lv-v">{{ l.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              </div>
              <div class="rp-lv-row is-total">
                <span class="rp-lv-k">Margen comercial bruto</span>
                <span class="rp-lv-v">
                  {{ l.margin_gross_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}
                  <b>{{ l.margin_gross_pct | number:'1.2-2' }}%</b>
                </span>
              </div>

              @for (lever of l.levers; track lever.key) {
                @if (lever.amount) {
                  <div class="rp-lv-row is-lever">
                    <span class="rp-lv-k">
                      + {{ lever.label }}
                      <small>
                        {{ lever.owner }} · {{ lever.docs }} docs
                        @if (lever.rate) { · {{ lever.rate | number:'1.2-2' }}% sobre compras }
                      </small>
                    </span>
                    <span class="rp-lv-v">
                      {{ lever.margin_effect | currency:'MXN':'symbol-narrow':'1.0-0' }}
                      @if (lever.pp !== null) { <b class="tone-ok">+{{ lever.pp | number:'1.2-2' }} pp</b> }
                    </span>
                  </div>
                }
              }

              <div class="rp-lv-row is-total is-final">
                <span class="rp-lv-k">Margen negociado</span>
                <span class="rp-lv-v">
                  {{ l.margin_negotiated_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}
                  <b>{{ l.margin_negotiated_pct | number:'1.2-2' }}%</b>
                </span>
              </div>
            </div>

            @if (l.levers_source_empty) {
              <p class="rp-lv-warn">
                <i class="pi pi-ban" aria-hidden="true"></i>
                <b>No hay ajustes de compra cargados</b> para ningún proveedor
                (<code>erp_purchase_adjustments</code> vacía). Las palancas de arriba
                no son cero: no se están midiendo.
              </p>
            }

            @if (l.overlap_warning) {
              <p class="rp-lv-warn">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Este proveedor da pronto pago por <b>nota de crédito y por descuento al pagar</b>.
                Puede ser el mismo descuento contado dos veces — verificalo en
                <a routerLink="/compras/descuentos">Descuentos</a>, que lo marca como canal “ambos”.
              </p>
            }

            <div class="rp-lv-block">
              <h4>No entra al margen</h4>
              <p>
                <b>{{ l.non_margin.error_captura.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
                en facturas duplicadas ({{ l.non_margin.error_captura.docs }} docs)
              </p>
              <p>
                <b>{{ l.non_margin.operacional.amount | currency:'MXN':'symbol-narrow':'1.0-0' }}</b>
                en fallas de servicio ({{ l.non_margin.operacional.docs }} docs)
              </p>
              <p class="rp-muted">{{ l.non_margin.error_captura.note }}</p>
            </div>

            @if (l.promotions.skus_con_promo) {
              <div class="rp-lv-block">
                <h4>Promoción al cliente</h4>
                <p>
                  <b>{{ l.promotions.skus_con_promo | number }}</b> SKUs con promoción vigente ·
                  beneficio {{ l.promotions.avg_benefit | number:'1.1-1' }} promedio
                  (máx {{ l.promotions.max_benefit | number:'1.0-1' }})
                </p>
                <p class="rp-muted">{{ l.promotions.note }}</p>
              </div>
            }

            @if (l.policy; as pol) {
              <div class="rp-lv-block">
                <h4>Lo pactado</h4>
                <p>
                  Descuento esperado <b>{{ pol.expected_discount_rate | number:'1.2-2' }}%</b>
                  @if (pol.discount_days) { a {{ pol.discount_days }} días }
                  @if (pol.discount_type) { <span class="rp-muted">· {{ pol.discount_type }}</span> }
                </p>
                @if (pol.expected_amount !== null) {
                  <p class="rp-muted">
                    Sobre el costo de la ventana serían {{ pol.expected_amount | currency:'MXN':'symbol-narrow':'1.0-0' }};
                    se cobraron {{ pol.taken_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}.
                    @if (pol.taken_amount < pol.expected_amount) {
                      <b class="tone-bad">Faltan {{ pol.expected_amount - pol.taken_amount | currency:'MXN':'symbol-narrow':'1.0-0' }}.</b>
                    }
                  </p>
                }
              </div>
            } @else {
              <div class="rp-lv-block">
                <h4>Lo pactado</h4>
                <p class="rp-muted">Sin política de descuento capturada para este proveedor.</p>
              </div>
            }

            <div class="rp-lv-block rp-lv-gap">
              <h4>Sin fuente todavía</h4>
              <ul>
                @for (na of l.not_attributed; track na.key) {
                  <li><b>{{ na.key }}</b> — {{ na.reason }}</li>
                }
              </ul>
              <p class="rp-muted">
                Todo lo demás de la cascada ya sale del ODS y está arriba.
              </p>
            </div>

            <div class="rp-lv-meta">
              @if (l.supplier.credit_days) { <span>Crédito {{ l.supplier.credit_days }} d</span> }
              @if (l.supplier.lead_time_days) { <span>Lead time {{ l.supplier.lead_time_days }} d</span> }
              <span>{{ l.skus | number }} SKUs con venta</span>
            </div>
          </div>
        }
      </p-drawer>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .rp-sep { opacity: .4; }
    .rp-none { color: var(--c-text-3); }
    .rp-muted { color: var(--c-text-2); }
    .rp-sub {
      font-size: var(--fs-micro); color: var(--c-text-3);
      display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; margin-top: 1px;
    }
    /* El nombre del producto es el ancla visual de la fila. */
    .rp-prod {
      font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--c-text-1);
      line-height: 1.3;
    }
    .rp-dim { color: var(--c-text-3); }
    .rp-abc {
      font-family: var(--font-mono); font-size: var(--fs-nano); font-weight: var(--fw-bold);
      border: 1px solid var(--c-divider); border-radius: var(--r-sm); padding: 0 3px;
    }

    .rp-head-actions { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }

    /* ── Segmentados ───────────────────────────────────────────────────── */
    .rp-seg { display: inline-flex; border: 1px solid var(--c-divider); border-radius: var(--r-md); overflow: hidden; }
    .rp-seg-btn {
      font: inherit; font-size: var(--fs-xs); font-weight: var(--fw-medium);
      background: none; border: 0; border-right: 1px solid var(--c-divider);
      padding: var(--sp-1) var(--sp-3); cursor: pointer; color: var(--c-text-2);
      transition: background-color var(--dur-micro) var(--ease-standard);
    }
    .rp-seg-btn:last-child { border-right: 0; }
    .rp-seg-btn:hover { background: var(--overlay-hover); }
    .rp-seg-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rp-seg-btn.is-on { background: var(--overlay-selected); color: var(--c-text-1); font-weight: var(--fw-bold); }

    .rp-target {
      display: inline-flex; align-items: center; gap: var(--sp-1);
      border: 1px solid var(--c-divider); border-radius: var(--r-md); padding: 0 var(--sp-2);
      font-size: var(--fs-xs); color: var(--c-text-2);
    }
    .rp-target input {
      width: 3.5rem; border: 0; background: none; font-family: var(--font-mono);
      font-size: var(--fs-sm); color: var(--c-text-1); text-align: right;
      font-variant-numeric: tabular-nums; padding: var(--sp-1) 0;
    }
    .rp-target input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .rp-target-pct { color: var(--c-text-3); }

    /* ── Cobertura: la honestidad del número ───────────────────────────── */
    .rp-coverage {
      margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--c-text-2);
      display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap;
    }
    .rp-coverage i { color: var(--c-text-3); }
    .rp-coverage b { color: var(--c-text-1); }
    .rp-src { color: var(--c-text-3); font-size: var(--fs-micro); }
    /* OBS.6.3 — el rezago del fact. Hereda el tamaño micro de la linea de procedencia pero sube
       el color: es una advertencia sobre el numero de arriba, no una nota al pie mas. */
    .rp-stale { color: var(--warn-soft-fg); font-weight: 600; }
    .rp-src code { font-family: var(--font-mono); font-size: var(--fs-nano); }

    /* Calidad del dato: se declara arriba, no se esconde en un tooltip. */
    .rp-dq {
      margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3);
      font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5;
      background: var(--c-surface-2); border: 1px solid var(--c-divider);
      border-left: 3px solid var(--c-warn); border-radius: var(--r-md);
    }
    .rp-dq i { color: var(--c-warn); margin-right: var(--sp-1); }
    .rp-dq b { color: var(--c-text-1); }

    /* Fuente vacía ≠ resultado en cero. */
    .rp-blind {
      margin: 0; padding: var(--sp-2) var(--sp-4);
      font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5;
      background: var(--c-surface-2); border-bottom: 1px solid var(--c-divider);
    }
    .rp-blind i { color: var(--c-bad); margin-right: var(--sp-1); }
    .rp-blind b { color: var(--c-text-1); }
    .rp-blind code { font-family: var(--font-mono); font-size: var(--fs-nano); }

    .rp-warn-ico { color: var(--c-warn); font-size: var(--fs-nano); margin-left: var(--sp-1); }
    .rp-cov {
      font-size: var(--fs-nano); color: var(--c-warn); margin-left: var(--sp-1);
      font-variant-numeric: tabular-nums;
    }

    /* ── Bandas ────────────────────────────────────────────────────────── */
    .rp-bands { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-4); }
    .rp-band {
      font: inherit; text-align: left; cursor: pointer;
      background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); min-width: 118px;
      display: flex; flex-direction: column; gap: 1px;
      transition: border-color var(--dur-micro) var(--ease-standard);
    }
    .rp-band:hover { border-color: var(--c-text-3); }
    .rp-band:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .rp-band.is-on { border-color: var(--action); box-shadow: inset 0 -2px 0 var(--action); }
    .rp-band-n {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: var(--fw-bold); line-height: 1.1;
    }
    .rp-band.tone-bad  .rp-band-n { color: var(--c-bad); }
    .rp-band.tone-warn .rp-band-n { color: var(--c-warn); }
    .rp-band.tone-ok   .rp-band-n { color: var(--c-ok); }
    .rp-band-l { font-size: var(--fs-micro); color: var(--c-text-2); }
    .rp-band-v { font-size: var(--fs-nano); color: var(--c-text-3); font-variant-numeric: tabular-nums; }

    /* ── Cascada: de donde viene el margen ─────────────────────────────── */
    .rp-casc {
      margin-top: var(--sp-5);
      background: var(--c-surface-1); border: 1px solid var(--c-divider);
      border-radius: var(--r-md); overflow: hidden;
    }
    .rp-casc-head {
      display: flex; align-items: baseline; gap: var(--sp-3); flex-wrap: wrap;
      padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--c-divider);
    }
    .rp-casc-head h2 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-bold); }
    .rp-casc-sub { font-size: var(--fs-micro); color: var(--c-text-3); }
    .rp-casc-rows { padding: 0 var(--sp-4) var(--sp-2); }
    .rp-cr {
      display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem 7.5rem 5rem;
      gap: var(--sp-3); align-items: baseline;
      padding: var(--sp-2) 0; border-bottom: 1px solid var(--c-divider);
    }
    .rp-cr:last-child { border-bottom: 0; }
    .rp-cr.is-zero { opacity: .45; }
    .rp-cr-k { font-size: var(--fs-sm); }
    .rp-cr-k small { display: block; font-size: var(--fs-nano); color: var(--c-text-3); margin-top: 1px; }
    .rp-cr-a, .rp-cr-e, .rp-cr-p {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm); text-align: right; white-space: nowrap;
    }
    .rp-cr-a { color: var(--c-text-3); }
    .rp-cr-e { color: var(--c-text-1); }
    .rp-cr-p { color: var(--c-ok); }
    .rp-cr-hd { border-bottom: 0; padding-bottom: 0; }
    .rp-cr-hd span {
      font-size: var(--fs-nano); text-transform: uppercase; letter-spacing: .06em;
      color: var(--c-text-3); font-family: var(--font-body);
    }
    .rp-cr.is-total { border-top: 2px solid var(--c-text-1); border-bottom: 0; }
    .rp-cr.is-total .rp-cr-k { font-weight: var(--fw-bold); }
    .rp-cr.is-total .rp-cr-p, .rp-cr.is-total .rp-cr-e { color: var(--c-text-1); font-weight: var(--fw-bold); }
    .rp-cr.is-final { border-top-color: var(--action); }
    .rp-cr.is-final .rp-cr-k, .rp-cr.is-final .rp-cr-p, .rp-cr.is-final .rp-cr-e { color: var(--action); }
    .rp-cr.is-gap { border-top: 1px dashed var(--c-divider); }
    .rp-cr.is-gap .rp-cr-p { color: var(--c-text-2); font-weight: var(--fw-bold); }
    .rp-cr.is-gap .rp-cr-p.tone-bad { color: var(--c-bad); }

    /* Lo que NO es margen: visible para que nadie lo sume por error. */
    .rp-nomargin {
      display: flex; gap: var(--sp-4); flex-wrap: wrap; align-items: flex-start;
      padding: var(--sp-3) var(--sp-4); background: var(--c-surface-2);
      border-top: 1px solid var(--c-divider);
    }
    .rp-nm-t {
      font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em;
      color: var(--c-text-3); font-weight: var(--fw-bold); align-self: center;
    }
    .rp-nm-i { font-size: var(--fs-xs); color: var(--c-text-2); text-decoration: none; }
    .rp-nm-i b { font-family: var(--font-mono); color: var(--c-text-1); font-variant-numeric: tabular-nums; }
    .rp-nm-i small { display: block; font-size: var(--fs-nano); color: var(--c-text-3); }
    a.rp-nm-i:hover b { color: var(--action); }
    a.rp-nm-i:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    /* Valor crudo, no un descuento: sin color de alarma hasta confirmar la unidad. */
    /* Valor crudo, no un descuento: sin color de alarma hasta confirmar la unidad. */
    .rp-promo { color: var(--c-text-2); font-variant-numeric: tabular-nums; }
    .rp-cr-p.rp-neg { color: var(--c-warn); }

    /* Lo que el integral no alcanza a restar: se declara al pie de su cascada. */
    .rp-missing {
      display: flex; gap: var(--sp-4); flex-wrap: wrap; align-items: flex-start;
      padding: var(--sp-3) var(--sp-4); background: var(--c-surface-2);
      border-top: 1px solid var(--c-divider);
    }
    .rp-dq-inline { margin: 0; border-radius: 0; border-left: 0; border-top: 0; }
    .rp-dq-inline a { color: var(--action); }

    .rp-uncol { padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--c-divider); }
    .rp-uncol ul { list-style: none; margin: var(--sp-2) 0 var(--sp-2); padding: 0; }
    .rp-uncol li {
      display: flex; gap: var(--sp-3); align-items: baseline; flex-wrap: wrap;
      padding: var(--sp-1) 0; border-bottom: 1px solid var(--c-divider); font-size: var(--fs-xs);
    }
    .rp-uncol li:last-child { border-bottom: 0; }
    .rp-uncol li b { color: var(--c-text-1); font-weight: var(--fw-medium); min-width: 16rem; }
    .rp-uncol li span { color: var(--c-text-3); font-variant-numeric: tabular-nums; }
    .rp-uncol li em {
      margin-left: auto; font-style: normal; color: var(--c-bad);
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    }
    .rp-uncol p { margin: 0; font-size: var(--fs-nano); }

    /* ── Toolbar ───────────────────────────────────────────────────────── */
    .rp-toolbar {
      display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap;
      margin-top: var(--sp-5); margin-bottom: var(--sp-3);
    }
    .rp-crumb {
      font: inherit; font-size: var(--fs-xs); cursor: pointer;
      background: var(--overlay-selected); border: 1px solid var(--c-divider);
      border-radius: 100px; padding: var(--sp-1) var(--sp-3);
      display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--c-text-1);
    }
    .rp-crumb:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .rp-crumb i { font-size: var(--fs-nano); color: var(--c-text-3); }

    .rp-search { position: relative; margin-left: auto; }
    .rp-search input {
      font: inherit; font-size: var(--fs-sm); width: 260px; max-width: 42vw;
      padding: var(--sp-1) var(--sp-2) var(--sp-1) 2rem;
      border: 1px solid var(--c-divider); border-radius: var(--r-md);
      background: var(--c-surface-1); color: var(--c-text-1);
    }
    .rp-search input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; }
    .rp-search-ico {
      position: absolute; left: var(--sp-2); top: 50%; transform: translateY(-50%);
      color: var(--c-text-3); font-size: var(--fs-xs);
    }

    /* ── Tabla ─────────────────────────────────────────────────────────── */
    .rp-panel {
      background: var(--c-surface-1); border: 1px solid var(--c-divider);
      border-radius: var(--r-md); overflow: hidden;
    }
    .rp-c-name { min-width: 300px; }
    .rp-c-gap, .rp-c-skus { width: 5.5rem; }

    /* El número del mostrador: se lee primero, con su cuenta abajo en chico. */
    .rp-c-unit { width: 9.5rem; }
    .rp-unit-m {
      display: block; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1);
    }
    .rp-unit-sub {
      display: block; font-size: var(--fs-nano); color: var(--c-text-3);
      font-variant-numeric: tabular-nums; line-height: 1.35; margin-top: 1px;
    }
    .rp-r-click { cursor: pointer; }
    .rp-pct, .rp-gap { font-variant-numeric: tabular-nums; font-weight: var(--fw-medium); }
    .rp-pct.tone-bad, .rp-gap.is-neg { color: var(--c-bad); }
    .rp-pct.tone-warn { color: var(--c-warn); }
    .rp-pct.tone-ok { color: var(--c-ok); }
    .rp-gapm { color: var(--c-bad); font-variant-numeric: tabular-nums; }
    .rp-totals td {
      font-weight: var(--fw-bold); background: var(--c-surface-2);
      border-top: 2px solid var(--c-text-1);
    }

    /* ── Side-peek de palancas ─────────────────────────────────────────── */
    .rp-lv { display: flex; flex-direction: column; gap: var(--sp-5); }
    .rp-lv-cascade { display: flex; flex-direction: column; }
    .rp-lv-row {
      display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3);
      padding: var(--sp-2) 0; border-bottom: 1px solid var(--c-divider);
    }
    .rp-lv-k { font-size: var(--fs-sm); }
    .rp-lv-k small { display: block; font-size: var(--fs-nano); color: var(--c-text-3); margin-top: 1px; }
    .rp-lv-v {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm); white-space: nowrap; text-align: right;
    }
    .rp-lv-v b { display: block; font-size: var(--fs-md); font-weight: var(--fw-bold); }
    .rp-lv-v b.tone-ok { color: var(--c-ok); font-size: var(--fs-xs); }
    .rp-lv-row.is-total { border-top: 2px solid var(--c-text-1); border-bottom: 0; padding-top: var(--sp-3); }
    .rp-lv-row.is-final { border-top-color: var(--action); }
    .rp-lv-row.is-final .rp-lv-k { color: var(--action); font-weight: var(--fw-bold); }
    .rp-lv-row.is-lever .rp-lv-k { color: var(--c-text-2); }

    .rp-lv-warn {
      margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs);
      background: var(--c-surface-2); border: 1px solid var(--c-warn);
      border-radius: var(--r-md); color: var(--c-text-2);
    }
    .rp-lv-warn i { color: var(--c-warn); margin-right: var(--sp-1); }
    .rp-lv-warn b { color: var(--c-text-1); }
    .rp-lv-block p b.tone-bad { color: var(--c-bad); }

    .rp-lv-block h4 {
      margin: 0 0 var(--sp-2); font-size: var(--fs-micro); text-transform: uppercase;
      letter-spacing: .06em; color: var(--c-text-3); font-weight: var(--fw-bold);
    }
    .rp-lv-block p { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); }
    .rp-lv-gap ul { margin: 0; padding-left: 1.1rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .rp-lv-gap li { margin-bottom: var(--sp-1); }
    .rp-lv-gap li b { font-family: var(--font-mono); color: var(--c-text-1); font-weight: var(--fw-medium); }
    .rp-lv-meta {
      display: flex; gap: var(--sp-3); flex-wrap: wrap;
      font-size: var(--fs-micro); color: var(--c-text-3);
      border-top: 1px solid var(--c-divider); padding-top: var(--sp-3);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialRentabilidadComponent {
  private readonly api = inject(ProfitabilityService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(MessageService);

  readonly LEVELS = LEVELS;
  readonly WINDOWS = WINDOWS;

  readonly window = signal<MarginWindow>('30d');
  readonly target = signal(15);
  readonly level = signal<MarginLevel>('sku');
  readonly band = signal<MarginBand | null>(null);
  readonly supplierId = signal<string | null>(null);
  readonly supplierName = signal<string | null>(null);
  readonly brandId = signal<string | null>(null);
  readonly brandName = signal<string | null>(null);
  readonly warehouseId = signal<string | null>(null);
  readonly warehouseName = signal<string | null>(null);
  readonly channel = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly sort = signal('revenue');
  readonly dir = signal<'asc' | 'desc'>('desc');
  search = '';
  readonly searchTerm = signal('');

  private readonly tick = signal(0);

  // ── Resumen ───────────────────────────────────────────────────────────
  private readonly ovRes = rxResource({
    params: () => ({ w: this.window(), t: this.target(), k: this.tick() }),
    stream: ({ params }) => this.api.overview({ window: params.w, target: params.t }),
  });
  readonly overview = computed(() => this.ovRes.value() ?? null);
  readonly loading = computed(() => this.ovRes.isLoading());

  /** KPIs con el veredicto: cuánto vendemos, qué margen deja, cuánto falta. */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const o = this.overview();
    if (!o) return [];
    const gap = o.gap_pp ?? 0;
    return [
      { label: `Venta ${this.windowLabel()}`, value: o.revenue, format: 'currency-short' },
      {
        label: 'Margen comercial bruto',
        value: o.margin_pct ?? 0,
        format: 'percent',
        tone: (o.margin_pct ?? 0) >= this.target() ? 'ok' : (o.margin_pct ?? 0) >= 10 ? 'warn' : 'bad',
        sub: this.fmtShort(o.margin_amount),
      },
      {
        label: 'Margen negociado',
        value: o.margin_negotiated_pct ?? 0,
        format: 'percent',
        tone: (o.margin_negotiated_pct ?? 0) >= this.target() ? 'ok' : 'warn',
        sub: 'con palancas de proveedor',
      },
      {
        label: `Brecha vs ${this.target()}%`,
        value: o.gap_pp_negotiated ?? gap,
        format: 'decimal1',
        tone: gap < 0 ? 'bad' : 'ok',
        sub: o.gap_amount && o.gap_amount > 0 ? `${this.fmtShort(o.gap_amount)} sin generar` : 'objetivo cubierto',
      },
      {
        label: 'Capital en inventario',
        value: o.inventory.total,
        format: 'currency-short',
        // El KPI cubre TODO el stock; la tabla sólo lo que vendió. Decir cuánto
        // es stock muerto es lo que hace que los dos números cuadren a la vista.
        sub: o.inventory.no_sales > 0
          ? `${this.fmtShort(o.inventory.no_sales)} sin venta en la ventana`
          : o.inventory_days ? `${Math.round(o.inventory_days)} días de costo` : undefined,
      },
    ];
  });

  /** Canales que alimentan la ventana. Sin esto, "cobertura" no dice de qué. */
  readonly channels = computed(() => {
    const ch = this.overview()?.coverage.channels ?? [];
    if (!ch.length) return null;
    return ch.map((c) => c.channel).join(' + ');
  });

  // ── MR.6: el puente se lee en puntos sobre la MISMA venta, o no cierra ────
  ppOf(o: ProfitabilityOverview, amount: number): number {
    return o.revenue > 0 ? (amount / o.revenue) * 100 : 0;
  }

  /** Margen integral + lo que se recuperaría cobrando la tasa habitual. */
  ceilingPct(o: ProfitabilityOverview): number {
    return (o.margin_integral_pct ?? 0) + this.ppOf(o, o.uncollected.margin_effect);
  }

  /** Lo que ninguna palanca medible explica. Positivo = todavía falta. */
  residualPp(o: ProfitabilityOverview): number {
    return this.target() - this.ceilingPct(o);
  }

  /** 11 columnas fijas + la de margen unitario, que sólo existe a nivel producto. */
  readonly colCount = computed(() => (this.level() === 'sku' ? 12 : 11));

  /**
   * Cómo se cobra esa unidad. `weight` es kilo; `piece` es la unidad en que
   * factura el PdV (paquete o pieza según el SKU) y no se puede nombrar más
   * fino sin mentir: `unit_sale` del catálogo dice PZA donde Kepler dice PAQ.
   */
  unitLabel(r: ProfitabilityRow): string {
    return r.unit_kind === 'weight' ? 'por kilo' : 'por unidad vendida';
  }

  conflictTip(r: ProfitabilityRow): string {
    return r.skus === 1
      ? 'El costo de catálogo de este SKU está en otra unidad que la venta: el inventario valuado no es confiable.'
      : `${r.cost_conflict_skus} de ${r.skus} SKUs valúan con un costo que el punto de venta contradice.`;
  }

  coverageTip(r: ProfitabilityRow): string {
    return `Sólo el ${Math.round(r.coverage_pct ?? 0)}% de esta venta trae costo. El margen se mide sobre esa parte.`;
  }

  private fmtShort(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
    return `$${n.toFixed(0)}`;
  }

  // ── Desglose ──────────────────────────────────────────────────────────
  private readonly params = computed(() => ({
    window: this.window(),
    level: this.level(),
    target: this.target(),
    search: this.searchTerm() || undefined,
    band: this.band(),
    supplier_id: this.supplierId(),
    brand_id: this.brandId(),
    warehouse_id: this.warehouseId(),
    channel: this.channel(),
    page: this.page(),
    pageSize: this.pageSize(),
    sort: this.sort(),
    dir: this.dir(),
    _k: this.tick(),
  }));

  private readonly bdRes = rxResource({
    params: () => this.params(),
    stream: ({ params }) => this.api.breakdown(params),
  });
  readonly rows = computed<ProfitabilityRow[]>(() => this.bdRes.value()?.data ?? []);
  readonly total = computed(() => this.bdRes.value()?.pagination?.total ?? 0);
  readonly totals = computed(() => this.bdRes.value()?.totals ?? null);
  readonly loadingRows = computed(() => this.bdRes.isLoading());

  readonly levelLabel = computed(() => LEVELS.find((l) => l.key === this.level())?.label ?? '');
  readonly windowLabel = computed(() => WINDOWS.find((w) => w.key === this.window())?.label ?? '');
  readonly canDrill = computed(() =>
    (['supplier', 'brand', 'warehouse', 'channel'] as MarginLevel[]).includes(this.level()),
  );
  readonly hasFilters = computed(
    () =>
      !!this.band() || !!this.searchTerm() || !!this.supplierId() || !!this.brandId() ||
      !!this.warehouseId() || !!this.channel(),
  );
  readonly crumb = computed(
    () => this.supplierName() ?? this.brandName() ?? this.warehouseName() ?? this.channel(),
  );

  // ── Palancas ──────────────────────────────────────────────────────────
  readonly leverOpen = signal(false);
  private readonly leverId = signal<string | null>(null);
  private readonly leverRes = rxResource({
    params: () => {
      const id = this.leverId();
      return id ? { id, w: this.window(), t: this.target() } : undefined;
    },
    stream: ({ params }) => this.api.supplierLevers(params.id, { window: params.w, target: params.t }),
  });
  readonly levers = computed(() => this.leverRes.value() ?? null);

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    const w = q.get('window') as MarginWindow | null;
    if (w && WINDOWS.some((x) => x.key === w)) this.window.set(w);
    const lv = q.get('level') as MarginLevel | null;
    if (lv && LEVELS.some((x) => x.key === lv)) this.level.set(lv);
    const t = Number(q.get('target'));
    if (t > 0 && t < 100) this.target.set(t);
    const b = q.get('band') as MarginBand | null;
    if (b) this.band.set(b);
    if (q.get('supplier_id')) {
      this.supplierId.set(q.get('supplier_id'));
      this.supplierName.set(q.get('supplier_name'));
    }
    if (q.get('brand_id')) {
      this.brandId.set(q.get('brand_id'));
      this.brandName.set(q.get('brand_name'));
    }
    if (q.get('warehouse_id')) {
      this.warehouseId.set(q.get('warehouse_id'));
      this.warehouseName.set(q.get('warehouse_name'));
    }
    if (q.get('channel')) this.channel.set(q.get('channel'));
    const term = q.get('q') ?? '';
    if (term) { this.search = term; this.searchTerm.set(term); }

    effect(() => {
      if (this.ovRes.error() || this.bdRes.error()) {
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la rentabilidad' });
      }
    });
  }

  reload(): void {
    this.tick.update((t) => t + 1);
  }

  setWindow(w: MarginWindow): void { this.window.set(w); this.resetPage(); }
  setLevel(l: MarginLevel): void { this.level.set(l); this.resetPage(); }

  setTarget(v: string): void {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      this.toast.add({ severity: 'warn', summary: 'Objetivo inválido', detail: 'Tiene que estar entre 1 y 99.' });
      return;
    }
    this.target.set(Math.round(n * 10) / 10);
    this.syncUrl();
  }

  toggleBand(b: MarginBand): void {
    this.band.set(this.band() === b ? null : b);
    this.resetPage();
  }

  /** Bajar de nivel manteniendo el contexto: el filtro viaja, no se pierde. */
  drill(r: ProfitabilityRow): void {
    const lv = this.level();
    if (lv === 'supplier') {
      this.leverId.set(r.id);
      this.leverOpen.set(true);
      return;
    }
    if (lv === 'brand') {
      this.brandId.set(r.id);
      this.brandName.set(r.name);
    } else if (lv === 'warehouse') {
      this.warehouseId.set(r.id);
      this.warehouseName.set(r.name);
    } else if (lv === 'channel') {
      // A nivel canal el `id` ES el canal: no hay catálogo detrás.
      this.channel.set(r.id);
    } else {
      return;
    }
    this.level.set('sku');
    this.resetPage();
  }

  clearDrill(): void {
    this.supplierId.set(null);
    this.supplierName.set(null);
    this.brandId.set(null);
    this.brandName.set(null);
    this.warehouseId.set(null);
    this.warehouseName.set(null);
    this.channel.set(null);
    this.resetPage();
  }

  clearFilters(): void {
    this.band.set(null);
    this.search = '';
    this.searchTerm.set('');
    this.clearDrill();
  }

  onLeverVisible(v: boolean): void {
    this.leverOpen.set(v);
    if (!v) this.leverId.set(null);
  }

  onSearch(v: string): void { this.search = v; this.searchDebounced(v); }
  private readonly searchDebounced = makeDebouncedSearch((v: string) => {
    this.searchTerm.set((v || '').trim());
    this.resetPage();
  });

  onLazy(e: LazyTableEvent): void {
    const rows = e.rows ?? this.pageSize();
    const field = (Array.isArray(e.sortField) ? e.sortField[0] : e.sortField) || 'revenue';
    const dir: 'asc' | 'desc' = (e.sortOrder ?? -1) < 0 ? 'desc' : 'asc';
    const changed = field !== this.sort() || dir !== this.dir();
    this.sort.set(field);
    this.dir.set(dir);
    this.pageSize.set(rows);
    this.page.set(changed ? 1 : Math.floor((e.first ?? 0) / rows) + 1);
    this.syncUrl();
  }

  private resetPage(): void {
    this.page.set(1);
    this.syncUrl();
  }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        window: this.window() === '30d' ? null : this.window(),
        level: this.level() === 'sku' ? null : this.level(),
        target: this.target() === 15 ? null : this.target(),
        band: this.band() || null,
        supplier_id: this.supplierId() || null,
        supplier_name: this.supplierName() || null,
        brand_id: this.brandId() || null,
        brand_name: this.brandName() || null,
        warehouse_id: this.warehouseId() || null,
        warehouse_name: this.warehouseName() || null,
        channel: this.channel() || null,
        q: this.searchTerm() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
