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
    <h1 class="page-title">Buscar cliente</h1>
    <p class="subtitle">Cualquier cliente del catálogo, esté o no en tu cartera</p>

    <div class="search">
      <i class="pi pi-search"></i>
      <input
        pInputText
        type="search"
        placeholder="Nombre, código o RFC"
        [(ngModel)]="search"
        (ngModelChange)="onSearch($event)"
        inputmode="search"
        enterkeyhint="search"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
      />
    </div>

    <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

    <div *ngIf="!loading() && customers().length === 0" class="empty">
      <i class="pi pi-search"></i>
      <p *ngIf="search">Sin resultados para "{{ search }}".</p>
      <p *ngIf="!search">Escribí para buscar un cliente.</p>
    </div>

    <div *ngIf="!loading() && customers().length > 0" class="list">
      <button class="client" *ngFor="let c of customers()" (click)="navigateToTakeOrder(c)">
        <span class="av">{{ initials(c.name) }}</span>
        <span class="cbody">
          <span class="nm">{{ c.name }}</span>
          <span class="meta">
            <span class="code">{{ c.code }}</span>
            <span *ngIf="c.phone">· {{ c.phone }}</span>
          </span>
        </span>
        <i class="pi pi-arrow-right action"></i>
      </button>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .page-title { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; }
      .search { display: flex; align-items: center; gap: 0.6rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.1rem 0.95rem; margin-bottom: 1rem; box-shadow: 0 1px 2px rgba(16,13,9,0.05); }
      .search i { color: var(--text-muted); }
      .search input { flex: 1; border: none; background: none; outline: none; height: 2.8rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }
      .empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }
      .list { display: flex; flex-direction: column; gap: 0.5rem; }
      .client {
        display: flex; align-items: center; gap: 0.8rem; width: 100%; text-align: left;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px);
        padding: 0.7rem 0.875rem; cursor: pointer; box-shadow: 0 1px 2px rgba(16,13,9,0.05);
        transition: transform 0.06s var(--ease, ease);
      }
      .client:active { transform: scale(0.985); }
      .av { width: 2.4rem; height: 2.4rem; border-radius: 12px; flex-shrink: 0; display: grid; place-items: center; background: var(--stone-100); color: var(--stone-700); font-weight: 800; font-size: 0.9rem; }
      .cbody { flex: 1; min-width: 0; }
      .nm { display: block; font-weight: 700; font-size: 0.95rem; color: var(--text-main); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .meta { display: flex; gap: 0.4rem; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
      .code { font-family: var(--font-mono); font-weight: 600; }
      .action { color: var(--action); font-size: 1.1rem; flex-shrink: 0; }
      @media (prefers-reduced-motion: reduce) { .client { transition: none; } }
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

  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
}
