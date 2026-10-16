import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import type { CampoSinClasificar, RespuestaSinClasificar } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { PreciosService } from '../precios.service';

const NOMBRE: Record<CampoSinClasificar, string> = { linea: 'Sin línea', tipo: 'Sin tipo', grupo: 'Sin grupo' };
const CAMPOS: CampoSinClasificar[] = ['tipo', 'grupo', 'linea'];
/** El carril del ODS empuja la ficha cada ~10 s: media hora sin pasada ya es un espejo detenido. */
const ESPEJO_DETENIDO_SEG = 30 * 60;

/**
 * `[CAT-PRECIO.5]` — **Mantenimiento · Sin clasificar.**
 *
 * Productos sin línea, tipo o grupo en NINGUNA sucursal que vende al público («NO APLICA» o vacío en
 * la ficha de Kepler). Si alguna sucursal sí lo tiene, no está aquí: es una diferencia entre sucursales.
 * Ordenado por venta de 30 días: primero lo que más se vende, que es lo que más estorba sin clasificar.
 */
@Component({
  selector: 'app-compras-mantenimiento-sin-clasificar',
  standalone: true,
  imports: [
    FormsModule, TableModule, SelectModule, TagModule, CheckboxModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc">
      <div class="sc-cabeza">
        @if (datos(); as d) {
          <p class="sc-titular">{{ n(d.con_falta) }} productos no tienen su clasificación completa en ninguna sucursal</p>
          @if (kpis().length) {
            <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Sin clasificar" />
          }
        }
        <div class="sc-cabeza-der">
          @if (datos(); as d) {
            <app-freshness-pill measures="data" [since]="d.ficha_al" [staleAfterSec]="espejoDetenido" label="ficha de Kepler" />
          }
          <app-context-help topic="precios-sucursales" />
        </div>
      </div>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="nadaQueClasificar()"
                      emptyIcon="pi-check-circle" emptyTitle="Todo está clasificado"
                      [emptyHint]="q() || conVenta() ? 'Con estos filtros no queda ningún producto sin clasificar.' : null"
                      (retry)="recargar()">
        <section class="sc-barra" aria-label="Filtros">
          @if (datos(); as d) {
            <div class="sc-chips" role="group" aria-label="Qué le falta">
              <button type="button" class="sc-chip" [class.is-sel]="falta() === null" [attr.aria-pressed]="falta() === null" (click)="onFalta(null)">
                <span>Todos</span><span class="sc-chip-n">{{ n(d.con_falta) }}</span>
              </button>
              @for (c of campos; track c) {
                <button type="button" class="sc-chip" [class.is-sel]="falta() === c" [attr.aria-pressed]="falta() === c" (click)="onFalta(c)">
                  <span>{{ nombre(c) }}</span><span class="sc-chip-n">{{ n(d.resumen[c]) }}</span>
                </button>
              }
            </div>
          }
          <label class="sc-f">
            <span class="sr-only">Buscar producto</span>
            <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                   placeholder="SKU o nombre" autocomplete="off" spellcheck="false" />
          </label>
          <label class="sc-f">
            <span class="sr-only">Línea</span>
            <p-select [options]="opcionesLinea()" optionLabel="label" optionValue="value" [ngModel]="linea()"
                      (onChange)="onLinea($event.value)" [filter]="true" filterBy="label" [showClear]="true"
                      placeholder="Todas las líneas" appendTo="body" ariaLabel="Línea" class="sc-sel" />
          </label>
          <label class="sc-chk">
            <p-checkbox [binary]="true" inputId="sc-venta" [ngModel]="conVenta()" (ngModelChange)="onConVenta($event)" />
            <span>Sólo con venta en 30 días</span>
          </label>
        </section>

        <div class="sc-tabla dt-scope">
          <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                   [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                   [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack">
            <ng-template #header>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">Línea</th>
                <th scope="col">Le falta</th>
                <th scope="col" class="comm-num">Venta 30 d</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td role="cell" data-label="Producto">
                  <div class="sc-prod">
                    <span class="sc-nombre">{{ f.nombre }}</span>
                    <span class="sc-meta"><span class="sc-mono">{{ f.sku }}</span> · en {{ f.plazas }} sucursales</span>
                  </div>
                </td>
                <td role="cell" data-label="Línea"><span>{{ f.linea.nombre || 'Sin línea' }}</span></td>
                <td role="cell" data-label="Le falta">
                  <span class="sc-tags">
                    @for (c of f.falta; track c) { <p-tag [value]="nombre(c)" severity="warn" /> }
                  </span>
                </td>
                <td class="comm-num" role="cell" data-label="Venta 30 d"><span class="sc-mono">{{ f.venta_30d > 0 ? dinero(f.venta_30d) : '—' }}</span></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="4" class="sc-vacio">{{ cargando() ? 'Cargando…' : 'Ningún producto coincide con los filtros.' }}</td></tr>
            </ng-template>
          </p-table>
        </div>

        <footer class="sc-notas">
          <p>Cuenta como sin asignar el valor vacío y el «NO APLICA» de los catálogos de Kepler. Si al menos una sucursal
            ya lo tiene asignado, el producto no aparece aquí: aparece en «Diferencias entre sucursales».</p>
        </footer>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sc { display: flex; flex-direction: column; gap: .625rem; container-type: inline-size; }
    .sc-cabeza { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .sc-titular { flex: 1 1 24rem; margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .sc-cabeza-der { display: flex; align-items: center; gap: .5rem; }
    .sc-barra { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .sc-chips { display: flex; flex-wrap: wrap; gap: .375rem; margin-right: auto; }
    .sc-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2rem; padding: 0 .625rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .sc-chip:hover { background: var(--hover-bg); }
    .sc-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sc-chip.is-sel { border-color: var(--action); background: var(--hover-bg); font-weight: var(--fw-bold); }
    .sc-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--warn-fg); }
    .sc-f { display: flex; flex-direction: column; font-size: var(--fs-xs); color: var(--c-text-2); }
    .sc-f input { height: 2.25rem; width: 14rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .sc-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .sc-sel { min-width: 14rem; }
    .sc-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .sc-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .sc-prod { display: flex; flex-direction: column; min-width: 0; }
    .sc-nombre { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .sc-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .sc-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .sc-tags { display: inline-flex; flex-wrap: wrap; gap: .25rem; }
    .sc-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .sc-notas { margin-top: 1rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .sc-notas p { margin: 0; max-width: 60rem; }
    /* Apilado: las reglas viejas de p-datatable con !important (styles.css, pantalla chica) fijan la última
       celda y esconden de la cuarta en adelante. Deuda con nombre CAT-PRECIO.1.1. */
    @container densetable (max-width: 34rem) {
      .sc-tabla.dt-scope td[data-label] { display: flex !important; position: static !important;
        box-shadow: none !important; min-width: 0 !important; }
      .sc-tabla.dt-scope td[data-label]::before { font-family: var(--font-body); }
      .sc-prod { text-align: right; }
    }
    @container (max-width: 48rem) {
      .sc-f input, .sc-sel { width: 100%; min-width: 0; }
      .sc-f { flex: 1 1 100%; }
    }
  `],
})
export class ComprasMantenimientoSinClasificarComponent {
  readonly campos = CAMPOS;
  readonly espejoDetenido = ESPEJO_DETENIDO_SEG;
  private readonly api = inject(PreciosService);

  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly falta = signal<CampoSinClasificar | null>(null);
  readonly linea = signal<string | null>(null);
  readonly conVenta = signal(false);

  private readonly res = rxResource({
    params: () => ({
      q: this.q() || undefined,
      falta: this.falta() ?? undefined,
      linea: this.linea() ?? undefined,
      con_venta: this.conVenta() || undefined,
      limite: this.tamano(),
      desplazamiento: (this.pagina() - 1) * this.tamano(),
    }),
    stream: ({ params }) => this.api.sinClasificar(params),
  });

  /**
   * El último dato bueno se conserva mientras se recarga: cambiar un filtro no puede desmontar la barra
   * de filtros (el buscador perdía el foco). Antes de la primera carga es `undefined`: nunca se pintan
   * ceros que no se midieron.
   */
  readonly datos = linkedSignal<RespuestaSinClasificar | undefined, RespuestaSinClasificar | undefined>({
    source: () => (this.res.error() ? undefined : this.res.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value,
  });
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => (this.res.error() ? 'No se pudo cargar lo que está sin clasificar.' : null));
  readonly nadaQueClasificar = computed(() => {
    const d = this.datos();
    return !!d && d.con_falta === 0;
  });
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly filas = computed(() => this.datos()?.filas ?? []);
  readonly opcionesLinea = computed(() =>
    // `_` = «sin línea»: el código vacío no viaja por la URL.
    (this.datos()?.lineas ?? []).map((l) => ({ label: `${l.nombre} (${this.n(l.productos)})`, value: l.codigo || '_' })),
  );
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    return [
      { label: 'sin tipo', value: d.resumen.tipo, format: 'number', tone: 'warn' },
      { label: 'sin grupo', value: d.resumen.grupo, format: 'number', tone: 'warn' },
    ];
  });

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => undefined);
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  recargar(): void { this.res.reload(); }
  onBuscar(v: string): void { this.busqueda = v; this.buscarDebounced(v); }
  onFalta(c: CampoSinClasificar | null): void { this.falta.set(c); this.pagina.set(1); }
  onLinea(v: string | null): void { this.linea.set(v); this.pagina.set(1); }
  onConVenta(v: boolean): void { this.conVenta.set(!!v); this.pagina.set(1); }

  nombre(c: CampoSinClasificar): string { return NOMBRE[c]; }
  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(v));
  }
  n(v: number): string { return new Intl.NumberFormat('es-MX').format(Number(v)); }
}
