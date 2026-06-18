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

/**
 * KPI de exactitud de inventario (IRA) sobre folios reconciliados (Fase I.5 / P1).
 * Exactitud por piezas + por valor, merma neta y desglose de shrinkage por causa
 * (habilitado por reason_code). Superficie Operations: tabla densa, sin adornos.
 */
@Component({
  selector: 'app-comercial-inventory-ira',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, ButtonModule, TableModule, TagModule, SelectModule, InputNumberModule],
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
        <div class="ira-kpis">
          <div class="ira-kpi">
            <span class="ira-kpi-label">IRA (piezas)</span>
            <span class="ira-kpi-val" [class.ira-good]="(d.ira_pct ?? 0) >= 97" [class.ira-bad]="d.ira_pct !== null && d.ira_pct < 90">{{ d.ira_pct !== null ? (d.ira_pct + '%') : '—' }}</span>
            <span class="ira-kpi-sub">{{ d.accurate_items }} / {{ d.total_items }} exactos</span>
          </div>
          <div class="ira-kpi">
            <span class="ira-kpi-label">Exactitud por valor</span>
            <span class="ira-kpi-val">{{ d.value_accuracy_pct !== null ? (d.value_accuracy_pct + '%') : '—' }}</span>
            <span class="ira-kpi-sub">teórico {{ d.expected_value | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
          </div>
          <div class="ira-kpi">
            <span class="ira-kpi-label">Variación neta</span>
            <span class="ira-kpi-val" [class.ira-bad]="d.net_variance_value < 0" [class.ira-good]="d.net_variance_value > 0">{{ d.net_variance_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            <span class="ira-kpi-sub">{{ d.net_variance_value < 0 ? 'merma' : (d.net_variance_value > 0 ? 'sobrante' : 'sin diferencia') }} · |Δ| {{ d.abs_variance_value | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
          </div>
          <div class="ira-kpi">
            <span class="ira-kpi-label">Folios reconciliados</span>
            <span class="ira-kpi-val">{{ d.folios }}</span>
            <span class="ira-kpi-sub">tolerancia {{ d.tolerance_pct }}%</span>
          </div>
        </div>

        <section class="ira-section">
          <h2>Shrinkage por causa</h2>
          @if (d.by_reason.length) {
            <p-table [value]="d.by_reason" styleClass="p-datatable-sm" [tableStyle]="{ 'min-width': '32rem' }">
              <ng-template pTemplate="header">
                <tr><th>Motivo</th><th class="in-num">Items</th><th class="in-num">Unidades</th><th class="in-num">Valor</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-r>
                <tr>
                  <td>{{ reasonLabel(r.reason_code) }}</td>
                  <td class="in-num">{{ r.items }}</td>
                  <td class="in-num">{{ r.units | number:'1.0-3' }}</td>
                  <td class="in-num">{{ r.value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else { <p class="ira-empty">Sin varianzas clasificadas en el rango.</p> }
        </section>

        <section class="ira-section">
          <h2>Folios recientes</h2>
          @if (d.recent_folios.length) {
            <p-table [value]="d.recent_folios" styleClass="p-datatable-sm" [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template pTemplate="header">
                <tr><th>Folio</th><th>Almacén</th><th>Reconciliado</th><th class="in-num">IRA</th><th class="in-num">Variación neta</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-r>
                <tr>
                  <td><a [routerLink]="['/comercial/inventory/sessions', r.count_id]" class="ira-folio">{{ r.folio }}</a></td>
                  <td>{{ r.warehouse_code || '—' }}</td>
                  <td>{{ r.reconciled_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td class="in-num"><p-tag [value]="r.ira_pct !== null ? (r.ira_pct + '%') : '—'" [severity]="iraSeverity(r.ira_pct)"></p-tag></td>
                  <td class="in-num" [class.ira-bad]="r.net_variance_value < 0">{{ r.net_variance_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
    .ira-tol label { font-size: .8rem; color: var(--text-muted, #78716c); }
    .ira-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem; margin-bottom: 1.5rem; }
    .ira-kpi { display: flex; flex-direction: column; gap: .2rem; padding: .9rem 1rem; border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); background: var(--card-bg, #fff); }
    .ira-kpi-label { font-size: .8rem; color: var(--text-muted, #78716c); }
    .ira-kpi-val { font-size: 1.5rem; font-weight: 700; }
    .ira-kpi-sub { font-size: .78rem; color: var(--text-muted, #78716c); }
    .ira-good { color: var(--ok, #16a34a); }
    .ira-bad { color: var(--bad, #dc2626); }
    .ira-section { margin-bottom: 1.5rem; }
    .ira-section h2 { font-size: 1rem; margin: 0 0 .5rem; }
    .in-num { text-align: right; }
    .ira-folio { font-family: var(--font-mono, monospace); }
    .ira-empty { color: var(--text-muted, #78716c); font-size: .9rem; }
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

  iraSeverity(pct: number | null): 'success' | 'warn' | 'danger' | 'secondary' {
    if (pct === null) return 'secondary';
    if (pct >= 97) return 'success';
    if (pct >= 90) return 'warn';
    return 'danger';
  }
}
