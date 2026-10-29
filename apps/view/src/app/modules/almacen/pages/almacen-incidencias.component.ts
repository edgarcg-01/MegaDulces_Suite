import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import {
  ETIQUETA_UNIDAD_IMPORTE,
  type ExcepcionMovimiento, type ExcepcionMovimientoItem, type MovimientosExcepcionesResponse,
} from '@megadulces/contracts';
import { AlmacenMovimientosService } from '../almacen-movimientos.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

const ETIQUETA: Record<ExcepcionMovimiento, string> = {
  diferencia: 'Diferencia', sin_acuse: 'Sin acuse', sin_origen: 'Sin origen',
  ajuste_inventario: 'Ajuste', importe_incompleto: 'Importe incompleto',
};
const SEVERIDAD: Record<ExcepcionMovimiento, 'danger' | 'warn' | 'info' | 'secondary'> = {
  diferencia: 'danger', sin_acuse: 'danger', sin_origen: 'warn', ajuste_inventario: 'info', importe_incompleto: 'secondary',
};

/**
 * `[MX.3.2]` **Incidencias de movimientos** — sólo lo que el motor no pudo dar por bueno.
 *
 * Hoy se audita a mano el Diario entero: el 90.7 % de las marcas «auditado» cayó en documentos que el
 * motor ya cuadraba (MX.0.1). Aquí llega el 3 % que no: diferencias, salidas a un almacén sin acuse
 * después de 15 días, recepciones sin origen, ajustes de inventario e importes incompletos. Lo que
 * cuadra sigue en el Diario (reportería). Lectura: resolver con motivo es MX.2.4.
 *
 * Jerarquía: primario = cuántas incidencias y de qué tipo (franja); secundario = cada incidencia con su
 * dinero y su antigüedad; terciario = folios, piezas y la unidad del importe.
 */
