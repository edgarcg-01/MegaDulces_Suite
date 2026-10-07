import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { CATALOGO_TABS } from '../catalogo-tabs';
import {
  ClasificacionNueva,
  EtapaNueva,
  HitoNuevo,
  ProductoNuevo,
  ProductosNuevosService,
} from '../productos-nuevos.service';

/** Los filtros, en el orden en que se revisan. El primero es lo que de verdad se sigue. */
export type VistaNuevos =
  | 'seguimiento' | 'mes_1' | 'mes_2' | 'mes_3' | 'graduado'
  | 'sin_venta_30' | 'por_confirmar' | 'sin_movimiento' | 'no_medible' | 'excluido';

const CHIPS: { id: VistaNuevos; label: string; tono: 'base' | 'warn' | 'bad' | 'info' }[] = [
  { id: 'seguimiento', label: 'En seguimiento', tono: 'base' },
  { id: 'mes_1', label: 'Mes 1 (0 a 29 días)', tono: 'base' },
  { id: 'mes_2', label: 'Mes 2', tono: 'base' },
  { id: 'mes_3', label: 'Mes 3', tono: 'base' },
  { id: 'graduado', label: 'Cumplieron 90 días', tono: 'base' },
  { id: 'sin_venta_30', label: 'Sin venta en 30 días', tono: 'bad' },
  { id: 'por_confirmar', label: 'Por confirmar', tono: 'warn' },
  { id: 'sin_movimiento', label: 'Dados de alta, sin movimiento', tono: 'info' },
  { id: 'no_medible', label: 'No medibles', tono: 'info' },
  { id: 'excluido', label: 'Excluidos', tono: 'info' },
];

export const OPCIONES_CLASIFICACION: { label: string; value: ClasificacionNueva | null }[] = [
  { label: 'Por confirmar', value: null },
  { label: 'Nuevo: lanzamiento real', value: 'nuevo' },
  { label: 'Recodificación de un producto existente', value: 'recodificacion' },
  { label: 'Promoción o paquete temporal', value: 'promocion' },
  { label: 'No es mercancía', value: 'no_mercancia' },
];

const ETIQUETA_CLASIFICACION: Record<ClasificacionNueva, string> = {
  nuevo: 'Nuevo',
  recodificacion: 'Recodificación',
  promocion: 'Promoción',
  no_mercancia: 'No es mercancía',
};

const ETIQUETA_FUENTE: Record<string, string> = {
  kepler: 'tienda',
  ruta: 'ruta',
  wincaja: 'Wincaja',
  entradas: 'entradas',
};

/** ¿La fila entra en esta vista? Pura: la prueba la ejerce sin montar el componente. */
export function pasaVista(f: ProductoNuevo, v: VistaNuevos): boolean {
  switch (v) {
    case 'seguimiento': return f.estado === 'seguimiento';
    case 'mes_1': case 'mes_2': case 'mes_3': case 'graduado':
      return f.estado === 'seguimiento' && f.etapa === v;
    case 'sin_venta_30': return f.estado === 'seguimiento' && f.sin_venta_30;
    case 'por_confirmar': return f.estado === 'seguimiento' && f.clasificacion === null;
    default: return f.estado === v;
  }
}

export function pasaBusqueda(f: ProductoNuevo, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [f.sku, f.nombre, f.marca, f.proveedor].some((x) => (x || '').toLowerCase().includes(t));
}

/**
 * El hito se muestra si ya cerró o si es el tramo EN CURSO. Los de más adelante van con guion:
 * a los 23 días, el valor "a 60 días" sería el mismo que el de 30 y se leería como un dato.
 */
export function hitoVisible(dia: number | null, n: HitoNuevo): boolean {
  return dia !== null && dia >= n - 30;
}

/** Fecha `YYYY-MM-DD` en corto, SIN corrimiento de zona (se lee como UTC y se pinta como UTC). */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(t);
}

