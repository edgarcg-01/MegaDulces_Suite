import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { BoardCustomer, BoardSales, BoardVendor, SupervisorBoardResponse } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SupervisorBoardService } from '../supervisor-board.service';
import { REASON_LABEL, routeCode } from './comercial-visitas-dia.component';

const ymdMx = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const MONEY = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

export type BoardSort = 'avance' | 'venta' | 'nombre';

/** Resultado de la visita, en llano. */
export const RESULT_LABEL: Record<NonNullable<BoardCustomer['result']>, { label: string; severity: 'success' | 'info' | 'warn' }> = {
  con_pedido: { label: 'Con pedido', severity: 'success' },
  sin_pedido: { label: 'Sin pedido', severity: 'info' },
  abierta: { label: 'Abierto, sin cerrar', severity: 'warn' },
};

/** Pesos sin centavos. Los numeric de Postgres llegan como texto: Number() antes de formatear. */
export function money(n: number | string | null | undefined): string {
  const v = Number(n);
  return Number.isFinite(v) ? MONEY.format(v) : '—';
}

/** «17–30 oct» o, si cruza de mes, «31 oct – 13 nov». Fechas YYYY-MM-DD. */
export function periodLabel(start: string, end: string): string {
  const parts = (ymd: string) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    return {
      day: d.getUTCDate(),
      mon: d.toLocaleDateString('es-MX', { month: 'short', timeZone: 'UTC' }).replace('.', ''),
    };
  };
  const a = parts(start);
  const b = parts(end);
  return a.mon === b.mon ? `${a.day}–${b.day} ${b.mon}` : `${a.day} ${a.mon} – ${b.day} ${b.mon}`;
}

/** Hora de México, 24 h, sin cero a la izquierda: «8:12». */
export function hora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Mexico_City' }).replace(/^0(?=\d)/, '');
}

/** «8:12 – 14:37» · «En ruta desde 8:12» · «Sin iniciar». */
export function routeSpan(v: BoardVendor): string {
  if (v.day_state === 'finalizada') return `${hora(v.started_at)} – ${hora(v.finished_at)}`;
  if (v.day_state === 'en_ruta') return `En ruta desde ${hora(v.started_at)}`;
  return 'Sin iniciar';
}

/**
 * Ordena sin perder a nadie: el valor ausente (sin meta, sin medir) va siempre AL FINAL, en
 * cualquier orden — nunca se mezcla con un cero.
 */
export function sortVendors(vs: readonly BoardVendor[], by: BoardSort): BoardVendor[] {
  const key = (v: BoardVendor): number | null =>
    by === 'avance' ? v.progress_pct : by === 'venta' ? v.sales_period.amount : null;
  return [...vs].sort((a, b) => {
    if (by === 'nombre') return a.name.localeCompare(b.name, 'es');
    const ka = key(a);
    const kb = key(b);
    if (ka == null && kb == null) return a.name.localeCompare(b.name, 'es');
    if (ka == null) return 1;
    if (kb == null) return -1;
    // Avance: el más atrasado primero (es a quien hay que atender). Venta: la mayor primero.
    return by === 'avance' ? Number(ka) - Number(kb) : Number(kb) - Number(ka);
  });
}

/** Avance recalculado en el cliente (sólo para el guardado optimista de una meta). */
function progressOf(sales: number | null, target: number | null): number | null {
  if (sales == null || target == null || !(Number(target) > 0)) return null;
  return (Number(sales) / Number(target)) * 100;
}

/**
 * `[MCP.3.9]` Mis vendedores — el tablero del supervisor de ventas.
 *
 * Pregunta que contesta (una sola): ¿cómo va hoy y en la catorcena cada vendedor de mi equipo?
 * Jerarquía: primario = la fila de totales y el avance contra la meta; secundario = la tabla, una
 * fila por vendedor; terciario = la hora de cada visita y el motivo, en el detalle.
 *
 * Lo no medido se declara («Sin medir» con su motivo), nunca como $0. Sin meta = «Sin meta».
 */