@Component({
  selector: 'app-almacen-incidencias',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, DatePickerModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in inc-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="inc-h1">Incidencias de movimientos <app-context-help topic="almacen-incidencias" /></h1>
          <p class="surf-page-sub">Sólo lo que el motor no pudo dar por bueno. Lo que cuadra está en el Diario de movimientos.</p>
        </div>
        <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="600"></app-freshness-pill>
      </header>

      <div class="inc-filtros">
        <p-datepicker [(ngModel)]="desde" (onSelect)="recargar()" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" appendTo="body"
                      inputId="inc-desde" ariaLabel="Desde"></p-datepicker>
        <p-datepicker [(ngModel)]="hasta" (onSelect)="recargar()" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" appendTo="body"
                      inputId="inc-hasta" ariaLabel="Hasta"></p-datepicker>
        <app-segmented [options]="tipos()" [value]="tipo()" (valueChange)="elegirTipo($event)" ariaLabel="Tipo de incidencia"></app-segmented>
      </div>

      @if (resp()?.capped) {
        <div class="inc-banda" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>El pareo llegó a su tope de 50,000 filas: la bandeja está incompleta. Acota el rango de fechas.</span>
        </div>
      }

      @if (resp(); as r) {
        <app-metric-strip [items]="kpis()" ariaLabel="Incidencias del rango"></app-metric-strip>
        <p class="inc-unidad">{{ unidadResumen() }}</p>
      }

      <app-load-state class="dt-scope" [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="!!resp() && !filas().length"
                      emptyIcon="pi-check-circle" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="recargar()">
        <p-table [value]="filas()" [lazy]="true" (onLazyLoad)="paginar($event)" [paginator]="total() > tam" [rows]="tam"
                 [totalRecords]="total()" [first]="(pagina() - 1) * tam" [loading]="cargando()"
                 selectionMode="single" dataKey="clave" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack"
                 [rowHover]="true" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Incidencia</th>
              <th>Fecha</th>
              <th class="comm-num">Días</th>
              <th>Origen</th>
              <th>Destino</th>
              <th class="comm-num">Piezas</th>
              <th class="comm-num">Importe</th>
              <th><span class="inc-oculto">Acción</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr [pSelectableRow]="f">
              <td class="dt-id" data-label="Incidencia" role="cell">
                @for (e of f.excepciones; track e) {
                  <p-tag [value]="etiqueta(e)" [severity]="severidad(e)" styleClass="inc-tag"></p-tag>
                }
                <span class="inc-tipo">{{ f.tipo === 'ajuste' ? 'Ajuste de inventario' : 'Traspaso' }}</span>
              </td>
              <td data-label="Fecha" role="cell" [attr.aria-label]="'Fecha ' + f.fecha">{{ f.fecha }}</td>
              <td class="comm-num dt-num" data-label="Días" role="cell" [attr.aria-label]="f.dias + ' días'">{{ f.dias | number }}</td>
              <td data-label="Origen" role="cell">
                <span class="inc-alm">{{ f.origen.nombre || 'Almacén sin nombre' }}</span>
                <span class="inc-folio">{{ f.origen.folio || '—' }}</span>
              </td>
              <td data-label="Destino" role="cell">
                @if (f.destino) {
                  <span class="inc-alm">{{ f.destino.nombre || 'Sin destino resuelto' }}</span>
                  <span class="inc-folio">{{ f.destino.folio || 'sin recepción' }}</span>
                } @else { <span class="inc-tenue">—</span> }
              </td>
              <td class="comm-num dt-num" data-label="Piezas" role="cell">
                @if (f.tipo === 'traspaso') {
                  <span>{{ f.piezas_enviadas != null ? (f.piezas_enviadas | number:'1.0-2') : '—' }} → {{ f.piezas_recibidas != null ? (f.piezas_recibidas | number:'1.0-2') : '—' }}</span>
                  @if (f.delta_piezas) { <span class="inc-delta">Δ {{ f.delta_piezas > 0 ? '+' : '' }}{{ f.delta_piezas | number:'1.0-2' }}</span> }
                } @else {
                  <span>{{ f.delta_piezas > 0 ? '+' : '' }}{{ f.delta_piezas | number:'1.0-2' }}</span>
                }
              </td>
              <td class="comm-num dt-num" data-label="Importe" role="cell">
                <span class="inc-imp">{{ f.importe != null ? dinero(f.importe) : '—' }}</span>
                <span class="inc-tenue">{{ unidad(f) }}</span>
                @if (f.lineas_sin_importe) { <span class="inc-tenue">+{{ f.lineas_sin_importe }} sin costo</span> }
              </td>
              <td class="dt-actions" data-label="Acción" role="cell">
                <button pButton type="button" class="p-button-sm p-button-text" (click)="$event.stopPropagation(); abrir(f)"
                        [attr.aria-label]="'Ver ' + (f.origen.folio || 'documento') + ' en el Diario'">
                  <span class="p-button-label">Ver en el Diario</span>
                </button>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .inc-h1 { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .inc-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
    .inc-banda { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--warn-border);
      background: var(--warn-soft-bg); color: var(--warn-soft-fg); border-radius: var(--r-md); margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
    .inc-unidad { margin: var(--sp-1) 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    :host ::ng-deep .inc-tag { margin-right: var(--sp-1); }
    .inc-tipo, .inc-folio, .inc-tenue, .inc-delta { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .inc-folio { font-family: var(--font-mono, monospace); }
    .inc-alm, .inc-imp { display: block; color: var(--text-main); }
    .inc-imp { font-weight: 600; }
    .inc-delta { color: var(--bad-fg); }
    .inc-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) { .inc-filtros { flex-direction: column; align-items: stretch; } }
  `],
})
export class AlmacenIncidenciasComponent implements OnInit {
  private readonly api = inject(AlmacenMovimientosService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly tam = 50;
  desde: Date | null = new Date(Date.now() - 30 * 864e5);
  hasta: Date | null = new Date();
  readonly tipo = signal<ExcepcionMovimiento | ''>('');
  readonly pagina = signal(1);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resp = signal<MovimientosExcepcionesResponse | null>(null);
  readonly cargadoEn = signal<Date | null>(null);

  readonly filas = computed(() => (this.resp()?.rows ?? []).map((r, i) => ({ ...r, clave: `${this.pagina()}-${i}` })));
  readonly total = computed(() => this.resp()?.total ?? 0);

  /** Las opciones del filtro llevan su cuenta: se ve qué tipo pesa antes de elegirlo. */
  readonly tipos = computed<SegOption[]>(() => {
    const p = this.resp()?.totals.por_excepcion ?? {};
    const n = (e: ExcepcionMovimiento) => p[e]?.n ?? 0;
    return [
      { label: `Todas (${(this.resp()?.totals.items ?? 0).toLocaleString('es-MX')})`, value: '' },
      ...(Object.keys(ETIQUETA) as ExcepcionMovimiento[]).map((e) => ({ label: `${ETIQUETA[e]} (${n(e).toLocaleString('es-MX')})`, value: e })),
    ];
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resp(); if (!r) return [];
    const p = r.totals.por_excepcion;
    const universo = r.totals.universo.traspasos + r.totals.universo.ajustes;
    return [
      { label: 'Incidencias', value: r.totals.items, format: 'number', tone: r.totals.items ? 'warn' : 'ok',
        sub: `de ${universo.toLocaleString('es-MX')} documentos revisados por el motor` },
      { label: 'Sin acuse', value: p.sin_acuse?.n ?? 0, format: 'number', tone: p.sin_acuse?.n ? 'bad' : 'muted', sub: this.dinero(p.sin_acuse?.importe ?? 0) },
      { label: 'Diferencias', value: p.diferencia?.n ?? 0, format: 'number', tone: p.diferencia?.n ? 'bad' : 'muted', sub: this.dinero(p.diferencia?.importe ?? 0) },
      { label: 'Ajustes', value: p.ajuste_inventario?.n ?? 0, format: 'number', tone: 'default', sub: this.dinero(p.ajuste_inventario?.importe ?? 0) },
      { label: 'Importe incompleto', value: p.importe_incompleto?.n ?? 0, format: 'number', tone: 'muted' },
    ];
  });

  /** El dinero de la bandeja, por unidad: nunca se suma valor de traspaso con precio de venta. */
  readonly unidadResumen = computed(() => {
    const u = this.resp()?.totals.importe_por_unidad; if (!u) return '';
    const partes = [
      u.valor_traspaso ? `${this.dinero(u.valor_traspaso)} a valor de traspaso` : '',
      u.precio_venta ? `${this.dinero(u.precio_venta)} a precio de venta` : '',
      u.mixta ? `${this.dinero(u.mixta)} con costo y precio mezclados` : '',
      u.sin_unidad ? `${this.dinero(u.sin_unidad)} sin unidad medida (ajustes)` : '',
    ].filter(Boolean);
    return partes.length ? `Importe de las incidencias: ${partes.join(' · ')}.` : '';
  });

  readonly vacioTitulo = computed(() => (this.tipo() ? `Sin incidencias de tipo «${ETIQUETA[this.tipo() as ExcepcionMovimiento]}»` : 'Sin incidencias en el rango'));
  readonly vacioPista = computed(() => (this.tipo() ? 'Elige «Todas» para ver el resto.' : 'Todo lo que el motor revisó en estas fechas cuadra. Amplía el rango para revisar más atrás.'));

  ngOnInit(): void { this.cargar(); }

  recargar(): void { this.pagina.set(1); this.cargar(); }

  elegirTipo(v: string): void { this.tipo.set(v as ExcepcionMovimiento | ''); this.recargar(); }

  paginar(e: TableLazyLoadEvent): void {
    const p = Math.floor((e.first ?? 0) / this.tam) + 1;
    if (p === this.pagina()) return;
    this.pagina.set(p); this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true); this.error.set(null);
    const f = { from: this.desde ? this.iso(this.desde) : undefined, to: this.hasta ? this.iso(this.hasta) : undefined };
    this.api.exceptions(f, this.tipo(), this.pagina(), this.tam).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resp.set(r); this.cargando.set(false); this.cargadoEn.set(new Date()); },
      // un error limpia lo anterior: no se deja en pantalla el número de otro rango
      error: () => { this.resp.set(null); this.cargando.set(false); this.error.set('No se pudieron cargar las incidencias.'); },
    });
  }

  /** Abre el documento en el Diario (su contraparte, piezas y renglones están allá). */
  abrir(f: ExcepcionMovimientoItem): void {
    const wh = f.origen.warehouse_id ?? f.destino?.warehouse_id;
    const folio = f.origen.folio ?? f.destino?.folio;
    if (!wh || !folio) return;
    const dc = f.origen.folio ? f.origen.doc_code : 'TrsfRcv';
    void this.router.navigate(['/almacen/movimientos'], { queryParams: { abrir: folio, wh, dc, from: f.fecha, to: f.fecha } });
  }

  etiqueta(e: ExcepcionMovimiento): string { return ETIQUETA[e]; }
  severidad(e: ExcepcionMovimiento): 'danger' | 'warn' | 'info' | 'secondary' { return SEVERIDAD[e]; }
  unidad(f: ExcepcionMovimientoItem): string { return f.unidad_importe ? ETIQUETA_UNIDAD_IMPORTE[f.unidad_importe] : 'unidad no medida'; }
  dinero(n: number | string): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
