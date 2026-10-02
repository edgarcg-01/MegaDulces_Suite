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
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

/** La valuación con la que se lee TODA la pantalla. No se mezclan: son dos cuentas distintas. */
type Metrica = 'costo' | 'venta';

/**
 * `[RD.13]` **Inventario de los camiones de Ruta Directa.**
 *
 * DESIGN §15 (answer-first): lo primero que se lee **no es una cifra, es el veredicto** —los
 * camiones no acumulan— y recién después el dinero. Cada número no trivial lleva su lectura en
 * llano al lado (días de venta, % de lo cargado), porque el riesgo #1 de una pantalla densa en
 * cifras no es el estilo sino que no se entienda qué se mira.
 *
 * ⚠️ Lo que la pantalla DECLARA en vez de callar (ADR-056):
 *  - **no hay conteo inicial** → la ventana arranca en la primera carga; el saldo en contra es
 *    mercancía que el camión ya traía. Por eso va partido en dos y **nunca neteado en silencio**;
 *  - **el costo es el del embarque**; el del ERP viaja rotulado aparte, jamás sumado;
 *  - **la cobertura**: cuántos pares no tienen costo o no tienen precio;
 *  - **el cuadre**: si deja de cerrar, el resto de la pantalla no se puede usar, y lo dice.
 *
 * La jerga (cuadre, a favor / en contra, los dos costos) vive en el diccionario versionado
 * (`context-help.dictionary.ts`, tópico `inventario-de-ruta`), no redactada acá — DESIGN §P.
 */
