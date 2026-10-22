import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import type {
  VisitMonitorResponse,
  VisitMonitorRow,
  VisitMonitorStatus,
  VisitMonitorVendor,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { VisitMonitorService } from '../visit-monitor.service';

/** Qué dice cada estado, en llano, y con qué severidad se pinta. */
export const STATUS_LABEL: Record<VisitMonitorStatus, { label: string; severity: 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' }> = {
  con_pedido: { label: 'Con pedido', severity: 'success' },
  sin_pedido: { label: 'Sin pedido', severity: 'info' },
  abierta: { label: 'Abierto, sin cerrar', severity: 'warn' },
  se_fue_sin_abrir: { label: 'Se fue sin abrir', severity: 'danger' },
  no_paso: { label: 'No pasó', severity: 'danger' },
  sin_ubicacion: { label: 'Sin ubicación', severity: 'secondary' },
  sin_gps: { label: 'Sin GPS del vendedor', severity: 'secondary' },
  pendiente: { label: 'Pendiente', severity: 'contrast' },
};

/** Los mismos textos que ve el vendedor al escoger el motivo. */
export const REASON_LABEL: Record<string, string> = {
  con_inventario: 'Todavía tiene producto',
  sin_recursos: 'No tiene dinero',
  cerrado: 'Estaba cerrado',
  no_atendio: 'No estaba el encargado',
  no_interesado: 'No le interesa',
  otro: 'Otro motivo',
};

/**
 * Orden de las filas: lo que el supervisor tiene que atender primero. Faltas → sin pedido (con
 * motivo) → abierto sin cerrar → con pedido → pendientes → no medido. Dentro de cada grupo se
 * respeta el orden de la ruta (el servidor ya las manda por secuencia de visita).
 */
export const STATUS_RANK: Record<VisitMonitorStatus, number> = {
  se_fue_sin_abrir: 0,
  no_paso: 0,
  sin_pedido: 1,
  abierta: 2,
  con_pedido: 3,
  pendiente: 4,
  sin_gps: 5,
  sin_ubicacion: 6,
};

type Filtro = 'todos' | 'faltas' | 'sin_pedido' | 'con_pedido' | 'no_medido' | 'pendiente';
const FILTRO: Record<Exclude<Filtro, 'todos'>, readonly VisitMonitorStatus[]> = {
  faltas: ['se_fue_sin_abrir', 'no_paso'],
  sin_pedido: ['sin_pedido', 'abierta'],
  con_pedido: ['con_pedido'],
  no_medido: ['sin_ubicacion', 'sin_gps'],
  pendiente: ['pendiente'],
};

/** Un bloque de vendedor ya listo para pintar: filas ordenadas, el resto agrupado, columnas que valen. */
export interface VendorBlock {
  v: VisitMonitorVendor;
  /** Filas que se listan una por una, en orden de importancia. */
  rows: VisitMonitorRow[];
  /** Clientes sin ubicación que NO se visitaron: no son falta ni aportan decisión → una sola línea. */
  sinUbicacion: VisitMonitorRow[];
  /** Alguna fila tiene distancia al abrir (si ninguna, la columna sobra). */
  showDist: boolean;
  /** Alguna fila tiene «lo más cerca que pasó». */
  showNear: boolean;
}

const ymdMx = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

/** No visitado y sin ubicación: no hay nada que juzgar ni que decidir sobre él. */
export function esSinUbicacionSinVisitar(r: VisitMonitorRow): boolean {
  return !r.has_location && !r.visited_at && (r.status === 'sin_ubicacion' || r.status === 'pendiente');
}

/** Ordena por importancia sin perder el orden de la ruta dentro de cada estado (sort estable). */
export function ordenarFilas(rows: readonly VisitMonitorRow[]): VisitMonitorRow[] {
  return [...rows].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
}

/**
 * El código de una ruta de Kepler sin el nombre de la persona que la lleva:
 * «1V003 PAULINA MICHELLE PLACENCIA BRAVO» → «1V003». Si el primer bloque no parece un código
 * (p. ej. «RUTA 27»), la ruta se deja entera.
 */
export function routeCode(route: string): string {
  const m = /^(\d+[A-Z]?\d*)\s+\S/i.exec(route.trim());
  return m ? m[1] : route;
}

/**
 * `[MCP.3.7]` Visitas del día — el supervisor de ventas ve, por vendedor de su equipo, qué
 * clientes de la ruta abrió y con qué resultado, y dónde faltó.
 *
 * Jerarquía: primario = las faltas (y quién las tiene: los vendedores vienen ordenados por faltas, y
 * dentro de cada vendedor las faltas van arriba); secundario = el resto de los clientes con su
 * estado; terciario = hora, distancia, GPS y los clientes sin ubicación que no se visitaron (una
 * línea plegada: no son falta ni piden decisión).
 *
 * Lo no medido se declara con su nombre y nunca se suma a faltas. Si ningún día se puede juzgar
 * (rutas abiertas o sin GPS), las faltas se declaran «no medido», no se dibuja un cero.
 */
@Component({
  selector: 'app-comercial-visitas-dia',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, TableModule, TagModule, SelectModule, DatePickerModule, ButtonModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, ContextHelpComponent,
  ],
  template: `
    <div class="vd" [class.surf-page]="!embebido()">
      <header [class.surf-page-head]="!embebido()" [class.vd-head-emb]="embebido()">
        @if (!embebido()) {
        <div class="surf-page-head-text">
          <h1>Visitas del día</h1>
          <p class="surf-page-sub">
            Qué clientes de su ruta abrió cada vendedor, con qué resultado, y dónde faltó.
            <a routerLink="/comercial/cartera" class="vd-link">Cartera de ventas</a>
          </p>
        </div>
        }
        <div class="vd-head">
          @if (data()?.alcance?.etiqueta; as alc) {
            <span class="vd-alcance"><i class="pi pi-filter" aria-hidden="true"></i>{{ alc }}</span>
          }
          <p-datepicker [ngModel]="dateObj()" (ngModelChange)="setDate($event)" dateFormat="yy-mm-dd"
            [maxDate]="maxDate" [showIcon]="true" appendTo="body" inputId="vd-fecha"
            ariaLabel="Fecha" styleClass="vd-date"></p-datepicker>
          <p-select [options]="vendorOpts()" [ngModel]="userId()" (ngModelChange)="setUser($event)"
            optionLabel="name" optionValue="user_id" placeholder="Todo mi equipo" [showClear]="true"
            [filter]="true" filterBy="name" appendTo="body" ariaLabel="Vendedor" styleClass="vd-sel"></p-select>
          <app-freshness-pill measures="fetch" [since]="loadedAt()" [staleAfterSec]="300" />
          <button pButton type="button" [text]="true" severity="secondary" size="small" (click)="load()"
            [disabled]="loading()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <app-load-state [loading]="loading() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.vendors.length"
        emptyIcon="pi-users" [emptyTitle]="emptyTitle()"
        [emptyHint]="emptyHint()" (retry)="load()">
        @if (data(); as d) {
          <div class="vd-kpis">
            <app-metric-strip [items]="kpis()" ariaLabel="Visitas del día" />
            <app-context-help topic="visitas-del-dia" />
          </div>
          @if (sinUbicacionTotal(); as su) {
            <p class="vd-second">{{ su }} de {{ d.totals.clientes }} clientes sin ubicación: de ellos no se puede saber si pasó.</p>
          }

          <app-segmented [options]="filterOpts()" [value]="filter()" (valueChange)="filter.set($any($event))" ariaLabel="Filtrar clientes por estado" />

          @for (b of blocks(); track b.v.user_id) {
            <section class="vd-vendor" [attr.aria-labelledby]="'vd-v-' + b.v.user_id">
              <div class="vd-vhead">
                <h2 class="vd-vname" [id]="'vd-v-' + b.v.user_id">{{ b.v.name }}</h2>
                <span class="vd-routes" [attr.title]="b.v.routes.join(', ') || null">{{ routesLabel(b.v) }}@if (b.v.route_source === 'agenda' && d.date !== d.today) {<span class="vd-tenue"> · agenda vigente</span>}</span>
                <p-tag [value]="dayLabel(b.v)" [severity]="b.v.day_state === 'en_ruta' ? 'info' : b.v.day_state === 'finalizada' ? 'success' : 'secondary'" />
                <span class="vd-gps" [class.vd-warn]="!hasGpsSpan(b.v)" [attr.title]="gpsTitle(b.v)">{{ gpsLabel(b.v) }}</span>
                <span class="vd-vcount">
                  <strong>{{ b.v.counts.visitados }}</strong> de {{ b.v.counts.clientes }} visitados
                  @if (b.v.counts.faltas) { · <strong class="vd-bad">{{ b.v.counts.faltas }} {{ b.v.counts.faltas === 1 ? 'falta' : 'faltas' }}</strong> }
                </span>
              </div>
              @if (b.rows.length) {
                <div class="dt-scope"><p-table [value]="b.rows" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small" [rowHover]="true"
                  [tableStyle]="{ 'min-width': b.showDist || b.showNear ? '44rem' : '34rem' }">
                  <ng-template #header>
                    <tr>
                      <th scope="col">Cliente</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Motivo</th>
                      <th scope="col" class="comm-num">Abrió</th>
                      @if (b.showDist) { <th scope="col" class="comm-num">Distancia al abrir</th> }
                      @if (b.showNear) { <th scope="col" class="comm-num">Lo más cerca que pasó</th> }
                    </tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr>
                      <td role="cell" data-label="Cliente">
                        <span class="vd-cname">{{ r.name }}</span>
                        <span class="vd-code"> {{ r.code }}</span>
                        @if (!r.on_route) { <span class="vd-tenue"> · fuera de su ruta</span> }
                      </td>
                      <td role="cell" data-label="Estado"><p-tag [value]="statusLabel(r.status)" [severity]="statusSeverity(r.status)" /></td>
                      <td role="cell" data-label="Motivo">
                        @if (r.no_sale_reason) { {{ reasonLabel(r.no_sale_reason) }} }
                        @if (r.notes) { <span class="vd-tenue">{{ r.no_sale_reason ? ' · ' : '' }}{{ r.notes }}</span> }
                        @if (!r.no_sale_reason && !r.notes) { <span class="vd-tenue">—</span> }
                      </td>
                      <td class="comm-num" role="cell" data-label="Abrió">
                        @if (r.visited_at) { <span class="vd-mono">{{ hora(r.visited_at) }}</span> }
                        @else { <span class="vd-tenue" title="No lo abrió">—</span> }
                      </td>
                      @if (b.showDist) {
                        <td class="comm-num" role="cell" data-label="Distancia al abrir" [class.vd-warn]="r.far">
                          @if (r.distance_m != null) { <span class="vd-mono">{{ dist(r.distance_m) }}</span>@if (r.far) { · lejos } }
                          @else { <span class="vd-tenue" [attr.title]="distEmpty(r)">—</span> }
                        </td>
                      }
                      @if (b.showNear) {
                        <td class="comm-num" role="cell" data-label="Lo más cerca que pasó">
                          @if (r.nearest_m != null) { <span class="vd-mono">{{ dist(r.nearest_m) }}</span> }
                          @else { <span class="vd-tenue" [attr.title]="nearestEmpty(r, b.v)">—</span> }
                        </td>
                      }
                    </tr>
                  </ng-template>
                </p-table></div>
              }
              @if (b.sinUbicacion.length) {
                <details class="vd-fold">
                  <summary>
                    {{ b.sinUbicacion.length }} {{ b.sinUbicacion.length === 1 ? 'cliente sin ubicación sin visitar' : 'clientes sin ubicación sin visitar' }}
                    · <span class="vd-fold-ver">Ver</span>
                  </summary>
                  <ul class="vd-fold-list">
                    @for (r of b.sinUbicacion; track r.customer_id) {
                      <li><span class="vd-cname">{{ r.name }}</span><span class="vd-code"> {{ r.code }}</span></li>
                    }
                  </ul>
                </details>
              }
              @if (!b.rows.length && !b.sinUbicacion.length) {
                <p class="vd-none">Ningún cliente de {{ b.v.name }} en «{{ filterLabel() }}».</p>
              }
            </section>
          }
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .vd-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    /* Embebida en Cartera: sólo los filtros, alineados a la derecha, sin el título de la página. */
    .vd-head-emb { display: flex; justify-content: flex-end; margin-bottom: var(--sp-3); }
    .vd-link { margin-left: var(--sp-2); color: var(--action); font-weight: 600; text-decoration: none; }
    .vd-link:hover { text-decoration: underline; }
    .vd-link:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .vd-alcance { display: inline-flex; align-items: center; gap: var(--sp-1); margin-right: auto; font-size: var(--fs-sm); color: var(--text-muted); }
    .vd-kpis { display: flex; align-items: flex-start; gap: var(--sp-1); }
    .vd-second { margin: var(--sp-2) 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .vd-vendor { margin-top: var(--sp-5); }
    .vd-vhead { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); }
    .vd-vname { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .vd-routes { font-size: var(--fs-sm); color: var(--text-main); }
    .vd-gps { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .vd-vcount { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .vd-vcount strong { color: var(--text-main); }
    .vd-bad, .vd-vcount .vd-bad { color: var(--bad-fg); }
    .vd-warn { color: var(--warn-fg); }
    .vd-cname { font-weight: 600; color: var(--text-main); }
    .vd-code { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .vd-tenue { color: var(--text-muted); }
    .vd-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .vd-fold { margin-top: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .vd-fold summary { cursor: pointer; padding: var(--sp-1) 0; }
    .vd-fold summary:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .vd-fold-ver { color: var(--action); font-weight: 600; }
    .vd-fold[open] .vd-fold-ver { color: var(--text-muted); font-weight: 400; }
    .vd-fold-list { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); columns: 2 18rem; column-gap: var(--sp-6); }
    .vd-fold-list li { padding: 2px 0; break-inside: avoid; }
    .vd-none { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: var(--r-md); }
  `],
})
export class ComercialVisitasDiaComponent {
  /** [MCP.3.7] Dentro de Cartera de ventas: sin título propio (ya lo pone la página). */
  readonly embebido = input(false);
  private readonly svc = inject(VisitMonitorService);
  private readonly destroyRef = inject(DestroyRef);

