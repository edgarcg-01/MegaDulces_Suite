import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import {
  AntiguedadUltimo,
  ETIQUETA_VEREDICTO_CONTRA_ULTIMO,
  FilaContraUltimo,
  VeredictoContraUltimo,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { CostoEstandarService } from '../costo-estandar.service';

/** Los chips, en el orden en que hay que atenderlos. «Igual» al final: es la meta, no la tarea. */
const CHIPS: { id: VeredictoContraUltimo | ''; tono: 'bad' | 'warn' | 'info' | 'ok' | 'base' }[] = [
  { id: '', tono: 'base' },
  { id: 'estandar_abajo', tono: 'bad' },
  { id: 'estandar_arriba', tono: 'info' },
  { id: 'unidad_no_clara', tono: 'warn' },
  { id: 'sin_compra', tono: 'base' },
  { id: 'igual', tono: 'ok' },
];

const SEVERIDAD: Record<VeredictoContraUltimo, 'danger' | 'info' | 'warn' | 'secondary' | 'success'> = {
  estandar_abajo: 'danger',
  estandar_arriba: 'info',
  unidad_no_clara: 'warn',
  sin_compra: 'secondary',
  sin_estandar: 'secondary',
  igual: 'success',
};

/** La fuente se recalcula de noche: pasado un día y poco, ya no es de hoy. */
const UN_DIA_Y_POCO = 26 * 3600;

/**
 * `[CAT-COSTO.7]` — **Costos · Contra último costo** (la Etapa 2b).
 *
 * El costo estándar de cada sucursal × producto contra lo que costó su última compra (XA2001
 * Aplica Orden Entrada). El estándar es con el que se arma el precio; si quedó por debajo de lo
 * que hoy se paga, el margen planeado sale más alto que el real.
 *
 * La pantalla no decide nada: el resultado, la antigüedad y lo que no se compara vienen del
 * servidor (`clasificarContraUltimo` sobre `analytics.mv_kepler_costos`). Aquí sólo se pinta.
 */
@Component({
  selector: 'app-compras-costos-ultimo',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, SelectModule, CheckboxModule, TagModule, TooltipModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cu">
      <div class="cu-cabeza">
        @if (datos()?.disponible) {
          <app-freshness-pill measures="data" [since]="datos()?.calculado_al ?? null" [staleAfterSec]="unDia" label="costos" />
        }
        <app-context-help topic="costos-kepler" />
      </div>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="noDisponible()"
                      emptyIcon="pi-clock" emptyTitle="Los costos todavía no se han calculado"
                      emptyHint="Se calculan cada noche desde Kepler. Vuelve a entrar mañana." (retry)="recargar()">
        @if (datos(); as d) {
          <!-- La respuesta primero: cuánto pesa el estándar que quedó abajo de lo que hoy se paga. -->
          <p class="cu-titular">
            {{ n(d.resumen.estandar_abajo.filas) }} productos por sucursal tienen el costo estándar por debajo de su última compra
            ({{ dinero(d.resumen.estandar_abajo.venta_30d) }} de venta en 30 días).
          </p>
          <app-metric-strip [items]="kpis()" mode="strip" ariaLabel="Costo estándar contra último costo" />

          <div class="cu-chips" role="group" aria-label="Filtrar por resultado">
            @for (ch of chips; track ch.id) {
              <button type="button" [class]="'cu-chip cu-tono-' + ch.tono"
                      [class.is-sel]="veredicto() === ch.id" [attr.aria-pressed]="veredicto() === ch.id"
                      (click)="onVeredicto(ch.id)">
                <span>{{ ch.id === '' ? 'Todos' : etiqueta(ch.id) }}</span>
                <span class="cu-chip-n">{{ n(conteo(ch.id)) }}</span>
              </button>
            }
          </div>
        }

        <section class="cu-filtros" aria-label="Filtros">
          <label class="cu-f">
            <span>Buscar producto</span>
            <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                   placeholder="SKU o nombre" autocomplete="off" spellcheck="false" />
          </label>
          <label class="cu-f">
            <span>Proveedor</span>
            <p-select [options]="opcionesProveedor()" optionLabel="label" optionValue="value"
                      [ngModel]="proveedor()" (onChange)="onProveedor($event.value)"
                      [filter]="true" filterBy="label" [showClear]="true" placeholder="Todos"
                      appendTo="body" ariaLabel="Proveedor" class="cu-sel" />
          </label>
          <label class="cu-f">
            <span>Sucursal</span>
            <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                      [ngModel]="sucursal()" (onChange)="onSucursal($event.value)"
                      [showClear]="true" placeholder="Todas" appendTo="body" ariaLabel="Sucursal" class="cu-sel" />
          </label>
          <div class="cu-f">
            <span>Antigüedad de la última compra</span>
            <app-segmented [options]="opcionesAntiguedad" [value]="antiguedad()" ariaLabel="Antigüedad de la última compra"
                           (valueChange)="onAntiguedad($event)" />
          </div>
          <label class="cu-chk">
            <p-checkbox [binary]="true" inputId="cu-sin-venta" [ngModel]="incluirSinVenta()" (ngModelChange)="onSinVenta($event)" />
            <span>Incluir productos sin venta en 30 días</span>
          </label>
        </section>

        <div class="cu-tabla">
          <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                   [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                   [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first">
            <ng-template #header>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">Sucursal</th>
                <th scope="col">Unidad</th>
                <th scope="col" class="comm-num">Estándar</th>
                <th scope="col" class="comm-num">Último costo</th>
                <th scope="col">Última compra</th>
                <th scope="col" class="comm-num">Diferencia</th>
                <th scope="col" class="comm-num">Promedio</th>
                <th scope="col" class="comm-num">Venta 30 d</th>
                <th scope="col">Resultado</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td>
                  <button type="button" class="cu-prod" (click)="skuElegido.emit(f.sku)"
                          [attr.aria-label]="'Ver historial de costos de ' + (f.nombre || f.sku)">{{ f.nombre || 'Sin nombre en catálogo' }}</button>
                  <div class="cu-meta"><span class="cu-mono">{{ f.sku }}</span> · {{ f.proveedor || 'sin proveedor' }}</div>
                </td>
                <td>{{ nombreSucursal(f.sucursal) }}</td>
                <td class="cu-unidad">{{ f.unidad_base || 'sin rótulo' }}</td>
                <td class="comm-num cu-mono">{{ dineroONada(f.costo_estandar) }}</td>
                <td class="comm-num cu-mono cu-fuerte">{{ dineroONada(f.costo_ultimo) }}</td>
                <td class="cu-compra">
                  @if (f.ultimo_fecha) {
                    <span class="cu-mono">{{ f.ultimo_fecha }}</span>
                    <div class="cu-meta">
                      XA2001-{{ f.ultimo_folio }}
                      @if (f.ultimo_origen === 'red') { · compra de {{ nombreSucursal(f.ultimo_sucursal) }} }
                    </div>
                  } @else {
                    <span class="cu-sin">{{ textoMotivo(f) }}</span>
                  }
                </td>
                <td class="comm-num cu-mono" [class.cu-mal]="f.veredicto === 'estandar_abajo'">{{ pct(f.diferencia_pct) }}</td>
                <td class="comm-num cu-mono">{{ dineroONada(f.costo_promedio) }}</td>
                <td class="comm-num cu-mono">{{ f.venta_30d > 0 ? dinero(f.venta_30d) : '—' }}</td>
                <td><p-tag [value]="etiqueta(f.veredicto)" [severity]="severidad(f.veredicto)" /></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="10" class="cu-vacio">{{ cargando() ? 'Cargando…' : 'Ningún producto coincide con los filtros.' }}</td></tr>
            </ng-template>
          </p-table>
        </div>

        <footer class="cu-notas">
          <p>Los tres costos están en la unidad base del catálogo y sin impuesto. El último costo sale sólo de compras
            (XA2001 Aplica Orden Entrada): los traspasos y los ajustes no lo mueven. Tolerancia para «Igual»: ±{{ datos()?.tolerancia_pct ?? 1 }} %.</p>
          <p>Si la sucursal nunca compró el producto, se muestra la última compra de otra sucursal y se dice de cuál.
            @if (datos()?.venta_al) { Venta de 30 días al {{ datos()?.venta_al }}. }</p>
        </footer>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cu { display: flex; flex-direction: column; gap: 1rem; container-type: inline-size; }
    .cu-cabeza { display: flex; align-items: center; gap: .5rem; justify-content: flex-end; }
    .cu-titular { margin: 0 0 .75rem; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .cu-chips { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
    .cu-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: 0 .75rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cu-chip:hover { background: var(--c-surface-2); }
    .cu-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cu-chip.is-sel { border-color: var(--action); background: var(--c-surface-2); font-weight: var(--fw-bold); }
    .cu-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-2); }
    .cu-tono-bad .cu-chip-n { color: var(--bad-fg); }
    .cu-tono-warn .cu-chip-n { color: var(--warn-fg); }
    .cu-tono-ok .cu-chip-n { color: var(--ok-fg); }
    .cu-filtros { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; margin-top: 1rem;
      background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; padding: .625rem .875rem; }
    .cu-f { display: flex; flex-direction: column; gap: .2rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .cu-f input { height: 2.25rem; width: 16rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .cu-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .cu-sel { min-width: 14rem; }
    .cu-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .cu-tabla { margin-top: 1rem; background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .cu-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cu-fuerte { font-weight: var(--fw-bold); }
    .cu-mal { color: var(--bad-fg); font-weight: var(--fw-bold); }
    .cu-prod { font-weight: var(--fw-bold); color: var(--c-text-1); background: none; border: none; padding: 0; font: inherit;
      text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: var(--c-divider); text-underline-offset: 3px; }
    .cu-prod:hover { text-decoration-color: var(--c-text-2); }
    .cu-prod:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cu-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cu-unidad { font-size: var(--fs-xs); color: var(--c-text-2); }
    .cu-compra { white-space: nowrap; }
    .cu-sin { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cu-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .cu-notas { margin-top: 1rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .cu-notas p { margin: 0 0 .35rem; max-width: 60rem; }
    @container (max-width: 48rem) {
      .cu-f input, .cu-sel { width: 100%; min-width: 0; }
      .cu-f { flex: 1 1 100%; }
    }
  `],
})
export class ComprasCostosUltimoComponent {
  /** Clic en un producto: el padre abre su historial. */
  readonly skuElegido = output<string>();

  readonly chips = CHIPS;
  readonly unDia = UN_DIA_Y_POCO;
  readonly opcionesAntiguedad: SegOption[] = [
    { label: 'Todas', value: '' },
    { label: 'Hasta 90 días', value: 'hasta_90' },
    { label: '90 a 180', value: 'de_90_a_180' },
    { label: 'Más de 180', value: 'mas_de_180' },
  ];
  private readonly api = inject(CostoEstandarService);

  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly proveedor = signal<string | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly veredicto = signal<VeredictoContraUltimo | ''>('');
  readonly antiguedad = signal<AntiguedadUltimo | ''>('');
  readonly incluirSinVenta = signal(false);

  private readonly res = rxResource({
    params: () => ({
      q: this.q() || undefined,
      proveedor_id: this.proveedor() || undefined,
      sucursal: this.sucursal() || undefined,
      veredicto: this.veredicto() || undefined,
      antiguedad: this.antiguedad() || undefined,
      solo_con_venta: this.incluirSinVenta() ? false : undefined,
      limite: this.tamano(),
      desplazamiento: (this.pagina() - 1) * this.tamano(),
    }),
    stream: ({ params }) => this.api.contraUltimo(params),
  });

  /** `undefined` mientras carga y tras un error: nunca se pintan ceros que no se midieron. */
  readonly datos = computed(() => (this.res.error() ? undefined : this.res.value()));
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => (this.res.error() ? 'No se pudo cargar la comparación de costos.' : null));
  /** La fuente nunca se calculó: se dice, no se pinta una tabla vacía con conteos en cero. */
  readonly noDisponible = computed(() => {
    const d = this.datos();
    return !!d && !d.disponible;
  });
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly filas = computed<FilaContraUltimo[]>(() => this.datos()?.filas ?? []);
  readonly opcionesProveedor = computed(() =>
    (this.datos()?.proveedores ?? []).map((p) => ({ label: `${p.nombre} (${p.productos})`, value: p.id })),
  );
  readonly opcionesSucursal = computed(() =>
    (this.datos()?.sucursales ?? []).map((s) => ({ label: s.nombre ? `${s.codigo} · ${s.nombre}` : s.codigo, value: s.codigo })),
  );

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const r = d.resumen;
    const a = d.abajo_por_antiguedad;
    const comparables = r.estandar_abajo.filas + r.estandar_arriba.filas + r.igual.filas;
    return [
      { label: 'Estándar abajo del último', value: r.estandar_abajo.venta_30d, format: 'currency-short', tone: 'bad',
        sub: `${this.n(r.estandar_abajo.filas)} productos · venta 30 d` },
      { label: 'Más de 5 %, compra reciente', value: a.hasta_90.venta_30d, format: 'currency-short', tone: 'bad',
        sub: `${this.n(a.hasta_90.filas)} con compra de los últimos 90 días` },
      { label: 'Estándar arriba del último', value: r.estandar_arriba.filas, format: 'number', tone: 'default',
        sub: 'productos' },
      { label: 'Iguales (±1 %)', value: comparables ? Math.round((100 * r.igual.filas) / comparables) : 0, format: 'percent',
        tone: 'ok', sub: `${this.n(r.igual.filas)} de ${this.n(comparables)} comparables`,
        ...(comparables ? {} : { state: 'no_medido' as const, stateNote: 'no hay productos comparables con estos filtros' }) },
      { label: 'No se pueden comparar', value: r.unidad_no_clara.filas + r.sin_compra.filas + r.sin_estandar.filas,
        format: 'number', tone: 'warn',
        sub: `${this.n(r.unidad_no_clara.filas)} unidad no clara · ${this.n(r.sin_compra.filas)} sin compra` },
    ];
  });

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => undefined);
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  recargar(): void {
    this.res.reload();
  }
  onBuscar(v: string): void {
    this.busqueda = v;
    this.buscarDebounced(v);
  }
  onProveedor(v: string | null): void {
    this.proveedor.set(v);
    this.pagina.set(1);
  }
  onSucursal(v: string | null): void {
    this.sucursal.set(v);
    this.pagina.set(1);
  }
  onVeredicto(v: VeredictoContraUltimo | ''): void {
    this.veredicto.set(v);
    this.pagina.set(1);
  }
  onAntiguedad(v: string): void {
    this.antiguedad.set((v || '') as AntiguedadUltimo | '');
    this.pagina.set(1);
  }
  onSinVenta(v: boolean): void {
    this.incluirSinVenta.set(!!v);
    this.pagina.set(1);
  }

  /** «Todos» suma el universo entero; cada chip, su resultado. */
  conteo(id: VeredictoContraUltimo | ''): number {
    const r = this.datos()?.resumen;
    if (!r) return 0;
    if (id === '') return Object.values(r).reduce((s, c) => s + c.filas, 0);
    return r[id].filas;
  }

  etiqueta(v: VeredictoContraUltimo): string {
    return ETIQUETA_VEREDICTO_CONTRA_ULTIMO[v];
  }
  severidad(v: VeredictoContraUltimo): 'danger' | 'info' | 'warn' | 'secondary' | 'success' {
    return SEVERIDAD[v];
  }
  textoMotivo(f: FilaContraUltimo): string {
    switch (f.motivo) {
      case 'unidad_no_resuelta': return 'Compra en una unidad que la ficha no declara';
      case 'inverosimil': return 'Costo de compra fuera de proporción';
      case 'sin_compra': return 'Sin compra en la red';
      default: return f.veredicto === 'sin_estandar' ? 'Sin estándar' : '—';
    }
  }

  nombreSucursal(codigo: string | null): string {
    if (!codigo) return '—';
    const s = (this.datos()?.sucursales ?? []).find((x) => x.codigo === codigo);
    return s?.nombre ? `${codigo} · ${s.nombre}` : codigo;
  }

  pct(v: number | null): string {
    if (v === null || v === undefined) return '—';
    const x = Number(v);
    return `${x > 0 ? '+' : ''}${x.toFixed(1)} %`;
  }

  dinero(v: number | string): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
  }

  dineroONada(v: number | string | null): string {
    return v === null || v === undefined ? '—' : this.dinero(v);
  }

  n(v: number): string {
    return new Intl.NumberFormat('es-MX').format(Number(v));
  }
}
