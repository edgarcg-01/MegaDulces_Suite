import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { SIN_LINEA } from '../weekly.service';
import { AnalisisStateService } from './analisis-state.service';
import { AnalisisCascadaComponent } from './analisis-cascada.component';

/**
 * `[TDA.A2]` Sección **Productos y proveedores** de `/tienda/analisis-semanal`.
 *
 * LÍNEA → PRODUCTO, maestro-detalle. «Línea» es como el negocio llama al proveedor al que
 * pertenece un producto, y vive en el catálogo (`catalog.products.supplier_id`); no hay
 * un campo `linea` aparte — se buscó y no existe.
 *
 * **Por qué la línea del catálogo y no «quién entregó», medido (2026-09-20, 12 meses de
 * tienda sin ruta):** la línea del catálogo cubre el **100.0 %** de la venta, es **1:1**
 * (9,541 SKUs con una línea, 2 con dos) y coincide con Kepler en **99.77 %**. La
 * alternativa —atribuir por las recepciones— se descartó con número: el **94.8 %** de la
 * venta viene de SKUs recibidos de más de un proveedor real, y en la misma ventana se
 * compró $521M contra $94M vendidos a costo, porque el CEDIS surte a toda la red. No son
 * el mismo universo, y una venta no sabe de qué entrega salió.
 *
 * Al elegir una línea, la cascada de abajo se acota a ella: ésa es la evolución histórica
 * de la línea, y es el mismo componente que usa Tráfico.
 *
 * OJO: acá adentro NO van acentos graves (template literal de JS).
 */
