import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageService } from 'primeng/api';
import {
  TeleventaService,
  QueueItem,
  ReservationRecord,
} from '../televenta.service';

const REASON_LABEL: Record<QueueItem['reason'], string> = {
  inactive_critical: 'Inactivo crítico',
  callback_due: 'Callback hoy',
  inactive_normal: 'Inactivo',
  never_ordered: 'Sin pedidos',
  general: 'Pool',
};

const REASON_SEVERITY: Record<QueueItem['reason'], 'danger' | 'warn' | 'info' | 'secondary' | 'success'> = {
  inactive_critical: 'danger',
  callback_due: 'warn',
  inactive_normal: 'info',
  never_ordered: 'secondary',
  general: 'success',
};

@Component({
  selector: 'app-televenta-queue',
  standalone: true,
  imports: [CommonModule, RouterModule, ButtonModule, TableModule, TagModule, ProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="section">
      <header class="section-header">
        <h1>Cola priorizada</h1>
        <p>Clientes ordenados por urgencia. Reservá uno para empezar a trabajarlo (TTL 30 min).</p>
      </header>

      <div *ngIf="loading()" class="loading" aria-live="polite">
        <p-progressSpinner styleClass="w-12 h-12"></p-progressSpinner>
      </div>

      <ng-container *ngIf="!loading()">
        <!-- Mis reservas activas -->
        <div *ngIf="myReservations().length > 0" class="my-card">
          <h2>Mis reservas activas <span class="count">({{ myReservations().length }})</span></h2>
          <div class="my-list">
            <article *ngFor="let r of myReservations()" class="my-item">
              <div class="my-info">
                <p class="code">{{ r.customer_code }}</p>
                <p class="name">{{ r.customer_name }}</p>
                <p class="ttl">Vence en {{ formatTtl(r.expires_in_seconds) }}</p>
              </div>
              <div class="my-actions">
                <button
                  pButton
                  label="Abrir"
                  icon="pi pi-arrow-right"
                  size="small"
                  (click)="open(r.customer_id)"
                ></button>
                <button
                  pButton
                  label="Liberar"
                  severity="secondary"
                  [outlined]="true"
                  size="small"
                  (click)="release(r.id)"
                  [disabled]="releasing() === r.id"
                ></button>
              </div>
            </article>
          </div>
        </div>

        <!-- Cola priorizada -->
        <div class="queue-card">
          <header class="queue-header">
            <h2>Próximos clientes <span class="count">({{ queue().length }})</span></h2>
            <button
              pButton
              icon="pi pi-refresh"
              label="Refrescar"
              severity="secondary"
              [text]="true"
              size="small"
              (click)="refresh()"
            ></button>
          </header>

          <div *ngIf="queue().length === 0" class="empty">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <p>No hay clientes pendientes en este momento.</p>
            <small>Revisá tus callbacks programados o esperá nuevos leads.</small>
          </div>

          <div *ngIf="queue().length > 0" class="queue-table" role="list">
            <article *ngFor="let item of queue()" class="queue-item" role="listitem">
              <div class="qi-tag">
                <p-tag
                  [value]="reasonLabel(item.reason)"
                  [severity]="reasonSeverity(item.reason)"
                ></p-tag>
              </div>
              <div class="qi-info">
                <p class="code">{{ item.code }}</p>
                <p class="name">{{ item.name }}</p>
                <p class="meta">
                  <span *ngIf="item.phone"><i class="pi pi-phone" aria-hidden="true"></i> {{ item.phone }}</span>
                  <span *ngIf="item.last_order_at; else noOrders">
                    Último pedido hace {{ item.days_since_last_order }} días
                  </span>
                  <ng-template #noOrders>Sin pedidos previos</ng-template>
                </p>
              </div>
              <div class="qi-actions">
                <button
                  pButton
                  label="Tomar"
                  icon="pi pi-arrow-right"
                  iconPos="right"
                  size="small"
                  (click)="reserve(item)"
                  [disabled]="reserving() === item.customer_id"
                ></button>
              </div>
            </article>
          </div>
        </div>
      </ng-container>
    </section>
  `,
  styles: [
    `
      .section { display: flex; flex-direction: column; gap: 1.5rem; }
      .section-header h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 0.25rem; color: var(--text-color); }
      .section-header p { color: var(--text-color-secondary); font-size: 0.875rem; margin: 0; }
      .loading { display: flex; justify-content: center; padding: 4rem 0; }
      .my-card, .queue-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 16px;
        padding: 1.25rem;
      }
      .my-card h2, .queue-card h2 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; color: var(--text-color); display: flex; align-items: center; gap: 0.5rem; }
      .count { font-size: 0.8rem; color: var(--text-color-secondary); font-weight: 400; }
      .my-list { display: flex; flex-direction: column; gap: 0.5rem; }
      .my-item, .queue-item {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.75rem;
        border: 1px solid var(--border-color);
        border-radius: 12px;
        background: var(--neutral-50);
        min-height: 64px;
      }
      .my-item:hover, .queue-item:hover { background: var(--neutral-100); }
      .my-info, .qi-info { flex: 1; min-width: 0; }
      .code { font-size: 0.7rem; color: var(--text-color-secondary); font-weight: 600; margin: 0; letter-spacing: 0.04em; }
      .name { font-size: 0.95rem; font-weight: 500; color: var(--text-color); margin: 0.1rem 0; }
      .ttl { font-size: 0.75rem; color: var(--brand-700); margin: 0; }
      .meta { font-size: 0.75rem; color: var(--text-color-secondary); margin: 0.1rem 0 0; display: flex; flex-wrap: wrap; gap: 0.75rem; }
      .meta i { font-size: 0.75rem; margin-right: 0.1rem; }
      .my-actions, .qi-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
      .qi-tag { width: 110px; flex-shrink: 0; }
      .queue-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
      .queue-header h2 { margin: 0; }
      .queue-table { display: flex; flex-direction: column; gap: 0.5rem; }
      .empty { text-align: center; padding: 3rem 1rem; color: var(--text-color-secondary); }
      .empty i { font-size: 2.5rem; color: var(--ok-fg); margin-bottom: 0.75rem; display: block; }
      .empty p { font-size: 0.95rem; margin: 0; color: var(--text-color); }
      .empty small { font-size: 0.8rem; }
      @media (max-width: 640px) {
        .queue-item, .my-item { flex-direction: column; align-items: stretch; }
        .qi-tag { width: auto; }
        .qi-actions, .my-actions { justify-content: flex-end; }
      }
    `,
  ],
})
export class TeleventaQueueComponent implements OnInit {
  private readonly svc = inject(TeleventaService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  readonly queue = signal<QueueItem[]>([]);
  readonly myReservations = signal<ReservationRecord[]>([]);
  readonly loading = signal<boolean>(true);
  readonly reserving = signal<string | null>(null);
  readonly releasing = signal<string | null>(null);

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    Promise.all([
      this.svc.getQueue(50).toPromise(),
      this.svc.getMyReservations().toPromise(),
    ])
      .then(([q, r]) => {
        this.queue.set(q ?? []);
        this.myReservations.set(r ?? []);
      })
      .catch((err) => {
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message || 'No se pudo cargar la cola.',
        });
      })
      .finally(() => this.loading.set(false));
  }

  reserve(item: QueueItem): void {
    this.reserving.set(item.customer_id);
    this.svc.reserveLead(item.customer_id).subscribe({
      next: () => {
        this.toast.add({
          severity: 'success',
          summary: 'Lead reservado',
          detail: `${item.code} ${item.name} reservado 30 min.`,
        });
        this.router.navigate(['/televenta/lead', item.customer_id]);
      },
      error: (err) => {
        this.reserving.set(null);
        const msg = err?.status === 409
          ? 'Otro operador ya tomó este cliente.'
          : err?.error?.message || 'No se pudo reservar.';
        this.toast.add({ severity: 'warn', summary: 'Reserva fallida', detail: msg });
        this.refresh();
      },
    });
  }

  release(reservationId: string): void {
    this.releasing.set(reservationId);
    this.svc.releaseReservation(reservationId).subscribe({
      next: () => {
        this.toast.add({ severity: 'info', summary: 'Liberado', detail: 'Lead devuelto al pool.' });
        this.refresh();
      },
      error: () => {
        this.releasing.set(null);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo liberar.' });
      },
    });
  }

  open(customerId: string): void {
    this.router.navigate(['/televenta/lead', customerId]);
  }

  reasonLabel(r: QueueItem['reason']): string {
    return REASON_LABEL[r] || r;
  }

  reasonSeverity(r: QueueItem['reason']): 'danger' | 'warn' | 'info' | 'secondary' | 'success' {
    return REASON_SEVERITY[r] || 'secondary';
  }

  formatTtl(secs: number): string {
    if (secs <= 0) return 'expirada';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}
