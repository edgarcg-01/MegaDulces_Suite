import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
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
import { nombrePropio } from '../catalogo-proveedor';
import { printIsolated } from '../../../shared/util/print-isolated';
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
 * ── Cómo se imprime, y por qué así ─────────────────────────────────────────────────────────
 * Con `printIsolated()` (el mismo helper del cartel del andén y de las etiquetas de checado): la
 * hoja se clona a un documento aparte y ESO es lo que se imprime.
 *
 * ⛔ Antes era `window.print()` + un bloque `@media print` en los estilos del componente, y no
 * podía funcionar: **los estilos de un componente Angular están encapsulados**, así que su
 * `.no-print{display:none}` sólo alcanza a los elementos de ESTE componente. Todo lo que vive
 * afuera —la migaja, el aviso de "hay una versión nueva", la barra lateral, los botones del
 * armazón— se imprimía igual. Medido en producción el 2026-10-13: la hoja salía con la migaja
 * "Comercial / Compras / Reabastecimiento / Catálogo" arriba y el botón "Actualizar" encima de la
 * tabla. Un `@media print` encapsulado no puede esconder lo que no es suyo.
 *
 * El helper además trae la red de seguridad para las tablets que ignoran el `print()` del iframe,
 * y el `@page{margin:0}` apaga el encabezado del navegador (fecha, URL y "1/1"). El margen real
 * de cada hoja lo pone el `thead`/`tfoot` de `.rp-doc`, que el navegador repite por página.
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
              placeholder="Elige uno o más proveedores"
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
              <h3>Elige un proveedor para empezar</h3>
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
                  <span>Puede ser un corte de red o un permiso. Vuelve a intentar; si sigue, avisa a sistemas.</span>
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
                <span>Hay {{ m.total }} productos que cumplen el filtro. Elige menos proveedores o filtra para verlos todos.</span>
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
                <button pButton size="small" (click)="imprimir()"
                        [disabled]="!seleccion().length || imprimiendo()">
                  <span class="p-button-icon p-button-icon-left"
                        [class]="imprimiendo() ? 'pi pi-spin pi-spinner' : 'pi pi-print'" aria-hidden="true"></span>
                  <span class="p-button-label">{{ imprimiendo() ? 'Preparando…' : 'Imprimir / Guardar PDF' }}</span>
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
        <!--
          La hoja ES el documento. Va envuelta en una tabla de una sola celda a proposito: su "thead" y su "tfoot" son el membrete y el pie, y el navegador los REPITE en cada hoja
          impresa. Es la unica forma de tener margen de arriba y de abajo en TODAS las paginas
          con @page margin cero — y ese margen cero es lo que apaga el encabezado propio del
          navegador (la fecha, la URL y el "1/1" que salian en la impresion vieja).
        -->
        <article #hoja class="rp-hoja" [class.is-previa]="previa()" aria-label="Hoja del reporte de precios">
          <table class="rp-doc">
            <thead>
              <tr><td>
                <div class="rp-run">
                  <span class="rp-run-org">MEGA DULCES</span>
                  <span class="rp-run-doc">Precios por proveedor</span>
                  <span class="rp-run-meta">{{ plazaCorta() }} · {{ hoy }}</span>
                </div>
              </td></tr>
            </thead>

            <tfoot>
              <tr><td>
                <!--
                  El bloque "Como leer esta hoja" vivia al final y se retiro a pedido de Compras
                    (2026-10-13): tres renglones de instrucciones al pie de una hoja que el
                  comprador ya sabe leer. Lo unico que no se podia perder de ahi era que el guion
                  NO es un cero — eso es un dato ausente declarado, no una lectura — y cabe en
                  tres palabras en el pie, que ademas se repite en todas las hojas.
                -->
                <div class="rp-run-pie">
                  <span>Documento interno de Mega Dulces · Compras</span>
                  <span>— sin dato · Precios calculados el {{ preciosAlImpreso() }}</span>
                </div>
              </td></tr>
            </tfoot>

            <tbody>
              <tr><td class="rp-doc-cuerpo">
                <header class="rp-portada">
                  <!--
                    El titulo de la caratula es el PROVEEDOR, no el nombre del reporte: eso ya lo
                    dice el membrete, que ademas viaja a todas las hojas. Repetirlo aca gastaba el
                    renglon mas visible del documento en una palabra que el lector ya leyo 3 cm
                    antes.
                  -->
                  <h1 class="rp-portada-h1">{{ sujetoHoja() }}</h1>
                  <p class="rp-portada-sub">Precios de venta vigentes en el ERP, por unidad, paquete y caja.</p>
                  <!--
                    "Precios al" y "Impreso" y no "Precios calculados" / "Emitido": eran dos fechas
                    lado a lado con rotulos que se parecian, y la que decide si el numero sirve es
                    la primera. La plaza va primero y con mas peso porque es lo que CAMBIA el
                    precio: la misma fila vale distinto en otra tienda.
                  -->
                  <dl class="rp-ficha">
                    <div class="rp-ficha-par is-fuerte">
                      <dt>Plaza del precio</dt>
                      <dd>{{ plazaImpresa() }}</dd>
                    </div>
                    <div class="rp-ficha-par">
                      <dt>Precios al</dt>
                      <dd>{{ preciosAlCorto() }}</dd>
                    </div>
                    <div class="rp-ficha-par">
                      <dt>Renglones</dt>
                      <dd>{{ seleccion().length }}</dd>
                    </div>
                    @if (sinPrecioImpresos(); as sin) {
                      <div class="rp-ficha-par">
                        <dt>Sin precio</dt>
                        <dd>{{ sin }} salen con guion</dd>
                      </div>
                    }
                    <!--
                      Aca iba "Impreso". Se fue: la fecha ya esta en el membrete y en el pie, o sea
                      en todas las hojas, y una quinta casilla dejaba a la ficha partida en dos
                      renglones con una sola caja sola abajo.
                    -->
                  </dl>
                </header>

                @for (g of gruposImpresion(); track g.proveedor) {
                  <section class="rp-hoja-grupo">
                    <table class="rp-hoja-tbl">
                      <thead>
                        <!--
                          El proveedor va DENTRO del thead, no en un h2 afuera: asi el navegador lo
                          repite en cada hoja junto con los titulos de columna. Antes vivia afuera y
                          en la pagina 2 quedaba una tabla de precios sin decir de quien era.
                        -->
                        <tr class="rp-hoja-tr-prov">
                          <th scope="colgroup" class="rp-hoja-prov" [attr.colspan]="dineroVisibles().length + 1">
                            <span class="rp-hoja-h2-nom">{{ g.proveedor }}</span>
                            <span class="rp-hoja-h2-n">{{ g.filas.length }} {{ g.filas.length === 1 ? 'producto' : 'productos' }}</span>
                          </th>
                        </tr>
                        <!--
                          Siete columnas de dinero en fila son una matriz, no una lista: sin decir
                          cual peldano mide cada una, "Paquete" y "Caja" se leen como dos precios
                          sueltos. Esta fila las agrupa por el peldano de Kepler del que hablan, y
                          como vive en el thead se repite en cada hoja junto con los titulos.
                        -->
                        <tr class="rp-hoja-tr-fam">
                          @for (f of familiasVisibles(); track f.titulo + f.span) {
                            <th class="rp-hoja-fam" [attr.colspan]="f.span" [class.es-vacia]="!f.titulo">{{ f.titulo }}</th>
                          }
                        </tr>
                        <tr>
                          <th scope="col">Producto</th>
                          @for (c of dineroVisibles(); track c.id) {
                            <th scope="col" class="col" [class.num]="c.num">{{ c.label }}</th>
                          }
                        </tr>
                      </thead>
                      <tbody>
                        @for (r of g.filas; track r.product_id) {
                          <tr>
                            <!--
                              SKU, unidad, marca y gramaje viajan DEBAJO del nombre y no como
                              columnas propias. Con ocho columnas en 176 mm el nombre se partia en
                              cuatro renglones mientras el SKU ocupaba una columna entera para
                              cinco digitos. Siguen saliendo solo si el comprador los tildo: lo que
                              cambia es donde se imprimen, no quien los elige.
                            -->
                            <td class="rp-td-nombre">
                              <span class="rp-nom">{{ legible(r.nombre) }}</span>
                              @if (identidadDe(r); as ident) {
                                <span class="rp-ident">{{ ident }}</span>
                              }
                            </td>
                            @for (c of dineroVisibles(); track c.id) {
                              <td [class.num]="c.num">{{ celda(r, c.id) }}</td>
                            }
                          </tr>
                        }
                      </tbody>
                    </table>
                  </section>
                }

              </td></tr>
            </tbody>
          </table>
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
     .rp-search input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
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

    /* ── La hoja ──────────────────────────────────────────────────────────
       Esto es PAPEL, no pantalla: los colores van en literales de tinta y no en
       tokens. Es la excepcion que DESIGN.md ya declaraba para la hoja impresa —
       en papel no hay tema oscuro, hay tinta — y ahora ademas es necesaria: estos
       mismos estilos se clonan dentro del documento aislado que se imprime, donde
       un token que resuelva a blanco sobre blanco no se ve hasta que sale la hoja.

       Las medidas van en milimetros porque la unidad del destino es la hoja carta.
    */
    /* La escala tipografica del PAPEL, en milimetros, declarada una sola vez. No sale de los
       tokens de pantalla a proposito: un cuerpo en rem depende del zoom del navegador y de la
       densidad del tema, y una hoja impresa no tiene ninguna de las dos cosas — es el mismo
       razonamiento de [DS.6.1], que ya dejo los font-size de tickets y exports en unidades
       fisicas: la pregunta no es en que archivo esta, es DONDE se renderiza.
       Son tokens de la familia --fs-*, acotados a la hoja, para que la tipografia del papel
       se cambie en un solo lugar. */
    .rp-hoja {
      display: none;
      --fs-hoja-xs: 2.8mm;   /* etiquetas de la ficha, pie */
      --fs-hoja-sm: 3mm;   /* notas, conteos */
      --fs-hoja-base: 3.2mm; /* la tabla */
      --fs-hoja-meta: 3.1mm;   /* la linea de contexto del membrete */
      --fs-hoja-md: 3.4mm;   /* datos de la ficha, bajada */
      --fs-hoja-lg: 3.7mm;   /* proveedor */
      --fs-hoja-xl: 4.6mm;   /* la marca */
      --fs-hoja-tit: 5.4mm;    /* el titulo del documento */
    }
    .rp-hoja.is-previa {
      display: block; margin-top: 1rem;
      /* La previa en pantalla imita la hoja: ancho carta y sombra de papel. */
      width: 215.9mm; max-width: 100%;
      background: #fff; color: #111; border: 1px solid #d6d3d1; border-radius: 4px;
      box-shadow: 0 1px 3px rgb(0 0 0 / .08); overflow: hidden;
    }
    .rp-doc { width: 100%; border-collapse: collapse; }
    .rp-doc > thead > tr > td,
    .rp-doc > tfoot > tr > td { padding: 0; border: 0; }
    /* 20 mm de margen y no 14: la hoja anterior llegaba casi al filo y no se podia ni
       sostener sin tapar un precio. Con 20 el bloque de texto mide 176 mm, que es lo que
       un ojo recorre sin perder el renglon. */
    .rp-doc-cuerpo { padding: 0 20mm; border: 0; vertical-align: top; }

    /* Membrete y pie: se repiten en cada hoja (thead/tfoot de .rp-doc). */
    .rp-run {
      display: flex; align-items: baseline; gap: 3mm;
      padding: 12mm 20mm 3mm; border-bottom: .6mm solid #111;
    }
    .rp-run-org { font-size: var(--fs-hoja-xl); font-weight: 800; letter-spacing: .10em; color: #111; }
    .rp-run-doc { font-size: var(--fs-hoja-md); color: #57534e; letter-spacing: .02em; }
    .rp-run-meta { margin-left: auto; font-size: var(--fs-hoja-meta); color: #57534e; font-variant-numeric: tabular-nums; }
    .rp-run-pie {
      display: flex; justify-content: space-between; gap: 4mm;
      padding: 3mm 20mm 11mm; margin-top: 4mm;
      border-top: .2mm solid #d6d3d1; font-size: var(--fs-hoja-sm); color: #78716c;
    }

    /* Portada: va una sola vez, en la primera hoja. */
    .rp-portada { padding-top: 7mm; }
    /* Viene en caja alta del ERP: con el cuerpo del titular a secas gritaba, y el interletrado
       negativo que sirve en minusculas aprieta las mayusculas. */
    .rp-portada-h1 {
      margin: 0; font-size: var(--fs-hoja-tit); font-weight: 700; letter-spacing: .005em;
      line-height: 1.15; color: #111;
    }
    .rp-portada-sub { margin: 1.2mm 0 0; font-size: var(--fs-hoja-md); color: #57534e; }
    .rp-ficha {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(40mm, 1fr)); gap: 0; margin: 5mm 0 0;
      border: .2mm solid #d6d3d1; border-radius: 1mm; overflow: hidden;
    }
    .rp-ficha-par { padding: 3.4mm 4mm; border-left: .2mm solid #e7e5e4; }
    .rp-ficha-par:first-child { border-left: 0; }
    .rp-ficha dt {
      margin: 0 0 1mm; font-size: var(--fs-hoja-xs); font-weight: 600; color: #78716c;
      text-transform: uppercase; letter-spacing: .06em;
    }
    .rp-ficha dd { margin: 0; font-size: var(--fs-hoja-md); color: #111; line-height: 1.3; }
    .rp-ficha-par.is-fuerte dd { font-size: var(--fs-hoja-lg); font-weight: 600; }

    /* Un proveedor por bloque. */
    .rp-hoja-grupo { margin-top: 7mm; }
    .rp-hoja-prov {
      padding: 0 0 1.4mm !important; border-bottom: .3mm solid #78716c !important; text-align: left;
    }
    /* En la hoja 1 este renglon queda debajo del titulo, que ya nombra al proveedor: es una
       marca de continuacion para las hojas 2 en adelante, no un segundo titulo. Por eso pesa
       menos que el h1 y no va en caja alta. */
    .rp-hoja-prov .rp-hoja-h2-nom {
      font-size: var(--fs-hoja-md); font-weight: 600; letter-spacing: .01em; color: #44403c;
      /* El th del encabezado pone caja alta y el span la HEREDA: sin este reset el nombre del
         proveedor salia gritado aunque la regla de arriba ya no lo pidiera. */
      text-transform: none; white-space: normal;
    }
    .rp-hoja-prov .rp-hoja-h2-n {
      float: right; font-size: var(--fs-hoja-sm); font-weight: 400; color: #78716c;
      text-transform: none; letter-spacing: 0;
    }
    .rp-hoja-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-hoja-base); color: #111; }
    .rp-hoja-tbl th, .rp-hoja-tbl td {
      border-bottom: .2mm solid #ededec; padding: 2.4mm 2.2mm; text-align: left; vertical-align: top;
    }
    /* El nombre se lleva un tercio y los precios quedan juntos a la derecha. Sin esto el
       navegador reparte el sobrante entre las ocho columnas: el nombre se parte en dos
       renglones mientras entre un precio y el siguiente queda un centimetro de nada. */
    .rp-td-nombre, .rp-hoja-tbl thead th:first-child { width: 42%; }
    .rp-nom { display: block; line-height: 1.25; }
    .rp-ident {
      display: block; margin-top: .6mm;
      font-size: var(--fs-hoja-xs); color: #78716c; font-variant-numeric: tabular-nums;
    }
    /* La fila que agrupa las columnas de dinero por peldano. */
    .rp-hoja-tr-fam th {
      border-bottom: 0; padding-bottom: .4mm;
      font-size: var(--fs-hoja-xs); font-weight: 600; color: #78716c;
      text-transform: uppercase; letter-spacing: .06em; text-align: center;
    }
    .rp-hoja-fam { border-left: .2mm solid #e7e5e4; }
    .rp-hoja-fam.es-vacia, .rp-hoja-tr-fam th:first-child { border-left: 0; }
    .rp-hoja-tbl thead th {
      border-bottom: .3mm solid #a8a29e; font-size: var(--fs-hoja-xs); font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em; color: #44403c; white-space: nowrap;
    }
    .rp-hoja-tbl td.num, .rp-hoja-tbl th.num {
      text-align: right; font-variant-numeric: tabular-nums;
      /* Un precio partido en dos renglones se lee como dos numeros. El nombre del producto es
         lo unico que puede envolver, y por eso se queda con el ancho sobrante. */
      white-space: nowrap; width: 1%;
    }
    .rp-hoja-tbl { line-height: 1.35; }
    /* Sin bandas: ya hay una linea por renglon, y en una impresora de oficina ese gris sale
       sucio y gasta toner en una hoja que se imprime por docenas. */


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

  /**
   * La misma fecha, en tres palabras. La ficha son cinco casillas en 19 cm: con el mes escrito
   * entero las dos fechas se parten en dos renglones y la casilla deja de leerse de un golpe.
   * El pie y el membrete siguen con el mes completo, donde sí entra.
   */
  private static corta(d: Date): string {
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
      .replace(/.$/, '');
  }
  readonly hoyCorto = ComprasCatalogoReporteComponent.corta(new Date());

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

  /**
   * De qué habla la hoja. Casi siempre es UN proveedor — el flujo arranca eligiéndolo — y entonces
   * su nombre es el mejor título que puede llevar la carátula. Con varios no se inventa un nombre:
   * se dice cuántos son y la lista queda en los encabezados de cada tabla.
   */
  readonly sujetoHoja = computed(() => {
    const g = this.gruposImpresion();
    if (g.length === 1) return g[0].proveedor;
    if (!g.length) return 'Precios por proveedor';
    return `${g.length} proveedores`;
  });

  /**
   * Cuántos de los renglones QUE SE IMPRIMEN no traen precio. No se usa `meta().sin_precio`: ése
   * cuenta sobre todo lo que trajo la consulta, y la hoja lleva lo seleccionado. Un número que no
   * corresponde a lo que el lector tiene enfrente es peor que no ponerlo.
   */
  readonly sinPrecioImpresos = computed(
    () => this.seleccion().filter((r) => r.piece_price == null).length,
  );

  /**
   * Las columnas de precio, agrupadas por el peldaño del que hablan. Devuelve tramos
   * `{ titulo, span }` en el orden en que se pintan, para la fila de encabezado que los agrupa.
   *
   * El primer tramo arranca sin título y se come la columna Producto más las de identidad (SKU,
   * marca, contenido, unidad): no son un peldaño, son de quién hablamos.
   */
  /** Las columnas que son DINERO: las que de verdad ocupan una columna en la hoja. */
  readonly dineroVisibles = computed(() => this.columnasVisibles().filter((c) => c.grupo !== 'identidad'));

  /** Las que identifican al producto. Se imprimen juntas, debajo del nombre. */
  readonly identidadVisibles = computed(() => this.columnasVisibles().filter((c) => c.grupo === 'identidad'));

  /** "18090 · PAQ · Santoyo" — lo que el comprador tildó, en un renglón bajo el nombre. */
  identidadDe(row: PriceReportRow): string {
    return this.identidadVisibles()
      .map((c) => this.celda(row, c.id))
      .filter((v) => v && v !== '—')
      .join(' · ');
  }

  readonly familiasVisibles = computed<{ titulo: string; span: number }[]>(() => {
    const DE: Record<string, string> = {
      precio_unidad: 'Por unidad', mayoreo_unidad: 'Por unidad',
      paquete: 'Por paquete', mayoreo_paquete: 'Por paquete',
      caja: 'Por caja', costo: 'Interno',
    };
    // Arranca en 1 por la columna Producto, que no está en `dineroVisibles()`.
    const tramos: { titulo: string; span: number }[] = [{ titulo: '', span: 1 }];
    for (const c of this.dineroVisibles()) {
      const titulo = DE[c.id] ?? '';
      const ultimo = tramos[tramos.length - 1];
      if (ultimo.titulo === titulo) ultimo.span += 1;
      else tramos.push({ titulo, span: 1 });
    }
    return tramos;
  });

  /** La plaza en dos palabras: el membrete se repite en cada hoja y no puede llevar un párrafo. */
  readonly plazaCorta = computed(() => {
    const m = this.meta();
    if (!m) return '—';
    return m.consolidado ? 'Consolidado' : (m.sucursal_nombre || `Plaza ${m.sucursal}`);
  });

  /** La fecha de cómputo para la ficha. Mantiene la declaración cuando no se pudo medir. */
  readonly preciosAlCorto = computed(() => {
    const iso = this.meta()?.precios_al;
    return iso ? ComprasCatalogoReporteComponent.corta(new Date(iso)) : 'sin fecha declarada';
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

  /**
   * Kepler guarda los nombres en mayúsculas y una hoja de 40 renglones en caja alta se lee a
   * tirones. Es el mismo `nombrePropio()` de [PF.9], que ya se usa en la pestaña Productos y
   * tiene su prueba: no se escribe un segundo humanizador para la misma caja alta.
   *
   * ⛔ Sólo para el PRODUCTO. El nombre del proveedor va verbatim, como lo tiene el ERP: es un
   * nombre legal en un documento de compras y no nos toca re-escribirlo. Medido en producción el
   * 2026-10-13: de 1,007 proveedores, **1,002 no traen razón social**, así que recortarla tampoco
   * compraba nada — y en los pocos que sí, "SPR DE RL" salía "Spr de Rl".
   */
  legible(s: string | null | undefined): string { return nombrePropio(s); }


  recargar(): void { this.reporteRes.reload(); }

  /**
   * Lo que el navegador debe ver en el documento aislado. Los estilos del componente SE CLONAN
   * (el helper copia los `<style>` del `<head>`, y los atributos de encapsulación viajan en el
   * HTML), así que acá sólo va lo que el papel necesita y la pantalla no:
   *
   *  - `.rp-hoja` vive en `display:none` salvo en la previa. En la hoja clonada hay que
   *    encenderla a mano, o se imprime una página en blanco si el usuario nunca abrió "Ver hoja".
   *  - `thead`/`tfoot` como grupos de encabezado y pie: es lo que los REPITE en cada página, y
   *    con eso cada hoja tiene su membrete, su pie y sus márgenes.
   *  - lo que no se parte: un renglón a la mitad y un encabezado de proveedor huérfano al pie.
   */
  private static readonly CSS_HOJA = [
    '.rp-hoja{display:block !important;width:auto !important;max-width:none !important;',
    'margin:0 !important;border:0 !important;border-radius:0 !important;box-shadow:none !important;',
    'background:#fff !important;color:#111 !important;overflow:visible !important;}',
    '.rp-doc{width:100%;}',
    '.rp-doc > thead{display:table-header-group;}',
    '.rp-doc > tfoot{display:table-footer-group;}',
    '.rp-hoja-tbl thead{display:table-header-group;}',
    '.rp-hoja-tbl tr{break-inside:avoid;page-break-inside:avoid;}',
    '.rp-portada{break-after:avoid;}',
  ].join('');

  private readonly hoja = viewChild<ElementRef<HTMLElement>>('hoja');
  readonly imprimiendo = signal(false);

  imprimir(): void {
    const el = this.hoja()?.nativeElement;
    if (!el || this.imprimiendo()) return;
    this.imprimiendo.set(true);
    printIsolated({
      html: el.outerHTML,
      // Carta, no A4: es el papel que hay en la oficina. Margen cero a propósito — los márgenes
      // de cada página los pone el membrete/pie repetido, y el cero apaga el encabezado que el
      // navegador imprime por su cuenta.
      page: 'size: letter portrait; margin: 0;',
      css: ComprasCatalogoReporteComponent.CSS_HOJA,
      bodyClass: 'rp-printing',
      fallbackClass: 'rp-fallback',
      onDone: () => this.imprimiendo.set(false),
    });
  }
}
