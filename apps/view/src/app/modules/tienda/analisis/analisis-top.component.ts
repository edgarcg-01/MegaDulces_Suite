import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { TopFacet } from '../weekly.service';
import { AnalisisStateService } from './analisis-state.service';
import { AnalisisCascadaComponent } from './analisis-cascada.component';

/**
 * `[TDA.A3]` Sección **Productos TOP** de `/tienda/analisis-semanal`.
 *
 * La otra mitad de «Proveedores y productos»: ahí la pregunta es *cómo viene cada
 * proveedor*; acá es *qué productos no puedo perder de vista*. Se separaron porque la
 * segunda vivía al pie de la primera y nadie llegaba.
 *
 * **Lo que la hace distinta es el ACUMULADO.** Una lista de 5,744 productos ordenada por
 * venta no es una decisión; la misma lista con la columna de acumulado sí, porque dice
 * dónde cortar. Medido en prod (12 meses de tienda): **249 productos hacen el 50 % de la
 * venta y 1,012 el 80 %** — o sea que 4,732 renglones, el 82 % del catálogo vendido, pesan
 * juntos una quinta parte. Por eso la vista abre en el corte de Pareto y no en la lista
 * completa.
 *
 * **Las tres etiquetas del ERP.** El negocio mostró la ficha de Kepler del SKU 70001 y se
 * decodificaron con ese SKU como sonda: Línea = el proveedor (`catalog.suppliers`), Tipo =
 * `kdii.c4` → `kdie`, Grupo = `kdii.c5` → `kdif`, los dos últimos vía la vista
 * `analytics.v_product_taxonomy`.
 *
 * ⚠️ **Tipo y Grupo NO son jerarquía** — 86 de 241 grupos aparecen bajo más de un tipo —
 * así que son dos filtros independientes y nunca un árbol «tipo → sus grupos».
 *
 * ⚠️ **Los filtros van al SERVIDOR, incluido el buscador.** Si filtrara en memoria, el
 * acumulado de la pantalla sería el de las filas visibles y no el del universo: el mismo
 * número con otro significado, que es la peor clase de error porque no se ve.
 *
 * OJO: acá adentro NO van acentos graves (template literal de JS).
 */
