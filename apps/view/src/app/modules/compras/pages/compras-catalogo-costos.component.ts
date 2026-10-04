import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { CATALOGO_TABS } from '../catalogo-tabs';
import {
  CeldaEntreSucursales,
  CostoEstandarService,
  FilaEntreSucursales,
  VeredictoEntreSucursales,
} from '../costo-estandar.service';
import { ComprasCostosHistorialComponent } from './compras-costos-historial.component';

/** Los chips, en el orden en que hay que atenderlos. `igual` al final: es la meta, no la tarea. */
const CHIPS: { id: VeredictoEntreSucursales | ''; label: string; tono: 'bad' | 'warn' | 'info' | 'ok' | 'base' }[] = [
  { id: '', label: 'Con diferencia', tono: 'base' },
  { id: 'distinto', label: 'Una plaza se sale', tono: 'bad' },
  { id: 'sin_mayoria', label: 'Sin mayoría', tono: 'warn' },
  { id: 'unidad_distinta', label: 'Unidad distinta', tono: 'info' },
  { id: 'igual', label: 'Iguales', tono: 'ok' },
];

const ETIQUETA: Record<VeredictoEntreSucursales, string> = {
  distinto: 'Se sale de la mayoría',
  sin_mayoria: 'Sin mayoría',
  unidad_distinta: 'Unidad distinta',
  igual: 'Igual',
  una_plaza: 'Una plaza',
};

interface FilaVista extends FilaEntreSucursales {
  porSucursal: Record<string, CeldaEntreSucursales | undefined>;
}

/**
 * `[CAT-COSTO.4]` — **Costos · Etapa 1: el costo estándar entre sucursales.**
 *
 * El costo estándar es la negociación con el proveedor (lista menos descuentos) y de él sale el
 * precio con el margen. Tiene que ser el mismo en todas las plazas; la meta es cero diferencias.
 *
 * La pantalla no decide nada: quién se sale, contra qué y qué se declara viene del servidor
 * (`clasificarEntreSucursales`). Aquí sólo se pinta, y se dice en voz alta lo que no se compara
 * (sin mayoría, unidad distinta, una sola plaza) en vez de dibujarlo como igual.
 *
 * Etapas siguientes (maqueta aprobada 2026-10-04): contra orden de entrada + historial,
 * proveedores y notas de crédito, utilidad de gestión. No se muestran pestañas vacías para ellas.
 */
