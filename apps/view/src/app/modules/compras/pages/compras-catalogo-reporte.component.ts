import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';

import {
  ComercialService,
  PriceReportBranch,
  PriceReportMeta,
  PriceReportRow,
  ProductSupplierOption,
} from '../../comercial/comercial.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import {
  COLUMNAS_DEFAULT,
  COLUMNAS_REPORTE,
  ColumnaReporte,
  ColumnaReporteId,
  celdaReporte,
  columnasElegidas,
} from '../catalogo-reporte-columnas';

/** Un proveedor con sus renglones, para la hoja impresa. */
interface GrupoImpresion {
  proveedor: string;
  filas: PriceReportRow[];
}

/**
 * `[CAT.7]` — **Reporte de precios por proveedor**, imprimible.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────────────────────
 * El comprador negocia proveedor por proveedor y hoy no tiene de dónde sacar, en un papel, los
 * precios a los que se vende lo de ESE proveedor. La pestaña Catálogo muestra un precio por
 * renglón y paginado de 50; esto arma la lista completa, con la matriz que Kepler ya tiene:
 * unidad / mayoreo / paquete / mayoreo de paquete / caja.
 *
 * ── Tres decisiones que la pantalla no puede callar ─────────────────────────────────────────
 *  1. **De qué plaza es el precio.** Kepler lo guarda por sucursal (`[NORM.3]`). Sin plaza elegida
 *     el backend devuelve la forma consolidada —que NO es un promedio: es la fila de la plaza que
 *     representa a la red— y la hoja lo imprime con esas palabras. Un precio de papel sin plaza es
 *     el que termina cobrándose mal en el mostrador.
 *  2. **De cuándo es.** `meta.precios_al` viaja a la carátula. Si no se pudo medir se dice; no se
 *     asume "hoy". El 2026-09-02 esta misma familia de datos llevaba seis días parada.
 *  3. **Qué falta.** Los renglones sin precio se cuentan y se declaran arriba de la tabla en vez
 *     de imprimirse como `$0.00`.
 *
 * ── Lo que NO hace, a propósito ─────────────────────────────────────────────────────────────
 * No calcula descuentos ni "ahorro" (eso es del verificador de mostrador, con sus cuatro guardas)
 * y no mezcla la lista `BASE-MXN` de la pestaña Catálogo: esa no tiene sucursal y llega con
 * semanas de rezago, así que en la misma hoja serían dos verdades sin etiqueta que las distinga.
 *
 * Impresión con `@media print` y el diálogo del navegador ("Guardar como PDF"), mismo patrón que
 * `/tienda/etiquetas` y la hoja de caducidades: el documento ES la pantalla, sin dependencias
 * nuevas ni almacenamiento de archivos.
 */