@Component({
  selector: 'app-tienda-analisis-top',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule,
    SelectButtonModule, TableModule, TooltipModule, AnalisisCascadaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (st.topError()) {
      <div class="tp-banner">
        <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los productos.
        <button pButton type="button" class="p-button-text p-button-sm" (click)="st.loadTop()">
          <span class="p-button-label">Reintentar</span>
        </button>
      </div>
    } @else if (st.topRep(); as rep) {
      <div class="card-premium card-flat tp-panel">
        <div class="tp-head">
          <div>
            <h3 class="tp-title">Productos TOP</h3>
            <!--
              El encabezado es la lectura de Pareto, no un adorno: dice contra qué universo
              se acumula y cuántos productos hay que no perder de vista. Sin el universo,
              «80%» no se puede interpretar.
            -->
            <p class="tp-sub">
              @if (rep.pareto.para_80) {
                <strong>{{ rep.pareto.para_80 | number }}</strong> de
                {{ rep.universo.productos | number }} productos hacen el <strong>80%</strong> de
                {{ money(rep.universo.venta) }}@if (rep.pareto.para_50) {; {{ rep.pareto.para_50 | number }} hacen la mitad}.
              } @else {
                {{ rep.universo.productos | number }} productos, {{ money(rep.universo.venta) }} de venta.
              }
            </p>
          </div>
          <p-selectbutton [options]="modeOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                          [ngModel]="st.topMode()" (ngModelChange)="st.changeTopFiltro({ mode: $event })"
                          styleClass="sb-liquid sb-liquid-sm" ariaLabel="Cuántos productos mostrar" />
        </div>

        <div class="tp-filtros">
          <label class="tp-ctl">
            <span class="tp-ctl-lbl">Tipo</span>
            <p-select [options]="tipoOpts()" optionLabel="label" optionValue="value" [filter]="true" filterBy="label"
                      [ngModel]="st.topTipo()" (ngModelChange)="st.changeTopFiltro({ tipo: $event })"
                      styleClass="sel-liquid tp-select" appendTo="body" />
          </label>
          <label class="tp-ctl">
            <span class="tp-ctl-lbl">Grupo</span>
            <p-select [options]="grupoOpts()" optionLabel="label" optionValue="value" [filter]="true" filterBy="label"
                      [ngModel]="st.topGrupo()" (ngModelChange)="st.changeTopFiltro({ grupo: $event })"
                      styleClass="sel-liquid tp-select" appendTo="body" />
          </label>
          <label class="tp-ctl">
            <span class="tp-ctl-lbl">Línea</span>
            <p-select [options]="lineaOpts()" optionLabel="label" optionValue="value" [filter]="true" filterBy="label"
                      [ngModel]="st.topLinea()" (ngModelChange)="st.changeTopFiltro({ linea: $event })"
                      styleClass="sel-liquid tp-select" appendTo="body" />
          </label>
          <label class="tp-ctl tp-ctl-grow">
            <span class="tp-ctl-lbl">Buscar</span>
            <input pInputText type="search" [ngModel]="texto()" (ngModelChange)="onTexto($event)"
                   placeholder="Nombre o SKU" aria-label="Buscar producto por nombre o SKU" />
          </label>
          @if (hayFiltro()) {
            <button pButton type="button" class="p-button-text p-button-sm tp-limpiar" (click)="limpiar()">
              <span class="p-button-label">Limpiar filtros</span>
            </button>
          }
        </div>

        <p-table [value]="rep.rows" styleClass="p-datatable-sm tp-table" [rowHover]="true"
                 [scrollable]="true" scrollHeight="600px"
                 [paginator]="rep.rows.length > 60" [rows]="60" [rowsPerPageOptions]="[60, 150, 300]"
                 currentPageReportTemplate="{first}–{last} de {totalRecords}"
                 [showCurrentPageReport]="true">
          <ng-template #header>
            <tr>
              <th class="tp-r tp-th-rk">#</th>
              <th class="tp-sticky">Producto</th>
              <th>Línea</th>
              <th>Tipo</th>
              <th>Grupo</th>
              <th class="tp-r">Venta</th>
              <th class="tp-r" pTooltip="Contra el período anterior del mismo tamaño." tooltipPosition="bottom">Δ%</th>
              <th class="tp-r">Part.</th>
              <th class="tp-r" pTooltip="Participación acumulada hasta esta fila. Es la lectura de Pareto: dónde cortar." tooltipPosition="bottom">Acum.</th>
              <th class="tp-r">Margen</th>
              <th class="tp-r">Mg%</th>
              <th class="tp-r">Unidades</th>
              <th class="tp-r" pTooltip="Venta ÷ unidades. Misma fuente, no cruza con el POS." tooltipPosition="bottom">$/unidad</th>
              <th class="tp-r" pTooltip="Días del período en que este producto vendió. Dos productos con la misma venta, uno todos los días y el otro en un pico, no se reponen igual." tooltipPosition="bottom">Días</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <!-- La franja marca dónde se cruza el 80%: es la línea que el negocio pidió no
                 perder de vista, y se ve sin tener que leer la columna número por número. -->
            <tr class="tp-row" [class.tp-sel]="st.productoSel() === p.product_id"
                [class.tp-fuera80]="(p.cum_pct ?? 0) > 80"
                [attr.aria-selected]="st.productoSel() === p.product_id"
                (click)="st.changeProducto(p.product_id)" (keydown.enter)="st.changeProducto(p.product_id)" tabindex="0">
              <td class="tp-r tp-muted">{{ p.rank }}</td>
              <td class="tp-sticky"><span class="tp-prod">{{ p.nombre }}</span><span class="tp-sku">{{ p.sku }}</span></td>
              <td class="tp-tax" [title]="p.linea || ''">{{ p.linea || '—' }}</td>
              <td class="tp-tax">{{ p.tipo || '—' }}</td>
              <td class="tp-tax" [title]="p.grupo || ''">{{ p.grupo || '—' }}</td>
              <td class="tp-r strong">{{ money(p.revenue) }}</td>
              <td class="tp-r"><span [ngClass]="deltaCls(p.delta_pct)">{{ deltaTxt(p.delta_pct) }}</span></td>
              <td class="tp-r tp-muted">{{ p.share_pct == null ? '—' : (p.share_pct | number: '1.2-2') + '%' }}</td>
              <td class="tp-r tp-acum">{{ p.cum_pct == null ? '—' : (p.cum_pct | number: '1.1-1') + '%' }}</td>
              <td class="tp-r tp-muted">{{ money(p.margin) }}</td>
              <td class="tp-r">{{ p.margin_pct == null ? '—' : (p.margin_pct | number: '1.1-1') + '%' }}</td>
              <td class="tp-r">{{ num(p.units) }}</td>
              <td class="tp-r">{{ p.avg_unit == null ? '—' : money2(p.avg_unit) }}</td>
              <td class="tp-r tp-muted">{{ p.sale_days }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr>
              <td colspan="14" class="tp-empty">
                @if (hayFiltro()) {
                  Ningún producto cumple los filtros entre
                  {{ rep.period.from | date: 'dd/MM/yy' }} y {{ rep.period.to | date: 'dd/MM/yy' }}.
                } @else {
                  Ninguna sucursal de tu alcance registra venta de productos en el período elegido.
                }
              </td>
            </tr>
          </ng-template>
        </p-table>

        <p class="tp-note tp-muted">
          «Part.» y «Acum.» se calculan sobre el universo <strong>filtrado completo</strong>
          ({{ rep.universo.productos | number }} productos), no sobre lo que está a la vista.
          @if (rep.mode === 'pareto' && rep.pareto.para_80 && rep.universo.productos > rep.mostrados) {
            Se muestran los <strong>{{ rep.mostrados | number }}</strong> que llegan al 80%;
            «Todos» trae el resto.
          }
          @if (rep.topado) { Topado en 1,500 filas. }
          Tipo y Grupo salen del ERP y <strong>no son jerarquía</strong>: 86 de 241 grupos aparecen
          bajo más de un tipo, por eso son dos filtros y no un árbol. «NO APLICA» es un valor real
          del catálogo, no un dato faltante: pesa el 14% de la venta.
          El margen usa el costo del fact (ADR-051): sirve para ordenar, no para cerrar.
        </p>
      </div>
    } @else {
      <div class="tp-loading">Cargando productos…</div>
    }

    <!-- La cascada, acotada al producto elegido si hay uno. -->
    <app-analisis-cascada />
  `,
  styles: [
    `
      :host { display: block; }
      .tp-panel { padding: 1rem; margin-bottom: 1rem; }
      .tp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
      .tp-title { margin: 0; font-size: .85rem; font-weight: 700; }
      .tp-sub { margin: .2rem 0 0; font-size: .78rem; color: var(--text-muted); max-width: 70ch; }
      .tp-filtros { display: flex; align-items: flex-end; gap: .75rem; flex-wrap: wrap; margin-bottom: .8rem; }
      .tp-ctl { display: inline-flex; flex-direction: column; gap: .2rem; }
      .tp-ctl-grow { flex: 1 1 14rem; }
      .tp-ctl-lbl { font-size: .68rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
      .tp-select { min-width: 13rem; }
      .tp-ctl-grow input { width: 100%; }
      .tp-limpiar { align-self: flex-end; }

      .tp-table { font-variant-numeric: tabular-nums; font-size: var(--fs-sm, .8125rem); }
      .tp-r { text-align: right; white-space: nowrap; }
      .tp-th-rk { width: 3rem; }
      .strong { font-weight: 700; } .tp-muted { color: var(--text-muted); }
      /* La tabla es ancha (14 columnas): el nombre del producto se congela, si no a la
         altura de «Días» ya no sabés de qué producto es la fila. */
      .tp-sticky { position: sticky; left: 0; z-index: 2; background: var(--card-bg); min-width: 15rem; }
      th.tp-sticky { z-index: 3; }
      .tp-prod { display: block; font-weight: 500; }
      .tp-sku { display: block; font-size: .7rem; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
      .tp-tax { font-size: var(--fs-xs, .75rem); color: var(--text-muted); max-width: 11rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tp-acum { font-weight: 600; }
      /* Fuera del 80%: se atenúa en vez de esconderse — sigue estando, pero deja de competir
         por la atención con lo que sí hay que mirar. */
      .tp-fuera80 .tp-acum, .tp-fuera80 td { opacity: .62; }
      .tp-row { cursor: pointer; }
      .tp-row:focus-visible { outline: 2px solid var(--action-ring, var(--action)); outline-offset: -2px; }
      .tp-sel > td { background: color-mix(in srgb, var(--action) 9%, transparent) !important; opacity: 1; }
      .tp-sel .tp-prod { font-weight: 700; }

      .tp-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg) 8%, transparent);
                   border: 1px solid color-mix(in srgb, var(--bad-fg) 30%, transparent); border-radius: var(--r-md);
                   padding: .7rem .9rem; font-size: .82rem; margin-bottom: 1rem; }
      .tp-loading, .tp-empty { padding: 2rem; text-align: center; color: var(--text-muted); font-size: .85rem; }
      .tp-note { font-size: .72rem; margin: .7rem 0 0; }
      .up { color: var(--ok-fg); } .down { color: var(--bad-fg); } .flat { color: var(--text-muted); }
      @media (max-width: 48rem) { .tp-select, .tp-ctl { min-width: 100%; width: 100%; } }
    `,
  ],
})
export class TiendaAnalisisTopComponent implements OnInit, OnDestroy {
  protected readonly st = inject(AnalisisStateService);

  /** Espejo local del buscador: el que va al servidor se manda con retardo. */
  readonly texto = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly modeOptions = [
    { label: 'Hasta el 80%', value: 'pareto' as const },
    { label: 'Todos', value: 'all' as const },
  ];

  ngOnInit(): void {
    this.texto.set(this.st.topQ());
    // Esta pestaña se recorta por PRODUCTO; la línea elegida en la pestaña anterior no
    // manda acá (comparten una sola cascada).
    this.st.limpiarAlcanceSalvo('producto');
    this.st.need('top', 'breakdown');
  }
  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** El texto pega al servidor (el acumulado depende de él), así que se espera a que pare de escribir. */
  onTexto(v: string): void {
    this.texto.set(v);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.st.changeTopFiltro({ q: v }), 350);
  }

  limpiar(): void {
    this.texto.set('');
    this.st.changeTopFiltro({ tipo: '', grupo: '', linea: '', q: '' });
  }

  readonly hayFiltro = computed(
    () => !!(this.st.topTipo() || this.st.topGrupo() || this.st.topLinea() || this.st.topQ()),
  );

  /**
   * Cada opción lleva su venta: elegir un filtro a ciegas entre 231 grupos es adivinar, y
   * con el peso al lado se elige el que importa.
   */
  private opts(fs: TopFacet[], todos: string) {
    return [
      { label: todos, value: '' },
      ...fs.map((f) => ({ label: `${f.name} · ${this.money(f.revenue)}`, value: f.code })),
    ];
  }
  readonly tipoOpts = computed(() => this.opts(this.st.topRep()?.facets.tipos ?? [], 'Todos los tipos'));
  readonly grupoOpts = computed(() => this.opts(this.st.topRep()?.facets.grupos ?? [], 'Todos los grupos'));
  readonly lineaOpts = computed(() => this.opts(this.st.topRep()?.facets.lineas ?? [], 'Todas las líneas'));

  deltaCls(p: number | null): string { return p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat'; }
  deltaTxt(p: number | null): string { return p == null ? '—' : (p > 0 ? '▲ +' : p < 0 ? '▼ ' : '') + p + '%'; }
  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  money2(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  num(v: number): string { return Math.round(v || 0).toLocaleString('es-MX'); }
}
