import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { map } from 'rxjs/operators';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { makeDebouncedSearch } from '../../../shared/util';
import { CostoEstandarService } from '../costo-estandar.service';
import { FiltroTipo, eventosTrazabilidad, graficaHistorial } from '../costos-historial.util';

const VEREDICTO: Record<string, string> = {
  apegada: 'apegada',
  arriba: 'arriba',
  abajo: 'abajo',
  sin_cargo: 'sin cargo',
  no_comparable: 'no comparable',
};

const TIPO: Record<string, string> = {
  estandar: 'Costo estándar',
  entrada: 'Costo de entrada',
  primera: 'Primera entrada',
  entrada_igual: 'Entrada sin cambio',
};

/**
 * `[CAT-COSTO.5]` — **Costos · Etapa 2: trazabilidad de un producto.**
 *
 * Cómo fue cambiando el costo estándar negociado y el costo de entrada, sucursal por sucursal.
 * El servidor arma las dos historias (`historial-costos.ts`); aquí sólo se filtra y se pinta con
 * funciones puras (`costos-historial.util.ts`).
 */
@Component({
  selector: 'app-compras-costos-historial',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, CheckboxModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ch-filtros" aria-label="Filtros del historial">
      <div class="ch-f ch-buscar">
        <label for="ch-prod">Producto</label>
        <input id="ch-prod" type="search" [value]="texto" (input)="onBuscar($any($event.target).value)"
               placeholder="SKU o nombre" autocomplete="off" spellcheck="false" />
        @if (sugerencias().length) {
          <ul class="ch-sug" role="listbox" aria-label="Productos encontrados">
            @for (s of sugerencias(); track s.sku) {
              <li><button type="button" (click)="elegir(s.sku)">
                <span class="ch-mono">{{ s.sku }}</span> {{ s.nombre }}
              </button></li>
            }
          </ul>
        }
      </div>
      <label class="ch-f">
        <span>Sucursal</span>
        <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value" [ngModel]="sucursal()"
                  (onChange)="sucursal.set($event.value)" [showClear]="true" placeholder="Todas" appendTo="body"
                  ariaLabel="Sucursal" class="ch-sel" />
      </label>
      <label class="ch-f">
        <span>Proveedor</span>
        <p-select [options]="opcionesProveedor()" optionLabel="label" optionValue="value" [ngModel]="proveedor()"
                  (onChange)="proveedor.set($event.value)" [showClear]="true" placeholder="Todos" appendTo="body"
                  ariaLabel="Proveedor" class="ch-sel" />
      </label>
      <label class="ch-f">
        <span>Desde</span>
        <input type="date" [value]="desde()" (change)="desde.set($any($event.target).value)" />
      </label>
      <label class="ch-f">
        <span>Hasta</span>
        <input type="date" [value]="hasta()" (change)="hasta.set($any($event.target).value)" />
      </label>
      <label class="ch-f">
        <span>Qué cambió</span>
        <p-select [options]="opcionesTipo" optionLabel="label" optionValue="value" [ngModel]="tipo()"
                  (onChange)="tipo.set($event.value)" appendTo="body" ariaLabel="Qué cambió" class="ch-sel" />
      </label>
    </section>

    @if (!sku()) {
      <p class="ch-vacio">Busca un producto para ver cómo cambió su costo estándar y su costo de entrada en cada sucursal.</p>
    } @else if (error()) {
      <p class="ch-error" role="alert">No se pudo cargar el historial de {{ sku() }}. Intenta de nuevo en un momento.</p>
    } @else if (datos(); as d) {
      <section class="ch-cabeza">
        <div>
          <p class="ch-meta"><span class="ch-mono">{{ d.sku }}</span> · {{ d.proveedor || 'sin proveedor' }}</p>
          <p class="ch-titulo">{{ d.nombre || 'Sin nombre en catálogo' }}</p>
        </div>
        <dl class="ch-kpis">
          <div><dt>Cambios de estándar</dt><dd>{{ conteo().estandar }}</dd></div>
          <div><dt>Cambios en entrada</dt><dd>{{ conteo().entrada }}</dd></div>
          <div><dt>Entradas arriba del estándar</dt><dd class="is-bad">{{ conteo().arriba }}</dd></div>
        </dl>
      </section>

      <section class="ch-grafica" aria-label="Gráfica de costos">
        <div class="ch-grafica-cab">
          <h2>Costo por unidad base</h2>
          <span class="ch-leyenda">
            <span class="ch-ley-linea"></span> Estándar de {{ grafica().sucursalLinea || '—' }}
            <span class="ch-ley-punto"></span> Costo de entrada
          </span>
        </div>
        <svg viewBox="0 0 1000 230" class="ch-svg" role="img"
             [attr.aria-label]="'Costo estándar de ' + (grafica().sucursalLinea || 'ninguna sucursal') + ' en escalones y cada entrada como punto'">
          @for (e of grafica().ejeY; track e.y) {
            <line x1="50" x2="1000" [attr.y1]="e.y - 4" [attr.y2]="e.y - 4" class="ch-grid" />
            <text x="0" [attr.y]="e.y" class="ch-eje">{{ e.t }}</text>
          }
          @for (e of grafica().ejeX; track e.x) {
            <text [attr.x]="e.x" y="226" class="ch-eje">{{ e.t }}</text>
          }
          @if (grafica().linea) {
            <polyline [attr.points]="grafica().linea" class="ch-linea" />
          }
          @for (p of grafica().puntos; track $index) {
            <circle [attr.cx]="p.x" [attr.cy]="p.y" r="5" class="ch-punto"><title>{{ p.titulo }}</title></circle>
          }
        </svg>
        @if (grafica().lineaPlana) {
          <p class="ch-nota">El estándar de {{ grafica().sucursalLinea || 'esta sucursal' }} no cambió en el periodo, o no hubo venta para verlo: la línea es plana.</p>
        }
        @if (!sucursal()) {
          <p class="ch-nota">La línea muestra el estándar de una sola sucursal. Elige una en el filtro para ver la suya.</p>
        }
      </section>

      <section class="ch-tabla" aria-label="Trazabilidad de cambios">
        <div class="ch-tabla-cab">
          <div>
            <h2>Trazabilidad de cambios</h2>
            <p>El cambio de entrada se mide contra la entrada anterior de la misma sucursal.</p>
          </div>
          <label class="ch-chk">
            <p-checkbox [binary]="true" inputId="ch-igual" [ngModel]="incluirSinCambio()" (ngModelChange)="incluirSinCambio.set(!!$event)" />
            <span>Incluir entradas sin cambio de costo</span>
          </label>
        </div>
        <p-table [value]="eventos()" size="small" class="surf-table">
          <ng-template #header>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Sucursal</th>
              <th scope="col">Qué cambió</th>
              <th scope="col" class="ch-num">Antes</th>
              <th scope="col" class="ch-num">Después</th>
              <th scope="col" class="ch-num">Cambio</th>
              <th scope="col">Documento</th>
              <th scope="col">Proveedor</th>
              <th scope="col" class="ch-num">Contra estándar vigente</th>
            </tr>
          </ng-template>
          <ng-template #body let-e>
            <tr [class.is-tenue]="e.tipo === 'entrada_igual'">
              <td class="ch-nowrap">{{ e.fecha }}</td>
              <td>{{ e.sucursal || 'sin plaza' }}</td>
              <td><span class="ch-tipo" [class]="'ch-tipo ch-tipo-' + e.tipo">{{ tipoTxt(e.tipo) }}</span></td>
              <td class="ch-num ch-mono">{{ e.antes === null ? '—' : dinero(e.antes) }}</td>
              <td class="ch-num ch-mono ch-fuerte">{{ e.despues === null ? '—' : dinero(e.despues) }}</td>
              <td class="ch-num ch-mono">{{ e.cambio_pct === null ? '—' : pct(e.cambio_pct) }}</td>
              <td><div class="ch-mono">{{ e.documento }}</div><div class="ch-sub">{{ e.nota }}</div></td>
              <td>{{ e.proveedor || '—' }}</td>
              <td class="ch-num">
                @if (e.veredicto) {
                  <span class="ch-ver" [class]="'ch-ver ch-ver-' + e.veredicto">
                    {{ verTxt(e.veredicto) }}{{ e.vs_estandar_pct !== null && e.veredicto !== 'apegada' ? ' ' + pct(e.vs_estandar_pct) : '' }}
                  </span>
                  @if (e.motivo) { <div class="ch-sub">{{ e.motivo }}</div> }
                } @else { — }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="9" class="ch-vacio">No hubo cambios con estos filtros.</td></tr>
          </ng-template>
        </p-table>
        <p class="ch-nota">El cambio de costo estándar se detecta en la venta: la fecha es la de la primera venta con el costo nuevo
          en esa sucursal, no la del día exacto en que se editó la ficha. El de entrada tiene la fecha de la orden de entrada.</p>
      </section>
    } @else {
      <p class="ch-vacio">Cargando historial…</p>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 1rem; }
    .ch-filtros { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end;
      background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: .625rem .875rem; }
    .ch-f { display: flex; flex-direction: column; gap: .2rem; font-size: var(--fs-xs); color: var(--c-text-2); position: relative; }
    .ch-f input { height: 2.25rem; border: 1px solid var(--c-divider); border-radius: 8px; padding: 0 .6rem;
      font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .ch-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .ch-buscar input { width: 18rem; max-width: 100%; }
    .ch-sel { min-width: 11rem; }
    .ch-sug { position: absolute; top: 100%; left: 0; z-index: 5; margin: .25rem 0 0; padding: .25rem; list-style: none;
      min-width: 22rem; max-width: 90vw; background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 8px; }
    .ch-sug button { display: block; width: 100%; min-height: 2.25rem; text-align: left; background: none; border: none;
      padding: .25rem .5rem; font: inherit; font-size: var(--fs-sm); color: var(--c-text-1); border-radius: 6px; cursor: pointer; }
    .ch-sug button:hover, .ch-sug button:focus-visible { background: var(--c-surface-2); }
    .ch-cabeza { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: center; justify-content: space-between;
      background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: 1rem 1.25rem; }
    .ch-meta { margin: 0; font-size: var(--fs-xs); color: var(--c-text-3); }
    .ch-titulo { margin: .15rem 0 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ch-kpis { display: flex; gap: 1.5rem; margin: 0; }
    .ch-kpis dt { font-size: var(--fs-xs); color: var(--c-text-2); }
    .ch-kpis dd { margin: 0; font-family: var(--font-mono); font-size: var(--fs-lg); color: var(--c-text-1); }
    .ch-kpis dd.is-bad { color: var(--bad-fg); }
    .ch-grafica, .ch-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: 1rem 1.25rem; }
    .ch-grafica-cab, .ch-tabla-cab { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; justify-content: space-between; }
    h2 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ch-tabla-cab p { margin: .2rem 0 .5rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .ch-leyenda { display: inline-flex; align-items: center; gap: .5rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .ch-ley-linea { display: inline-block; width: 1.1rem; height: 2px; background: var(--c-text-1); }
    .ch-ley-punto { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: var(--action); margin-left: .5rem; }
    .ch-svg { width: 100%; height: auto; display: block; margin-top: .5rem; }
    .ch-grid { stroke: var(--c-divider); stroke-width: 1; }
    .ch-eje { fill: var(--c-text-3); font-size: var(--fs-xs); font-family: var(--font-mono); }
    .ch-linea { fill: none; stroke: var(--c-text-1); stroke-width: 2; }
    .ch-punto { fill: var(--action); }
    .ch-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .ch-num { text-align: right; white-space: nowrap; }
    .ch-nowrap { white-space: nowrap; }
    .ch-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ch-fuerte { font-weight: var(--fw-bold); }
    .ch-sub { font-size: var(--fs-xs); color: var(--c-text-3); }
    tr.is-tenue td { color: var(--c-text-3); }
    .ch-tipo { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-2); }
    .ch-tipo-estandar { background: var(--c-text-1); color: var(--c-surface-1); }
    .ch-tipo-entrada, .ch-tipo-primera { background: var(--warn-soft-bg); color: var(--c-text-1); }
    .ch-ver { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-1); font-family: var(--font-mono); }
    .ch-ver-arriba { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .ch-ver-abajo, .ch-ver-sin_cargo { background: var(--ok-soft-bg); color: var(--c-text-1); }
    .ch-ver-no_comparable { color: var(--c-text-3); }
    .ch-nota { margin: .5rem 0 0; font-size: var(--fs-xs); color: var(--c-text-2); max-width: 60rem; }
    .ch-vacio { color: var(--c-text-2); font-size: var(--fs-sm); text-align: center; padding: 1.5rem; }
    .ch-error { color: var(--bad-fg); font-size: var(--fs-sm); }
  `],
})
export class ComprasCostosHistorialComponent {
  /** SKU que llega desde la URL (o al hacer clic en un producto de «Entre sucursales»). */
  readonly sku = input<string | null>(null);
  readonly skuElegido = output<string>();

  private readonly api = inject(CostoEstandarService);

  texto = '';
  private readonly q = signal('');
  readonly sucursal = signal<string | null>(null);
  readonly proveedor = signal<string | null>(null);
  readonly tipo = signal<FiltroTipo>('ambos');
  readonly incluirSinCambio = signal(false);
  readonly hasta = signal(new Date().toISOString().slice(0, 10));
  readonly desde = signal(new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10));

  readonly opcionesTipo = [
    { label: 'Estándar y entrada', value: 'ambos' },
    { label: 'Sólo costo estándar', value: 'estandar' },
    { label: 'Sólo costo de entrada', value: 'entrada' },
  ];

  private readonly res = rxResource({
    params: () => ({ sku: this.sku(), desde: this.desde(), hasta: this.hasta() }),
    stream: ({ params }) => (params.sku ? this.api.historial(params.sku, params.desde, params.hasta) : of(null)),
  });
  readonly datos = computed(() => (this.res.error() ? null : this.res.value()));
  readonly error = computed(() => !!this.res.error());

  private readonly busquedaRes = rxResource({
    params: () => this.q(),
    stream: ({ params }) =>
      params.length < 2
        ? of([])
        : this.api.listar({ q: params, limite: 40 }).pipe(
            map((r) => {
              const vistos = new Map<string, string>();
              for (const f of r.filas) if (!vistos.has(f.sku)) vistos.set(f.sku, f.nombre ?? '');
              return [...vistos].slice(0, 8).map(([sku, nombre]) => ({ sku, nombre }));
            }),
          ),
  });
  readonly sugerencias = computed(() => this.busquedaRes.value() ?? []);

  private readonly filtros = computed(() => ({
    sucursal: this.sucursal(),
    proveedor: this.proveedor(),
    tipo: this.tipo(),
    incluirSinCambio: this.incluirSinCambio(),
  }));
  readonly eventos = computed(() => {
    const d = this.datos();
    return d ? eventosTrazabilidad(d, this.filtros()) : [];
  });
  readonly grafica = computed(() => {
    const d = this.datos();
    return d
      ? graficaHistorial(d, this.filtros())
      : { linea: '', sucursalLinea: null, lineaPlana: true, puntos: [], ejeY: [], ejeX: [] };
  });
  readonly conteo = computed(() => {
    const ev = this.eventos();
    return {
      estandar: ev.filter((e) => e.tipo === 'estandar').length,
      entrada: ev.filter((e) => e.tipo === 'entrada').length,
      arriba: ev.filter((e) => e.veredicto === 'arriba').length,
    };
  });
  readonly opcionesSucursal = computed(() =>
    (this.datos()?.sucursales ?? []).map((s) => ({ label: s.nombre ? `${s.codigo} · ${s.nombre}` : s.codigo, value: s.codigo })),
  );
  readonly opcionesProveedor = computed(() =>
    [...new Set((this.datos()?.entradas ?? []).map((e) => e.proveedor).filter((p): p is string => !!p))]
      .sort()
      .map((p) => ({ label: p, value: p })),
  );

  private readonly buscar = makeDebouncedSearch((v) => this.q.set(v.trim()));
  onBuscar(v: string): void {
    this.texto = v;
    this.buscar(v);
  }
  elegir(sku: string): void {
    this.texto = '';
    this.q.set('');
    this.skuElegido.emit(sku);
  }

  tipoTxt(t: string): string {
    return TIPO[t] ?? t;
  }
  verTxt(v: string): string {
    return VEREDICTO[v] ?? v;
  }
  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  }
  pct(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} %`;
  }
}
