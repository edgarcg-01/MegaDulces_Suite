import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  RouteInventoryDetailRow,
  RouteInventoryReport,
  RouteInventoryRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { REPORTS_TABS } from '../reports-tabs';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

/** La métrica con la que se lee TODA la pantalla. No se mezclan: son dos valuaciones distintas. */
type Metrica = 'costo' | 'venta';

/**
 * `[RD.13]` **Inventario de los camiones de Ruta Directa.**
 *
 * Responde "cuánto inventario tienen" como un **cuadre**, no como un dato suelto:
 * `cargado − vendido = inventario`, y la identidad cierra al centavo en las dos valuaciones.
 * El conmutador de arriba cambia la valuación de la pantalla entera — nunca mezcla columnas.
 *
 * ⚠️ Lo que la pantalla DECLARA en vez de callar (ADR-056):
 *  - **no hay conteo inicial**: la ventana arranca en la primera carga documentada, así que el
 *    saldo negativo es mercancía que el camión ya traía. Por eso el inventario sale partido en
 *    "a favor" y "en contra", nunca neteado sin decirlo;
 *  - **el costo es el del embarque** (lo que la sucursal le cargó al camión). La línea del ERP
 *    viaja aparte, rotulada, porque mide otra cosa;
 *  - **la cobertura**: cuántos pares no tienen costo o no tienen precio.
 */
