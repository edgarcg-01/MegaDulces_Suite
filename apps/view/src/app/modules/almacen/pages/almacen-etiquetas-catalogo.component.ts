import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { diaCorto, warehouseName, type BoxLabelAvisoTipo, type BoxLabelCatalogDefect } from '@megadulces/contracts';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { EtiquetasCajaService } from '../etiquetas-caja.service';
import { rangoMx } from '../etiquetas-caja-impresion';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

const TEXTO: Record<BoxLabelAvisoTipo, string> = {
  kepler_no_lee_codigo: 'Sin código de caja',
  catalogo_factor_0: 'Factor de caja en 0',
  catalogo_factor_distinto: 'Factor distinto al recibido',
  kepler_caja_otra_unidad: 'La caja es otra unidad',
  sin_catalogo: 'No está en el catálogo',
  caja_incompleta: 'Caja incompleta',
};
const ORDEN: BoxLabelAvisoTipo[] = ['kepler_no_lee_codigo', 'catalogo_factor_0', 'catalogo_factor_distinto', 'kepler_caja_otra_unidad', 'sin_catalogo'];

/**
 * `[RE.ETQ.2.2 / 3.2]` **Catálogo de Kepler** — lo que el catálogo de Kepler tiene mal en lo que llegó en caja, para
 * que Compras lo corrija allá (la Suite no escribe en Kepler). La etiqueta se imprime igual con lo de la orden de
 * entrada; esto es para que Kepler deje de estar mal.
 *
 * Pestaña aparte y no una sección de la cola: contesta OTRA pregunta («¿qué está mal en Kepler?» ≠ «¿qué me falta
 * etiquetar?») y la persona que la usa es otra (Compras). Skill `diseno` §3a.
 *
 * Jerarquía: primario = cuántos productos y por qué defecto; secundario = qué está mal en cada uno; terciario =
 * clave, renglones y última llegada.
 */
