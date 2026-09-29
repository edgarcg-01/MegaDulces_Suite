import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import {
  ComercialService, InventoryVarianceEvent, InventoryVarianceLine,
  InventoryVarianceCoverage, Warehouse,
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
    ToggleSwitchModule, MetricCardComponent],
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

      @if (!includeInitialLoad) {
        <p class="inv-var-note">
          Las <strong>cargas iniciales</strong> (cuando una sucursal migra de Wincaja a Kepler)
          están fuera: cuadran consigo mismas y no son descuadre. Son $30.8M en el histórico.
        </p>
      }

      <div class="surf-grid inv-var-kpis">
        <app-metric-card class="panel-col-3" label="Sobrante" tone="warn"
          [valueText]="fmtMoney(totals().sobrante)"
          [sub]="totals().skusSobrante + ' SKUs con más físico que teórico'"></app-metric-card>
        <app-metric-card class="panel-col-3" label="Faltante" tone="bad"
          [valueText]="fmtMoney(totals().faltante)"
          [sub]="totals().skusFaltante + ' SKUs con menos físico que teórico'"></app-metric-card>
        <app-metric-card class="panel-col-3" label="Neto"
          [valueText]="fmtMoney(totals().neto)"
          sub="Sobrante menos faltante"></app-metric-card>
        <app-metric-card class="panel-col-3" label="Eventos"
          [value]="events().length"
          sub="Conteos en el período"></app-metric-card>
      </div>

      <p-table [value]="events()" [loading]="loading()" dataKey="rowKey" styleClass="surf-table"
        selectionMode="single" [(selection)]="selected" (selectionChange)="openDetail()">
        <ng-template pTemplate="header">
          <tr>
            <th>Almacén</th><th>Fecha</th><th>Tipo</th>
            <th class="num">SKUs sobrante</th><th class="num">$ sobrante</th>
            <th class="num">SKUs faltante</th><th class="num">$ faltante</th>
            <th class="num">$ neto</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-e>
          <tr [pSelectableRow]="e">
            <td>{{ e.warehouse_code }} — {{ e.warehouse_name }}</td>
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
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="inv-var-empty">
            No hay conteos en el período. El inventario completo de Kepler es trimestral.
          </td></tr>
        </ng-template>
      </p-table>

      @if (selected) {
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

          <p-table [value]="lines()" [loading]="loadingDetail()" styleClass="surf-table"
            [scrollable]="true" scrollHeight="420px">
            <ng-template pTemplate="header">
              <tr>
                <th>SKU</th><th>Descripción</th><th>Unidad</th><th>Signo</th>
                <th class="num">Cantidad</th><th class="num">Costo</th><th class="num">Importe</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-l>
              <tr>
                <td class="tabular">{{ l.sku }}</td>
                <td>{{ l.descripcion }}</td>
                <td>{{ l.unidad_erp }}</td>
                <td>
                  <p-tag [severity]="l.signo === 'sobrante' ? 'warn' : 'danger'"
                    [value]="l.signo"></p-tag>
                </td>
                <td class="num tabular">{{ l.cantidad }}</td>
                <td class="num tabular">{{ fmtMoney(l.costo_unitario) }}</td>
                <td class="num tabular">{{ fmtMoney(l.importe) }}</td>
              </tr>
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
    .inv-var-detail { margin-top: 1.25rem; }
    .inv-var-detail h2 { font-size: 1rem; margin: 0 0 .5rem; }
    .inv-var-coverage { display: flex; gap: .625rem; align-items: center; flex-wrap: wrap;
      font-size: .8125rem; margin-bottom: .625rem; }
    .inv-var-warn { color: var(--warn, #b45309); }
    .inv-var-empty { text-align: center; padding: 1.5rem; color: var(--text-muted, #78716c); }
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

  warehouseFilter: string | null = null;
  includeInitialLoad = false;
  selected: (InventoryVarianceEvent & { rowKey: string }) | null = null;

  readonly warehouseOptions = computed(() => [
    { label: 'Todos los almacenes', value: null as string | null },
    ...this.warehouses().map((w) => ({ label: `${w.code} — ${w.name}`, value: w.id })),
  ]);

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

  load() {
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
