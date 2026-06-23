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
        <p-select [options]="warehouses()" optionLabel="code" optionValue="id" [(ngModel)]="warehouseId" (onChange)="load()"
          placeholder="Todos los almacenes" [showClear]="true" styleClass="ira-wh"></p-select>
        <span class="ira-tol">
          <label>Tolerancia %</label>
          <p-inputNumber [(ngModel)]="tolerancePct" [min]="0" [max]="100" [maxFractionDigits]="2" (onBlur)="load()"></p-inputNumber>
        </span>
        <button pButton label="Actualizar" icon="pi pi-refresh" [text]="true" (click)="load()"></button>
      </div>

      @if (data(); as d) {
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
            [sub]="'teórico ' + money0(d.expected_value)"></app-metric-card>

          <app-metric-card class="panel-col-3"
            label="Variación neta" [value]="d.net_variance_value" format="currency"
            [accent]="varianceAccent(d.net_variance_value)"
            [sub]="varianceLabel(d)"></app-metric-card>

          <app-metric-card class="panel-col-3"
            label="Folios reconciliados" [value]="d.folios" format="number"
            accent="var(--chart-6)" [sub]="'tolerancia ' + d.tolerance_pct + '%'"></app-metric-card>
        </div>

        <section class="ira-section">
          <h2>Shrinkage por causa</h2>
          @if (d.by_reason.length) {
            <p-table [value]="d.by_reason" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--zebra p-datatable-sm" [tableStyle]="{ 'min-width': '32rem' }">
              <ng-template pTemplate="header">
                <tr><th scope="col">Motivo</th><th scope="col" class="num">Items</th><th scope="col" class="num">Unidades</th><th scope="col" class="num">Valor</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-r>
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
            <p-table [value]="d.recent_folios" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra p-datatable-sm" [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template pTemplate="header">
                <tr><th scope="col">Folio</th><th scope="col">Almacén</th><th scope="col">Reconciliado</th><th scope="col" class="num">IRA</th><th scope="col" class="num">Variación neta</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-r>
                <tr>
                  <td><a [routerLink]="['/comercial/inventory/sessions', r.count_id]" class="ira-folio">{{ r.folio }}</a></td>
                  <td>{{ r.warehouse_code || '—' }}</td>
                  <td>{{ r.reconciled_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td class="num"><p-tag [value]="r.ira_pct !== null ? (r.ira_pct + '%') : '—'" [severity]="iraSeverity(r.ira_pct)"></p-tag></td>
                  <td class="num" [class.ira-bad]="r.net_variance_value < 0">{{ r.net_variance_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else { <p class="ira-empty">Aún no hay folios reconciliados{{ warehouseId() ? ' en este almacén' : '' }}.</p> }
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
  `],
})
export class ComercialInventoryIraComponent {
  private svc = inject(ComercialService);
  private destroyRef = inject(DestroyRef);

  warehouses = signal<Warehouse[]>([]);
  warehouseId = signal<string | null>(null);
  tolerancePct = signal<number>(0);
  data = signal<InventoryIra | null>(null);
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
    this.svc.inventoryIra({ warehouse_id: this.warehouseId() || undefined, tolerance_pct: this.tolerancePct() ?? 0 })
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
  varianceAccent(v: number): string {
    if (v < 0) return 'var(--bad-fg)';
    if (v > 0) return 'var(--ok-fg)';
    return 'var(--chart-8)';
  }
  varianceLabel(d: InventoryIra): string {
    const dir = d.net_variance_value < 0 ? 'merma' : d.net_variance_value > 0 ? 'sobrante' : 'sin diferencia';
    return `${dir} · |Δ| ${this.money0(d.abs_variance_value)}`;
  }

  iraSeverity(pct: number | null): 'success' | 'warn' | 'danger' | 'secondary' {
    if (pct === null) return 'secondary';
    if (pct >= 97) return 'success';
    if (pct >= 90) return 'warn';
    return 'danger';
  }
}
