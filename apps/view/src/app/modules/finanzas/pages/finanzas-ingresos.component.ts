import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TableModule } from 'primeng/table';
import { TreeTableModule } from 'primeng/treetable';
import { ChartModule } from 'primeng/chart';
import { TreeNode } from 'primeng/api';
import {
  ComercialService, IncomeGrain, IncomeGroupBy, IncomeParams, IncomeRecon, IncomeReport, IncomeRow, IncomeSources,
  IncomeTree, IncomeTreeNode, IncomeDocumento as IncomeDocumentoT,
} from '../../comercial/comercial.service';
import { SALES_CANAL_ORDER, SALES_CANAL_SHORT, salesCanalLabel, type SalesCanal } from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ThemeService } from '../../../core/services/theme.service';
import { egresChartOptions, egresChartSeries } from '../../comercial/pages/egresos-chart-opts';

/**
 * `[IG.2]` Ingresos contables — el otro lado del libro de `/finanzas/egresos`.
 *
 * ── POR QUÉ NO ES LA MISMA PANTALLA, AUNQUE LO PAREZCA ───────────────────────────────────
 * Reusa los mismos organismos (métricas, segmentado, píldora de frescura, opciones de gráfica,
 * banda de cobertura) pero **no las mismas dimensiones**, porque del lado del ingreso casi ninguna
 * mide. Medido en prod el 2026-09-25:
 *
 *   · la `sucursal` es SIEMPRE `00` — la venta se contabiliza centralizada en el CEDIS, y es el
 *     filtro que evita contar la misma venta hasta 7 veces (+69 %);
 *   · `área`, `departamento` y `concepto` vienen del ciclo de solicitud de gasto → vacíos;
 *   · el nombre de la cuenta MIENTE: `401-002` se llama «VENTA FLETES A TERCEROS» y no es fletes;
 *     `401-003` es «VECINAL» en unas sucursales y «MAYOREO» en otras.
 *
 * Lo que sí discrimina —y de ahí salen el árbol y la tabla— es **canal → plaza**, que vive en el
 * concepto `c6` de la póliza.
 *
 * La fuente es `analytics.income_entries_src()`: derivación viva sobre el ODS, no una tabla de
 * importer, así que la frescura es de minutos y no de la noche anterior.
 */
