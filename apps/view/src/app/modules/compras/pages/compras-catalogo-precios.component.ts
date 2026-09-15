import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
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
import { ComercialService, PriceGapRow } from '../../comercial/comercial.service';

type Vista = '' | 'pieza' | 'mayoreo' | 'unidad';

/**
 * `[CAT.3]` — **Precios distintos**, pestaña del Catálogo de Compras.
 *
 * El cliente que compra el mismo dulce en 8 Esquinas y en Padre Hidalgo debería pagar lo mismo.
 * Cuando no pasa, casi siempre es que alguien actualizó el precio en una plaza y no se replicó —
 * no una decisión comercial.
 *
 * Dos defectos, y se reportan por separado porque se corrigen en pantallas distintas de Kepler:
 *   **pieza** (el precio normal difiere) y **mayoreo** (el normal coincide pero el de volumen no —
 *   se ve menos y duele igual: quien se lleva una caja paga distinto según dónde entre).
 *
 * ⚠️ El corte entre "diferencia de precio" y "revisar la unidad" es una HEURÍSTICA: 3× o más
 * entre plazas. Funciona para los extremos (hay casos de 21,870 %, que son claramente unidad) pero
 * NO es limpio en el borde — medido en prod, `MEGA HUEVO BUILDERS` sale $9.68 contra $28.81, o sea
 * 197.6 %, y se queda del lado de "precio" por dos décimas. Ahí hace falta ojo humano; la pantalla
 * lo dice en vez de fingir que separó bien.
 *
 * ⚠️ Esta pantalla NO dice cuál precio es el correcto. Para eso hay que saber **cuál se actualizó
 * al último**, y la tabla de origen no guarda esa historia. Acá se muestra la dispersión y en qué
 * plaza está cada extremo; decidir quién manda es trabajo de la fase Red de Precios. Prometer más
 * que eso sería mandar a alguien a “corregir” el precio bueno.
 */
