import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { CatalogoLatidoService } from '../catalogo-latido.service';
import { ComercialService, DupBarcodeRow, DupProduct } from '../../comercial/comercial.service';

type Severidad = '' | 'distinto' | '5' | '25';

/**
 * `[CAT.2]` — **Códigos repetidos**, pestaña del Catálogo de Compras.
 *
 * Un código de barras no puede estar dado de alta en más de un producto. Cuando lo está, la caja
 * tiene dos altas para el mismo escaneo y **cobra la que le toque, en el mismo mostrador y el mismo
 * día**. Por eso es un defecto distinto del de Precios distintos y merece su propia pestaña:
 *
 *  - Es **local a la sucursal**: aparece aunque las 7 estén perfectamente alineadas entre sí.
 *  - La pregunta no es *en qué sucursal*, sino **cuál alta se queda** — y eso se decide comparando
 *    rotación, no precio.
 *  - El arreglo es dar de baja el código que sobra **en Kepler**; acá sólo se detecta y se sigue.
 *
 * Medido contra producción el 14-sep-2026: 185 códigos en más de un producto, 373 productos
 * involucrados, 188 casos cobrando distinto y 149 con más de 5 %.
 *
 * Lee el mismo endpoint que el tablero de precios (`network`, con `solo_duplicados`), así que no
 * agrega superficie de backend: es otro lente sobre el mismo dato.
 */
