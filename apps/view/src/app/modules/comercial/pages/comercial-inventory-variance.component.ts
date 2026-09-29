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
} from '../comercial.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

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
    ToggleSwitchModule, SelectButtonModule, TooltipModule, MetricCardComponent],
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
              <p-table [value]="pl.items" styleClass="surf-table" [scrollable]="true" scrollHeight="360px">
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
            <p-table [value]="k.periodos" styleClass="surf-table">
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

            <p-table [value]="r.items" styleClass="surf-table" [scrollable]="true"
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

      <p-table [value]="events()" [loading]="loading()" dataKey="rowKey" styleClass="surf-table"
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

          <p-table [value]="lines()" [loading]="loadingDetail()" styleClass="surf-table"
            [scrollable]="true" scrollHeight="420px">
            <ng-template #header>
              <tr>
                <th>SKU</th><th>Descripción</th><th>Un.</th>
                <th class="num">Debía haber</th><th class="num">Se contó</th>
                <th class="num">Diferencia</th><th class="num">Costo</th><th class="num">Importe</th>
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
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="8" class="inv-var-note">
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
    .inv-var-toggle { display: inline-flex; gap: .5rem; align-items: center; font-size: .8125rem; }
    .inv-var-note { font-size: .8125rem; color: var(--text-muted, #78716c); margin: 0 0 .75rem; }
    .inv-var-kpis { margin-bottom: 1rem; }
    .inv-var-row { cursor: pointer; }
    .inv-var-row:hover { background: var(--surface-hover, rgba(0,0,0,.035)); }
    .inv-var-row-sel { background: var(--surface-hover, rgba(0,0,0,.055)); }
    .inv-var-row .pi { font-size: .75rem; opacity: .55; margin-right: .35rem; }
    .inv-var-nd { opacity: .5; cursor: help; }
    .inv-var-mas { color: var(--p-amber-600, #b45309); }
    .inv-var-menos { color: var(--p-red-600, #dc2626); }
    .inv-var-detail { margin-top: 1.25rem; }
    .inv-var-detail h2 { font-size: 1rem; margin: 0 0 .5rem; }
    .inv-var-coverage { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap;
      font-size: .8125rem; margin-bottom: .625rem; }
    .inv-var-warn { color: var(--warn, #b45309); }
    .inv-var-empty { text-align: center; padding: 1.5rem; color: var(--text-muted, #78716c); }
    .inv-var-tabs { margin-bottom: .75rem; }
    .inv-var-prog h2.inv-var-h2 { font-size: 1rem; margin: 1.25rem 0 .5rem; }
    .inv-var-salv { font-size: .75rem; color: var(--text-muted, #78716c); }
    .num { text-align: right; }
    .tabular { font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialInventoryVarianceComponent {
  private readonly api = inject(ComercialService);

  readonly events = signal<(InventoryVarianceEvent & { rowKey: string })[]>([]);
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

  readonly vistas = [
    { label: 'Diferencias', value: 'diferencias' },
    { label: 'Programa', value: 'programa' },
    { label: 'Reincidencia', value: 'reincidencia' },
  ];
  vista: 'diferencias' | 'programa' | 'reincidencia' = 'diferencias';
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

  constructor() {
    this.api.listWarehouses(true).subscribe((w) => this.warehouses.set(w ?? []));
    this.load();
  }

  /** [IC.6] Cambiar de pestaña recarga lo de esa vista, no todo. */
  onVista() {
    if (this.vista === 'programa') this.loadPrograma();
    else if (this.vista === 'reincidencia') this.loadReincidencia();
    else this.load();
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
      next: (rows) => {
        this.events.set((rows ?? []).map((r) => ({ ...r, rowKey: `${r.warehouse_id}|${r.fecha}` })));
        this.loading.set(false);
      },
      error: () => { this.events.set([]); this.loading.set(false); },
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