  readonly maxDate = new Date();
  readonly date = signal(ymdMx(new Date()));
  readonly dateObj = computed(() => new Date(`${this.date()}T12:00:00`));
  readonly userId = signal<string | null>(null);
  readonly filter = signal<Filtro>('todos');

  readonly data = signal<VisitMonitorResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly loadedAt = signal<number | null>(null);

  readonly vendorOpts = computed(() => this.data()?.vendor_options ?? []);

  readonly emptyTitle = computed(() =>
    this.data()?.alcance?.tipo_ruta === 'vecinal' ? 'Nadie de tu equipo tenía ruta vecinal ese día' : 'Nadie de tu equipo tenía ruta ese día',
  );

  readonly emptyHint = computed(() => {
    const d = this.data();
    if (!d) return '';
    if (d.alcance?.tipo_ruta === 'vecinal') {
      return 'Tu puesto sólo ve rutas vecinales. Si alguien de tu equipo sí salió, revisa que su ruta esté declarada como vecinal.';
    }
    if (d.vendor_options.length <= 1 && d.scope === 'equipo') {
      return 'No tienes vendedores a tu cargo, y tú no tenías ruta ni visitas ese día. El equipo se arma con el jefe directo de cada persona.';
    }
    return 'Nadie tenía ruta escogida o en su agenda para ese día, ni registró visitas.';
  });

