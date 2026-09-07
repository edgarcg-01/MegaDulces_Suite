import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, catchError, debounceTime, distinctUntilChanged, of } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import {
  ExistenciaApiService, ExistenciaRow, ExistenciaCell, ExistenciaColumn,
  ExistenciaTotals, ExistenciaFreshness, ExistenciaDetailRow,
} from '../existencia.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * EXISTENCIA — la misma pantalla en Almacén (`/almacen/inventory/existencia`) y en Compras
 * (`/compras/existencia`). Un solo componente, dos rutas: cero divergencia.
 *
 * Layout O.2 (Almacén/Compras): grid full-width, header sticky, SKU congelado a la izquierda,
 * fila de totales al pie, frescura y offline prominentes — "el dato de existencia es volátil:
 * nunca se ve estático sin señal de cuán fresco es".
 *
 * Answer-first (Q.1): la pantalla abre con la conclusión (valor del inventario, cuánto NO se está
 * midiendo, cuántos agotados) y cada tarjeta es un FILTRO, no un adorno (Q.4).
 *
 * La regla dura que hereda de U.2b: cuando el costo pagado contradice el divisor de un almacén,
 * la celda muestra la cantidad NATIVA con el rótulo del ERP (`2,679 kg ⚠`) y su dinero va en raya
 * — nunca `$0`, que se lee "no cuesta nada". Ver docs/UNIDADES_DE_MEDIDA.md §8quater.
 */
