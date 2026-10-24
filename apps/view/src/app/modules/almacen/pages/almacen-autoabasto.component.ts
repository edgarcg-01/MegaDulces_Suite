import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { TagModule } from 'primeng/tag';

import {
  ESTADOS_RENGLON, ESTADO_RENGLON_LABEL,
  type AutoabastoMesaRenglon, type AutoabastoRenglonesResponse, type EstadoRenglon, type OrdenMesa, type SurteRenglon,
} from '@megadulces/contracts';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch } from '../../../shared/util/debounced-search.util';
import { makeLazyLoad, LazyTableEvent } from '../../../shared/util/lazy-table.util';

import { AutoabastoService, AutoabastoWarehouseOpt, AutoabastoRenglonesQuery } from '../autoabasto.service';
import { qty, cuandoTexto, cuandoPorQue, surteTexto, surtePorQue, faltaNetaPorQue, estadoPorQue } from '../porques.util';

/**
 * Fase AB — **Autoabasto**: la mesa del almacenista y del encargado de sucursal.
 *
 * ── [AB.28] La mesa sobre la cuenta única ────────────────────────────────────────────────────
 * Hasta AB.27 esta pantalla calculaba por su lado (`/mesa`): no restaba lo que ya viene y su
 * «Acción» elegía origen con el sobrante de TODA la red. Medido el 2026-10-23 (AB.25): de 8,534
 * renglones, 393 ya venían y se volvían a pedir y 3,264 tenían una Acción que contradecía a quién se
 * le pide. Desde AB.28 lee `GET /commercial/autoabasto/renglones`, que sale del MISMO armado que
 * «Mi pedido» (`armarRenglon` en libs/contracts): las dos pantallas no pueden dar cifras distintas.
 *
 * La pregunta que contesta, en una frase: **¿qué le falta a mi almacén que todavía nadie ha pedido?**
 * Jerarquía (DESIGN §Q.5): primario = cuántos renglones nadie ha pedido y cuánto vale lo que se pide;
 * secundario = la tabla con falta neta y estado; terciario = mínimo, reorden, máximo y entrega.
 *
 * Decisiones del PM que gobiernan esta pantalla (FASE_AB §16.6):
 *  · D2 — cada sucursal ve sólo SU mesa: un almacén a la vez; quien alcanza varios elige uno.
 *  · D3 — sale la «Acción» por sobrante de la red; en su lugar «Surte» (su matriz o el proveedor).
 *  · D4 — las rutas no entran (no tienen política ni canal).
 *
 * Sólo lee. Lo que NO hace todavía, dicho y no simulado: generar la requisición de la sucursal
 * (AB.29) y abrir «Mi pedido» en el producto (AB.28b).
 */

const POSICION: Record<string, { label: string; severity: 'danger' | 'warn' | 'info' | 'secondary' }> = {
  agotado: { label: 'Agotado', severity: 'danger' },
  bajo_minimo: { label: 'Bajo mínimo', severity: 'warn' },
  bajo_reorden: { label: 'Bajo reorden', severity: 'warn' },
  sano: { label: 'Sano', severity: 'secondary' },
  sobrestock: { label: 'Sobrestock', severity: 'info' },
};

const ESTADO_SEVERIDAD: Record<EstadoRenglon, 'danger' | 'warn' | 'success' | 'secondary'> = {
  sin_pedir: 'danger',
  compras_lo_planeo: 'warn',
  ya_viene: 'success',
  en_politica: 'secondary',
};

const SURTE_LABEL: Record<SurteRenglon['tipo'], string> = {
  matriz: 'Su matriz (traspaso)',
  proveedor: 'Proveedor (compra)',
  sin_ruta: 'Sin ruta',
};

/** Las columnas que el servidor sabe ordenar. Sin orden elegido, manda el orden de lectura. */
const ORDEN_COLUMNA: Record<string, OrdenMesa> = { sku: 'sku', falta: 'falta', falta_neta: 'falta_neta', valor: 'valor' };