@Component({
  selector: 'app-compras-catalogo-precios',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, TooltipModule,
    PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pg">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Precios distintos</h1>
          <p class="surf-page-sub">
            El mismo producto a distinto precio según la sucursal. Se corrige en Kepler.
          </p>
        </div>
        <div class="pg-head-actions">
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="cargando()"
                  (click)="recargar()" pTooltip="Refrescar">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <!--
        Sin grano por sucursal no hay nada que comparar. Se DICE, en vez de devolver una lista
        vacía que se lea como "todo alineado" — que es exactamente lo contrario de lo que sabemos.
      -->
      @if (comparable() === false) {
        <div class="pg-aviso" role="status">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <div>
            <strong>Esta base no guarda el precio por sucursal.</strong>
            <span>Sin eso no se puede comparar entre plazas: la tabla de etiquetas tiene una sola
              fila por producto. Los códigos repetidos sí se ven en su pestaña.</span>
          </div>
        </div>
      }

      <div class="pg-kpis">
        <div class="pg-kpi">
          <span class="pg-k">Con diferencia</span>
          <span class="pg-v pg-bad">{{ filas().length | number }}</span>
          <span class="pg-d">productos que no cuestan lo mismo en toda la red</span>
        </div>
        <div class="pg-kpi">
          <span class="pg-k">Diferencia mayor</span>
          <span class="pg-v pg-bad">{{ peor() | number:'1.1-1' }} %</span>
          <span class="pg-d">el caso más grave de la lista</span>
        </div>
        <div class="pg-kpi">
          <span class="pg-k">Arriba de 25 %</span>
          <span class="pg-v pg-warn">{{ mayores(25) | number }}</span>
          <span class="pg-d">no se explica por plaza</span>
        </div>
        <div class="pg-kpi">
          <span class="pg-k">Revisar la unidad</span>
          <span class="pg-v pg-warn">{{ conteo('unidad') | number }}</span>
          <span class="pg-d">una plaza cobra 3× lo de otra: no es precio, es unidad</span>
        </div>
      </div>

      <div class="pg-filtros">
        <input type="search" class="pg-input" [(ngModel)]="busqueda" (keyup.enter)="recargar()"
               placeholder="Nombre, SKU o código de barras" aria-label="Buscar" />
        <button pButton type="button" class="p-button-sm p-button-outlined" (click)="recargar()">
          <span class="p-button-label">Buscar</span>
        </button>
      </div>

      <!-- Las vistas a la vista, con su conteo: se elige sabiendo cuánto hay detrás. -->
      <div class="pg-seg" role="tablist" aria-label="Qué mirar">
        @for (v of vistas; track v.value) {
          <button type="button" role="tab" class="pg-seg-btn" [class.pg-seg-on]="vista() === v.value"
                  [attr.aria-selected]="vista() === v.value" (click)="vista.set(v.value)">
            <span>{{ v.label }}</span>
            <span class="pg-seg-n">{{ conteo(v.value) | number }}</span>
          </button>
        }
      </div>

      @if (vista() === 'unidad') {
        <div class="pg-aviso" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <div>
            <strong>Esto probablemente no es un precio mal capturado: es la unidad.</strong>
            <span>Una plaza cobra 3 veces o más lo de otra por el mismo SKU. Casi siempre una
              capturó el precio por pieza y la otra por caja. Se muestran aparte para que no
              entierren las diferencias reales — pero también hay que corregirlas. El corte en 3×
              es una regla práctica: los casos cerca del límite (150–200 %) pueden ser cualquiera
              de las dos cosas y hay que mirarlos.</span>
          </div>
        </div>
      }

      <p-table [value]="filas()" [loading]="cargando()" dataKey="sku"
               styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--zebra"
               [rowHover]="true" [expandedRowKeys]="abiertos">
        <ng-template #header>
          <tr>
            <th scope="col" style="width:2.5rem"><span class="sr-only">Abrir</span></th>
            <th scope="col">Producto</th>
            <th scope="col" class="pg-r">Precio normal</th>
            <th scope="col" class="pg-r">Mayoreo</th>
            <th scope="col" class="pg-r">Sucursales</th>
            <th scope="col">Dónde está la diferencia</th>
          </tr>
        </ng-template>

        <ng-template #body let-r let-abierto="expanded">
          <tr>
            <td>
              <button type="button" class="pg-exp" [pRowToggler]="r"
                      [attr.aria-label]="abierto ? 'Cerrar' : 'Ver el precio de cada sucursal'">
                <i [class]="abierto ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-hidden="true"></i>
              </button>
            </td>
            <td>
              <div class="pg-nombre">
                {{ r.nombre || r.sku }}
                @if (r.sospecha_unidad) {
                  <span class="pg-tag" pTooltip="Una plaza cobra 3× lo de otra: revisá la unidad, no el precio"
                        tooltipPosition="top">unidad</span>
                }
              </div>
              <div class="pg-meta">
                <code class="comm-code">{{ r.sku }}</code>
                @if (r.barcode) { <span class="pg-bc">{{ r.barcode }}</span> }
                @if (r.supplier_name) { <span>· {{ r.supplier_name }}</span> }
              </div>
            </td>
            <td class="pg-r">
              @if (r.pieza_pct > 0) {
                <span class="pg-num" [class.pg-bad]="r.pieza_pct >= 25" [class.pg-warn]="r.pieza_pct >= 5 && r.pieza_pct < 25">
                  {{ r.pieza_min | currency:'MXN':'symbol-narrow':'1.2-2' }} –
                  {{ r.pieza_max | currency:'MXN':'symbol-narrow':'1.2-2' }}
                </span>
                <small class="pg-small">{{ r.pieza_pct | number:'1.1-1' }} %</small>
              } @else {
                <span class="pg-ok-txt">igual en toda la red</span>
              }
            </td>
            <td class="pg-r">
              @if (r.mayoreo_pct > 0) {
                <span class="pg-num" [class.pg-bad]="r.mayoreo_pct >= 25" [class.pg-warn]="r.mayoreo_pct >= 5 && r.mayoreo_pct < 25">
                  {{ r.mayoreo_min | currency:'MXN':'symbol-narrow':'1.2-2' }} –
                  {{ r.mayoreo_max | currency:'MXN':'symbol-narrow':'1.2-2' }}
                </span>
                <small class="pg-small">{{ r.mayoreo_pct | number:'1.1-1' }} %</small>
              } @else if (r.mayoreo_min != null) {
                <span class="pg-ok-txt">igual</span>
              } @else {
                <span class="pg-muted">sin mayoreo</span>
              }
            </td>
            <td class="pg-r pg-num pg-muted">{{ r.sucursales }}</td>
            <td>
              @if (r.suc_barata && r.suc_cara && r.pieza_pct > 0) {
                <span class="pg-plaza">{{ r.suc_barata }} más barata</span>
                <span class="pg-flecha" aria-hidden="true">→</span>
                <span class="pg-plaza pg-plaza-cara">{{ r.suc_cara }} más cara</span>
              } @else {
                <span class="pg-muted">sólo en el mayoreo</span>
              }
            </td>
          </tr>
        </ng-template>

        <ng-template #expandedrow let-r>
          <tr class="pg-detalle">
            <td [attr.colspan]="6">
              <table class="pg-mini">
                <thead>
                  <tr>
                    <th scope="col">Sucursal</th>
                    <th scope="col" class="pg-r">Precio normal</th>
                    <th scope="col" class="pg-r">Mayoreo</th>
                    <th scope="col" class="pg-r">Desde</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of r.por_sucursal; track s.sucursal) {
                    <tr>
                      <td>{{ s.sucursal }}</td>
                      <td class="pg-r pg-num"
                          [class.pg-bad]="s.pieza === r.pieza_max && r.pieza_pct > 0"
                          [class.pg-ok]="s.pieza === r.pieza_min && r.pieza_pct > 0">
                        {{ s.pieza == null ? '—' : (s.pieza | currency:'MXN':'symbol-narrow':'1.2-2') }}
                      </td>
                      <td class="pg-r pg-num">
                        {{ s.mayoreo == null ? '—' : (s.mayoreo | currency:'MXN':'symbol-narrow':'1.2-2') }}
                      </td>
                      <td class="pg-r pg-num pg-muted">{{ s.desde || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              <p class="pg-pie">
                ⚠️ Esta pantalla <strong>no dice cuál precio es el correcto</strong>: para eso hay
                que saber cuál se actualizó al último, y la tabla de origen no guarda esa historia.
                Muestra dónde está la diferencia; la corrección se captura en Kepler.
              </p>
            </td>
          </tr>
        </ng-template>

        <ng-template #emptymessage>
          <tr>
            <td [attr.colspan]="6" class="pg-vacio">
              @if (cargando()) { Comparando precios entre sucursales… }
              @else if (comparable() === false) { No hay precio por sucursal en esta base. }
              @else { Ningún producto con precios distintos entre sucursales. }
            </td>
          </tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pg-head-actions { display: flex; gap: .5rem; align-items: center; }

    .pg-aviso {
      display: flex; gap: .6rem; align-items: flex-start;
      margin-top: 1rem; padding: .7rem .875rem;
      border: 1px solid var(--c-divider); border-left: 3px solid var(--warn-fg);
      border-radius: 6px; background: var(--warn-bg);
      font-size: var(--fs-xs); color: var(--c-text-2);
    }
    .pg-aviso strong { display: block; color: var(--c-text-1); margin-bottom: .1rem; }
    .pg-aviso i { margin-top: .15rem; }

    .pg-kpis {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
      border: 1px solid var(--c-divider); border-radius: 8px;
      background: var(--c-surface-0); margin: 1rem 0 .75rem; overflow: hidden;
    }
    .pg-kpi { padding: .75rem .875rem; border-left: 1px solid var(--c-divider); display: flex; flex-direction: column; }
    .pg-kpi:first-child { border-left: 0; }
    .pg-k { font-size: .66rem; letter-spacing: .07em; text-transform: uppercase; color: var(--c-text-3); font-weight: 600; }
    .pg-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 1.35rem; margin-top: .2rem; }
    .pg-d { font-size: .7rem; color: var(--c-text-2); margin-top: .15rem; }

    .pg-filtros { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
    .pg-input {
      padding: .35rem .5rem; border: 1px solid var(--c-divider); border-radius: 6px;
      background: var(--c-surface-1); min-width: 16rem; color: var(--c-text-1);
    }

    .pg-seg { display: flex; flex-wrap: wrap; gap: .3rem; margin-bottom: .6rem; }
    .pg-seg-btn {
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .3rem .6rem; border: 1px solid var(--c-divider); border-radius: 999px;
      background: var(--c-surface-0); color: var(--c-text-2);
      font-size: var(--fs-xs); font-weight: var(--fw-medium); cursor: pointer;
    }
    .pg-seg-btn:hover { background: var(--c-surface-2); color: var(--c-text-1); }
    .pg-seg-btn:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .pg-seg-on { border-color: var(--action); background: var(--c-surface-2); color: var(--c-text-1); font-weight: var(--fw-bold); }
    .pg-seg-n {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: .68rem; padding: 0 .3rem; border-radius: 4px;
      background: var(--c-surface-2); color: var(--c-text-2);
    }
    .pg-seg-on .pg-seg-n { background: var(--action); color: #fff; }

    .pg-r { text-align: right; }
    .pg-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pg-muted { color: var(--c-text-2); }
    .pg-small { display: block; font-size: .68rem; color: var(--c-text-3); font-family: var(--font-mono); }
    .pg-bad { color: var(--bad-fg); }
    .pg-warn { color: var(--warn-fg); }
    .pg-ok { color: var(--ok-fg); }
    .pg-ok-txt { font-size: .72rem; color: var(--ok-fg); }

    .pg-nombre { font-weight: var(--fw-bold); font-size: .82rem; }
    .pg-meta { font-size: .7rem; color: var(--c-text-2); display: flex; gap: .3rem; flex-wrap: wrap; align-items: center; }
    .pg-bc { font-family: var(--font-mono); }
    .pg-tag {
      display: inline-block; margin-left: .3rem; padding: 0 .35rem; border-radius: 4px;
      font-size: .6rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
      color: var(--warn-fg); background: var(--warn-bg); border: 1px solid var(--warn-fg);
    }

    .pg-plaza { font-size: .75rem; }
    .pg-plaza-cara { color: var(--bad-fg); font-weight: var(--fw-bold); }
    .pg-flecha { margin: 0 .3rem; color: var(--c-text-3); }

    .pg-exp { background: none; border: 0; color: var(--c-text-2); cursor: pointer; padding: .15rem .3rem; }
    .pg-exp:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    .pg-detalle > td { background: var(--c-surface-1); }
    .pg-mini { width: 100%; border-collapse: collapse; }
    .pg-mini th {
      text-align: left; font-size: .62rem; letter-spacing: .05em; text-transform: uppercase;
      color: var(--c-text-3); padding: .25rem .4rem; border-bottom: 1px solid var(--c-divider);
    }
    .pg-mini th.pg-r { text-align: right; }
    .pg-mini td { padding: .25rem .4rem; font-size: .78rem; border-bottom: 1px solid var(--c-divider); }
    .pg-pie { margin: .5rem 0 0; font-size: .72rem; color: var(--c-text-2); max-width: 88ch; }
    .pg-pie strong { color: var(--c-text-1); }

    .pg-vacio { text-align: center; padding: 1.75rem .75rem; color: var(--c-text-2); }

    @media (max-width: 900px) {
      .pg-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .pg-kpi { border-top: 1px solid var(--c-divider); }
      .pg-kpi:nth-child(-n+2) { border-top: 0; }
      .pg-kpi:nth-child(odd) { border-left: 0; }
    }
  `],
})
export class ComprasCatalogoPreciosComponent implements OnInit {
  readonly tabs = CATALOGO_TABS;

  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Todo lo que trajo el servidor; la vista se deriva, así cambiarla es instantáneo. */
  private readonly todas = signal<PriceGapRow[]>([]);
  readonly cargando = signal(false);
  /** `false` = la base no tiene precio por sucursal. `null` = todavía no se sabe. */
  readonly comparable = signal<boolean | null>(null);
  readonly vista = signal<Vista>('');
  abiertos: Record<string, boolean> = {};
  busqueda = '';

  readonly vistas: { label: string; value: Vista }[] = [
    { label: 'Diferencias de precio', value: '' },
    { label: 'Sólo precio normal', value: 'pieza' },
    { label: 'Sólo mayoreo', value: 'mayoreo' },
    { label: 'Revisar la unidad', value: 'unidad' },
  ];

  readonly filas = computed(() => this.todas().filter((r) => this.pasa(r, this.vista())));
  /** Sobre lo FILTRADO: si contara las sospechas de unidad diría 21,870 % y no querría decir nada. */
  readonly peor = computed(() =>
    this.filas().reduce((m, r) => Math.max(m, r.pieza_pct, r.mayoreo_pct), 0));

  ngOnInit(): void { this.recargar(); }

  conteo(v: Vista): number { return this.todas().filter((r) => this.pasa(r, v)).length; }

  mayores(pct: number): number {
    return this.filas().filter((r) => Math.max(r.pieza_pct, r.mayoreo_pct) >= pct).length;
  }

  /**
   * La sospecha de unidad NO entra en las vistas de precio: si entrara, sus 3,000 % acapararían
   * los primeros lugares y enterrarían las diferencias reales. Tampoco se borra — tiene su propia
   * vista, porque también hay que arreglarla.
   */
  private pasa(r: PriceGapRow, v: Vista): boolean {
    if (v === 'unidad') return r.sospecha_unidad;
    if (r.sospecha_unidad) return false;
    if (v === 'pieza') return r.pieza_pct > 0;
    if (v === 'mayoreo') return r.mayoreo_pct > 0;
    return true;
  }

  recargar(): void {
    this.cargando.set(true);
    this.api.priceDiscrepancies({ search: this.busqueda || undefined, limit: 300 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.comparable.set(r.comparable);
          this.todas.set(r.rows);
          this.cargando.set(false);
        },
        error: (e) => {
          this.cargando.set(false);
          this.toast.add({
            severity: 'error', summary: 'No se pudieron comparar los precios',
            detail: e?.error?.message || 'Revisá que la API esté arriba y que tengas permiso.',
          });
        },
      });
  }
}