  /** Clientes sin coordenadas (visitados o no): dato secundario, no del peso de un KPI. */
  readonly sinUbicacionTotal = computed(() => {
    const d = this.data();
    if (!d) return 0;
    let n = 0;
    for (const v of d.vendors) for (const r of v.rows) if (!r.has_location) n++;
    return n;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const t = d.totals;
    const abiertas = d.vendors.filter((v) => !v.closed).length;
    const sinGps = d.vendors.filter((v) => v.closed && !v.gps_points).length;
    const juzgables = d.vendors.length - abiertas - sinGps;
    const faltas: MetricStripItem = juzgables <= 0
      ? {
        label: 'Faltas', value: 'Sin medir', format: 'text', tone: 'muted', state: 'no_medido',
        stateNote: abiertas
          ? 'Ninguna ruta se ha finalizado: la falta se calcula al finalizar (o al día siguiente).'
          : 'Ningún vendedor mandó GPS ese día: no se puede saber si pasó.',
      }
      : {
        label: 'Faltas', value: t.faltas, tone: t.faltas ? 'bad' : 'default',
        sub: `${t.se_fue_sin_abrir} se fue sin abrir · ${t.no_paso} no pasó`,
        ...(abiertas || sinGps
          ? {
            state: 'parcial' as const,
            stateNote: [
              abiertas ? `${abiertas} ${abiertas === 1 ? 'ruta sigue abierta' : 'rutas siguen abiertas'}: su falta se calcula al finalizar` : '',
              sinGps ? `${sinGps} ${sinGps === 1 ? 'vendedor' : 'vendedores'} sin GPS: no se puede saber si pasó` : '',
            ].filter(Boolean).join(' · '),
          }
          : {}),
      };
    return [
      { label: 'Visitados', value: `${t.visitados} de ${t.clientes}`, format: 'text' },
      { label: 'Con pedido', value: t.con_pedido, tone: 'ok' },
      { label: 'Sin pedido', value: t.sin_pedido + t.abiertas, sub: t.abiertas ? `${t.abiertas} sin cerrar` : undefined },
      faltas,
    ];
  });