@Component({
  selector: 'app-tienda-analisis-productos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TableModule, TooltipModule, AnalisisCascadaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- ───────────────────────── MAESTRO: las líneas ───────────────────────── -->
    @if (st.suppliersError()) {
      <div class="pr-banner">
        <i class="pi pi-exclamation-triangle"></i> No se pudo cargar la venta por línea.
        <button pButton type="button" class="p-button-text p-button-sm" (click)="st.loadSuppliers()">
          <span class="p-button-label">Reintentar</span>
        </button>
      </div>
    } @else if (st.suppliersRep(); as rep) {
      <div class="card-premium card-flat pr-panel">
        <div class="pr-head">
          <div>
            <h3 class="pr-title">Venta por línea</h3>
            <p class="pr-sub">
              La línea es el proveedor al que pertenece el producto en el catálogo.
              @if (rep.concentracion.para_50) {
                <strong>{{ rep.concentracion.para_50 }}</strong> de {{ rep.concentracion.lineas }} líneas
                explican la mitad de la venta@if (rep.concentracion.para_80) {, y {{ rep.concentracion.para_80 }} el 80%}.
              }
              Elige una para ver sus productos y su evolución.
            </p>
          </div>
          <span class="pr-search">
            <input pInputText type="search" [ngModel]="qL()" (ngModelChange)="qL.set($event)"
                   placeholder="Buscar línea" aria-label="Buscar línea" />
          </span>
        </div>

        <p-table [value]="lineasFiltradas()" styleClass="p-datatable-sm pr-table" [rowHover]="true"
                 [scrollable]="true" scrollHeight="420px" dataKey="code">
          <ng-template #header>
            <tr>
              <th>Línea</th>
              <th class="ta-r">Venta</th>
              <th class="ta-r" pTooltip="Contra el período anterior del mismo tamaño." tooltipPosition="bottom">Δ%</th>
              <th class="ta-r">Part.</th>
              <th class="ta-r">Margen</th>
              <th class="ta-r">Mg%</th>
              <th class="ta-r">Unidades</th>
              <th class="ta-r" pTooltip="SKUs de la línea CON VENTA en el período, no los que tiene en el catálogo." tooltipPosition="bottom">SKUs</th>
            </tr>
          </ng-template>
          <ng-template #body let-l>
            <tr class="pr-linea" [class.pr-sel]="st.lineaSel() === l.code"
                [attr.aria-selected]="st.lineaSel() === l.code"
                (click)="st.changeLinea(l.code)" (keydown.enter)="st.changeLinea(l.code)" tabindex="0">
              <td>
                <span class="pr-linea-nom">{{ l.name }}</span>
                @if (l.code !== sinLinea) { <span class="pr-linea-cod">{{ l.code }}</span> }
              </td>
              <td class="ta-r strong">{{ money(l.revenue) }}</td>
              <td class="ta-r"><span [ngClass]="deltaCls(l.delta_pct)">{{ deltaTxt(l.delta_pct) }}</span></td>
              <td class="ta-r pr-muted">{{ l.share_pct == null ? '—' : (l.share_pct | number: '1.1-1') + '%' }}</td>
              <td class="ta-r pr-muted">{{ money(l.margin) }}</td>
              <td class="ta-r">{{ l.margin_pct == null ? '—' : (l.margin_pct | number: '1.1-1') + '%' }}</td>
              <td class="ta-r">{{ num(l.units) }}</td>
              <td class="ta-r pr-muted">{{ num(l.skus) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr>
              <td colspan="8" class="pr-empty">
                @if (qL()) { Ninguna línea coincide con «{{ qL() }}». }
                @else { Ninguna sucursal de tu alcance registra venta en el período elegido. }
              </td>
            </tr>
          </ng-template>
        </p-table>

        <p class="pr-note pr-muted">
          La línea sale del catálogo y <strong>es un atributo de hoy: no tiene historia</strong>. Si mañana
          le cambian la línea a un producto, su venta pasada se re-atribuye sola. El margen usa el costo del
          fact, que en la mitad Kepler viene derivado del markup configurado y no del costo pagado (ADR-051):
          sirve para ordenar y mirar tendencia, no para cerrar.
        </p>
      </div>
    } @else {
      <div class="pr-loading">Cargando las líneas…</div>
    }

    <!-- ───────────────── DETALLE: los productos de la línea elegida ───────────────── -->
    @if (st.lineaSel()) {
      <div class="card-premium card-flat pr-panel">
        <div class="pr-head">
          <div>
            <h3 class="pr-title">
              Productos de {{ st.lineaProductos()?.supplier?.name || 'la línea' }}
            </h3>
            <p class="pr-sub">
              «Part.» es lo que cada producto pesa <strong>dentro de su línea</strong>, no dentro de la tienda:
              es la pregunta que se hace al abrir una línea.
            </p>
          </div>
          <div class="pr-head-acciones">
            <span class="pr-search">
              <input pInputText type="search" [ngModel]="qP()" (ngModelChange)="qP.set($event)"
                     placeholder="Buscar producto o SKU" aria-label="Buscar producto de la línea" />
            </span>
            <button pButton type="button" class="p-button-text p-button-sm" (click)="st.changeLinea(st.lineaSel())">
              <span class="p-button-label">Ver todas las líneas</span>
            </button>
          </div>
        </div>

        @if (st.lineaProductosError()) {
          <div class="pr-banner">
            <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los productos de la línea.
            <button pButton type="button" class="p-button-text p-button-sm" (click)="st.loadLineaProductos()">
              <span class="p-button-label">Reintentar</span>
            </button>
          </div>
        } @else if (st.lineaProductos(); as det) {
          <p-table [value]="productosFiltrados()" styleClass="p-datatable-sm pr-table" [rowHover]="true"
                   [scrollable]="true" scrollHeight="480px">
            <ng-template #header>
              <tr>
                <th>Producto</th>
                <th>Marca</th>
                <th class="ta-r">Venta</th>
                <th class="ta-r">Δ%</th>
                <th class="ta-r">Part. línea</th>
                <th class="ta-r">Margen</th>
                <th class="ta-r">Mg%</th>
                <th class="ta-r">Unidades</th>
              </tr>
            </ng-template>
            <ng-template #body let-p>
              <tr>
                <td><span class="pr-prod">{{ p.nombre }}</span><span class="pr-sku">{{ p.sku }}</span></td>
                <td class="pr-muted">{{ p.brand || '—' }}</td>
                <td class="ta-r strong">{{ money(p.revenue) }}</td>
                <td class="ta-r"><span [ngClass]="deltaCls(p.delta_pct)">{{ deltaTxt(p.delta_pct) }}</span></td>
                <td class="ta-r pr-muted">{{ p.share_pct == null ? '—' : (p.share_pct | number: '1.1-1') + '%' }}</td>
                <td class="ta-r pr-muted">{{ money(p.margin) }}</td>
                <td class="ta-r">{{ p.margin_pct == null ? '—' : (p.margin_pct | number: '1.1-1') + '%' }}</td>
                <td class="ta-r">{{ num(p.units) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr>
                <td colspan="8" class="pr-empty">
                  @if (qP()) { Ningún producto de esta línea coincide con «{{ qP() }}». }
                  @else { Esta línea no registra venta entre {{ det.period.from | date: 'dd/MM/yy' }} y {{ det.period.to | date: 'dd/MM/yy' }}. }
                </td>
              </tr>
            </ng-template>
          </p-table>
          @if (det.rows.length >= 300) {
            <p class="pr-note pr-muted">Se muestran los 300 productos de más venta de la línea.</p>
          }
        } @else {
          <div class="pr-loading">Cargando los productos de la línea…</div>
        }
      </div>
    }

    <!-- ───────── EVOLUCIÓN: la misma cascada, acotada a la línea si hay una ───────── -->
    <app-analisis-cascada />
  `,
  styles: [
    `
      :host { display: block; }
      .pr-panel { padding: 1rem; margin-bottom: 1rem; }
      .pr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
      .pr-head-acciones { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
      .pr-title { margin: 0; font-size: .85rem; font-weight: 700; }
      .pr-sub { margin: .2rem 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 66ch; }
      .pr-search input { min-width: 15rem; }
      .pr-table { font-variant-numeric: tabular-nums; }
      /* La fila del maestro es un control: tiene que verse que se puede elegir, y la
         elegida tiene que quedar marcada cuando el ojo baja al detalle. */
      .pr-linea { cursor: pointer; }
      .pr-linea:focus-visible { outline: 2px solid var(--action-ring, var(--action)); outline-offset: -2px; }
      .pr-sel > td { background: color-mix(in srgb, var(--action) 9%, transparent) !important; }
      .pr-sel .pr-linea-nom { font-weight: 700; }
      .pr-linea-nom { display: block; }
      .pr-linea-cod { display: block; font-size: .7rem; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
      .pr-prod { display: block; font-weight: 500; }
      .pr-sku { display: block; font-size: .7rem; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
      .pr-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg) 8%, transparent);
                   border: 1px solid color-mix(in srgb, var(--bad-fg) 30%, transparent); border-radius: var(--r-md);
                   padding: .7rem .9rem; font-size: .82rem; margin-bottom: 1rem; }
      .pr-loading, .pr-empty { padding: 2rem; text-align: center; color: var(--text-muted); font-size: .85rem; }
      .pr-note { font-size: .72rem; margin: .7rem 0 0; }
      .ta-r { text-align: right; } .strong { font-weight: 700; } .pr-muted { color: var(--text-muted); }
      .up { color: var(--ok-fg); } .down { color: var(--bad-fg); } .flat { color: var(--text-muted); }
      @media (max-width: 48rem) { .pr-search, .pr-search input { width: 100%; min-width: 0; } }
    `,
  ],
})
export class TiendaAnalisisProductosComponent implements OnInit {
  protected readonly st = inject(AnalisisStateService);
  protected readonly sinLinea = SIN_LINEA;
  readonly qL = signal('');
  readonly qP = signal('');

  ngOnInit(): void {
    // Esta pestaña se recorta por LÍNEA. El producto que se haya elegido en «Productos
    // TOP» se suelta: las dos comparten una sola cascada, y dejarlo mostraría la
    // evolución de un producto debajo de una tabla de líneas.
    this.st.limpiarAlcanceSalvo('linea');
    this.st.need('suppliers', 'breakdown');
  }

  /** Filtros en memoria: las líneas son ~301 y los productos de una ≤300. */
  readonly lineasFiltradas = computed(() => {
    const rows = this.st.suppliersRep()?.rows ?? [];
    const t = this.qL().trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((l) => l.name.toLowerCase().includes(t) || l.code.toLowerCase().includes(t));
  });

  readonly productosFiltrados = computed(() => {
    const rows = this.st.lineaProductos()?.rows ?? [];
    const t = this.qP().trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(
      (p) => (p.nombre || '').toLowerCase().includes(t)
        || (p.sku || '').toLowerCase().includes(t)
        || (p.brand || '').toLowerCase().includes(t),
    );
  });

  deltaCls(p: number | null): string { return p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat'; }
  deltaTxt(p: number | null): string { return p == null ? '—' : (p > 0 ? '▲ +' : p < 0 ? '▼ ' : '') + p + '%'; }
  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  num(v: number): string { return Math.round(v || 0).toLocaleString('es-MX'); }
}
