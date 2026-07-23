import { ChangeDetectionStrategy, Component, EventEmitter, Output, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { BankMovement } from '../../bank.service';
import { GROUP_ORDER, groupLabel, groupColorVar, dmy } from './bancos-shared';

/**
 * CB.14 — Vista MOVIMIENTOS (tabla filtrable read-only). El shell posee los filtros
 * que disparan recarga del backend (para respetar el cambio de periodo); el hijo los
 * refleja y emite `filter`/`searchChange`. "Color por grupo" es estado local (view).
 */
@Component({
  selector: 'bancos-movimientos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, CheckboxModule, InputTextModule, IconFieldModule, InputIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-filters">
      <p-select [options]="accountOpts()" optionLabel="label" optionValue="value" [filter]="true"
                [ngModel]="fAccount()" (ngModelChange)="filter.emit({ field: 'account', value: $event })"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Cuenta"></p-select>
      <p-select [options]="groupOpts()" optionLabel="label" optionValue="value"
                [ngModel]="fGroup()" (ngModelChange)="filter.emit({ field: 'group', value: $event })"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Grupo"></p-select>
      <p-select [options]="reconOpts()" optionLabel="label" optionValue="value"
                [ngModel]="fRecon()" (ngModelChange)="filter.emit({ field: 'recon', value: $event })"
                appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Estado de conciliación"></p-select>
      <span class="fb-check">
        <p-checkbox [ngModel]="fUncat()" [binary]="true" inputId="fUncat" (onChange)="filter.emit({ field: 'uncat', value: $event.checked })"></p-checkbox>
        <label for="fUncat">Solo sin clasificar</label>
      </span>
      <span class="fb-check">
        <p-checkbox [ngModel]="colorByGroup()" [binary]="true" inputId="fColor" (onChange)="colorByGroup.set($event.checked)"></p-checkbox>
        <label for="fColor">Color por grupo</label>
      </span>
      <p-iconfield iconPosition="left" class="fb-search">
        <p-inputicon styleClass="pi pi-search" />
        <input pInputText type="text" [ngModel]="fSearch()" (ngModelChange)="searchChange.emit($event)"
               placeholder="Buscar concepto / código…" aria-label="Buscar" />
      </p-iconfield>
      <span class="fb-count muted">
        @if (movTotal() > movements().length) { Mostrando {{ movements().length | number }} de {{ movTotal() | number }} }
        @else { {{ movTotal() | number }} movimientos }
      </span>
    </div>
    @if (colorByGroup()) {
      <div class="fb-legend" aria-label="Colores por grupo — clic para filtrar">
        @for (g of GROUP_ORDER; track g) {
          <button type="button" class="fb-legend-item" [class.active]="fGroup() === g" [style.--g]="color(g)"
                  (click)="filter.emit({ field: 'group', value: fGroup() === g ? '' : g })" [attr.aria-pressed]="fGroup() === g">
            <span class="fb-legend-dot"></span>{{ label(g) }}
          </button>
        }
      </div>
    }
    <div class="card-premium card-flat fb-tablewrap">
      <p-table [value]="movements()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh"
               [paginator]="movements().length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]">
        <ng-template pTemplate="header">
          <tr>
            <th class="col-w6" pSortableColumn="movement_date">Fecha <p-sortIcon field="movement_date" /></th>
            <th class="col-w7">Cuenta</th>
            <th>Concepto</th>
            <th class="col-w11">Categoría</th>
            <th class="ta-r col-w8" pSortableColumn="amount_in">Depósito <p-sortIcon field="amount_in" /></th>
            <th class="ta-r col-w8" pSortableColumn="amount_out">Retiro <p-sortIcon field="amount_out" /></th>
            <th class="col-w25" title="Conciliación"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-m>
          <tr class="fb-mov-row" [class.fb-colored]="colorByGroup()"
              [style.--g]="colorByGroup() ? color(m.group_key) : null"
              [class.fb-uncat]="!m.category_id && !colorByGroup()">
            <td class="mono">{{ dm(m.movement_date) }}</td>
            <td class="muted">{{ m.account_label }}</td>
            <td class="fb-concept" [title]="m.concept">{{ m.concept || '—' }}</td>
            <td>
              @if (m.category_name) { <span class="fb-cat-chip">{{ m.category_name }}</span> }
              @else { <span class="fb-cat-chip fb-cat-none">sin clasificar</span> }
            </td>
            <td class="ta-r mono">{{ m.amount_in ? (m.amount_in | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
            <td class="ta-r mono">{{ m.amount_out ? (m.amount_out | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
            <td class="ta-c">
              @if (m.recon_status === 'matched') { <i class="pi pi-check-circle fb-rec-ok" title="Conciliado con Kepler"></i> }
              @else if (m.recon_status === 'unmatched') { <i class="pi pi-circle fb-rec-no" title="Sin conciliar"></i> }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos con estos filtros.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .muted { color: var(--text-muted); }
    .col-w6 { width: 6rem; } .col-w7 { width: 7rem; } .col-w8 { width: 8rem; } .col-w11 { width: 11rem; } .col-w25 { width: 2.5rem; }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .fb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .fb-search { min-width: 16rem; flex: 1; }
    .fb-check { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-count { margin-left: auto; font-size: var(--fs-xs); }
    .fb-concept { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-cat-chip { display: inline-block; font-size: var(--fs-xs); color: var(--text-muted); }
    .fb-cat-chip.fb-cat-none { color: var(--warn-fg); }
    .fb-uncat { background: color-mix(in srgb, var(--warn-fg) 5%, transparent); }
    .fb-colored > td { background: color-mix(in srgb, var(--g, transparent) 8%, transparent); }
    .fb-colored > td:first-child { box-shadow: inset 3px 0 0 var(--g, transparent); }
    .fb-legend { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); margin-bottom: var(--sp-2); }
    .fb-legend-item { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-xs);
      color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: var(--r-pill);
      padding: 2px var(--sp-2); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
    .fb-legend-item:hover { background: var(--hover-bg); }
    .fb-legend-item.active { border-color: var(--g); color: var(--text-main); background: color-mix(in srgb, var(--g) 8%, transparent); }
    .fb-legend-item:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .fb-legend-dot { width: 10px; height: 10px; border-radius: 3px; background: var(--g, var(--text-faint)); flex: none; }
    .fb-rec-ok { color: var(--ok-fg); font-size: 0.85rem; }
    .fb-rec-no { color: var(--text-faint); font-size: 0.7rem; }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosMovimientosComponent {
  readonly movements = input.required<BankMovement[]>();
  readonly movTotal = input.required<number>();
  readonly accountOpts = input.required<{ label: string; value: string }[]>();
  readonly groupOpts = input.required<{ label: string; value: string }[]>();
  readonly reconOpts = input.required<{ label: string; value: string }[]>();
  readonly fAccount = input<string>('');
  readonly fGroup = input<string>('');
  readonly fRecon = input<string>('');
  readonly fUncat = input<boolean>(false);
  readonly fSearch = input<string>('');
  @Output() filter = new EventEmitter<{ field: string; value: any }>();
  @Output() searchChange = new EventEmitter<string>();

  readonly GROUP_ORDER = GROUP_ORDER;
  readonly colorByGroup = signal(true);
  label(g: string): string { return groupLabel(g); }
  color(g?: string | null): string { return groupColorVar(g); }
  dm(v: any): string { return dmy(v); }
}
