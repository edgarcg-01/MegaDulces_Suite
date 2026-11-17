import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { BankAccount, ContpaqiBankAccount, KeplerAccount } from '../../bank.service';
import { BankAdminTab } from './bancos-shared';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * CB.14 — Vista ADMIN (read-only catálogo Kepler + setup de cuentas de banco).
 * Presentacional: recibe catálogo/cuentas; el tab activo y el alta de cuenta son
 * estado local; emite search / patchAccount / addAccount para que el shell ejecute.
 */
@Component({
  selector: 'bancos-admin',
  standalone: true,
  imports: [FormsModule, ButtonModule, TableModule, SelectModule, CheckboxModule, InputTextModule, IconFieldModule, InputIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-adminseg" role="radiogroup">
      <button role="radio" [attr.aria-checked]="tab()==='catalogo'" [class.active]="tab()==='catalogo'" (click)="tab.set('catalogo')">Catálogo Kepler</button>
      <button role="radio" [attr.aria-checked]="tab()==='cuentas'" [class.active]="tab()==='cuentas'" (click)="tab.set('cuentas')">Cuentas de banco</button>
    </div>

    @if (tab() === 'catalogo') {
      <div class="fb-admin-bar">
        <p class="fb-admin-note muted">Catálogo REAL de cuentas de Kepler (almacén 00). Úsalo para saber qué mayor/subcuenta es cada cosa — NO adivines. Busca por clave (611) o descripción (comisión).</p>
        <p-iconfield iconPosition="left" class="fb-search">
          <p-inputicon class="pi pi-search" />
          <input pInputText type="text" [ngModel]="kaSearch()" (ngModelChange)="search.emit($event)"
                 placeholder="Buscar cuenta: clave o descripción…" aria-label="Buscar cuenta Kepler" />
        </p-iconfield>
      </div>
      <div class="card-premium card-flat fb-tablewrap">
        <p-table [value]="keplerAccounts()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
          <ng-template #header>
            <tr><th class="col-w8" pSortableColumn="cuenta">Clave <p-sorticon field="cuenta" /></th><th pSortableColumn="cuenta_nombre">Descripción <p-sorticon field="cuenta_nombre" /></th><th class="col-w6" pSortableColumn="cuenta_mayor">Mayor <p-sorticon field="cuenta_mayor" /></th></tr>
          </ng-template>
          <ng-template #body let-a>
            <tr><td class="mono" [class.ok]="a.es_mayor">{{ a.cuenta }}</td><td>{{ a.cuenta_nombre || '—' }}</td><td class="mono muted">{{ a.cuenta_mayor }}</td></tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="3"><div class="surf-empty"><i class="pi pi-search"></i><p>{{ kaSearch() ? 'Sin resultados.' : 'Escribe para buscar en el catálogo.' }}</p></div></td></tr>
          </ng-template>
        </p-table>
      </div>
    }

    @if (tab() === 'cuentas') {
      <div class="fb-admin-bar">
        <p class="fb-admin-note muted">Cuentas del catálogo (banco/caja/factoraje). Alias = nombre de la hoja en el Excel. Necesario para importar y cuadrar. <b>Libro ContPAQi</b> = la cuenta contable 102xxx contra la que el Cuadre 3 vías compara cada banco.@if (soloLectura()) { Sólo lectura: editarlas pide el permiso de gestionar Bancos. }</p>
        @if (!soloLectura()) {
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="linking()" (click)="link.emit()"
                  title="Enlaza cada cuenta de banco con la cuenta 102xxx de ContPAQi que lleva su número (no quita un enlace que no encuentre)"><span class="p-button-icon p-button-icon-left pi pi-link" aria-hidden="true"></span><span class="p-button-label">Enlazar con ContPAQi</span></button>
        }
      </div>
      <div class="card-premium card-flat fb-tablewrap">
        <p-table [value]="accounts()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
          <ng-template #header>
            <tr><th class="col-w8" pSortableColumn="bank">Banco <p-sorticon field="bank" /></th><th class="col-w6" pSortableColumn="account_label">Cuenta <p-sorticon field="account_label" /></th><th class="col-w10" pSortableColumn="alias">Alias (hoja Excel) <p-sorticon field="alias" /></th><th class="col-w7" pSortableColumn="kind">Tipo <p-sorticon field="kind" /></th><th pSortableColumn="kepler_link">Vínculo Kepler <p-sorticon field="kepler_link" /></th><th pSortableColumn="contpaqi_cuenta">Libro ContPAQi <p-sorticon field="contpaqi_cuenta" /></th><th class="col-w4 ta-c" pSortableColumn="active">Activa <p-sorticon field="active" /></th></tr>
          </ng-template>
          <ng-template #body let-a>
            <tr [class.fb-inactive]="!a.active">
              <td>{{ a.bank }}</td>
              <td class="mono">{{ a.account_label }}</td>
              <td><input pInputText class="fb-pin mono" [ngModel]="a.alias" [disabled]="soloLectura()" (change)="patchAccount.emit({ a, patch: { alias: $any($event.target).value } })" placeholder="—" /></td>
              <td><p-select [options]="kindOpts" optionLabel="label" optionValue="value" [ngModel]="a.kind" [disabled]="soloLectura()" (ngModelChange)="patchAccount.emit({ a, patch: { kind: $event } })" appendTo="body" styleClass="fb-sel sel-liquid" /></td>
              <td><input pInputText class="fb-pin" [ngModel]="a.kepler_link" [disabled]="soloLectura()" (change)="patchAccount.emit({ a, patch: { kepler_link: $any($event.target).value } })" placeholder="cómo mapea al 102" /></td>
              <td>
                @if (a.kind !== 'bank') { <span class="muted">no aplica</span> }
                @else if (soloLectura() || !cpqAccounts().length) {
                  @if (a.contpaqi_cuenta) { <span class="mono">{{ a.contpaqi_cuenta }}</span> <span class="muted">{{ a.contpaqi_cuenta_nombre }}</span> }
                  @else { <span class="fb-tag-warn">sin enlazar</span> }
                } @else {
                  <p-select [options]="cpqOpts(a)" optionLabel="label" optionValue="value" [ngModel]="a.contpaqi_cuenta ?? null"
                            (ngModelChange)="manualLink.emit({ bankAccountId: a.id, cuenta: $event ?? null })"
                            placeholder="sin enlazar" [showClear]="true" [filter]="true" filterBy="label" appendTo="body"
                            styleClass="fb-sel sel-liquid" [style]="{ minWidth: '14rem' }" scrollHeight="16rem"
                            [ariaLabel]="'Libro ContPAQi de ' + a.bank + ' ' + a.account_label" />
                }
              </td>
              <td class="ta-c"><p-checkbox [ngModel]="a.active" [binary]="true" [disabled]="soloLectura()" (onChange)="patchAccount.emit({ a, patch: { active: $event.checked } })" /></td>
            </tr>
          </ng-template>
          <!-- [CB.77] Quien sólo ve no recibe un formulario que el servidor le va a rechazar (403). -->
          <ng-template #footer>
            @if (!soloLectura()) {
            <tr class="fb-newrow">
              <td><input pInputText class="fb-pin" [(ngModel)]="naBank" placeholder="BANCO" /></td>
              <td><input pInputText class="fb-pin mono" [(ngModel)]="naLabel" placeholder="0000" /></td>
              <td><input pInputText class="fb-pin mono" [(ngModel)]="naAlias" placeholder="hoja Excel" /></td>
              <td><p-select [options]="kindOpts" optionLabel="label" optionValue="value" [(ngModel)]="naKind" appendTo="body" styleClass="fb-sel sel-liquid" /></td>
              <td><input pInputText class="fb-pin" [(ngModel)]="naKepler" placeholder="opcional" /></td>
              <td class="muted">se enlaza después de crearla</td>
              <td class="ta-c"><button pButton type="button" class="p-button-sm p-button-text" [disabled]="addingAcct()" (click)="emitAdd()" aria-label="Agregar cuenta"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span></button></td>
            </tr>
            }
          </ng-template>
        </p-table>
      </div>
    }
  `,
  styles: [BANCOS_STYLES, `
    .fb-adminseg { display: flex; gap: var(--sp-1); margin-bottom: var(--sp-3); }
    .fb-adminseg button { background: none; border: 1px solid var(--border-color); color: var(--text-muted); font: inherit; font-size: var(--fs-xs); font-weight: 500; padding: var(--sp-1) var(--sp-3); border-radius: var(--r-sm); cursor: pointer; }
    .fb-adminseg button.active { color: var(--action); border-color: var(--action); background: color-mix(in srgb, var(--action) 8%, transparent); }
    .fb-admin-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); flex-wrap: wrap; }
    .fb-admin-note { font-size: var(--fs-xs); max-width: 48rem; margin: 0; }
    .fb-newrow { background: var(--surface-ground); }
    .fb-inactive { opacity: 0.5; }
    .fb-tag-warn { font-size: var(--fs-xs); color: var(--warn-fg); }
    :host ::ng-deep .fb-pin.p-inputtext { width: 100%; font-size: var(--fs-xs); padding: 2px var(--sp-2); }
    :host ::ng-deep .fb-sel.p-select { font-size: var(--fs-sm); }
  `],
})
export class BancosAdminComponent {
  readonly keplerAccounts = input.required<KeplerAccount[]>();
  readonly accounts = input.required<BankAccount[]>();
  readonly kaSearch = input<string>('');
  readonly addingAcct = input<boolean>(false);
  /** [CB.77] Sin FINANCE_BANK_GESTIONAR: se ve, no se edita (antes el cambio se pintaba y el servidor lo rechazaba). */
  readonly soloLectura = input<boolean>(false);
  /** [CB.78] Cuentas 102xxx de ContPAQi para enlazar (las pide quien gestiona: el endpoint exige GESTIONAR). */
  readonly cpqAccounts = input<ContpaqiBankAccount[]>([]);
  readonly linking = input<boolean>(false);
  @Output() link = new EventEmitter<void>();
  @Output() manualLink = new EventEmitter<{ bankAccountId: string; cuenta: string | null }>();

  /** Lo libre más la que ya tiene esta cuenta (si no, el selector la mostraría vacía). Más movimientos primero. */
  private readonly cpqLibres = computed(() => this.cpqAccounts().slice().sort((x, y) => y.movs - x.movs));
  cpqOpts(a: BankAccount): { label: string; value: string }[] {
    return this.cpqLibres()
      .filter((c) => !c.taken || c.cuenta === a.contpaqi_cuenta)
      .map((c) => ({ label: `${c.cuenta} · ${c.cuenta_nombre} · ${c.movs} movs`, value: c.cuenta }));
  }
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