@Component({
  selector: 'app-almacen-autoabasto',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, InputTextModule, TooltipModule, TagModule,
    LoadStateComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent, SucursalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="surf-page ab-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Autoabasto</h1>
          <p class="surf-page-sub">
            Qué le falta a tu almacén, qué parte ya viene en camino y a quién se le pide. Es la misma
            cuenta que «Mi pedido»: las dos pantallas dicen lo mismo de cada producto.
          </p>
        </div>
        <div class="ab-actions">
          <app-context-help topic="almacen-autoabasto" />
          <button pButton type="button" class="p-button-sm"
                  (click)="descargarPdf()" [disabled]="!almacen() || generandoPdf()"
                  [pTooltip]="almacen() ? '' : 'Elige un almacén para generar el reporte'" tooltipPosition="bottom">
            <span class="p-button-icon p-button-icon-left pi"
                  [class.pi-file-pdf]="!generandoPdf()" [class.pi-spin]="generandoPdf()"
                  [class.pi-spinner]="generandoPdf()" aria-hidden="true"></span>
            <span class="p-button-label">{{ generandoPdf() ? 'Generando…' : 'Descargar PDF' }}</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  (click)="recargar()" [disabled]="loading()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (pdfError(); as e) {
        <p class="ab-aviso" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e }}</p>
      }

      <!-- El alcance lo aplica el servidor (área Almacén): la lista ya viene recortada a los almacenes de la persona. -->
      @if (filtrosListos()) {
        @if (!warehouses().length) {
          <p class="ab-aviso" role="note">
            <i class="pi pi-lock" aria-hidden="true"></i>
            No tienes almacén asignado, así que no hay mesa que mostrar. Pide que te asignen tu almacén en tu ficha de Personas.
          </p>
        }
      } @else if (filtrosError()) {
        <p class="ab-aviso" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          No se pudo saber qué almacenes tienes a tu alcance. Vuelve a intentar con «Actualizar».
        </p>
      }

      <div class="ab-filters">
        @if (warehouses().length > 1) {
          <p-select [options]="warehouses()" optionLabel="name" optionValue="id"
                    [ngModel]="warehouseId()" (ngModelChange)="setAlmacen($event)"
                    placeholder="Elige un almacén" [filter]="warehouses().length > 6"
                    class="ab-f" ariaLabel="Almacén"></p-select>
        } @else if (almacen(); as a) {
          <span class="ab-scope"><i class="pi pi-building" aria-hidden="true"></i> {{ a.name }}</span>
        }

        <app-segmented [options]="estadoOpts()" [value]="estado() ?? 'todos'" (valueChange)="setEstado($event)"
                       ariaLabel="Estado del renglón" />

        <p-select [options]="posicionOpts" optionLabel="label" optionValue="value"
                  [ngModel]="posicion()" (ngModelChange)="setPosicion($event)"
                  placeholder="Toda posición" [showClear]="true" class="ab-f" ariaLabel="Posición"></p-select>

        <p-select [options]="surteOpts" optionLabel="label" optionValue="value"
                  [ngModel]="surte()" (ngModelChange)="setSurte($event)"
                  placeholder="A quién se le pide" [showClear]="true" class="ab-f" ariaLabel="A quién se le pide"></p-select>

        <input pInputText type="search" class="ab-search" placeholder="SKU o nombre"
               [ngModel]="searchRaw()" (ngModelChange)="onSearch($event)" aria-label="Buscar por SKU o nombre" />
      </div>

      @if (almacen()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Lo que le falta al almacén" />

        @if (resp(); as r) {
          @if (!r.pedidos_medidos) {
            <p class="ab-aviso" role="note">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              Esta sucursal no tiene cliente de traspaso en Kepler: lo ya pedido a la matriz <strong>no se pudo medir</strong>,
              así que «Ya viene» puede quedarse corto y «Falta por pedir» puede incluir algo que sí se pidió.
            </p>
          }
          @if (r.resumen.sin_valuar > 0) {
            <p class="ab-aviso" role="note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <strong>{{ r.resumen.sin_valuar }}</strong> producto(s) no entran en los importes de arriba: su costo de compra no
              coincide con su unidad, así que el dinero <strong>no se está midiendo</strong>. Las cantidades sí son válidas.
            </p>
          }
          <p class="ab-calc">Calculado el {{ r.fecha_mx }} a las {{ r.hora_mx }} (hora de México, del servidor).</p>
        }

        <app-load-state class="dt-scope" [loading]="loading()" [error]="error()" [isEmpty]="!renglones().length"
                        emptyTitle="Nada que mostrar"
                        [emptyHint]="hayFiltro() ? 'Con estos filtros no hay renglones. Quita algún filtro.' : 'A este almacén no le falta nada.'"
                        (retry)="load(true)">
          <p-table [value]="renglones()" [lazy]="true" (onLazyLoad)="onLazyLoad($event)"
                   [paginator]="true" [rows]="pageSize()" [totalRecords]="total()"
                   [rowsPerPageOptions]="[50, 100, 250]" [first]="(page() - 1) * pageSize()"
                   [scrollable]="true" scrollHeight="flex" dataKey="product_id" [customSort]="true"
                   styleClass="p-datatable-sm dt-stack surf-table surf-table--plain surf-table--sticky surf-table--frozen-first">
            <ng-template #header>
              <tr>
                <th pSortableColumn="sku" class="ab-c-sku">Producto <p-sorticon field="sku" /></th>
                <th>Posición</th>
                <th class="comm-num">Existencia</th>
                <th class="comm-num ab-c-dim">Mín</th>
                <th class="comm-num ab-c-dim">Reorden</th>
                <th class="comm-num ab-c-dim">Máx</th>
                <th pSortableColumn="falta" class="comm-num">Falta <p-sorticon field="falta" /></th>
                <th class="comm-num">Ya viene</th>
                <th pSortableColumn="falta_neta" class="comm-num">Falta neta <p-sorticon field="falta_neta" /></th>
                <th>Surte</th>
                <th>Estado</th>
                <th>Entrega</th>
              </tr>
            </ng-template>

            <ng-template #body let-r>
              <tr>
                <td class="ab-c-sku" data-label="Producto">
                  <span class="ab-sku">{{ r.sku }}</span>
                  <span class="ab-name">{{ r.nombre }}</span>
                </td>
                <td data-label="Posición">
                  <p-tag [value]="posicionDe(r.posicion).label" [severity]="posicionDe(r.posicion).severity" />
                </td>
                <td class="comm-num" data-label="Existencia">{{ qty(r.existencia) }}</td>
                <td class="comm-num ab-c-dim" data-label="Mín">{{ qty(r.diagnostico.min_stock) }}</td>
                <td class="comm-num ab-c-dim" data-label="Reorden">{{ qty(r.diagnostico.reorder_point) }}</td>
                <td class="comm-num ab-c-dim" data-label="Máx">{{ qty(r.diagnostico.max_stock) }}</td>
                <td class="comm-num" data-label="Falta">{{ qty(r.falta) }}</td>
                <td class="comm-num" data-label="Ya viene">{{ yaViene(r) > 0 ? qty(yaViene(r)) : '—' }}</td>
                <td class="comm-num is-strong ab-why" data-label="Falta neta"
                    [pTooltip]="faltaNetaPorQue(r, medidos())" tooltipPosition="top">{{ qty(r.falta_neta) }}</td>
                <td data-label="Surte">
                  <span class="ab-surte" [class.ab-surte-none]="r.surte.tipo === 'sin_ruta'"
                        [pTooltip]="surtePorQue(r.surte)" tooltipPosition="left">{{ surteTexto(r.surte) }}</span>
                </td>
                <td data-label="Estado">
                  <p-tag [value]="etiquetaEstado(r.estado)" [severity]="severidadEstado(r.estado)"
                         [pTooltip]="estadoPorQue(r)" tooltipPosition="left" />
                </td>
                <td class="ab-why" data-label="Entrega" [pTooltip]="entregaPorQue(r)" tooltipPosition="left">{{ entrega(r) }}</td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      } @else if (warehouses().length > 1) {
        <p class="ab-aviso" role="note">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Tienes <strong>{{ warehouses().length }} almacenes</strong> a tu alcance. Cada mesa es de un solo almacén: elige uno arriba.
        </p>
      }

      <p class="ab-foot">
        Cantidades en cajas. Falta neta = falta − lo que ya viene (pedido abierto a la matriz de 7 días o menos y
        embarque sin recibir). Lo que Compras planeó y todavía no está en Kepler se muestra, pero no se resta.
      </p>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ab-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .ab-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

    .ab-aviso, .ab-scope {
      display: flex; align-items: flex-start; gap: var(--sp-2); margin: 0;
      padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); line-height: 1.45;
    }
    .ab-aviso { background: var(--overlay-hover); color: var(--text-main); }
    .ab-scope { padding: 0; color: var(--text-muted); align-items: center; }
    .ab-aviso i { margin-top: var(--sp-1); }

    .ab-filters { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .ab-filters .ab-f { min-width: 12rem; }
    .ab-search { min-width: 14rem; flex: 1 1 14rem; }

    .ab-calc, .ab-foot { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }

    .ab-c-sku { min-width: 16rem; }
    .ab-sku { display: block; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-xs); color: var(--text-muted); }
    .ab-name { display: block; font-size: var(--fs-sm); color: var(--text-main); }
    .ab-c-dim { color: var(--text-muted); }

    .ab-surte { font-size: var(--fs-sm); }
    /* Sin ruta configurada NO es compra: se ve distinto a propósito (ADR-056). */
    .ab-surte-none { color: var(--text-muted); font-style: italic; }
    /* El subrayado punteado marca la celda que EXPLICA al pasar el mouse. */
    .ab-why { text-decoration: underline dotted var(--border-color); text-underline-offset: 3px; cursor: help; }
  `],
})
export class AlmacenAutoabastoComponent {
  private readonly svc = inject(AutoabastoService);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly resp = signal<AutoabastoRenglonesResponse | null>(null);
  readonly renglones = computed<AutoabastoMesaRenglon[]>(() => this.resp()?.renglones ?? []);
  readonly total = computed(() => this.resp()?.total ?? 0);
  readonly medidos = computed(() => this.resp()?.pedidos_medidos ?? true);

  readonly warehouses = signal<AutoabastoWarehouseOpt[]>([]);
  readonly filtrosListos = signal(false);
  readonly filtrosError = signal(false);
  readonly warehouseId = signal<string | null>(null);
  readonly almacen = computed<AutoabastoWarehouseOpt | null>(() => {
    const id = this.warehouseId();
    return this.warehouses().find((w) => w.id === id) ?? null;
  });

  readonly estado = signal<EstadoRenglon | null>(null);
  readonly posicion = signal<string | null>(null);
  readonly surte = signal<SurteRenglon['tipo'] | null>(null);
  readonly searchRaw = signal('');
  private readonly search = signal('');
  readonly page = signal(1);
  readonly pageSize = signal(50);
  private readonly sortBy = signal<OrdenMesa>('lectura');
  private readonly sortDir = signal<'asc' | 'desc'>('desc');

  readonly generandoPdf = signal(false);
  readonly pdfError = signal<string | null>(null);
  /** La última consulta pedida: una idéntica no se vuelve a pedir (ver `load`). */
  private ultimaConsulta: string | null = null;

  /** La fila de la tabla llega sin tipo a la plantilla: el estado pasa por aquí para indexar con tipo. */
  etiquetaEstado(e: EstadoRenglon): string { return ESTADO_RENGLON_LABEL[e] ?? e; }
  severidadEstado(e: EstadoRenglon): 'danger' | 'warn' | 'success' | 'secondary' { return ESTADO_SEVERIDAD[e] ?? 'secondary'; }
  readonly posicionOpts = Object.entries(POSICION).map(([value, p]) => ({ value, label: p.label }));
  readonly surteOpts = (Object.keys(SURTE_LABEL) as SurteRenglon['tipo'][]).map((value) => ({ value, label: SURTE_LABEL[value] }));

  /** El estado con su conteo DENTRO del control: no hay que tocar el filtro para saber si vale la pena. */
  readonly estadoOpts = computed<SegOption[]>(() => {
    const r = this.resp()?.resumen;
    return [
      { label: 'Todos', value: 'todos', count: r?.renglones },
      ...ESTADOS_RENGLON.filter((e) => e !== 'en_politica').map((e) => ({ label: ESTADO_RENGLON_LABEL[e], value: e, count: r?.por_estado[e] })),
    ];
  });

  readonly hayFiltro = computed(() => !!(this.estado() || this.posicion() || this.surte() || this.search()));

  /**
   * Primero lo que nadie ha pedido (el primario), después cuánto vale lo que se pide, por a quién.
   * Un importe que no se pudo medir viaja `null` y se dibuja «—», nunca $0 (ADR-056).
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resp()?.resumen;
    if (!r) return [];
    const dinero = (label: string, v: number | null, sub: string): MetricStripItem =>
      v == null ? { label, value: '—', format: 'text', sub: 'sin medir' } : { label, value: v, format: 'currency-short', sub };
    const items: MetricStripItem[] = [
      { label: 'Falta por pedir', value: r.por_estado.sin_pedir, tone: r.por_estado.sin_pedir > 0 ? 'bad' : 'ok', sub: 'lo que ya viene no alcanza' },
      { label: 'Compras lo planeó', value: r.por_estado.compras_lo_planeo, tone: 'warn', sub: 'aún no está en Kepler' },
      { label: 'Ya viene', value: r.por_estado.ya_viene, tone: 'ok', sub: 'pedido o en camino' },
      dinero('Se pide a la matriz', r.por_surte.matriz.valor, `${r.por_surte.matriz.a_pedir} renglones`),
      dinero('Se pide al proveedor', r.por_surte.proveedor.valor, `${r.por_surte.proveedor.a_pedir} renglones`),
    ];
    if (r.por_surte.sin_ruta.renglones > 0) {
      items.push({ label: 'Sin ruta', value: r.por_surte.sin_ruta.renglones, tone: 'warn', sub: 'no se sabe a quién pedir' });
    }
    return items;
  });

  readonly onSearch = makeDebouncedSearch((term) => { this.search.set(term.trim()); this.page.set(1); this.load(); });
  private readonly lazy = makeLazyLoad(this.page, this.pageSize, () => this.load());
  readonly onLazyLoad = (e: LazyTableEvent) => {
    const field = Array.isArray(e.sortField) ? e.sortField[0] : e.sortField;
    const orden = (field && ORDEN_COLUMNA[field]) || null;
    // Sin columna elegida manda el orden de lectura, y su dirección no se toca: la carga inicial de la
    // tabla trae `sortOrder = 1` sin campo, y cambiarla volvía distinta una consulta idéntica.
    this.sortBy.set(orden ?? 'lectura');
    this.sortDir.set(orden && e.sortOrder === 1 ? 'asc' : 'desc');
    this.lazy(e);
  };

  constructor() {
    this.cargarFiltros();
  }

  /** «Actualizar»: si no se supo el alcance, se vuelve a pedir; si ya se sabe, se recalcula la mesa. */
  recargar(): void {
    if (!this.filtrosListos()) { this.cargarFiltros(); return; }
    this.load(true);
  }

  private cargarFiltros(): void {
    this.filtrosError.set(false);
    this.svc.filtros().subscribe({
      next: (f) => {
        const ws = f.warehouses ?? [];
        this.warehouses.set(ws);
        this.filtrosListos.set(true);
        // D2: con un solo almacén a su alcance, la mesa es la de ese almacén.
        if (ws.length === 1) this.setAlmacen(ws[0].id);
      },
      // Si no se pudo saber el alcance, se dice: una lista vacía no significa «no tienes almacén».
      error: () => { this.warehouses.set([]); this.filtrosListos.set(false); this.filtrosError.set(true); },
    });
  }

  private query(): AutoabastoRenglonesQuery | null {
    const id = this.warehouseId();
    if (!id) return null;
    return {
      warehouse_id: id,
      estado: this.estado() ?? undefined,
      posicion: this.posicion() ?? undefined,
      surte: this.surte() ?? undefined,
      search: this.search() || undefined,
      sort_by: this.sortBy(),
      sort_dir: this.sortDir(),
      page: this.page(),
      pageSize: this.pageSize(),
    };
  }

  /**
   * Pide la mesa al servidor. ⚠️ Una consulta IDÉNTICA a la última no se repite (salvo `forzar`): al
   * elegir el almacén, la tabla aparece y dispara su carga perezosa con los mismos filtros, y cada
   * vuelta cuesta lo que «Mi pedido» (3.7 s). Lo cazó la prueba: se pedía dos veces.
   */
  load(forzar = false): void {
    const q = this.query();
    if (!q) return;
    const clave = JSON.stringify(q);
    if (!forzar && clave === this.ultimaConsulta) return;
    this.ultimaConsulta = clave;
    this.loading.set(true);
    this.error.set(null);
    this.svc.renglones(q).subscribe({
      next: (r) => { this.resp.set(r); this.loading.set(false); },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo cargar la mesa.');
        this.resp.set(null);
        this.loading.set(false);
      },
    });
  }

  setAlmacen(id: string | null): void { this.warehouseId.set(id); this.page.set(1); this.resp.set(null); this.load(); }
  setEstado(v: string): void { this.estado.set(v === 'todos' ? null : (v as EstadoRenglon)); this.page.set(1); this.load(); }
  setPosicion(v: string | null): void { this.posicion.set(v); this.page.set(1); this.load(); }
  setSurte(v: SurteRenglon['tipo'] | null): void { this.surte.set(v); this.page.set(1); this.load(); }

  /** Pide al servidor TODO lo del almacén con los filtros puestos y arma el PDF. */
  async descargarPdf(): Promise<void> {
    const q = this.query();
    const a = this.almacen();
    if (!q || !a || this.generandoPdf()) return;
    this.generandoPdf.set(true);
    this.pdfError.set(null);
    try {
      const rep = await firstValueFrom(this.svc.renglones({ ...q, page: undefined, pageSize: undefined, todos: 1 }));
      const filtros: string[] = [];
      const e = this.estado(); const p = this.posicion(); const s = this.surte();
      if (e) filtros.push(`Estado: ${ESTADO_RENGLON_LABEL[e]}`);
      if (p) filtros.push(`Posición: ${POSICION[p]?.label ?? p}`);
      if (s) filtros.push(`Surte: ${SURTE_LABEL[s]}`);
      if (this.search()) filtros.push(`Búsqueda: «${this.search()}»`);
      const { descargarPdfAutoabasto } = await import('../autoabasto-pdf');
      await descargarPdfAutoabasto(rep, { filtros, generadoPor: this.auth.user()?.username ?? null });
    } catch (err: unknown) {
      const msg = (err as { error?: { message?: string } })?.error?.message;
      this.pdfError.set(msg || 'No se pudo generar el reporte. Inténtalo de nuevo.');
    } finally {
      this.generandoPdf.set(false);
    }
  }

  posicionDe(b: string): { label: string; severity: 'danger' | 'warn' | 'info' | 'secondary' } {
    return POSICION[b] ?? { label: b || '—', severity: 'secondary' };
  }
  yaViene(r: AutoabastoMesaRenglon): number { return (r.ya_pedido || 0) + (r.en_camino || 0); }
  entrega(r: AutoabastoMesaRenglon): string {
    return cuandoTexto({ next_due_date: r.diagnostico.next_due_date, cadence_days: r.diagnostico.cadence_days });
  }
  entregaPorQue(r: AutoabastoMesaRenglon): string {
    return cuandoPorQue({
      next_due_date: r.diagnostico.next_due_date, cadence_days: r.diagnostico.cadence_days,
      lead_time_days: r.diagnostico.lead_time_days, on_hand: r.existencia, avg_daily_units: r.diagnostico.venta_diaria,
    });
  }

  readonly qty = qty;
  readonly surteTexto = surteTexto;
  readonly surtePorQue = surtePorQue;
  readonly faltaNetaPorQue = faltaNetaPorQue;
  readonly estadoPorQue = estadoPorQue;
}
