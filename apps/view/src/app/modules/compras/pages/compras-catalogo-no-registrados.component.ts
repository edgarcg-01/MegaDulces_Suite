import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { FaltantesService, type NoRegistrado } from '../../tienda/faltantes.service';

interface Opcion { label: string; value: string }

/**
 * `[MOS.2]` — **No registrados**, pestaña del Catálogo de Compras.
 *
 * Los códigos que se escanearon en el mostrador («¿Te pidieron algo?» del arqueo) y Kepler no
 * reconoció en esa sucursal. Quien la abre va a Kepler y da de alta el producto; **en cuanto
 * aparece allá, sale solo de esta lista** (el servidor compara contra `kepler_ods.kdii` de la
 * sucursal en cada lectura — ver `no-registrados.sql.ts`). No hay botón de «ya lo registré»: que
 * salga solo es lo que garantiza que se registró de verdad.
 *
 * Pantalla limpia a pedido de quien la usa: sólo los productos por trabajar, con sucursal,
 * proveedor y búsqueda por SKU o nombre. La lista llega COMPLETA (con tope declarado), así que el
 * filtro en el cliente ve todo; si alguna vez se llega al tope, se dice.
 */
@Component({
  selector: 'app-compras-catalogo-no-registrados',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, TooltipModule,
    PageTabsComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page nr">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>No registrados</h1>
        </div>
        <button pButton type="button" class="p-button-sm p-button-text" [loading]="cargando()"
                (click)="recargar()" pTooltip="Volver a revisar contra Kepler" aria-label="Volver a revisar contra Kepler">
          <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
        </button>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <div class="nr-filtros">
        <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                  [ngModel]="sucursal()" (onChange)="sucursal.set($event.value ?? '')"
                  [showClear]="true" placeholder="Todas las sucursales" appendTo="body"
                  ariaLabel="Sucursal" class="nr-sel" />
        <p-select [options]="opcionesProveedor()" optionLabel="label" optionValue="value"
                  [ngModel]="proveedor()" (onChange)="proveedor.set($event.value ?? '')"
                  [filter]="true" filterBy="label" [showClear]="true" placeholder="Todos los proveedores"
                  appendTo="body" ariaLabel="Proveedor" class="nr-sel" />
        <input type="search" class="nr-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="SKU o nombre" aria-label="Buscar por SKU o nombre" autocomplete="off" spellcheck="false" />
        @if (datos()) {
          <span class="nr-n">{{ filas().length | number }} de {{ total() | number }} productos</span>
        }
      </div>

      @if (recortado()) {
        <p class="nr-aviso" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          Hay más códigos de los que caben en esta lista; se muestran los más recientes.
        </p>
      }

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!!datos() && total() === 0"
                      emptyIcon="pi-check-circle" emptyTitle="No hay productos por registrar"
                      emptyHint="Todo lo que se escaneó en el mostrador ya existe en Kepler."
                      (retry)="recargar()">
        <div class="dt-scope">
          <p-table [value]="filas()" [paginator]="filas().length > 50" [rows]="50" dataKey="cosa"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first">
            <ng-template #header>
              <tr>
                <th scope="col">Código escaneado</th>
                <th scope="col">SKU</th>
                <th scope="col">Producto</th>
                <th scope="col">Proveedor</th>
                <th scope="col">Sucursal</th>
                <th scope="col" class="comm-num">Veces</th>
                <th scope="col">Última vez</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td class="nr-mono">{{ f.scanned_code || '—' }}</td>
                <td class="nr-mono">{{ f.sku || '—' }}</td>
                <td>
                  @if (!f.nombre) {
                    <span class="nr-faint">Sin descripción</span>
                  } @else if (f.nombre_escrito) {
                    <span class="nr-escrito">«{{ f.nombre }}»</span> <span class="nr-faint">escrito en caja</span>
                  } @else {
                    {{ f.nombre }}
                  }
                </td>
                <td>{{ f.proveedor || '—' }}</td>
                <td>{{ f.warehouse_name || f.warehouse_code }}</td>
                <td class="comm-num nr-mono">{{ f.veces }}</td>
                <td class="nr-muted">{{ f.ultima_vez | date:'dd/MM/yy HH:mm':'-0600' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7" class="nr-vacio">Ningún producto coincide con los filtros.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .nr-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin: var(--sp-3) 0; }
    .nr-sel { min-width: 13rem; }
    .nr-buscar { flex: 1 1 14rem; max-width: 22rem; min-width: 0; min-height: 2.25rem; padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg);
      color: var(--text-main); font: inherit; font-size: var(--fs-sm); }
    .nr-buscar:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .nr-n { margin-left: auto; font-size: var(--fs-xs); color: var(--text-muted); }
    .nr-aviso { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-3);
      padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-xs);
      background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .nr-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); }
    .nr-muted { color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; }
    .nr-faint { color: var(--text-faint); font-size: var(--fs-xs); }
    .nr-escrito { font-style: italic; color: var(--text-muted); }
    .nr-vacio { text-align: center; padding: var(--sp-6) var(--sp-3); color: var(--text-muted); }
  `],
})
export class ComprasCatalogoNoRegistradosComponent implements OnInit {
  readonly tabs = CATALOGO_TABS;
  private readonly api = inject(FaltantesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<NoRegistrado[] | null>(null);
  readonly recortado = signal(false);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly sucursal = signal('');
  readonly proveedor = signal('');
  readonly busqueda = signal('');

  readonly total = computed(() => this.datos()?.length ?? 0);

  readonly opcionesSucursal = computed<Opcion[]>(() => {
    const m = new Map<string, string>();
    for (const f of this.datos() ?? []) m.set(f.warehouse_code, f.warehouse_name || f.warehouse_code);
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  });

  readonly opcionesProveedor = computed<Opcion[]>(() => {
    const s = new Set<string>();
    for (const f of this.datos() ?? []) if (f.proveedor) s.add(f.proveedor);
    return [...s].sort((a, b) => a.localeCompare(b)).map((p) => ({ value: p, label: p }));
  });

  /**
   * Los filtros sobre la lista COMPLETA. Un código sin proveedor (no existe en Kepler) sólo se ve
   * con «Todos los proveedores»: no tiene a quién pertenecer todavía.
   */
  readonly filas = computed<NoRegistrado[]>(() => {
    const suc = this.sucursal();
    const prov = this.proveedor();
    const base = (this.datos() ?? []).filter((f) =>
      (!suc || f.warehouse_code === suc) && (!prov || f.proveedor === prov));
    return filtrarPorBusqueda(base, this.busqueda(), (f) => [f.sku, f.nombre, f.scanned_code]);
  });

  ngOnInit(): void { this.recargar(); }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.noRegistrados().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.datos.set(r.filas);
        this.recortado.set(r.recortado);
        this.cargando.set(false);
      },
      error: (e: { error?: { message?: string } }) => {
        this.cargando.set(false);
        this.error.set(e?.error?.message || 'No se pudo leer la lista. Revisa la conexión y vuelve a intentar.');
      },
    });
  }
}