  readonly filterOpts = computed<SegOption[]>(() => {
    const t = this.data()?.totals;
    return [
      { label: 'Todos', value: 'todos', count: t?.clientes },
      { label: 'Faltas', value: 'faltas', count: t?.faltas },
      { label: 'Sin pedido', value: 'sin_pedido', count: t ? t.sin_pedido + t.abiertas : undefined },
      { label: 'Con pedido', value: 'con_pedido', count: t?.con_pedido },
      { label: 'No medido', value: 'no_medido', count: t ? t.sin_ubicacion + t.sin_gps : undefined },
      { label: 'Pendientes', value: 'pendiente', count: t?.pendientes },
    ];
  });
  readonly filterLabel = computed(() => this.filterOpts().find((o) => o.value === this.filter())?.label ?? '');

  /** Cada vendedor ya filtrado, ordenado y partido (una vez por cambio, no en cada ciclo de pintado). */
  readonly blocks = computed<VendorBlock[]>(() => {
    const d = this.data();
    const f = this.filter();
    if (!d) return [];
    const keep = f === 'todos' ? null : FILTRO[f];
    return d.vendors.map((v) => {
      const visibles = keep ? v.rows.filter((r) => keep.includes(r.status)) : v.rows;
      const rows: VisitMonitorRow[] = [];
      const sinUbicacion: VisitMonitorRow[] = [];
      for (const r of ordenarFilas(visibles)) (esSinUbicacionSinVisitar(r) ? sinUbicacion : rows).push(r);
      return {
        v,
        rows,
        sinUbicacion,
        showDist: rows.some((r) => r.distance_m != null),
        showNear: rows.some((r) => r.nearest_m != null),
      };
    });
  });

