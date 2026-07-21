import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { SupervisorAiService, RouteBalanceSim } from './supervisor-ai.service';

/**
 * Horus ACT.5 — Balanceo de carga entre rutas/personas. Muestra el tiempo que
 * tarda cada persona en su ruta HOY vs cómo quedaría nivelado (moviendo clientes
 * de las rutas más cargadas a las más livianas). Co-piloto: el supervisor Aplica
 * (escribe) y puede Revertir. Superficie Operations (DESIGN.md).
 */
@Component({
  selector: 'app-route-balance',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, SelectModule, SkeletonModule, ToastModule, ConfirmDialogModule],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rb">
      <header class="rb__head">
        <div>
          <a routerLink="/dashboard/supervisor-ai" class="rb__back"><i class="pi pi-arrow-left"></i> Supervisor IA</a>
          <h1 class="rb__title">Balanceo de carga</h1>
          <p class="rb__sub">Nivela el tiempo de ruta entre personas moviendo clientes de las cargadas a las livianas</p>
        </div>
        <div class="rb__ctl">
          <p-select [options]="days" [(ngModel)]="dow" (onChange)="load()" optionLabel="label" optionValue="value" styleClass="rb__day" />
        </div>
      </header>

      @if (loading()) {
        <p-skeleton height="5rem" styleClass="mb-3" />
        <p-skeleton height="18rem" />
      } @else if (!sim() || sim()!.before.length === 0) {
        <div class="card empty">Sin rutas asignadas para este día. Asigná rutas a vendedores (plan de ruta) para poder balancear.</div>
      } @else {
        @if (sim()!.metrics; as m) {
          <div class="kpis">
            <div class="kpi">
              <span class="kpi__l">Ruta más larga hoy</span>
              <span class="kpi__v kpi__v--bad">{{ m.makespan_before }} min</span>
            </div>
            <div class="kpi">
              <span class="kpi__l">Ruta más larga nivelada</span>
              <span class="kpi__v kpi__v--ok">{{ m.makespan_after }} min</span>
            </div>
            <div class="kpi">
              <span class="kpi__l">Mejora</span>
              <span class="kpi__v" [class.kpi__v--ok]="m.improvement_pct > 0">{{ m.improvement_pct }}%</span>
            </div>
            <div class="kpi">
              <span class="kpi__l">Desbalance (σ) · movimientos</span>
              <span class="kpi__v">{{ m.stddev_before }}→{{ m.stddev_after }} · {{ m.moved }}</span>
            </div>
          </div>

          <div class="actions">
            <button
              pButton
              type="button"
              [disabled]="m.moved === 0 || busy()"
              [label]="busy() ? 'Aplicando…' : 'Aplicar rebalanceo'"
              icon="pi pi-check"
              (click)="confirmApply()"
            ></button>
            <button
              pButton
              type="button"
              severity="secondary"
              [outlined]="true"
              [disabled]="busy()"
              label="Revertir último"
              icon="pi pi-undo"
              (click)="confirmUndo()"
            ></button>
            <span class="hint">Recalcula en el servidor al aplicar · reversible</span>
          </div>
        }

        <div class="card">
          <h2 class="card__title">Tiempo por persona · antes → después</h2>
          <table class="tbl">
            <thead>
              <tr>
                <th>Ruta</th>
                <th>Vendedor</th>
                <th class="num">Clientes</th>
                <th>Carga (min)</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.sales_route) {
                <tr>
                  <td>{{ row.sales_route }}</td>
                  <td>{{ row.vendor || '—' }}</td>
                  <td class="num">
                    {{ row.beforeCust }}
                    @if (row.afterCust !== row.beforeCust) {
                      <span class="delta" [class.delta--up]="row.afterCust > row.beforeCust" [class.delta--down]="row.afterCust < row.beforeCust">→ {{ row.afterCust }}</span>
                    }
                  </td>
                  <td>
                    <div class="bars">
                      <div class="bar bar--before" [style.width.%]="pct(row.beforeMin)"><span>{{ row.beforeMin }}</span></div>
                      <div class="bar bar--after" [style.width.%]="pct(row.afterMin)"><span>{{ row.afterMin }}</span></div>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <div class="legend">
            <span><span class="sw sw--before"></span> hoy</span>
            <span><span class="sw sw--after"></span> nivelado</span>
          </div>
        </div>

        <div class="card">
          <h2 class="card__title">Movimientos propuestos ({{ sim()!.moves.length }})</h2>
          @if (sim()!.moves.length === 0) {
            <p class="empty">La carga ya está pareja: no hace falta mover clientes.</p>
          } @else {
            <ul class="moves">
              @for (mv of sim()!.moves; track mv.customer_id) {
                <li class="move">
                  <span class="move__name">{{ mv.name }}</span>
                  <span class="move__route">{{ mv.from_route }}</span>
                  <i class="pi pi-arrow-right"></i>
                  <span class="move__route move__route--to">{{ mv.to_route }}</span>
                </li>
              }
            </ul>
          }
        </div>
      }

      <p-toast />
      <p-confirmDialog />
    </div>
  `,
  styles: [
    `
      .rb { padding: 1.25rem; max-width: 1000px; margin: 0 auto; color: var(--text, #1c1917); }
      .rb__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
      .rb__back { font-size: .78rem; color: var(--text-soft, #78716c); text-decoration: none; display: inline-flex; align-items: center; gap: .3rem; }
      .rb__back:hover { color: var(--action, #ea580c); }
      .rb__title { font-size: 1.5rem; font-weight: 700; margin: .25rem 0 0; }
      .rb__sub { margin: .2rem 0 0; color: var(--text-soft, #78716c); font-size: .85rem; }
      .card { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--radius, 12px); padding: 1rem 1.1rem; margin-bottom: 1rem; }
      .card__title { font-size: .95rem; font-weight: 600; margin: 0 0 .7rem; }
      .empty { color: var(--text-soft, #78716c); font-size: .88rem; margin: .25rem 0; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin-bottom: 1rem; }
      .kpi { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--radius, 12px); padding: .7rem .85rem; display: flex; flex-direction: column; gap: .25rem; }
      .kpi__l { font-size: .72rem; color: var(--text-soft, #78716c); text-transform: uppercase; letter-spacing: .03em; }
      .kpi__v { font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }
      .kpi__v--ok { color: var(--ok, #16a34a); }
      .kpi__v--bad { color: var(--bad, #dc2626); }
      .actions { display: flex; align-items: center; gap: .6rem; margin-bottom: 1rem; flex-wrap: wrap; }
      .hint { font-size: .75rem; color: var(--text-soft, #a8a29e); }
      .tbl { width: 100%; border-collapse: collapse; font-size: .86rem; }
      .tbl th { text-align: left; font-weight: 600; color: var(--text-soft, #78716c); padding: .4rem .5rem; border-bottom: 1px solid var(--border-color, #e7e5e4); }
      .tbl td { padding: .45rem .5rem; border-bottom: 1px solid var(--border-color, #f0efed); vertical-align: middle; }
      .tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
      .delta { font-size: .72rem; margin-left: .25rem; }
      .delta--up { color: var(--bad, #dc2626); }
      .delta--down { color: var(--ok, #16a34a); }
      .bars { display: flex; flex-direction: column; gap: .2rem; min-width: 160px; }
      .bar { height: 1rem; border-radius: 4px; display: flex; align-items: center; min-width: 1.6rem; }
      .bar span { font-size: .64rem; font-weight: 700; color: #fff; padding: 0 .3rem; }
      .bar--before { background: #9ca3af; }
      .bar--after { background: var(--ok, #16a34a); }
      .legend { display: flex; gap: 1rem; margin-top: .6rem; font-size: .74rem; color: var(--text-soft, #78716c); }
      .sw { display: inline-block; width: .8rem; height: .8rem; border-radius: 3px; vertical-align: middle; margin-right: .3rem; }
      .sw--before { background: #9ca3af; }
      .sw--after { background: var(--ok, #16a34a); }
      .moves { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .move { display: flex; align-items: center; gap: .5rem; padding: .4rem 0; border-bottom: 1px solid var(--border-color, #f0efed); font-size: .85rem; }
      .move:last-child { border-bottom: none; }
      .move__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .move__route { font-size: .74rem; padding: .1rem .45rem; border-radius: 6px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #57534e); }
      .move__route--to { background: color-mix(in srgb, var(--ok, #16a34a) 14%, transparent); color: var(--ok, #15803d); }
      .move i { color: var(--text-soft, #a8a29e); font-size: .7rem; }
      .mb-3 { margin-bottom: .75rem; }
      @media (max-width: 760px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
    `,
  ],
})
export class RouteBalanceComponent implements OnInit {
  private readonly api = inject(SupervisorAiService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly sim = signal<RouteBalanceSim | null>(null);
  dow = new Date().getDay() === 0 ? 7 : new Date().getDay(); // ISODOW aproximado (el server usa TZ MX)

  readonly days = [
    { value: 1, label: 'Lunes' },
    { value: 2, label: 'Martes' },
    { value: 3, label: 'Miércoles' },
    { value: 4, label: 'Jueves' },
    { value: 5, label: 'Viernes' },
    { value: 6, label: 'Sábado' },
    { value: 7, label: 'Domingo' },
  ];

  /** Filas fusionadas antes/después por ruta para la tabla. */
  readonly rows = computed(() => {
    const s = this.sim();
    if (!s) return [];
    const after = new Map(s.after.map((r) => [r.sales_route, r]));
    return s.before.map((b) => {
      const a = after.get(b.sales_route);
      return {
        sales_route: b.sales_route,
        vendor: b.vendor,
        beforeCust: b.customers,
        afterCust: a?.customers ?? b.customers,
        beforeMin: b.time_min,
        afterMin: a?.time_min ?? b.time_min,
      };
    });
  });

  private readonly maxMin = computed(() => {
    const s = this.sim();
    if (!s) return 1;
    const all = [...s.before.map((r) => r.time_min), ...s.after.map((r) => r.time_min)];
    return Math.max(1, ...all);
  });

  pct(min: number): number {
    return Math.round((min / this.maxMin()) * 100);
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api
      .routeBalance(this.dow)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.sim.set(s);
          this.loading.set(false);
        },
        error: () => {
          this.toast.add({ severity: 'error', summary: 'No se pudo simular el balanceo' });
          this.loading.set(false);
        },
      });
  }

  confirmApply(): void {
    const moved = this.sim()?.metrics?.moved ?? 0;
    this.confirm.confirm({
      header: 'Aplicar rebalanceo',
      message: `Se moverán ${moved} cliente(s) entre rutas para nivelar los tiempos. Es reversible. ¿Aplicar?`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Aplicar',
      rejectLabel: 'Cancelar',
      accept: () => this.apply(),
    });
  }

  private apply(): void {
    this.busy.set(true);
    this.api
      .applyRouteBalance(this.dow)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.toast.add({ severity: 'success', summary: 'Rebalanceo aplicado', detail: `${r?.applied ?? 0} clientes movidos` });
          this.busy.set(false);
          this.load();
        },
        error: () => {
          this.toast.add({ severity: 'error', summary: 'No se pudo aplicar' });
          this.busy.set(false);
        },
      });
  }

  confirmUndo(): void {
    this.confirm.confirm({
      header: 'Revertir rebalanceo',
      message: 'Restaura las rutas de los clientes al estado previo al último rebalanceo de este día. ¿Revertir?',
      icon: 'pi pi-undo',
      acceptLabel: 'Revertir',
      rejectLabel: 'Cancelar',
      accept: () => this.undo(),
    });
  }

  private undo(): void {
    this.busy.set(true);
    this.api
      .undoRouteBalance(this.dow)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.toast.add({ severity: 'info', summary: 'Rebalanceo revertido', detail: `${r?.restored ?? 0} clientes restaurados` });
          this.busy.set(false);
          this.load();
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'No se pudo revertir', detail: e?.error?.message });
          this.busy.set(false);
        },
      });
  }
}