@Component({
  selector: 'app-compras-catalogo-reporte',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CheckboxModule,
    MultiSelectModule,
    SelectModule,
    TableModule,
    TooltipModule,
    SkeletonModule,
    MetricStripComponent,
    PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page rp">
      <header class="surf-page-head no-print">
        <div class="surf-page-head-text">
          <h1>Reporte de precios</h1>
          <p class="surf-page-sub">
            La lista imprimible de lo que se vende de un proveedor, con la matriz de precios de Kepler.
          </p>
        </div>
      </header>

      <div class="no-print"><app-page-tabs [tabs]="tabs" /></div>

      <!-- ── 1. De quién ──────────────────────────────────────────────────── -->
      <section class="sheet cols-12 no-print">
        <article class="cell cell-span-12 is-flush">
          <div class="rp-step">
            <span class="rp-step-n" aria-hidden="true">1</span>
            <h2 class="rp-step-h">Proveedores</h2>
          </div>
          <div class="rp-bar">
            <p-multiselect
              class="rp-sel-wide"
              [options]="proveedores()"
              optionLabel="name"
              optionValue="id"
              [ngModel]="elegidos()"
              (ngModelChange)="onProveedores($event)"
              [filter]="true"
              filterBy="name"
              [showClear]="true"
              [maxSelectedLabels]="2"
              selectedItemsLabel="{0} proveedores"
              placeholder="Elegí uno o más proveedores"
              emptyFilterMessage="Sin coincidencias"
              appendTo="body"
              scrollHeight="320px"
              ariaLabel="Proveedores del reporte">
              <ng-template let-s #item>
                <div class="rp-sup-opt">
                  <span>{{ s.name }}</span>
                  <span class="rp-sup-count">{{ s.product_count }}</span>
                </div>
              </ng-template>
            </p-multiselect>

            <p-select
              class="rp-sel"
              [options]="opcionesSucursal()"
              optionLabel="label"
              optionValue="value"
              [ngModel]="sucursal()"
              (ngModelChange)="onSucursal($event)"
              placeholder="Precio consolidado"
              appendTo="body"
              ariaLabel="Plaza del precio" />

            <div class="rp-search">
              <i class="pi pi-search" aria-hidden="true"></i>
              <input
                type="search"
                [ngModel]="search()"
                (ngModelChange)="search.set($event)"
                placeholder="Filtrar por nombre, SKU o código…"
                aria-label="Filtrar productos del reporte"
                autocomplete="off" />
            </div>

            <label class="rp-chk">
              <p-checkbox [ngModel]="soloConPrecio()" (ngModelChange)="onSoloConPrecio($event)"
                          [binary]="true" inputId="rp-solo-precio" />
              <span>Sólo con precio</span>
            </label>
          </div>
        </article>
      </section>

      <!-- ── 2. Qué columnas ─────────────────────────────────────────────── -->
      <section class="sheet cols-12 no-print">
        <article class="cell cell-span-12 is-flush">
          <div class="rp-step">
            <span class="rp-step-n" aria-hidden="true">2</span>
            <h2 class="rp-step-h">Apartados del reporte</h2>
            <span class="rp-step-sub">{{ columnas().length }} de {{ todasLasColumnas.length }} tildados</span>
          </div>
          <div class="rp-cols">
            @for (g of grupos; track g.clave) {
              <fieldset class="rp-col-grupo">
                <legend>{{ g.titulo }}</legend>
                @for (c of g.columnas; track c.id) {
                  <label class="rp-chk" [pTooltip]="c.ayuda" tooltipPosition="top">
                    <p-checkbox [ngModel]="tiene(c.id)" (ngModelChange)="toggleColumna(c.id, $event)"
                                [binary]="true" [inputId]="'rp-col-' + c.id" />
                    <span>{{ c.label }}</span>
                  </label>
                }
              </fieldset>
            }
          </div>
        </article>
      </section>

      <!-- ── 3. Qué productos ────────────────────────────────────────────── -->
      @if (!elegidos().length) {
        <div class="sheet cols-12 no-print">
          <article class="cell cell-span-12">
            <div class="rp-empty">
              <div class="rp-empty-ico"><i class="pi pi-users" aria-hidden="true"></i></div>
              <h3>Elegí un proveedor para empezar</h3>
              <p>El reporte se arma con los productos del proveedor y los precios que Kepler tiene cargados para ellos.</p>
            </div>
          </article>
        </div>
      } @else {
        @if (error()) {
          <div class="sheet cols-12 no-print">
            <article class="cell cell-span-12">
              <div class="rp-error" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <div>
                  <strong>No se pudo cargar el reporte.</strong>
                  <span>Puede ser un corte de red o un permiso. Reintentá; si sigue, avisá a sistemas.</span>
                </div>
                <button pButton size="small" [outlined]="true" (click)="recargar()">
                  <span class="p-button-label">Reintentar</span>
                </button>
              </div>
            </article>
          </div>
        }

        @if (cargando()) {
          <p-skeleton height="180px" styleClass="no-print" />
        }

        @if (meta(); as m) {
          <div class="no-print">
            <app-metric-strip [items]="kpis(m)" ariaLabel="Resumen del reporte" />
          </div>

          <!-- Procedencia: de qué plaza y de cuándo. No se puede cerrar: es una condición del dato. -->
          <div class="rp-aviso no-print" [class.is-warn]="procedencia().alerta" role="status">
            <i [class]="procedencia().alerta ? 'pi pi-exclamation-triangle' : 'pi pi-info-circle'" aria-hidden="true"></i>
            <div>
              <strong>{{ procedencia().titulo }}</strong>
              <span>{{ procedencia().detalle }}</span>
            </div>
          </div>

          @if (m.truncado) {
            <div class="rp-aviso is-warn no-print" role="status">
              <i class="pi pi-filter" aria-hidden="true"></i>
              <div>
                <strong>La lista se cortó en {{ m.limite }} renglones.</strong>
                <span>Hay {{ m.total }} productos que cumplen el filtro. Elegí menos proveedores o filtrá para verlos todos.</span>
              </div>
            </div>
          }
        }

        <section class="sheet cols-12 no-print">
          <article class="cell cell-span-12 is-flush">
            <div class="rp-step">
              <span class="rp-step-n" aria-hidden="true">3</span>
              <h2 class="rp-step-h">Productos del reporte</h2>
              <span class="rp-step-sub">{{ seleccion().length }} de {{ filas().length }} seleccionados</span>
              <div class="rp-step-actions">
                <button pButton size="small" [text]="true" severity="secondary" (click)="seleccionarTodos()">
                  <span class="p-button-label">Todos</span>
                </button>
                <button pButton size="small" [text]="true" severity="secondary" (click)="seleccionarNinguno()">
                  <span class="p-button-label">Ninguno</span>
                </button>
                <button pButton size="small" [outlined]="true" (click)="previa.set(!previa())"
                        [attr.aria-pressed]="previa()">
                  <span class="p-button-icon p-button-icon-left pi pi-eye" aria-hidden="true"></span>
                  <span class="p-button-label">{{ previa() ? 'Ocultar hoja' : 'Ver hoja' }}</span>
                </button>
                <button pButton size="small" (click)="imprimir()" [disabled]="!seleccion().length">
                  <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span>
                  <span class="p-button-label">Imprimir / Guardar PDF</span>
                </button>
              </div>
            </div>

            <p-table
              class="p-datatable-sm surf-table surf-table--sticky"
              [value]="filas()"
              [selection]="seleccion()"
              (selectionChange)="seleccion.set($event)"
              dataKey="product_id"
              [loading]="cargando()"
              [paginator]="filas().length > 100"
              [rows]="100"
              [rowsPerPageOptions]="[100, 250, 500]"
              [rowHover]="true">
              <ng-template #header>
                <tr>
                  <th scope="col" class="rp-th-chk">
                    <p-table-header-checkbox ariaLabel="Seleccionar todos" />
                  </th>
                  <th scope="col">Producto</th>
                  @for (c of columnasVisibles(); track c.id) {
                    <th scope="col" [class.num]="c.num">{{ c.label }}</th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [class.rp-sin-precio]="r.piece_price == null">
                  <td class="rp-th-chk"><p-table-checkbox [value]="r" /></td>
                  <td>
                    <div class="rp-nombre">{{ r.nombre }}</div>
                    <div class="rp-sup">{{ r.supplier_name || 'sin proveedor' }}</div>
                  </td>
                  @for (c of columnasVisibles(); track c.id) {
                    <td [class.num]="c.num">{{ celda(r, c.id) }}</td>
                  }
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr>
                  <td [attr.colspan]="columnasVisibles().length + 2" class="comm-empty-cell">
                    <div class="comm-empty">
                      <div class="comm-empty-icon"><i class="pi pi-box" aria-hidden="true"></i></div>
                      <h3>Sin productos</h3>
                      <p>Ese proveedor no tiene productos activos que cumplan el filtro.</p>
                    </div>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </article>
        </section>
      }

      <!-- ═══════════ La hoja: lo único que se imprime ═══════════ -->
      @if (seleccion().length) {
        <article class="rp-hoja" [class.is-previa]="previa()" aria-label="Hoja del reporte de precios">
          <header class="rp-hoja-head">
            <div>
              <strong class="rp-hoja-org">MEGA DULCES</strong>
              <span class="rp-hoja-doc">Reporte de precios por proveedor</span>
            </div>
            <div class="rp-hoja-fecha">
              <span class="rp-hoja-lbl">Emitido</span>
              <strong>{{ hoy }}</strong>
            </div>
          </header>

          <section class="rp-hoja-ident">
            <div>
              <span class="rp-hoja-lbl">Precio de</span>
              <span class="rp-hoja-val">{{ plazaImpresa() }}</span>
            </div>
            <div>
              <span class="rp-hoja-lbl">Precios calculados</span>
              <span class="rp-hoja-val">{{ preciosAlImpreso() }}</span>
            </div>
            <div>
              <span class="rp-hoja-lbl">Renglones</span>
              <span class="rp-hoja-val">{{ seleccion().length }}</span>
            </div>
          </section>

          @for (g of gruposImpresion(); track g.proveedor) {
            <section class="rp-hoja-grupo">
              <h2 class="rp-hoja-h2">{{ g.proveedor }} <span>({{ g.filas.length }})</span></h2>
              <table class="rp-hoja-tbl">
                <thead>
                  <tr>
                    <th scope="col">Producto</th>
                    @for (c of columnasVisibles(); track c.id) {
                      <th scope="col" [class.num]="c.num">{{ c.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (r of g.filas; track r.product_id) {
                    <tr>
                      <td>{{ r.nombre }}</td>
                      @for (c of columnasVisibles(); track c.id) {
                        <td [class.num]="c.num">{{ celda(r, c.id) }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }

          <footer class="rp-hoja-pie">
            El precio unitario es el de la unidad BASE de Kepler (columna Unidad): en los productos
            con base PAQ ese renglón ya es el paquete. Un guion (—) significa que el dato no está
            cargado, no que sea cero.
          </footer>
        </article>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    /* ── Pasos ───────────────────────────────────────────────────────────── */
    .rp-step {
      display: flex; align-items: center; gap: .5rem;
      padding: .625rem .875rem;
      border-bottom: 1px solid var(--c-divider);
      flex-wrap: wrap;
    }
    .rp-step-n {
      display: inline-grid; place-items: center;
      width: 20px; height: 20px; border-radius: 999px;
      background: var(--c-surface-2); color: var(--c-text-2);
      font-size: var(--fs-xs); font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums;
    }
    .rp-step-h { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .rp-step-sub { color: var(--c-text-2); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
    .rp-step-actions { margin-left: auto; display: flex; gap: .375rem; align-items: center; flex-wrap: wrap; }

    .rp-bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; padding: .625rem .875rem; }
    /*
      La clase va en el HOST del componente, no en styleClass: PrimeNG 22 le quitó ese input a
      select/multiselect/table y como atributo estático queda muerto — sin error y sin efecto.
      Lo vigila scripts/check-primeng-api.js. (Sin acentos graves acá adentro: cierran el literal.)
    */
    .rp-sel-wide { min-width: 320px; }
    .rp-sel { min-width: 200px; }

    .rp-search {
      display: inline-flex; align-items: center; gap: .375rem;
      height: 32px; padding: 0 .5rem; min-width: 240px;
      background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 8px;
      color: var(--c-text-2);
    }
    .rp-search input {
      border: 0; background: transparent; outline: none; color: var(--c-text-1);
      font: inherit; width: 100%;
    }
    .rp-search:focus-within { border-color: var(--action); }

    .rp-chk { display: inline-flex; align-items: center; gap: .375rem; color: var(--c-text-1); font-size: var(--fs-sm); cursor: pointer; }

    .rp-sup-opt { display: flex; justify-content: space-between; gap: 1rem; width: 100%; }
    .rp-sup-count { color: var(--c-text-2); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); }

    /* ── Columnas ────────────────────────────────────────────────────────── */
    .rp-cols { display: flex; gap: 1.25rem; flex-wrap: wrap; padding: .75rem .875rem; }
    .rp-col-grupo { border: 0; margin: 0; padding: 0; display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; }
    .rp-col-grupo legend {
      float: left; width: 100%; padding: 0 0 .25rem;
      color: var(--c-text-2); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em;
    }

    /* ── Avisos / estados ────────────────────────────────────────────────── */
    .rp-aviso {
      display: flex; gap: .625rem; align-items: flex-start;
      padding: .625rem .875rem; margin-bottom: .75rem;
      border: 1px solid var(--c-divider); border-radius: 10px;
      background: var(--c-surface-1); color: var(--c-text-2); font-size: var(--fs-sm);
    }
    .rp-aviso.is-warn { border-color: var(--warn-border); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rp-aviso strong { display: block; color: var(--c-text-1); }
    .rp-aviso.is-warn strong { color: inherit; }

    .rp-error {
      display: flex; gap: .625rem; align-items: center;
      padding: .75rem; border: 1px solid var(--bad-border); border-radius: 10px;
      background: var(--bad-soft-bg); color: var(--bad-soft-fg);
    }
    .rp-error div { display: flex; flex-direction: column; flex: 1; }

    .rp-empty { text-align: center; padding: 2.5rem 1rem; color: var(--c-text-2); }
    .rp-empty-ico { font-size: 1.5rem; color: var(--c-text-3); margin-bottom: .5rem; }
    .rp-empty h3 { margin: 0 0 .25rem; font-size: var(--fs-body); color: var(--c-text-1); }
    .rp-empty p { margin: 0; font-size: var(--fs-sm); }

    /* ── Tabla ───────────────────────────────────────────────────────────── */
    .rp-th-chk { width: 2.5rem; }
    .rp-nombre { font-weight: var(--fw-medium); color: var(--c-text-1); }
    .rp-sup { color: var(--c-text-3); font-size: var(--fs-xs); }
    .rp-sin-precio td { color: var(--c-text-2); }
    :host ::ng-deep .surf-table td.num,
    :host ::ng-deep .surf-table th.num { text-align: right; font-variant-numeric: tabular-nums; }

    /* ── La hoja ─────────────────────────────────────────────────────────── */
    .rp-hoja { display: none; }
    .rp-hoja.is-previa {
      display: block;
      background: var(--c-surface-1); color: var(--c-text-1);
      border: 1px solid var(--c-divider); border-radius: 10px;
      padding: 1.25rem; margin-top: 1rem;
    }
    .rp-hoja-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; border-bottom: 2px solid var(--c-divider); padding-bottom: .5rem; }
    .rp-hoja-org { display: block; font-size: var(--fs-lg); letter-spacing: .06em; }
    .rp-hoja-doc { color: var(--c-text-2); font-size: var(--fs-sm); }
    .rp-hoja-fecha { text-align: right; font-variant-numeric: tabular-nums; }
    .rp-hoja-lbl { display: block; color: var(--c-text-2); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; }
    .rp-hoja-ident { display: flex; gap: 2rem; flex-wrap: wrap; margin: .75rem 0; }
    .rp-hoja-val { font-weight: var(--fw-medium); }
    .rp-hoja-h2 { font-size: var(--fs-sm); margin: 1rem 0 .375rem; text-transform: uppercase; letter-spacing: .04em; }
    .rp-hoja-h2 span { color: var(--c-text-2); font-weight: var(--fw-regular); }
    .rp-hoja-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    .rp-hoja-tbl th, .rp-hoja-tbl td { border: 1px solid var(--c-divider); padding: .25rem .375rem; text-align: left; }
    .rp-hoja-tbl th { background: var(--c-surface-2); }
    .rp-hoja-tbl td.num, .rp-hoja-tbl th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .rp-hoja-pie { margin-top: 1rem; color: var(--c-text-2); font-size: var(--fs-xs); }

    /*
      Impresión: se esconde el chrome de la app y queda sólo la hoja, en A4 con márgenes reales.
      Los literales de color acá son la excepción declarada del sistema (hoja de papel): en papel
      no hay tema oscuro ni tokens — hay tinta.
    */
    @media print {
      .no-print, p-skeleton { display: none !important; }
      .rp-hoja { display: block !important; background: #fff; color: #000; border: 0; padding: 0; margin: 0; }
      .rp-hoja-head { border-bottom-color: #000; }
      .rp-hoja-tbl th, .rp-hoja-tbl td { border-color: #999; }
      .rp-hoja-tbl th { background: #f2f2f2; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .rp-hoja-doc, .rp-hoja-lbl, .rp-hoja-pie { color: #444; }
      /* Un renglón no se parte a la mitad, y el encabezado del grupo no queda huérfano al pie. */
      .rp-hoja-tbl tr { break-inside: avoid; }
      .rp-hoja-h2 { break-after: avoid; }
      .rp-hoja-tbl thead { display: table-header-group; }
    }
  `],
})
export class ComprasCatalogoReporteComponent {
  readonly tabs = CATALOGO_TABS;
  readonly todasLasColumnas = COLUMNAS_REPORTE;

  /** Los tres grupos de apartados, como se pintan. */
  readonly grupos: { clave: string; titulo: string; columnas: ColumnaReporte[] }[] = [
    { clave: 'identidad', titulo: 'Identificación', columnas: COLUMNAS_REPORTE.filter((c) => c.grupo === 'identidad') },
    { clave: 'precio', titulo: 'Precios', columnas: COLUMNAS_REPORTE.filter((c) => c.grupo === 'precio') },
    { clave: 'costo', titulo: 'Interno', columnas: COLUMNAS_REPORTE.filter((c) => c.grupo === 'costo') },
  ];

  private readonly api = inject(ComercialService);

  readonly elegidos = signal<string[]>([]);
  readonly sucursal = signal<string | null>(null);
  readonly search = signal('');
  readonly soloConPrecio = signal(false);
  readonly columnas = signal<ColumnaReporteId[]>([...COLUMNAS_DEFAULT]);
  readonly seleccion = signal<PriceReportRow[]>([]);
  readonly previa = signal(false);

  readonly hoy = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

  // ── Lecturas ────────────────────────────────────────────────────────────
  private readonly proveedoresRes = rxResource({
    params: () => true,
    stream: () => this.api.productSuppliers(),
  });
  readonly proveedores = computed<ProductSupplierOption[]>(() => this.proveedoresRes.value() ?? []);

  private readonly sucursalesRes = rxResource({
    params: () => true,
    stream: () => this.api.priceReportBranches(),
  });
  readonly sucursales = computed<PriceReportBranch[]>(() => this.sucursalesRes.value() ?? []);

  /**
   * El reporte. `undefined` mientras no haya proveedor elegido → el recurso queda ocioso y NO
   * pide el catálogo entero: son 8,700 productos que nadie imprime.
   */
  private readonly reporteRes = rxResource({
    params: () => {
      const ids = this.elegidos();
      if (!ids.length) return undefined;
      return {
        supplier_ids: ids,
        sucursal: this.sucursal(),
        search: this.search().trim() || undefined,
        only_with_price: this.soloConPrecio() || undefined,
      };
    },
    stream: ({ params }) => this.api.priceReport(params),
  });

  /**
   * ⚠️ `hasValue()` y no `value() ?? []`: en estado de error `value()` **lanza**. Sin esta guarda,
   * un corte de red no muestra el banner de error — revienta el render entero y la pantalla queda
   * en blanco. Lo destapó la prueba que monta el componente; en `tsc` las dos formas son iguales.
   */
  readonly filas = computed<PriceReportRow[]>(() => (this.reporteRes.hasValue() ? this.reporteRes.value().rows : []));
  readonly meta = computed<PriceReportMeta | null>(() => (this.reporteRes.hasValue() ? this.reporteRes.value().meta : null));
  readonly cargando = computed(() => this.reporteRes.isLoading());
  readonly error = computed(() => !!this.reporteRes.error());

  constructor() {
    // Al cambiar el pedido, entran todos los renglones y el usuario destilda lo que no quiere.
    // Es lo contrario de arrancar en cero: elegir proveedor ya es decir "quiero lo de éste".
    effect(() => {
      const filas = this.filas();
      this.seleccion.set([...filas]);
    });
  }

  // ── Opciones ────────────────────────────────────────────────────────────
  readonly opcionesSucursal = computed(() => [
    { label: 'Precio consolidado (toda la red)', value: null },
    ...this.sucursales().map((s) => ({ label: `${s.nombre} (${s.sucursal})`, value: s.sucursal })),
  ]);

  readonly columnasVisibles = computed<ColumnaReporte[]>(() => columnasElegidas(this.columnas()));

  // ── Procedencia: de qué plaza y de cuándo ───────────────────────────────
  readonly procedencia = computed(() => {
    const m = this.meta();
    if (!m) return { alerta: false, titulo: '', detalle: '' };

    const plaza = m.consolidado
      ? 'Precio consolidado: es el de la plaza que representa a la red, no un promedio ni el de una sucursal en particular.'
      : `Precio de ${m.sucursal_nombre || 'la plaza ' + m.sucursal}.`;
    const faltan = m.sin_precio > 0
      ? ` ${m.sin_precio} de ${m.mostrados} renglones no tienen precio cargado y salen con guion.`
      : '';

    if (!m.precios_al) {
      return {
        alerta: true,
        titulo: 'No se sabe de cuándo son estos precios.',
        detalle: plaza + faltan,
      };
    }
    const dias = Math.floor((Date.now() - new Date(m.precios_al).getTime()) / 86400000);
    const fecha = new Date(m.precios_al).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    return dias > 7
      ? { alerta: true, titulo: `Estos precios llevan ${dias} días sin recalcularse (último: ${fecha}).`, detalle: plaza + faltan }
      : { alerta: false, titulo: `Precios calculados el ${fecha}.`, detalle: plaza + faltan };
  });

  /** Lo que va impreso en la carátula, en una línea. */
  readonly plazaImpresa = computed(() => {
    const m = this.meta();
    if (!m) return '—';
    return m.consolidado
      ? 'Consolidado (la plaza que representa a la red — no distingue sucursal)'
      : `${m.sucursal_nombre || 'Plaza'} (${m.sucursal})`;
  });

  readonly preciosAlImpreso = computed(() => {
    const iso = this.meta()?.precios_al;
    if (!iso) return 'sin fecha declarada';
    return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  });

  readonly kpis = (m: PriceReportMeta): MetricStripItem[] => [
    { label: 'Productos', value: m.mostrados, format: 'number' },
    { label: 'Seleccionados', value: this.seleccion().length, format: 'number', tone: 'brand' },
    {
      label: 'Sin precio',
      value: m.sin_precio,
      format: 'number',
      tone: m.sin_precio > 0 ? 'warn' : 'default',
      sub: m.sin_precio > 0 ? 'salen con guion, no con cero' : 'todos con precio',
    },
  ];

  /** Los renglones seleccionados agrupados por proveedor, en el orden en que llegaron. */
  readonly gruposImpresion = computed<GrupoImpresion[]>(() => {
    const ids = new Set(this.seleccion().map((r) => r.product_id));
    const grupos = new Map<string, PriceReportRow[]>();
    for (const r of this.filas()) {
      if (!ids.has(r.product_id)) continue;
      const clave = r.supplier_name || 'Sin proveedor asignado';
      const lista = grupos.get(clave);
      if (lista) lista.push(r);
      else grupos.set(clave, [r]);
    }
    return [...grupos.entries()].map(([proveedor, filas]) => ({ proveedor, filas }));
  });

  // ── Acciones ────────────────────────────────────────────────────────────
  onProveedores(ids: string[]): void { this.elegidos.set(ids || []); }
  onSucursal(s: string | null): void { this.sucursal.set(s ?? null); }
  onSoloConPrecio(v: boolean): void { this.soloConPrecio.set(!!v); }

  tiene(id: ColumnaReporteId): boolean { return this.columnas().includes(id); }

  toggleColumna(id: ColumnaReporteId, on: boolean): void {
    const actuales = this.columnas();
    if (on && !actuales.includes(id)) this.columnas.set([...actuales, id]);
    if (!on) this.columnas.set(actuales.filter((c) => c !== id));
  }

  seleccionarTodos(): void { this.seleccion.set([...this.filas()]); }
  seleccionarNinguno(): void { this.seleccion.set([]); }

  celda(row: PriceReportRow, id: ColumnaReporteId): string { return celdaReporte(row, id); }

  recargar(): void { this.reporteRes.reload(); }

  imprimir(): void { if (typeof window !== 'undefined') window.print(); }
}
