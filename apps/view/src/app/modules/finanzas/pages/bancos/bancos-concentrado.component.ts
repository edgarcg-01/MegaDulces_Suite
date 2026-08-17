import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { Concentrado, ConcentradoAccount, Balances } from '../../bank.service';
import { CajaIngresoRefComponent } from './caja-ingreso-ref.component';
import { GROUP_ORDER, groupLabel, groupColorVar, money } from './bancos-shared';
import { exportXlsx } from './bancos-export';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * CB.14 — Vista CONCENTRADO (pivote cuenta × grupo). Presentacional: recibe el
 * concentrado y las opciones de cuenta del shell; el filtro por cuenta es estado
 * local de la vista. Sin lógica de carga (esa vive en el shell).
 */
@Component({
  selector: 'bancos-concentrado',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, TableModule, MetricStripComponent, CajaIngresoRefComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del periodo" />
    <caja-ingreso-ref [period]="period()" />
    <div class="fb-filters">
      <p-select [options]="accountOpts()" optionLabel="label" optionValue="value" [filter]="true"
                [ngModel]="fAccount()" (ngModelChange)="fAccount.set($event)"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Cuenta"></p-select>
      <span class="fb-count muted">{{ rows().length }} cuenta(s)</span>
    </div>
    <div class="card-premium card-flat fb-tablewrap">
      <h3 class="fb-card-title fb-pnl-title">Concentrado <span class="muted">— cuenta x grupo</span><button type="button" class="fb-xls" [disabled]="exporting()" (click)="exportXls()" title="Descarga el concentrado tal como se ve"><i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel</button></h3>
      <p-table [value]="rows()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
               [customSort]="true" (sortFunction)="onSort($event)">
        <ng-template #header>
          <tr>
            <th class="fb-sticky-col" pSortableColumn="bank">Cuenta <p-sorticon field="bank" /></th>
            @for (g of groupCols(); track g) { <th class="ta-r" [pSortableColumn]="'g:' + g"><span class="fb-ghead"><span class="fb-legend-dot" [style.--g]="color(g)"></span>{{ label(g) }}</span> <p-sorticon [field]="'g:' + g" /></th> }
            <th class="ta-r" pSortableColumn="deposits">Depósitos <p-sorticon field="deposits" /></th>
            <th class="ta-r" pSortableColumn="withdrawals">Retiros <p-sorticon field="withdrawals" /></th>
            <th class="ta-c col-cuadre" pSortableColumn="cuadre" title="¿El saldo de esta cuenta cierra? (inicial + depósitos − retiros = final)">Cuadre <p-sorticon field="cuadre" /></th>
          </tr>
        </ng-template>
        <ng-template #body let-a>
          <tr [class.fb-nocuadra]="cuadreOf(a).state === 'bad'">
            <td class="fb-sticky-col"><span class="fb-acct">{{ a.bank }} <span class="muted">{{ a.account_label }}</span></span></td>
            @for (g of groupCols(); track g) { <td class="ta-r mono">{{ cellAmount(a, g) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td> }
            <td class="ta-r mono fb-strong">{{ a.deposits | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="ta-r mono fb-strong">{{ a.withdrawals | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="ta-c">
              @switch (cuadreOf(a).state) {
                @case ('ok') { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                @case ('bad') { <i class="pi pi-exclamation-triangle bad" [title]="'No cuadra · Δ ' + cuadreOf(a).deltaFmt"></i> }
                @default { <span class="muted" title="Sin saldo en el Excel para verificar">—</span> }
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #footer>
          <tr class="fb-total-row">
            <td class="fb-sticky-col">Total</td>
            @for (g of groupCols(); track g) { <td class="ta-r mono">{{ groupTotal(g) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td> }
            <td class="ta-r mono fb-strong">{{ c().grand.deposits | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="ta-r mono fb-strong">{{ c().grand.withdrawals | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="ta-c">@if (noCuadraCount() > 0) { <span class="fb-bad-badge" [title]="noCuadraCount() + ' cuenta(s) sin cuadrar'">{{ noCuadraCount() }}</span> }</td>
          </tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [BANCOS_STYLES, `
    /* Boton de export: ghost, discreto -- accion secundaria. */
    .fb-xls { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); color: var(--text-muted); font: inherit; font-size: var(--fs-xs);
      padding: 2px var(--sp-2); cursor: pointer; margin-left: var(--sp-2); vertical-align: middle; }
    .fb-xls:hover:not(:disabled) { color: var(--text-main); background: var(--hover-bg); }
    .fb-xls:disabled { opacity: .6; cursor: default; }
    .fb-xls:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }

    .fb-acct { font-weight: 500; }
    .fb-sticky-col { position: sticky; left: 0; background: var(--card-bg); z-index: 1; }
    .fb-total-row { font-weight: 600; border-top: 2px solid var(--border-color); background: var(--surface-ground); }
    .fb-ghead { display: inline-flex; align-items: center; gap: 4px; }
    .col-cuadre { width: 5rem; }
    /* Fila cuya cuenta no cuadra: borde-tinte sutil (quiet-luxury, no fill saturado). */
    .fb-nocuadra > td:first-child { box-shadow: inset 3px 0 0 var(--bad-fg); }
    .fb-bad-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 1.2rem; height: 1.2rem;
      font-size: var(--fs-micro); font-weight: 700; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--bad-fg) 15%, transparent); color: var(--bad-fg); }
  `],
})
export class BancosConcentradoComponent {
  readonly concentrado = input.required<Concentrado>();
  readonly balances = input.required<Balances | null>();
  readonly accountOpts = input.required<{ label: string; value: string }[]>();
  readonly period = input<string>('');
  readonly fAccount = signal('');

  /** Mapa bank|account_label → cuadre (del cuadre de saldos verificado). */
  readonly balMap = computed(() => {
    const m = new Map<string, { cuadra: boolean; sin_saldo: boolean; delta: number }>();
    for (const b of this.balances()?.accounts ?? []) {
      m.set(`${b.bank}|${b.account_label}`, { cuadra: b.cuadra, sin_saldo: b.sin_saldo, delta: b.delta });
    }
    return m;
  });
  cuadreOf(a: { bank: string; account_label: string }): { state: 'ok' | 'bad' | 'na'; deltaFmt: string } {
    const b = this.balMap().get(`${a.bank}|${a.account_label}`);
    if (!b || b.sin_saldo) return { state: 'na', deltaFmt: '' };
    return { state: b.cuadra ? 'ok' : 'bad', deltaFmt: money(b.delta) };
  }
  readonly noCuadraCount = computed(() =>
    this.rows().filter((a) => this.cuadreOf(a).state === 'bad').length);

  readonly c = computed(() => this.concentrado());

  /**
   * Orden del pivote. Va por `customSort` y no por el de PrimeNG porque dos de las
   * columnas no son campos de la fila: las de GRUPO son dinámicas (field `g:<grupo>`,
   * el valor sale de `cellAmount`) y "Cuadre" es un estado derivado del cuadre de
   * saldos, no un dato del renglón. `rows()` sigue siendo computed: acá sólo se
   * guarda qué columna y en qué sentido, nunca se muta el arreglo de entrada.
   */

  readonly exporting = signal(false);
  /** El pivote se exporta con las MISMAS columnas de grupo que se ven, en el mismo orden. */
  async exportXls(): Promise<void> {
    this.exporting.set(true);
    try {
      const groups = this.groupCols();
      const cols: any[] = [
        { header: 'Banco', get: (r: any) => r.bank, width: 20 },
        { header: 'Cuenta', get: (r: any) => r.account_label, width: 16 },
      ];
      for (const g of groups) cols.push({ header: this.label(g), get: (r: any) => this.cellAmount(r, g), type: 'money' });
      cols.push({ header: 'Depositos', get: (r: any) => r.deposits, type: 'money', total: true });
      cols.push({ header: 'Retiros', get: (r: any) => r.withdrawals, type: 'money', total: true });
      cols.push({ header: 'Cuadre', get: (r: any) => { const st = this.cuadreOf(r).state; return st === 'ok' ? 'Cuadra' : st === 'bad' ? 'No cuadra' : 'Sin saldo'; }, width: 12 });
      await exportXlsx('Concentrado ' + this.period(), [{
        name: 'Concentrado', subtitle: this.period() + ' - ' + this.rows().length + ' cuentas', rows: this.rows(), cols,
      }]);
    } finally { this.exporting.set(false); }
  }

  readonly sortState = signal<{ field: string; order: number } | null>(null);
  onSort(e: { field?: string; order?: number }): void {
    this.sortState.set(e?.field ? { field: e.field, order: e.order ?? 1 } : null);
  }
  /** Valor comparable de una celda: grupo dinámico, estado de cuadre, o campo directo. */
  private sortValue(a: ConcentradoAccount, field: string): number | string {
    if (field.startsWith('g:')) return this.cellAmount(a, field.slice(2));
    if (field === 'cuadre') { const st = this.cuadreOf(a).state; return st === 'bad' ? 2 : st === 'ok' ? 1 : 0; }
    if (field === 'bank') return `${a.bank} ${a.account_label}`;
    return (a as unknown as Record<string, number | string>)[field] ?? 0;
  }
  readonly rows = computed(() => {
    const c = this.concentrado(); const f = this.fAccount();
    const base = f ? c.accounts.filter((a) => a.account_id === f) : c.accounts;
    const st = this.sortState();
    if (!st) return base;
    return [...base].sort((x, y) => {
      const vx = this.sortValue(x, st.field), vy = this.sortValue(y, st.field);
      const cmp = typeof vx === 'number' && typeof vy === 'number'
        ? vx - vy
        : String(vx).localeCompare(String(vy), 'es-MX', { numeric: true });
      return cmp * st.order;
    });
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