@Component({
  selector: 'app-almacen-existencia',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, PaginatorModule, TagModule,
    InputTextModule, IconFieldModule, InputIconModule, MultiSelectModule, ToggleSwitchModule,
    MetricStripComponent, FreshnessPillComponent, ContextHelpComponent, SidePeekComponent,
  ],
  template: `
    <section class="ex">
      <header class="ex-head">
        <div class="ex-title">
          <h1>Existencia</h1>
          <p class="ex-sub">
            Qué hay y dónde, derivado del ERP. Una fila por producto, una columna por almacén.
            <span class="ex-note">De consulta: la compra se decide en Pedido y el ajuste en Ajustes de stock.</span>
          </p>
        </div>
        <div class="ex-actions">
          <!-- O.2 — la frescura va arriba y POR RAMA. Una sola píldora promediaría un feed de
               minutos con uno de horas y mentiría sobre las dos. -->
          @for (f of freshness(); track f.rama) {
            <app-freshness-pill [since]="f.dato_al" [label]="f.label" [staleAfterSec]="staleFor(f)" />
          }
          <app-context-help topic="existencia" />
        </div>
      </header>

      @if (totals(); as t) {
        <app-metric-strip [items]="kpis(t)" ariaLabel="Resumen de existencia" />
        <!-- Se DECLARA lo que los totales no incluyen. Un total que excluye en silencio se lee
             como si lo abarcara todo. -->
        @if (t.celdas_sin_valuar) {
          <p class="ex-banner">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>{{ sinValuarTexto(t) }}</span>
            <button type="button" class="ex-link" (click)="soloSinUnidad()">Ver sólo ésos</button>
          </p>
        }
      }

      <div class="ex-filters">
        <p-iconfield class="ex-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" [(ngModel)]="fSearch" (ngModelChange)="search$.next($event)"
                 placeholder="SKU o nombre…" aria-label="Buscar producto" />
        </p-iconfield>
        <p-multiselect [options]="whOpts()" [(ngModel)]="fWarehouses" (onChange)="reload(1)"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes"
                       [showClear]="true" [maxSelectedLabels]="3" selectedItemsLabel="{0} almacenes"
                       styleClass="ex-sel" appendTo="body" />
        <p-multiselect [options]="bucketOpts" [(ngModel)]="fBucket" (onChange)="reload(1)"
                       optionLabel="label" optionValue="value" placeholder="Todos los estados"
                       [showClear]="true" [maxSelectedLabels]="1" styleClass="ex-sel" appendTo="body" />
        <label class="ex-toggle">
          <p-toggleswitch [(ngModel)]="fHideZero" (onChange)="reload(1)" />
          <span>Sólo con existencia</span>
        </label>
        @if (fOnlyUnverified()) {
          <p-tag severity="warn" value="Sólo sin unidad verificada" styleClass="ex-chip"
                 (click)="fOnlyUnverified.set(false); reload(1)" />
        }
      </div>

      <div class="ex-grid">
        <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
                 dataKey="product_id" [tableStyle]="{ 'min-width': '60rem' }" styleClass="ex-table"
                 (sortFunction)="onSort($event)" [customSort]="true">
          <ng-template #header>
            <tr>
              <th pFrozenColumn class="ex-sku" pSortableColumn="sku">SKU <p-sorticon field="sku" /></th>
              <th pFrozenColumn class="ex-name" pSortableColumn="nombre">Producto <p-sorticon field="nombre" /></th>
              @for (c of columns(); track c.code) {
                <th class="ex-r ex-wh" [title]="colTitle(c)">
                  {{ c.code }}
                  @if (c.es_hub) { <i class="pi pi-building" aria-hidden="true"></i> }
                  @if (staleCol(c)) { <i class="pi pi-clock ex-stale" aria-hidden="true"></i> }
                </th>
              }
              <th class="ex-r" pSortableColumn="existencia">Total cjs <p-sorticon field="existencia" /></th>
              <th class="ex-r" pSortableColumn="valor">Valor <p-sorticon field="valor" /></th>
            </tr>
          </ng-template>

          <ng-template #body let-r>
            <tr (click)="open(r)" class="ex-row">
              <td pFrozenColumn class="ex-sku">{{ r.sku }}</td>
              <td pFrozenColumn class="ex-name" [title]="r.nombre">{{ r.nombre }}</td>
              @for (c of columns(); track c.code) {
                @if (cell(r, c.code); as cl) {
                  @if (cl.rung) {
                    <!-- No se puede convertir a cajas: va la cantidad SUELTA con su rótulo, que
                         sí es verdad. Una cifra en cajas acá sería inventada. -->
                    <td class="ex-r ex-rung" [title]="rungTitle(r, c.code, cl)">
                      {{ cl.nat | number:'1.0-0' }} {{ natU(cl) }}
                      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    </td>
                  } @else {
                    <td class="ex-r">
                      <span [class]="'ex-q ' + bClass(cl.b)">{{ cl.q | number:'1.0-1' }}</span>
                    </td>
                  }
                } @else {
                  <!-- Sin fila en el ERP para ese almacén. Un punto y no un 0: "no hay renglón"
                       y "hay cero" no son lo mismo (Q.5 — jerarquía por tipo, no por color). -->
                  <td class="ex-r ex-none">·</td>
                }
              }
              <td class="ex-r ex-strong">{{ r.total_cajas | number:'1.0-1' }}</td>
              <td class="ex-r ex-val" [title]="valorTitle(r)">
                @if (r.sin_valuar) {
                  <span class="ex-rung">
                    @if (r.valor) { {{ money(r.valor) }} } @else { sin valuar }
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  </span>
                } @else { {{ money(r.valor) }} }
              </td>
            </tr>
          </ng-template>

          <!-- O.2 exige la fila de totales. ⚠️ Ninguna otra pantalla del repo combina footer con
               columna congelada en PrimeNG 22, así que si el pie no se pega hay que pasarlo a un
               strip sticky fuera de la tabla. Es lo único de esta pantalla que no pude verificar. -->
          <ng-template #footer>
            @if (totals(); as t) {
              <tr class="ex-tot">
                <td pFrozenColumn class="ex-sku">Total</td>
                <td pFrozenColumn class="ex-name">{{ t.skus | number }} productos</td>
                @for (c of columns(); track c.code) {
                  <td class="ex-r" [title]="whTotTitle(t, c.code)">
                    {{ whTot(t, c.code)?.cajas | number:'1.0-0' }}
                  </td>
                }
                <td class="ex-r"></td>
                <td class="ex-r ex-strong">{{ money(t.valor) }}</td>
              </tr>
            }
          </ng-template>

          <ng-template #emptymessage>
            <tr><td [attr.colspan]="columns().length + 4" class="ex-empty">
              @if (loading()) { Cargando… } @else { Ningún producto con los filtros activos. }
            </td></tr>
          </ng-template>
        </p-table>
      </div>

      <p-paginator [rows]="pageSize()" [totalRecords]="total()" [first]="(page() - 1) * pageSize()"
                   [rowsPerPageOptions]="[25, 50, 100]" (onPageChange)="onPage($event)" />

      <app-side-peek [open]="peek()" (openChange)="peek.set($event)"
                     [title]="peekTitle()" [subtitle]="peekSub()">
        @if (detail().length) {
          <table class="ex-detail">
            <thead>
              <tr><th>Almacén</th><th class="ex-r">Existencia</th><th>Unidad</th><th class="ex-r">÷ caja</th>
                  <th class="ex-r">Mín</th><th class="ex-r">Reorden</th><th class="ex-r">Máx</th><th>ERP</th></tr>
            </thead>
            <tbody>
              @for (d of detail(); track d.warehouse_code) {
                <tr [class.ex-rung-row]="d.rung_veredicto">
                  <td>{{ d.warehouse_code }} <span class="ex-none">{{ d.warehouse_name }}</span></td>
                  <td class="ex-r">{{ d.nat | number:'1.0-2' }}</td>
                  <td>{{ d.base_label || '—' }}</td>
                  <td class="ex-r">
                    {{ d.dbf | number:'1.0-2' }}
                    @if (d.rung_veredicto) {
                      <span class="ex-rung" [title]="detailRungTitle(d)">
                        (el costo dice {{ d.dbf_esperado | number:'1.0-2' }}) <i class="pi pi-exclamation-triangle"></i>
                      </span>
                    }
                  </td>
                  <td class="ex-r ex-none">{{ d.min_stock | number:'1.0-0' }}</td>
                  <td class="ex-r ex-none">{{ d.reorder_point | number:'1.0-0' }}</td>
                  <td class="ex-r ex-none">{{ d.max_stock | number:'1.0-0' }}</td>
                  <td class="ex-none">{{ d.erp || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
          <!-- Q.4 — todo dato accionable navega a su arreglo con el filtro puesto. -->
          <div class="ex-peek-actions">
            <button pButton type="button" size="small" severity="secondary" icon="pi pi-shopping-cart"
                    label="Ver en Pedido" (click)="verEnPedido()"></button>
          </div>
        } @else { <p class="ex-none">Cargando desglose…</p> }
      </app-side-peek>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ex { display: flex; flex-direction: column; gap: .75rem; padding: 1rem 1rem 0; min-height: 0; }
    .ex-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .ex-title h1 { margin: 0; font-size: 1.15rem; font-weight: 700; letter-spacing: -.01em; }
    .ex-sub { margin: .15rem 0 0; font-size: .78rem; color: var(--text-color-secondary); max-width: 62ch; line-height: 1.45; }
    .ex-note { display: block; color: var(--text-faint); }
    .ex-actions { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }

    .ex-banner {
      display: flex; gap: .5rem; align-items: flex-start; margin: -.25rem 0 0;
      padding: .55rem .7rem; border: 1px solid var(--border-color); border-radius: var(--radius-md, 8px);
      background: var(--surface-hover, transparent); color: var(--text-color-secondary);
      font-size: .78rem; line-height: 1.45;
    }
    .ex-banner i { color: var(--warn-fg, #b45309); margin-top: .1rem; flex: none; }
    .ex-link { background: none; border: 0; padding: 0; color: var(--action, #c2410c); cursor: pointer;
               font: inherit; text-decoration: underline; white-space: nowrap; }

    .ex-filters { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .ex-search { flex: 0 1 18rem; }
    .ex-search input { width: 100%; }
    .ex-toggle { display: inline-flex; align-items: center; gap: .4rem; font-size: .78rem; color: var(--text-color-secondary); }
    .ex-chip { cursor: pointer; }

    /* O.2 — full-width grid; el alto lo cede al viewport para que el pie quede a la vista. */
    .ex-grid { min-height: 0; flex: 1 1 auto; overflow: hidden; }
    .ex-table { font-size: .78rem; }
    .ex-r { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono, ui-monospace), monospace; }
    .ex-sku { width: 6.5rem; font-family: var(--font-mono, ui-monospace), monospace; }
    .ex-name { min-width: 15rem; max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ex-wh { min-width: 5.5rem; }
    .ex-wh i { font-size: .6rem; opacity: .55; margin-left: .15rem; }
    .ex-stale { color: var(--warn-fg, #b45309); opacity: .9 !important; }
    .ex-row { cursor: pointer; }
    .ex-none { color: var(--text-faint); }
    .ex-strong { font-weight: 700; }
    .ex-val { min-width: 7rem; }

    /* La celda que no se puede convertir. Aviso, no error: el dato existe — lo que falta es la
       certeza de su unidad. Mismo lenguaje que /compras/pedido. */
    .ex-rung { color: var(--warn-fg, #b45309); white-space: nowrap; }
    .ex-rung i { font-size: .65rem; margin-left: .2rem; }
    .ex-rung-row td { background: color-mix(in srgb, var(--warn-fg, #b45309) 7%, transparent); }

    /* Estado por FORMA además de tono: el color no puede ser el único portador (Q.6). */
    .ex-q.b-agotado { color: var(--danger-fg, #b91c1c); font-weight: 700; }
    .ex-q.b-bajo_minimo { color: var(--danger-fg, #b91c1c); }
    .ex-q.b-bajo_reorden { color: var(--warn-fg, #b45309); }
    .ex-q.b-sobrestock { color: var(--text-color-secondary); font-style: italic; }

    .ex-tot td { font-weight: 700; border-top: 2px solid var(--border-color); background: var(--surface-section, transparent); }
    .ex-empty { text-align: center; padding: 2rem; color: var(--text-color-secondary); }

    .ex-detail { width: 100%; border-collapse: collapse; font-size: .76rem; }
    .ex-detail th { text-align: left; font-weight: 600; padding: .3rem .4rem; border-bottom: 1px solid var(--border-color); color: var(--text-color-secondary); }
    .ex-detail td { padding: .3rem .4rem; border-bottom: 1px solid var(--surface-border, var(--border-color)); }
    .ex-peek-actions { margin-top: .9rem; display: flex; gap: .5rem; }

    @media (max-width: 48rem) { .ex { padding: .6rem .6rem 0; } .ex-search { flex: 1 1 100%; } }
  `],
})
export class AlmacenExistenciaComponent implements OnInit {
  private readonly api = inject(ExistenciaApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<ExistenciaRow[]>([]);
  readonly columns = signal<ExistenciaColumn[]>([]);
  readonly totals = signal<ExistenciaTotals | null>(null);
  readonly freshness = signal<ExistenciaFreshness[]>([]);
  readonly loading = signal(false);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(50);

  fSearch = '';
  fWarehouses: string[] = [];
  fBucket: string[] = [];
  fHideZero = true;
  readonly fOnlyUnverified = signal(false);
  private sortBy = 'valor';
  private sortDir = 'desc';

  readonly search$ = new Subject<string>();

  readonly bucketOpts = [
    { label: 'Agotado', value: 'agotado' },
    { label: 'Bajo mínimo', value: 'bajo_minimo' },
    { label: 'Bajo reorden', value: 'bajo_reorden' },
    { label: 'Sano', value: 'sano' },
    { label: 'Sobrestock', value: 'sobrestock' },
  ];
  readonly whOpts = computed(() => this.columns().map((c) => ({ label: `${c.code} · ${c.name}`, value: c.code })));

  // Side-peek
  readonly peek = signal(false);
  readonly detail = signal<ExistenciaDetailRow[]>([]);
  private peekRow: ExistenciaRow | null = null;
  readonly peekTitle = signal('');
  readonly peekSub = signal('');

  ngOnInit(): void {
    this.search$.pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.reload(1));
    this.reload(1);
  }

