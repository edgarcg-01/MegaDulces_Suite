import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import type { BoardVendor, SupervisorBoardResponse } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SupervisorBoardService } from '../supervisor-board.service';
import { routeCode } from './comercial-visitas-dia.component';

const MONEY = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

/** `YYYY-MM-DD` de una fecha en hora de México. */
export const ymdMx = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

export type BoardSort = 'venta' | 'nombre';

/** Pesos sin centavos. Los numeric de Postgres llegan como texto: Number() antes de formatear. */
export function money(n: number | string | null | undefined): string {
  if (n == null || n === '') return '—';
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

/** Estado de la ruta de hoy, en llano y con un color que NO es lo único que lo dice (lleva texto). */
export const DAY_STATE: Record<BoardVendor['day_state'], { label: string; severity: 'info' | 'success' | 'secondary' }> = {
  en_ruta: { label: 'En ruta', severity: 'info' },
  finalizada: { label: 'Terminó', severity: 'success' },
  sin_iniciar: { label: 'Sin iniciar', severity: 'secondary' },
};

/** La hora que acompaña al estado: «desde 9:32» · «8:12 – 14:37» · nada si no inició. */
export function stateTime(v: BoardVendor): string {
  if (v.day_state === 'finalizada') return `${hora(v.started_at)} – ${hora(v.finished_at)}`;
  if (v.day_state === 'en_ruta') return `desde ${hora(v.started_at)}`;
  return '';
}

/**
 * Ordena sin perder a nadie. Venta = la venta de HOY (la única que muestra la tabla), mayor primero;
 * la venta sin medir va siempre AL FINAL — nunca se mezcla con un cero.
 */
export function sortVendors(vs: readonly BoardVendor[], by: BoardSort): BoardVendor[] {
  return [...vs].sort((a, b) => {
    if (by === 'nombre') return a.name.localeCompare(b.name, 'es');
    const ka = a.sales_day.amount;
    const kb = b.sales_day.amount;
    if (ka == null && kb == null) return a.name.localeCompare(b.name, 'es');
    if (ka == null) return 1;
    if (kb == null) return -1;
    return Number(kb) - Number(ka);
  });
}

/**
 * `[MCP.3.9]` Mis vendedores — el tablero del supervisor de ventas.
 *
 * Pregunta que contesta (una sola): ¿cómo va HOY cada vendedor de mi equipo? Una fila por vendedor:
 * su ruta (inicio–fin), cuántos clientes visitó y lo que lleva cobrado en Kepler.
 *
 * `[MCP.3.10]` Lo demás se quitó a pedido de David (2026-10-22): los totales, la meta y el avance de
 * la catorcena y el detalle por cliente. La meta y los días del vendedor viven en «Asignar rutas»
 * (clic en el vendedor → Resumen). La fecha, el orden y la frescura los pone la barra de Cartera.
 *
 * Lo no medido se declara («Sin medir» con su motivo), nunca como $0.
 */
@Component({
  selector: 'app-comercial-supervisor-board',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TableModule, TagModule, LoadStateComponent],
  template: `
    <app-load-state [loading]="loading() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.vendors.length"
      emptyIcon="pi-users" [emptyTitle]="emptyTitle()" [emptyHint]="emptyHint()" (retry)="load()">
      @if (data(); as d) {
        <div class="sb-panel dt-scope">
          <p-table [value]="rows()" dataKey="user_id" class="dt-stack" tableStyleClass="surf-table surf-table--plain" size="small"
            [tableStyle]="{ 'min-width': '40rem' }" [attr.aria-label]="'Mis vendedores, ' + d.date">
            <ng-template #header>
              <tr>
                <th scope="col">Vendedor</th>
                <th scope="col" class="sb-col-state">Ruta de hoy</th>
                <th scope="col" class="sb-col-vis">Visitados</th>
                @if (showSales()) { <th scope="col" class="comm-num sb-col-money">Venta hoy</th> }
              </tr>
            </ng-template>
            <ng-template #body let-v>
              <tr>
                <td role="cell" data-label="Vendedor" class="dt-id">
                  <span class="sb-who">
                    <button type="button" class="sb-name" (click)="openVendor.emit(v.user_id)"
                      [attr.aria-label]="'Ver el resumen de ' + v.name">{{ v.name }}</button>
                    @if (v.routes.length) { <span class="sb-code">{{ routesLabel(v) }}</span> }
                  </span>
                </td>
                <td role="cell" data-label="Ruta de hoy">
                  <span class="sb-state">
                    <p-tag [value]="stateLabel(v)" [severity]="stateSeverity(v)" />
                    @if (stateTime(v)) { <span class="sb-time">{{ stateTime(v) }}</span> }
                  </span>
                </td>
                <td role="cell" data-label="Visitados" [attr.aria-label]="v.customers_visited + ' de ' + v.customers_total + ' clientes visitados'">
                  <span class="sb-vis">
                    <span class="sb-meter" aria-hidden="true"><span class="sb-meter-fill" [style.width.%]="visitPct(v)"></span></span>
                    <span class="sb-num">{{ v.customers_visited }} de {{ v.customers_total }}</span>
                    @if (v.customers_total) { <span class="sb-pct">{{ visitPctLabel(v) }}</span> }
                  </span>
                </td>
                @if (showSales()) {
                  <td role="cell" data-label="Venta hoy" class="comm-num dt-num">
                    @if (v.sales_day.amount != null) { <span class="sb-strong">{{ fmt(v.sales_day.amount) }}</span> }
                    @else { <span class="sb-unmeasured" [attr.title]="v.sales_day.unmeasured_reason">Sin medir</span> }
                  </td>
                }
              </tr>
            </ng-template>
          </p-table>
        </div>
      }
    </app-load-state>
  `,
  styles: [`
    :host { display: block; }
    .sb-panel { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; min-width: 0; }
    .sb-col-state { width: 16rem; }
    .sb-col-vis { width: 15rem; }
    .sb-col-money { width: 9rem; }
    .sb-who { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .sb-name { background: transparent; border: 0; padding: 0; font: inherit; font-weight: 600; color: var(--text-main); text-align: left; cursor: pointer; }
    .sb-name:hover { text-decoration: underline; }
    .sb-name:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .sb-code { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-state { display: inline-flex; align-items: center; gap: var(--sp-2); white-space: nowrap; }
    .sb-time { font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-strong { font-weight: 700; color: var(--text-main); }
    .sb-unmeasured { font-size: var(--fs-xs); color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: var(--r-sm); padding: 0 var(--sp-1); white-space: nowrap; }
    .sb-vis { display: inline-flex; align-items: center; gap: var(--sp-2); white-space: nowrap; }
    .sb-num { font-variant-numeric: tabular-nums; color: var(--text-main); }
    .sb-pct { font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-meter { display: inline-block; width: 5rem; height: 6px; border-radius: var(--r-pill); background: var(--overlay-hover); overflow: hidden; }
    .sb-meter-fill { display: block; height: 100%; background: var(--action); }
  `],
})
export class ComercialSupervisorBoardComponent {
  private readonly svc = inject(SupervisorBoardService);
  private readonly destroyRef = inject(DestroyRef);

