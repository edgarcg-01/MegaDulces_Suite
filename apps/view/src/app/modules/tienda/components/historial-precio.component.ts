import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { compactarHistorial, type PriceHistoryResult, type PriceHistoryRow } from '@megadulces/contracts';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { EtiquetasService, SearchHit } from '../etiquetas.service';
import { ETIQUETAS_TABS } from '../etiquetas-tabs';

type Rango = '90' | '365' | '0';
type Vista = 'filas' | 'tramos';

/**
 * [ETQ-HISTORIAL.3/.4] Buscador de productos y su historial de cambios de precio, en las 9 plazas.
 *
 * Es una PANTALLA (`/tienda/etiquetas/historial`), pestaña junto a «Cambios de precio»; el historial se despliega en línea.
 *
 * La pregunta que contesta: que precio ha tenido este producto, y desde cuando.
 *
 * Dos vistas del MISMO dato, porque la medicion en prod encontro que Kepler reescribe el mismo cambio varias veces
 * (676 de 686 pasos repetidos en el SKU 92013): las FILAS son lo que Kepler escribio; los TRAMOS son lo que le paso al
 * precio. Por decision del PM arranca en filas, para ver como se ve; el tope y el recorte se dicen, no se callan.
 *
 * Una plaza se NOMBRA (pipe sucursal), nunca se numera. La presentacion vacia queda vacia: no se inventa "pieza".
 */