  reload(page?: number): void {
    if (page) this.page.set(page);
    this.loading.set(true);
    this.api.list({
      search: this.fSearch,
      warehouse_ids: this.fWarehouses,
      bucket: this.fBucket.length === 1 ? this.fBucket[0] : undefined,
      hide_zero: this.fHideZero,
      only_unverified: this.fOnlyUnverified(),
      sort_by: this.sortBy, sort_dir: this.sortDir,
      page: this.page(), pageSize: this.pageSize(),
    }).pipe(
      // Empty ≠ error de red: si truena, se avisa y no se pinta una tabla vacía silenciosa.
      catchError(() => of(null)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) return;
      this.rows.set(r.rows || []);
      if (r.columns?.length) this.columns.set(r.columns);
      this.totals.set(r.totals);
      this.freshness.set(r.freshness || []);
      this.total.set(r.total || 0);
    });
  }

  onPage(e: PaginatorState): void {
    this.pageSize.set(e.rows || 50);
    this.reload(Math.floor((e.first || 0) / (e.rows || 50)) + 1);
  }

  onSort(e: any): void {
    const map: Record<string, string> = { sku: 'sku', nombre: 'nombre', existencia: 'existencia', valor: 'valor' };
    this.sortBy = map[e.field] || 'valor';
    this.sortDir = e.order === 1 ? 'asc' : 'desc';
    this.reload(1);
  }

  soloSinUnidad(): void { this.fOnlyUnverified.set(true); this.reload(1); }

  cell(r: ExistenciaRow, code: string): ExistenciaCell | null { return r.cells?.[code] ?? null; }

  /**
   * El rótulo de la unidad nativa. ⚠️ Kepler a veces guarda ahí un NÚMERO (el gramaje de la bolsa:
   * '500', '250') en vez del nombre: concatenarlo daba "298 500", que no se lee como nada. En ese
   * caso va "u." y el gramaje queda en el tooltip. Misma regla que en compras-pedido-real.
   */
  natU(cl: ExistenciaCell): string {
    const raw = (cl.natu || '').trim();
    if (!raw) return 'u';
    return /^[\d.]+$/.test(raw) ? 'u' : raw.toLowerCase();
  }

  bClass(b?: string): string { return b ? `b-${b}` : ''; }

  kpis(t: ExistenciaTotals): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Valor del inventario', value: t.valor ?? 0, format: 'currency', tone: 'brand' },
      { label: 'Productos con existencia', value: t.skus },
    ];
    if (t.celdas_sin_valuar) {
      items.push({ label: 'Sin unidad verificada', value: t.skus_sin_valuar, tone: 'warn' });
    }
    return items;
  }

  sinValuarTexto(t: ExistenciaTotals): string {
    const arb = t.arbitrado
      ? ` Por lo que se pagó valdrían ~${this.money(t.arbitrado)}, cifra de referencia para revisar — no publicable.`
      : '';
    return `${t.skus_sin_valuar} productos (${t.celdas_sin_valuar} celdas) no se pueden convertir a cajas: `
      + `el costo de compra contradice el divisor de ese almacén. Se muestra la cantidad suelta con su unidad. `
      + `No valen cero: no se están midiendo.${arb}`;
  }

  rungTitle(r: ExistenciaRow, code: string, cl: ExistenciaCell): string {
    const raw = (cl.natu || '').trim();
    const u = /^[\d.]+$/.test(raw) ? `unidades de ${raw}` : this.natU(cl);
    const dir = cl.rung === 'x1_inflada'
      ? 'el divisor de cajas es más chico de lo que el costo justifica'
      : 'el divisor de cajas es más grande de lo que el costo justifica';
    return `No se puede convertir a cajas: ${dir}. Lo que sí es verdad: hay `
      + `${(cl.nat ?? 0).toLocaleString('es-MX')} ${u} en ${code}. Clic para ver el desglose.`;
  }

  valorTitle(r: ExistenciaRow): string {
    if (!r.sin_valuar) return '';
    return `${r.sin_valuar} de ${r.n_almacenes} almacenes quedan fuera de este valor: su unidad no está `
      + 'verificada. El total de la red los excluye y los declara aparte.';
  }

  detailRungTitle(d: ExistenciaDetailRow): string {
    return `Usamos ${d.dbf} unidades por caja, pero lo que se pagó implica ${d.dbf_esperado}. `
      + `Mientras no se resuelva, esta celda no se convierte ni se valúa.`
      + (d.arbitrado ? ` Por lo pagado valdría ~${this.money(d.arbitrado)} (referencia).` : '');
  }

  colTitle(c: ExistenciaColumn): string {
    const f = this.freshness().find((x) => this.ramaOf(c.code) === x.rama);
    const edad = f ? ` · dato de hace ${this.edad(f.minutos)}` : '';
    return `${c.name}${c.es_hub ? ' (centro de distribución)' : ''}${edad}`;
  }

  /** Kepler alimenta 01-06; Wincaja el CEDIS 00 y los de Morelia. */
  private ramaOf(code: string): string {
    return (code === '00' || code.startsWith('MD-')) ? 'wincaja' : 'kepler';
  }

  /** Marca la columna cuyo feed pasó de 3 h: quien lee UNA columna tiene que ver que es de ayer. */
  staleCol(c: ExistenciaColumn): boolean {
    const f = this.freshness().find((x) => this.ramaOf(c.code) === x.rama);
    return !!f && f.minutos > 180;
  }

  /**
   * El umbral de la píldora. ⚠️ Provisional y declarado: `wincaja.v_stock` NO tiene sensor en
   * `db-health` (los que hay miden la VENTA de Wincaja, no la existencia), así que hasta que lo
   * tenga se usa un umbral local en vez de inventar uno con cara de oficial.
   */
  staleFor(f: ExistenciaFreshness): number { return f.rama === 'kepler' ? 900 : 3600 * 8; }

  private edad(min: number): string {
    if (min < 90) return `${Math.round(min)} min`;
    const h = min / 60;
    return h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} días`;
  }

  whTot(t: ExistenciaTotals, code: string) { return t.per_warehouse?.find((w) => w.code === code) ?? null; }
  whTotTitle(t: ExistenciaTotals, code: string): string {
    const w = this.whTot(t, code);
    if (!w) return '';
    const sv = w.sin_valuar ? ` · ${w.sin_valuar} celdas sin valuar, fuera de esta suma` : '';
    return `${w.skus_con_existencia} productos con existencia · ${this.money(w.valor)}${sv}`;
  }

  open(r: ExistenciaRow): void {
    this.peekRow = r;
    this.peekTitle.set(`${r.sku} · ${r.nombre}`);
    this.peekSub.set(r.sin_valuar
      ? `${r.sin_valuar} almacén(es) con la unidad sin verificar`
      : `${r.n_almacenes} almacén(es) con existencia`);
    this.detail.set([]);
    this.peek.set(true);
    this.api.detail(r.product_id).pipe(catchError(() => of({ product: null, rows: [] })), takeUntilDestroyed(this.destroyRef))
      .subscribe((d) => this.detail.set(d.rows || []));
  }

  /** Q.4 — navega a su lugar de arreglo CON el filtro puesto. */
  verEnPedido(): void {
    if (!this.peekRow) return;
    this.router.navigate(['/compras/pedido'], { queryParams: { search: this.peekRow.sku } });
  }

  // null NO es cero. Un importe ausente significa "no se está midiendo" y se dibuja como raya:
  // $0 se lee "no cuesta nada", que es la mentira que esta pantalla existe para quitar.
  money(v: number | string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '—';
    return (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