@Component({
  selector: 'app-finanzas-ingresos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, DialogModule, MultiSelectModule, SelectModule,
    DatePickerModule, InputNumberModule, InputTextModule, ToggleSwitchModule,
    TableModule, TreeTableModule, ChartModule,
    SegmentedComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <div style="display:inline-flex;align-items:center;gap:.4rem">
            <h1>Ingresos contables</h1>
            @if (report(); as r) { <app-freshness-pill measures="data" [freshness]="r.freshness" label="ingresos" /> }
          </div>
          <p class="surf-page-sub">Pólizas de venta (401) del CEDIS · desglose por canal y plaza · derivado del ODS al minuto</p>
        </div>
        <button pButton type="button" class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">Exportar CSV</span></button>
      </header>

      <div class="in-filters card-premium card-flat">
        <div class="in-field"><label>Canal</label>
          <p-multiselect [options]="canalOpts" [(ngModel)]="canal" optionLabel="label" optionValue="value" placeholder="Todos" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queueFilter()" /></div>
        <div class="in-field"><label>Mes</label>
          <p-select [options]="mesOpts" [(ngModel)]="mesSel" optionLabel="label" optionValue="value" [showClear]="true" placeholder="—" appendTo="body" (onChange)="pickMes($event.value)" styleClass="w-full" [filter]="true" /></div>
        <div class="in-field"><label>Rango</label>
          <p-datepicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="onRangeChange()" /></div>
        <div class="in-field"><label>Concepto / cliente</label>
          <input pInputText [(ngModel)]="concepto" placeholder="Buscar…" (keyup.enter)="applyFilters()" (blur)="queueFilter()" /></div>
        <div class="in-field in-narrow"><label>Monto ≥</label>
          <p-inputnumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="queueFilter()" /></div>
        <div class="in-field in-toggle"><label>Comparar</label>
          <p-toggleswitch [(ngModel)]="compare" (ngModelChange)="queueFilter()" /></div>
      </div>

      @if (report()) { <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de ingresos" /> }

      <!-- Cobertura declarada: mismo motor que Egresos, etiquetado en PLAZAS. -->
      @if (coverageAviso(); as cov) {
        <div class="in-cov" role="note">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <div class="in-cov-body">
            @if (cov.comp; as c) {
              <div class="in-cov-delta">
                <span>Δ vs período previo: <strong class="in-cov-all">{{ signo(c.delta_pct) }}</strong> con todas las plazas,
                  <strong class="in-cov-ok">{{ signo(c.delta_pct_comparable) }}</strong> con las que reportan en ambos períodos.</span>
              </div>
              @if (c.solo_actual.length) {
                <div>Plazas nuevas en este período: <strong>{{ lista(c.solo_actual) }}</strong> — su venta sube el total sin que las demás hayan vendido más.</div>
              }
              @if (c.solo_previo.length) {
                <div>Dejaron de reportar: <strong>{{ c.solo_previo.join(', ') }}</strong>.</div>
              }
            }
            <div>{{ cov.note }}</div>
            @if (cov.meses_parciales.length) {
              <div>Meses incompletos en la tendencia: <strong>{{ cov.meses_parciales.join(', ') }}</strong> — su barra es más baja por calendario.</div>
            }
            @if (cov.pct !== null) {
              <div class="muted">Comparable mes a mes: <strong>{{ cov.pct }}%</strong> del importe del rango ({{ cov.grupos_todos.length }} de {{ cov.grupos.length }} plazas en todos los meses).</div>
            }
          </div>
        </div>
      }

      <div class="in-viewbar">
        <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista" />
        @if (view() === 'tabla') {
          <div class="in-dim">
            <label>Agrupar por</label>
            <p-select [options]="groupByOpts" [ngModel]="groupBy()" (ngModelChange)="setGroupBy($event)" optionLabel="label" optionValue="value" appendTo="body" />
          </div>
        }
      </div>

      @if (loading()) {
        <div class="in-empty">Cargando…</div>
      } @else if (error()) {
        <app-load-state [error]="error()" (retry)="reload()"></app-load-state>
      } @else {
        @if (view() === 'arbol') {
          <!-- [IG.9] Canal › período › folio › depósito. Los dos de abajo se piden AL ABRIR: un
               canal de 90 días son miles de documentos y decenas de miles de depósitos.
               ⚠️ Los anchos van en el <th> Y en el <td>. Con [scrollable] PrimeNG renderiza
               encabezado y cuerpo como DOS tablas separadas, así que el width del <th> no llega
               al <td> y las columnas quedan corridas respecto de su título. -->
          <div class="in-grainbar">
            <app-segmented [options]="treeGrainOpts" [value]="treeGrain()"
                           (valueChange)="setTreeGrain($event)" ariaLabel="Grano del árbol" />
            <span class="in-hint">
              @if (treeGrain() === 'dia') {
                El canal abre a su sucursal, ruta o repartidor; ése a sus días; el día a sus folios;
                y cada folio a los depósitos que se casaron contra él.
              } @else {
                Con este grano el árbol llega hasta el período. Para bajar a folio y a depósito, poné Día.
              }
            </span>
          </div>
          <p-treetable [value]="treeNodes()" [scrollable]="true" styleClass="p-treetable-sm in-table"
                       (onNodeExpand)="onTreeExpand($event)">
            <ng-template #header>
              <tr>
                <th>Canal · sucursal, ruta o repartidor · día · folio · depósito</th>
                <th class="ta-r" style="width:6rem">Docs</th>
                <th class="ta-r" style="width:10rem">Importe</th>
                <th class="ta-r" style="width:10rem">Cobrado</th>
                <th class="ta-r" style="width:10rem">Pendiente</th>
                <th style="width:15rem">Cómo entró</th>
                <th class="ta-r" style="width:5rem">%</th>
              </tr>
            </ng-template>
            <ng-template #body let-rowNode let-rowData="rowData">
              <tr [ttRow]="rowNode" [class.in-cancel]="rowData.cancelado">
                <td>
                  <p-treetabletoggler [rowNode]="rowNode" />
                  <span [class.strong]="rowData.level === 'canal'">{{ rowData.label }}</span>
                  @if (rowData.residuo) { <span class="in-tag">residuo</span> }
                  @if (rowData.kind) {
                    <span class="in-kind" [class.in-kind-int]="rowData.cancelado">{{ rowData.kind }}</span>
                  }
                  @if (rowData.level === 'folio') {
                    <button type="button" class="in-verdoc" (click)="verDocumento(rowData, $event)"
                            [attr.aria-label]="'Ver el documento ' + rowData.label">Ver documento</button>
                  }
                  @if (rowData.sub) { <span class="in-sub">{{ rowData.sub }}</span> }
                </td>
                <td class="ta-r" style="width:6rem">{{ rowData.movs | number }}</td>
                <td class="ta-r strong" style="width:10rem">{{ money(rowData.total) }}</td>
                <td class="ta-r" style="width:10rem">
                  {{ rowData.cobrado === null || rowData.cobrado === undefined ? '' : money(rowData.cobrado) }}
                </td>
                <td class="ta-r" style="width:10rem" [class.in-deuda]="rowData.pendiente > 0">
                  {{ rowData.pendiente === null || rowData.pendiente === undefined ? '' : money(rowData.pendiente) }}
                </td>
                <td style="width:15rem" class="muted in-como">{{ rowData.como }}</td>
                <td class="ta-r muted" style="width:5rem">{{ rowData.share_pct }}%</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7" class="in-empty">Sin ingresos en el período.</td></tr></ng-template>
          </p-treetable>
        }

        @if (view() === 'tabla' && report(); as r) {
          <p-table [value]="r.rows" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm in-table" [rowHover]="true"
                   [paginator]="r.rows.length > 50" [rows]="50" sortField="total" [sortOrder]="-1">
            <ng-template #header>
              <tr>
                <th pSortableColumn="label">{{ groupByLabel() }}</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="movs">Docs</th>
                <th class="ta-r" style="width:12rem" pSortableColumn="total">Importe</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="share_pct">%</th>
                @if (compare()) { <th class="ta-r" style="width:8rem" pSortableColumn="delta_pct">Δ vs prev</th> }
              </tr>
            </ng-template>
            <ng-template #body let-row>
              <tr>
                <td>
                  {{ row.label }}
                  @if (canalShort(row.canal); as tag) { <span class="in-tag">{{ tag }}</span> }
                </td>
                <td class="ta-r">{{ row.movs | number }}</td>
                <td class="ta-r strong">{{ money(row.total) }}</td>
                <td class="ta-r muted">{{ row.share_pct }}%</td>
                @if (compare()) {
                  <td class="ta-r" [class.up]="row.delta_pct > 0" [class.down]="row.delta_pct < 0">
                    {{ row.delta_pct === null ? '—' : (row.delta_pct > 0 ? '+' : '') + row.delta_pct + '%' }}
                  </td>
                }
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td [attr.colspan]="compare() ? 5 : 4" class="in-empty">Sin ingresos en el período.</td></tr></ng-template>
          </p-table>
        }

        @if (view() === 'tendencia') {
          <div class="card-premium card-flat in-chart">
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts()" height="360px"></p-chart>
          </div>
        }

        <!-- [IG.3] CUADRE DE FUENTES — cuatro caminos al mismo peso de venta. -->
        @if (view() === 'cuadre') {
          @if (sources(); as s) {
            <div class="card-premium card-flat">
              <p-table [value]="s.fuentes" styleClass="p-datatable-sm in-table">
                <ng-template #header>
                  <tr><th>Fuente</th><th class="ta-r" style="width:13rem">Importe</th><th class="ta-r" style="width:8rem">Δ vs contable</th><th>Qué significa</th></tr>
                </ng-template>
                <ng-template #body let-f>
                  <tr [class.in-nocomp]="!f.comparable">
                    <td class="strong">{{ f.label }}</td>
                    <td class="ta-r strong">{{ f.monto === null ? 'NO MEDIDO' : money(f.monto) }}</td>
                    <td class="ta-r" [class.muted]="!f.comparable">
                      {{ f.monto === null || !f.comparable ? '—' : signo(f.delta_pct) }}
                    </td>
                    <td class="muted">{{ f.nota }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          } @else {
            <div class="in-empty">Cargando el cuadre…</div>
          }
        }

        <!-- [IG.7] CONCILIACION — el ingreso LIGADO a su documento, su cliente y su cobro.
             Misma plaza y mismo canal que el Arbol: la liga es por FOLIO, asi que el renglon de
             aca cuadra al centavo con el de alla. Vendido y cobrado NO se obligan a ser iguales:
             la diferencia es plazo de credito, y se publica como columna propia. -->
        @if (view() === 'conciliacion') {
          @if (recon(); as rc) {
            <div class="in-grainbar">
              <app-segmented [options]="grainOpts" [value]="grain()" (valueChange)="setGrain($event)" ariaLabel="Grano" />
              @if (rc.totales.docs > rc.totales.docs_ligados) {
                <span class="in-warn">
                  {{ rc.totales.docs - rc.totales.docs_ligados }} de {{ rc.totales.docs }} pólizas no
                  encontraron su factura — van declaradas abajo, sin cliente ni cobro inventado.
                </span>
              }
            </div>

            <div class="card-premium card-flat in-bridge">
              @for (b of rc.bridge; track b.key) {
                <div class="in-bridge-item">
                  <span class="in-bridge-label">{{ b.label }}</span>
                  <span class="in-bridge-val">{{ b.monto === null ? 'NO MEDIDO' : money(b.monto) }}</span>
                  <span class="in-bridge-note">{{ b.nota }}</span>
                </div>
              }
            </div>

            <div class="card-premium card-flat dt-scope">
              <p-table [value]="rc.rows" [scrollable]="true" scrollHeight="flex"
                       styleClass="p-datatable-sm in-table dt-stack" [rowHover]="true">
                <ng-template #header>
                  <tr>
                    <th style="width:7.5rem">Periodo</th>
                    <th>Plaza</th>
                    <th style="width:9rem">Qué es</th>
                    <th class="ta-r">Facturado</th>
                    <th class="ta-r">Cobrado</th>
                    <th class="ta-r">Pendiente</th>
                    <th style="width:16rem">Cómo entró</th>
                    <th class="ta-r" style="width:5rem">Pagos</th>
                  </tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td class="mono dt-id" role="cell" data-label="Periodo">{{ r.periodo }}</td>
                    <td role="cell" data-label="Plaza">
                      <span class="strong">{{ r.plaza }}</span>
                      <span class="in-canal">{{ r.canal }}</span>
                    </td>
                    <td role="cell" data-label="Qué es">
                      <span class="in-kind" [class.in-kind-int]="r.es_interno === true"
                            [class.in-kind-nm]="r.es_interno === null">{{ kindLabel(r.kind) }}</span>
                    </td>
                    <td class="ta-r strong dt-num" role="cell" data-label="Facturado">{{ money(r.vendido) }}</td>
                    <td class="ta-r dt-num" role="cell" data-label="Cobrado">
                      {{ r.cobrado ? money(r.cobrado) : '—' }}
                      @if (r.vendido > 0 && r.cobrado > 0) {
                        <span class="in-pct">{{ pct(r.cobrado, r.vendido) }}%</span>
                      }
                    </td>
                    <td class="ta-r dt-num" role="cell" data-label="Pendiente"
                        [class.in-deuda]="(r.pendiente ?? 0) > 0">
                      {{ r.pendiente === null ? 'NO MEDIDO' : (r.pendiente ? money(r.pendiente) : '—') }}
                    </td>
                    <td role="cell" data-label="Cómo entró">
                      @if (r.cuentas.length) {
                        @for (c of r.cuentas.slice(0, 3); track c.code) {
                          <span class="in-cta" [class.in-cta-efvo]="c.medio === 'efectivo'"
                                [class.in-cta-aj]="c.medio === 'ajuste'">
                            {{ c.nombre || c.code }} · {{ money(c.importe) }}
                            @if (c.pagos > 1) { <em>×{{ c.pagos }}</em> }
                          </span>
                        }
                        @if (r.cuentas.length > 3) {
                          <span class="in-cta in-cta-mas">+{{ r.cuentas.length - 3 }} cuentas más</span>
                        }
                      } @else { <span class="muted">sin cobro todavía</span> }
                    </td>
                    <td class="ta-r dt-num" role="cell" data-label="Pagos">{{ r.pagos || '—' }}</td>
                  </tr>
                </ng-template>
                <ng-template #footer>
                  <tr class="in-tot">
                    <td colspan="3" class="strong">Total</td>
                    <td class="ta-r strong">{{ money(rc.totales.vendido) }}</td>
                    <td class="ta-r">{{ money(rc.totales.cobrado) }}</td>
                    <td class="ta-r">{{ money(rc.totales.pendiente) }}</td>
                    <td class="muted">
                      efectivo {{ money(rc.totales.efectivo) }} · depósito {{ money(rc.totales.banco) }}
                    </td>
                    <td class="ta-r">{{ rc.totales.pagos }}</td>
                  </tr>
                </ng-template>
              </p-table>
              <div class="in-foot">
                Hasta <strong>{{ rc.totales.max_pagos_por_factura }}</strong> pagos distintos casados
                contra una sola factura. Del total facturado,
                <strong>{{ money(rc.totales.vendido_interno) }}</strong> es traspaso dentro de la
                casa (el CEDIS facturándole a sus propias tiendas y rutas) y
                <strong>{{ money(rc.totales.vendido_externo) }}</strong> es venta a cliente de
                afuera. En el período entraron <strong>{{ money(rc.totales.cobrado_en_periodo) }}</strong>
                en {{ rc.totales.pagos_en_periodo }} pagos — eso es la caja; lo de arriba es el devengo.
                <br />
                <em>Pendiente</em> es el saldo de las facturas del renglón, no «facturado menos
                cobrado»: una devolución resta en lo facturado pero se aplica contra la factura que
                le toque, que puede ser de otro día.
              </div>
            </div>

            <!-- Lo que esta pantalla NO puede medir va ABAJO del total que lo contiene, con su
                 monto. Un hueco sin numero se lee como que no existe. -->
            <div class="card-premium card-flat in-huecos">
              <div class="in-huecos-t">Lo que queda fuera del ingreso, y por que</div>
              @for (h of rc.huecos; track h.key) {
                <div class="in-hueco">
                  <span class="in-hueco-val" [class.in-nomedido]="h.monto === null">
                    {{ h.monto === null ? 'NO MEDIDO' : money(h.monto) }}
                  </span>
                  <span class="in-hueco-lbl">{{ h.label }}</span>
                  <span class="in-hueco-note">{{ h.nota }}</span>
                </div>
              }
            </div>
          } @else {
            <div class="in-empty">Cargando la conciliación…</div>
          }
        }
      }
    </div>

    <!-- [IG.10] El documento de un folio. Lo primero que dice es lo que NO trae: el U-D-13 no
         detalla mercancia, y una tabla de productos vacia se leeria como "no compro nada". -->
    <p-dialog [(visible)]="docAbiertoModel" [modal]="true" [draggable]="false" [dismissableMask]="true"
              [style]="{ width: '46rem', maxWidth: '94vw' }" header="Documento">
      @if (docCargando()) {
        <div class="in-empty">Abriendo el documento…</div>
      } @else if (doc(); as dc) {
        <div class="in-doc">
          <div class="in-doc-head">
            <div>
              <div class="in-doc-folio">Folio {{ dc.folio }}</div>
              <div class="in-doc-meta">
                {{ dc.doctype }}@if (dc.doctype_label) { · {{ dc.doctype_label }} } · {{ dc.fecha }}
              </div>
            </div>
            <div class="ta-r">
              <div class="in-doc-total">{{ money(dc.total) }}</div>
              @if (dc.condicion) { <div class="in-doc-meta">{{ dc.condicion }}</div> }
            </div>
          </div>

          @if (dc.cancelado) {
            <div class="in-doc-alerta">
              ⛔ El ERP CANCELÓ este documento ($0.00) y su póliza de ingreso sigue viva, sin reversar.
              No debería estar sumando al ingreso publicado.
            </div>
          }

          <div class="in-doc-grid">
            <div><span>Cliente</span>{{ dc.cliente_nombre || dc.cliente_code }}</div>
            <div><span>Código</span>{{ dc.cliente_code }}</div>
            <div><span>Qué es</span>{{ dc.kind || '—' }}</div>
            <div><span>Cobrado</span>{{ money(dc.cobrado) }}</div>
            <div><span>Nota de crédito</span>{{ money(dc.nota_credito) }}</div>
            <div><span>Pendiente</span>{{ money(dc.pendiente) }}</div>
          </div>

          <!-- La ausencia del detalle se DECLARA. No es que falte en nuestra copia: el ERP no lo
               escribe, y por eso la Fase AX excluyó este doctype de su visor de documentos. -->
          @if (dc.solo_servicio) {
            <div class="in-doc-nota">
              <strong>Este documento no detalla mercancía, y no es que falte el dato: el ERP no lo
              escribe.</strong>
              Medido sobre 30 días, los 1,548 documentos de este tipo traen un renglón o ninguno
              — nunca dos — y ese renglón es el SKU <code>1</code> con unidad <code>SER</code>
              (servicio) y el total completo adentro. Se buscó un documento hermano con el detalle,
              para el mismo cliente y el mismo día: no existe.
            </div>
          }

          @if (dc.renglones.length) {
            <div class="in-doc-t">Como lo escribió el ERP</div>
            <table class="in-doc-tabla">
              <tr>
                <th class="ta-r">#</th><th>Código</th><th>Producto</th>
                <th class="ta-r">Cant</th><th>Unidad</th><th class="ta-r">Importe</th>
              </tr>
              @for (l of dc.renglones; track l.renglon) {
                <tr>
                  <td class="ta-r muted">{{ l.renglon }}</td>
                  <td class="mono">{{ l.sku }}</td>
                  <!-- El nombre sale del catálogo, no del documento: si el código no resuelve se
                       DECLARA, en vez de repetir el código disfrazado de nombre. -->
                  <td>{{ l.descripcion || '— no está en el catálogo' }}</td>
                  <td class="ta-r">{{ l.cantidad }}</td><td>{{ l.unidad }}</td>
                  <td class="ta-r">{{ money(l.importe) }}</td>
                </tr>
              }
            </table>
          }

          <div class="in-doc-t">
            Los cobros que se casaron contra este documento
            @if (dc.pagos.length) { <span class="muted">— {{ dc.pagos.length }}</span> }
          </div>
          @if (dc.pagos.length) {
            <table class="in-doc-tabla">
              <tr><th>Documento</th><th>Fecha y cuenta</th><th>Cómo entró</th><th class="ta-r">Importe</th></tr>
              @for (g of dc.pagos; track g.key) {
                <tr>
                  <td>{{ g.label }}</td><td class="muted">{{ g.sub }}</td>
                  <td class="muted">{{ g.como }}</td><td class="ta-r">{{ money(g.total) }}</td>
                </tr>
              }
            </table>
          } @else {
            <div class="in-doc-nota">Todavía no se ha cobrado nada contra este documento.</div>
          }
        </div>
      }
    </p-dialog>
  `,
  styles: [`
    /* [IG.6] Conciliacion. Tokens de Operations: densidad alta, cero decoracion. */
    .in-grainbar { display: flex; align-items: center; gap: 1rem; margin-bottom: .75rem; flex-wrap: wrap; }
    .in-warn { font-size: .78rem; color: var(--warn-fg, #92400e); }
    .in-bridge { display: flex; flex-wrap: wrap; gap: 0; margin-bottom: 1rem; padding: 0; }
    .in-bridge-item { flex: 1 1 14rem; min-width: 14rem; padding: .85rem 1rem;
      border-right: 1px solid var(--surface-border, #e7e5e4); display: flex; flex-direction: column; gap: .15rem; }
    .in-bridge-item:last-child { border-right: 0; }
    .in-bridge-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); }
    .in-bridge-val { font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .in-bridge-note { font-size: .72rem; color: var(--text-muted, #78716c); line-height: 1.3; }
    .in-interno { color: var(--warn-fg, #92400e); font-variant-numeric: tabular-nums; }
    /* [IG.7] El canal y el "que es" conviven en el renglon: el canal viene del concepto de la
       poliza y esta dado vuelta; el "que es" sale del cliente del documento. Se muestran juntos
       a proposito, para que la contradiccion se vea en vez de resolverse en silencio. */
    /* [IG.9] El arbol baja a folio y deposito: el renglon necesita decir QUE es y COMO entro. */
    .in-sub { display: block; font-size: .72rem; color: var(--text-muted, #78716c); line-height: 1.4;
      margin-left: 1.9rem; }
    .in-como { font-size: .76rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .in-cancel td { background: color-mix(in srgb, var(--warn-fg, #92400e) 8%, transparent); }
    .in-cancel .strong, .in-cancel td:first-child { color: var(--warn-fg, #92400e); }
    .in-hint { font-size: .78rem; color: var(--text-muted, #78716c); }
    /* [IG.10] Ver el documento. */
    .in-verdoc { margin-left: .6rem; padding: 0 .4rem; font-size: .7rem; line-height: 1.5;
      background: none; border: 1px solid var(--surface-border, #e7e5e4);
      border-radius: var(--radius-sm, 4px); color: var(--text-muted, #78716c); cursor: pointer; }
    .in-verdoc:hover { color: var(--action, #c2410c); border-color: var(--action, #c2410c); }
    .in-doc { display: flex; flex-direction: column; gap: .9rem; }
    .in-doc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .in-doc-folio { font-size: 1.05rem; font-weight: 600; }
    .in-doc-meta { font-size: .76rem; color: var(--text-muted, #78716c); }
    .in-doc-total { font-size: 1.2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .in-doc-alerta { padding: .6rem .8rem; border: 1px solid var(--warn-fg, #92400e);
      border-radius: var(--radius-sm, 4px); color: var(--warn-fg, #92400e); font-size: .8rem; line-height: 1.5; }
    .in-doc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem .9rem; }
    .in-doc-grid > div { font-size: .82rem; }
    .in-doc-grid span { display: block; font-size: .68rem; text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-muted, #78716c); }
    .in-doc-nota { padding: .6rem .8rem; border-left: 2px solid var(--surface-border, #e7e5e4);
      font-size: .78rem; line-height: 1.6; color: var(--text-muted, #78716c); }
    .in-doc-nota strong { color: var(--text-color, #1c1917); }
    .in-doc-t { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;
      color: var(--text-muted, #78716c); font-weight: 600; }
    .in-doc-tabla { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .in-doc-tabla th { text-align: left; font-size: .68rem; text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-muted, #78716c); font-weight: 600;
      border-bottom: 1px solid var(--surface-border, #e7e5e4); padding: .3rem .4rem; }
    .in-doc-tabla td { padding: .3rem .4rem; border-bottom: 1px solid var(--surface-border, #e7e5e4);
      font-variant-numeric: tabular-nums; }
    .in-canal { display: block; font-size: .72rem; color: var(--text-muted, #78716c);
      text-transform: lowercase; }
    .in-kind { display: inline-block; font-size: .72rem; line-height: 1.5; padding: .05rem .4rem;
      border-radius: var(--radius-sm, 4px); border: 1px solid var(--surface-border, #e7e5e4);
      color: var(--text-color, #1c1917); white-space: nowrap; }
    .in-kind-int { border-color: var(--warn-fg, #92400e); color: var(--warn-fg, #92400e); }
    .in-kind-nm { border-style: dashed; color: var(--text-muted, #78716c); }
    .in-pct { display: block; font-size: .7rem; color: var(--text-muted, #78716c); }
    .in-deuda { color: var(--warn-fg, #92400e); font-weight: 600; }
    .in-cta { display: block; font-size: .72rem; line-height: 1.45;
      font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .in-cta em { font-style: normal; color: var(--text-muted, #78716c); }
    .in-cta-efvo { color: var(--action, #c2410c); }
    .in-cta-aj { color: var(--text-muted, #78716c); font-style: italic; }
    .in-cta-mas { color: var(--text-muted, #78716c); }
    .in-foot { padding: .75rem 1rem; border-top: 1px solid var(--surface-border, #e7e5e4);
      font-size: .78rem; line-height: 1.55; color: var(--text-muted, #78716c); }
    .in-foot strong { color: var(--text-color, #1c1917); font-variant-numeric: tabular-nums; }
    .in-tot td { border-top: 2px solid var(--surface-border, #e7e5e4); font-weight: 700; font-variant-numeric: tabular-nums; }
    .in-huecos { margin-top: 1rem; padding: .9rem 1rem; }
    .in-huecos-t { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
      color: var(--text-muted, #78716c); margin-bottom: .6rem; }
    .in-hueco { display: grid; grid-template-columns: 9rem 18rem 1fr; gap: .75rem; align-items: baseline;
      padding: .35rem 0; border-top: 1px solid var(--surface-border, #e7e5e4); }
    .in-hueco:first-of-type { border-top: 0; }
    .in-hueco-val { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
    .in-nomedido { color: var(--text-muted, #78716c); font-weight: 600; font-size: .8rem; }
    .in-hueco-lbl { font-weight: 600; }
    .in-hueco-note { font-size: .76rem; color: var(--text-muted, #78716c); line-height: 1.35; }
    @media (max-width: 720px) { .in-hueco { grid-template-columns: 1fr; } }
    .in-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .in-field { display: flex; flex-direction: column; gap: .3rem; min-width: 11rem; }
    .in-field > label { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); }
    .in-narrow { min-width: 8rem; }
    .in-toggle { min-width: 6rem; }
    .in-viewbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1rem 0 .8rem; flex-wrap: wrap; }
    .in-dim { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: var(--text-muted, #78716c); }
    .in-table { font-size: .84rem; }
    .in-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .in-chart { padding: 1rem; }
    .in-tag { margin-left: .45rem; font-size: .66rem; padding: .08rem .35rem; border-radius: var(--r-pill, 999px);
      background: color-mix(in srgb, currentColor 10%, transparent); color: var(--text-muted, #78716c); }
    /* La fila no comparable se atenúa: está ahí para dar contexto, no para restarla. */
    .in-nocomp { opacity: .78; }
    /* Banda de cobertura — gemela de la de Egresos. Tono warn: no está roto, está declarado. */
    .in-cov { display: flex; gap: .6rem; align-items: flex-start; margin: 0 0 1rem;
      font-size: .82rem; line-height: 1.45; color: var(--text-strong, inherit);
      background: color-mix(in srgb, var(--warn-fg) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--warn-fg) 28%, transparent);
      border-radius: var(--r-sm, .4rem); padding: .6rem .8rem; }
    .in-cov > .pi { color: var(--warn-fg); margin-top: .15rem; flex: none; }
    .in-cov-body { display: flex; flex-direction: column; gap: .25rem; }
    .in-cov-delta { font-size: .88rem; }
    .in-cov-all { color: var(--text-muted, #78716c); }
    .in-cov-ok { color: var(--ok-fg); }
    .in-cov .muted { color: var(--text-muted, #78716c); }
  `],
})
export class FinanzasIngresosComponent {
  private readonly svc = inject(ComercialService);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly viewOpts = [
    { label: 'Árbol', value: 'arbol' }, { label: 'Tabla', value: 'tabla' },
    { label: 'Tendencia', value: 'tendencia' }, { label: '¿Cuadra?', value: 'cuadre' },
    { label: 'Conciliación', value: 'conciliacion' },
  ];
  readonly groupByOpts: Array<{ label: string; value: IncomeGroupBy }> = [
    { label: 'Canal', value: 'canal' }, { label: 'Plaza', value: 'plaza' },
    { label: 'Documento', value: 'documento' }, { label: 'Mes', value: 'mes' },
  ];
  /** Las etiquetas salen del contrato, no de una lista a mano (ADR-056). */
  readonly canalOpts = SALES_CANAL_ORDER.map((c) => ({ label: salesCanalLabel(c), value: c }));

  readonly report = signal<IncomeReport | null>(null);
  readonly tree = signal<IncomeTree | null>(null);
  readonly sources = signal<IncomeSources | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly view = signal<'arbol' | 'tabla' | 'tendencia' | 'cuadre' | 'conciliacion'>('arbol');
  // `[IG.6]` Conciliación: lo vendido contra lo cobrado, por sucursal.
  readonly recon = signal<IncomeRecon | null>(null);
  readonly grain = signal<IncomeGrain>('mes');
  readonly grainOpts = [
    { label: 'Día', value: 'dia' }, { label: 'Mes', value: 'mes' }, { label: 'Trimestre', value: 'trimestre' },
  ];
  readonly groupBy = signal<IncomeGroupBy>('canal');
  readonly compare = signal(false);

  canal: string[] = [];
  concepto = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];
  mesSel: string | null = null;

  /** Últimos 18 meses. ⚠️ 2025 fue PRESUPUESTO (sin UD1301): la banda de cobertura lo declara. */
  readonly mesOpts = (() => {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 18; i++) {
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const lbl = d.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
      out.push({ label: lbl.charAt(0).toUpperCase() + lbl.slice(1), value: val });
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  })();

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    const items: MetricStripItem[] = [
      { label: 'Ingreso total', value: r.total, format: 'currency', tone: 'brand', sub: `${r.movimientos} docs` },
    ];
    for (const c of r.by_canal) {
      items.push({ label: c.label, value: c.total, format: 'currency', sub: `${c.movs} docs · ${this.pct(c.total, r.total)}%` });
    }
    return items;
  });

  // ⚠️ Deja de ser `computed`: el árbol ahora MUTA (los hijos llegan al abrir) y un computed se
  // recalcularía desde cero perdiendo todo lo cargado. Lo llena `loadTree`.
  readonly treeNodes = signal<TreeNode[]>([]);
  /** Grano del SEGUNDO nivel del árbol. Debajo siempre baja a folio y a depósito. */
  readonly treeGrain = signal<'dia' | 'mes' | 'trimestre'>('dia');
  readonly treeGrainOpts = [
    { label: 'Día', value: 'dia' },
    { label: 'Mes', value: 'mes' },
    { label: 'Trimestre', value: 'trimestre' },
  ];
  readonly groupByLabel = computed(() => this.groupByOpts.find((o) => o.value === this.groupBy())?.label || 'Canal');

  readonly chartData = computed(() => {
    const s = this.report()?.series || [];
    return {
      labels: s.map((p) => (p.parcial ? `${p.mes} ·parcial` : p.mes)),
      datasets: [
        { label: 'Mostrador', data: s.map((p) => p.mostrador), backgroundColor: egresChartSeries()[0] },
        { label: 'Telemarketing', data: s.map((p) => p.telemarketing), backgroundColor: egresChartSeries()[1] },
        { label: 'Ruta', data: s.map((p) => p.ruta), backgroundColor: egresChartSeries()[2] },
        { label: 'Reparto vecinal', data: s.map((p) => p.vecinal), backgroundColor: egresChartSeries()[3] },
        { label: 'Contado', data: s.map((p) => p.contado), backgroundColor: egresChartSeries()[4] },
        { label: 'Sin canal declarado', data: s.map((p) => p.otro), backgroundColor: egresChartSeries()[5] },
      ],
    };
  });
  readonly chartOpts = computed(() => egresChartOptions(
    this.theme.isMonochrome(),
    new Map((this.report()?.series || []).map((p) => [p.mes, { parcial: p.parcial, sucursales: p.plazas }])),
  ));

  /** Mismo criterio que en Egresos: el aviso sale sólo cuando hay algo que declarar. */
  readonly coverageAviso = computed(() => {
    const r = this.report();
    if (!r?.coverage?.measured) return null;
    const c = r.coverage;
    const comp = r.comparativo?.universo_cambio ? r.comparativo : null;
    if (!comp && !c.grupos_parciales.length && !c.meses_parciales.length) return null;
    return { ...c, comp };
  });

  /**
   * Nombra unos pocos y cuenta el resto. La banda ya publicó una vez «237 plazas» seguido de
   * doscientos nombres de cliente: un aviso que no se puede leer no avisa. El arreglo de fondo es
   * que el residuo cuente como UN grupo (lo hace el servidor), esto es el cinturón.
   */
  lista(xs: string[], n = 5): string {
    return xs.slice(0, n).join(', ') + (xs.length > n ? ` y ${xs.length - n} más` : '');
  }

  signo(v: number | null): string { return v === null ? 'sin base' : `${v > 0 ? '+' : ''}${v}%`; }
  canalShort(c: string | null): string { return c ? (SALES_CANAL_SHORT[c as SalesCanal] ?? '') : ''; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  pct(part: number, total: number): number { return total ? +((part / total) * 100).toFixed(1) : 0; }

  /**
   * `[IG.7]` El rótulo de QUÉ es el cliente detrás de una plaza. Va al lado del canal y no lo
   * reemplaza: el canal que publica el Árbol sale del concepto de la póliza y está dado vuelta
   * (lo que dice "mostrador" es traspaso interno, y la venta de mayoreo real cae en "otro"), pero
   * corregirlo a espaldas del usuario rompería el cuadre con la otra pestaña. Se muestran los dos.
   */
  kindLabel(k: string): string {
    switch (k) {
      case 'externo': return 'Cliente de afuera';
      case 'interno_sucursal': return 'Tienda propia';
      case 'interno_punto_venta': return 'Punto de venta propio';
      case 'interno_ruta': return 'Ruta propia';
      case 'interno_traspaso': return 'Traspaso';
      case 'interno_telemarketing': return 'Telemarketing propio';
      case 'sin_catalogo': return 'Fuera del catálogo';
      case 'sin_documento': return 'Sin documento';
      case 'mixto': return 'Mezcla';
      default: return k;
    }
  }

  private toNode(n: IncomeTreeNode, expanded = false): TreeNode {
    return {
      data: { ...n, residuo: n.key === 'otro' },
      expanded,
      children: (n.children || []).map((c) => this.toNode(c)),
      // ⚠️ `leaf` lo manda el SERVIDOR, no el hecho de que los hijos todavía no estén cargados.
      // Derivarlo de `children.length` haría que todo nodo por cargar se dibujara sin flecha: el
      // árbol se vería completo y terminado justo donde empieza lo que el usuario vino a ver.
      leaf: n.leaf ?? !n.children?.length,
    };
  }

  // `[IG.10]` El documento que se esta viendo.
  readonly doc = signal<IncomeDocumentoT | null>(null);
  readonly docAbierto = signal(false);
  readonly docCargando = signal(false);
  /** p-dialog usa [(visible)] con un setter: un signal no se le puede atar directo. */
  get docAbiertoModel(): boolean { return this.docAbierto(); }
  set docAbiertoModel(v: boolean) { this.docAbierto.set(v); }

  /** Fecha LOCAL (no toISOString): con UTC-6 el dia se corre y el rango pide otro mes. */
  private fmtFecha(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + dd;
  }

  /**
   * `[IG.10]` Ver el documento de un folio. Edgar: *"al dar clic al folio, dar la opcion
   * de ver ese doc"*.
   *
   * ⛔ Lo que el dialogo NO puede mostrar, y por eso lo DICE en vez de callarlo: el U-D-13 no
   * detalla mercancia. Medido sobre 30 dias, sus 1,548 documentos traen UN renglon o ninguno,
   * nunca dos, y ese renglon es el SKU 1 con unidad SER y el total completo adentro. Una tabla de
   * productos vacia se leeria como «no compro nada», que es falso.
   */
  verDocumento(d: IncomeTreeNode, ev?: Event) {
    ev?.stopPropagation();
    if (!d.folio || !d.fecha) return;
    this.doc.set(null);
    this.docCargando.set(true);
    this.docAbierto.set(true);
    this.svc.incomeDocumento(d.folio, d.fecha).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.doc.set(r); this.docCargando.set(false); },
        error: () => {
          this.docCargando.set(false);
          this.docAbierto.set(false);
          this.error.set('No se pudo abrir ese documento.');
        },
      });
  }

  /**
   * `[IG.9]` Abrir un nodo pide sus hijos. Sólo la primera vez: después quedan en el nodo.
   *
   * Un canal de 90 días son miles de documentos y decenas de miles de depósitos, así que bajar a
   * folio y a depósito se paga al abrir y no en la carga inicial.
   */
  onTreeExpand(ev: { node?: TreeNode }) {
    const node = ev?.node;
    const d = node?.data as (IncomeTreeNode & { cargando?: boolean }) | undefined;
    if (!node || !d || node.children?.length || d.cargando) return;
    // El canal ya trae sus sucursales/rutas/repartidores en la carga inicial; de ahí para abajo
    // cada nivel se pide al abrir. `pago` es el fondo del árbol: no tiene hijos.
    if (d.level !== 'plaza' && d.level !== 'periodo' && d.level !== 'folio') return;
    if (!d.canal) return;
    const [ra, rb] = this.rangeDates || [];
    d.cargando = true;
    this.svc.incomeTreeChildren({
      canal: d.canal,
      plaza: d.plaza,
      fecha: d.level === 'plaza' ? null : d.fecha,
      folio: d.level === 'folio' ? d.folio : null,
      from: ra ? this.fmtFecha(ra) : undefined,
      to: rb ? this.fmtFecha(rb) : undefined,
      grain: this.treeGrain(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          node.children = r.nodes.map((c) => this.toNode(c));
          node.leaf = r.nodes.length === 0;
          d.cargando = false;
          // El árbol de PrimeNG lee un arreglo por referencia: sin una copia nueva el renglón
          // abierto queda vacío aunque los hijos ya estén adentro del nodo.
          this.treeNodes.update((ns) => [...ns]);
        },
        error: () => {
          d.cargando = false;
          node.leaf = true;
          this.error.set('No se pudieron cargar los movimientos de ese nivel.');
        },
      });
  }

  private fresh = { report: false, tree: false, sources: false, recon: false };
  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() { this.showView(); }

  setView(v: string) { this.view.set(v as 'arbol'); this.showView(); }
  setGroupBy(v: IncomeGroupBy) { this.groupBy.set(v); this.fresh.report = false; this.showView(); }

  pickMes(v: string | null) {
    this.mesSel = v || null;
    if (v) {
      const [y, m] = v.split('-').map(Number);
      this.rangeDates = [new Date(y, m - 1, 1), new Date(y, m, 0)];
    }
    this.applyFilters();
  }
  onRangeChange() { this.mesSel = null; this.queueFilter(); }
  queueFilter() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.applyFilters(), 300);
  }
  applyFilters() {
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
    this.fresh = { report: false, tree: false, sources: false, recon: false };
    this.showView();
  }
  reload() { this.error.set(null); this.applyFilters(); }

  private showView() {
    if (!this.fresh.report) this.loadReport();
    if (this.view() === 'arbol' && !this.fresh.tree) this.loadTree();
    if (this.view() === 'cuadre' && !this.fresh.sources) this.loadSources();
    if (this.view() === 'conciliacion' && !this.fresh.recon) this.loadRecon();
  }

  private params(extra: Partial<IncomeParams> = {}): IncomeParams {
    const [a, b] = this.rangeDates || [];
    // Formateo LOCAL (no toISOString): con UTC-6 el día se corre y el rango pide otro mes.
    const fmt = (d?: Date) =>
      d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    return {
      from: fmt(a), to: fmt(b),
      canal: this.canal, concepto: this.concepto || undefined,
      min_importe: this.minImporte ?? undefined,
      ...extra,
    };
  }

  private reportSub?: Subscription;
  private treeSub?: Subscription;
  private sourcesSub?: Subscription;
  private reconSub?: Subscription;

  private loadReport() {
    this.loading.set(true);
    this.error.set(null);
    this.reportSub?.unsubscribe();
    this.reportSub = this.svc.income(this.params({ group_by: this.groupBy(), compare: this.compare() }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.fresh.report = true; this.loading.set(false); },
        error: () => { this.loading.set(false); this.error.set('No se pudieron cargar los ingresos del período.'); },
      });
  }

  private loadTree() {
    this.treeSub?.unsubscribe();
    this.treeSub = this.svc.incomeTree({ ...this.params(), grain: this.treeGrain() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (t) => {
          this.tree.set(t);
          // El primer canal nace abierto: un árbol que arranca todo cerrado obliga a adivinar
          // dónde hay algo. Los de abajo se abren a mano.
          this.treeNodes.set((t.tree || []).map((n, i) => this.toNode(n, i === 0)));
          this.fresh.tree = true;
        },
        // Declara, no se calla: «sin ingresos» y «no se pudo cargar» se leen igual (lección GX.19).
        error: () => {
          this.tree.set(null); this.treeNodes.set([]); this.fresh.tree = false;
          this.error.set('No se pudo cargar el desglose por canal.');
        },
      });
  }

  /** `[IG.9]` Cambiar el grano del segundo nivel recarga el árbol: los hijos ya no sirven. */
  setTreeGrain(g: string) {
    const v = g === 'mes' || g === 'trimestre' ? g : 'dia';
    if (v === this.treeGrain()) return;
    this.treeGrain.set(v);
    this.fresh.tree = false;
    this.loadTree();
  }

  private loadSources() {
    this.sourcesSub?.unsubscribe();
    this.sourcesSub = this.svc.incomeSources(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => { this.sources.set(s); this.fresh.sources = true; },
        error: () => { this.sources.set(null); this.error.set('No se pudo cargar el cuadre de fuentes.'); },
      });
  }

  setGrain(g: string) {
    this.grain.set(g as IncomeGrain);
    this.fresh.recon = false;
    this.loadRecon();
  }

  private loadRecon() {
    this.reconSub?.unsubscribe();
    this.reconSub = this.svc.incomeRecon({ ...this.params(), grain: this.grain() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.recon.set(r); this.fresh.recon = true; },
        error: () => { this.recon.set(null); this.error.set('No se pudo cargar la conciliación.'); },
      });
  }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const head = ['concepto', 'docs', 'importe', 'share_pct', ...(this.compare() ? ['delta_pct'] : [])];
    const lines = [head.join(',')];
    for (const row of r.rows as IncomeRow[]) {
      const label = (row.label || '').replace(/"/g, '""');
      const base: (string | number)[] = [`"${label}"`, row.movs, row.total, row.share_pct];
      if (this.compare()) base.push(row.delta_pct ?? '');
      lines.push(base.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ingresos_${r.group_by}_${r.from}_${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