@Component({
  selector: 'app-compras-catalogo-codigos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule,
    TooltipModule, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cd">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Códigos repetidos</h1>
          <p class="surf-page-sub">
            El mismo código de barras dado de alta en más de un producto. Al escanear, la caja
            cobra el alta que le toque.
          </p>
        </div>
        <div class="cd-head-actions">
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="cargando()"
                  (click)="recargar()" pTooltip="Refrescar">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <!--
        [CAT.7] El estado del canal, SIEMPRE visible. "No hay nada nuevo" y "dejé de preguntar" se
        ven igual en pantalla y significan lo contrario; por eso se declara cuál de las dos es.
      -->
      <div class="cd-rail">
        <span class="cd-dot" [class.cd-dot-off]="!enVivo()"></span>
        <span class="cd-rail-l">{{ enVivo() ? 'Al día' : 'Sin conexión' }}</span>
        <span class="cd-rail-m">
          {{ enVivo()
            ? 'se actualiza sola en cuanto corrigen algo en Kepler'
            : 'los datos son de la última carga; recargá para ver si cambió algo' }}
        </span>
      </div>

      <!--
        [CAT.2] El defecto se detecta sin precios. Cuando el contexto de precio no está, se dice —y
        NO se muestra 0, que es lo que hacía antes y se leía como "acá está todo bien".
      -->
      @if (sinPrecios()) {
        <div class="cd-noinst" role="status">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <div>
            <strong>Los códigos repetidos se detectaron; sus precios no.</strong>
            <span>Falta el catálogo de Kepler en el ODS de esta base, así que no se puede decir si
              además cobran distinto. El defecto de abajo es real igual: un código en dos altas
              descuenta del SKU equivocado, con o sin precio.</span>
          </div>
        </div>
      }

      <!-- Contadores. Cuentan CÓDIGOS, no productos: el sujeto del problema es el código. -->
      <div class="cd-kpis">
        <div class="cd-kpi">
          <span class="cd-k">Códigos repetidos</span>
          <span class="cd-v cd-bad">{{ grupos().length | number }}</span>
          <span class="cd-d">dados de alta en 2 o más productos</span>
        </div>
        <div class="cd-kpi">
          <span class="cd-k">Cobran distinto</span>
          @if (sinPrecios()) {
            <span class="cd-v cd-muted">—</span>
            <span class="cd-d">sin precios no se puede saber</span>
          } @else {
            <span class="cd-v cd-bad">{{ cobranDistinto() | number }}</span>
            <span class="cd-d">la caja cobra la que le toque</span>
          }
        </div>
        <div class="cd-kpi">
          <span class="cd-k">En todas las sucursales</span>
          <span class="cd-v cd-bad">{{ enTodas() | number }}</span>
          <span class="cd-d">el alta duplicada se replicó a toda la red</span>
        </div>
        <div class="cd-kpi">
          <span class="cd-k">Mismo precio</span>
          @if (sinPrecios()) {
            <span class="cd-v cd-muted">—</span>
            <span class="cd-d">sin precios no se puede saber</span>
          } @else {
            <span class="cd-v cd-ok">{{ grupos().length - cobranDistinto() | number }}</span>
            <span class="cd-d">repetido, pero el cliente no lo sufre</span>
          }
        </div>
      </div>

      <div class="cd-filtros">
        <input type="search" class="cd-input" [(ngModel)]="busqueda" (keyup.enter)="recargar()"
               placeholder="Código de barras, SKU o nombre" aria-label="Buscar" />
        <button pButton type="button" class="p-button-sm p-button-outlined" (click)="recargar()">
          <span class="p-button-label">Buscar</span>
        </button>
      </div>

      <!--
        Las cuatro vistas a la vista, no escondidas en un desplegable: son el eje de trabajo de la
        pantalla, y con su conteo al lado se elige sabiendo cuánto hay detrás. Cambiar de vista NO
        vuelve a pedir al servidor — filtra lo que ya está cargado, así que es instantáneo.
      -->
      <div class="cd-seg" role="tablist" aria-label="Qué tan grave">
        @for (o of severidades; track o.value) {
          <button type="button" role="tab" class="cd-seg-btn"
                  [class.cd-seg-on]="severidad() === o.value"
                  [attr.aria-selected]="severidad() === o.value"
                  [disabled]="o.value !== '' && sinPrecios()"
                  [pTooltip]="o.value !== '' && sinPrecios()
                    ? 'Necesita precios, y esta base no los tiene cargados'
                    : ''"
                  tooltipPosition="top"
                  (click)="setSeveridad(o.value)">
            <span>{{ o.label }}</span>
            <span class="cd-seg-n">{{ conteo(o.value) | number }}</span>
          </button>
        }
      </div>

      <p-table [value]="grupos()" [loading]="cargando()" dataKey="barcode"
               styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--zebra"
               [rowHover]="true" [expandedRowKeys]="abiertos">
        <ng-template #header>
          <tr>
            <th scope="col" style="width:2.5rem"><span class="sr-only">Abrir</span></th>
            <th scope="col">Código de barras</th>
            <th scope="col">Productos que lo comparten</th>
            <th scope="col">Se repite en</th>
            <th scope="col" class="cd-r">Altas</th>
            <th scope="col" class="cd-r">Precio</th>
            <th scope="col">Veredicto</th>
          </tr>
        </ng-template>

        <ng-template #body let-g let-abierto="expanded">
          <tr>
            <td>
              <button type="button" class="cd-exp" [pRowToggler]="g"
                      [attr.aria-label]="abierto ? 'Cerrar' : 'Ver los productos'">
                <i [class]="abierto ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true"></i>
              </button>
            </td>
            <td><span class="cd-bc">{{ g.barcode }}</span></td>
            <td>
              <div class="cd-nombres">
                @for (p of g.productos; track p.sku) {
                  <span>{{ p.nombre || p.sku }}</span>
                }
              </div>
            </td>
            <td>
              @if (g.sucursales.length) {
                <div class="cd-plazas">
                  @if (g.sucursales.length >= totalSucursales()) {
                    <span class="cd-badge cd-badge-bad">las {{ g.sucursales.length }}</span>
                  }
                  @for (s of g.sucursales; track s) { <span class="cd-plaza">{{ s }}</span> }
                </div>
              } @else {
                <span class="cd-muted cd-small-inline"
                      pTooltip="El código de pieza no delata este duplicado: vive en el de paquete o caja, y esa tabla no guarda sucursal."
                      tooltipPosition="top">no consta</span>
              }
            </td>
            <td class="cd-r cd-num">{{ g.altas }}</td>
            <td class="cd-r">
              @if (!g.precio_conocido) {
                <span class="cd-muted cd-small-inline">sin precio</span>
              } @else if (g.cobran_distinto) {
                <span class="cd-num cd-bad">
                  {{ g.precio_min | currency:'MXN':'symbol-narrow':'1.2-2' }} –
                  {{ g.precio_max | currency:'MXN':'symbol-narrow':'1.2-2' }}
                </span>
                <small class="cd-small">{{ g.precio_max - g.precio_min | currency:'MXN':'symbol-narrow':'1.2-2' }} de diferencia</small>
              } @else {
                <span class="cd-num">{{ g.precio_min | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              }
            </td>
            <td>
              @if (!g.precio_conocido) {
                <span class="cd-badge cd-badge-warn">código repetido</span>
              } @else if (g.cobran_distinto) {
                <span class="cd-badge cd-badge-bad">cobran distinto</span>
              } @else {
                <span class="cd-badge cd-badge-ok">mismo precio</span>
              }
            </td>
          </tr>
        </ng-template>

        <!--
          El detalle NO es la matriz de precios: es la lista de altas que comparten el código, para
          decidir cuál se queda.
        -->
        <ng-template #expandedrow let-g>
          <tr class="cd-detalle">
            <td [attr.colspan]="7">
              <!--
                [CAT.6] Matriz alta x sucursal. "Las 7 sucursales" dice que el duplicado esta en
                todas, pero no contesta la pregunta operativa: a que precio sale CADA alta en CADA
                plaza. Con la matriz se ve de un golpe si el problema es del catalogo central (las
                dos altas cuestan lo mismo en todas, como el caso 7503009290074) o de una tienda.
              -->
              <div class="cd-scroll">
                <table class="cd-mini">
                  <thead>
                    <tr>
                      <th scope="col">SKU</th>
                      <th scope="col">Nombre</th>
                      <th scope="col">Estado</th>
                      @for (s of plazasDe(g); track s) {
                        <th scope="col" class="cd-r">{{ s }}</th>
                      }
                      @if (!plazasDe(g).length) { <th scope="col" class="cd-r">Precio</th> }
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of g.productos; track p.sku) {
                      <tr>
                        <td><code class="comm-code">{{ p.sku }}</code></td>
                        <td>
                          <div>{{ p.nombre || '—' }}</div>
                          <div class="cd-sub">{{ p.unit || '—' }} · {{ p.supplier_name || 'sin proveedor' }}</div>
                        </td>
                        <td>
                          <span class="cd-badge" [class.cd-badge-ok]="p.activo" [class.cd-badge-warn]="!p.activo">
                            {{ p.activo ? 'activo' : 'inactivo' }}
                          </span>
                        </td>
                        @for (s of plazasDe(g); track s) {
                          <td class="cd-r cd-num"
                              [class.cd-bad]="precioEn(p, s) != null && precioEn(p, s) === g.precio_max"
                              [class.cd-ok]="precioEn(p, s) != null && precioEn(p, s) === g.precio_min">
                            {{ precioEn(p, s) == null ? '—' : (precioEn(p, s) | currency:'MXN':'symbol-narrow':'1.2-2') }}
                          </td>
                        }
                        @if (!plazasDe(g).length) {
                          <td class="cd-r cd-num">
                            {{ p.precio_min == null ? '—' : (p.precio_min | currency:'MXN':'symbol-narrow':'1.2-2') }}
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="cd-pie">
                El arreglo es dar de baja el código que sobra <strong>en Kepler</strong>. Esta
                pantalla sólo detecta y da seguimiento.
              </p>
            </td>
          </tr>
        </ng-template>

        <ng-template #emptymessage>
          <tr>
            <td [attr.colspan]="7" class="cd-vacio">
              @if (cargando()) { Leyendo el catálogo… }
              @else { Ningún código repetido con estos filtros. }
            </td>
          </tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cd-head-actions { display: flex; gap: .5rem; align-items: center; }

    .cd-kpis {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
      border: 1px solid var(--c-divider); border-radius: 8px;
      background: var(--c-surface-0); margin: 1rem 0 .75rem; overflow: hidden;
    }
    .cd-kpi { padding: .75rem .875rem; border-left: 1px solid var(--c-divider); display: flex; flex-direction: column; }
    .cd-kpi:first-child { border-left: 0; }
    .cd-k { font-size: .66rem; letter-spacing: .07em; text-transform: uppercase; color: var(--c-text-3); font-weight: 600; }
    .cd-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 1.35rem; margin-top: .2rem; }
    .cd-d { font-size: .7rem; color: var(--c-text-2); margin-top: .15rem; }

    .cd-filtros { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
    .cd-input {
      padding: .35rem .5rem; border: 1px solid var(--c-divider); border-radius: 6px;
      background: var(--c-surface-1); min-width: 15rem; color: var(--c-text-1);
    }

    .cd-seg { display: flex; flex-wrap: wrap; gap: .3rem; margin-bottom: .6rem; }
    .cd-seg-btn {
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .3rem .6rem; border: 1px solid var(--c-divider); border-radius: 999px;
      background: var(--c-surface-0); color: var(--c-text-2);
      font-size: var(--fs-xs); font-weight: var(--fw-medium); cursor: pointer;
      transition: background 120ms var(--ease-standard), border-color 120ms var(--ease-standard);
    }
    .cd-seg-btn:hover:not(:disabled) { background: var(--c-surface-2); color: var(--c-text-1); }
    .cd-seg-btn:disabled { opacity: .45; cursor: not-allowed; }
    .cd-seg-btn:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .cd-seg-on {
      border-color: var(--action); background: var(--c-surface-2);
      color: var(--c-text-1); font-weight: var(--fw-bold);
    }
    .cd-seg-n {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: .68rem; padding: 0 .3rem; border-radius: 4px;
      background: var(--c-surface-2); color: var(--c-text-2);
    }
    .cd-seg-on .cd-seg-n { background: var(--action); color: #fff; }


    .cd-rail {
      display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem;
      margin-top: .6rem; padding: .35rem .6rem;
      border: 1px solid var(--c-divider); border-radius: 6px; background: var(--c-surface-0);
    }
    .cd-dot {
      width: 7px; height: 7px; border-radius: 50%; background: var(--ok-fg); flex: none;
      animation: cd-pulse 2.4s ease-out infinite;
    }
    .cd-dot-off { background: var(--c-text-3); animation: none; }
    @keyframes cd-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(64,111,78,.42); }
      70%  { box-shadow: 0 0 0 7px rgba(64,111,78,0); }
      100% { box-shadow: 0 0 0 0 rgba(64,111,78,0); }
    }
    @media (prefers-reduced-motion: reduce) { .cd-dot { animation: none; } }
    .cd-rail-l { font-size: var(--fs-xs); font-weight: var(--fw-bold); }
    .cd-rail-m { font-size: .72rem; color: var(--c-text-2); }
    .cd-r { text-align: right; }
    .cd-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cd-muted { color: var(--c-text-2); }
    .cd-small { display: block; font-size: .68rem; color: var(--c-text-3); font-family: var(--font-mono); }
    .cd-bad { color: var(--bad-fg); }
    .cd-warn { color: var(--warn-fg); }
    .cd-ok { color: var(--ok-fg); }

    .cd-bc { font-family: var(--font-mono); font-size: .82rem; font-weight: 600; }
    .cd-meta { font-size: .7rem; color: var(--c-text-2); margin-top: .1rem; }

    .cd-badge {
      display: inline-block; padding: .05rem .4rem; border-radius: 4px;
      font-size: .62rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
      border: 1px solid transparent;
    }
    .cd-badge-bad { color: var(--bad-fg); background: var(--bad-bg); border-color: var(--bad-fg); }
    .cd-badge-ok { color: var(--ok-fg); background: var(--ok-bg); border-color: var(--ok-fg); }
    .cd-badge-warn { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-fg); }
    .cd-nombres { display: flex; flex-direction: column; gap: .05rem; font-size: .8rem; }
    .cd-plazas { display: flex; flex-wrap: wrap; gap: .2rem; }
    .cd-scroll { overflow-x: auto; }
    .cd-sub { font-size: .68rem; color: var(--c-text-2); }
    .cd-plaza {
      font-size: .66rem; padding: .05rem .35rem; border-radius: 999px;
      background: var(--c-surface-2); border: 1px solid var(--c-divider); color: var(--c-text-2);
      white-space: nowrap;
    }
    .cd-small-inline { font-size: .75rem; }
    .cd-pie { margin: .5rem 0 0; font-size: .72rem; color: var(--c-text-2); }
    .cd-pie strong { color: var(--c-text-1); }

    .cd-exp { background: none; border: 0; color: var(--c-text-2); cursor: pointer; padding: .15rem .3rem; }
    .cd-exp:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    .cd-detalle > td { background: var(--c-surface-1); }
    .cd-sugerencia {
      display: flex; gap: .5rem; align-items: flex-start;
      font-size: .78rem; color: var(--c-text-2); margin-bottom: .5rem;
    }
    .cd-sugerencia strong { color: var(--c-text-1); }
    .cd-mini { width: 100%; border-collapse: collapse; }
    .cd-mini th {
      text-align: left; font-size: .62rem; letter-spacing: .05em; text-transform: uppercase;
      color: var(--c-text-3); padding: .25rem .4rem; border-bottom: 1px solid var(--c-divider);
    }
    .cd-mini td { padding: .25rem .4rem; font-size: .78rem; border-bottom: 1px solid var(--c-divider); }

    .cd-vacio { text-align: center; padding: 1.75rem .75rem; color: var(--c-text-2); }

    .cd-rail {
      display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .75rem;
      margin-top: .75rem; padding: .45rem .7rem;
      border: 1px solid var(--c-divider); border-radius: 6px; background: var(--c-surface-0);
    }
    .cd-dot {
      width: 7px; height: 7px; border-radius: 50%; background: var(--ok-fg); flex: none;
      animation: cd-pulse 2.4s ease-out infinite;
    }
    .cd-dot-off { background: var(--c-text-3); animation: none; }
    @keyframes cd-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(64,111,78,.42); }
      70%  { box-shadow: 0 0 0 7px rgba(64,111,78,0); }
      100% { box-shadow: 0 0 0 0 rgba(64,111,78,0); }
    }
    @media (prefers-reduced-motion: reduce) { .cd-dot { animation: none; } }
    .cd-rail-l { font-size: var(--fs-xs); font-weight: var(--fw-bold); }
    .cd-rail-m { font-size: .72rem; color: var(--c-text-2); }
    .cd-rail-r { margin-left: auto; }

    .cd-nuevo {
      display: flex; gap: .6rem; align-items: center;
      margin-top: .5rem; padding: .5rem .7rem;
      border: 1px solid var(--action); border-left-width: 3px;
      border-radius: 6px; background: var(--c-surface-1);
      font-size: var(--fs-xs);
    }
    .cd-nuevo-txt { flex: 1; min-width: 0; }
    .cd-nuevo-txt strong { display: block; color: var(--c-text-1); }
    .cd-nuevo-txt span { color: var(--c-text-2); }

    .cd-noinst {
      display: flex; gap: .6rem; align-items: flex-start;
      margin: 1rem 0 0; padding: .7rem .875rem;
      border: 1px solid var(--c-divider); border-left: 3px solid var(--warn-fg);
      border-radius: 6px; background: var(--warn-bg);
      font-size: var(--fs-xs); color: var(--c-text-2);
    }
    .cd-noinst strong { display: block; color: var(--c-text-1); margin-bottom: .1rem; }
    .cd-noinst i { margin-top: .15rem; }
    .cd-cmd {
      display: inline-block; margin-top: .4rem; padding: .15rem .4rem;
      font-family: var(--font-mono); font-size: .72rem;
      background: var(--c-surface-2); border: 1px solid var(--c-divider); border-radius: 4px;
    }

    @media (max-width: 900px) {
      .cd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cd-kpi { border-top: 1px solid var(--c-divider); }
      .cd-kpi:nth-child(-n+2) { border-top: 0; }
      .cd-kpi:nth-child(odd) { border-left: 0; }
    }
  `],
})
export class ComprasCatalogoCodigosComponent implements OnInit, OnDestroy {
  readonly tabs = CATALOGO_TABS;

  private readonly api = inject(ComercialService);
  private readonly latido = inject(CatalogoLatidoService);

  /** [CAT.7] `false` = el latido no responde; la pantalla lo DICE en vez de callarlo. */
  readonly enVivo = this.latido.enVivo;
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Todo lo que trajo el servidor. La vista elegida NO se le pide al backend: se deriva de acá con
   * un `computed`, así cambiar de pestaña es instantáneo y los conteos de cada opción salen gratis
   * — sin eso habría que adivinar cuánto hay detrás de cada una antes de hacer clic.
   */
  private readonly todas = signal<DupBarcodeRow[]>([]);
  readonly severidad = signal<Severidad>('');
  readonly grupos = computed(() => this.todas().filter((g) => this.pasaSeveridad(g, this.severidad())));
  /** `true` = el catálogo de precios no está disponible, así que el contexto no se pudo calcular. */
  readonly sinPrecios = signal(false);
  readonly cargando = signal(false);

  abiertos: Record<string, boolean> = {};

  busqueda = '';
  readonly severidades: { label: string; value: Severidad }[] = [
    { label: 'Todos los repetidos', value: '' },
    { label: 'Sólo los que cobran distinto', value: 'distinto' },
    { label: 'Cobran distinto > 5 %', value: '5' },
    { label: 'Cobran distinto > 25 %', value: '25' },
  ];

  readonly cobranDistinto = computed(() => this.grupos().filter((g) => g.cobran_distinto).length);

  /**
   * [CAT.4] Cuántas sucursales hay en juego. Se deduce del máximo observado en vez de clavarlo en
   * 7: si mañana abre una tienda, la etiqueta "las N sucursales" sigue siendo cierta sola.
   */
  readonly totalSucursales = computed(() =>
    this.todas().reduce((m, g) => Math.max(m, g.sucursales.length), 0) || 7);

  /**
   * [CAT.6] Las plazas que aparecen en ESTE grupo, en orden. Se sacan de los propios productos:
   * si una tienda no maneja el producto, no se le dibuja columna vacía.
   */
  plazasDe(g: DupBarcodeRow): string[] {
    const set = new Set<string>();
    for (const p of g.productos) for (const s of p.por_sucursal || []) set.add(s.sucursal);
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }

  precioEn(p: DupProduct, sucursal: string): number | null {
    return (p.por_sucursal || []).find((s) => s.sucursal === sucursal)?.precio ?? null;
  }

  /** El caso peor: el alta duplicada no se quedó en una plaza, se replicó a toda la red. */
  readonly enTodas = computed(() =>
    this.grupos().filter((g) => g.sucursales.length >= this.totalSucursales()).length);

  setSeveridad(v: Severidad): void { this.severidad.set(v); }

  /** Cuántas filas quedarían en esa vista. Se calcula sobre lo cargado, no sobre lo filtrado. */
  conteo(v: Severidad): number {
    return this.todas().filter((g) => this.pasaSeveridad(g, v)).length;
  }

  ngOnInit(): void {
    this.recargar();
    this.latido.escuchar();
  }

  ngOnDestroy(): void { this.latido.dejarDeEscuchar(); }

  /** [CAT.7] Cuando corrigen un codigo en Kepler, esta tabla se entera sola. Recarga directo: aca
   *  no hay riesgo de mover algo bajo el cursor, la tabla se lee, no se edita. */
  private readonly alCambiar = effect(() => {
    if (this.latido.version() > 0) this.recargar();
  });

  recargar(): void {
    this.cargando.set(true);
    // [CAT.2] Endpoint propio: el defecto vive en el catálogo de códigos, no en las vistas de
    // precio. Así la pantalla sirve aunque el ODS esté vacío o su carril caído.
    this.api.duplicateBarcodes({ search: this.busqueda || undefined, limit: 300 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.sinPrecios.set(!r.precios_disponibles);
          this.todas.set(r.rows);
          this.cargando.set(false);
        },
        error: (e) => {
          this.cargando.set(false);
          this.toast.add({
            severity: 'error', summary: 'No se pudo leer el catálogo de códigos',
            detail: e?.error?.message || 'Revisá que la API esté arriba y que tengas permiso.',
          });
        },
      });
  }

  private pasaSeveridad(g: DupBarcodeRow, v: Severidad): boolean {
    // Sin precio no se puede afirmar nada sobre gravedad: cae sólo en "todos", en vez de colarse
    // en una vista que asegura algo que no sabemos.
    if (!g.precio_conocido) return v === '';
    if (v === 'distinto') return g.cobran_distinto;
    if (v === '5') return g.cobran_distinto && this.pct(g) >= 5;
    if (v === '25') return g.cobran_distinto && this.pct(g) >= 25;
    return true;
  }

  pct(g: DupBarcodeRow): number {
    if (g.precio_min == null || g.precio_max == null || g.precio_min <= 0) return 0;
    return ((g.precio_max - g.precio_min) / g.precio_min) * 100;
  }

}
