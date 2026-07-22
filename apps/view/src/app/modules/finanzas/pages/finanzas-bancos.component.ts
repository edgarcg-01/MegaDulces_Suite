import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { BankService, BankAccount, MovementCategory, BankStatement, BankMovement, Concentrado } from '../bank.service';

type View = 'concentrado' | 'movimientos' | 'cuentas';

/** Etiquetas + orden de los grupos del tablero CONCENTRADO. */
const GROUP_LABELS: Record<string, string> = {
  ingreso: 'Ingresos', compra: 'Compras', gasto: 'Gastos', factoraje: 'Factoraje',
  financiero: 'Financiero', traspaso: 'Traspasos', devolucion: 'Devoluciones', sin_clasificar: 'Sin clasificar',
};
const GROUP_ORDER = ['ingreso', 'compra', 'gasto', 'factoraje', 'financiero', 'traspaso', 'devolucion', 'sin_clasificar'];

/**
 * CB.3 — Conciliación bancaria (ADR-033). Reemplaza el workbook Excel: tablero
 * CONCENTRADO (pivote cuenta × grupo), grid de movimientos con reclasificación
 * inline, y lista de cuentas. Surface Operations (denso, quiet-luxury, dark-first).
 */
@Component({
  selector: 'app-finanzas-bancos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in fb-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head fb-head">
        <div class="surf-page-head-text">
          <h1>Bancos</h1>
          <p class="surf-page-sub">Conciliación bancaria: estados de cuenta clasificados contra el catálogo alineado a Kepler. Reemplaza el Excel manual.</p>
        </div>
        <div class="fb-head-actions">
          <label class="fb-period">
            <span>Periodo</span>
            <select [ngModel]="period()" (ngModelChange)="setPeriod($event)" aria-label="Periodo">
              @for (p of periods(); track p) { <option [value]="p">{{ p }}</option> }
            </select>
          </label>
        </div>
      </header>

      <div class="fb-viewseg" role="tablist">
        <button role="tab" [attr.aria-selected]="view()==='concentrado'" [class.active]="view()==='concentrado'" (click)="view.set('concentrado')"><i class="pi pi-table"></i> Concentrado</button>
        <button role="tab" [attr.aria-selected]="view()==='movimientos'" [class.active]="view()==='movimientos'" (click)="view.set('movimientos')"><i class="pi pi-list"></i> Movimientos</button>
        <button role="tab" [attr.aria-selected]="view()==='cuentas'" [class.active]="view()==='cuentas'" (click)="view.set('cuentas')"><i class="pi pi-wallet"></i> Cuentas</button>
      </div>

      @if (loading()) {
        <div class="fb-skeleton" aria-busy="true">
          @for (i of [1,2,3,4,5,6]; track i) { <div class="fb-skel-row"></div> }
        </div>
      } @else {

      <!-- ── CONCENTRADO ── -->
      @if (view() === 'concentrado') {
        @if (concentrado(); as c) {
          <app-metric-strip [items]="kpiItems(c)" ariaLabel="Resumen del periodo" />
          <div class="card-premium card-flat fb-tablewrap">
            <p-table [value]="c.accounts" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
              <ng-template pTemplate="header">
                <tr>
                  <th class="fb-sticky-col">Cuenta</th>
                  @for (g of groupCols(); track g) { <th class="ta-r">{{ label(g) }}</th> }
                  <th class="ta-r">Depósitos</th>
                  <th class="ta-r">Retiros</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-a>
                <tr>
                  <td class="fb-sticky-col"><span class="fb-acct">{{ a.bank }} <span class="muted">{{ a.account_label }}</span></span></td>
                  @for (g of groupCols(); track g) {
                    <td class="ta-r mono">{{ cellAmount(a, g) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  }
                  <td class="ta-r mono fb-strong">{{ a.deposits | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono fb-strong">{{ a.withdrawals | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="footer">
                <tr class="fb-total-row">
                  <td class="fb-sticky-col">Total</td>
                  @for (g of groupCols(); track g) { <td class="ta-r mono">{{ groupTotal(c, g) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                  <td class="ta-r mono fb-strong">{{ c.grand.deposits | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono fb-strong">{{ c.grand.withdrawals | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        } @else {
          <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin estados de cuenta para {{ period() }}.</p></div>
        }
      }

      <!-- ── MOVIMIENTOS ── -->
      @if (view() === 'movimientos') {
        <div class="fb-filters">
          <select [ngModel]="fAccount()" (ngModelChange)="fAccount.set($event); reloadMovements()" aria-label="Cuenta">
            <option value="">Todas las cuentas</option>
            @for (a of accounts(); track a.id) { <option [value]="a.id">{{ a.bank }} {{ a.account_label }}</option> }
          </select>
          <select [ngModel]="fGroup()" (ngModelChange)="fGroup.set($event); reloadMovements()" aria-label="Grupo">
            <option value="">Todos los grupos</option>
            @for (g of GROUP_ORDER; track g) { <option [value]="g">{{ label(g) }}</option> }
          </select>
          <label class="fb-check"><input type="checkbox" [ngModel]="fUncat()" (ngModelChange)="fUncat.set($event); reloadMovements()"> Solo sin clasificar</label>
          <input type="search" class="fb-search" [ngModel]="fSearch()" (ngModelChange)="onSearch($event)" placeholder="Buscar concepto / código…" aria-label="Buscar">
          <span class="fb-count muted">{{ movTotal() | number }} movimientos</span>
        </div>
        <div class="card-premium card-flat fb-tablewrap">
          <p-table [value]="movements()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh">
            <ng-template pTemplate="header">
              <tr>
                <th style="width:6rem">Fecha</th>
                <th style="width:7rem">Cuenta</th>
                <th>Concepto</th>
                <th style="width:11rem">Categoría</th>
                <th class="ta-r" style="width:8rem">Depósito</th>
                <th class="ta-r" style="width:8rem">Retiro</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-m>
              <tr [class.fb-uncat]="!m.category_id">
                <td class="mono">{{ m.movement_date }}</td>
                <td class="muted">{{ m.account_label }}</td>
                <td class="fb-concept" [title]="m.concept">{{ m.concept || '—' }}</td>
                <td>
                  <select class="fb-cat-select" [class.fb-cat-empty]="!m.category_id"
                          [ngModel]="m.category_id || ''" (ngModelChange)="reclassify(m, $event)" [attr.aria-label]="'Categoría de ' + (m.concept || 'movimiento')">
                    <option value="">— sin clasificar —</option>
                    @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
                  </select>
                </td>
                <td class="ta-r mono">{{ m.amount_in ? (m.amount_in | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                <td class="ta-r mono">{{ m.amount_out ? (m.amount_out | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="6"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos con estos filtros.</p></div></td></tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- ── CUENTAS ── -->
      @if (view() === 'cuentas') {
        <div class="card-premium card-flat fb-tablewrap">
          <p-table [value]="statements()" styleClass="p-datatable-sm" [rowHover]="true">
            <ng-template pTemplate="header">
              <tr><th>Banco</th><th>Cuenta</th><th>Tipo</th><th class="ta-r">Depósitos</th><th class="ta-r">Retiros</th><th class="ta-r">Saldo final</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-s>
              <tr>
                <td>{{ s.bank }}</td>
                <td class="mono">{{ s.account_label }}</td>
                <td><span class="fb-kind">{{ kindLabel(s.kind) }}</span></td>
                <td class="ta-r mono">{{ s.total_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono">{{ s.total_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono fb-strong">{{ s.closing_balance | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="6"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas cargadas para {{ period() }}.</p></div></td></tr>
            </ng-template>
          </p-table>
        </div>
      }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fb-head-actions { display: flex; align-items: center; gap: var(--sp-3); }
    .fb-period { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .fb-period select, .fb-filters select, .fb-search {
      font: inherit; font-size: var(--fs-sm); padding: var(--sp-1) var(--sp-2);
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-sm);
    }
    .fb-viewseg { display: flex; gap: var(--sp-1); margin: var(--sp-3) 0; border-bottom: 1px solid var(--border-color); }
    .fb-viewseg button {
      display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none;
      color: var(--text-muted); font: inherit; font-size: var(--fs-sm); font-weight: 500;
      padding: var(--sp-2) var(--sp-3); border-bottom: 2px solid transparent; cursor: pointer;
    }
    .fb-viewseg button.active { color: var(--action); border-bottom-color: var(--action); }
    .fb-viewseg button:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .fb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .fb-search { min-width: 16rem; flex: 1; }
    .fb-check { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-count { margin-left: auto; font-size: var(--fs-xs); }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .muted { color: var(--text-muted); }
    .fb-strong { font-weight: 600; color: var(--text-main); }
    .fb-acct { font-weight: 500; }
    .fb-sticky-col { position: sticky; left: 0; background: var(--card-bg); z-index: 1; }
    .fb-total-row { font-weight: 600; border-top: 2px solid var(--border-color); background: var(--surface-ground); }
    .fb-concept { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-cat-select {
      font: inherit; font-size: var(--fs-xs); width: 100%; padding: 2px var(--sp-1);
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid transparent; border-radius: var(--r-sm); cursor: pointer;
    }
    .fb-cat-select:hover, .fb-cat-select:focus { border-color: var(--border-color); }
    .fb-cat-empty { color: var(--warn-fg); border-color: var(--warn-border); }
    .fb-uncat { background: color-mix(in srgb, var(--warn-fg) 5%, transparent); }
    .fb-kind { font-size: var(--fs-xs); text-transform: capitalize; color: var(--text-muted); }
    .fb-skeleton { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
    .fb-skel-row { height: var(--row-h-md, 40px); border-radius: var(--r-sm); background: var(--hover-bg); animation: fb-pulse 1.4s ease-in-out infinite; }
    @keyframes fb-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .fb-skel-row { animation: none; } }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class FinanzasBancosComponent implements OnInit {
  private readonly api = inject(BankService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = FINANZAS_TABS;
  readonly GROUP_ORDER = GROUP_ORDER;

  readonly view = signal<View>('concentrado');
  readonly loading = signal(true);
  readonly periods = signal<string[]>([]);
  readonly period = signal<string>('');
  readonly accounts = signal<BankAccount[]>([]);
  readonly categories = signal<MovementCategory[]>([]);
  readonly statements = signal<BankStatement[]>([]);
  readonly concentrado = signal<Concentrado | null>(null);
  readonly movements = signal<BankMovement[]>([]);
  readonly movTotal = signal(0);

  readonly fAccount = signal('');
  readonly fGroup = signal('');
  readonly fUncat = signal(false);
  readonly fSearch = signal('');
  private searchTimer: any = null;

  /** Grupos con datos en el periodo (columnas del CONCENTRADO), en orden canónico. */
  readonly groupCols = computed(() => {
    const c = this.concentrado();
    if (!c) return [] as string[];
    const present = new Set(Object.keys(c.groupTotals));
    return GROUP_ORDER.filter((g) => present.has(g));
  });

  ngOnInit(): void {
    this.api.periods().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ps) => {
        this.periods.set(ps);
        this.period.set(ps[0] || '');
        this.api.categories().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((cs) => this.categories.set(cs));
        this.api.accounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((as) => this.accounts.set(as));
        if (this.period()) this.loadPeriod();
        else this.loading.set(false);
      },
      error: () => this.fail('No se pudieron cargar los periodos.'),
    });
  }

  setPeriod(p: string): void { this.period.set(p); this.loadPeriod(); }

  private loadPeriod(): void {
    this.loading.set(true);
    const p = this.period();
    this.api.concentrado(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => this.concentrado.set(c),
      error: () => this.fail('No se pudo cargar el concentrado.'),
    });
    this.api.statements(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => this.statements.set(s));
    this.reloadMovements();
  }

  reloadMovements(): void {
    const p = this.period();
    if (!p) { this.loading.set(false); return; }
    this.api.movements({
      period: p, account_id: this.fAccount() || undefined, group_key: this.fGroup() || undefined,
      uncategorized: this.fUncat() || undefined, search: this.fSearch() || undefined, limit: 500,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.movements.set(r.rows); this.movTotal.set(r.total); this.loading.set(false); },
      error: () => this.fail('No se pudieron cargar los movimientos.'),
    });
  }

  onSearch(v: string): void {
    this.fSearch.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reloadMovements(), 300);
  }

  /** Reclasifica optimista: refleja el cambio ya, revierte si el server falla. */
  reclassify(m: BankMovement, categoryId: string): void {
    const prev = m.category_id;
    const cat = this.categories().find((c) => c.id === categoryId) || null;
    this.movements.update((rows) => rows.map((r) => r.id === m.id
      ? { ...r, category_id: categoryId || null, category_code: cat?.code || null, category_name: cat?.name || null, group_key: cat?.group_key || null }
      : r));
    this.api.reclassify(m.id, categoryId || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.toast.add({ severity: 'success', summary: 'Reclasificado', life: 1500 }),
      error: () => {
        this.movements.update((rows) => rows.map((r) => r.id === m.id ? { ...r, category_id: prev } : r));
        this.fail('No se pudo reclasificar.');
      },
    });
  }

  kpiItems(c: Concentrado): MetricStripItem[] {
    const neto = c.grand.deposits - c.grand.withdrawals;
    const sinClas = c.groupTotals['sin_clasificar'];
    return [
      { label: 'Depósitos', value: c.grand.deposits, format: 'currency' },
      { label: 'Retiros', value: c.grand.withdrawals, format: 'currency' },
      { label: 'Neto', value: neto, format: 'currency', tone: neto >= 0 ? 'ok' : 'bad' },
      { label: 'Sin clasificar', value: sinClas ? sinClas.movs : 0, format: 'number', tone: (sinClas?.movs || 0) > 0 ? 'warn' : 'ok' },
    ];
  }

  cellAmount(a: any, group: string): number {
    const g = a.groups?.[group];
    if (!g) return 0;
    return group === 'ingreso' || group === 'devolucion' ? g.deposits : g.withdrawals;
  }
  groupTotal(c: Concentrado, group: string): number {
    const g = c.groupTotals?.[group];
    if (!g) return 0;
    return group === 'ingreso' || group === 'devolucion' ? g.deposits : g.withdrawals;
  }
  label(group: string): string { return GROUP_LABELS[group] || group; }
  kindLabel(kind: string): string { return kind === 'bank' ? 'Banco' : kind === 'cash' ? 'Caja' : 'Factoraje'; }

  private fail(msg: string): void {
    this.loading.set(false);
    this.toast.add({ severity: 'error', summary: 'Error', detail: msg, life: 4000 });
  }
}