@Component({
  selector: 'app-comercial-inventario-ruta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, DatePickerModule,
    ToastModule, TagModule, PageTabsComponent, SidePeekComponent,
  ],
  providers: [MessageService],
  template: `
<p-toast />
<div class="page">
  <header class="page-head">
    <div>
      <h1>Inventario de ruta</h1>
      <p class="sub">
        Lo que trae cada camión de Ruta Directa, reconstruido del embarque de su sucursal menos lo
        que vendió. Kepler no publica saldo de ruta: no hay tabla que consultar.
      </p>
    </div>
  </header>

  <app-page-tabs [tabs]="tabs" />

  <!-- Filtros + conmutador de valuación -->
  <section class="bar">
    <div class="bar-left">
      <p-datePicker
        [(ngModel)]="rango"
        selectionMode="range"
        dateFormat="dd/mm/yy"
        placeholder="Toda la ventana"
        [readonlyInput]="true"
        [showClear]="true"
        appendTo="body" />
      <p-button label="Aplicar" icon="pi pi-filter" size="small" (onClick)="cargar()" [loading]="cargando()" />
    </div>
    <div class="seg" role="group" aria-label="Valuación">
      <button type="button" [class.on]="metrica() === 'costo'" (click)="setMetrica('costo')">A costo</button>
      <button type="button" [class.on]="metrica() === 'venta'" (click)="setMetrica('venta')">A venta</button>
    </div>
  </section>

  @if (data(); as d) {
    <!-- Respuesta primero: el total, en la valuación elegida -->
    <section class="kpis">
      <article class="kpi strong">
        <span class="k-lbl">Inventario {{ metrica() === 'costo' ? 'a costo' : 'a precio de venta' }}</span>
        <span class="k-val">{{ totalInventario() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
        <span class="k-foot">
          {{ totalPos() | currency:'MXN':'symbol-narrow':'1.0-0' }} a favor ·
          {{ totalNeg() | currency:'MXN':'symbol-narrow':'1.0-0' }} en contra
        </span>
      </article>
      <article class="kpi">
        <span class="k-lbl">Cargado</span>
        <span class="k-val">{{ totalCarga() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
      </article>
      <article class="kpi">
        <span class="k-lbl">{{ metrica() === 'costo' ? 'Costo de lo vendido' : 'Venta a cliente' }}</span>
        <span class="k-val">{{ totalVendido() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
      </article>
      <article class="kpi">
        <span class="k-lbl">Cuadre</span>
        <span class="k-val">
          @if (d.cuadra) { <i class="pi pi-check-circle ok"></i> cierra }
          @else { <i class="pi pi-times-circle mal"></i> NO cierra }
        </span>
        <span class="k-foot">cargado − vendido = inventario</span>
      </article>
    </section>

    <!-- Lo que no se puede callar -->
    <section class="declara">
      <p><i class="pi pi-info-circle"></i> <strong>Sin conteo inicial.</strong> {{ d.declara.sin_ancla }}</p>
      <p><i class="pi pi-info-circle"></i> <strong>De dónde sale el costo.</strong> {{ d.declara.costo }}</p>
      <p><i class="pi pi-info-circle"></i> <strong>Fuera de alcance.</strong> {{ d.declara.fuera_de_alcance }}</p>
      <p class="muted">
        Ventana {{ d.desde === '2000-01-01' ? 'completa (desde la primera carga de cada ruta)' : d.desde }}
        @if (d.desde !== '2000-01-01') { → {{ d.hasta }} } · dato al {{ d.data_as_of ?? 'sin medir' }} ·
        {{ sinCosto() }} pares sin costo · {{ sinPrecio() }} sin precio
      </p>
    </section>

    <!-- Las 10 columnas son CAMPOS de una ruta → se apilan en estrecho (DESIGN_TABLES). -->
    <div class="dt-scope">
    <p-table [value]="d.routes" dataKey="route_no" [scrollable]="true" scrollHeight="52vh"
             styleClass="p-datatable-sm dt-stack" [rowHover]="true"
             [tableStyle]="{ 'min-width': '62rem' }">
      <ng-template #header>
        <tr>
          <th>Ruta</th>
          <th>Plaza</th>
          <th class="r">Cargado</th>
          <th class="r">{{ metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente' }}</th>
          <th class="r">Inventario</th>
          <th class="r">A favor</th>
          <th class="r">En contra</th>
          <th class="r">SKU +/−</th>
          <th class="r">Δ</th>
          <th></th>
        </tr>
      </ng-template>
      <ng-template #body let-r>
        <tr>
          <td class="dt-id mono" role="cell"><strong>{{ r.route_no }}</strong></td>
          <td class="muted" role="cell" data-label="Plaza">{{ r.plaza }}</td>
          <td class="r" role="cell" data-label="Cargado">{{ carga(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          <td class="r" role="cell" [attr.data-label]="metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente'">{{ vendido(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          <td class="r" role="cell" data-label="Inventario"><strong>{{ inv(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong></td>
          <td class="r pos" role="cell" data-label="A favor">{{ invPos(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          <td class="r neg" role="cell" data-label="En contra">{{ invNeg(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          <td class="r muted mono" role="cell" data-label="SKU +/−">{{ r.pares_pos }} / {{ r.pares_neg }}</td>
          <td class="r" role="cell" data-label="Δ del cuadre" [class.mal]="Math.abs(delta(r)) >= 0.01">{{ delta(r) | number:'1.2-2' }}</td>
          <td class="r" role="cell" data-label="">
            <p-button icon="pi pi-list" severity="secondary" [text]="true" size="small"
                      [ariaLabel]="'Ver el detalle de la ruta ' + r.route_no"
                      (onClick)="abrirDetalle(r)" />
          </td>
        </tr>
      </ng-template>
      <ng-template #emptymessage>
        <tr><td colspan="10" class="vacio">Sin movimiento de ruta en la ventana.</td></tr>
      </ng-template>
    </p-table>
    </div>

    @if (metrica() === 'costo') {
      <p class="contraste">
        <i class="pi pi-flag"></i>
        <strong>Línea de contraste.</strong> El ERP escribe su propio costo en la línea de venta de
        las rutas de Padre Hidalgo: {{ totalCogsErp() | currency:'MXN':'symbol-narrow':'1.0-0' }}.
        <strong>No es la misma cifra</strong> que el costo del embarque y no se suma con ella —
        miden cosas distintas (la ficha contra el costo del documento).
      </p>
    }
  }

  <app-side-peek [(open)]="detalleAbierto" [width]="720"
                 [title]="'Ruta ' + (rutaSel()?.route_no ?? '')"
                 [subtitle]="metrica() === 'costo' ? 'Saldo valuado al costo del embarque' : 'Saldo valuado al precio realizado'">
    @if (detalle(); as filas) {
      <div class="dt-scope">
      <p-table [value]="filas" [scrollable]="true" scrollHeight="60vh"
               styleClass="p-datatable-sm dt-stack" [rowHover]="true"
               [tableStyle]="{ 'min-width': '44rem' }">
        <ng-template #header>
          <tr>
            <th>SKU</th><th>Producto</th><th>Un.</th>
            <th class="r">Cargado</th><th class="r">Vendido</th><th class="r">Saldo</th>
            <th class="r">{{ metrica() === 'costo' ? 'A costo' : 'A venta' }}</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template #body let-f>
          <tr>
            <td class="dt-id mono" role="cell">{{ f.sku }}</td>
            <td role="cell" data-label="Producto">{{ f.producto }}</td>
            <td class="mono muted" role="cell" data-label="Unidad">{{ f.unidad }}</td>
            <td class="r" role="cell" data-label="Cargado">{{ f.qty_carga | number:'1.0-2' }}</td>
            <td class="r" role="cell" data-label="Vendido">{{ f.qty_venta | number:'1.0-2' }}</td>
            <td class="r" role="cell" data-label="Saldo" [class.neg]="f.saldo < 0"><strong>{{ f.saldo | number:'1.0-2' }}</strong></td>
            <td class="r" role="cell" [attr.data-label]="metrica() === 'costo' ? 'A costo' : 'A venta'">
              @if (valorFila(f) === null) { <span class="muted">—</span> }
              @else { {{ valorFila(f) | currency:'MXN':'symbol-narrow':'1.0-0' }} }
            </td>
            <td role="cell" data-label="">
              @if (f.veredicto !== 'ok') {
                <p-tag [value]="etiqueta(f.veredicto)" severity="warn" />
              }
            </td>
          </tr>
        </ng-template>
      </p-table>
      </div>
    } @else {
      <p class="muted">Cargando el detalle…</p>
    }
  </app-side-peek>
</div>
  `,
  styles: [`
    .page { padding: 1rem 1.25rem 2rem; display: flex; flex-direction: column; gap: 1rem; }
    .page-head h1 { font-size: 1.35rem; font-weight: 700; margin: 0; color: var(--c-text-1); }
    .page-head .sub { margin: .25rem 0 0; color: var(--c-text-3); font-size: .85rem; max-width: 70ch; }
    .bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .bar-left { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
    .seg button { background: var(--c-surface-1); color: var(--c-text-2); border: 0; padding: .4rem .9rem;
      font-size: .82rem; font-weight: 600; cursor: pointer; }
    .seg button.on { background: var(--action); color: var(--action-ink); }
    .seg button:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .75rem; }
    .kpi { background: var(--c-surface-1); border: 1px solid var(--border); border-radius: var(--radius-md);
      padding: .75rem .9rem; display: flex; flex-direction: column; gap: .15rem; }
    .kpi.strong { border-color: var(--action); }
    .k-lbl { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-3); }
    .k-val { font-size: 1.3rem; font-weight: 700; color: var(--c-text-1); font-variant-numeric: tabular-nums; }
    .k-foot { font-size: .72rem; color: var(--c-text-3); }
    .declara { background: var(--c-surface-2); border: 1px solid var(--border);
      border-radius: var(--radius-md); padding: .7rem .9rem; font-size: .8rem; color: var(--c-text-2); }
    .declara p { margin: 0 0 .35rem; }
    .declara p:last-child { margin: 0; }
    .declara i { color: var(--c-text-3); margin-right: .3rem; }
    .contraste { font-size: .8rem; color: var(--c-text-2); background: var(--c-surface-2);
      border-left: 3px solid var(--c-divider); padding: .6rem .8rem; border-radius: var(--radius-sm); margin: 0; }
    .r { text-align: right; font-variant-numeric: tabular-nums; }
    .mono { font-family: var(--font-mono); font-size: .8rem; }
    .muted { color: var(--c-text-3); }
    .pos { color: var(--ok); }
    .neg { color: var(--bad); }
    .ok { color: var(--ok); }
    .mal { color: var(--bad); }
    .vacio { text-align: center; padding: 1.5rem; color: var(--c-text-3); }
  `],
})
export class ComercialInventarioRutaComponent {
  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = REPORTS_TABS;
  readonly Math = Math;

