import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';

type OrdersMode = 'pending' | 'history';

/**
 * KPI strip de pedidos (adaptativo por modo pending/history). Presentacional puro.
 * Count-up en los valores (una vez, on-view). El skeleton solo se muestra hasta el
 * primer dato: en recargas posteriores los números se actualizan en su lugar (sin
 * flicker y sin re-animar). Extraído de comercial-orders (CV.3).
 */
@Component({
  selector: 'app-order-kpis',
  standalone: true,
  imports: [CommonModule, SkeletonModule, CountUpDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-skeleton *ngIf="showSkeleton" height="120px"></p-skeleton>
    <div *ngIf="!showSkeleton" class="sheet cols-12">
      <article class="cell" [class.cell-span-6]="mode === 'pending'" [class.cell-span-3]="mode === 'history'">
        <span class="cell-icon" aria-hidden="true">
          <i class="pi pi-wallet"></i>
        </span>
        <span class="cell-label">{{ mode === 'pending' ? 'Ventas potenciales' : 'Ventas en la ventana' }}</span>
        <span class="cell-value is-headline" [appCountUp]="totalAmount" countUpFormat="money-short"></span>
        <span class="cell-sub">{{ total }} pedido{{ total === 1 ? '' : 's' }} en período</span>
      </article>

      <ng-container *ngIf="mode === 'pending'">
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true">
            <i class="pi pi-hourglass"></i>
          </span>
          <span class="cell-label">Por aprobar</span>
          <span class="cell-value" [appCountUp]="statusCounts['pending_approval'] ?? 0" countUpFormat="int"></span>
          <span class="cell-sub">requieren acción</span>
          <div class="ok-ratio" aria-hidden="true">
            <div class="ok-ratio-track"><div class="ok-ratio-fill is-warn" [style.width.%]="ratio('pending_approval')"></div></div>
            <span class="ok-ratio-pct">{{ ratio('pending_approval') }}%</span>
          </div>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true">
            <i class="pi pi-pencil"></i>
          </span>
          <span class="cell-label">Borradores</span>
          <span class="cell-value" [appCountUp]="statusCounts['draft'] ?? 0" countUpFormat="int"></span>
          <span class="cell-sub">sin enviar a aprobación</span>
          <div class="ok-ratio" aria-hidden="true">
            <div class="ok-ratio-track"><div class="ok-ratio-fill is-neutral" [style.width.%]="ratio('draft')"></div></div>
            <span class="ok-ratio-pct">{{ ratio('draft') }}%</span>
          </div>
        </article>
      </ng-container>

      <ng-container *ngIf="mode === 'history'">
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true">
            <i class="pi pi-sync"></i>
          </span>
          <span class="cell-label">En curso</span>
          <span class="cell-value" [appCountUp]="statusCounts['confirmed'] ?? 0" countUpFormat="int"></span>
          <span class="cell-sub">a despachar</span>
          <div class="ok-ratio" aria-hidden="true">
            <div class="ok-ratio-track"><div class="ok-ratio-fill is-info" [style.width.%]="ratio('confirmed')"></div></div>
            <span class="ok-ratio-pct">{{ ratio('confirmed') }}%</span>
          </div>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true">
            <i class="pi pi-check-circle"></i>
          </span>
          <span class="cell-label">Entregados</span>
          <span class="cell-value" [appCountUp]="statusCounts['fulfilled'] ?? 0" countUpFormat="int"></span>
          <span class="cell-sub">cerrados</span>
          <div class="ok-ratio" aria-hidden="true">
            <div class="ok-ratio-track"><div class="ok-ratio-fill is-ok" [style.width.%]="ratio('fulfilled')"></div></div>
            <span class="ok-ratio-pct">{{ ratio('fulfilled') }}%</span>
          </div>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true">
            <i class="pi pi-times-circle"></i>
          </span>
          <span class="cell-label">Cancelados</span>
          <span class="cell-value" [appCountUp]="statusCounts['cancelled'] ?? 0" countUpFormat="int"></span>
          <span class="cell-sub">en el período</span>
          <div class="ok-ratio" aria-hidden="true">
            <div class="ok-ratio-track"><div class="ok-ratio-fill is-bad" [style.width.%]="ratio('cancelled')"></div></div>
            <span class="ok-ratio-pct">{{ ratio('cancelled') }}%</span>
          </div>
        </article>
      </ng-container>
    </div>
  `,
  styles: [`
    /* Barra de ratio: share del status sobre el libro de la ventana. Color = token semántico del estado. */
    .ok-ratio { display: flex; align-items: center; gap: .5rem; margin-top: auto; padding-top: .75rem; }
    .ok-ratio-track {
      flex: 1; height: 6px; border-radius: 999px;
      background: var(--c-surface-2); overflow: hidden;
    }
    .ok-ratio-fill {
      height: 100%; border-radius: 999px;
      transition: width 500ms var(--ease-out, cubic-bezier(.23,1,.32,1));
    }
    .ok-ratio-fill.is-warn    { background: var(--warn-fg); }
    .ok-ratio-fill.is-neutral { background: var(--c-text-3, var(--neutral-400)); }
    .ok-ratio-fill.is-info    { background: var(--info-fg); }
    .ok-ratio-fill.is-ok      { background: var(--ok-fg); }
    .ok-ratio-fill.is-bad     { background: var(--bad-fg); }
    .ok-ratio-pct {
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-2);
      min-width: 34px; text-align: right;
    }
    @media (prefers-reduced-motion: reduce) { .ok-ratio-fill { transition: none; } }
  `],
})
export class OrderKpisComponent {
  private _loading = false;
  private _seen = false;

  /** Skeleton solo hasta el primer dato; luego se actualiza en su lugar. */
  @Input() set loading(v: boolean) {
    this._loading = v;
    if (!v) this._seen = true;
  }
  get showSkeleton(): boolean {
    return this._loading && !this._seen;
  }

  @Input() mode: OrdersMode = 'pending';
  @Input() totalAmount = 0;
  @Input() total = 0;
  @Input() statusCounts: Record<string, number> = {};

  /** Total del libro en la ventana (suma de todos los status, independiente del filtro). */
  get windowTotal(): number {
    const c = this.statusCounts;
    return (
      (c['pending_approval'] || 0) +
      (c['draft'] || 0) +
      (c['confirmed'] || 0) +
      (c['fulfilled'] || 0) +
      (c['cancelled'] || 0)
    );
  }

  /** Share % de un status sobre el libro de la ventana. */
  ratio(key: string): number {
    const t = this.windowTotal;
    return t > 0 ? Math.round(((this.statusCounts[key] || 0) / t) * 100) : 0;
  }
}
