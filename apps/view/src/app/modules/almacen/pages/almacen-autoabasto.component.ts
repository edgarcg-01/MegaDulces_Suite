import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';

import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { makeDebouncedSearch } from '../../../shared/util/debounced-search.util';
import { makeLazyLoad, LazyTableEvent } from '../../../shared/util/lazy-table.util';

import {
  AutoabastoService, AutoabastoRow, AutoabastoResumen, AutoabastoAccion,
  AutoabastoWarehouseOpt, AutoabastoSupplierOpt, AutoabastoQuery,
} from '../autoabasto.service';

/**
 * Fase AB — **Autoabasto**: la mesa de trabajo del almacenista y del encargado de sucursal.
 *
 * ── Por qué esta pantalla existe si ya está /compras/pedido ──────────────────
 * Es la MISMA fuente (`CommercialReplenishmentService`) para OTRA audiencia. Hoy
 * `COMPRAS_PEDIDO_VER` está en `false` explícito para `almacenista` y en `true` para
 * `encargado_tienda`: la persona que hace el trabajo es justo la que no ve los números. Esta
 * pantalla se abre con llave propia (`AUTOABASTO_VER`) sin tocar nada del lado de Compras.
 *
 * ── Qué cambia respecto de la pantalla del comprador ─────────────────────────
 * El comprador entra a decidir **qué comprar**. El almacén entra a decidir **qué pedir y a
 * quién**, y la regla §5 del pedido es que sucursal-sucursal va ANTES que compra. Por eso la
 * columna que manda acá es `accion` —*traspaso* / *traspaso parcial* / *comprar*— y el KPI
 * principal separa **lo que se resuelve moviendo** de **lo que hay que desembolsar**. No es un
 * filtro de presentación sobre la lista del comprador: es el mismo dato leído por la decisión
 * que toma esta audiencia.
 *
 * ── Lo que esta pantalla NO hace todavía, dicho acá y no simulado ────────────
 *  · **No escribe.** Solicitar, autorizar y la escalera de facultades (`AUTOABASTO_SOLICITAR` /
 *    `_AUTORIZAR` / `_EXCEDER_TOPE`) entran en el PR siguiente de la fase. Las llaves ya están
 *    repartidas (migración `20260919160000`), pero **no hay acción que gatear** — y un gate sin
 *    acción es un permiso muerto (ADR-054).
 *  · **No filtra por sucursal del usuario.** `warehouse_id` es del llamador, no del token: el
 *    scope por sucursal todavía no está aplicado en el backend. Un almacenista con la clave ve
 *    la red completa si no filtra. Queda declarado en pantalla, no disimulado con un filtro de
 *    front que daría sensación de alcance sin serlo.
 *  · **El $ retenido no se dibuja en cero.** Cuando el costo de compra contradice el peldaño de
 *    unidades (U.2), el motor manda `suggested_cost: null`. La mesa lo cuenta aparte y lo dice.
 */

/** Etiqueta y tono de cada acción. El orden del mapa es el orden de lectura de la mesa. */
const ACCION_META: Record<AutoabastoAccion, { label: string; cls: string; hint: string }> = {
  traspaso:         { label: 'Traspaso',        cls: 'ab-ac-traspaso', hint: 'Se cubre entero con sobrante de otra sucursal — no hay que comprar.' },
  traspaso_parcial: { label: 'Traspaso parcial', cls: 'ab-ac-parcial',  hint: 'Una parte se cubre con sobrante de la red; el resto pasa al comprador.' },
  comprar:          { label: 'Comprar',          cls: 'ab-ac-comprar',  hint: 'No hay sobrante en la red: la solicitud va al comprador.' },
  sobrante:         { label: 'Sobrante',         cls: 'ab-ac-sobrante', hint: 'Acá sobra sobre el máximo: es candidato a salir hacia otra sucursal.' },
  ok:               { label: 'En política',      cls: 'ab-ac-ok',       hint: 'Dentro de mínimo, reorden y máximo. No hay nada que hacer.' },
};

