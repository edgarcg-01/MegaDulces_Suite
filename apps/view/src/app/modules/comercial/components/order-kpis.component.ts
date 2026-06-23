import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

type OrdersMode = 'pending' | 'history';

/**
 * KPI strip de pedidos (adaptativo por modo pending/history). Presentacional puro.
 * J16: migrado a `MetricCard` — hero con sparkline (serie diaria de monto) +
 * cards de status como `progress` (share sobre el libro de la ventana) con color
 * semántico por estado. Count-up consolidado en la directiva del organismo.
 */
@Component({
  selector: 'app-order-kpis',
  standalone: true,
  imports: [CommonModule, SkeletonModule, MetricCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-skeleton *ngIf="showSkeleton" height="172px"></p-skeleton>
    <div *ngIf="!showSkeleton" class="surf-grid">
      <!-- HERO: ventas (sparkline de monto diario) -->
      <app-metric-card class="panel-col-6" [large]="true"
        [label]="mode === 'pending' ? 'Ventas potenciales' : 'Ventas en la ventana'"
        [value]="totalAmount" format="currency" accent="var(--action)"
        [variant]="series.length > 1 ? 'sparkline' : 'plain'" [series]="series"
        [sub]="total + (total === 1 ? ' pedido' : ' pedidos') + ' en período'"></app-metric-card>

      <ng-container *ngIf="mode === 'pending'">
        <app-metric-card class="panel-col-3" variant="progress"
          label="Por aprobar" [value]="statusCounts['pending_approval'] ?? 0" [goal]="windowTotal"
          format="number" accent="var(--warn-fg)" sub="requieren acción"></app-metric-card>
        <app-metric-card class="panel-col-3" variant="progress"
          label="Borradores" [value]="statusCounts['draft'] ?? 0" [goal]="windowTotal"
          format="number" accent="var(--c-text-3)" sub="sin enviar a aprobación"></app-metric-card>
      </ng-container>

      <ng-container *ngIf="mode === 'history'">
        <app-metric-card class="panel-col-2" variant="progress"
          label="En curso" [value]="statusCounts['confirmed'] ?? 0" [goal]="windowTotal"
          format="number" accent="var(--info-fg)" sub="a despachar"></app-metric-card>
        <app-metric-card class="panel-col-2" variant="progress"
          label="Entregados" [value]="statusCounts['fulfilled'] ?? 0" [goal]="windowTotal"
          format="number" accent="var(--ok-fg)" sub="cerrados"></app-metric-card>
        <app-metric-card class="panel-col-2" variant="progress"
          label="Cancelados" [value]="statusCounts['cancelled'] ?? 0" [goal]="windowTotal"
          format="number" accent="var(--bad-fg)" sub="en el período"></app-metric-card>
      </ng-container>
    </div>
  `,
  styles: [`:host { display:block; }`],
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
  /** J16 — serie diaria de monto para el sparkline del hero. */
  @Input() series: number[] = [];

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
}
