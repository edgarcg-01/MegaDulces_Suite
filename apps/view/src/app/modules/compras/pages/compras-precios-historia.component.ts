import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { TooltipModule } from 'primeng/tooltip';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { isoLocalDate } from '../../../shared/util';
import { PreciosService } from '../precios.service';
import { graficaPrecio, serieHistoria } from '../precios-historia.util';

/**
 * `[CAT-PRECIO.4]` — **La historia de UN precio** (producto × unidad × sucursal), la que se abre al
 * dar clic en un precio de la lista. Como la hoja de Compras: fecha, precio y cuánto cambió contra el
 * anterior (incremento / bajó), con su gráfica.
 *
 * Sale de la bitácora nativa de Kepler. Los meses sin una sola fila en la bitácora se DICEN: en esos
 * meses no se sabe si el precio cambió, y la escalera los cruza en línea recta sin saberlo.
 */
@Component({
  selector: 'app-compras-precios-historia',
  standalone: true,
  imports: [TooltipModule, LoadStateComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="false" (retry)="res.reload()">
      @if (datos(); as d) {
        <div class="ph">
          <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Resumen de la historia del precio" />

          @if (grafica().d) {
            <figure class="ph-fig">
              <svg [attr.viewBox]="'0 0 640 180'" class="ph-svg" role="img"
                   [attr.aria-label]="'Precio de ' + d.unidad + ' entre ' + fechaLarga(grafica().desde!) + ' y ' + fechaLarga(grafica().hasta!) + ': de ' + dinero(grafica().min) + ' a ' + dinero(grafica().max)">
                <path [attr.d]="grafica().d" class="ph-linea" />
                @for (p of grafica().puntos; track $index) {
                  <circle [attr.cx]="p.x" [attr.cy]="p.y" r="3.5" class="ph-punto">
                    <title>{{ fechaLarga(p.fecha) }} · {{ dinero(p.precio) }}</title>
                  </circle>
                }
              </svg>
              <figcaption class="ph-eje">
                <span>{{ fechaCorta(grafica().desde!) }}</span>
                <span>mín. {{ dinero(grafica().min) }} · máx. {{ dinero(grafica().max) }}</span>
                <span>{{ fechaCorta(grafica().hasta!) }}</span>
              </figcaption>
            </figure>
          }

          @if (d.cambios.length) {
            <ul class="ph-lista" aria-label="Cambios de precio">
              @for (c of d.cambios; track $index) {
                <li [class.is-sube]="c.nuevo > c.anterior" [class.is-baja]="c.nuevo < c.anterior">
                  <span class="ph-fecha">{{ fechaLarga(c.fecha) }}</span>
                  <span class="ph-precio">{{ dinero(c.nuevo) }}</span>
                  <span class="ph-ajuste">
                    @if (c.es_baja) {
                      <i class="pi pi-ban" aria-hidden="true"></i> le quitaron el precio
                    } @else if (c.ajuste_pct === null) {
                      antes sin precio
                    } @else if (c.nuevo > c.anterior) {
                      <i class="pi pi-arrow-up" aria-hidden="true"></i> {{ pct(c.ajuste_pct) }} incremento
                    } @else {
                      <i class="pi pi-arrow-down" aria-hidden="true"></i> {{ pct(c.ajuste_pct) }} bajó
                    }
                  </span>
                  <span class="ph-antes">antes {{ dinero(c.anterior) }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="ph-nada">No hay ningún cambio de este precio en la bitácora de Kepler de esta sucursal
              @if (d.bitacora_desde) { (que empieza en {{ mesLargo(d.bitacora_desde) }}) }.</p>
          }

          @if (d.meses_sin_registro.length) {
            <p class="ph-aviso" role="note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <span>Sin registro en la bitácora de esta sucursal: {{ meses(d.meses_sin_registro) }}. En esos meses no se
                sabe si el precio cambió.</span>
            </p>
          }
        </div>
      }
    </app-load-state>
  `,
  styles: [`
    :host { display: block; }
    .ph { display: flex; flex-direction: column; gap: .9rem; container-type: inline-size; }
    @container (max-width: 24rem) {
      .ph-eje { flex-direction: column; align-items: flex-start; }
    }
    .ph-fig { margin: 0; border: 1px solid var(--c-divider); border-radius: 8px; padding: .5rem .6rem; }
    .ph-svg { width: 100%; height: auto; display: block; }
    .ph-linea { fill: none; stroke: var(--action); stroke-width: 2; }
    .ph-punto { fill: var(--c-surface-1); stroke: var(--action); stroke-width: 2; }
    .ph-eje { display: flex; justify-content: space-between; gap: .5rem; font-size: var(--fs-xs); color: var(--c-text-3); }
    .ph-lista { list-style: none; margin: 0; padding: 0; }
    .ph-lista li { display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'fecha precio' 'ajuste antes';
      gap: .1rem .75rem; padding: .45rem .25rem; border-top: 1px solid var(--c-divider); font-size: var(--fs-sm); }
    .ph-lista li:first-child { border-top: 0; }
    .ph-fecha { grid-area: fecha; color: var(--c-text-1); }
    .ph-precio { grid-area: precio; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .ph-ajuste { grid-area: ajuste; font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-2); }
    /* Subir no es «malo» ni bajar «bueno» para quien vende: la dirección la dicen la flecha y la palabra, no el color. */
    .is-sube .ph-ajuste, .is-baja .ph-ajuste { color: var(--c-text-1); }
    .ph-antes { grid-area: antes; text-align: right; font-size: var(--fs-xs); color: var(--c-text-3); font-family: var(--font-mono); }
    .ph-nada { margin: 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .ph-aviso { display: flex; gap: .5rem; align-items: flex-start; margin: 0; padding: .5rem .65rem; border-radius: 6px;
      border: 1px solid var(--c-divider); border-left: 3px solid var(--warn-fg); background: var(--warn-soft-bg);
      font-size: var(--fs-xs); color: var(--c-text-2); }
  `],
})
export class ComprasPreciosHistoriaComponent {
  readonly sku = input.required<string>();
  readonly sucursal = input.required<string>();
  readonly unidad = input.required<string>();
  private readonly api = inject(PreciosService);
  private readonly hoy = isoLocalDate(new Date());

  readonly res = rxResource({
    params: () => ({ sku: this.sku(), sucursal: this.sucursal(), unidad: this.unidad() }),
    stream: ({ params }) => this.api.historia(params.sku, params.sucursal, params.unidad),
  });
  readonly datos = computed(() => (this.res.error() ? undefined : this.res.value()));
  readonly error = computed(() => (this.res.error() ? 'No se pudo cargar la historia de este precio.' : null));
  /** Lo primero que se lee: cuánto vale hoy, cuántas veces cambió y cuándo fue la última. */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const ultimo = d.cambios[0];
    return [
      d.precio_actual === null
        ? { label: 'precio hoy', value: 'sin precio', format: 'text' }
        : { label: 'precio hoy', value: d.precio_actual, format: 'currency2' },
      { label: 'cambios', value: d.cambios.length, format: 'number', sub: d.bitacora_desde ? `desde ${this.mesLargo(d.bitacora_desde)}` : undefined },
      ultimo
        ? { label: 'último cambio', value: this.fechaLarga(ultimo.fecha), format: 'text' }
        : { label: 'último cambio', value: 'sin registro', format: 'text', state: 'no_medido', stateNote: 'la bitácora no tiene cambios de este precio' },
    ];
  });

  readonly grafica = computed(() => {
    const d = this.datos();
    return graficaPrecio(d ? serieHistoria(d, this.hoy) : []);
  });

  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(Number(v));
  }
  pct(v: number): string {
    return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(Math.abs(v))} %`;
  }
  private fecha(iso: string, op: Intl.DateTimeFormatOptions): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', op).format(new Date(y, m - 1, d || 1));
  }
  fechaLarga(iso: string): string { return this.fecha(iso, { day: 'numeric', month: 'short', year: 'numeric' }); }
  fechaCorta(iso: string): string { return this.fecha(iso, { month: 'short', year: '2-digit' }); }
  mesLargo(ym: string): string { return this.fecha(`${ym}-01`, { month: 'long', year: 'numeric' }); }
  meses(lista: string[]): string { return lista.map((m) => this.mesLargo(m)).join(', '); }
}