  constructor() {
    this.load();
  }

  setDate(d: Date | null): void {
    if (!d) return;
    this.date.set(ymdMx(d));
    this.load();
  }

  setUser(id: string | null): void {
    this.userId.set(id || null);
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc
      .monitor(this.date(), this.userId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.data.set(d);
          this.loading.set(false);
          this.loadedAt.set(Date.now());
        },
        error: (e) => {
          this.loading.set(false);
          this.data.set(null);
          this.error.set(e?.error?.message || 'No se pudieron cargar las visitas del día.');
        },
      });
  }

  statusLabel(s: VisitMonitorStatus): string {
    return STATUS_LABEL[s]?.label ?? s;
  }
  statusSeverity(s: VisitMonitorStatus) {
    return STATUS_LABEL[s]?.severity ?? 'secondary';
  }
  reasonLabel(k: string): string {
    return REASON_LABEL[k] ?? k;
  }

  routesLabel(v: VisitMonitorVendor): string {
    return v.routes.length ? v.routes.map(routeCode).join(', ') : 'sin ruta ese día';
  }

  dayLabel(v: VisitMonitorVendor): string {
    if (v.day_state === 'en_ruta') return `En ruta desde ${this.hora(v.started_at)}`;
    if (v.day_state === 'finalizada') return `Finalizó ${this.hora(v.finished_at)}`;
    return 'No inició ruta';
  }

  /** Hay GPS que sirva: al menos 2 puntos y entre el primero y el último pasó tiempo. */
  hasGpsSpan(v: VisitMonitorVendor): boolean {
    if (v.gps_points < 2 || !v.gps_first_at || !v.gps_last_at) return false;
    const a = new Date(v.gps_first_at).getTime();
    const b = new Date(v.gps_last_at).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && b - a >= 60_000;
  }

  gpsLabel(v: VisitMonitorVendor): string {
    return this.hasGpsSpan(v) ? `GPS de ${this.hora(v.gps_first_at)} a ${this.hora(v.gps_last_at)}` : 'Sin GPS suficiente';
  }

  gpsTitle(v: VisitMonitorVendor): string {
    if (!v.gps_points) return 'El celular no mandó ubicación ese día.';
    const n = `${v.gps_points} ${v.gps_points === 1 ? 'punto' : 'puntos'} de GPS`;
    if (!this.hasGpsSpan(v)) return `${n}, sin un lapso que permita saber por dónde pasó.`;
    return `${n} útiles.`;
  }

  /** Por qué no hay distancia al abrir. */
  distEmpty(r: VisitMonitorRow): string {
    if (!r.visited_at) return 'No lo abrió';
    if (!r.has_location) return 'El cliente no tiene ubicación';
    return 'El celular no mandó GPS al abrir';
  }

  /** Por qué no hay «lo más cerca que pasó». */
  nearestEmpty(r: VisitMonitorRow, v: VisitMonitorVendor): string {
    if (!r.on_route) return 'No es de su ruta';
    if (!r.has_location) return 'El cliente no tiene ubicación';
    if (!v.gps_points) return 'Sin GPS del vendedor';
    return 'Más de 2 km';
  }

  hora(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }

  dist(m: number): string {
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
  }
}
