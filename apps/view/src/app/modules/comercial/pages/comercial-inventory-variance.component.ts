import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TooltipModule } from 'primeng/tooltip';
import {
  ComercialService, InventoryVarianceEvent, InventoryVarianceLine,
  InventoryVarianceCoverage, InventoryCountPlan, InventoryVarianceKpi, Warehouse,
  InventoryReincidencia, InventoryReincidenciaItem,
  RollforwardPeriodos, RollforwardPeriodo, RollforwardItem, RollforwardTotales,
  RollforwardFreshness,
} from '../comercial.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { TableDensityComponent } from '../../../shared/components/table-density/table-density.component';
import { TableDensityService } from '../../../shared/components/table-density/table-density.service';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

/**
 * [IC.0] Diferencias del conteo físico de Kepler.
 *
 * Kepler hace el inventario completo cada trimestre y emite el ajuste. El dato existe desde
 * nov-2025 y NO se veía en ninguna pantalla — $6.60M de sobrante contra $2.26M de faltante
 * sólo en sep-2026. Esta página no hace contar a nadie: muestra lo que ya pasó.
 *
 * Superficie Operations: tabla densa, master-detail, sin adornos.
 *
 * Dos decisiones que la separan de un tablero que engaña:
 *  · Las CARGAS INICIALES (migración Wincaja→Kepler) se excluyen por default y se pueden
 *    ver con el switch. Son $30.8M que mezclados con el descuadre lo vuelven ruido.
 *  · La COBERTURA se muestra siempre que se abre un evento: cuántos SKUs con existencia
 *    quedaron SIN contar. Sin eso, la pantalla se lee como si lo contado fuera el almacén.
 */
