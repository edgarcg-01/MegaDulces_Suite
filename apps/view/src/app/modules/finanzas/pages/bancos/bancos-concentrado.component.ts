import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { Concentrado } from '../../bank.service';
import { GROUP_ORDER, groupLabel, groupColorVar } from './bancos-shared';

/**
 * CB.14 — Vista CONCENTRADO (pivote cuenta × grupo). Presentacional: recibe el
 * concentrado y las opciones de cuenta del shell; el filtro por cuenta es estado
 * local de la vista. Sin lógica de carga (esa vive en el shell).
 */
@Component({
  selector: 'bancos-concentrado',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, TableModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del periodo" />
    <div class="fb-filters">
      <p-select [options]="accountOpts()" optionLabel="label" optionValue="value" [filter]="true"
                [ngModel]="fAccount()" (ngModelChange)="fAccount.set($event)"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Cuenta"></p-select>
      <span class="fb-count muted">{{ rows().length }} cuenta(s)</span>
    </div>
    <div class="card-premium card-flat fb-tablewrap">
      <p-table [value]="rows()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
        <ng-template pTemplate="header">
          <tr>
            <th class="fb-sticky-col">Cuenta</th>
            @for (g of groupCols(); track g) { <th class="ta-r"><span class="fb-ghead"><span class="fb-legend-dot" [style.--g]="color(g)"></span>{{ label(g) }}</span></th> }
            <th class="ta-r">Depósitos</th>
            <th class="ta-r">Retiros</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-a>
          <tr>
            <td class="fb-sticky-col"><span class="fb-acct">{{ a.bank }} <span class="muted">{{ a.account_label }}</span></span></td>
            @for (g of groupCols(); track g) { <td class="ta-r mono">{{ cellAmount(a, g) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
            <td class="ta-r mono fb-strong">{{ a.deposits | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            <td class="ta-r mono fb-strong">{{ a.withdrawals | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="footer">
          <tr class="fb-total-row">
            <td class="fb-sticky-col">Total</td>
            @for (g of groupCols(); track g) { <td class="ta-r mono">{{ groupTotal(g) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
            <td class="ta-r mono fb-strong">{{ c().grand.deposits | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            <td class="ta-r mono fb-strong">{{ c().grand.withdrawals | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          </tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .fb-count { margin-left: auto; font-size: var(--fs-xs); }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .muted { color: var(--text-muted); }
    .fb-strong { font-weight: 600; color: var(--text-main); }
    .fb-acct { font-weight: 500; }
    .fb-sticky-col { position: sticky; left: 0; background: var(--card-bg); z-index: 1; }
    .fb-total-row { font-weight: 600; border-top: 2px solid var(--border-color); background: var(--surface-ground); }
    .fb-ghead { display: inline-flex; align-items: center; gap: 4px; }
    .fb-legend-dot { width: 10px; height: 10px; border-radius: 3px; background: var(--g, var(--text-faint)); flex: none; }
  `],
})
export class BancosConcentradoComponent {
  readonly concentrado = input.required<Concentrado>();
  readonly accountOpts = input.required<{ label: string; value: string }[]>();
  readonly fAccount = signal('');

  readonly c = computed(() => this.concentrado());
  readonly rows = computed(() => {
    const c = this.concentrado(); const f = this.fAccount();
    return f ? c.accounts.filter((a) => a.account_id === f) : c.accounts;
  });
  readonly groupCols = computed(() => {
    const present = new Set(Object.keys(this.concentrado().groupTotals));
    return GROUP_ORDER.filter((g) => present.has(g));
  });
  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const c = this.concentrado();
    const neto = c.grand.deposits - c.grand.withdrawals;
    const sinClas = c.groupTotals['sin_clasificar'];
    return [
      { label: 'Depósitos', value: c.grand.deposits, format: 'currency' },
      { label: 'Retiros', value: c.grand.withdrawals, format: 'currency' },
      { label: 'Neto', value: neto, format: 'currency', tone: neto >= 0 ? 'ok' : 'bad' },
      { label: 'Sin clasificar', value: sinClas ? sinClas.movs : 0, format: 'number', tone: (sinClas?.movs || 0) > 0 ? 'warn' : 'ok' },
    ];
  });

  label(g: string): string { return groupLabel(g); }
  color(g: string): string { return groupColorVar(g); }
  cellAmount(a: any, group: string): number {
    const g = a.groups?.[group];
    if (!g) return 0;
    return group === 'ingreso' || group === 'devolucion' ? g.deposits : g.withdrawals;
  }
  groupTotal(group: string): number {
    const g = this.concentrado().groupTotals?.[group];
    if (!g) return 0;
    return group === 'ingreso' || group === 'devolucion' ? g.deposits : g.withdrawals;
  }
}
