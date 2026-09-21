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
 *
 * ── [AB.3b] Los porqués: tres de siete, y las otras cuatro dichas ────────────
 * El plan del 2026-09-21 exige que cada sugerencia se explique. Se contestan **cuánto** (la resta
 * con el objetivo que publica el motor), **a quién** (`replenish_via` + origen) y **para cuándo**
 * (`next_due_date` + `lead_time_days` + días de cobertura) — los tres salían del motor desde
 * RA-PRO.9 y esta pantalla no los mostraba.
 *
 * Las cuatro que faltan **no se simulan**:
 *  · *¿Por qué mover el parámetro?* → AB.6, necesita `parameter_proposal` (propuesta con vigencia).
 *  · *¿Por qué requiere revisión?* → parcial: `rung_veredicto` declara la unidad; pedido mínimo,
 *    caducidad y excepción entran con la solicitud (AB.7).
 *  · ⛔ *¿Por qué NO propone pedir?* → **sigue sin contestarse, y es el más caro**: la mesa lista
 *    sólo lo que falta, así que un producto cubierto no aparece y *"lo revisé y está cubierto"*
 *    se lee igual que *"nunca lo miré"*. Pedirlo es un modo nuevo de la pantalla, no una columna.
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
              <!-- [AB.3b] "a quién" y "para cuándo". Reemplazan a la columna Proveedor: el
                   proveedor sigue visible dentro de Origen cuando la ruta es compra, y cuando es
                   traspaso el proveedor NO es la respuesta a "a quién le pido". -->
              <th class="ab-c-org">Origen</th>
              <th class="ab-c-cua">Entrega</th>
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
              <!-- [AB.3b] "¿por qué esa cantidad?" — la resta, con el objetivo que publicó el motor. -->
              <td class="ab-c-num ab-strong ab-why"
                  [pTooltip]="cantidadPorQue(r)" tooltipPosition="top">{{ qty(r.suggested_qty) }}</td>
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
              <td class="ab-c-org">
                <span class="ab-org {{ origenCls(r) }}"
                      [pTooltip]="origenPorQue(r)" tooltipPosition="left">{{ origenTexto(r) }}</span>
              </td>
              <td class="ab-c-cua ab-why"
                  [pTooltip]="cuandoPorQue(r)" tooltipPosition="left">{{ cuandoTexto(r) }}</td>
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

    /* [AB.3b] Origen y entrega. El subrayado punteado marca la celda que EXPLICA al pasar el
       mouse: sin esa pista el tooltip existe y nadie lo encuentra. */
    .ab-c-org { max-width: 13rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ab-c-cua { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .ab-org { display: inline-block; padding: .12rem .45rem; border-radius: 6px; font-size: .75rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .ab-o-transfer { background: var(--green-100, #e3f7e8); color: var(--green-700, #1d7a3a); font-weight: 600; }
    .ab-o-buy { background: var(--surface-100); color: var(--text-color); }
    /* Sin ruta configurada NO es compra: se ve distinto a propósito (ADR-056). */
    .ab-o-none { background: transparent; color: var(--text-color-secondary); font-style: italic; }
    .ab-why { text-decoration: underline dotted var(--surface-400, #b9b9b9); text-underline-offset: 3px; cursor: help; }

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

  // ── [AB.3b] Los porqués ────────────────────────────────────────────────────────────────────
  // El plan exige que cada sugerencia se explique. Tres de las siete preguntas se contestan con
  // datos que el motor YA devolvía y la pantalla no mostraba; las otras cuatro entran en AB.6 y
  // AB.7 y NO se simulan acá.
  //
  // ⚠️ Regla de esta sección: cuando falta el dato se dice **por qué falta**, no se rellena.
  // Un "Compra" por default sobre un par sin canal configurado sería un origen inventado.

  /**
   * Formatea una fecha `YYYY-MM-DD` **sin pasar por la zona horaria**.
   *
   * ⛔ `new Date('2026-09-25T00:00:00.000Z').toLocaleDateString('es-MX')` imprime **24 de sep**:
   * la API serializa un `date` de Postgres como medianoche UTC y el navegador lo renderiza en
   * hora de México (−06:00), o sea el día anterior. Es el mismo bug que LC.16 encontró en el
   * libro de compras, y en una fecha de entrega se leería como "llega un día antes".
   * Por eso se parsea el texto y se construye la fecha en hora LOCAL.
   */
  private fechaCorta(v: string | null): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  /** Días entre hoy y una fecha `YYYY-MM-DD`, en días de calendario locales. */
  private diasHasta(v: string | null): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
    if (!m) return null;
    const hoy = new Date();
    const a = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime();
    const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return Math.round((b - a) / 86_400_000);
  }

  /**
   * Días que aguanta la existencia a la venta medida. `null` = **sin venta medida** — que no es
   * "dura para siempre": es que no hay con qué calcularlo.
   */
  private diasDeCobertura(r: AutoabastoRow): number | null {
    const v = Number(r.avg_daily_units ?? 0);
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.floor(Number(r.on_hand ?? 0) / v);
  }

  /** ¿Por qué a ese origen? — texto de la columna. */
  origenTexto(r: AutoabastoRow): string {
    if (r.replenish_via === 'transfer') return r.source_warehouse_code ? `← ${r.source_warehouse_code}` : 'Traspaso';
    if (r.replenish_via === 'purchase') return r.supplier_name || 'Compra';
    return r.supplier_name || '—';
  }

  /** Clase del chip de origen: distingue traspaso, compra y **sin canal**. */
  origenCls(r: AutoabastoRow): string {
    if (r.replenish_via === 'transfer') return 'ab-o-transfer';
    if (r.replenish_via === 'purchase') return 'ab-o-buy';
    return 'ab-o-none';
  }

  /** ¿Por qué a ese origen? — la explicación larga, en el tooltip. */
  origenPorQue(r: AutoabastoRow): string {
    if (r.replenish_via === 'transfer') {
      const src = r.source_warehouse_code ? `el almacén ${r.source_warehouse_code}` : 'otro almacén';
      return `Traspaso: la ruta configurada para este proveedor en esta sucursal surte desde ${src}.`;
    }
    if (r.replenish_via === 'purchase') {
      return `Compra directa a ${r.supplier_name || 'su proveedor'}: es la ruta configurada para esta sucursal.`;
    }
    return 'Sin ruta configurada para este proveedor en esta sucursal. El origen no está decidido — no se supone que sea compra.';
  }

  /** ¿Por qué debo pedir hoy? — texto corto de la columna. */
  cuandoTexto(r: AutoabastoRow): string {
    const f = this.fechaCorta(r.next_due_date);
    if (f) return f;
    return r.cadence_days ? `cada ${r.cadence_days} d` : '—';
  }

  /** ¿Por qué debo pedir hoy? — la explicación larga. */
  cuandoPorQue(r: AutoabastoRow): string {
    const partes: string[] = [];
    const f = this.fechaCorta(r.next_due_date);
    const d = this.diasHasta(r.next_due_date);
    if (f) {
      partes.push(d === null ? `Próxima entrega: ${f}.`
        : d < 0 ? `La entrega del ${f} está vencida por ${-d} día(s).`
        : d === 0 ? `La entrega es HOY (${f}).`
        : `Próxima entrega: ${f}, en ${d} día(s).`);
    } else if (r.cadence_days) {
      partes.push(`El canal entrega cada ${r.cadence_days} día(s), pero no hay fecha de próxima entrega registrada.`);
    } else {
      partes.push('Sin calendario de entregas configurado para este origen.');
    }
    if (r.lead_time_days) partes.push(`Tarda ${r.lead_time_days} día(s) en llegar desde que se solicita.`);
    const cob = this.diasDeCobertura(r);
    partes.push(cob === null
      ? 'La existencia no tiene venta medida, así que no se puede estimar cuándo se agota.'
      : `Con la venta actual, la existencia alcanza ~${cob} día(s).`);
    return partes.join(' ');
  }

  /** ¿Por qué esa cantidad? — la resta, con el objetivo que publicó el motor. */
  cantidadPorQue(r: AutoabastoRow): string {
    // ⚠️ `target_qty` lo agregó AB.3b al motor. Si la API que responde es anterior, llega
    // `undefined` — y `qty()` lo imprimiría como **0**, que se leería como "el objetivo es cero"
    // en vez de "esta API no lo publica". Se dice cuál es la causa (ADR-056).
    if (r.target_qty == null || !Number.isFinite(Number(r.target_qty))) {
      return `Faltan ${this.qty(r.suggested_qty)} caja(s) para el objetivo, pero esta versión de la API ` +
        `no publica el objetivo que usó, así que la resta no se puede mostrar.`;
    }
    const base = `Objetivo ${this.qty(r.target_qty)} − existencia ${this.qty(r.on_hand)} − en camino ` +
      `${this.qty(r.in_transit)} = faltan ${this.qty(r.suggested_qty)} caja(s).`;
    if (r.transfer_in > 0 && r.buy_qty > 0) {
      return `${base} De eso, ${this.qty(r.transfer_in)} sale del sobrante de la red y ${this.qty(r.buy_qty)} hay que comprarlo.`;
    }
    if (r.transfer_in > 0) return `${base} Se cubre completo con el sobrante de otras sucursales.`;
    return base;
  }
}
