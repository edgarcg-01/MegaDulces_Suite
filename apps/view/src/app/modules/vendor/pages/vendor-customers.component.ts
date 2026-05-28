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
import { Router } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, switchMap } from 'rxjs';
import { VendorService, VendorCustomer } from '../vendor.service';

@Component({
  selector: 'app-vendor-customers',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    SkeletonModule,
    InputTextModule,
    ButtonModule,
  ],
  template: `
    <h1 class="page-title">Clientes</h1>

    <div class="search-bar">
      <span class="p-input-icon-left search-wrap">
        <i class="pi pi-search"></i>
        <input
          pInputText
          type="search"
          placeholder="Buscar por nombre, código o RFC"
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
        <i class="pi pi-info-circle"></i>
        <p *ngIf="search">Sin resultados para "{{ search }}".</p>
        <p *ngIf="!search">No hay clientes activos en tu tenant.</p>
      </div>
    </p-card>

    <div *ngIf="!loading() && customers().length > 0" class="customer-list">
      <p-card
        *ngFor="let c of customers()"
        styleClass="customer-card"
        (click)="navigateToTakeOrder(c)"
      >
        <div class="customer-row">
          <div class="info">
            <div class="name">{{ c.name }}</div>
            <div class="meta">
              <span class="code">{{ c.code }}</span>
              <span *ngIf="c.phone" class="phone">
                <i class="pi pi-phone"></i> {{ c.phone }}
              </span>
            </div>
            <div class="credit" *ngIf="c.credit_limit > 0">
              Crédito: {{ fmtMoney(c.credit_limit) }}
            </div>
          </div>
          <i class="pi pi-arrow-right action"></i>
        </div>
      </p-card>
    </div>
  `,
  styles: [
    `
      .page-title { margin: 0 0 1rem; font-size: 1.5rem; }
      .search-bar { margin-bottom: 1rem; }
      .search-wrap {
        display: block;
        position: relative;
      }
      .search-wrap input {
        width: 100%;
        padding-left: 2.25rem;
      }
      .search-wrap i {
        position: absolute;
        left: 0.75rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-color-secondary);
        z-index: 1;
      }
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--text-color-secondary);
      }
      .empty i { font-size: 2rem; display: block; margin-bottom: 0.5rem; }
      .customer-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      /* styleClass aplica la clase AL .p-card, no a un descendiente.
         Por eso combinamos las clases sin espacio. */
      :host ::ng-deep .p-card.customer-card {
        cursor: pointer;
        transition: box-shadow 0.15s, transform 0.05s;
      }
      :host ::ng-deep .p-card.customer-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.08); }
      :host ::ng-deep .p-card.customer-card:active { transform: scale(0.99); }
      :host ::ng-deep .p-card.customer-card .p-card-body { padding: 0.875rem 1rem; }
      :host ::ng-deep .p-card.customer-card .p-card-content { padding: 0; }
      .customer-row {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
      .info { flex: 1; min-width: 0; }
      .name {
        font-weight: 600;
        font-size: 1rem;
        line-height: 1.2;
      }
      .meta {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        font-size: 0.8rem;
        color: var(--text-color-secondary);
        margin-top: 0.25rem;
      }
      .code { font-weight: 600; }
      .phone i { font-size: 0.7rem; }
      .credit {
        font-size: 0.75rem;
        color: var(--green-600, #16a34a);
        margin-top: 0.25rem;
      }
      .action {
        color: var(--primary-color);
        font-size: 1.25rem;
        flex-shrink: 0;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorCustomersComponent implements OnInit {
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
        switchMap((s) => this.api.listCustomers({ search: s.trim() || undefined, pageSize: 100 })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (r) => {
          this.customers.set(r.data);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });

    // Carga inicial
    this.search$.next('');
  }

  onSearch(v: string): void {
    this.loading.set(true);
    this.search$.next(v);
  }

  navigateToTakeOrder(c: VendorCustomer): void {
    this.router.navigate(['/vendor/take-order', c.id]);
  }

  fmtMoney(n: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
  }
}
