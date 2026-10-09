import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComercialService, Product, ProductStats, ProductSupplierOption, UpdateProductDto } from '../../comercial/comercial.service';
import { makeLazyLoad, makeDebouncedSearch } from '../../../shared/util';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { avisoDePrecio } from '../catalogo-precio-aviso';
import { ProductosNuevosService } from '../productos-nuevos.service';
import {
  CuidarRespuesta, FlujoLista, FlujoResumen, MotivoLider, ProductoACuidar, ProductosFlujoService, VeredictoCompra,
} from '../productos-flujo.service';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ProductoFlujoPanelComponent, VEREDICTO_CLASE, diasTexto, dinero, fechaCorta, variacionTexto } from './producto-flujo-panel.component';
import { catchError, of } from 'rxjs';

/** `[PF.1]` La situacion de compra en una palabra o dos, para la tabla. */
export const VEREDICTO_CORTO: Record<VeredictoCompra, string> = {
  comprar: 'Comprar', traspasar: 'Mover entre sucursales', esperar: 'Esperar', sobra: 'Sobra',
  no_comprar: 'No comprar', sin_movimiento: 'Sin movimiento',
};

/** `[PF.1]` "Estancado en 2 · Agotado en 1 · Caducado en 1" (o NULL si todo se mueve). */
export function alertasTexto(f: Pick<FlujoResumen, 'estancadas' | 'agotadas' | 'frenadas'> & Partial<Pick<FlujoResumen, 'caducidad'>>): string | null {
  const c = f.caducidad;
  const partes = [
    c && c.vencido > 0 ? `Caducado en ${c.plazas_vencido.length}` : null,
    c && c.en_riesgo > 0 ? `Caduca sin venderse en ${c.plazas_en_riesgo.length}` : null,
    f.estancadas.length ? `Estancado en ${f.estancadas.length}` : null,
    f.agotadas.length ? `Agotado en ${f.agotadas.length}` : null,
    f.frenadas.length ? `Se frenó en ${f.frenadas.length}` : null,
  ].filter((x): x is string => !!x);
  return partes.length ? partes.join(' · ') : null;
}

/** `[PF.2]` Por qué pide atención un líder, en palabras. */
export const MOTIVO_LIDER: Record<MotivoLider, string> = {
  agotado: 'Agotado en alguna sucursal', comprar: 'Comprar', mover: 'Mover entre sucursales', se_freno: 'Se frenó la venta',
};

/** `[PF.3]` La situación de caducidad de un producto en una frase, para "Para cuidar hoy". */
export function caducidadTexto(c: NonNullable<FlujoResumen['caducidad']>): { estado: 'caducado' | 'no_alcanza' | 'justo'; texto: string } {
  if (c.vencido > 0) return { estado: 'caducado', texto: `Caducado según el registro en ${c.plazas_vencido.join(', ')}` };
  if (c.en_riesgo > 0) return { estado: 'no_alcanza', texto: `No alcanza a venderse en ${c.plazas_en_riesgo.join(', ')}` };
  return { estado: 'justo', texto: 'Caduca pronto: ponerlo al frente' };
}

/** Lo que se abre en el panel lateral: un renglón de la tabla o un producto de "Para cuidar hoy". */
interface AbiertoFlujo {
  id: string;
  nombre: string | null;
  sku: string | null;
  brand_name?: string | null;
  /** Sólo desde la tabla: con él se puede editar. */
  producto?: Product;
}