@Component({
  selector: 'app-historial-precio',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule, TableModule, SegmentedComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, PageTabsComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .hp-buscar { position: relative; max-inline-size: 34rem; margin-block-end: 1rem; }
    .hp-cab { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.5rem 1rem; margin: 0 0 0.75rem; }
    .hp-cab h2 { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .hp-cab p { margin: 0.15rem 0 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .hp-vacio { margin: 0; padding: 1.5rem 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .hp-buscar input { inline-size: 100%; }
    .hp-lista { position: absolute; z-index: 20; inset-inline: 0; margin: 0.25rem 0 0; padding: 0.25rem; list-style: none;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--radius-md); box-shadow: var(--shadow-float);
      max-block-size: 22rem; overflow: auto; }
    .hp-hit { display: flex; align-items: baseline; gap: 0.5rem; inline-size: 100%; text-align: start; padding: 0.4rem 0.5rem;
      background: transparent; border: 0; border-radius: var(--radius-sm); color: var(--fg-1); font-size: var(--fs-sm); cursor: pointer; }
    .hp-hit:hover, .hp-hit:focus-visible { background: var(--table-hover); }
    .hp-hit:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .hp-hit[disabled] { cursor: not-allowed; color: var(--fg-3); }
    .hp-hit b { font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .hp-hit .hp-promo { margin-inline-start: auto; font-size: var(--fs-xs); color: var(--fg-2); }
    .hp-aviso { margin: 0.25rem 0 0; font-size: var(--fs-xs); color: var(--fg-3); }

    .hp-resumen { margin: 0 0 0.75rem; font-size: var(--fs-md); color: var(--fg-1); }
    .hp-resumen b { font-variant-numeric: tabular-nums; }
    .hp-resumen small { display: block; margin-block-start: 0.15rem; font-size: var(--fs-xs); color: var(--fg-2); }
    .hp-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin-block-end: 0.75rem; }
    .hp-ctl label { font-size: var(--fs-xs); color: var(--fg-2); }
    .hp-warn { margin: 0 0 0.75rem; padding: 0.5rem 0.75rem; font-size: var(--fs-sm); color: var(--fg-1);
      border: 1px solid var(--border-color); border-inline-start-width: 3px; border-radius: var(--radius-md); }
    .hp-num { text-align: end; font-variant-numeric: tabular-nums; }
    .hp-mute { color: var(--fg-3); }
    .hp-quito { font-size: var(--fs-xs); color: var(--fg-1); font-weight: var(--fw-bold); }
  `],
  template: `
    <!-- [ETQ-HISTORIAL.4] Ventana aparte junto a «Cambios de precio» (mismas pestañas, mismo permiso). -->
    <app-page-tabs [tabs]="tabs" />
    <div class="hp-buscar">
      <input type="search" pInputText aria-label="Buscar un producto para ver su historial de precios"
             placeholder="Busca un producto: nombre, código o barras" autocomplete="off"
             [ngModel]="texto()" (ngModelChange)="escribir($event)" (keydown.enter)="elegirPrimero()" (keydown.escape)="limpiar()" />
      @if (buscando() && resultados.isLoading()) { <p class="hp-aviso" role="status">Buscando…</p> }
      @if (buscando() && resultados.error()) { <p class="hp-aviso" role="alert">No se pudo buscar. Intenta de nuevo.</p> }
      @if (buscando() && !resultados.isLoading() && !resultados.error() && hits().length === 0) {
        <p class="hp-aviso" role="status">Ningún producto coincide con «{{ consulta() }}».</p>
      }
      @if (hits().length) {
        <ul class="hp-lista" role="listbox" aria-label="Productos encontrados">
          @for (h of hits(); track h.product_id) {
            <li role="option" [attr.aria-selected]="false">
              <button type="button" class="hp-hit" [disabled]="!h.sku || !!h.es_promocion" (click)="elegir(h)">
                <b>{{ h.sku }}</b><span>{{ h.name }}</span>
                @if (h.es_promocion) { <span class="hp-promo">Promoción: no es un producto</span> }
              </button>
            </li>
          }
        </ul>
      }
    </div>

    @if (!producto()) {
      <p class="hp-vacio">Escribe el nombre, el código o el código de barras y elige el producto: aquí aparece todo su historial de cambios de precio.</p>
    }
    <section aria-label="Historial de precios del producto">
      @if (producto()) {
        <header class="hp-cab">
          <div><h2>{{ producto()?.name }}</h2><p>Código {{ producto()?.sku }}</p></div>
          <!-- [ETQ-HISTORIAL.5 / H.3.2] Misma ruta que «Cambios de precio»: manda el código a la etiquetera, que lo resuelve y muestra la hoja antes de imprimir. -->
          <p-button label="Imprimir etiqueta" icon="pi pi-print" size="small" [outlined]="true" (onClick)="imprimir()" />
        </header>
        @if (items().length) {
          <app-metric-strip [items]="metricas()" />
          <p class="hp-resumen"><small>Un tramo es un precio que se mantuvo: Kepler lo reescribe varias veces aunque no cambie.</small></p>
        }
        @if (datos()?.freshness; as f) {
          <p class="hp-resumen"><app-freshness-pill [freshness]="f" measures="data" label="Bitácora de precios" /></p>
        }

        <div class="hp-ctl" role="group" aria-label="Filtros del historial">
          <app-segmented [options]="rangos" [value]="rango()" (valueChange)="rango.set($any($event))" ariaLabel="Rango de tiempo" />
          <app-segmented [options]="vistas" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Cómo ver el historial" />
          <label for="hp-plaza">Plaza</label>
          <p-select inputId="hp-plaza" [options]="opcionesPlaza()" optionLabel="label" optionValue="value" [ngModel]="plaza()"
                    (ngModelChange)="plaza.set($event ?? '')" [showClear]="false" appendTo="body" ariaLabel="Plaza" />
          <label for="hp-unidad">Presentación</label>
          <p-select inputId="hp-unidad" [options]="opcionesUnidad()" optionLabel="label" optionValue="value" [ngModel]="unidad()"
                    (ngModelChange)="unidad.set($event ?? '')" [showClear]="false" appendTo="body" ariaLabel="Presentación" />
        </div>

        @if (datos()?.truncado) {
          <p class="hp-warn" role="status">
            Se muestran las {{ datos()?.tope }} más recientes: hay más movimientos y los más viejos no caben.
            Elige un rango menor para ver el tramo que buscas completo.
          </p>
        }

        <app-load-state [loading]="historial.isLoading()" [error]="error()" [isEmpty]="!historial.isLoading() && !error() && filtradas().length === 0"
                        emptyIcon="pi-history" emptyTitle="Sin cambios registrados en este rango"
                        [emptyHint]="items().length ? 'Prueba con otra plaza o presentación.' : 'La bitácora de Kepler no tiene movimientos de este producto en el rango elegido. Eso no dice que no exista: sólo que su precio no se movió.'"
                        errorTitle="No se pudo leer el historial" (retry)="historial.reload()">
          @if (vista() === 'filas') {
            <p-table [value]="filtradas()" styleClass="surf-table surf-table--plain surf-table--sticky" [paginator]="filtradas().length > 100"
                     [rows]="100" [rowsPerPageOptions]="[100, 250, 500]" [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template #header>
                <tr>
                  <th>Plaza</th><th>Fecha</th><th>Hora</th><th>Presentación</th>
                  <th class="comm-num hp-num">Antes</th><th class="comm-num hp-num">Ahora</th><th class="comm-num hp-num">Cambio</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td>{{ r.sucursal | sucursal }}</td>
                  <td>{{ r.fecha }}</td>
                  <td class="hp-mute">{{ hora(r.hora) }}</td>
                  <td>{{ r.unidad ?? '—' }}</td>
                  <td class="comm-num hp-num">{{ r.precio_anterior | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }}</td>
                  <td class="comm-num hp-num">
                    @if (r.es_baja) { <span class="hp-quito">Sin precio</span> } @else { {{ r.precio_nuevo | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }} }
                  </td>
                  <td class="comm-num hp-num">{{ signo(r.delta) }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else {
            <p-table [value]="tramos()" styleClass="surf-table surf-table--plain surf-table--sticky" [paginator]="tramos().length > 100"
                     [rows]="100" [tableStyle]="{ 'min-width': '40rem' }">
              <ng-template #header>
                <tr>
                  <th>Plaza</th><th>Presentación</th><th>Desde</th><th>Hasta</th>
                  <th class="comm-num hp-num">Precio</th><th class="comm-num hp-num">Antes</th><th class="comm-num hp-num">Veces escrito</th>
                </tr>
              </ng-template>
              <ng-template #body let-t>
                <tr>
                  <td>{{ t.sucursal | sucursal }}</td>
                  <td>{{ t.unidad ?? '—' }}</td>
                  <td>{{ t.desde }}</td>
                  <td>{{ t.hasta }}</td>
                  <td class="comm-num hp-num">
                    @if (t.es_baja) { <span class="hp-quito">Sin precio</span> } @else { {{ t.precio | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }} }
                  </td>
                  <td class="comm-num hp-num">{{ t.precio_anterior | currency: 'MXN' : 'symbol-narrow' : '1.2-2' }}</td>
                  <td class="comm-num hp-num">{{ t.veces }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
        </app-load-state>
      }
    </section>
  `,
})
export class HistorialPrecioComponent {
  private readonly svc = inject(EtiquetasService);
  private readonly router = inject(Router);
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  readonly tabs = ETIQUETAS_TABS;
  readonly rangos = [{ label: '90 días', value: '90' }, { label: '1 año', value: '365' }, { label: 'Todo', value: '0' }];
  readonly vistas = [{ label: 'Todas las filas', value: 'filas' }, { label: 'Agrupar repetidos', value: 'tramos' }];

  // ── buscador ──
  readonly texto = signal('');
  readonly consulta = signal('');
  readonly buscando = computed(() => this.consulta().length >= 2);
  readonly resultados = rxResource({
    params: () => (this.consulta().length >= 2 ? this.consulta() : null),
    stream: ({ params }) => (params ? this.svc.search(params) : of<SearchHit[]>([])),
  });
  readonly hits = computed<SearchHit[]>(() => (this.buscando() ? (this.resultados.value() ?? []) : []));

  escribir(v: string): void {
    this.texto.set(v);
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => this.consulta.set(String(v ?? '').trim()), 250);
  }
  limpiar(): void {
    this.texto.set('');
    this.consulta.set('');
  }
  elegirPrimero(): void {
    const h = this.hits().find((x) => x.sku && !x.es_promocion);
    if (h) this.elegir(h);
  }
  elegir(h: SearchHit): void {
    if (!h.sku || h.es_promocion) return;
    this.producto.set(h);
    this.plaza.set('');
    this.unidad.set('');
    this.rango.set('365');
    this.limpiar();
  }

  /**
   * [ETQ-HISTORIAL.5 / H.3.2] Manda ESTE producto a la etiquetera por estado del router (la misma vía de
   * «Cambios de precio»): allá `addBulk()` lo resuelve con el camino de siempre y la persona ve la hoja antes
   * de gastar papel. No abre la impresión sola ni duplica la maquinaria de impresión.
   */
  imprimir(): void {
    const sku = this.producto()?.sku?.trim();
    if (!sku) return;
    this.router.navigate(['/tienda/etiquetas'], { state: { codes: [sku] } });
  }

  // ── historial ──
  readonly producto = signal<SearchHit | null>(null);
  readonly rango = signal<Rango>('365');
  readonly vista = signal<Vista>('filas');
  readonly plaza = signal('');
  readonly unidad = signal('');

  readonly historial = rxResource({
    params: () => {
      const p = this.producto();
      return p?.sku ? { sku: p.sku.trim(), dias: Number(this.rango()) as 90 | 365 | 0 } : null;
    },
    stream: ({ params }) => (params ? this.svc.priceHistory(params.sku, params.dias) : of(null)),
  });
  readonly error = computed(() => (this.historial.error() ? 'Reintenta; si sigue, avisa a Sistemas.' : null));
  /** Leer value() de un recurso en ERROR lanza: se lee sólo si hay valor (error ≠ vacío, y la pantalla no se cae). */
  readonly datos = computed<PriceHistoryResult | null>(() => (this.historial.hasValue() ? this.historial.value() ?? null : null));
  readonly items = computed<PriceHistoryRow[]>(() => this.datos()?.items ?? []);

  readonly plazasConDatos = computed(() => [...new Set(this.items().map((i) => i.sucursal))].sort());
  readonly opcionesPlaza = computed(() => [{ label: 'Todas las plazas', value: '' }, ...this.plazasConDatos().map((s) => ({ label: this.nombrePlaza(s), value: s }))]);
  readonly opcionesUnidad = computed(() => [
    { label: 'Todas', value: '' },
    ...[...new Set(this.items().map((i) => i.unidad ?? ''))].filter(Boolean).sort().map((u) => ({ label: u, value: u })),
  ]);

  readonly filtradas = computed(() => {
    const p = this.plaza();
    const u = this.unidad();
    return this.items().filter((i) => (!p || i.sucursal === p) && (!u || (i.unidad ?? '') === u));
  });
  /** Los tramos de lo que se está viendo (y su conteo, que alimenta la lectura en llano de arriba). */
  readonly tramos = computed(() => compactarHistorial(this.filtradas()));
  /** Lo primero que se lee: cuántas filas escribió Kepler contra cuántos precios distintos tuvo el producto. */
  readonly metricas = computed<MetricStripItem[]>(() => [
    { label: 'Filas de Kepler', value: this.filtradas().length, format: 'number' },
    { label: 'Tramos de precio', value: this.tramos().length, format: 'number' },
    { label: 'Plazas', value: new Set(this.filtradas().map((i) => i.sucursal)).size, format: 'number' },
  ]);

  private nombrePlaza(code: string): string {
    return new SucursalPipe().transform(code);
  }
  hora(h: string | null): string {
    return h ? h.slice(0, 8) : '—';
  }
  signo(d: number | null): string {
    if (d === null || d === undefined) return '—';
    return `${d > 0 ? '+' : ''}${d.toFixed(2)}`;
  }
}