  /** Día consultado (`YYYY-MM-DD`, hora de México). Lo elige la barra de Cartera. */
  readonly date = input<string>(ymdMx(new Date()));
  readonly sort = input<BoardSort>('venta');
  /** Clic (o Enter) en un vendedor: Cartera abre su Resumen en «Asignar rutas». */
  readonly openVendor = output<string>();

  readonly data = signal<SupervisorBoardResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

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

  /** Si la venta no se pudo medir para NADIE (p. ej. Ruta directa), la columna no se pinta. */
  readonly showSales = computed(() => (this.data()?.vendors ?? []).some((v) => v.sales_day.amount != null));

  constructor() {
    // Cada cambio de fecha vuelve a pedir el tablero de ese día.
    effect(() => {
      this.date();
      untracked(() => this.load());
    });
  }

  /** Sólo la ÚLTIMA respuesta pinta: si cambian la fecha dos veces seguidas, la vieja no tapa a la nueva. */
  private seq = 0;

  load(): void {
    const n = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.svc
      .board(this.date())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          if (n !== this.seq) return;
          this.data.set(d);
          this.loading.set(false);
        },
        error: (e) => {
          if (n !== this.seq) return;
          this.loading.set(false);
          this.data.set(null);
          this.error.set(e?.error?.message || 'No se pudo cargar el tablero de tus vendedores.');
        },
      });
  }

  // ── Formato ──
  fmt(n: number | null): string {
    return money(n);
  }
  stateLabel(v: BoardVendor): string {
    return DAY_STATE[v.day_state]?.label ?? v.day_state;
  }
  stateSeverity(v: BoardVendor) {
    return DAY_STATE[v.day_state]?.severity ?? 'secondary';
  }
  stateTime(v: BoardVendor): string {
    return stateTime(v);
  }
  visitPctLabel(v: BoardVendor): string {
    return `${Math.round(this.visitPct(v))} %`;
  }
  routesLabel(v: BoardVendor): string {
    return v.routes.map(routeCode).join(', ');
  }
  visitPct(v: BoardVendor): number {
    return v.customers_total ? Math.min(100, (v.customers_visited / v.customers_total) * 100) : 0;
  }
}