@Component({
  selector: 'app-comercial-supervisor-board',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, TableModule, TagModule, DatePickerModule, ButtonModule, InputNumberModule, ToastModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
    <p-toast key="sb" />
    <div class="sb">
      <div class="sb-bar">
        <p class="sb-scope">
          @if (data(); as d) {
            @if (d.scope_label) { <span class="sb-scope-lbl">{{ d.scope_label }}</span><span class="sb-dot" aria-hidden="true">·</span> }
            <span>Catorcena {{ period() }}</span><span class="sb-dot" aria-hidden="true">·</span>
            <span class="sb-mono">día {{ d.period.day }} de 14</span>
          }
        </p>
        <div class="sb-tools">
          <p-datepicker [ngModel]="dateObj()" (ngModelChange)="setDate($event)" dateFormat="yy-mm-dd"
            [maxDate]="maxDate" [showIcon]="true" appendTo="body" inputId="sb-fecha"
            ariaLabel="Fecha" styleClass="sb-date"></p-datepicker>
          <app-freshness-pill measures="fetch" [since]="data()?.generated_at ?? null" [staleAfterSec]="300" />
          <button pButton type="button" [text]="true" severity="secondary" size="small" (click)="load()"
            [disabled]="loading()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </div>

      <app-load-state [loading]="loading() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.vendors.length"
        emptyIcon="pi-users" [emptyTitle]="emptyTitle()" [emptyHint]="emptyHint()" (retry)="load()">
        @if (data(); as d) {
          <div class="sb-kpis">
            <app-metric-strip [items]="kpis()" ariaLabel="Totales de mi equipo" />
            <app-context-help topic="tablero-supervisor" />
          </div>

          <div class="sb-sort">
            <span class="sb-sort-lbl" id="sb-sort-lbl">Ordenar por</span>
            <app-segmented [options]="sortOpts" [value]="sort()" (valueChange)="sort.set($any($event))" ariaLabel="Ordenar vendedores" />
          </div>

          <div class="sb-md" [class.sb-md--open]="!!selected()">
            <div class="sb-master dt-scope">
              <!-- Con teclado: flechas para moverse y Enter/Espacio abre el detalle (pSelectableRow). -->
              <p-table [value]="rows()" dataKey="user_id" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                [rowHover]="true" [tableStyle]="{ 'min-width': '40rem' }"
                selectionMode="single" [selection]="selected()" [metaKeySelection]="false"
                (onRowSelect)="alElegirFila($event)" (onRowUnselect)="alElegirFila($event)">
                <ng-template #header>
                  <tr>
                    <th scope="col">Vendedor</th>
                    <th scope="col">Ruta</th>
                    <th scope="col">Visitados</th>
                    @if (cols().day) { <th scope="col" class="comm-num">Venta hoy</th> }
                    @if (cols().period) { <th scope="col" class="comm-num">Venta catorcena</th> }
                    @if (cols().target) { <th scope="col" class="comm-num">Meta</th> }
                    @if (cols().progress) { <th scope="col" class="comm-num">Avance</th> }
                  </tr>
                </ng-template>
                <ng-template #body let-v>
                  <tr class="sb-row" [pSelectableRow]="v" [class.sb-row-on]="selectedId() === v.user_id">
                    <td role="cell" data-label="Vendedor" class="dt-id">
                      <button type="button" class="sb-name" [attr.aria-expanded]="selectedId() === v.user_id"
                        [attr.aria-controls]="'sb-detail'">{{ v.name }}</button>
                      @if (v.routes.length) { <span class="sb-code">{{ routesLabel(v) }}</span> }
                    </td>
                    <td role="cell" data-label="Ruta">
                      <span [class.sb-tenue]="v.day_state === 'sin_iniciar'" class="sb-mono">{{ span(v) }}</span>
                    </td>
                    <td role="cell" data-label="Visitados" [attr.aria-label]="v.customers_visited + ' de ' + v.customers_total + ' clientes visitados'">
                      <span class="sb-vis">
                        <span class="sb-mono">{{ v.customers_visited }} de {{ v.customers_total }}</span>
                        <span class="sb-meter" aria-hidden="true"><span class="sb-meter-fill" [style.width.%]="visitPct(v)"></span></span>
                      </span>
                    </td>
                    @if (cols().day) {
                      <td role="cell" data-label="Venta hoy" class="comm-num dt-num">
                        @if (v.sales_day.amount != null) { <span class="sb-mono">{{ fmt(v.sales_day.amount) }}</span> }
                        @else { <span class="sb-unmeasured" [attr.title]="v.sales_day.unmeasured_reason">Sin medir</span> }
                      </td>
                    }
                    @if (cols().period) {
                      <td role="cell" data-label="Venta catorcena" class="comm-num dt-num">
                        @if (v.sales_period.amount != null) { <span class="sb-mono sb-strong">{{ fmt(v.sales_period.amount) }}</span> }
                        @else { <span class="sb-unmeasured" [attr.title]="v.sales_period.unmeasured_reason">Sin medir</span> }
                      </td>
                    }
                    @if (cols().target) {
                      <td role="cell" data-label="Meta" class="comm-num dt-num" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
                        @if (d.can_set_targets) {
                          <span class="sb-target">
                            <p-inputnumber [ngModel]="draftOf(v)" (ngModelChange)="setDraft(v.user_id, $event)"
                              mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="0" [maxFractionDigits]="2"
                              [min]="0" placeholder="Sin meta" [inputStyle]="{ width: '7.5rem' }"
                              [ariaLabel]="'Meta de la catorcena de ' + v.name" (keydown.enter)="saveTarget(v)" />
                            <button pButton type="button" size="small" severity="contrast" [disabled]="!dirty(v) || saving() === v.user_id"
                              [loading]="saving() === v.user_id" (click)="saveTarget(v)" [attr.aria-label]="'Guardar meta de ' + v.name">
                              <span class="p-button-icon pi pi-check" aria-hidden="true"></span></button>
                          </span>
                        } @else {
                          @if (v.target != null) { <span class="sb-mono">{{ fmt(v.target) }}</span> }
                          @else { <span class="sb-tenue">Sin meta</span> }
                        }
                      </td>
                    }
                    @if (cols().progress) {
                      <td role="cell" data-label="Avance" class="comm-num dt-num">
                        @if (v.progress_pct != null) { <span class="sb-mono sb-strong">{{ pct(v.progress_pct) }}</span> }
                        @else { <span class="sb-tenue" [attr.title]="v.target == null ? 'Sin meta' : 'Venta sin medir'">—</span> }
                      </td>
                    }
                  </tr>
                </ng-template>
              </p-table>
            </div>

            @if (selected(); as s) {
              <aside class="sb-detail" id="sb-detail" [attr.aria-label]="'Clientes de ' + s.name">
                <header class="sb-dhead">
                  <div>
                    <h2 class="sb-dname">{{ s.name }}</h2>
                    <p class="sb-dsub">
                      @if (s.routes.length) { <span class="sb-code">{{ routesLabel(s) }}</span><span class="sb-dot" aria-hidden="true">·</span> }
                      <span class="sb-mono">{{ span(s) }}</span>
                    </p>
                  </div>
                  <button pButton type="button" [text]="true" severity="secondary" size="small" (click)="selectedId.set(null)"
                    aria-label="Cerrar detalle"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button>
                </header>

                <h3 class="sb-group">Visitados ({{ visited().length }})</h3>
                @if (visited().length) {
                  <ul class="sb-list">
                    @for (c of visited(); track c.customer_id) {
                      <li class="sb-cust">
                        <span class="sb-mono sb-time">{{ hora(c.visited_at) }}</span>
                        <span class="sb-cname">{{ c.name }}@if (c.code) {<span class="sb-code"> {{ c.code }}</span>}</span>
                        @if (c.result) { <p-tag [value]="resultLabel(c)" [severity]="resultSeverity(c)" /> }
                        @if (c.reason) { <span class="sb-reason">{{ reasonLabel(c.reason) }}</span> }
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="sb-none">No ha abierto a ningún cliente de su ruta.</p>
                }

                <h3 class="sb-group">Sin visitar ({{ pending().length }})</h3>
                @if (pending().length) {
                  <ul class="sb-list">
                    @for (c of pending(); track c.customer_id) {
                      <li class="sb-cust sb-cust--pend">
                        <span class="sb-cname">{{ c.name }}@if (c.code) {<span class="sb-code"> {{ c.code }}</span>}</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="sb-none">Ya visitó a todos los clientes de su ruta.</p>
                }
              </aside>
            }
          </div>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sb { container-type: inline-size; container-name: sb; }
    .sb-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3); }
    .sb-scope { margin: 0; margin-right: auto; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .sb-scope-lbl { color: var(--text-main); font-weight: 600; }
    .sb-dot { color: var(--text-faint); }
    .sb-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .sb-kpis { display: flex; align-items: flex-start; gap: var(--sp-1); }
    .sb-sort { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-4) 0 var(--sp-2); }
    .sb-sort-lbl { font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-md { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
    @container sb (min-width: 66rem) {
      .sb-md--open { grid-template-columns: minmax(0, 1fr) 22rem; }
      .sb-detail { position: sticky; top: var(--sp-3); max-height: calc(100vh - 8rem); overflow-y: auto; }
    }
    .sb-row { cursor: pointer; }
    .sb-row-on > td { background: var(--overlay-selected); }
    .sb-name { background: transparent; border: 0; padding: 0; cursor: pointer; font: inherit; font-weight: 600; color: var(--text-main); text-align: left; }
    .sb-name:hover { text-decoration: underline; }
    .sb-name:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .sb-code { margin-left: var(--sp-1); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .sb-strong { font-weight: 700; color: var(--text-main); }
    .sb-tenue { color: var(--text-muted); }
    .sb-unmeasured { font-size: var(--fs-xs); color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: var(--r-sm); padding: 0 var(--sp-1); white-space: nowrap; }
    .sb-vis { display: inline-flex; align-items: center; gap: var(--sp-2); white-space: nowrap; }
    .sb-meter { display: inline-block; width: 3.5rem; height: 4px; border-radius: var(--r-pill); background: var(--overlay-hover); overflow: hidden; }
    .sb-meter-fill { display: block; height: 100%; background: var(--text-muted); }
    .sb-target { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .sb-detail { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--c-surface-1); padding: var(--sp-3) var(--sp-4); min-width: 0; }
    .sb-dhead { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-2); }
    .sb-dname { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .sb-dsub { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); display: flex; flex-wrap: wrap; gap: var(--sp-1); }
    .sb-dsub .sb-code { margin-left: 0; }
    .sb-group { margin: var(--sp-4) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .sb-list { list-style: none; margin: 0; padding: 0; }
    .sb-cust { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border-color); font-size: var(--fs-sm); }
    .sb-time { color: var(--text-muted); min-width: 2.6rem; }
    .sb-cname { color: var(--text-main); min-width: 0; overflow-wrap: anywhere; flex: 1 1 10rem; }
    .sb-cust--pend .sb-cname { color: var(--text-muted); }
    .sb-reason { flex-basis: 100%; padding-left: 3.1rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-none { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class ComercialSupervisorBoardComponent {
  private readonly svc = inject(SupervisorBoardService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly maxDate = new Date();
  readonly date = signal(ymdMx(new Date()));
  readonly dateObj = computed(() => new Date(`${this.date()}T12:00:00`));

  readonly data = signal<SupervisorBoardResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly sort = signal<BoardSort>('avance');
  readonly sortOpts: SegOption[] = [
    { label: 'Avance', value: 'avance' },
    { label: 'Venta', value: 'venta' },
    { label: 'Nombre', value: 'nombre' },
  ];

  readonly selectedId = signal<string | null>(null);
  /** user_id -> meta tecleada y aún no guardada. */
  readonly drafts = signal<Record<string, number | null>>({});
  readonly saving = signal<string | null>(null);

  readonly hora = hora;

  readonly period = computed(() => {
    const p = this.data()?.period;
    return p ? periodLabel(p.start, p.end) : '';
  });

  readonly isToday = computed(() => this.date() === ymdMx(new Date()));

  readonly emptyTitle = computed(() => {
    const cuando = this.isToday() ? 'hoy' : 'ese día';
    const s = this.data()?.scope;
    if (s === 'vecinal') return `Nadie de tu equipo tiene ruta vecinal ${cuando}`;
    if (s === 'directa') return `Nadie de tu equipo tiene ruta directa ${cuando}`;
    return `Nadie de tu equipo tiene ruta ${cuando}`;
  });

  readonly emptyHint = computed(() => {
    const s = this.data()?.scope;
    if (s === 'vecinal') return 'Tu puesto sólo ve rutas vecinales. Si alguien de tu equipo sí salió, revisa en «Asignar rutas» que tenga una ruta vecinal.';
    if (s === 'directa') return 'Tu puesto sólo ve rutas directas. Si alguien de tu equipo sí salió, revisa en «Asignar rutas» que tenga su ruta.';
    return 'Nadie de tu equipo tiene ruta asignada para ese día. Las rutas se asignan en «Asignar rutas».';
  });

  readonly rows = computed(() => sortVendors(this.data()?.vendors ?? [], this.sort()));

  /** Columnas que valen: si un dato no existe para NADIE, la columna no se pinta. */
  readonly cols = computed(() => {
    const d = this.data();
    const vs = d?.vendors ?? [];
    const has = (f: (v: BoardVendor) => BoardSales) => vs.some((v) => f(v).amount != null);
    return {
      day: has((v) => v.sales_day),
      period: has((v) => v.sales_period),
      target: !!d?.can_set_targets || vs.some((v) => v.target != null),
      progress: vs.some((v) => v.progress_pct != null),
    };
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? this.data()?.vendors.find((v) => v.user_id === id) ?? null : null;
  });

  /** Visitados por hora; sin visitar en el orden de la ruta (como los manda el servidor). */
  readonly visited = computed(() =>
    (this.selected()?.customers ?? [])
      .filter((c) => !!c.visited_at)
      .sort((a, b) => new Date(a.visited_at as string).getTime() - new Date(b.visited_at as string).getTime()),
  );
  readonly pending = computed(() => (this.selected()?.customers ?? []).filter((c) => !c.visited_at));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const t = d.totals;
    const vs = d.vendors;
    const visitPct = t.customers_total ? Math.round((t.customers_visited / t.customers_total) * 100) : null;
    return [
      { label: 'Vendedores', value: t.vendors },
      {
        label: 'Clientes visitados', value: `${t.customers_visited} de ${t.customers_total}`, format: 'text',
        sub: visitPct != null ? `${visitPct} % de sus rutas` : undefined,
      },
      this.salesKpi('Venta cobrada hoy', t.sales_day, vs.map((v) => v.sales_day)),
      { ...this.salesKpi('Venta de la catorcena', t.sales_period, vs.map((v) => v.sales_period)), sub: this.targetSub(vs) },
    ];
  });

  constructor() {
    this.load();
  }

  setDate(d: Date | null): void {
    if (!d) return;
    this.date.set(ymdMx(d));
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc
      .board(this.date())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.data.set(d);
          this.drafts.set({});
          if (this.selectedId() && !d.vendors.some((v) => v.user_id === this.selectedId())) this.selectedId.set(null);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.data.set(null);
          this.error.set(e?.error?.message || 'No se pudo cargar el tablero de tus vendedores.');
        },
      });
  }

  /** La tabla manda la fila elegida (o deselegida) con mouse o teclado; abre o cierra su detalle. */
  alElegirFila(e: { data?: BoardVendor | BoardVendor[] }): void {
    const fila = Array.isArray(e.data) ? e.data[0] : e.data;
    if (fila) this.select(fila.user_id);
  }

  select(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
    // En pantallas angostas el detalle queda DEBAJO de la tabla: llevar la vista hasta él.
    if (this.selectedId()) {
      setTimeout(() => {
        const el = (this.host.nativeElement as HTMLElement).querySelector('#sb-detail') as HTMLElement | null;
        el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  // ── Meta ──
  draftOf(v: BoardVendor): number | null {
    const d = this.drafts();
    return v.user_id in d ? d[v.user_id] : v.target;
  }

  setDraft(id: string, value: number | null | undefined): void {
    this.drafts.update((d) => ({ ...d, [id]: value == null ? null : Number(value) }));
  }

  dirty(v: BoardVendor): boolean {
    const d = this.drafts();
    if (!(v.user_id in d)) return false;
    const a = d[v.user_id];
    return (a == null ? null : Number(a)) !== (v.target == null ? null : Number(v.target));
  }

  /** Guardado optimista: la meta se ve de inmediato; si el servidor la rechaza, vuelve la anterior. */
  saveTarget(v: BoardVendor): void {
    const d = this.data();
    if (!d || !d.can_set_targets || this.saving() === v.user_id || !this.dirty(v)) return;
    const amount = this.drafts()[v.user_id];
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      this.toast.add({ key: 'sb', severity: 'warn', summary: 'Meta inválida', detail: 'La meta va en pesos y no puede ser negativa.' });
      return;
    }
    this.saving.set(v.user_id);
    const previo = d.vendors.find((x) => x.user_id === v.user_id) ?? v;
    this.patchVendor(v.user_id, { target: amount, progress_pct: progressOf(previo.sales_period.amount, amount) });
    this.svc
      .setTarget({ user_id: v.user_id, period_start: d.period.start, amount })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.patchVendor(v.user_id, { target: r.amount, progress_pct: progressOf(previo.sales_period.amount, r.amount) });
          this.drafts.update((x) => {
            const rest = { ...x };
            delete rest[v.user_id];
            return rest;
          });
          this.saving.set(null);
          this.toast.add({ key: 'sb', severity: 'success', summary: r.amount == null ? 'Meta quitada' : 'Meta guardada', detail: v.name });
        },
        error: (e) => {
          // Rollback: vuelve lo que había. Lo tecleado se conserva para reintentar.
          this.patchVendor(v.user_id, { target: previo.target, progress_pct: previo.progress_pct });
          this.saving.set(null);
          this.toast.add({ key: 'sb', severity: 'error', summary: 'No se guardó la meta', detail: e?.error?.message || `La meta de ${v.name} sigue como estaba.` });
        },
      });
  }

  private patchVendor(id: string, patch: Partial<BoardVendor>): void {
    this.data.update((d) => (d ? { ...d, vendors: d.vendors.map((x) => (x.user_id === id ? { ...x, ...patch } : x)) } : d));
  }

  // ── Totales ──
  private salesKpi(label: string, total: number | null, parts: BoardSales[]): MetricStripItem {
    const sinMedir = parts.filter((p) => p.amount == null);
    const motivos = [...new Set(sinMedir.map((p) => p.unmeasured_reason).filter((x): x is string => !!x))];
    if (total == null) {
      return {
        label, value: 'Sin medir', format: 'text', tone: 'muted', state: 'no_medido',
        stateNote: motivos.join(' · ') || 'No se pudo leer la venta cobrada en Kepler.',
      };
    }
    const item: MetricStripItem = { label, value: Number(total), format: 'currency' };
    if (sinMedir.length) {
      item.state = 'parcial';
      item.stateNote = `${sinMedir.length} de ${parts.length} ${parts.length === 1 ? 'vendedor' : 'vendedores'} sin medir${motivos.length ? ': ' + motivos.join(' · ') : ''}`;
    }
    return item;
  }

  /** Meta y avance del equipo: el avance sólo compara a quienes tienen meta Y venta medida. */
  private targetSub(vs: readonly BoardVendor[]): string {
    const conMeta = vs.filter((v) => v.target != null);
    if (!conMeta.length) return 'Sin meta capturada';
    const medibles = conMeta.filter((v) => v.sales_period.amount != null);
    const meta = conMeta.reduce((s, v) => s + Number(v.target), 0);
    const parts = [`Meta ${money(meta)}`];
    const metaMed = medibles.reduce((s, v) => s + Number(v.target), 0);
    if (medibles.length && metaMed > 0) {
      const venta = medibles.reduce((s, v) => s + Number(v.sales_period.amount), 0);
      parts.push(`avance ${Math.round((venta / metaMed) * 100)} %`);
    }
    if (conMeta.length < vs.length) parts.push(`${conMeta.length} de ${vs.length} con meta`);
    return parts.join(' · ');
  }

  // ── Formato ──
  fmt(n: number | null): string {
    return money(n);
  }
  pct(n: number): string {
    return `${Math.round(Number(n))} %`;
  }
  span(v: BoardVendor): string {
    return routeSpan(v);
  }
  routesLabel(v: BoardVendor): string {
    return v.routes.map(routeCode).join(', ');
  }
  visitPct(v: BoardVendor): number {
    return v.customers_total ? Math.min(100, (v.customers_visited / v.customers_total) * 100) : 0;
  }
  resultLabel(c: BoardCustomer): string {
    return c.result ? RESULT_LABEL[c.result]?.label ?? c.result : '';
  }
  resultSeverity(c: BoardCustomer) {
    return c.result ? RESULT_LABEL[c.result]?.severity ?? 'secondary' : 'secondary';
  }
  reasonLabel(k: string): string {
    return REASON_LABEL[k] ?? k;
  }
}