const BUCKET_LABEL: Record<string, string> = {
  agotado: 'Agotado',
  bajo_minimo: 'Bajo mínimo',
  bajo_reorden: 'Bajo reorden',
  sano: 'Sano',
  sobrestock: 'Sobrestock',
};

@Component({
  selector: 'app-almacen-autoabasto',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, MultiSelectModule,
    InputTextModule, TooltipModule, LoadStateComponent, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ab-page">
      <header class="ab-head">
        <div>
          <h1 class="ab-title">Autoabasto</h1>
          <p class="ab-sub">
            Qué falta, cuánto pedir y a quién. El sugerido ya viene neto de lo que está en camino,
            y lo que se puede cubrir con sobrante de otra sucursal se separa de lo que hay que comprar.
          </p>
        </div>
        <button pButton type="button" class="p-button-sm p-button-outlined"
                (click)="reload()" [disabled]="loading()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
      </header>

      <!-- El alcance se declara, no se simula: hoy el backend no recorta por la sucursal del
           token, así que sin filtro la mesa es de la red completa. -->
      @if (!warehouseIds().length) {
        <p class="ab-scope" role="note">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Estás viendo la <strong>red completa</strong>. El recorte por tu sucursal todavía no lo
          aplica el servidor — elegí almacén en el filtro para trabajar sobre el tuyo.
        </p>
      }

      <app-metric-strip [items]="kpis()" ariaLabel="Indicadores de la mesa de autoabasto"></app-metric-strip>

      @if (resumen(); as r) {
        @if (r.sin_valuar_politicas > 0) {
          <p class="ab-retenido" role="note">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <strong>{{ r.sin_valuar_politicas }}</strong> políticas ({{ r.sin_valuar_skus }} SKUs) no
            entran en los importes de arriba: su costo de compra contradice el peldaño de unidades,
            así que el $ <strong>no se está midiendo</strong>. Las cantidades sí son válidas.
          </p>
        }
      }

      <div class="ab-filters">
        <p-multiselect [options]="warehouses()" optionLabel="name" optionValue="id"
                       [ngModel]="warehouseIds()" (ngModelChange)="setWarehouses($event)"
                       placeholder="Todos los almacenes" [filter]="true" [showClear]="true"
                       styleClass="ab-f" [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes">
        </p-multiselect>

        <p-select [options]="supplierOpts()" optionLabel="name" optionValue="id"
                  [ngModel]="supplierId()" (ngModelChange)="setSupplier($event)"
                  placeholder="Todos los proveedores" [filter]="true" [showClear]="true"
                  styleClass="ab-f">
        </p-select>

        <p-select [options]="accionOpts" optionLabel="label" optionValue="value"
                  [ngModel]="accion()" (ngModelChange)="setAccion($event)"
                  placeholder="Toda acción" [showClear]="true" styleClass="ab-f">
        </p-select>

        <p-select [options]="bucketOpts" optionLabel="label" optionValue="value"
                  [ngModel]="bucket()" (ngModelChange)="setBucket($event)"
                  placeholder="Toda posición" [showClear]="true" styleClass="ab-f">
        </p-select>

        <input pInputText type="search" class="ab-search" placeholder="SKU o nombre"
               [ngModel]="searchRaw()" (ngModelChange)="onSearch($event)"
               aria-label="Buscar por SKU o nombre" />
      </div>

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!rows().length"
                      emptyTitle="Nada que abastecer"
                      emptyHint="Con estos filtros no hay producto fuera de política."
                      (retry)="reload()">
        <p-table [value]="rows()" [lazy]="true" (onLazyLoad)="onLazyLoad($event)"
                 [paginator]="true" [rows]="pageSize()" [totalRecords]="total()"
                 [rowsPerPageOptions]="[50, 100, 250]" [first]="(page() - 1) * pageSize()"
                 [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm"
                 dataKey="rowKey" [customSort]="true">
          <ng-template #header>
            <tr>
              <th pSortableColumn="sku" class="ab-c-sku">SKU / Producto</th>
              <th pSortableColumn="warehouse_code" class="ab-c-wh">Almacén</th>
              <th class="ab-c-num">Existencia</th>
              <th class="ab-c-num">Mín</th>
              <th class="ab-c-num">Reorden</th>
              <th class="ab-c-num">Máx</th>
              <th class="ab-c-num">En camino</th>
              <th pSortableColumn="suggested_qty" class="ab-c-num">Falta</th>
              <th class="ab-c-num">De la red</th>
              <th class="ab-c-num">A comprar</th>
              <th class="ab-c-acc">Acción</th>
              <th pSortableColumn="supplier_name" class="ab-c-sup">Proveedor</th>
            </tr>
          </ng-template>

          <ng-template #body let-r>
            <tr>
              <td class="ab-c-sku">
                <span class="ab-sku">{{ r.sku }}</span>
                <span class="ab-name">{{ r.nombre }}</span>
              </td>
              <td class="ab-c-wh">
                <span class="ab-wh">{{ r.warehouse_code }}</span>
                <span class="ab-bucket ab-b-{{ r.bucket }}">{{ bucketLabel(r.bucket) }}</span>
              </td>
              <td class="ab-c-num">{{ qty(r.on_hand) }}</td>
              <td class="ab-c-num ab-dim">{{ qty(r.min_stock) }}</td>
              <td class="ab-c-num ab-dim">{{ qty(r.reorder_point) }}</td>
              <td class="ab-c-num ab-dim">{{ qty(r.max_stock) }}</td>
              <td class="ab-c-num">{{ r.in_transit > 0 ? qty(r.in_transit) : '—' }}</td>
              <td class="ab-c-num ab-strong">{{ qty(r.suggested_qty) }}</td>
              <!-- Lo que la empresa YA compró y está en otra sucursal. Va antes que "A comprar"
                   porque ese es el orden de decisión que pide la regla de traspaso. -->
              <td class="ab-c-num ab-transfer">{{ r.transfer_in > 0 ? qty(r.transfer_in) : '—' }}</td>
              <td class="ab-c-num ab-buy">{{ r.buy_qty > 0 ? qty(r.buy_qty) : '—' }}</td>
              <td class="ab-c-acc">
                <span class="ab-ac {{ accionMeta(r.accion).cls }}"
                      [pTooltip]="accionMeta(r.accion).hint" tooltipPosition="left">
                  {{ accionMeta(r.accion).label }}
                </span>
              </td>
              <td class="ab-c-sup">{{ r.supplier_name || '—' }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p class="ab-foot">
        Cantidades en cajas. Solicitar y autorizar llegan en la siguiente entrega de la fase — esta
        pantalla todavía sólo lee.
      </p>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ab-page { display: flex; flex-direction: column; gap: 1rem; padding: 1rem 1.15rem 1.5rem; }

    .ab-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .ab-title { margin: 0; font-size: 1.35rem; font-weight: 650; letter-spacing: -.01em; color: var(--text-color); }
    .ab-sub { margin: .3rem 0 0; max-width: 62ch; font-size: .85rem; line-height: 1.5; color: var(--text-color-secondary); }

    .ab-scope, .ab-retenido {
      display: flex; align-items: flex-start; gap: .55rem; margin: 0;
      padding: .6rem .8rem; border-radius: 8px; font-size: .82rem; line-height: 1.45;
    }
    .ab-scope { background: var(--surface-100); color: var(--text-color-secondary); }
    .ab-retenido { background: var(--yellow-50, var(--surface-100)); color: var(--text-color); }
    .ab-scope i, .ab-retenido i { margin-top: .12rem; }

    .ab-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .ab-filters ::ng-deep .ab-f { min-width: 12rem; }
    .ab-search { min-width: 14rem; flex: 1 1 14rem; }

    /* Cifras alineadas: tabular-nums para que las columnas comparen de un vistazo. */
    .ab-c-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ab-dim { color: var(--text-color-secondary); }
    .ab-strong { font-weight: 650; }
    .ab-transfer { color: var(--primary-color); }
    .ab-buy { font-weight: 600; }

    .ab-c-sku { min-width: 16rem; }
    .ab-sku { display: block; font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; color: var(--text-color-secondary); }
    .ab-name { display: block; font-size: .85rem; }

    .ab-c-wh { white-space: nowrap; }
    .ab-wh { display: block; font-weight: 600; font-size: .82rem; }
    .ab-bucket { display: inline-block; margin-top: .15rem; padding: .05rem .4rem; border-radius: 999px; font-size: .68rem; letter-spacing: .02em; }
    .ab-b-agotado { background: var(--red-100, #fee); color: var(--red-700, #a00); }
    .ab-b-bajo_minimo { background: var(--orange-100, #fef0e0); color: var(--orange-700, #a65300); }
    .ab-b-bajo_reorden { background: var(--yellow-100, #fdf5d8); color: var(--yellow-800, #8a6d00); }
    .ab-b-sano { background: var(--surface-100); color: var(--text-color-secondary); }
    .ab-b-sobrestock { background: var(--blue-100, #e3f0ff); color: var(--blue-700, #0b5fb0); }

    .ab-c-acc { white-space: nowrap; }
    .ab-ac { display: inline-block; padding: .12rem .5rem; border-radius: 6px; font-size: .75rem; font-weight: 600; }
    .ab-ac-traspaso { background: var(--green-100, #e3f7e8); color: var(--green-700, #1d7a3a); }
    .ab-ac-parcial { background: var(--teal-100, #ddf3f1); color: var(--teal-700, #0f6f68); }
    .ab-ac-comprar { background: var(--orange-100, #fef0e0); color: var(--orange-700, #a65300); }
    .ab-ac-sobrante { background: var(--blue-100, #e3f0ff); color: var(--blue-700, #0b5fb0); }
    .ab-ac-ok { background: var(--surface-100); color: var(--text-color-secondary); }

    .ab-c-sup { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ab-foot { margin: 0; font-size: .78rem; color: var(--text-color-secondary); }

    @media (max-width: 900px) {
      .ab-filters ::ng-deep .ab-f, .ab-search { min-width: 100%; }
    }
  `],
})
export class AlmacenAutoabastoComponent {
  private readonly svc = inject(AutoabastoService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly rows = signal<AutoabastoRow[]>([]);
  readonly total = signal(0);
  readonly resumen = signal<AutoabastoResumen | null>(null);

  readonly warehouses = signal<AutoabastoWarehouseOpt[]>([]);
  readonly suppliers = signal<AutoabastoSupplierOpt[]>([]);
  /** El `showClear` del p-select ya cubre el "todos": no se agrega una opción falsa a la lista. */
  readonly supplierOpts = computed(() => this.suppliers());

  readonly warehouseIds = signal<string[]>([]);
  readonly supplierId = signal<string | null>(null);
  readonly accion = signal<AutoabastoAccion | null>(null);
  readonly bucket = signal<string | null>(null);
  readonly searchRaw = signal('');
  private readonly search = signal('');

  readonly page = signal(1);
  readonly pageSize = signal(50);
  private readonly sortBy = signal<string | null>(null);
  private readonly sortDir = signal<'asc' | 'desc'>('desc');

  readonly accionOpts = (Object.keys(ACCION_META) as AutoabastoAccion[])
    .map((value) => ({ value, label: ACCION_META[value].label }));
  readonly bucketOpts = Object.entries(BUCKET_LABEL).map(([value, label]) => ({ value, label }));

  readonly onSearch = makeDebouncedSearch((term) => {
    this.search.set(term.trim());
    this.page.set(1);
    this.load();
  });

  readonly onLazyLoad = (e: LazyTableEvent) => {
    const field = Array.isArray(e.sortField) ? e.sortField[0] : e.sortField;
    if (field) {
      this.sortBy.set(field);
      this.sortDir.set(e.sortOrder === 1 ? 'asc' : 'desc');
    }
    this.lazy(e);
  };
  private readonly lazy = makeLazyLoad(this.page, this.pageSize, () => this.load());

  constructor() {
    this.svc.filtros().subscribe({
      next: (f) => {
        this.warehouses.set(f.warehouses ?? []);
        this.suppliers.set(f.suppliers ?? []);
      },
      // Los filtros son un accesorio: si fallan, la mesa igual se puede leer sin recortar.
      error: () => { this.warehouses.set([]); this.suppliers.set([]); },
    });
    this.load();
  }

  /**
   * Los KPIs leen la decisión, no el inventario: primero **cuánto se resuelve moviendo** lo que
   * la empresa ya compró, después **cuánto hay que desembolsar**. Un importe que el motor no
   * pudo medir viaja como `null` y acá se dibuja `—`, nunca `$0` (ADR-056).
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resumen();
    if (!r) return [];
    // `null` = el motor no pudo medir ese importe. Se manda como TEXTO ('—'): la rama numérica
    // del strip haría `Number('—') || 0` y pintaría un **0** que nadie midió.
    const dinero = (label: string, v: number | null, tone: MetricStripItem['tone'], sub: string): MetricStripItem =>
      v == null
        ? { label, value: '—', format: 'text', tone, sub: 'sin medir' }
        : { label, value: v, format: 'currency-short', tone, sub };
    return [
      { label: 'Agotado',      value: r.agotado,      tone: 'bad',  sub: 'sin existencia' },
      { label: 'Bajo mínimo',  value: r.bajo_minimo,  tone: 'warn', sub: 'por debajo del piso' },
      { label: 'Bajo reorden', value: r.bajo_reorden, tone: 'warn', sub: 'toca pedir' },
      { label: 'Sobrestock',   value: r.sobrestock,   tone: 'brand', sub: 'candidato a salir' },
      dinero('Se cubre con la red', r.traspasable_valor, 'ok', 'traspaso, no compra'),
      dinero('Hay que comprar', r.compra_real_valor, 'default', 'residual real'),
    ];
  });

  private query(): AutoabastoQuery {
    return {
      warehouse_ids: this.warehouseIds().length ? this.warehouseIds().join(',') : undefined,
      supplier_id: this.supplierId() ?? undefined,
      bucket: this.bucket() ?? undefined,
      search: this.search() || undefined,
      sort_by: this.sortBy() ?? undefined,
      sort_dir: this.sortBy() ? this.sortDir() : undefined,
      page: this.page(),
      pageSize: this.pageSize(),
    };
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const q = this.query();

    this.svc.mesa(q).subscribe({
      next: (res) => {
        // `accion` la resuelve el motor por fila y el endpoint todavía no la acepta como filtro:
        // se recorta acá y se dice en el total, en vez de inventar un parámetro que el backend
        // ignoraría en silencio.
        const a = this.accion();
        const rows = a ? (res.rows ?? []).filter((r) => r.accion === a) : (res.rows ?? []);
        this.rows.set(rows);
        this.total.set(a ? rows.length : res.total ?? 0);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo cargar la mesa.');
        this.rows.set([]);
        this.total.set(0);
        this.loading.set(false);
      },
    });

    this.svc.resumen(q).subscribe({
      next: (r) => this.resumen.set(r),
      // El resumen es complementario: si falla, la mesa no se bloquea — pero tampoco se
      // inventan KPIs en cero.
      error: () => this.resumen.set(null),
    });
  }

  reload(): void { this.load(); }

  setWarehouses(ids: string[]): void { this.warehouseIds.set(ids ?? []); this.page.set(1); this.load(); }
  setSupplier(id: string | null): void { this.supplierId.set(id); this.page.set(1); this.load(); }
  setAccion(a: AutoabastoAccion | null): void { this.accion.set(a); this.page.set(1); this.load(); }
  setBucket(b: string | null): void { this.bucket.set(b); this.page.set(1); this.load(); }

  accionMeta(a: AutoabastoAccion) { return ACCION_META[a] ?? ACCION_META.ok; }
  bucketLabel(b: string): string { return BUCKET_LABEL[b] ?? b; }

  /** Cajas con hasta 1 decimal, sin arrastrar el `.0` cuando es entero. */
  qty(v: number | null | undefined): string {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('es-MX', { maximumFractionDigits: 1 });
  }
}