  rango: Date[] | null = null;
  readonly metrica = signal<Metrica>('costo');
  readonly data = signal<RouteInventoryReport | null>(null);
  readonly cargando = signal(false);
  readonly detalleAbierto = signal(false);
  readonly rutaSel = signal<RouteInventoryRow | null>(null);
  readonly detalle = signal<RouteInventoryDetailRow[] | null>(null);

  constructor() { this.cargar(); }

  setMetrica(m: Metrica) {
    this.metrica.set(m);
    // El detalle se re-pinta solo: la métrica sólo cambia qué columna se lee, no la consulta.
  }

  cargar() {
    this.cargando.set(true);
    const [f, t] = this.rangoIso();
    this.api.routeInventory(f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.data.set(d); this.cargando.set(false); },
        error: (e) => {
          this.cargando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar', detail: e?.error?.message ?? 'Error' });
        },
      });
  }

  abrirDetalle(r: RouteInventoryRow) {
    this.rutaSel.set(r);
    this.detalle.set(null);
    this.detalleAbierto.set(true);
    const [f, t] = this.rangoIso();
    this.api.routeInventoryDetail(r.route_no, f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (filas) => this.detalle.set(filas),
        error: () => this.detalle.set([]),
      });
  }

  // ── Lecturas por métrica. Nunca se mezclan las dos columnas. ──
  carga = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.carga_costo : r.carga_venta;
  vendido = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.cogs_costo : r.venta_cliente;
  inv = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo : r.inventario_venta;
  invPos = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_pos : r.inventario_venta_pos;
  invNeg = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_neg : r.inventario_venta_neg;
  delta = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.delta_costo : r.delta_venta;

  /** ⚠️ `null` cuando no hay con qué valuar. Nunca $0: un cero dibujado miente (ADR-056). */
  valorFila = (f: RouteInventoryDetailRow): number | null =>
    this.metrica() === 'costo' ? f.saldo_costo : f.saldo_venta;

  etiqueta(v: RouteInventoryDetailRow['veredicto']): string {
    return v === 'negativo_sin_ancla' ? 'ya lo traía'
      : v === 'sin_costo' ? 'sin costo'
      : v === 'sin_precio' ? 'sin precio' : '';
  }

  private readonly rows = computed(() => this.data()?.routes ?? []);
  private suma(f: (r: RouteInventoryRow) => number): number {
    return this.rows().reduce((a, r) => a + (Number(f(r)) || 0), 0);
  }
  readonly totalCarga = computed(() => this.suma((r) => this.carga(r)));
  readonly totalVendido = computed(() => this.suma((r) => this.vendido(r)));
  readonly totalInventario = computed(() => this.suma((r) => this.inv(r)));
  readonly totalPos = computed(() => this.suma((r) => this.invPos(r)));
  readonly totalNeg = computed(() => this.suma((r) => this.invNeg(r)));
  readonly totalCogsErp = computed(() => this.suma((r) => Number(r.cogs_erp) || 0));
  readonly sinCosto = computed(() => this.rows().reduce((a, r) => a + (r.pares_sin_costo || 0), 0));
  readonly sinPrecio = computed(() => this.rows().reduce((a, r) => a + (r.pares_sin_precio || 0), 0));

  private rangoIso(): [string | undefined, string | undefined] {
    const r = this.rango;
    if (!r || !r[0]) return [undefined, undefined];
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [iso(r[0]), r[1] ? iso(r[1]) : iso(r[0])];
  }
}
