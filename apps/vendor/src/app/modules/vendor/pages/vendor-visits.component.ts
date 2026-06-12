import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VendorService, CoverageCustomer } from '../vendor.service';

/**
 * Apartado "Por visitar": la cartera del vendedor en orden de visita
 * (visit_sequence) con check-in explícito por cliente y la cobertura del día
 * (cuántos visitados de cuántos). Toasts en el p-toast del shell.
 */
@Component({
  selector: 'app-vendor-visits',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CardModule,
    TagModule,
    ButtonModule,
    SkeletonModule,
  ],
  template: `
    <h1 class="page-title">Por visitar</h1>

    <div class="progress" *ngIf="!loading() && customers().length > 0">
      <div class="progress-text">{{ visitedCount() }} de {{ customers().length }} visitados hoy</div>
      <div class="progress-track">
        <div class="progress-fill" [style.transform]="'translateX(' + (progressPct() - 100) + '%)'"></div>
      </div>
    </div>

    <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

    <p-card *ngIf="!loading() && customers().length === 0">
      <div class="empty">
        <i class="pi pi-map-marker"></i>
        <p>No tenés cartera asignada.</p>
        <p class="hint">Pedile a tu supervisor que te asigne tus rutas de venta.</p>
      </div>
    </p-card>

    <div *ngIf="!loading() && customers().length > 0" class="customer-list">
      <p-card
        *ngFor="let c of customers()"
        styleClass="visit-card"
        [class.done]="c.visited_today"
      >
        <div class="visit-row">
          <div class="seq" [class.unset]="c.visit_sequence == null" [class.ok]="c.visited_today">
            <i *ngIf="c.visited_today" class="pi pi-check"></i>
            <span *ngIf="!c.visited_today">{{ c.visit_sequence ?? '·' }}</span>
          </div>
          <div class="info">
            <div class="name">{{ c.name }}</div>
            <div class="meta">
              <span class="code">{{ c.code }}</span>
              <p-tag
                *ngIf="c.sales_route"
                [value]="c.sales_route"
                severity="secondary"
                styleClass="route-tag"
              ></p-tag>
              <span *ngIf="c.visited_today" class="visited-at">Visitado {{ fmtTime(c.last_visit_at) }}</span>
            </div>
          </div>
          <div class="actions">
            <button
              *ngIf="!c.visited_today"
              pButton
              label="Visita"
              icon="pi pi-map-marker"
              size="small"
              [loading]="processing().has(c.id)"
              (click)="checkIn(c)"
            ></button>
            <a
              pButton
              icon="pi pi-shopping-cart"
              severity="secondary"
              size="small"
              [text]="true"
              [routerLink]="['/vendor/take-order', c.id]"
              aria-label="Tomar pedido"
            ></a>
          </div>
        </div>
      </p-card>
    </div>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.75rem; font-size: 1.5rem; color: var(--text-main); }
      .progress { margin-bottom: 1rem; }
      .progress-text { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.375rem; }
      .progress-track {
        height: 0.5rem;
        border-radius: 999px;
        background: var(--surface-100);
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        width: 100%;
        background: var(--ok-fg, var(--brand-700));
        border-radius: 999px;
        transition: transform 0.25s var(--ease-out, cubic-bezier(0.23,1,0.32,1));
      }
      @media (prefers-reduced-motion: reduce) {
        .progress-fill { transition: none; }
      }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty p { margin: 0 0 0.5rem; }
      .empty .hint { font-size: 0.8rem; }
      .customer-list { display: flex; flex-direction: column; gap: 0.5rem; }
      :host ::ng-deep .p-card.visit-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.visit-card.done { opacity: 0.7; }
      :host ::ng-deep .p-card.visit-card .p-card-body { padding: 0.75rem 0.875rem; }
      :host ::ng-deep .p-card.visit-card .p-card-content { padding: 0; }
      :host ::ng-deep .route-tag .p-tag { font-size: 0.65rem; }
      .visit-row { display: flex; align-items: center; gap: 0.75rem; }
      .seq {
        flex-shrink: 0;
        width: 2rem;
        height: 2rem;
        border-radius: 999px;
        background: var(--brand-50, var(--surface-100));
        color: var(--brand-700);
        font-weight: 700;
        font-size: 0.9rem;
        display: flex;
        align-items: center;
        justify-content: center;
        font-variant-numeric: tabular-nums;
      }
      .seq.unset { background: var(--surface-100); color: var(--text-muted); }
      .seq.ok { background: var(--ok-fg, #16a34a); color: #fff; }
      .info { flex: 1; min-width: 0; }
      .name { font-weight: 600; font-size: 1rem; line-height: 1.2; color: var(--text-main); }
      .meta { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-top: 0.25rem; }
      .code { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }
      .visited-at { font-size: 0.7rem; color: var(--ok-fg, #16a34a); }
      .actions { display: flex; align-items: center; gap: 0.25rem; flex-shrink: 0; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorVisitsComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly customers = signal<CoverageCustomer[]>([]);
  readonly processing = signal<Set<string>>(new Set());

  readonly visitedCount = computed(() => this.customers().filter((c) => c.visited_today).length);
  readonly progressPct = computed(() => {
    const total = this.customers().length;
    return total ? Math.round((this.visitedCount() / total) * 100) : 0;
  });

  ngOnInit(): void {
    this.api
      .coverage()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.customers.set(list);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar la cobertura' });
        },
      });
  }

  checkIn(c: CoverageCustomer): void {
    const busy = new Set(this.processing());
    busy.add(c.id);
    this.processing.set(busy);
    this.api
      .checkIn(c.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.customers.set(
            this.customers().map((x) =>
              x.id === c.id
                ? { ...x, visited_today: true, last_visit_at: new Date().toISOString() }
                : x,
            ),
          );
          this.clearProcessing(c.id);
          this.toast.add({ severity: 'success', summary: 'Visita registrada', detail: c.name });
        },
        error: (e) => {
          this.clearProcessing(c.id);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo registrar',
            detail: e?.error?.message || 'Intentá de nuevo.',
          });
        },
      });
  }

  private clearProcessing(id: string): void {
    const s = new Set(this.processing());
    s.delete(id);
    this.processing.set(s);
  }

  fmtTime(s?: string | null): string {
    if (!s) return '';
    return new Date(s).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
}