@Component({
  selector: 'app-comercial-inventario-ruta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, DatePickerModule, ToastModule, TagModule,
    PageTabsComponent, SidePeekComponent, MetricStripComponent, LoadStateComponent,
    SegmentedComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
<p-toast />
<div class="ir-page">
  <header class="ir-head">
    <div class="ir-head-txt">
      <h1>Inventario de ruta</h1>
      <p class="ir-sub">
        Lo que trae cada camión, reconstruido del embarque de su sucursal menos lo que vendió.
        Kepler no guarda el saldo de una ruta: guarda los papeles.
      </p>
    </div>
    <app-context-help topic="inventario-de-ruta" />
  </header>

  <app-page-tabs [tabs]="tabs" />

  <section class="ir-bar">
    <div class="ir-bar-l">
      <p-datepicker
        [(ngModel)]="rango"
        selectionMode="range"
        dateFormat="dd/mm/yy"
        placeholder="Toda la ventana"
        [readonlyInput]="true"
        [showClear]="true"
        [showIcon]="true"
        appendTo="body" />
      <p-button label="Aplicar" icon="pi pi-filter" size="small" severity="secondary"
                (onClick)="cargar()" [loading]="cargando()" />
    </div>
    <app-segmented [options]="VALUACIONES" [value]="metrica()"
                   ariaLabel="Valuación" (valueChange)="setMetrica($event)" />
  </section>

  <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!filas().length"
                  [skeletonRows]="11" emptyIcon="pi-truck"
                  emptyTitle="Ninguna ruta con movimiento en este periodo"
                  emptyHint="Probá con «Toda la ventana»: la carga documentada arranca el 15-jul en Padre Hidalgo y el 14-ago en Canindo."
                  (retry)="cargar()">
    @if (data(); as d) {
      <!-- Answer-first: el veredicto en llano ANTES del dinero (DESIGN §15). -->
      <p class="ir-veredicto" [class.ir-no-cierra]="!d.cuadra">
        @if (d.cuadra) {
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <span>
            <strong>Los camiones no acumulan.</strong>
            Lo que queda arriba es el <strong>{{ pctDeLoCargado() | number:'1.1-1' }}%</strong>
            de todo lo que se les cargó — unos <strong>{{ diasDeVenta() | number:'1.0-0' }} días</strong>
            de venta. La cuenta cierra: cargado − vendido = inventario.
          </span>
        } @else {
          <i class="pi pi-times-circle" aria-hidden="true"></i>
          <span>
            <strong>La cuenta NO cierra.</strong> Alguna fila se valuó con dos varas distintas:
            el resto de la pantalla no se puede usar hasta resolverlo. Mirá la columna Δ.
          </span>
        }
      </p>

      <app-metric-strip [items]="kpis()" [ariaLabel]="'Inventario de ruta ' + etiquetaMetrica()" />

      <div class="ir-sub-bar">
        <span>
          {{ filas().length }} rutas ·
          {{ d.desde === TODO ? 'desde la primera carga de cada una' : d.desde + ' → ' + d.hasta }} ·
          dato al {{ d.data_as_of ?? 'sin medir' }}
        </span>
        <span>{{ sinCosto() }} sin costo · {{ sinPrecio() }} sin precio</span>
      </div>

      <!-- Las 10 columnas son CAMPOS de una ruta → se apilan en estrecho (DESIGN_TABLES). -->
      <div class="dt-scope">
        <p-table [value]="filas()" dataKey="route_no" [scrollable]="true" scrollHeight="46vh"
                 class="dt-stack" size="small" [rowHover]="true"
                 [tableStyle]="{ 'min-width': '64rem' }">
          <ng-template #header>
            <tr>
              <th class="ir-frozen">Ruta</th>
              <th>Plaza</th>
              <th class="ir-r">Cargado</th>
              <th class="ir-r">{{ metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente' }}</th>
              <th class="ir-r">Inventario</th>
              <th class="ir-r">A favor</th>
              <th class="ir-r">En contra</th>
              <th class="ir-r">Días</th>
              <th class="ir-r">Δ</th>
              <th class="ir-r"><span class="ir-sr">Detalle</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr [class.ir-fila-mal]="!cierra(r)">
              <td class="ir-frozen dt-id ir-mono" role="cell"><strong>{{ r.route_no }}</strong></td>
              <td class="ir-tenue" role="cell" data-label="Plaza">{{ r.plaza }}</td>
              <td class="ir-r ir-mono" role="cell" data-label="Cargado">{{ carga(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ir-r ir-mono" role="cell"
                  [attr.data-label]="metrica() === 'costo' ? 'Costo vendido' : 'Venta a cliente'">{{ vendido(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ir-r ir-mono ir-fuerte" role="cell" data-label="Inventario">{{ inv(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ir-r ir-mono ir-ok" role="cell" data-label="A favor">{{ invPos(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ir-r ir-mono ir-bad" role="cell" data-label="En contra">{{ invNeg(r) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ir-r ir-mono ir-tenue" role="cell" data-label="Días de venta">{{ dias(r) | number:'1.0-0' }}</td>
              <td class="ir-r ir-mono" role="cell" data-label="Δ del cuadre">
                @if (cierra(r)) { <span class="ir-tenue">0</span> }
                @else { <strong class="ir-bad">{{ delta(r) | number:'1.2-2' }}</strong> }
              </td>
              <td class="ir-r" role="cell" data-label="">
                <p-button icon="pi pi-list" severity="secondary" [text]="true" size="small"
                          [ariaLabel]="'Ver el detalle por producto de la ruta ' + r.route_no"
                          (onClick)="abrirDetalle(r)" />
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>

      @if (metrica() === 'costo' && totalCogsErp() > 0) {
        <p class="ir-contraste">
          <i class="pi pi-flag" aria-hidden="true"></i>
          <span>
            <strong>El ERP tiene su propio costo, y no es éste.</strong>
            Para las rutas de Padre Hidalgo, Kepler guarda además un costo en cada línea de venta:
            <strong>{{ totalCogsErp() | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong> contra los
            {{ totalVendido() | currency:'MXN':'symbol-narrow':'1.0-0' }} del embarque.
            <strong>No se suman</strong> — miden cosas distintas. Se usa el del embarque porque es
            el único con el que la cuenta cierra.
          </span>
        </p>
      }

      <section class="ir-declara">
        <p><i class="pi pi-info-circle" aria-hidden="true"></i> {{ d.declara.sin_ancla }}</p>
        <p><i class="pi pi-info-circle" aria-hidden="true"></i> {{ d.declara.fuera_de_alcance }}</p>
      </section>
    }
  </app-load-state>

  <app-side-peek [(open)]="detalleAbierto" [width]="760"
                 [title]="'Ruta ' + (rutaSel()?.route_no ?? '')"
                 [subtitle]="subtituloDetalle()">
    <app-load-state [loading]="detalle() === null" [isEmpty]="detalle()?.length === 0"
                    [skeletonRows]="8" emptyIcon="pi-box"
                    emptyTitle="Sin productos en este periodo">
      <div class="dt-scope">
        <p-table [value]="detalle() ?? []" [scrollable]="true" scrollHeight="62vh"
                 class="dt-stack" size="small" [rowHover]="true"
                 [tableStyle]="{ 'min-width': '46rem' }">
          <ng-template #header>
            <tr>
              <th>SKU</th><th>Producto</th><th>Un.</th>
              <th class="ir-r">Cargado</th><th class="ir-r">Vendido</th><th class="ir-r">Saldo</th>
              <th class="ir-r">{{ etiquetaMetrica() }}</th>
              <th><span class="ir-sr">Aviso</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr>
              <td class="dt-id ir-mono" role="cell">{{ f.sku }}</td>
              <td role="cell" data-label="Producto">{{ f.producto }}</td>
              <td class="ir-mono ir-tenue" role="cell" data-label="Unidad">{{ f.unidad }}</td>
              <td class="ir-r ir-mono" role="cell" data-label="Cargado">{{ f.qty_carga | number:'1.0-2' }}</td>
              <td class="ir-r ir-mono" role="cell" data-label="Vendido">{{ f.qty_venta | number:'1.0-2' }}</td>
              <td class="ir-r ir-mono" role="cell" data-label="Saldo" [class.ir-bad]="f.saldo < 0">
                <strong>{{ f.saldo | number:'1.0-2' }}</strong>
              </td>
              <td class="ir-r ir-mono" role="cell" [attr.data-label]="etiquetaMetrica()">
                @if (valorFila(f) === null) { <span class="ir-tenue" title="No hay con qué valuarlo">—</span> }
                @else { {{ valorFila(f) | currency:'MXN':'symbol-narrow':'1.0-0' }} }
              </td>
              <td role="cell" data-label="">
                @if (f.veredicto !== 'ok') { <p-tag [value]="etiqueta(f.veredicto)" severity="warn" /> }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    </app-load-state>
  </app-side-peek>
</div>
  `,
  styles: [`
    /* Elevación = borde 1px O sombra, nunca ambas (DESIGN §7). Cero hex crudo (§2). */
    .ir-page { padding: 1rem 1.25rem 2rem; display: flex; flex-direction: column; gap: .9rem; }
    .ir-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .ir-head h1 { font-size: 1.35rem; font-weight: 700; margin: 0; color: var(--c-text-1); }
    .ir-sub { margin: .25rem 0 0; color: var(--c-text-3); font-size: .85rem; max-width: 72ch; }
    .ir-bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .ir-bar-l { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

    .ir-veredicto { display: flex; gap: .55rem; align-items: flex-start; margin: 0;
      font-size: .9rem; color: var(--c-text-1); line-height: 1.45;
      background: var(--c-surface-1); border: 1px solid var(--border);
      border-left: 3px solid var(--ok); border-radius: var(--radius-md); padding: .7rem .9rem; }
    .ir-veredicto i { color: var(--ok); margin-top: .15rem; }
    .ir-veredicto.ir-no-cierra { border-left-color: var(--bad); }
    .ir-veredicto.ir-no-cierra i { color: var(--bad); }

    .ir-sub-bar { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
      font-size: .76rem; color: var(--c-text-3); }

    /* Cifras: Geist Mono + tabular-nums obligatorio (DESIGN §4). */
    .ir-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: .82rem; }
    .ir-r { text-align: right; }
    .ir-fuerte { color: var(--c-text-1); font-weight: 600; }
    .ir-tenue { color: var(--c-text-3); }
    .ir-ok { color: var(--ok-fg); }
    .ir-bad { color: var(--bad-fg); }
    .ir-fila-mal { background: var(--bad-soft-bg); }

    /* 1a columna congelada (DESIGN §7). El header sticky lo da p-table scrollable. */
    .ir-frozen { position: sticky; left: 0; z-index: 1; background: var(--card-bg); }

    .ir-contraste, .ir-declara { font-size: .8rem; color: var(--c-text-2);
      background: var(--c-surface-2); border-radius: var(--radius-sm); padding: .65rem .85rem; margin: 0; }
    .ir-contraste { display: flex; gap: .55rem; align-items: flex-start;
      border-left: 3px solid var(--c-divider); }
    .ir-contraste i { color: var(--c-text-3); margin-top: .15rem; }
    .ir-declara p { margin: 0 0 .3rem; }
    .ir-declara p:last-child { margin: 0; }
    .ir-declara i { color: var(--c-text-3); margin-right: .3rem; }

    .ir-sr { position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap; }

    @media (max-width: 34rem) { .ir-frozen { position: static; } }
  `],
})
export class ComercialInventarioRutaComponent {
  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = REPORTS_TABS;
  /** Centinela que el backend devuelve cuando no se acotó el rango. */
  readonly TODO = '2000-01-01';
  readonly VALUACIONES = [
    { label: 'A costo', value: 'costo' },
    { label: 'A venta', value: 'venta' },
  ];

  rango: Date[] | null = null;
  readonly metrica = signal<Metrica>('costo');
  readonly data = signal<RouteInventoryReport | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly detalleAbierto = signal(false);
  readonly rutaSel = signal<RouteInventoryRow | null>(null);
  readonly detalle = signal<RouteInventoryDetailRow[] | null>(null);

  constructor() { this.cargar(); }

  setMetrica(v: string): void {
    // El conmutador sólo cambia QUÉ columna se lee; no vuelve a pedir nada al servidor.
    this.metrica.set(v === 'venta' ? 'venta' : 'costo');
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    const [f, t] = this.rangoIso();
    this.api.routeInventory(f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.data.set(d); this.cargando.set(false); },
        error: (e) => {
          this.cargando.set(false);
          // Empty ≠ error de red (DESIGN §6): el error va al estado, no a un vacío silencioso.
          this.error.set(e?.error?.message ?? 'No se pudo leer el inventario de ruta.');
        },
      });
  }

  abrirDetalle(r: RouteInventoryRow): void {
    this.rutaSel.set(r);
    this.detalle.set(null);
    this.detalleAbierto.set(true);
    const [f, t] = this.rangoIso();
    this.api.routeInventoryDetail(r.route_no, f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (filas) => this.detalle.set(filas),
        error: () => {
          this.detalle.set([]);
          this.toast.add({ severity: 'error', summary: 'No se pudo abrir el detalle' });
        },
      });
  }

  // ── Lecturas por valuación. Las dos columnas NUNCA se mezclan. ──
  carga = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.carga_costo : r.carga_venta;
  vendido = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.cogs_costo : r.venta_cliente;
  inv = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo : r.inventario_venta;
  invPos = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_pos : r.inventario_venta_pos;
  invNeg = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.inventario_costo_neg : r.inventario_venta_neg;
  delta = (r: RouteInventoryRow) => this.metrica() === 'costo' ? r.delta_costo : r.delta_venta;
  cierra = (r: RouteInventoryRow) => Math.abs(Number(this.delta(r)) || 0) < 0.01;

  /** Lectura en llano de la fila: cuántos días de venta representa lo que trae arriba. */
  dias(r: RouteInventoryRow): number {
    const porDia = Number(this.vendido(r)) / Math.max(1, this.diasVentana());
    return porDia > 0 ? Number(this.inv(r)) / porDia : 0;
  }

  /** ⚠️ `null` cuando no hay con qué valuar. Nunca $0: un cero dibujado miente (ADR-056). */
  valorFila = (f: RouteInventoryDetailRow): number | null =>
    this.metrica() === 'costo' ? f.saldo_costo : f.saldo_venta;

  etiqueta(v: RouteInventoryDetailRow['veredicto']): string {
    return v === 'negativo_sin_ancla' ? 'ya lo traía'
      : v === 'sin_costo' ? 'sin costo'
      : v === 'sin_precio' ? 'sin precio' : '';
  }

  etiquetaMetrica(): string { return this.metrica() === 'costo' ? 'a costo' : 'a venta'; }

  subtituloDetalle(): string {
    return this.metrica() === 'costo'
      ? 'Saldo valuado al costo del embarque'
      : 'Saldo valuado al precio al que de verdad se vendió';
  }

  readonly filas = computed(() => this.data()?.routes ?? []);

  private suma(f: (r: RouteInventoryRow) => number): number {
    return this.filas().reduce((a, r) => a + (Number(f(r)) || 0), 0);
  }
  readonly totalCarga = computed(() => this.suma((r) => this.carga(r)));
  readonly totalVendido = computed(() => this.suma((r) => this.vendido(r)));
  readonly totalInv = computed(() => this.suma((r) => this.inv(r)));
  readonly totalPos = computed(() => this.suma((r) => this.invPos(r)));
  readonly totalNeg = computed(() => this.suma((r) => this.invNeg(r)));
  readonly totalCogsErp = computed(() => this.suma((r) => Number(r.cogs_erp) || 0));
  readonly sinCosto = computed(() => this.filas().reduce((a, r) => a + (r.pares_sin_costo || 0), 0));
  readonly sinPrecio = computed(() => this.filas().reduce((a, r) => a + (r.pares_sin_precio || 0), 0));

  readonly pctDeLoCargado = computed(() => {
    const c = this.totalCarga();
    return c > 0 ? Math.abs(this.totalInv()) / c * 100 : 0;
  });
  readonly diasDeVenta = computed(() => {
    const porDia = this.totalVendido() / Math.max(1, this.diasVentana());
    return porDia > 0 ? Math.abs(this.totalInv()) / porDia : 0;
  });

  /**
   * KPIs con **variedad por tipo de dato** (ADR-033): el saldo cambia de tono con su signo, el
   * par a-favor/en-contra va en tonos opuestos a propósito, y el cuadre es TEXTO, no un número
   * disfrazado. Nunca cinco métricas idénticas.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    const inv = this.totalInv();
    return [
      {
        label: `Inventario ${this.etiquetaMetrica()}`,
        value: inv, format: 'currency-short',
        tone: inv < 0 ? 'bad' : 'brand',
        sub: `${this.pctDeLoCargado().toFixed(1)}% de lo cargado`,
      },
      { label: 'A favor', value: this.totalPos(), format: 'currency-short', tone: 'ok',
        sub: 'sigue arriba del camión' },
      { label: 'En contra', value: this.totalNeg(), format: 'currency-short', tone: 'bad',
        sub: 'ya lo traía de antes' },
      { label: 'Cargado', value: this.totalCarga(), format: 'currency-short', tone: 'default',
        sub: `${this.diasVentana()} días` },
      {
        label: 'Cuadre', value: d?.cuadra === false ? 'NO cierra' : 'Cierra', format: 'text',
        tone: d?.cuadra === false ? 'bad' : 'ok',
        sub: 'cargado − vendido = inventario',
      },
    ];
  });

  /** Días del periodo mirado. Con la ventana completa se toma desde la carga más vieja. */
  private diasVentana(): number {
    const d = this.data();
    if (!d) return 1;
    const desde = d.desde === this.TODO
      ? this.filas().reduce(
        (m, r) => (r.carga_desde && r.carga_desde < m ? r.carga_desde : m), '9999-12-31')
      : d.desde;
    if (!desde || desde === '9999-12-31') return 1;
    const ms = Date.parse(d.hasta) - Date.parse(desde);
    return Math.max(1, Math.round(ms / 86400000));
  }

  private rangoIso(): [string | undefined, string | undefined] {
    const r = this.rango;
    if (!r || !r[0]) return [undefined, undefined];
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [iso(r[0]), r[1] ? iso(r[1]) : iso(r[0])];
  }
}