@Component({
  selector: 'app-comercial-inventory-variance',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule,
    ToggleSwitchModule, SelectButtonModule, TooltipModule, MetricCardComponent,
    ContextHelpComponent, TableDensityComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page inv-var">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Diferencias de inventario</h1>
          <p>
            Descuadre del conteo físico que hace Kepler cada trimestre. Sobrante y faltante
            por almacén, con el detalle SKU por SKU.
          </p>
        </div>
        <div class="surf-page-head-actions">
          <!-- DESIGN Q.7: la jerga se consulta sin salir de la pantalla, desde el diccionario
               versionado. Esta pantalla tiene cuatro vocabularios y cuatro roles que la leen. -->
          <app-context-help topic="inventario-diferencias" />
          <!-- §564 #2: 40px por default, 32px para quien vive acá. La preferencia se recuerda. -->
          <app-table-density />
        </div>
      </header>

      <p-selectbutton [options]="vistas" [(ngModel)]="vista" optionLabel="label" optionValue="value"
        (onChange)="onVista()" styleClass="inv-var-tabs"></p-selectbutton>

      <div class="inv-var-filters">
        <p-select [options]="warehouseOptions()" optionLabel="label" optionValue="value"
          [(ngModel)]="warehouseFilter" (onChange)="load()" placeholder="Todos los almacenes"
          styleClass="inv-var-wh"></p-select>
        <label class="inv-var-toggle">
          <p-toggleswitch [(ngModel)]="includeInitialLoad" (onChange)="load()"></p-toggleswitch>
          <span>Incluir cargas iniciales</span>
        </label>
        <button pButton [text]="true" (click)="load()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
      </div>

      @if (vista === 'programa') {
        <!-- ── [IC.6] El programa: los tres ritmos en un lugar ────────────────────── -->
        <section class="inv-var-prog">
          @if (!warehouseFilter) {
            <p class="inv-var-note">Elegí un almacén para ver qué le toca este mes.</p>
          } @else {
            @if (plan(); as pl) {
              <div class="surf-grid inv-var-kpis">
                <app-metric-card class="panel-col-3" label="Toca este mes"
                  [value]="pl.total" [sub]="'ola ' + pl.ola + ' + top'"></app-metric-card>
                <app-metric-card class="panel-col-3" label="Del top"
                  [value]="pl.del_top" sub="se cuentan todos los meses"></app-metric-card>
                <app-metric-card class="panel-col-3" label="De la ola"
                  [value]="pl.de_la_ola" sub="un tercio del catálogo"></app-metric-card>
                <app-metric-card format="text" class="panel-col-3" label="Cobertura del trimestre"
                  [valueText]="cobertura()?.cubre_todo ? 'las 3 olas' : 'incompleta'"
                  [tone]="cobertura()?.cubre_todo ? 'ok' : 'bad'"
                  [sub]="'desvío máx. ' + (cobertura()?.desvio_max_pct ?? '—') + '%'"></app-metric-card>
              </div>
              @if (pl.truncado) {
                <p class="inv-var-warn">
                  ⚠️ El plan quedó truncado por el límite: hay más SKUs que deberían entrar.
                </p>
              }
              <p-table [value]="pl.items" styleClass="surf-table" [class.is-dense]="density.dense()" [scrollable]="true" scrollHeight="360px">
                <ng-template #header>
                  <tr><th>SKU</th><th>ABC</th><th>Motivo</th><th class="num">Score</th>
                      <th class="num">Señales</th><th>Salvedad</th></tr>
                </ng-template>
                <ng-template #body let-i>
                  <tr>
                    <td class="tabular">{{ i.sku }}</td>
                    <td>{{ i.abc_class || '—' }}</td>
                    <td>
                      <p-tag [severity]="i.motivo === 'top' ? 'warn' : 'secondary'"
                        [value]="i.motivo"></p-tag>
                    </td>
                    <td class="num tabular">{{ i.score }}</td>
                    <td class="num tabular">{{ i.senales_usadas }}/4</td>
                    <td class="inv-var-salv">{{ i.score_salvedad || '' }}</td>
                  </tr>
                </ng-template>
              </p-table>
            }
          }

          @if (kpi(); as k) {
            <h2 class="inv-var-h2">¿Está sirviendo?</h2>
            @if (k.veredicto === 'sin_base_de_comparacion') {
              <p class="inv-var-note">
                Todavía <strong>no se puede responder</strong>: hacen falta dos trimestres con
                los mismos almacenes. {{ k.tendencia?.motivo || '' }}
              </p>
            } @else if (k.tendencia; as tn) {
              <p class="inv-var-note">
                De {{ tn.de }} a {{ tn.a }}:
                <strong>{{ tn.pct_antes }}% → {{ tn.pct_despues }}%</strong>
                ({{ tn.delta_pp }} pp) sobre los almacenes comunes.
              </p>
            }
            @if (k.periodos_descartados > 0) {
              <p class="inv-var-warn">
                ⚠️ {{ k.periodos_descartados }} período(s) fuera de la tendencia: su descuadre
                supera el valor contado, así que el denominador no los cubre.
              </p>
            }
            <p-table [value]="k.periodos" styleClass="surf-table" [class.is-dense]="density.dense()">
              <ng-template #header>
                <tr><th>Trimestre</th><th class="num">Almacenes</th><th>Cuáles</th>
                    <th class="num">Contado</th><th class="num">% descuadre</th><th>Salvedad</th></tr>
              </ng-template>
              <ng-template #body let-p>
                <tr>
                  <td>{{ p.periodo }}</td>
                  <td class="num tabular">{{ p.almacenes }}</td>
                  <td class="inv-var-salv">{{ p.codigos?.join(', ') }}</td>
                  <td class="num tabular">{{ fmtMoney(+p.valor_contado) }}</td>
                  <td class="num tabular">{{ p.pct_descuadre ?? '—' }}%</td>
                  <td class="inv-var-salv">{{ p.salvedad || '' }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
        </section>
      }

      @if (vista === 'conciliacion') {
        <!-- [IC.11] A dónde se fue la mercancía entre dos conteos -->
        <section class="inv-var-prog">
          <div class="inv-var-filters">
            <p-select [options]="rfOpciones()" optionLabel="label" optionValue="value"
              [(ngModel)]="rfSel" (onChange)="loadRf()" placeholder="Elegí un período"
              styleClass="inv-var-wh" [filter]="true"></p-select>
            <p-select [options]="rfVeredictos" optionLabel="label" optionValue="value"
              [(ngModel)]="rfVeredicto" (onChange)="loadRf()" placeholder="Todos"
              styleClass="inv-var-wh"></p-select>
          </div>

          @if (rf(); as r) {
            <!-- Q.1 answer-first: la conclusión antes que la evidencia. Q.2: en llano. -->
            <p class="inv-var-lectura">{{ rfLectura() }}</p>

            <!-- ⛔ Esto sale de una matview que se refresca UNA vez al día. Si el refresco se
                 para, la pantalla no se vacía ni avisa: sigue mostrando la merma del período
                 anterior. El veredicto es TERNARIO: "unknown" no es "fresh". -->
            @if (r.freshness; as f) {
              <div class="inv-var-fresh">
                @if (f.status === 'unknown') {
                  <p-tag severity="secondary" value="Frescura sin medir"></p-tag>
                  <span class="inv-var-salv">{{ f.motivo }}</span>
                } @else {
                  <app-freshness-pill measures="data" [since]="f.data_as_of"
                    label="Calculado" [staleAfterSec]="129600"></app-freshness-pill>
                  <span class="inv-var-salv">se recalcula cada noche</span>
                }
              </div>
            }

            @if (rfCobertura(); as cob) {
              @if (cob.pct >= 20) {
                <p class="inv-var-warn">
                  ⚠️ <strong>{{ cob.sin }} de {{ cob.total }} SKUs ({{ cob.pct }}%)</strong> estaban
                  en el primer conteo y <strong>no en el segundo</strong>: su diferencia es
                  desconocida, no cero. El total de arriba no cubre esa parte del almacén.
                </p>
              }
            }

            <!-- ⛔ La segunda salvedad, y NO es simétrica: un esperado negativo sólo puede
                 caer del lado del sobrante, así que lo exagera. -->
            @if (r.totales.imposibles > 0) {
              <p class="inv-var-warn">
                ⚠️ <strong>{{ r.totales.imposibles }} SKUs</strong> salieron más de lo que el conteo
                anterior decía que había, o sea que falta una entrada sin capturar. Su
                «debía quedar» es imposible y sólo puede caer del lado del sobrante:
                <strong>{{ fmtMoney(+r.totales.importe_imposible) }}</strong> del sobrante de
                abajo viene de ahí, y no es mercancía que apareció.
              </p>
            }

            <!-- La cadena, en orden de lectura: de lo que había a lo que quedó sin explicar -->
            <div class="surf-grid inv-var-kpis">
              <app-metric-card class="panel-col-2" label="Había (conteo anterior)"
                format="text" [valueText]="(+r.totales.contado_inicio).toLocaleString('es-MX')"
                sub="unidades contadas"></app-metric-card>
              <app-metric-card class="panel-col-2" label="Entró"
                format="text" [valueText]="(+r.totales.compras + +r.totales.recibido).toLocaleString('es-MX')"
                [sub]="'compra ' + (+r.totales.compras).toLocaleString('es-MX') + ' · traspaso ' + (+r.totales.recibido).toLocaleString('es-MX')"></app-metric-card>
              <app-metric-card class="panel-col-2" label="Salió"
                format="text" [valueText]="(+r.totales.vendido + +r.totales.enviado).toLocaleString('es-MX')"
                [sub]="'venta ' + (+r.totales.vendido).toLocaleString('es-MX') + ' · traspaso ' + (+r.totales.enviado).toLocaleString('es-MX')"></app-metric-card>
              <app-metric-card class="panel-col-2" label="Debía quedar"
                format="text" [valueText]="(+r.totales.esperado).toLocaleString('es-MX')"
                sub="había + entró − salió"></app-metric-card>
              <app-metric-card class="panel-col-2" label="Se contó"
                format="text" [valueText]="(+r.totales.contado_fin).toLocaleString('es-MX')"
                sub="conteo siguiente"></app-metric-card>
              <app-metric-card class="panel-col-2" label="Falta sin explicar" tone="bad"
                format="text" [valueText]="fmtMoney(-(+r.totales.importe_merma))"
                [sub]="r.totales.merma + ' SKUs'"></app-metric-card>
            </div>

            <p-table [value]="r.items" styleClass="surf-table" [class.is-dense]="density.dense()" [scrollable]="true"
              scrollHeight="420px" [loading]="loadingRf()">
              <ng-template #header>
                <tr>
                  <th>SKU</th><th>Descripción</th>
                  <th class="num">Había</th><th class="num">Entró</th><th class="num">Salió</th>
                  <th class="num">Debía quedar</th><th class="num">Se contó</th>
                  <th class="num">Sin explicar</th><th class="num">$</th><th>Veredicto</th>
                </tr>
              </ng-template>
              <ng-template #body let-i>
                <tr>
                  <td class="tabular">{{ i.sku }}</td>
                  <td>{{ i.descripcion || '—' }}</td>
                  <td class="num tabular">{{ +i.contado_inicio }}</td>
                  <td class="num tabular">{{ (+i.compras + +i.recibido) || '—' }}</td>
                  <td class="num tabular">{{ (+i.vendido + +i.enviado) || '—' }}</td>
                  <td class="num tabular">
                    @if (i.esperado_imposible) {
                      <span class="inv-var-imposible"
                        pTooltip="Imposible: salió más de lo que había. Falta una entrada sin capturar, así que su diferencia no es confiable."
                      >{{ +i.esperado }}</span>
                    } @else { {{ +i.esperado }} }
                  </td>
                  <!-- ⛔ Guion, no cero: NULL acá significa que nadie lo volvió a contar. -->
                  <td class="num tabular">
                    @if (i.contado_fin === null) {
                      <span class="inv-var-nd" pTooltip="No se volvió a contar: su diferencia es desconocida">—</span>
                    } @else { {{ +i.contado_fin }} }
                  </td>
                  <td class="num tabular"
                      [class.inv-var-menos]="i.veredicto === 'merma'"
                      [class.inv-var-mas]="i.veredicto === 'sobrante'">
                    {{ i.no_explicado === null ? '—' : (+i.no_explicado > 0 ? '+' : '') + (+i.no_explicado) }}
                  </td>
                  <td class="num tabular">
                    {{ i.importe_no_explicado === null ? '—' : fmtMoney(+i.importe_no_explicado) }}
                  </td>
                  <td><p-tag [severity]="vereSev(i.veredicto)" [value]="vereLabel(i.veredicto)"></p-tag></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="10" class="inv-var-note">
                  Sin renglones con este filtro.
                </td></tr>
              </ng-template>
            </p-table>
          } @else if (!rfSel) {
            <p class="inv-var-note">Elegí un período para ver a dónde se fue la mercancía.</p>
          }

          <!-- ⛔ Los almacenes que NO se pueden conciliar van EN PANTALLA: uno ausente de un
               selector se lee como que no tiene problema. -->
          @if (rfPeriodos()?.sin_par; as sp) {
            @if (sp.length) {
              <h2 class="inv-var-h2">Sin comparación posible</h2>
              <p-table [value]="sp" styleClass="surf-table" [class.is-dense]="density.dense()">
                <ng-template #header>
                  <tr><th>Almacén</th><th class="num">Conteos</th><th>Por qué</th></tr>
                </ng-template>
                <ng-template #body let-x>
                  <tr>
                    <td class="tabular">{{ x.code }} — {{ x.name }}</td>
                    <td class="num tabular">{{ x.capturas }}</td>
                    <td class="inv-var-salv">{{ x.motivo }}</td>
                  </tr>
                </ng-template>
              </p-table>
            }
          }
        </section>
      }

      @if (vista === 'reincidencia') {
        <!-- [IC.3b] La vista de IC.3 llevaba en prod sin un solo consumidor -->
        <section class="inv-var-prog">
          @if (!warehouseFilter) {
            <p class="inv-var-note">
              Sin almacén elegido se consultan todos y tarda cerca del doble. Elegí uno arriba
              para que responda en ~0.65 s.
            </p>
          }

          <div class="inv-var-filters">
            <p-select [options]="patrones" optionLabel="label" optionValue="value"
              [(ngModel)]="patronFilter" (onChange)="loadReincidencia()"
              placeholder="Todos los patrones" styleClass="inv-var-wh"></p-select>
          </div>

          @if (reinc(); as r) {
            <div class="surf-grid inv-var-kpis">
              @for (x of resumenOrdenado(); track x.patron) {
                <app-metric-card class="panel-col-3" [label]="patronLabel(x.patron)"
                  [value]="x.skus"
                  [tone]="x.patron === 'merma' ? 'bad' : x.patron === 'sobra' ? 'warn' : 'default'"
                  [sub]="fmtMoney(+x.pesos_neto) + ' netos'"></app-metric-card>
              }
            </div>

            <!-- Lo que NO se puede juzgar va SIEMPRE en pantalla: un almacén entero puede caer
                 acá, y esconderlo se lee como que no tiene problema. -->
            @if (r.sin_base.skus > 0) {
              <p class="inv-var-warn">
                ⚠️ <strong>{{ r.sin_base.skus }} SKUs no se pueden juzgar</strong>
                ({{ fmtMoney(+r.sin_base.pesos_abs) }} movidos, almacenes {{ r.sin_base.almacenes }}):
                {{ r.sin_base.motivo }}.
              </p>
            }

            <p class="inv-var-note">
              Ordenado por lo que <strong>queda</strong>, no por lo que se movió. Un SKU puede
              mover millones y devolverlos: eso es captura o unidad, no mercancía perdida.
            </p>

            <p-table [value]="r.items" styleClass="surf-table" [class.is-dense]="density.dense()" [scrollable]="true"
              scrollHeight="420px" [loading]="loadingReinc()">
              <ng-template #header>
                <tr><th>SKU</th><th>Alm.</th><th class="num">Contado</th>
                    <th class="num">Descuadres</th><th>Patrón</th><th>Forma</th>
                    <th class="num">Retiene</th><th class="num">Neto</th><th>Qué significa</th></tr>
              </ng-template>
              <ng-template #body let-i>
                <tr>
                  <td class="tabular">{{ i.sku }}</td>
                  <td class="tabular">{{ i.warehouse_code }}</td>
                  <td class="num tabular">{{ i.veces_contado }}</td>
                  <td class="num tabular">{{ i.veces_descuadro }}</td>
                  <td><p-tag [severity]="patronSev(i.patron)"
                        [value]="patronLabel(i.patron)"></p-tag></td>
                  <td>
                    @if (i.forma === 'evento_aislado') {
                      <p-tag severity="info" value="un evento"
                        [pTooltip]="'El mayor conteo explica el ' + (i.concentracion * 100 | number:'1.0-0') + '% del neto'"></p-tag>
                    } @else if (i.forma === 'sostenido') {
                      <p-tag severity="danger" value="sostenido"></p-tag>
                    } @else {
                      <span class="inv-var-salv">—</span>
                    }
                  </td>
                  <td class="num tabular">
                    {{ i.retencion === null ? '—' : (i.retencion * 100 | number:'1.0-0') + '%' }}
                  </td>
                  <td class="num tabular">{{ fmtMoney(+i.pesos_neto) }}</td>
                  <td class="inv-var-salv">{{ lectura(i) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="9" class="inv-var-note">
                  Sin SKUs con {{ r.min_conteos }} conteos o más en este filtro.
                </td></tr>
              </ng-template>
            </p-table>
          }
        </section>
      }

      @if (vista === 'diferencias' && !includeInitialLoad) {
        <p class="inv-var-note">
          Las <strong>cargas iniciales</strong> (cuando una sucursal migra de Wincaja a Kepler)
          están fuera: cuadran consigo mismas y no son descuadre. Son $30.8M en el histórico.
        </p>
      }

      @if (vista === 'diferencias') {
      <!-- ⛔ Esto sale de una matview que se refresca una vez al día. Si el refresco se para, la
           pantalla no se vacía ni avisa: sigue mostrando el descuadre del trimestre anterior.
           El veredicto es TERNARIO: "unknown" no es "fresh" (ADR-056). -->
      @if (frescura(); as f) {
        <div class="inv-var-fresh">
          @if (f.status === 'unknown') {
            <p-tag severity="secondary" value="Frescura sin medir"></p-tag>
            <span class="inv-var-salv">{{ f.motivo }}</span>
          } @else {
            <app-freshness-pill measures="data" [since]="f.data_as_of"
              label="Calculado" [staleAfterSec]="129600"></app-freshness-pill>
            <span class="inv-var-salv">se recalcula cada noche</span>
          }
        </div>
      }

      <!-- [IC.12] LA BANDA EN DISPUTA, antes que el total que la contiene (Q.1 answer-first).
           El ajuste de Kepler declara la cantidad en PIEZAS y la valúa al costo de la CAJA en
           una parte de los renglones: ese importe se suma a las tarjetas de abajo igual que el
           resto, así que quien lee el total tiene que poder saber qué parte discute. -->
      @if (expuesto(); as x) {
        @if (x.skus > 0) {
          <p class="inv-var-warn">
            ⚠️ <strong>{{ x.skus }} renglones ({{ fmtMoney(x.publicado) }}{{ x.pct !== null ? ', el ' + x.pct + '% del total' : '' }})</strong>
            están valuados a un costo <strong>al menos 2 veces</strong> el que la captura de ese
            mismo día implica para el mismo SKU — la marca de que la cantidad va en piezas y el
            costo en cajas. Al costo contado serían <strong>{{ fmtMoney(x.contado) }}</strong>:
            hay <strong>{{ fmtMoney(x.diferencia) }}</strong> en disputa dentro de los números de
            abajo. El importe es el que Kepler asentó y no se corrige; se declara.
          </p>
        }
        @if (x.sinTestigo > 0) {
          <p class="inv-var-note">
            {{ x.sinTestigo }} renglones ({{ fmtMoney(x.pesosSinTestigo) }}) no se pudieron
            juzgar: su SKU no aparece en la captura de ese día. No cuentan como correctos.
          </p>
        }
      }

      <div class="surf-grid inv-var-kpis">
        <app-metric-card format="text" class="panel-col-3" label="Sobrante" tone="warn"
          [valueText]="fmtMoney(totals().sobrante)"
          [sub]="totals().skusSobrante + ' SKUs con más físico que teórico'"></app-metric-card>
        <app-metric-card format="text" class="panel-col-3" label="Faltante" tone="bad"
          [valueText]="fmtMoney(totals().faltante)"
          [sub]="totals().skusFaltante + ' SKUs con menos físico que teórico'"></app-metric-card>
        <app-metric-card format="text" class="panel-col-3" label="Neto"
          [valueText]="fmtMoney(totals().neto)"
          sub="Sobrante menos faltante"></app-metric-card>
        <app-metric-card class="panel-col-3" label="Eventos"
          [value]="events().length"
          sub="Conteos en el período"></app-metric-card>
      </div>

      <p-table [value]="events()" [loading]="loading()" dataKey="rowKey" styleClass="surf-table" [class.is-dense]="density.dense()"
        selectionMode="single" [(selection)]="selected" (selectionChange)="openDetail()">
        <ng-template #header>
          <tr>
            <th>Almacén</th><th>Fecha</th><th>Tipo</th>
            <th class="num">SKUs sobrante</th><th class="num">$ sobrante</th>
            <th class="num">SKUs faltante</th><th class="num">$ faltante</th>
            <th class="num">$ neto</th>
          </tr>
        </ng-template>
        <ng-template #body let-e>
          <tr [pSelectableRow]="e" class="inv-var-row"
              [class.inv-var-row-sel]="selected?.rowKey === e.rowKey">
            <td>
              <i class="pi" [ngClass]="selected?.rowKey === e.rowKey ? 'pi-angle-down' : 'pi-angle-right'"
                 aria-hidden="true"></i>
              {{ e.warehouse_code }} — {{ e.warehouse_name }}</td>
            <td>{{ e.fecha }}</td>
            <td>
              @if (e.tipo_evento === 'carga_inicial') {
                <p-tag severity="secondary" value="Carga inicial"></p-tag>
              } @else {
                <p-tag severity="info" value="Conteo"></p-tag>
              }
            </td>
            <td class="num tabular">{{ e.skus_sobrante }}</td>
            <td class="num tabular">{{ fmtMoney(e.pesos_sobrante) }}</td>
            <td class="num tabular">{{ e.skus_faltante }}</td>
            <td class="num tabular">{{ fmtMoney(e.pesos_faltante) }}</td>
            <td class="num tabular">{{ fmtMoney(e.pesos_neto) }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8" class="inv-var-empty">
            No hay conteos en el período. El inventario completo de Kepler es trimestral.
          </td></tr>
        </ng-template>
      </p-table>

      }

      @if (vista === 'diferencias' && selected) {
        <section class="inv-var-detail">
          <h2>{{ selected.warehouse_code }} · {{ selected.fecha }}</h2>

          @if (coverage(); as c) {
            <div class="inv-var-coverage">
              @if (c.pct_cubierto === null) {
                <p-tag severity="secondary" value="Cobertura sin medir"></p-tag>
                <span>No se pudo medir qué quedó sin contar.</span>
              } @else {
                <p-tag [severity]="c.pct_cubierto >= 90 ? 'success' : 'warn'"
                  [value]="c.pct_cubierto + '% contado'"></p-tag>
                <span>
                  <strong>{{ c.sin_contar }}</strong> SKUs con existencia
                  <strong>no se contaron</strong> ({{ c.contados }} de {{ c.con_existencia }}).
                </span>
              }
              @if (c.dias_desde_conteo > 21) {
                <span class="inv-var-warn">
                  Comparado contra la existencia de hoy, {{ c.dias_desde_conteo }} días después
                  del conteo: es orientativo.
                </span>
              }
            </div>
          }

          <!-- ⛔ El "debía haber" es DERIVADO: Kepler emite la diferencia, no el teórico.
               Cuánto no se pudo reconstruir va en pantalla, no en un .md que nadie abre. -->
          @if (sinTeorico() > 0) {
            <p class="inv-var-warn">
              ⚠️ <strong>{{ sinTeorico() }} de {{ lines().length }}</strong> renglones sin
              «debía haber»: el ajuste de Kepler excede lo capturado, así que el teórico daría
              negativo. Se muestran igual con su diferencia, que sí es dato directo.
            </p>
          }

          <p-table [value]="lines()" [loading]="loadingDetail()" styleClass="surf-table" [class.is-dense]="density.dense()"
            [scrollable]="true" scrollHeight="420px">
            <ng-template #header>
              <tr>
                <th>SKU</th><th>Descripción</th><th>Un.</th>
                <th class="num">Debía haber</th><th class="num">Se contó</th>
                <th class="num">Diferencia</th><th class="num">Costo</th><th class="num">Importe</th>
                <!-- [IC.12] El costo del ajuste contra el que implica la captura del MISMO día. -->
                <th>Costo vs. contado</th>
              </tr>
            </ng-template>
            <ng-template #body let-l>
              <tr>
                <td class="tabular">{{ l.sku }}</td>
                <td>{{ l.descripcion }}</td>
                <td>{{ l.unidad_erp }}</td>
                <!-- DERIVADO (contado −/+ diferencia): Kepler no guarda el teórico. Lo que no
                     se puede reconstruir sale con guion y su motivo, nunca con un número. -->
                <td class="num tabular">
                  @if (l.teorico === null || l.teorico === undefined) {
                    <span class="inv-var-nd" [pTooltip]="l.teorico_salvedad || ''">—</span>
                  } @else { {{ l.teorico }} }
                </td>
                <td class="num tabular">{{ l.contado ?? '—' }}</td>
                <td class="num tabular"
                    [class.inv-var-mas]="l.signo === 'sobrante'"
                    [class.inv-var-menos]="l.signo === 'faltante'">
                  {{ l.signo === 'sobrante' ? '+' : '−' }}{{ l.cantidad }}
                </td>
                <td class="num tabular">{{ fmtMoney(l.costo_unitario) }}</td>
                <td class="num tabular">{{ fmtMoney(l.importe) }}</td>
                <!-- La RAZÓN va en el tooltip, no sólo la etiqueta: un 12.0 clavado es un
                     peldaño y un 1.03 es deriva de costo, y eso se juzga viendo el número. -->
                <td>
                  <p-tag [severity]="veredictoSev(l.costo_veredicto)"
                    [value]="veredictoLabel(l.costo_veredicto)"
                    [pTooltip]="l.costo_contado != null
                      ? 'La captura de ese día implica ' + fmtMoney(l.costo_contado)
                        + ' por unidad (razón ' + l.razon_costo + '×)'
                        + (l.ficha_peldano === 'caja' && l.ficha_costo_base != null
                           ? '. La ficha de Kepler: ' + fmtMoney(l.ficha_costo_base) + ' la pieza, '
                             + fmtMoney(l.ficha_costo_caja) + ' la caja de ' + l.ficha_factor_caja
                           : '')
                      : 'Sin costo contado con qué juzgarlo: el SKU no está en la captura de ese día, o la captura lo valuó en cero'"
                  ></p-tag>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="9" class="inv-var-note">
                Sin renglones para este evento con el filtro actual.
              </td></tr>
            </ng-template>
          </p-table>
        </section>
      }
    </div>
  `,
  styles: [`
    .inv-var-filters { display: flex; gap: .75rem; align-items: center; margin-bottom: .75rem; flex-wrap: wrap; }
    .inv-var-toggle { display: inline-flex; gap: .5rem; align-items: center; font-size: var(--fs-xs); }
    .inv-var-note { font-size: var(--fs-xs); color: var(--fg-3); margin: 0 0 .75rem; }
    .inv-var-kpis { margin-bottom: 1rem; }
    .inv-var-fresh { display: flex; gap: .5rem; align-items: center; margin: -.5rem 0 1rem; }
    .inv-var-lectura { font-size: var(--fs-lg); color: var(--fg-1); margin: .25rem 0 1rem;
      max-width: 68ch; line-height: 1.45; }
    .inv-var-row { cursor: pointer; }
    .inv-var-row:hover { background: var(--surface-hover, rgba(0,0,0,.035)); }
    .inv-var-row-sel { background: var(--surface-hover, rgba(0,0,0,.055)); }
    .inv-var-row .pi { font-size: var(--fs-nano); opacity: .55; margin-right: .35rem; }
    .inv-var-nd { opacity: .5; cursor: help; }
    .inv-var-imposible { color: var(--bad-fg); text-decoration: underline dotted;
      text-underline-offset: 2px; cursor: help; }
    .inv-var-mas { color: var(--warn-fg); }
    .inv-var-menos { color: var(--bad-fg); }
    .inv-var-detail { margin-top: 1.25rem; }
    .inv-var-detail h2 { font-size: var(--fs-h3); margin: 0 0 .5rem; }
    .inv-var-coverage { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap;
      font-size: var(--fs-xs); margin-bottom: .625rem; }
    .inv-var-warn { color: var(--warn-fg); }
    .inv-var-empty { text-align: center; padding: 1.5rem; color: var(--fg-3); }
    .inv-var-tabs { margin-bottom: .75rem; }
    .inv-var-prog h2.inv-var-h2 { font-size: var(--fs-h3); margin: 1.25rem 0 .5rem; }
    .inv-var-salv { font-size: var(--fs-nano); color: var(--fg-3); }
    .num { text-align: right; }
    .tabular { font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialInventoryVarianceComponent {
  private readonly api = inject(ComercialService);
  /** §564 #2 — la densidad la elige quien usa la pantalla, y se recuerda entre pantallas. */
  readonly density = inject(TableDensityService);

  readonly events = signal<(InventoryVarianceEvent & { rowKey: string })[]>([]);
  /** [IC.12] Sale de una matview: sin esto la pantalla publicaría un número sin decir de cuándo
   *  es, que es el modo de falla que la Fase VP catalogó. Ternario: `unknown` no es `fresh`. */
  readonly frescura = signal<RollforwardFreshness | null>(null);
  readonly lines = signal<InventoryVarianceLine[]>([]);
  readonly coverage = signal<InventoryVarianceCoverage | null>(null);
  readonly loading = signal(false);
  readonly loadingDetail = signal(false);
  readonly warehouses = signal<Warehouse[]>([]);
  readonly plan = signal<InventoryCountPlan | null>(null);
  readonly cobertura = signal<{ cubre_todo: boolean; desvio_max_pct: number | null } | null>(null);
  readonly kpi = signal<InventoryVarianceKpi | null>(null);
  readonly reinc = signal<InventoryReincidencia | null>(null);
  readonly loadingReinc = signal(false);

  readonly rfPeriodos = signal<RollforwardPeriodos | null>(null);
  readonly rf = signal<{
    totales: RollforwardTotales; items: RollforwardItem[]; freshness: RollforwardFreshness;
  } | null>(null);
  readonly loadingRf = signal(false);

  readonly vistas = [
    { label: 'Diferencias', value: 'diferencias' },
    { label: 'Programa', value: 'programa' },
    { label: 'Reincidencia', value: 'reincidencia' },
    { label: 'Conciliación', value: 'conciliacion' },
  ];
  vista: 'diferencias' | 'programa' | 'reincidencia' | 'conciliacion' = 'diferencias';
  rfSel: string | null = null;
  rfVeredicto: string | null = null;

  readonly rfVeredictos = [
    { label: 'Todos', value: null as string | null },
    { label: 'Falta (merma)', value: 'merma' },
    { label: 'Sobra', value: 'sobrante' },
    { label: 'Cuadra', value: 'cuadra' },
    { label: 'Sin recontar', value: 'no_recontado' },
  ];

  readonly rfOpciones = computed(() => (this.rfPeriodos()?.periodos ?? []).map((x) => ({
    label: `${x.warehouse_code} — ${x.desde} → ${x.hasta}`,
    value: `${x.warehouse_id}|${x.desde}|${x.hasta}`,
  })));

  readonly rfPeriodoSel = computed<RollforwardPeriodo | null>(() => {
    const v = this.rfSel; if (!v) return null;
    const [id, d, h] = v.split('|');
    return (this.rfPeriodos()?.periodos ?? []).find(
      (x) => x.warehouse_id === id && x.desde === d && x.hasta === h) ?? null;
  });
  patronFilter: string | null = null;

  readonly patrones = [
    { label: 'Todos', value: null as string | null },
    { label: 'Merma (falta y no vuelve)', value: 'merma' },
    { label: 'Sobra (y no vuelve)', value: 'sobra' },
    { label: 'Se compensa (captura/unidad)', value: 'se_compensa' },
    { label: 'Mixto', value: 'mixto' },
  ];

  /** El resumen del servidor, ordenado como se lee: primero lo que cuesta dinero. */
  readonly resumenOrdenado = computed(() => {
    const orden = ['merma', 'sobra', 'mixto', 'se_compensa', 'sin_dinero'];
    return [...(this.reinc()?.resumen ?? [])]
      .sort((x, y) => orden.indexOf(x.patron) - orden.indexOf(y.patron));
  });

  warehouseFilter: string | null = null;
  includeInitialLoad = false;
  selected: (InventoryVarianceEvent & { rowKey: string }) | null = null;

  readonly warehouseOptions = computed(() => [
    { label: 'Todos los almacenes', value: null as string | null },
    ...this.warehouses().map((w) => ({ label: `${w.code} — ${w.name}`, value: w.id })),
  ]);

  /** Cuántos renglones del detalle no tienen «debía haber» reconstruible. */
  readonly sinTeorico = computed(
    () => this.lines().filter((l) => (l as { teorico?: number | null }).teorico == null).length);

  readonly totals = computed(() => {
    const e = this.events();
    return {
      sobrante: e.reduce((a, x) => a + Number(x.pesos_sobrante || 0), 0),
      faltante: e.reduce((a, x) => a + Number(x.pesos_faltante || 0), 0),
      neto: e.reduce((a, x) => a + Number(x.pesos_neto || 0), 0),
      skusSobrante: e.reduce((a, x) => a + Number(x.skus_sobrante || 0), 0),
      skusFaltante: e.reduce((a, x) => a + Number(x.skus_faltante || 0), 0),
    };
  });

  /**
   * [IC.12] LA BANDA EN DISPUTA — cuánto del total de arriba está valuado a un costo que la
   * captura de ese mismo día contradice por un factor de escalera.
   *
   * Va en pantalla y no en un `.md`: el importe de esos renglones se suma a las tarjetas igual
   * que el resto, así que quien lee el total tiene que poder saber qué parte discute.
   */
  readonly expuesto = computed(() => {
    const e = this.events();
    const skus = e.reduce((a, x) => a + Number(x.skus_peldano || 0), 0);
    const publicado = e.reduce((a, x) => a + Number(x.pesos_peldano || 0), 0);
    const contado = e.reduce((a, x) => a + Number(x.pesos_peldano_contado || 0), 0);
    const sinTestigo = e.reduce((a, x) => a + Number(x.skus_sin_testigo || 0), 0);
    const total = this.totals().sobrante + this.totals().faltante;
    return {
      skus, publicado, contado, diferencia: publicado - contado, sinTestigo,
      pesosSinTestigo: e.reduce((a, x) => a + Number(x.pesos_sin_testigo || 0), 0),
      // NULL, no 0: sin total no hay porcentaje que calcular.
      pct: total > 0 ? Math.round((publicado / total) * 1000) / 10 : null,
    };
  });

  /** Etiqueta del veredicto del costo, en llano. */
  veredictoLabel(v: string | undefined): string {
    return { coincide: 'Cuadra', difiere: 'Diferencia',
      peldano_arriba: 'Costo de caja', peldano_abajo: 'Costo por debajo',
      sin_testigo: 'Sin testigo' }[v ?? ''] ?? '—';
  }

  veredictoSev(v: string | undefined): 'danger' | 'warn' | 'success' | 'secondary' {
    return v === 'peldano_arriba' ? 'danger' : v === 'peldano_abajo' ? 'warn'
      : v === 'coincide' ? 'success' : 'secondary';
  }

  constructor() {
    this.api.listWarehouses(true).subscribe((w) => this.warehouses.set(w ?? []));
    this.load();
  }

  /** [IC.6] Cambiar de pestaña recarga lo de esa vista, no todo. */
  onVista() {
    if (this.vista === 'programa') this.loadPrograma();
    else if (this.vista === 'reincidencia') this.loadReincidencia();
    else if (this.vista === 'conciliacion') this.loadConciliacion();
    else this.load();
  }

  loadConciliacion() {
    if (!this.rfPeriodos()) {
      this.api.inventoryRollforwardPeriodos().subscribe({
        next: (r) => {
          this.rfPeriodos.set(r);
          // Arranca en el período más reciente del almacén filtrado, o el primero que haya:
          // una pantalla que abre vacía obliga a adivinar qué elegir.
          const pref = this.warehouseFilter
            ? r.periodos.find((x) => x.warehouse_id === this.warehouseFilter)
            : r.periodos[0];
          if (pref) { this.rfSel = `${pref.warehouse_id}|${pref.desde}|${pref.hasta}`; this.loadRf(); }
        },
        error: () => this.rfPeriodos.set(null),
      });
    } else if (this.rfSel) this.loadRf();
  }

  loadRf() {
    if (!this.rfSel) { this.rf.set(null); return; }
    const [warehouse_id, desde, hasta] = this.rfSel.split('|');
    this.loadingRf.set(true);
    this.api.inventoryRollforward({
      warehouse_id, desde, hasta,
      veredicto: this.rfVeredicto ?? undefined, limit: 150,
    }).subscribe({
      next: (r) => { this.rf.set(r); this.loadingRf.set(false); },
      error: () => { this.rf.set(null); this.loadingRf.set(false); },
    });
  }

  /**
   * [Q.2 de DESIGN.md] El número no se muestra solo: se explica en llano. Es la primera línea
   * de la pantalla porque la conclusión va antes que la evidencia (Q.1, answer-first).
   */
  readonly rfLectura = computed(() => {
    const t = this.rf()?.totales; const p = this.rfPeriodoSel();
    if (!t || !p) return '';
    const merma = Math.abs(Number(t.importe_merma || 0));
    const sobra = Number(t.importe_sobrante || 0);
    const neto = sobra - merma;
    const q = `En ${p.warehouse_name}, entre el ${p.desde} y el ${p.hasta} (${t.dias} días), `;
    if (t.merma === 0 && t.sobrante === 0) return q + 'todo lo contado se explica con los movimientos.';
    const cuerpo = neto < 0
      ? `faltan ${this.fmtMoney(merma)} que los movimientos no explican`
      : `sobran ${this.fmtMoney(sobra)} que los movimientos no explican`;
    return q + cuerpo + ` (${t.merma} SKUs faltan, ${t.sobrante} sobran, ${t.cuadra} cuadran).`;
  });

  /** ⛔ Qué parte del almacén NO mide este período. Si es la mayoría, el total engaña. */
  readonly rfCobertura = computed(() => {
    const t = this.rf()?.totales; if (!t || !t.skus) return null;
    return { sin: t.sin_recontar, total: t.skus, pct: Math.round((t.sin_recontar / t.skus) * 100) };
  });

  vereSev(v: string): 'danger' | 'warn' | 'success' | 'secondary' {
    return v === 'merma' ? 'danger' : v === 'sobrante' ? 'warn'
      : v === 'cuadra' ? 'success' : 'secondary';
  }

  vereLabel(v: string): string {
    return { merma: 'Falta', sobrante: 'Sobra', cuadra: 'Cuadra',
      no_recontado: 'Sin recontar' }[v] ?? v;
  }

  /**
   * [IC.3b] Sin almacén la consulta cuesta ~1.1 s y con almacén ~0.65 s — por eso la pantalla
   * pide elegir uno, igual que Programa. No es una limitación oculta: está medido y dicho.
   */
  loadReincidencia() {
    this.loadingReinc.set(true);
    this.api.inventoryReincidencia({
      warehouse_id: this.warehouseFilter ?? undefined,
      patron: this.patronFilter ?? undefined,
      limit: 100,
    }).subscribe({
      next: (r) => { this.reinc.set(r); this.loadingReinc.set(false); },
      error: () => { this.reinc.set(null); this.loadingReinc.set(false); },
    });
  }

  /** Lo que la fila significa en una línea, que es lo que la persona necesita leer. */
  lectura(i: InventoryReincidenciaItem): string {
    if (i.forma === 'evento_aislado' && i.patron !== 'se_compensa')
      return 'Un solo conteo explica casi todo: revisá ESA captura, no el anaquel';
    if (i.patron === 'se_compensa') return 'Entra y sale: huele a unidad o a captura, no a faltante';
    if (i.patron === 'merma') return 'Falta siempre y no vuelve — el caso que hay que ir a ver';
    if (i.patron === 'sobra') return 'Sobra siempre: entradas sin registrar o unidad mal declarada';
    return 'Alterna sin patrón claro';
  }

  patronSev(p: string): 'danger' | 'warn' | 'info' | 'secondary' {
    return p === 'merma' ? 'danger' : p === 'sobra' ? 'warn'
      : p === 'se_compensa' ? 'info' : 'secondary';
  }

  patronLabel(p: string): string {
    return { merma: 'Merma', sobra: 'Sobra', se_compensa: 'Se compensa',
      mixto: 'Mixto', sin_dinero: 'Sin dinero' }[p] ?? p;
  }

  loadPrograma() {
    // El KPI no depende del almacén elegido: si no hay filtro, es el global.
    this.api.inventoryVarianceKpi(this.warehouseFilter ?? undefined)
      .subscribe({ next: (k) => this.kpi.set(k), error: () => this.kpi.set(null) });
    if (!this.warehouseFilter) { this.plan.set(null); this.cobertura.set(null); return; }
    this.api.inventoryCountPlan({ warehouse_id: this.warehouseFilter })
      .subscribe({ next: (p) => this.plan.set(p), error: () => this.plan.set(null) });
    this.api.inventoryWaveCoverage(this.warehouseFilter)
      .subscribe({ next: (c) => this.cobertura.set(c), error: () => this.cobertura.set(null) });
  }

  load() {
    if (this.vista === 'programa') { this.loadPrograma(); return; }
    this.loading.set(true);
    this.selected = null;
    this.lines.set([]);
    this.coverage.set(null);
    this.api.inventoryVarianceSummary({
      warehouse_id: this.warehouseFilter ?? undefined,
      include_initial_load: this.includeInitialLoad,
    }).subscribe({
      next: (res) => {
        this.events.set((res?.items ?? []).map(
          (r) => ({ ...r, rowKey: `${r.warehouse_id}|${r.fecha}` })));
        this.frescura.set(res?.freshness ?? null);
        this.loading.set(false);
      },
      // ⛔ En el error la frescura se BORRA. Dejar la anterior haría que la píldora siguiera
      // diciendo "actualizado" sobre una tabla vacía.
      error: () => { this.events.set([]); this.frescura.set(null); this.loading.set(false); },
    });
  }

  openDetail() {
    const e = this.selected;
    if (!e) { this.lines.set([]); this.coverage.set(null); return; }
    this.loadingDetail.set(true);
    this.api.inventoryVarianceDetail({ warehouse_id: e.warehouse_id, fecha: e.fecha })
      .subscribe({
        next: (l) => { this.lines.set(l ?? []); this.loadingDetail.set(false); },
        error: () => { this.lines.set([]); this.loadingDetail.set(false); },
      });
    // La cobertura sólo tiene sentido para un conteo: una carga inicial no "deja sin contar",
    // trae lo que el ERP viejo tenía.
    if (e.tipo_evento === 'conteo') {
      this.api.inventoryVarianceCoverage(e.warehouse_id, e.fecha)
        .subscribe({ next: (c) => this.coverage.set(c), error: () => this.coverage.set(null) });
    }
  }

  fmtMoney(n: number | null | undefined): string {
    if (n == null) return '—';
    return '$' + Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  }
}
