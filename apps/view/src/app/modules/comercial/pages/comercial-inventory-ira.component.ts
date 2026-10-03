import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { ComercialService, InventoryIra, Warehouse } from '../comercial.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

/**
 * KPI de exactitud de inventario (IRA) sobre folios reconciliados (Fase I.5 / P1).
 * Exactitud por piezas + por valor, merma neta y desglose de shrinkage por causa
 * (habilitado por reason_code). Superficie Operations: tabla densa, sin adornos.
 */
@Component({
  selector: 'app-comercial-inventory-ira',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, ButtonModule, TableModule, TagModule, SelectModule, InputNumberModule, MetricCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page ira">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Exactitud de inventario (IRA)</h1>
          <p>Sobre folios reconciliados. Exactitud por piezas y por valor + merma por causa.</p>
        </div>
      </header>

      <div class="ira-filters">
        <p-select [options]="warehouseOptions()" optionLabel="code" optionValue="id" [(ngModel)]="warehouseFilter" (onChange)="load()"
          styleClass="ira-wh"></p-select>
        <span class="ira-tol">
          <label>Tolerancia %</label>
          <p-inputnumber [(ngModel)]="tolerancePct" [min]="0" [max]="100" [maxFractionDigits]="2" (onBlur)="load()"></p-inputnumber>
        </span>
        <button pButton [text]="true" (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
      </div>

      @if (data(); as d) {
        <!-- [IRA.1] ANSWER-FIRST. El IRA solo mira folios RECONCILIADOS; si no hay ninguno, las
             cuatro tarjetas salen en guion y nadie puede deducir que lo que falta no es
             descuadre sino el proceso entero. Medido en prod: 6 folios cancelados, 18,845
             renglones y 9 contados. Eso es un diagnostico; cuatro guiones no lo son. -->
        @if (!d.folios) {
          <p class="ira-alerta">
            <b>Ningun folio reconciliado todavia</b>, asi que no hay exactitud que medir &mdash;
            lo que falta no es descuadre, es el proceso.
            @if (d.sin_reconciliar.length) {
              @for (o of d.sin_reconciliar; track o.status) {
                <span class="ira-alerta-det">
                  Hay <b>{{ o.folios }}</b> folio(s) en estado <b>{{ estadoLabel(o.status) }}</b>
                  con <b>{{ o.renglones | number }}</b> renglones, de los que se contaron
                  <b>{{ o.tocados | number }}</b>
                  ({{ o.renglones ? ((o.tocados / o.renglones) * 100 | number:'1.0-2') : 0 }}%)
                  &mdash; {{ o.desde | date:'dd/MM/yy' }} a {{ o.hasta | date:'dd/MM/yy' }},
                  almacenes {{ o.almacenes || '&mdash;' }}.
                </span>
              }
            } @else {
              <span class="ira-alerta-det">Tampoco hay folios abiertos ni cancelados.</span>
            }
          </p>
        }

        <!-- El costo ausente entra al calculo valuado en CERO, o sea que una diferencia sin
             costo se ve como si no hubiera diferencia. Se declara en vez de dejar que el
             porcentaje suba solo. -->
        @if (d.items_sin_costo > 0) {
          <p class="ira-alerta">
            <b>{{ d.items_sin_costo | number }}</b> renglones no tienen costo que resolver.
            Entran valuados en cero, asi que su diferencia no pesa y la
            <b>exactitud por valor sale mas alta de lo que es</b>.
          </p>
        }

        <div class="surf-grid ira-bento">
          <app-metric-card class="panel-col-3"
            label="IRA (piezas)"
            [variant]="d.ira_pct !== null ? 'gauge' : 'plain'" format="text" valueText="—"
            [value]="d.ira_pct ?? 0" [gaugeMax]="100" [accent]="iraAccent(d.ira_pct)"
            [sub]="d.accurate_items + ' / ' + d.total_items + ' exactos'"></app-metric-card>

          <app-metric-card class="panel-col-3"
            label="Exactitud por valor"
            [variant]="d.value_accuracy_pct !== null ? 'gauge' : 'plain'" format="text" valueText="—"
            [value]="d.value_accuracy_pct ?? 0" [gaugeMax]="100" accent="var(--chart-2)"
            [sub]="d.expected_value !== null ? ('teórico ' + money0(d.expected_value)) : 'sin base para calcularlo'"></app-metric-card>

          <app-metric-card class="panel-col-3"
            label="Variación neta"
            [variant]="d.net_variance_value !== null ? 'plain' : 'plain'"
            [format]="d.net_variance_value !== null ? 'currency' : 'text'"
            [value]="d.net_variance_value ?? 0" valueText="&mdash;"
            [accent]="varianceAccent(d.net_variance_value)"
            [sub]="varianceLabel(d)"></app-metric-card>

          <app-metric-card class="panel-col-3"
            label="Folios reconciliados" [value]="d.folios" format="number"
            accent="var(--chart-6)"
            [sub]="d.tolerance_pct === 0
              ? 'tolerancia 0%: exacto = diferencia CERO'
              : ('tolerancia ' + d.tolerance_pct + '% del teórico')"></app-metric-card>
        </div>

        <section class="ira-section">
          <h2>Shrinkage por causa</h2>
          @if (d.by_reason.length) {
            <p-table [value]="d.by_reason" styleClass="surf-table surf-table--sticky p-datatable-sm" [tableStyle]="{ 'min-width': '32rem' }">
              <ng-template #header>
                <tr><th scope="col">Motivo</th><th scope="col" class="num">Items</th><th scope="col" class="num">Unidades</th><th scope="col" class="num">Valor</th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td>{{ reasonLabel(r.reason_code) }}</td>
                  <td class="num">{{ r.items }}</td>
                  <td class="num">{{ r.units | number:'1.0-3' }}</td>
                  <td class="num">{{ r.value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else { <p class="ira-empty">Sin varianzas clasificadas en el rango.</p> }
        </section>

        <section class="ira-section">
          <h2>Folios recientes</h2>
          @if (d.recent_folios.length) {
            <p-table [value]="d.recent_folios" styleClass="surf-table surf-table--sticky surf-table--frozen-first p-datatable-sm" [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template #header>
                <tr><th scope="col">Folio</th><th scope="col">Almacén</th><th scope="col">Reconciliado</th><th scope="col" class="num">IRA</th><th scope="col" class="num">Variación neta</th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td><a [routerLink]="['/almacen/inventory/sessions', r.count_id]" class="ira-folio">{{ r.folio }}</a></td>
                  <td>{{ r.warehouse_code || '—' }}</td>
                  <td>{{ r.reconciled_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td class="num"><p-tag [value]="r.ira_pct !== null ? (r.ira_pct + '%') : '—'" [severity]="iraSeverity(r.ira_pct)"></p-tag></td>
                  <td class="num" [class.ira-bad]="r.net_variance_value < 0">{{ r.net_variance_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else { <p class="ira-empty">Aún no hay folios reconciliados{{ isSpecific() ? ' en este almacén' : '' }}.</p> }
        </section>
      } @else {
        <p class="ira-empty">Cargando…</p>
      }
    </div>
  `,
  styles: [`
    .ira-filters { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; margin-bottom: 1rem; }
    .ira-tol { display: flex; flex-direction: column; gap: .25rem; }
    .ira-tol label { font-size: .8rem; color: var(--c-text-2); }
    .ira-bento { margin-bottom: 1.5rem; }
    .ira-bad { color: var(--bad-fg); }
    .ira-section { margin-bottom: 1.5rem; }
    .ira-section h2 { font-size: 1rem; margin: 0 0 .5rem; }
    .ira-folio { font-family: var(--font-mono, monospace); }
    .ira-empty { color: var(--c-text-2); font-size: .9rem; }
    /* [IRA.1] El diagnostico va arriba y se ve: no es una nota al pie. */
    .ira-alerta {
      font-size: var(--fs-xs); color: var(--warn-fg); margin: 0 0 1rem;
      padding: .5rem .8rem; border-left: 3px solid var(--warn-fg);
      background: color-mix(in srgb, var(--warn-fg) 7%, transparent); border-radius: 4px;
      line-height: 1.5; max-width: 96ch;
    }
    .ira-alerta-det { display: block; color: var(--fg-3); margin-top: .2rem; }
  `],
})
export class ComercialInventoryIraComponent {
  private svc = inject(ComercialService);
  private destroyRef = inject(DestroyRef);

  readonly ALL = '__all__';
  warehouses = signal<Warehouse[]>([]);
  warehouseFilter = this.ALL;
  warehouseOptions = computed(() => [
    { id: this.ALL, code: 'Todos los almacenes', name: 'Todos los almacenes' } as unknown as Warehouse,
    ...this.warehouses(),
  ]);
  tolerancePct = 0;
  isSpecific(): boolean { return this.warehouseFilter !== this.ALL; }
  private whParam(): string | undefined { return this.isSpecific() ? this.warehouseFilter : undefined; }
  data = signal<InventoryIra | null>(null);

  /** [IRA.1] El estado del folio, en llano: la pantalla la lee quien cuenta, no quien codea. */
  estadoLabel(st: string): string {
    return { cancelled: 'cancelado', open: 'abierto', counting: 'en conteo',
      review: 'en revisión', closed: 'cerrado' }[st] ?? st;
  }
  private reasonMap = signal<Record<string, string>>({});

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (w) => this.warehouses.set(w), error: () => { /* no crítico */ } });
    this.svc.inventoryVarianceReasons()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (rs) => this.reasonMap.set(Object.fromEntries(rs.map((r) => [r.code, r.label]))), error: () => { /* no crítico */ } });
    this.load();
  }

  load() {
    this.svc.inventoryIra({ warehouse_id: this.whParam(), tolerance_pct: this.tolerancePct })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.data.set(d), error: () => { /* no crítico */ } });
  }

  reasonLabel(code: string): string {
    if (code === 'sin_clasificar') return 'Sin clasificar';
    return this.reasonMap()[code] || code;
  }

  money0(n: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }).format(n || 0);
  }

  iraAccent(pct: number | null): string {
    if (pct === null) return 'var(--chart-8)';
    if (pct >= 97) return 'var(--ok-fg)';
    if (pct >= 90) return 'var(--warn-fg)';
    return 'var(--bad-fg)';
  }
  /** [IRA.1] `null` = no hay con qué calcularla, y eso NO es un acento neutro de "cero". */
  varianceAccent(v: number | null): string {
    if (v === null) return 'var(--chart-8)';
    if (v < 0) return 'var(--bad-fg)';
    if (v > 0) return 'var(--ok-fg)';
    return 'var(--chart-8)';
  }
  varianceLabel(d: InventoryIra): string {
    // ⛔ "sin diferencia" sobre cero folios es una afirmación que nadie midió.
    if (d.net_variance_value === null) return 'sin folios reconciliados que medir';
    const dir = d.net_variance_value < 0 ? 'merma' : d.net_variance_value > 0 ? 'sobrante' : 'sin diferencia';
    return `${dir} · |Δ| ${this.money0(d.abs_variance_value ?? 0)}`;
  }

  iraSeverity(pct: number | null): 'success' | 'warn' | 'danger' | 'secondary' {
    if (pct === null) return 'secondary';
    if (pct >= 97) return 'success';
    if (pct >= 90) return 'warn';
    return 'danger';
  }
}