@Component({
  selector: 'app-almacen-etiquetas-catalogo',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, InputTextModule, SelectModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head ec-head">
        <div>
          <h1>Catálogo de Kepler en lo recibido <app-context-help topic="almacen-etiquetas-catalogo" /></h1>
          <p class="ec-sub">Productos que llegaron en caja con el catálogo de Kepler mal. La etiqueta se imprime con lo de la orden de entrada; esto se corrige en Kepler.</p>
        </div>
        <div class="ec-head-acc">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="3600"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="cargando()" (click)="recargar()" aria-label="Actualizar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      @if (defectos()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Defectos del catálogo de Kepler"></app-metric-strip>
      }

      <div class="ec-filtros">
        <app-segmented [options]="tipos()" [value]="tipo()" (valueChange)="tipo.set($any($event))" ariaLabel="Qué defecto ver"></app-segmented>
        @if (sucursales().length > 1) {
          <p-select [options]="sucursales()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (ngModelChange)="sucursal.set($event)"
                    [showClear]="true" placeholder="Todas las sucursales" appendTo="body" inputId="ec-suc" ariaLabel="Sucursal" class="ec-sel"></p-select>
        }
        <input pInputText type="search" class="ec-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Clave o producto" aria-label="Buscar producto" enterkeyhint="search" autocomplete="off" />
      </div>

      <app-load-state class="dt-scope" [loading]="cargando() && !defectos()" [error]="error()" [isEmpty]="!!defectos() && !visibles().length"
                      emptyIcon="pi-check-circle" emptyTitle="Nada que corregir" [emptyHint]="busqueda() ? 'Nada coincide con la búsqueda.' : 'Lo recibido en caja en los últimos 30 días tiene el catálogo de Kepler bien.'"
                      (retry)="recargar()">
        <p-table [value]="visibles()" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack" [rowHover]="true"
                 [paginator]="visibles().length > 50" [rows]="50">
          <ng-template #header>
            <tr>
              <th>Producto</th>
              <th>Sucursal</th>
              <th>Qué está mal en Kepler</th>
              <th class="comm-num">Llegó con</th>
              <th>Kepler dice</th>
              <th class="comm-num">Renglones</th>
            </tr>
          </ng-template>
          <ng-template #body let-d>
            <tr>
              <td class="dt-id" data-label="Producto" role="cell">
                <span class="ec-prod">{{ d.nombre || d.sku }}</span>
                <span class="ec-ter">{{ d.sku }} · llegó en {{ d.unidad }}</span>
              </td>
              <td data-label="Sucursal" role="cell">{{ nombreSucursal(d.sucursal) }}</td>
              <td data-label="Qué está mal" role="cell">
                <div class="ec-tags">@for (t of d.defectos; track t) { <p-tag [value]="texto(t)" severity="warn"></p-tag> }</div>
              </td>
              <td class="comm-num dt-num" data-label="Llegó con" role="cell">
                <span class="ec-num">{{ d.uxc_recibida ?? '—' }}</span> <span class="ec-ter">por caja</span>
              </td>
              <td data-label="Kepler dice" role="cell">
                <span class="ec-ter">Factor {{ d.kepler_factor_caja ?? 'vacío' }} · código {{ d.kepler_codigo_caja || 'vacío' }} · caja {{ d.kepler_unidad_caja || 'vacía' }}</span>
              </td>
              <td class="comm-num dt-num" data-label="Renglones" role="cell">
                <span class="ec-num">{{ d.renglones }}</span> <span class="ec-ter">última {{ dia(d.ultima_captura) }}</span>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
      @if (rango(); as r) { <p class="ec-nota">Órdenes de entrada del {{ dia(r.date_from) }} al {{ dia(r.date_to) }}, en las sucursales que puedes ver.</p> }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ec-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .ec-head-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .ec-sub { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .ec-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-4) 0 var(--sp-3); }
    .ec-buscar { flex: 1 1 14rem; min-width: 0; }
    .ec-prod { display: block; }
    .ec-num { font-weight: 600; font-variant-numeric: tabular-nums; }
    .ec-ter { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .ec-tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
    .ec-nota { color: var(--text-muted); font-size: var(--fs-xs); margin-top: var(--sp-3); }
  `],
})
export class AlmacenEtiquetasCatalogoComponent implements OnInit {
  private readonly api = inject(EtiquetasCajaService);
  private readonly destroyRef = inject(DestroyRef);

  readonly defectos = signal<BoxLabelCatalogDefect[] | null>(null);
  readonly rango = signal<{ date_from: string; date_to: string } | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly tipo = signal<BoxLabelAvisoTipo | 'todos'>('todos');
  readonly sucursal = signal<string | null>(null);
  readonly busqueda = signal('');

  readonly sucursales = computed(() =>
    [...new Set((this.defectos() ?? []).map((d) => d.sucursal))].sort().map((c) => ({ label: this.nombreSucursal(c), value: c })));

  private readonly enAlcance = computed(() => {
    const s = this.sucursal();
    const base = (this.defectos() ?? []).filter((d) => !s || d.sucursal === s);
    return filtrarPorBusqueda(base, this.busqueda(), (d) => [d.sku, d.nombre, this.nombreSucursal(d.sucursal)]);
  });

  readonly visibles = computed(() => {
    const t = this.tipo();
    return this.enAlcance().filter((d) => t === 'todos' || d.defectos.includes(t));
  });

  readonly tipos = computed<SegOption[]>(() => {
    const ds = this.enAlcance();
    return [
      { label: 'Todos', value: 'todos', count: ds.length },
      ...ORDEN.map((t) => ({ label: TEXTO[t], value: t, count: ds.filter((d) => d.defectos.includes(t)).length })).filter((o) => o.count > 0),
    ];
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const ds = this.enAlcance();
    const n = (t: BoxLabelAvisoTipo) => ds.filter((d) => d.defectos.includes(t)).length;
    return [
      { label: 'Productos por corregir en Kepler', value: ds.length, tone: ds.length ? 'warn' : 'ok' },
      { label: 'Sin código de caja', value: n('kepler_no_lee_codigo'), sub: 'Kepler no lee la etiqueta' },
      { label: 'Factor de caja en 0', value: n('catalogo_factor_0') },
      { label: 'Factor distinto al recibido', value: n('catalogo_factor_distinto') },
    ];
  });

  ngOnInit(): void {
    this.recargar();
  }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.defectos(rangoMx(30)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.defectos.set(r.defectos);
        this.rango.set({ date_from: r.date_from, date_to: r.date_to });
        this.cargadoEn.set(new Date());
        this.cargando.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo cargar el catálogo.');
        this.cargando.set(false);
      },
    });
  }

  texto(t: BoxLabelAvisoTipo): string {
    return TEXTO[t];
  }
  nombreSucursal(code: string): string {
    return warehouseName(code) || code;
  }
  dia(d: string | null): string {
    return d ? diaCorto(d) : '—';
  }
}