/**
 * `[NP.5]` — **Productos nuevos.** Cada código que entra al catálogo se sigue 30, 60 y 90 días
 * desde su primera entrada o venta: cuánto se invirtió, cuánto vendió y si se volvió a comprar.
 *
 * La pantalla no decide nada: qué es nuevo, en qué etapa va y qué cuenta para la cohorte lo
 * resuelve el servidor (`libs/commercial/.../new-products.ts`). Aquí se pinta y se DECLARA lo que
 * no se mide (inversión sin entrada en Kepler, historia corta) en vez de dibujarlo como cero.
 */
@Component({
  selector: 'app-compras-catalogo-nuevos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, ButtonModule, TooltipModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pn">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Productos nuevos</h1>
          <p class="surf-page-sub">
            Cada código que entra al catálogo se sigue 90 días desde su primera entrada o venta:
            cuánto se invirtió, cuánto vendió y si se volvió a comprar.
          </p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      @if (datos(); as d) {
        @if (!d.calculado) {
          <section class="pn-aviso" role="status">
            <strong>Las cifras todavía no se calculan.</strong>
            <span>Se calculan cada noche a las 6:20 con la venta y las entradas del día anterior. Vuelve mañana.</span>
          </section>
        } @else {
          <p class="pn-frescura">
            Cifras al {{ fechaHora(d.calculado_at) }} · se recalculan cada noche.
          </p>

          @if (d.resumen; as r) {
            <section class="pn-respuesta" aria-live="polite">
              <p class="pn-titular">
                {{ n(r.seguimiento) }} productos nuevos en seguimiento:
                @if (d.costo_visible && r.inversion !== null) {
                  se invirtieron {{ dinero(r.inversion) }} y han vendido {{ dinero(r.venta) }}.
                } @else {
                  han vendido {{ dinero(r.venta) }}.
                }
              </p>
              <p class="pn-sub">
                {{ n(r.sin_venta_30) }} de {{ n(r.con_30_dias) }} que ya cumplieron 30 días no vendieron nada en ese mes ·
                {{ n(r.recomprados) }} ya se volvieron a comprar ·
                {{ n(r.por_confirmar) }} esperan que Compras confirme qué son.
              </p>
              @if (!d.costo_visible) {
                <p class="pn-sub">No tienes permiso para ver costos: la inversión no se muestra.</p>
              }
            </section>

            <section class="pn-kpis" aria-label="Indicadores">
              @if (d.costo_visible) {
                <div class="pn-kpi">
                  <span class="pn-k">Inversión</span>
                  <span class="pn-v">{{ r.inversion === null ? 'No medida' : dinero(r.inversion) }}</span>
                  <span class="pn-d">importe de las entradas en Kepler</span>
                </div>
              }
              <div class="pn-kpi">
                <span class="pn-k">Venta acumulada</span>
                <span class="pn-v">{{ dinero(r.venta) }}</span>
                <span class="pn-d">desde su lanzamiento, todas las plazas</span>
              </div>
              @if (d.costo_visible) {
                <div class="pn-kpi">
                  <span class="pn-k">Venta por cada $1 invertido</span>
                  <span class="pn-v">{{ r.venta_por_peso === null ? '—' : veces(r.venta_por_peso) }}</span>
                  <span class="pn-d">sólo productos con inversión medida</span>
                </div>
              }
              <div class="pn-kpi">
                <span class="pn-k">Se volvieron a comprar</span>
                <span class="pn-v">{{ n(r.recomprados) }} <small>de {{ n(r.seguimiento) }}</small></span>
                <span class="pn-d">segunda entrada en una plaza que ya lo tenía</span>
              </div>
              <div class="pn-kpi">
                <span class="pn-k">Sin venta en su primer mes</span>
                <span class="pn-v" [class.pn-bad]="r.sin_venta_30 > 0">{{ n(r.sin_venta_30) }} <small>de {{ n(r.con_30_dias) }}</small></span>
                <span class="pn-d">ya cumplieron 30 días</span>
              </div>
            </section>
          }

          @if (d.cohortes.length) {
            <section class="pn-bloque" aria-labelledby="pn-cohortes">
              <h2 id="pn-cohortes" class="pn-h2">Por mes de lanzamiento</h2>
              <div class="pn-tabla">
                <table class="pn-cohortes">
                  <thead>
                    <tr>
                      <th scope="col">Mes</th>
                      <th scope="col" class="pn-num">Productos</th>
                      @if (d.costo_visible) { <th scope="col" class="pn-num">Inversión</th> }
                      <th scope="col" class="pn-num">Venta</th>
                      @if (d.costo_visible) { <th scope="col" class="pn-num">Venta por $1</th> }
                      <th scope="col" class="pn-num">Recomprados</th>
                      <th scope="col" class="pn-num">Sin venta en 30 días</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of d.cohortes; track c.mes) {
                      <tr>
                        <td>{{ mes(c.mes) }}</td>
                        <td class="pn-num pn-mono">{{ n(c.productos) }}</td>
                        @if (d.costo_visible) {
                          <td class="pn-num pn-mono" [pTooltip]="c.con_inversion < c.productos ? (c.productos - c.con_inversion) + ' sin inversión medida' : ''">
                            {{ c.inversion === null ? 'No medida' : dinero(c.inversion) }}
                          </td>
                        }
                        <td class="pn-num pn-mono">{{ dinero(c.venta) }}</td>
                        @if (d.costo_visible) {
                          <td class="pn-num pn-mono">{{ c.venta_por_peso === null ? '—' : veces(c.venta_por_peso) }}</td>
                        }
                        <td class="pn-num pn-mono">{{ n(c.recomprados) }}</td>
                        <td class="pn-num pn-mono">{{ c.con_30_dias ? n(c.sin_venta_30) + ' de ' + n(c.con_30_dias) : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <div class="pn-chips" role="group" aria-label="Filtrar productos">
            @for (ch of chips; track ch.id) {
              <button type="button" [class]="'pn-chip pn-tono-' + ch.tono" [class.is-sel]="vista() === ch.id"
                      [attr.aria-pressed]="vista() === ch.id" (click)="vista.set(ch.id)">
                <span>{{ ch.label }}</span>
                <span class="pn-chip-n">{{ n(conteo(ch.id)) }}</span>
              </button>
            }
            <label class="pn-buscar">
              <span class="pn-sr">Buscar producto</span>
              <input type="search" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                     placeholder="Buscar SKU, nombre, marca o proveedor" autocomplete="off" spellcheck="false" />
            </label>
          </div>

          <div class="pn-tabla">
            <p-table [value]="filas()" dataKey="product_id" [expandedRowKeys]="abiertos" [paginator]="filas().length > 50"
                     [rows]="50" size="small" class="surf-table surf-table--sticky">
              <ng-template #header>
                <tr>
                  <th scope="col" class="pn-col-toggle"><span class="pn-sr">Detalle</span></th>
                  <th scope="col">Producto</th>
                  <th scope="col">Lanzamiento</th>
                  <th scope="col" class="pn-num">30 días</th>
                  <th scope="col" class="pn-num">60 días</th>
                  <th scope="col" class="pn-num">90 días</th>
                  @if (d.costo_visible) { <th scope="col" class="pn-num" pTooltip="Venta acumulada entre lo invertido">Venta por $1</th> }
                  <th scope="col">Recompra</th>
                  <th scope="col">Plazas</th>
                  <th scope="col">Clasificación</th>
                </tr>
              </ng-template>
              <ng-template #body let-f let-expanded="expanded">
                <tr>
                  <td class="pn-col-toggle">
                    <button type="button" class="pn-toggle" [pRowToggler]="f" [attr.aria-expanded]="expanded"
                            [attr.aria-label]="(expanded ? 'Cerrar' : 'Abrir') + ' detalle de ' + (f.nombre || f.sku)">
                      <i [class]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true"></i>
                    </button>
                  </td>
                  <td>
                    <div class="pn-prod">{{ f.nombre || 'Sin nombre en catálogo' }}</div>
                    <div class="pn-meta">
                      <span class="pn-mono">{{ f.sku }}</span>
                      @if (f.marca) { · {{ f.marca }} }
                      @if (f.proveedor) { · {{ f.proveedor }} }
                    </div>
                    <div class="pn-tags">
                      <span class="pn-tag pn-tag-nuevo">{{ etapa(f.etapa, f.dia) }}</span>
                      @if (f.sin_venta_30 && f.estado === 'seguimiento') { <span class="pn-tag pn-tag-bad">Sin venta en 30 días</span> }
                      @if (f.posible_recodificacion && !f.clasificacion) {
                        <span class="pn-tag pn-tag-warn" pTooltip="Otro producto dado de alta antes tiene el mismo código de barras">Posible recodificación</span>
                      }
                    </div>
                  </td>
                  <td>
                    <div>{{ fecha(f.lanzamiento) }}</div>
                    @if (f.lanzamiento) {
                      <div class="pn-meta">{{ f.primera_recepcion === f.lanzamiento ? 'primera entrada' : 'primera venta' }}</div>
                    } @else {
                      <div class="pn-meta">alta {{ fecha(f.alta_suite) }}</div>
                    }
                  </td>
                  @for (h of hitos; track h) {
                    <td class="pn-num pn-hito">
                      @if (f.estado !== 'seguimiento' && f.estado !== 'excluido' || !hitoVisible(f.dia, h)) {
                        <span class="pn-muted">—</span>
                      } @else {
                        @if (f.hitos[h].venta !== null) {
                          <span class="pn-mono pn-fuerte">{{ dinero(f.hitos[h].venta) }}</span>
                        } @else {
                          <span class="pn-muted">sin venta</span>
                        }
                        @if (d.costo_visible) {
                          <span class="pn-sub-c">{{ f.hitos[h].inversion === null ? 'inversión no medida' : 'invertido ' + dinero(f.hitos[h].inversion) }}</span>
                        }
                        @if (!f.hitos[h].cerrado) { <span class="pn-curso">en curso</span> }
                      }
                    </td>
                  }
                  @if (d.costo_visible) {
                    <td class="pn-num pn-mono">{{ f.venta_por_peso === null ? '—' : veces(f.venta_por_peso) }}</td>
                  }
                  <td>
                    @if (f.dia_recompra !== null) {
                      <span>Día {{ f.dia_recompra }}</span>
                    } @else if (f.entradas === 0) {
                      <span class="pn-muted" pTooltip="Sin entradas en Kepler: no se puede saber">No medida</span>
                    } @else {
                      <span class="pn-muted">Todavía no</span>
                    }
                  </td>
                  <td class="pn-plazas">
                    <span pTooltip="Plazas que lo recibieron">{{ f.plazas_recibido }} recibe</span> ·
                    <span pTooltip="Plazas que lo vendieron">{{ f.plazas_venta }} vende</span> ·
                    <span pTooltip="Plazas con existencia hoy">{{ f.plazas_con_existencia }} con existencia</span>
                  </td>
                  <td>
                    @if (f.estado === 'excluido' || f.estado === 'no_medible' || f.estado === 'sin_movimiento') {
                      <span class="pn-tag">{{ f.motivo }}</span>
                    } @else if (f.clasificacion) {
                      <span class="pn-tag pn-tag-ok">{{ etiquetaClasificacion(f.clasificacion) }}</span>
                    } @else {
                      <span class="pn-tag pn-tag-warn">Por confirmar</span>
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-f>
                <tr class="pn-detalle-fila">
                  <td [attr.colspan]="d.costo_visible ? 10 : 9">
                    <div class="pn-detalle">
                      <dl class="pn-datos">
                        <div><dt>Alta en la Suite</dt><dd>{{ fecha(f.alta_suite) }}{{ f.alta_en_lote ? ' (carga masiva)' : '' }}</dd></div>
                        <div><dt>Primera entrada</dt><dd>{{ fecha(f.primera_recepcion) }}</dd></div>
                        <div><dt>Primera venta</dt><dd>{{ fecha(f.primera_venta) }}</dd></div>
                        <div><dt>Última venta</dt><dd>{{ fecha(f.ultima_venta) }}</dd></div>
                        <div><dt>Días con venta en su primer mes</dt><dd>{{ f.lanzamiento ? f.dias_con_venta_30 + ' de 30' : '—' }}</dd></div>
                        <div><dt>Entradas</dt><dd>{{ f.entradas }}</dd></div>
                        <div><dt>Se vio en</dt><dd>{{ fuentes(f.fuentes) }}</dd></div>
                        @if (d.costo_visible) {
                          <div><dt>Inversión total</dt><dd>{{ f.inversion_total === null ? 'No medida' : dinero(f.inversion_total) }}</dd></div>
                        }
                        <div><dt>Venta total</dt><dd>{{ f.venta_total === null ? 'Sin venta' : dinero(f.venta_total) }}</dd></div>
                      </dl>

                      <form class="pn-clasificar" (submit)="$event.preventDefault(); guardar(f)">
                        <h3 class="pn-h3">¿Qué es este código?</h3>
                        <p class="pn-meta">Sólo los lanzamientos reales cuentan para la inversión y el retorno.</p>
                        <p-select [options]="opciones" optionLabel="label" optionValue="value"
                                  [ngModel]="borrador(f).clasificacion" (ngModelChange)="editar(f, 'clasificacion', $event)"
                                  [ngModelOptions]="{ standalone: true }" [disabled]="!puedeGestionar()"
                                  appendTo="body" ariaLabel="Clasificación" class="pn-sel" />
                        <textarea class="pn-nota" rows="2" maxlength="500" [ngModel]="borrador(f).nota"
                                  (ngModelChange)="editar(f, 'nota', $event)" [ngModelOptions]="{ standalone: true }"
                                  [disabled]="!puedeGestionar()" placeholder="Nota: por qué se catalogó, qué se espera, proveedor…"
                                  aria-label="Nota de la clasificación"></textarea>
                        <div class="pn-acciones">
                          @if (puedeGestionar()) {
                            <button pButton type="submit" class="p-button-sm" [loading]="guardando() === f.product_id">
                              <span class="p-button-label">Guardar</span>
                            </button>
                          } @else {
                            <span class="pn-meta">Necesitas permiso para gestionar productos.</span>
                          }
                          @if (f.clasificado_por) { <span class="pn-meta">Última clasificación: {{ f.clasificado_por }}</span> }
                          @if (errorGuardar() === f.product_id) { <span class="pn-error" role="alert">No se pudo guardar. Intenta de nuevo.</span> }
                        </div>
                      </form>
                    </div>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td [attr.colspan]="d.costo_visible ? 10 : 9" class="pn-vacio">Ningún producto en esta vista.</td></tr>
              </ng-template>
            </p-table>
          </div>

          <footer class="pn-notas">
            <p>El seguimiento arranca en la primera entrada o la primera venta, no en el alta: un código que tarda en llegar no se castiga.
              La fecha de alta es la de la Suite; la de Kepler todavía no se identifica.</p>
            <p>Inversión = importe de las entradas de Kepler. El CEDIS operó en Wincaja hasta el 30 de septiembre, y las plazas 01, 02 y 06
              antes de pasar a Kepler: lo que entró por ahí no se ve y el producto dice «inversión no medida», no cero.</p>
            <p>Las cifras son en pesos y sin margen: el costo de lo vendido todavía no se puede medir bien para un producto nuevo.
              Recompra = una segunda entrada en una plaza que ya lo había recibido; el surtido inicial en varias plazas no cuenta.</p>
            <p>No medible = no hay 90 días de historia antes de su primera actividad en todas las fuentes donde aparece (tienda, ruta, Wincaja o entradas),
              así que no se puede afirmar que antes no se vendía. Las cargas masivas al catálogo no cuentan como altas.</p>
          </footer>
        }
      } @else if (cargando()) {
        <p class="pn-meta">Cargando…</p>
      } @else if (error()) {
        <p class="pn-error" role="alert">No se pudieron cargar los productos nuevos. Intenta de nuevo en un momento.</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pn { display: flex; flex-direction: column; gap: 1rem; }
    .pn-frescura { margin: 0; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-aviso { display: flex; flex-direction: column; gap: .25rem; background: var(--warn-soft-bg); border: 1px solid var(--c-divider);
      border-radius: 10px; padding: .875rem 1.125rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .pn-respuesta { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: 1rem 1.25rem; }
    .pn-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .pn-sub { margin: .35rem 0 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .pn-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .75rem; }
    .pn-kpi { display: flex; flex-direction: column; gap: .2rem; background: var(--c-surface-1); border: 1px solid var(--c-divider);
      border-radius: 10px; padding: .75rem 1rem; }
    .pn-k { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-v small { font-size: var(--fs-xs); font-weight: normal; color: var(--c-text-2); }
    .pn-d { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pn-bad { color: var(--bad-fg); }
    .pn-bloque { display: flex; flex-direction: column; gap: .5rem; }
    .pn-h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .pn-cohortes { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .pn-cohortes th, .pn-cohortes td { padding: .45rem .75rem; border-bottom: 1px solid var(--c-divider); text-align: left; }
    .pn-cohortes th { font-size: var(--fs-xs); color: var(--c-text-2); font-weight: var(--fw-bold); }
    .pn-cohortes tbody tr:last-child td { border-bottom: none; }
    /* La regla de arriba alinea a la izquierda y gana por especificidad: los numeros van a la derecha. */
    .pn-cohortes th.pn-num, .pn-cohortes td.pn-num { text-align: right; }
    .pn-chips { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .pn-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: 0 .75rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .pn-chip:hover { background: var(--c-surface-2); }
    .pn-chip.is-sel { border-color: var(--action); background: var(--c-surface-2); font-weight: var(--fw-bold); }
    .pn-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pn-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-tono-bad .pn-chip-n { color: var(--bad-fg); }
    .pn-tono-warn .pn-chip-n { color: var(--warn-fg); }
    .pn-buscar { margin-left: auto; }
    .pn-buscar input { height: 2.25rem; width: 18rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .pn-buscar input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pn-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .pn-num { text-align: right; white-space: nowrap; }
    .pn-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pn-fuerte { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-muted { color: var(--c-text-3); }
    .pn-col-toggle { width: 2.25rem; }
    .pn-toggle { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: none;
      border-radius: 6px; background: none; color: var(--c-text-2); cursor: pointer; }
    .pn-toggle:hover { background: var(--c-surface-2); }
    .pn-toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pn-prod { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pn-tags { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .25rem; }
    .pn-tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: var(--fs-xs);
      font-weight: var(--fw-bold); white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-2); }
    .pn-tag-nuevo { background: var(--c-surface-2); color: var(--c-text-1); border: 1px solid var(--action); }
    .pn-tag-bad { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .pn-tag-warn { background: var(--warn-soft-bg); color: var(--c-text-1); }
    .pn-tag-ok { background: var(--ok-soft-bg); color: var(--c-text-1); }
    .pn-hito { vertical-align: top; }
    .pn-hito > span { display: block; }
    .pn-sub-c { font-size: var(--fs-xs); color: var(--c-text-2); font-family: var(--font-mono); }
    .pn-curso { font-size: var(--fs-xs); color: var(--warn-fg); }
    .pn-plazas { font-size: var(--fs-xs); color: var(--c-text-2); white-space: nowrap; }
    .pn-detalle-fila > td { background: var(--c-surface-2); }
    .pn-detalle { display: grid; grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr); gap: 1.25rem; padding: .5rem .25rem; }
    .pn-datos { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .5rem 1rem; margin: 0; }
    .pn-datos dt { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-datos dd { margin: 0; font-size: var(--fs-sm); color: var(--c-text-1); }
    .pn-clasificar { display: flex; flex-direction: column; gap: .5rem; }
    .pn-sel { width: 100%; }
    .pn-nota { width: 100%; border: 1px solid var(--c-divider); border-radius: 8px; padding: .45rem .6rem; font: inherit;
      font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); resize: vertical; }
    .pn-nota:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pn-acciones { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .pn-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .pn-notas { font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .pn-notas p { margin: 0 0 .35rem; max-width: 62rem; }
    .pn-error { color: var(--bad-fg); font-size: var(--fs-sm); }
    @media (max-width: 48rem) {
      .pn-detalle { grid-template-columns: 1fr; }
      .pn-buscar { margin-left: 0; width: 100%; }
      .pn-buscar input { width: 100%; }
    }
  `],
})
export class ComprasCatalogoNuevosComponent {
  readonly tabs = CATALOGO_TABS;
  readonly chips = CHIPS;
  readonly opciones = OPCIONES_CLASIFICACION;
  readonly hitos: HitoNuevo[] = [30, 60, 90];
  readonly hitoVisible = hitoVisible;

  private readonly api = inject(ProductosNuevosService);
  private readonly perms = inject(PermissionsService);

  readonly puedeGestionar = computed(() => this.perms.has(Permission.COMMERCIAL_PRODUCTS_GESTIONAR));
  readonly vista = signal<VistaNuevos>('seguimiento');
  readonly busqueda = signal('');
  readonly guardando = signal<string | null>(null);
  readonly errorGuardar = signal<string | null>(null);
  /** Lo que el usuario está editando, por producto. Se borra al guardar. */
  private readonly borradores = signal<Record<string, { clasificacion: ClasificacionNueva | null; nota: string }>>({});
  abiertos: Record<string, boolean> = {};

  private readonly recarga = signal(0);
  private readonly res = rxResource({
    params: () => this.recarga(),
    stream: () => this.api.listar(),
  });

  /** `undefined` mientras carga o tras un error: nunca se pintan ceros que no se midieron. */
  readonly datos = computed(() => (this.res.error() ? undefined : this.res.value()));
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => !!this.res.error());

  readonly filas = computed(() => {
    const d = this.datos();
    if (!d) return [];
    const v = this.vista();
    const q = this.busqueda();
    return d.filas.filter((f) => pasaVista(f, v) && pasaBusqueda(f, q));
  });

  conteo(v: VistaNuevos): number {
    return (this.datos()?.filas ?? []).filter((f) => pasaVista(f, v)).length;
  }

  borrador(f: ProductoNuevo): { clasificacion: ClasificacionNueva | null; nota: string } {
    return this.borradores()[f.product_id] ?? { clasificacion: f.clasificacion, nota: f.nota ?? '' };
  }

  editar(f: ProductoNuevo, campo: 'clasificacion' | 'nota', valor: ClasificacionNueva | null | string): void {
    const actual = this.borrador(f);
    this.borradores.update((b) => ({ ...b, [f.product_id]: { ...actual, [campo]: valor } }));
  }

  guardar(f: ProductoNuevo): void {
    if (!this.puedeGestionar()) return;
    const b = this.borrador(f);
    this.guardando.set(f.product_id);
    this.errorGuardar.set(null);
    this.api.clasificar(f.product_id, b.clasificacion, b.nota.trim() || null).subscribe({
      next: () => {
        this.guardando.set(null);
        this.borradores.update((x) => {
          const { [f.product_id]: _, ...resto } = x;
          return resto;
        });
        this.recarga.update((n) => n + 1);
      },
      error: () => {
        this.guardando.set(null);
        this.errorGuardar.set(f.product_id);
      },
    });
  }

  etapa(e: EtapaNueva, dia: number | null): string {
    if (e === 'sin_movimiento' || dia === null) return 'Nuevo · sin movimiento';
    if (e === 'graduado') return `Cumplió 90 días · día ${dia}`;
    return `Nuevo · día ${dia}`;
  }

  etiquetaClasificacion(c: ClasificacionNueva): string {
    return ETIQUETA_CLASIFICACION[c];
  }

  fuentes(lista: string[]): string {
    return lista.length ? lista.map((x) => ETIQUETA_FUENTE[x] ?? x).join(', ') : 'ninguna';
  }

  fecha(iso: string | null): string {
    return fechaCorta(iso);
  }

  fechaHora(iso: string | null): string {
    if (!iso) return 'sin fecha';
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  }

  mes(m: string): string {
    const t = Date.parse(`${m}-01T00:00:00Z`);
    return Number.isFinite(t)
      ? new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(t)
      : m;
  }

  dinero(v: number | null): string {
    if (v === null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(v);
  }

  veces(v: number): string {
    return `$${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
  }

  n(v: number): string {
    return new Intl.NumberFormat('es-MX').format(v);
  }
}
