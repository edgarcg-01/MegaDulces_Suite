import { ChangeDetectionStrategy, Component, EventEmitter, Output, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { BankAccount, KeplerAccount } from '../../bank.service';
import { BankAdminTab } from './bancos-shared';

/**
 * CB.14 — Vista ADMIN (read-only catálogo Kepler + setup de cuentas de banco).
 * Presentacional: recibe catálogo/cuentas; el tab activo y el alta de cuenta son
 * estado local; emite search / patchAccount / addAccount para que el shell ejecute.
 */
@Component({
  selector: 'bancos-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, CheckboxModule, InputTextModule, IconFieldModule, InputIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-adminseg" role="tablist">
      <button role="tab" [class.active]="tab()==='catalogo'" (click)="tab.set('catalogo')">Catálogo Kepler</button>
      <button role="tab" [class.active]="tab()==='cuentas'" (click)="tab.set('cuentas')">Cuentas de banco</button>
    </div>

    @if (tab() === 'catalogo') {
      <div class="fb-admin-bar">
        <p class="fb-admin-note muted">Catálogo REAL de cuentas de Kepler (almacén 00). Úsalo para saber qué mayor/subcuenta es cada cosa — NO adivines. Busca por clave (611) o descripción (comisión).</p>
        <p-iconfield iconPosition="left" class="fb-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" [ngModel]="kaSearch()" (ngModelChange)="search.emit($event)"
                 placeholder="Buscar cuenta: clave o descripción…" aria-label="Buscar cuenta Kepler" />
        </p-iconfield>
      </div>
      <div class="card-premium card-flat fb-tablewrap">
        <p-table [value]="keplerAccounts()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
          <ng-template pTemplate="header">
            <tr><th class="col-w8">Clave</th><th>Descripción</th><th class="col-w6">Mayor</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-a>
            <tr><td class="mono" [class.ok]="a.es_mayor">{{ a.cuenta }}</td><td>{{ a.cuenta_nombre || '—' }}</td><td class="mono muted">{{ a.cuenta_mayor }}</td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="3"><div class="surf-empty"><i class="pi pi-search"></i><p>{{ kaSearch() ? 'Sin resultados.' : 'Escribe para buscar en el catálogo.' }}</p></div></td></tr>
          </ng-template>
        </p-table>
      </div>
    }

    @if (tab() === 'cuentas') {
      <div class="fb-admin-bar">
        <p class="fb-admin-note muted">Cuentas del catálogo (banco/caja/factoraje). Alias = nombre de la hoja en el Excel. Necesario para importar y cuadrar.</p>
      </div>
      <div class="card-premium card-flat fb-tablewrap">
        <p-table [value]="accounts()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
          <ng-template pTemplate="header">
            <tr><th class="col-w8">Banco</th><th class="col-w6">Cuenta</th><th class="col-w10">Alias (hoja Excel)</th><th class="col-w7">Tipo</th><th>Vínculo Kepler</th><th class="col-w4 ta-c">Activa</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-a>
            <tr [class.fb-inactive]="!a.active">
              <td>{{ a.bank }}</td>
              <td class="mono">{{ a.account_label }}</td>
              <td><input pInputText class="fb-pin mono" [ngModel]="a.alias" (change)="patchAccount.emit({ a, patch: { alias: $any($event.target).value } })" placeholder="—" /></td>
              <td><p-select [options]="kindOpts" optionLabel="label" optionValue="value" [ngModel]="a.kind" (ngModelChange)="patchAccount.emit({ a, patch: { kind: $event } })" appendTo="body" styleClass="fb-sel sel-liquid" /></td>
              <td><input pInputText class="fb-pin" [ngModel]="a.kepler_link" (change)="patchAccount.emit({ a, patch: { kepler_link: $any($event.target).value } })" placeholder="cómo mapea al 102" /></td>
              <td class="ta-c"><p-checkbox [ngModel]="a.active" [binary]="true" (onChange)="patchAccount.emit({ a, patch: { active: $event.checked } })" /></td>
            </tr>
          </ng-template>
          <ng-template pTemplate="footer">
            <tr class="fb-newrow">
              <td><input pInputText class="fb-pin" [(ngModel)]="naBank" placeholder="BANCO" /></td>
              <td><input pInputText class="fb-pin mono" [(ngModel)]="naLabel" placeholder="0000" /></td>
              <td><input pInputText class="fb-pin mono" [(ngModel)]="naAlias" placeholder="hoja Excel" /></td>
              <td><p-select [options]="kindOpts" optionLabel="label" optionValue="value" [(ngModel)]="naKind" appendTo="body" styleClass="fb-sel sel-liquid" /></td>
              <td><input pInputText class="fb-pin" [(ngModel)]="naKepler" placeholder="opcional" /></td>
              <td class="ta-c"><button pButton type="button" icon="pi pi-plus" class="p-button-sm p-button-text" [disabled]="addingAcct()" (click)="emitAdd()"></button></td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .muted { color: var(--text-muted); } .ok { color: var(--ok-fg); }
    .ta-c { text-align: center; }
    .col-w4 { width: 4rem; } .col-w6 { width: 6rem; } .col-w7 { width: 7rem; } .col-w8 { width: 8rem; } .col-w10 { width: 10rem; }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .fb-search { min-width: 16rem; }
    .fb-adminseg { display: flex; gap: var(--sp-1); margin-bottom: var(--sp-3); }
    .fb-adminseg button { background: none; border: 1px solid var(--border-color); color: var(--text-muted); font: inherit; font-size: var(--fs-xs); font-weight: 500; padding: var(--sp-1) var(--sp-3); border-radius: var(--r-sm); cursor: pointer; }
    .fb-adminseg button.active { color: var(--action); border-color: var(--action); background: color-mix(in srgb, var(--action) 8%, transparent); }
    .fb-admin-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); flex-wrap: wrap; }
    .fb-admin-note { font-size: var(--fs-xs); max-width: 48rem; margin: 0; }
    .fb-newrow { background: var(--surface-ground); }
    .fb-inactive { opacity: 0.5; }
    :host ::ng-deep .fb-pin.p-inputtext { width: 100%; font-size: var(--fs-xs); padding: 2px var(--sp-2); }
    :host ::ng-deep .fb-sel.p-select { font-size: var(--fs-sm); }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosAdminComponent {
  readonly keplerAccounts = input.required<KeplerAccount[]>();
  readonly accounts = input.required<BankAccount[]>();
  readonly kaSearch = input<string>('');
  readonly addingAcct = input<boolean>(false);
  @Output() search = new EventEmitter<string>();
  @Output() patchAccount = new EventEmitter<{ a: BankAccount; patch: Partial<BankAccount> }>();
  @Output() addAccount = new EventEmitter<{ bank: string; account_label: string; alias: string; kind: string; kepler_link: string }>();

  readonly tab = signal<BankAdminTab>('catalogo');
  readonly kindOpts = [
    { label: 'Banco', value: 'bank' }, { label: 'Caja', value: 'cash' }, { label: 'Factoraje', value: 'factoraje' },
  ];
  naBank = ''; naLabel = ''; naAlias = ''; naKind = 'bank'; naKepler = '';

  emitAdd(): void {
    this.addAccount.emit({ bank: this.naBank, account_label: this.naLabel, alias: this.naAlias, kind: this.naKind, kepler_link: this.naKepler });
    this.naBank = this.naLabel = this.naAlias = this.naKepler = '';
  }
}
