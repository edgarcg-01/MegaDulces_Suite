import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, switchMap } from 'rxjs';
import { VendorService, VendorCustomer } from '../vendor.service';

/**
 * Apartado "Pedido nuevo": la cartera del vendedor (clientes de sus rutas de
 * venta asignadas) en orden de visita (visit_sequence). Tocar un cliente abre
 * el flujo de toma de pedido. La cartera y el orden los define el supervisor en
 * /comercial/cartera.
 */
@Component({
  selector: 'app-vendor-new-order',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    CardModule,
    SkeletonModule,
    InputTextModule,
    ButtonModule,
    TagModule,
  ],
  template: `
    <h1 class="page-title">Pedido nuevo</h1>
    <p class="subtitle">Tu cartera, en orden de visita</p>

    <div class="search-bar">
      <span class="p-input-icon-left search-wrap">
        <i class="pi pi-search"></i>
        <input
          pInputText
          type="search"
          placeholder="Filtrar tu cartera"
          [(ngModel)]="search"
          (ngModelChange)="onSearch($event)"
          inputmode="search"
          enterkeyhint="search"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
        />
      </span>
    </div>

    <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

    <p-card *ngIf="!loading() && customers().length === 0">
      <div class="empty">
        <i class="pi pi-sitemap"></i>
        <p *ngIf="search">Sin resultados para "{{ search }}" en tu cartera.</p>
        <ng-container *ngIf="!search">
          <p>No tenés rutas asignadas todavía.</p>
          <p class="hint">Pedile a tu supervisor que te asigne tu cartera de ventas.</p>
          <a
            pButton
            label="Buscar un cliente"
            icon="pi pi-search"
            severity="secondary"
            [text]="true"
            routerLink="/vendor/search"
          ></a>
        </ng-container>
      </div>
    </p-card>

    <div *ngIf="!loading() && customers().length > 0" class="customer-list">
      <p-card
        *ngFor="let c of customers()"
        styleClass="customer-card"
        (click)="takeOrder(c)"
      >
        <div class="customer-row">
          <div class="seq" [class.unset]="c.visit_sequence == null">
            {{ c.visit_sequence ?? '·' }}
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
            </div>
          </div>
          <i class="pi pi-arrow-right action"></i>
        </div>
      </p-card>
    </div>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.25rem; font-size: 1.5rem; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; }
      .search-bar { margin-bottom: 1rem; }
      .search-wrap { display: block; position: relative; }
      .search-wrap input { width: 100%; padding-left: 2.25rem; }
      .search-wrap i {
        position: absolute;
        left: 0.75rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-muted);
        z-index: 1;
      }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty p { margin: 0 0 0.5rem; }
      .empty .hint { font-size: 0.8rem; margin-bottom: 1rem; }
      .customer-list { display: flex; flex-direction: column; gap: 0.5rem; }
      :host ::ng-deep .p-card.customer-card {
        cursor: pointer;
        transition: box-shadow 0.15s, transform 0.05s;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.customer-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.08); }
      :host ::ng-deep .p-card.customer-card:active { transform: scale(0.99); }
      :host ::ng-deep .p-card.customer-card .p-card-body { padding: 0.75rem 1rem; }
      :host ::ng-deep .p-card.customer-card .p-card-content { padding: 0; }
      :host ::ng-deep .route-tag .p-tag { font-size: 0.65rem; }
      .customer-row { display: flex; align-items: center; gap: 0.875rem; }
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
      .info { flex: 1; min-width: 0; }
      .name { font-weight: 600; font-size: 1rem; line-height: 1.2; color: var(--text-main); }
      .meta { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-top: 0.25rem; }
      .code { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }
      .action { color: var(--brand-700); font-size: 1.25rem; flex-shrink: 0; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorNewOrderComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly customers = signal<VendorCustomer[]>([]);

  search = '';
  private readonly search$ = new Subject<string>();

  ngOnInit(): void {
    this.search$
      .pipe(
        debounceTime(250),
        switchMap((s) => this.api.myCartera({ search: s.trim() || undefined, pageSize: 200 })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (r) => {
          this.customers.set(r.data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });

    this.search$.next('');
  }

  onSearch(v: string): void {
    this.loading.set(true);
    this.search$.next(v);
  }

  takeOrder(c: VendorCustomer): void {
    this.router.navigate(['/vendor/take-order', c.id]);
  }
}