@Component({
  selector: 'app-compras-catalogo',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    InputNumberModule,
    TextareaModule,
    ToggleSwitchModule,
    SelectModule,
    TableModule,
    TagModule,
    ToastModule,
    TooltipModule,
    SkeletonModule,
    MetricCardComponent,
    PageTabsComponent,
    SidePeekComponent,
    ProductoFlujoPanelComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page pp">
      <p-toast></p-toast>
    
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Catálogo de productos</h1>
          <p class="surf-page-sub">
            <b>{{ total() }}</b> SKU{{ total() === 1 ? '' : 's' }}
            <span class="pp-divider" aria-hidden="true">·</span>
            sincronizado desde Mega_Dulces ERP
          </p>
        </div>
        <div class="pp-head-actions">
          <button pButton [text]="true" severity="secondary" size="small" (click)="refresh()" [loading]="loading()" pTooltip="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <!--
        De donde sale el precio y que tan viejo es. Va arriba y sin boton de cerrar porque es una
        condicion del dato, no el resultado de una accion. La lista NO tiene sucursal: el numero es
        uno solo para toda la red, y eso hay que decirlo, no dejarlo suponer.
        (Sin acentos graves aca adentro: cierran el template literal de JS.)
      -->
      @if (avisoPrecio(); as a) {
        <div class="pp-aviso" [class.pp-aviso-warn]="a.viejo" role="status">
          <i [class]="a.viejo ? 'pi pi-clock' : 'pi pi-info-circle'" aria-hidden="true"></i>
          <div>
            <strong>{{ a.titulo }}</strong>
            <span>{{ a.detalle }}</span>
          </div>
        </div>
      }

      <!-- Toolbar -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush pp-filters-cell">
          <div class="pp-toolbar">
            <!-- Search -->
            <div class="pp-search">
              <i class="pi pi-search pp-search-icon" aria-hidden="true"></i>
              <input
                type="search"
                [value]="searchInput"
                (input)="onSearchChange($any($event.target).value)"
                placeholder="Buscar nombre, SKU, barcode o descripción…"
                inputmode="search"
                autocomplete="off"
                spellcheck="false"
                aria-label="Buscar productos"
                />
                @if (searchInput) {
                  <button
                    type="button"
                    class="pp-search-clear"
                    (click)="clearSearch()"
                    aria-label="Limpiar"
                    >
                    <i class="pi pi-times" aria-hidden="true"></i>
                  </button>
                }
              </div>
    
              <!-- Supplier filter -->
              <p-select
                [options]="suppliers()"
                optionLabel="name"
                optionValue="id"
                [ngModel]="selectedSupplier()"
                (onChange)="onSupplierChange($event.value)"
                [filter]="true"
                filterBy="name"
                [showClear]="true"
                placeholder="Todos los proveedores"
                emptyFilterMessage="Sin coincidencias"
                styleClass="pp-supplier-select"
                appendTo="body"
                scrollHeight="320px"
                >
                <ng-template let-s #item>
                  <div class="pp-sup-opt">
                    <span class="pp-sup-name">{{ s.name }}</span>
                    <span class="pp-sup-count">{{ s.product_count }}</span>
                  </div>
                </ng-template>
              </p-select>
    
              <!-- Only with cost (importer validation) -->
              <label class="pp-toggle">
                <p-toggleswitch [ngModel]="onlyWithCost()" (ngModelChange)="onOnlyWithCostChange($event)"></p-toggleswitch>
                <span>Sólo con costo</span>
              </label>
    
              <div class="pp-toolbar-spacer"></div>
    
              <!-- Reset -->
              @if (hasActiveFilters()) {
                <button
                  type="button"
                  class="pp-reset"
                  (click)="resetFilters()"
                  >
                  <i class="pi pi-refresh" aria-hidden="true"></i>
                  <span>Reset</span>
                </button>
              }
            </div>
          </article>
        </div>
    
        <!-- KPI BENTO — agregados catálogo-wide (no del paginado) -->
        @if (!stats()) {
          <p-skeleton height="132px"></p-skeleton>
        }
        @if (stats(); as s) {
          <div class="surf-grid pp-bento">
            <app-metric-card class="panel-col-3"
              label="SKUs en catálogo" [value]="s.total" format="number"
              accent="var(--action)"
              [variant]="brandSeries().length > 1 ? 'bars' : 'plain'"
              [series]="brandSeries()" [seriesLabels]="brandLabels()" [highlightLast]="false"
            [sub]="s.brands + ' marcas · ' + s.categories + ' categorías'"></app-metric-card>
            <app-metric-card class="panel-col-3" variant="progress"
              label="Activos" [value]="s.active" [goal]="s.total" format="number"
            accent="var(--ok-fg)" sub="visibles en portal y vendedor"></app-metric-card>
            <app-metric-card class="panel-col-3" variant="progress"
              label="Con costo" [value]="s.with_cost" [goal]="s.total" format="number"
            accent="var(--chart-2)" sub="validados desde el ERP"></app-metric-card>
            <app-metric-card class="panel-col-3" variant="progress"
              label="Con precio al cliente" [value]="s.with_price" [goal]="s.total" format="number"
            accent="var(--chart-6)" [sub]="subtituloPrecio()"></app-metric-card>
          </div>
        }
    
        <!-- [PF.2]/[PF.3] Para cuidar hoy: los lideres que piden atencion y lo que caduca antes de venderse. -->
        @if (cuidar(); as c) {
          <section class="pc" aria-label="Para cuidar hoy">
            <article class="pc-card">
              <header class="pc-head">
                <h2 class="pc-t">Líderes que piden atención</h2>
                <span class="pc-n">{{ c.lideres.piden_atencion.length }} de {{ c.lideres.total }} líderes</span>
              </header>
              <div class="pc-chips" role="group" aria-label="Filtrar por motivo">
                <button type="button" class="pc-chip" [class.is-on]="motivo() === null" (click)="motivo.set(null)">Todos · {{ c.lideres.piden_atencion.length }}</button>
                @for (m of motivos; track m) {
                  @if (c.lideres.por_motivo[m]) {
                    <button type="button" class="pc-chip" [class.is-on]="motivo() === m" (click)="motivo.set(m)">{{ motivoTexto(m) }} · {{ c.lideres.por_motivo[m] }}</button>
                  }
                }
              </div>
              @if (lideresVista(); as ls) {
                <ul class="pc-lista">
                  @for (x of ls; track x.resumen.product_id) {
                    <li>
                      <button type="button" class="pc-item" (click)="abrirCuidar(x)">
                        <span class="pc-rank">#{{ x.resumen.lider?.rank }}</span>
                        <span class="pc-cuerpo">
                          <span class="pc-nom">{{ x.nombre || x.sku }}</span>
                          <span class="pc-det">
                            <span class="pp-ver" [ngClass]="claseVeredicto(x.resumen.compra.veredicto)">{{ x.resumen.compra.titulo }}</span>
                            @if (x.resumen.agotadas.length) { <span>Agotado en {{ nombresDe(x.resumen.agotadas) }}</span> }
                          </span>
                        </span>
                        @if ((x.en_juego_dia ?? 0) > 0) {
                          <span class="pc-dinero" pTooltip="Lo que ya se deja de vender por día donde está agotado; si se acaba en menos de una semana, toda su venta por día.">{{ dinero(x.en_juego_dia) }}<small>por día</small></span>
                        }
                      </button>
                    </li>
                  } @empty {
                    <li class="pc-vacio">Ningún líder pide atención por este motivo.</li>
                  }
                </ul>
                @if (lideresFiltrados().length > ls.length) {
                  <button type="button" class="pc-mas" (click)="verTodos.set(true)">Ver los {{ lideresFiltrados().length }}</button>
                }
              }
              <p class="pc-meta">Líder = está entre los {{ c.lideres.total }} productos que juntos hacen la mitad de la venta de la red en 90 días
                (nuestra venta, no participación de mercado). Primero lo que más se juega por día.
                @if (c.lideres.calculado) { Ranking al {{ hora(c.lideres.calculado) }}. }</p>
            </article>

            <article class="pc-card">
              <header class="pc-head">
                <h2 class="pc-t">Caducan antes de venderse</h2>
                <span class="pc-n">{{ c.caducidad.productos.length }} producto{{ c.caducidad.productos.length === 1 ? '' : 's' }}</span>
              </header>
              <ul class="pc-lista">
                @for (x of c.caducidad.productos; track x.resumen.product_id) {
                  @let cad = caducidad(x);
                  <li>
                    <button type="button" class="pc-item" (click)="abrirCuidar(x)">
                      <span class="pc-cuerpo">
                        <span class="pc-nom">{{ x.nombre || x.sku }}</span>
                        <span class="pc-det">
                          <span class="pc-cad" [ngClass]="'is-' + cad.estado">{{ cad.texto }}</span>
                        </span>
                      </span>
                      @if (x.resumen.caducidad?.proxima; as f) {
                        <span class="pc-fecha">{{ fecha(f) }}<small>{{ diasA(f) }}</small></span>
                      }
                    </button>
                  </li>
                } @empty {
                  <li class="pc-vacio">Ningún lote registrado está por caducar sin venderse.</li>
                }
              </ul>
              <p class="pc-meta">Sólo lo que tiene fecha registrada en el andén o en la revisión de caducidades:
                {{ c.caducidad.cobertura.lotes }} lotes de {{ c.caducidad.cobertura.productos }} productos
                @if (c.caducidad.cobertura.sucursales.length) { en {{ nombresDe(c.caducidad.cobertura.sucursales) }} }.
                Lo que no tiene fecha registrada no aparece aquí, y eso no quiere decir que no caduque.</p>
            </article>
          </section>
        } @else if (cuidarError()) {
          <p class="pc-meta" role="alert">No se pudo cargar «Para cuidar hoy».</p>
        } @else {
          <p-skeleton height="180px"></p-skeleton>
        }

        <!-- Table -->
        <div class="sheet cols-12">
          <article class="cell cell-span-12 is-flush">
            <p-table
              [value]="rows()"
              [loading]="loading()"
              [lazy]="true"
              [paginator]="true"
              [rows]="pageSize()"
              [totalRecords]="total()"
              [first]="(page() - 1) * pageSize()"
              [rowsPerPageOptions]="[25, 50, 100, 200]"
              (onLazyLoad)="onLazyLoad($event)"
             
              styleClass="p-datatable-sm pp-table surf-table surf-table--sticky surf-table--frozen-first"
              [rowHover]="true"
              >
              <ng-template #header>
                <tr>
                  <th scope="col">Producto</th>
                  <th scope="col">SKU</th>
                  <th scope="col" class="comm-num" pTooltip="Venta con impuestos del 1 a hoy, contra los mismos días del mes anterior. En vivo.">Este mes</th>
                  <th scope="col">Situación</th>
                  <th scope="col">Marca</th>
                  <th scope="col">Proveedor</th>
                  <th scope="col">Categoría</th>
                  <th scope="col">Ubic.</th>
                  <th scope="col" class="comm-num">Costo</th>
                  <th scope="col" class="comm-num">Precio al cliente</th>
                  <th scope="col" class="comm-num">Unidad</th>
                  <th scope="col">Estado</th>
                  <th scope="col"><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-p>
                <tr (click)="abrirFlujo(p)" (keydown.enter)="abrirFlujo(p)" (keydown.space)="$event.preventDefault(); abrirFlujo(p)"
                  tabindex="0" role="button" [attr.aria-label]="'Ver cómo se vende ' + p.nombre" class="comm-row-clickable">
                  @let fl = flujo().get(p.id);
                  <td>
                    <div class="comm-cell-strong" [pTooltip]="p.description || ''" tooltipPosition="right" [tooltipDisabled]="!p.description">
                      {{ p.nombre }}
                    </div>
                    @if (fl?.lider; as l) {
                      <span class="pp-lider" pTooltip="Está entre los productos que juntos hacen la mitad de la venta de la red en 90 días">Líder #{{ l.rank }}</span>
                    }
                    @if (nuevo(p.id); as nv) {
                      <span class="pp-nuevo" pTooltip="Producto nuevo en seguimiento: ver la pestaña Productos nuevos">{{ nv }}</span>
                    }
                    @if (p.barcode) {
                      <div class="comm-muted is-small">{{ p.barcode }}</div>
                    }
                  </td>
                  <td>
                    @if (p.sku) {
                      <code class="comm-code">{{ p.sku }}</code>
                    }
                    @if (!p.sku) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <!-- [PF.1] El mes contra los mismos dias del anterior y la situacion de compra. -->
                  <td class="comm-num">
                    @if (fl) {
                      <span class="pp-mes">{{ dinero(fl.mes) }}</span>
                      <span class="pp-var" [class.is-up]="(fl.variacion ?? 0) > 0" [class.is-down]="(fl.variacion ?? 0) < 0"
                            [pTooltip]="'Mismos días del mes anterior: ' + dinero(fl.mes_anterior_mismo)">{{ variacion(fl.variacion) }}</span>
                    } @else {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td>
                    @if (fl) {
                      <span class="pp-ver" [ngClass]="claseVeredicto(fl.compra.veredicto)" [pTooltip]="fl.compra.titulo">{{ veredictoCorto(fl.compra.veredicto) }}</span>
                      @if (alertas(fl); as a) { <span class="pp-alerta">{{ a }}</span> }
                    } @else {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td>
                    @if (p.brand_name) {
                      <span class="pp-brand-tag">{{ p.brand_name }}</span>
                    }
                    @if (!p.brand_name) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td>
                    @if (p.supplier_name) {
                      <span class="pp-sup-tag" [pTooltip]="p.supplier_name" tooltipPosition="top">{{ p.supplier_name }}</span>
                    }
                    @if (!p.supplier_name) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td>
                    @if (p.category_name) {
                      <span class="pp-cat-tag">{{ p.category_name }}</span>
                    }
                    @if (!p.category_name) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td>
                    @if (p.location) {
                      <code class="comm-code pp-loc-code">{{ p.location }}</code>
                    }
                    @if (!p.location) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td class="comm-num">
                    @if (p.cost_base != null) {
                      <span>{{ p.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                    }
                    @if (p.cost_base == null) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td class="comm-num">
                    @if (p.price_customer != null) {
                      <span class="pp-pv">{{ p.price_customer | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                      @if (p.price_min_qty && p.price_min_qty > 1) {
                        <span class="comm-muted is-small pp-pv-qty">desde {{ p.price_min_qty }}</span>
                      }
                    } @else {
                      <span class="comm-muted" pTooltip="Este producto no tiene precio publicado en la lista de mostrador."
                            tooltipPosition="left">sin precio</span>
                    }
                  </td>
                  <td class="comm-num">
                    @if (p.unit_sale) {
                      <span>{{ p.unit_sale }}@if (p.factor_sale && p.factor_sale > 1) {
                        <span class="comm-muted is-small"> × {{ p.factor_sale }}</span>
                      }</span>
                    }
                    @if (!p.unit_sale) {
                      <span class="comm-muted">—</span>
                    }
                  </td>
                  <td>
                    <span class="pp-status" [class.is-on]="p.activo">
                      <span class="pp-status-dot" aria-hidden="true"></span>
                      {{ p.activo ? 'Activo' : 'Inactivo' }}
                    </span>
                  </td>
                  <td class="comm-actions">
                    <button pButton size="small" severity="secondary" [text]="true" (click)="$event.stopPropagation(); openEdit(p)" pTooltip="Editar"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr>
                  <td colspan="13" class="comm-empty-cell">
                    <div class="comm-empty">
                      <div class="comm-empty-icon"><i [class]="searchInput ? 'pi pi-search' : 'pi pi-box'" aria-hidden="true"></i></div>
                      <h3>{{ searchInput ? 'Sin resultados' : 'Sin productos' }}</h3>
                      @if (searchInput) {
                        <p>No se encontraron productos con "{{ searchInput }}".</p>
                      }
                      @if (!searchInput) {
                        <p>Sincronizar desde Mega_Dulces ERP:</p>
                      }
                      @if (!searchInput) {
                        <code class="comm-code pp-empty-cmd">database/importers/mega_dulces_sync.js --scope=products</code>
                      }
                    </div>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </article>
        </div>
      </div>
    
      <!-- [PF.1] Como se vende el producto: flujo contra el mes anterior, sucursales y si hace falta comprar. -->
      <app-side-peek [open]="abierto() !== null" (openChange)="$event ? null : cerrarFlujo()" [width]="880"
                     [title]="abierto()?.nombre || ''" [subtitle]="abierto() ? ((abierto()!.sku || '') + (abierto()!.brand_name ? ' · ' + abierto()!.brand_name : '')) : null">
        @if (abierto(); as a) {
          @if (a.producto; as prod) {
            <div class="pp-peek-acciones">
              <button pButton size="small" severity="secondary" [outlined]="true" (click)="openEdit(prod)">
                <span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span><span class="p-button-label">Editar producto</span></button>
            </div>
          }
          <app-producto-flujo-panel [productId]="a.id" />
        }
      </app-side-peek>

      <!-- Edit Dialog -->
      <p-dialog
        [(visible)]="dialogVisible"
        [modal]="true"
        [draggable]="false"
        [style]="{ width: '560px' }"
        [header]="editing()?.nombre || 'Editar producto'"
        >
        @if (editing(); as e) {
          <div class="pp-edit-body">
            <div class="pp-edit-meta">
              <div><span class="comm-muted is-small">SKU</span> <code class="comm-code">{{ e.sku || '—' }}</code></div>
              @if (e.brand_name) {
                <div><span class="comm-muted is-small">Marca</span> <strong>{{ e.brand_name }}</strong></div>
              }
              @if (e.cost_base != null) {
                <div><span class="comm-muted is-small">Costo base</span> <strong>{{ e.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
              }
              @if (e.prices_count != null) {
                <div><span class="comm-muted is-small">Precios configurados</span> <strong>{{ e.prices_count }}</strong></div>
              }
              @if (e.total_available != null) {
                <div><span class="comm-muted is-small">Stock disponible</span> <strong>{{ fmtNumber(e.total_available) }}</strong></div>
              }
            </div>
            <form [formGroup]="form" class="comm-form">
              <label>
                <span>Descripción larga</span>
                <textarea pInputTextarea rows="3" formControlName="description" maxlength="500"></textarea>
                <span class="comm-muted is-small">Visible en el Portal y la app de vendedores en hover sobre el nombre.</span>
              </label>
              <div class="pp-form-row">
                <label>
                  <span>Ubicación</span>
                  <input pInputText formControlName="location" maxlength="20" placeholder="ej: Z000" />
                </label>
                <label>
                  <span>Ubicación bodega</span>
                  <input pInputText formControlName="location_warehouse" maxlength="20" placeholder="ej: B-12" />
                </label>
              </div>
              <label>
                <span>Puntos de fidelidad</span>
                <p-inputnumber formControlName="loyalty_points" [min]="0" [showButtons]="true"></p-inputnumber>
              </label>
              <label class="pp-toggle-line">
                <p-toggleswitch formControlName="activo"></p-toggleswitch>
                <span>Activo en catálogo</span>
                <span class="comm-muted is-small">(si lo desactivás, no aparece en portal ni vendor)</span>
              </label>
            </form>
          </div>
        }
        <ng-template #footer>
          <button pButton severity="secondary" [outlined]="true" (click)="dialogVisible = false"><span class="p-button-label">Cancelar</span></button>
          <button pButton [loading]="saving()" [disabled]="form.invalid" (click)="save()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar</span></button>
        </ng-template>
      </p-dialog>
    `,
  styles: [`
    .pp-mes { display: block; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .pp-var { display: block; font-size: var(--fs-xs); color: var(--c-text-3); font-family: var(--font-mono); }
    .pp-var.is-up { color: var(--ok-fg); }
    .pp-var.is-down { color: var(--bad-fg); }
    .pp-ver { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      border: 1px solid var(--c-divider); color: var(--c-text-2); white-space: nowrap; }
    .pp-ver.is-comprar { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .pp-ver.is-traspasar { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .pp-ver.is-sobra, .pp-ver.is-no { color: var(--ok-fg); background: var(--ok-soft-bg); }
    .pp-alerta { display: block; margin-top: .15rem; font-size: var(--fs-xs); color: var(--c-text-3); white-space: nowrap; }
    .pp-peek-acciones { display: flex; justify-content: flex-end; margin-bottom: .75rem; }
    .pp-nuevo { display: inline-block; margin-top: .2rem; padding: .05rem .45rem; border-radius: 999px;
      border: 1px solid var(--action); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-1); }
    :host { display: block; }
    .pp-head-actions { display: flex; gap: 0.5rem; align-items: center; }
    .pp-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    .pp-bento { margin-bottom: 1rem; }
    .pp-lider { display: inline-block; margin: .2rem .3rem 0 0; padding: .05rem .45rem; border-radius: 999px; font-size: var(--fs-xs);
      font-weight: var(--fw-bold); color: var(--action); border: 1px solid currentColor; }
    .pc { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr)); gap: 1rem; margin-bottom: 1rem; }
    .pc-card { display: flex; flex-direction: column; gap: .5rem; min-width: 0; border: 1px solid var(--c-divider); border-radius: 12px;
      background: var(--c-surface-1); padding: .8rem .9rem; }
    .pc-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
    .pc-t { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pc-n { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pc-chips { display: flex; flex-wrap: wrap; gap: .35rem; }
    .pc-chip { border: 1px solid var(--c-divider); background: var(--c-surface-1); color: var(--c-text-2); border-radius: 999px;
      padding: .15rem .6rem; font-size: var(--fs-xs); cursor: pointer; min-height: 1.75rem; }
    .pc-chip.is-on { background: var(--c-text-1); border-color: var(--c-text-1); color: var(--c-surface-1); font-weight: var(--fw-bold); }
    .pc-chip:focus-visible, .pc-item:focus-visible, .pc-mas:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pc-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 22rem; overflow-y: auto; }
    .pc-lista > li + li { border-top: 1px solid var(--c-divider); }
    .pc-item { width: 100%; display: flex; align-items: center; gap: .6rem; padding: .45rem .25rem; background: none; border: 0;
      text-align: left; cursor: pointer; color: inherit; font: inherit; }
    .pc-item:hover { background: var(--c-surface-2); }
    .pc-rank { flex-shrink: 0; min-width: 2.4rem; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pc-cuerpo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .pc-nom { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pc-det { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pc-dinero, .pc-fecha { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pc-dinero small, .pc-fecha small { font-family: var(--font-sans, inherit); font-size: var(--fs-xs); font-weight: normal; color: var(--c-text-3); }
    .pc-cad { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-weight: var(--fw-bold); border: 1px solid var(--c-divider); }
    .pc-cad.is-caducado, .pc-cad.is-no_alcanza { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .pc-cad.is-justo { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .pc-vacio { padding: .6rem .25rem; font-size: var(--fs-sm); color: var(--c-text-3); }
    .pc-mas { align-self: flex-start; background: none; border: 0; padding: .2rem 0; color: var(--action); font-size: var(--fs-sm);
      font-weight: var(--fw-bold); cursor: pointer; }
    .pc-meta { margin: 0; font-size: var(--fs-xs); color: var(--c-text-3); }

    .pp-filters-cell { display: flex; flex-direction: column; }
    .pp-toolbar {
      display: flex; align-items: center; gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .pp-toolbar-spacer { flex: 1; min-width: 0; }

    .pp-search {
      display: inline-flex; align-items: center;
      height: 32px;
      width: 320px; max-width: 100%;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .pp-search:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
    }
    .pp-search-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    .pp-search input {
      flex: 1; background: transparent;
      border: none !important; outline: none !important; box-shadow: none !important;
      -webkit-appearance: none; appearance: none;
      font-size: var(--fs-sm); color: var(--c-text-1);
      min-width: 0; padding: 0; height: 28px;
    }
      .pp-search input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .pp-search input::placeholder { color: var(--c-text-3); }
    /* Sin la "x" nativa del type=search (ya hay botón propio de limpiar). */
    .pp-search input::-webkit-search-cancel-button { display: none; }
    .pp-search-clear {
      background: transparent; border: none;
      width: 22px; height: 22px;
      border-radius: 4px;
      color: var(--c-text-3); cursor: pointer;
      display: grid; place-items: center; flex-shrink: 0;
      font-size: var(--fs-xs);
    }
    .pp-search-clear:hover { color: var(--c-text-1); background: var(--c-surface-2); }


    .pp-pv { font-weight: var(--fw-bold); }
    .pp-pv-qty { display: block; }

    .pp-aviso {
      display: flex; gap: .55rem; align-items: flex-start;
      padding: .5rem .75rem; margin: .75rem 0 0;
      border: 1px solid var(--c-divider); border-left-width: 3px;
      border-radius: 6px; background: var(--c-surface-1);
      font-size: var(--fs-xs); color: var(--c-text-2);
    }
    .pp-aviso-warn { border-left-color: var(--warn-fg); background: var(--warn-soft-bg); }
    .pp-aviso i { margin-top: .1rem; }
    .pp-aviso strong { display: block; color: var(--c-text-1); }

    .pp-toggle {
      display: inline-flex; align-items: center; gap: .5rem;
      font-size: var(--fs-xs); color: var(--c-text-2);
    }

    .pp-reset {
      display: inline-flex; align-items: center; gap: .35rem;
      height: 32px; padding: 0 .75rem;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      color: var(--c-text-2);
      font-size: var(--fs-xs); font-weight: var(--fw-medium);
      cursor: pointer;
    }
    .pp-reset:hover { color: var(--c-text-1); border-color: var(--c-text-1); background: var(--c-surface-2); }
    .pp-reset i { font-size: var(--fs-xs); }

    .pp-brand-tag, .pp-cat-tag, .pp-sup-tag {
      display: inline-block;
      padding: .15rem .55rem;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      border-radius: 6px;
      font-weight: var(--fw-medium);
      white-space: nowrap;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: middle;
    }

    /* Filtro de proveedor */
    .pp-supplier-select { min-width: 210px; }
    .pp-sup-opt { display: flex; align-items: center; justify-content: space-between; gap: 1rem; width: 100%; }
    .pp-sup-count { font-size: var(--fs-xs); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
    .pp-loc-code {
      font-size: var(--fs-xs);
      padding: .1rem .35rem;
      letter-spacing: 0.04em;
    }
    .pp-status {
      display: inline-flex; align-items: center; gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-3);
    }
    .pp-status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--c-text-3);
    }
    .pp-status.is-on { color: var(--c-text-1); }
    .pp-status.is-on .pp-status-dot { background: var(--c-ok); }

    .pp-empty-cmd { display: inline-block; padding: .4rem .75rem; font-size: var(--fs-xs); }

    /* ── Edit dialog ── */
    .pp-edit-body { display: flex; flex-direction: column; gap: 1rem; }
    .pp-edit-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .65rem 1rem;
      padding: .75rem 1rem;
      background: var(--c-surface-2);
      border-radius: 8px;
    }
    .pp-edit-meta > div { display: flex; flex-direction: column; gap: .15rem; }
    .pp-edit-meta strong { font-variant-numeric: tabular-nums; color: var(--c-text-1); }
    .pp-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .pp-toggle-line {
      display: flex !important; flex-direction: row !important;
      align-items: center; gap: .65rem;
    }
    .pp-toggle-line > span:first-of-type { font-weight: var(--fw-medium); }

    @media (max-width: 40rem) {
      .pp-edit-meta, .pp-form-row { grid-template-columns: 1fr; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComprasCatalogoComponent {
  readonly tabs = CATALOGO_TABS;

  /**
   * [RP.12] De donde sale el precio y que tan viejo es.
   *
   * Dos cosas que la pantalla NO puede callar: (1) es la lista de mostrador, una sola para toda la
   * red — la fase RP existe porque el precio difiere entre las 7 sucursales, y este numero no lo
   * muestra; (2) la alimenta un importer desde la DB legacy, asi que puede llevar semanas parada.
   * El umbral son 7 dias: mas que eso ya no es "el precio de hoy".
   *
   * [CAT.PRECIO] La logica vive en `catalogo-precio-aviso.ts`, como funcion pura con el reloj
   * inyectado: adentro de un `computed()` no se puede probar sin montar Angular, y con `Date.now()`
   * adentro la prueba depende de la hora del que la corre. El candado esta en su `.spec.ts`.
   */
  readonly avisoPrecio = computed(() => avisoDePrecio(this.stats(), Date.now()));

  readonly subtituloPrecio = computed(() => {
    const st = this.stats();
    if (!st) return 'lista de mostrador';
    const sin = st.total - st.with_price;
    return sin > 0 ? sin.toLocaleString('es-MX') + ' sin precio publicado' : 'todos con precio';
  });

  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  // Paginación
  readonly page = signal(1);
  readonly pageSize = signal(50);

  // Filtros (todas señales → alimentan los rxResource)
  searchInput = '';
  readonly searchSignal = signal('');

  readonly onlyWithCost = signal(false);
  readonly selectedSupplier = signal<string | null>(null);

  // ── Lecturas reactivas (Resource API, Angular 22) ──
  // Listado paginado: se recarga solo cuando cambia cualquier filtro/página y
  // cancela la petición vieja si otra la reemplaza.
  private readonly listRes = rxResource({
    params: () => ({
      page: this.page(),
      pageSize: this.pageSize(),
      search: this.searchSignal() || undefined,
      supplier_id: this.selectedSupplier() || undefined,
      with_cost: this.onlyWithCost() || undefined,
    }),
    stream: ({ params }) => this.api.listProducts(params),
  });
  readonly rows = computed<Product[]>(() => this.listRes.value()?.data ?? []);
  readonly total = computed(() => this.listRes.value()?.pagination?.total ?? 0);
  readonly loading = computed(() => this.listRes.isLoading());

  // Agregados catálogo-wide: solo dependen del search (no del segmento/costo ni del paginado).
  private readonly statsRes = rxResource({
    params: () => this.searchSignal(),
    stream: ({ params }) => this.api.productStats(params || undefined),
  });
  readonly stats = computed<ProductStats | null>(() => this.statsRes.value() ?? null);
  readonly brandSeries = computed(() => this.stats()?.top_brands.map((b) => b.sku_count) ?? []);
  readonly brandLabels = computed(() => this.stats()?.top_brands.map((b) => b.name) ?? []);

  // Proveedores para el dropdown (one-shot).
  private readonly suppliersRes = rxResource({
    params: () => true,
    stream: () => this.api.productSuppliers(),
  });
  readonly suppliers = computed<ProductSupplierOption[]>(() => this.suppliersRes.value() ?? []);

  // [NP.5] La etiqueta "Nuevo · dia N". Se pide UNA vez; si falla, la lista sigue sin etiqueta:
  // el catalogo no puede caerse porque el seguimiento de nuevos no respondio.
  private readonly nuevos = inject(ProductosNuevosService);
  private readonly nuevosRes = rxResource({
    params: () => true,
    stream: () => this.nuevos.listar().pipe(catchError(() => of(null))),
  });
  private readonly etiquetasNuevo = computed(() => {
    const m = new Map<string, string>();
    for (const f of this.nuevosRes.value()?.filas ?? []) {
      if (f.estado === 'seguimiento' && f.etapa !== 'graduado' && f.dia !== null) m.set(f.product_id, `Nuevo · día ${f.dia}`);
      else if (f.estado === 'sin_movimiento') m.set(f.product_id, 'Nuevo · sin movimiento');
    }
    return m;
  });
  nuevo(id: string): string | null {
    return this.etiquetasNuevo().get(id) ?? null;
  }

  // [PF.1] Flujo de venta de los productos de la pagina: el mes contra los mismos dias del anterior,
  // en vivo (cada minuto, sin vaciar la columna mientras llega lo nuevo) y la situacion de compra.
  private readonly flujoApi = inject(ProductosFlujoService);
  private readonly recargaFlujo = signal(0);
  private readonly flujoRes = rxResource({
    params: () => {
      const ids = this.rows().map((r) => r.id);
      return ids.length ? { ids, v: this.recargaFlujo() } : undefined;
    },
    stream: ({ params }) => (params ? this.flujoApi.listar(params.ids).pipe(catchError(() => of(null))) : of(null)),
  });
  /** Por producto, lo ultimo que llego: una recarga o un error no borran la columna. */
  readonly flujo = linkedSignal<FlujoLista | null | undefined, Map<string, FlujoResumen>>({
    source: () => this.flujoRes.value(),
    computation: (nuevo, previo) => {
      const m = new Map(previo?.value ?? []);
      for (const x of nuevo?.productos ?? []) m.set(x.product_id, x);
      return m;
    },
  });
  readonly abierto = signal<AbiertoFlujo | null>(null);
  readonly dinero = dinero;
  readonly variacion = variacionTexto;

  abrirFlujo(p: Product): void { this.abierto.set({ id: p.id, nombre: p.nombre, sku: p.sku ?? null, brand_name: p.brand_name ?? null, producto: p }); }
  abrirCuidar(x: ProductoACuidar): void { this.abierto.set({ id: x.resumen.product_id, nombre: x.nombre, sku: x.sku }); }
  cerrarFlujo(): void { this.abierto.set(null); }
  claseVeredicto(v: VeredictoCompra): string { return VEREDICTO_CLASE[v]; }
  veredictoCorto(v: VeredictoCompra): string { return VEREDICTO_CORTO[v]; }
  alertas(f: FlujoResumen): string | null { return alertasTexto(f); }

  // [PF.2]/[PF.3] Para cuidar hoy: igual para todo el tenant; se refresca cada minuto con lo demas y no se
  // vacia mientras llega lo nuevo.
  private readonly cuidarRes = rxResource({
    params: () => ({ v: this.recargaFlujo() }),
    stream: () => this.flujoApi.cuidar(),
  });
  readonly cuidar = linkedSignal<CuidarRespuesta | undefined, CuidarRespuesta | null>({
    source: () => (this.cuidarRes.error() ? undefined : this.cuidarRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly cuidarError = computed(() => !!this.cuidarRes.error() && !this.cuidar());
  readonly motivos: MotivoLider[] = ['agotado', 'comprar', 'mover', 'se_freno'];
  readonly motivo = signal<MotivoLider | null>(null);
  readonly verTodos = signal(false);
  readonly lideresFiltrados = computed(() => {
    const m = this.motivo();
    const xs = this.cuidar()?.lideres.piden_atencion ?? [];
    return m ? xs.filter((x) => x.motivos?.includes(m)) : xs;
  });
  /** Los primeros 8; con "Ver todos", todos (la lista tiene su propio scroll). */
  readonly lideresVista = computed(() => (this.verTodos() ? this.lideresFiltrados() : this.lideresFiltrados().slice(0, 8)));
  readonly fecha = fechaCorta;
  motivoTexto(m: MotivoLider): string { return MOTIVO_LIDER[m]; }
  caducidad(x: ProductoACuidar) { return caducidadTexto(x.resumen.caducidad!); }
  nombresDe(xs: Array<{ plaza: string; nombre: string | null }>): string { return xs.map((x) => x.nombre || 'Sucursal ' + x.plaza).join(', '); }
  /** Días que faltan para una fecha, desde hoy en México. */
  diasA(f: string): string {
    const hoy = this.cuidar()?.periodos.hoy ?? new Date().toISOString().slice(0, 10);
    return diasTexto(Math.round((Date.parse(f + 'T00:00:00Z') - Date.parse(hoy + 'T00:00:00Z')) / 86_400_000));
  }
  hora(iso: string): string {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  }

  // Edit dialog
  readonly editing = signal<Product | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;
  form: FormGroup = this.fb.group({
    description: [''],
    location: [''],
    location_warehouse: [''],
    loyalty_points: [0],
    activo: [true],
  });

  constructor() {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.recargaFlujo.update((n) => n + 1);
    }, 60_000);
    this.destroyRef.onDestroy(() => clearInterval(id));
    // Toast en error de la lectura principal (equivale al catch del subscribe viejo).
    effect(() => {
      if (this.listRes.error()) {
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar productos' });
      }
    });
  }

  /** Fuerza recarga manual (botón refrescar / tras guardar). */
  refresh(): void {
    this.listRes.reload();
    this.statsRes.reload();
  }

  onSupplierChange(id: string | null): void {
    this.selectedSupplier.set(id);
    this.reload();
  }

  /** Vuelve a la primera página; los rxResource se recargan solos al cambiar la señal. */
  reload(): void {
    this.page.set(1);
  }

  onSearchChange(v: string): void {
    this.searchInput = v;
    this.searchDebounced(v);
  }
  private readonly searchDebounced = makeDebouncedSearch((v) => {
    this.searchSignal.set((v || '').trim());
    this.page.set(1);
  });

  clearSearch(): void {
    this.searchInput = '';
    this.searchSignal.set('');
    this.page.set(1);
  }

  onOnlyWithCostChange(v: boolean): void {
    this.onlyWithCost.set(v);
    this.reload();
  }

  resetFilters(): void {
    this.searchInput = '';
    this.searchSignal.set('');
    this.onlyWithCost.set(false);
    this.selectedSupplier.set(null);
    this.page.set(1);
  }

  hasActiveFilters(): boolean {
    return !!this.searchSignal() || this.onlyWithCost() || !!this.selectedSupplier();
  }

  // El evento lazy solo actualiza page/pageSize (señales); el rxResource reacciona → no-op.
  readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => undefined);

  openEdit(p: Product): void {
    // Buscar el detalle completo para traer prices_count, total_available.
    this.api.findProduct(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (full) => {
        this.editing.set(full);
        this.form.reset({
          description: full.description || '',
          location: full.location || '',
          location_warehouse: full.location_warehouse || '',
          loyalty_points: full.loyalty_points || 0,
          activo: full.activo,
        });
        this.dialogVisible = true;
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar detalle' }),
    });
  }

  save(): void {
    const e = this.editing();
    if (!e || this.form.invalid) return;
    this.saving.set(true);
    const v = this.form.value;
    const payload: UpdateProductDto = {
      description: v.description?.trim() || null,
      location: v.location?.trim() || null,
      location_warehouse: v.location_warehouse?.trim() || null,
      loyalty_points: v.loyalty_points == null ? null : Number(v.loyalty_points),
      activo: !!v.activo,
    };
    this.api.updateProduct(e.id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: 'Producto actualizado' });
        this.refresh();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  fmtNumber(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX').format(Number(n));
  }
}