@Component({
  selector: 'app-compras-catalogo-costos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, CheckboxModule, TooltipModule, PageTabsComponent, ComprasCostosHistorialComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cc">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costos</h1>
          <p class="surf-page-sub">
            @if (vista() === 'historial') {
              Cómo fue cambiando el costo estándar negociado y el costo de entrada de un producto, sucursal por sucursal.
            } @else {
              Costo estándar entre sucursales: el costo de la ficha de Kepler tiene que ser el mismo en todas las plazas.
              Se corrige en Kepler.
            }
          </p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <div class="cc-vistas" role="tablist" aria-label="Vistas de costo estándar">
        <button type="button" role="tab" class="cc-vista" [class.is-sel]="vista() === 'sucursales'"
                [attr.aria-selected]="vista() === 'sucursales'" (click)="irA('sucursales')">Entre sucursales</button>
        <button type="button" role="tab" class="cc-vista" [class.is-sel]="vista() === 'historial'"
                [attr.aria-selected]="vista() === 'historial'" (click)="irA('historial')">Historial por producto</button>
      </div>

      @if (vista() === 'historial') {
        <app-compras-costos-historial [sku]="skuHistorial()" (skuElegido)="abrirHistorial($event)" />
      } @else {

      @if (datos(); as d) {
        <section class="cc-respuesta" aria-live="polite">
          <div class="cc-respuesta-txt">
            <p class="cc-titular">
              {{ n(d.resumen.distinto) }} productos tienen una sucursal con costo estándar distinto al de la mayoría.
            </p>
            <p class="cc-sub">
              La meta es cero. Tolerancia {{ d.tolerancia_pct }} %. Además, {{ n(d.resumen.sin_mayoria) }} sin mayoría y
              {{ n(d.resumen.unidad_distinta) }} con unidad distinta entre plazas: esos no se pueden comparar, se revisan a mano.
            </p>
          </div>
        </section>

        <div class="cc-chips" role="group" aria-label="Filtrar por resultado">
          @for (ch of chips; track ch.id) {
            <button type="button" class="cc-chip" [class]="'cc-chip cc-tono-' + ch.tono"
                    [class.is-sel]="veredicto() === ch.id" [attr.aria-pressed]="veredicto() === ch.id"
                    (click)="onVeredicto(ch.id)">
              <span>{{ ch.label }}</span>
              <span class="cc-chip-n">{{ n(conteo(ch.id)) }}</span>
            </button>
          }
        </div>
      }

      <section class="cc-filtros" aria-label="Filtros">
        <label class="cc-f">
          <span>Buscar producto</span>
          <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                 placeholder="SKU o nombre" autocomplete="off" spellcheck="false" />
        </label>
        <label class="cc-f">
          <span>Proveedor</span>
          <p-select [options]="opcionesProveedor()" optionLabel="label" optionValue="value"
                    [ngModel]="proveedor()" (onChange)="onProveedor($event.value)"
                    [filter]="true" filterBy="label" [showClear]="true" placeholder="Todos"
                    appendTo="body" ariaLabel="Proveedor" class="cc-sel" />
        </label>
        <label class="cc-f">
          <span>Sucursal que se sale</span>
          <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                    [ngModel]="sucursal()" (onChange)="onSucursal($event.value)"
                    [showClear]="true" placeholder="Cualquiera" appendTo="body" ariaLabel="Sucursal" class="cc-sel" />
        </label>
        <label class="cc-chk">
          <p-checkbox [binary]="true" inputId="cc-venta" [ngModel]="soloConVenta()" (ngModelChange)="onSoloConVenta($event)" />
          <span>Comparar sólo sucursales con venta en 30 días</span>
        </label>
      </section>

      <div class="cc-tabla">
        <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                 [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                 [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                 size="small" class="surf-table surf-table--sticky">
          <ng-template #header>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col">Unidad</th>
              <th scope="col" class="cc-num">Mayoría</th>
              @for (s of sucursales(); track s.codigo) {
                <th scope="col" class="cc-num" [pTooltip]="s.nombre || ''">{{ s.codigo }}</th>
              }
              <th scope="col" class="cc-num">Diferencia</th>
              <th scope="col" class="cc-num">Venta 30 d</th>
              <th scope="col">Resultado</th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr>
              <td>
                <button type="button" class="cc-prod" (click)="abrirHistorial(f.sku)"
                        [attr.aria-label]="'Ver historial de costos de ' + (f.nombre || f.sku)">{{ f.nombre || 'Sin nombre en catálogo' }}</button>
                <div class="cc-meta"><span class="cc-mono">{{ f.sku }}</span> · {{ f.proveedor || 'sin proveedor' }}</div>
              </td>
              <td class="cc-unidad">{{ unidades(f) }}</td>
              <td class="cc-num cc-mono cc-fuerte">{{ f.mayoria === null ? '—' : dinero(f.mayoria) }}</td>
              @for (s of sucursales(); track s.codigo) {
                @if (f.porSucursal[s.codigo]; as c) {
                  <td class="cc-num cc-mono cc-celda" [class.is-fuera]="c.fuera" [class.is-sin-venta]="!c.vende"
                      [pTooltip]="tipCelda(c)" tooltipPosition="top">{{ dinero(c.costo) }}</td>
                } @else {
                  <td class="cc-num cc-vacia" pTooltip="Esta sucursal no tiene ficha con costo">—</td>
                }
              }
              <td class="cc-num cc-mono">{{ f.diferencia_pct === null ? '—' : f.diferencia_pct + ' %' }}</td>
              <td class="cc-num cc-mono">{{ f.venta_30d > 0 ? dinero(f.venta_30d) : '—' }}</td>
              <td><span class="cc-tag" [class]="'cc-tag cc-tag-' + f.veredicto">{{ etiqueta(f.veredicto) }}</span></td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td [attr.colspan]="sucursales().length + 6" class="cc-vacio">
              {{ cargando() ? 'Cargando…' : 'Ningún producto coincide con los filtros.' }}
            </td></tr>
          </ng-template>
        </p-table>
      </div>

      <footer class="cc-notas">
        <p>Se compara contra el costo que comparte la mayoría de las plazas, en la unidad base de la ficha y sin IVA.
          Kepler no guarda cuándo se editó la ficha, así que no se puede saber cuál cambió al último: por eso la referencia es la mayoría.</p>
        <p>Celda en ámbar: esa sucursal se sale de la mayoría. Celda tenue: la sucursal no vendió el producto en 30 días.
          La plaza 00 (Oficinas) no entra.</p>
        @if (datos(); as d) {
          <p>{{ n(d.resumen.una_plaza) }} productos tienen ficha con costo en una sola sucursal: no hay con qué compararlos.
            Venta de 30 días {{ d.actividad_al ? 'al ' + d.actividad_al : 'sin fecha: la ventana no se ha refrescado' }}.</p>
        }
        @if (error()) {
          <p class="cc-error" role="alert">No se pudo cargar la comparación. Intenta de nuevo en un momento.</p>
        }
      </footer>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cc { display: flex; flex-direction: column; gap: 1rem; }
    .cc-respuesta { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: 1rem 1.25rem; }
    .cc-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .cc-sub { margin: .35rem 0 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cc-chips { display: flex; flex-wrap: wrap; gap: .5rem; }
    .cc-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: 0 .75rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cc-chip:hover { background: var(--c-surface-2); }
    .cc-chip.is-sel { border-color: var(--action); background: var(--c-surface-2); font-weight: var(--fw-bold); }
    .cc-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-2); }
    .cc-tono-bad .cc-chip-n { color: var(--bad-fg); }
    .cc-tono-warn .cc-chip-n { color: var(--warn-fg); }
    .cc-tono-ok .cc-chip-n { color: var(--ok-fg); }
    .cc-filtros { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end;
      background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: .625rem .875rem; }
    .cc-f { display: flex; flex-direction: column; gap: .2rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .cc-f input { height: 2.25rem; width: 16rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .cc-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .cc-sel { min-width: 14rem; }
    .cc-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .cc-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .cc-num { text-align: right; white-space: nowrap; }
    .cc-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cc-fuerte { font-weight: var(--fw-bold); }
    .cc-prod { font-weight: var(--fw-bold); color: var(--c-text-1); background: none; border: none; padding: 0; font: inherit;
      text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: var(--c-divider); text-underline-offset: 3px; }
    .cc-prod:hover { text-decoration-color: var(--c-text-2); }
    .cc-prod:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cc-vistas { display: flex; flex-wrap: wrap; gap: .4rem; }
    .cc-vista { min-height: 2.25rem; padding: 0 .9rem; border-radius: 999px; border: 1px solid var(--c-divider);
      background: var(--c-surface-1); color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cc-vista.is-sel { background: var(--c-text-1); color: var(--c-surface-1); border-color: var(--c-text-1); font-weight: var(--fw-bold); }
    .cc-vista:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cc-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cc-unidad { font-size: var(--fs-xs); color: var(--c-text-2); }
    .cc-celda.is-fuera { background: var(--warn-soft-bg); color: var(--c-text-1); font-weight: var(--fw-bold); }
    .cc-celda.is-sin-venta { color: var(--c-text-3); }
    .cc-vacia { color: var(--c-text-3); background: var(--c-surface-2); }
    .cc-tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: var(--fs-xs);
      font-weight: var(--fw-bold); white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-2); }
    .cc-tag-distinto { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .cc-tag-sin_mayoria { background: var(--warn-soft-bg); color: var(--c-text-1); }
    .cc-tag-igual { background: var(--ok-soft-bg); color: var(--c-text-1); }
    .cc-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .cc-notas { font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .cc-notas p { margin: 0 0 .35rem; max-width: 60rem; }
    .cc-error { color: var(--bad-fg); }
  `],
})
export class ComprasCatalogoCostosComponent {
  readonly tabs = CATALOGO_TABS;
  readonly chips = CHIPS;
  private readonly api = inject(CostoEstandarService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** La vista y el producto viven en la URL: se pueden compartir y el botón Atrás funciona. */
  private readonly query = toSignal(this.route.queryParamMap);
  readonly vista = computed<'sucursales' | 'historial'>(() =>
    this.query()?.get('vista') === 'historial' ? 'historial' : 'sucursales',
  );
  readonly skuHistorial = computed(() => this.query()?.get('sku') || null);

  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly proveedor = signal<string | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly veredicto = signal<VeredictoEntreSucursales | ''>('');
  readonly soloConVenta = signal(false);

  private readonly res = rxResource({
    // En el historial esta consulta no corre: params undefined deja el recurso en reposo.
    params: () => this.vista() !== 'sucursales' ? undefined : ({
      q: this.q() || undefined,
      proveedor_id: this.proveedor() || undefined,
      sucursal: this.sucursal() || undefined,
      veredicto: this.veredicto() || undefined,
      solo_diferencias: this.veredicto() === '' ? true : undefined,
      solo_con_venta: this.soloConVenta() || undefined,
      limite: this.tamano(),
      desplazamiento: (this.pagina() - 1) * this.tamano(),
    }),
    stream: ({ params }) => this.api.entreSucursales(params),
  });

  /** `undefined` mientras carga y tras un error: nunca se pintan ceros que no se midieron. */
  readonly datos = computed(() => (this.res.error() ? undefined : this.res.value()));
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => !!this.res.error());
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly sucursales = computed(() => this.datos()?.sucursales ?? []);
  readonly filas = computed<FilaVista[]>(() =>
    (this.datos()?.filas ?? []).map((f) => ({
      ...f,
      porSucursal: Object.fromEntries(f.celdas.map((c) => [c.sucursal, c])),
    })),
  );
  readonly opcionesProveedor = computed(() =>
    (this.datos()?.proveedores ?? []).map((p) => ({ label: `${p.nombre} (${p.productos})`, value: p.id })),
  );
  readonly opcionesSucursal = computed(() =>
    this.sucursales().map((s) => ({ label: s.nombre ? `${s.codigo} · ${s.nombre}` : s.codigo, value: s.codigo })),
  );

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => {});
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  irA(vista: 'sucursales' | 'historial'): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { vista: vista === 'historial' ? 'historial' : null }, queryParamsHandling: 'merge' });
  }

  abrirHistorial(sku: string): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { vista: 'historial', sku }, queryParamsHandling: 'merge' });
  }

  onBuscar(v: string): void {
    this.busqueda = v;
    this.buscarDebounced(v);
  }
  onProveedor(v: string | null): void {
    this.proveedor.set(v);
    this.pagina.set(1);
  }
  onSucursal(v: string | null): void {
    this.sucursal.set(v);
    this.pagina.set(1);
  }
  onVeredicto(v: VeredictoEntreSucursales | ''): void {
    this.veredicto.set(v);
    this.pagina.set(1);
  }
  onSoloConVenta(v: boolean): void {
    this.soloConVenta.set(!!v);
    this.pagina.set(1);
  }

  /** «Con diferencia» suma los tres resultados que hay que revisar. */
  conteo(id: VeredictoEntreSucursales | ''): number {
    const r = this.datos()?.resumen;
    if (!r) return 0;
    return id === '' ? r.distinto + r.sin_mayoria + r.unidad_distinta : r[id];
  }

  etiqueta(v: VeredictoEntreSucursales): string {
    return ETIQUETA[v];
  }

  unidades(f: FilaEntreSucursales): string {
    return [...new Set(f.celdas.map((c) => c.unidad || 'sin rótulo'))].join(' / ');
  }

  tipCelda(c: CeldaEntreSucursales): string {
    const partes = [c.unidad || 'sin rótulo'];
    if (c.desviacion_pct !== null) partes.push(`${c.desviacion_pct > 0 ? '+' : ''}${c.desviacion_pct} % contra la mayoría`);
    if (!c.comparada) partes.push('no se comparó: sin venta en 30 días');
    else if (!c.vende) partes.push('sin venta en 30 días');
    return partes.join(' · ');
  }

  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  }

  n(v: number): string {
    return new Intl.NumberFormat('es-MX').format(v);
  }
}
