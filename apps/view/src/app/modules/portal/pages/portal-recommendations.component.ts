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
import { Router } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs/operators';
import { forkJoin, of } from 'rxjs';
import {
  PortalService,
  RecommendationItem,
  RecommendationCategory,
  RecommendedBasketDto,
} from '../portal.service';

interface CategoryMeta {
  key: RecommendationCategory;
  title: string;
  description: string;
  severity: 'success' | 'info' | 'warn' | 'danger' | 'secondary';
  icon: string;
}

const CATEGORIES: CategoryMeta[] = [
  {
    key: 'base',
    title: 'Tu base',
    description: 'Productos que compras regularmente.',
    severity: 'success',
    icon: 'pi-star-fill',
  },
  {
    key: 'focus',
    title: 'Foco comercial',
    description: 'Productos que otros clientes compran mucho — vale la pena probarlos.',
    severity: 'warn',
    icon: 'pi-bullseye',
  },
  {
    key: 'exploration',
    title: 'Explora estas marcas',
    description: 'SKUs nuevos de tus marcas favoritas.',
    severity: 'info',
    icon: 'pi-compass',
  },
  {
    key: 'innovation',
    title: 'Innovación',
    description: 'Productos recién llegados al catálogo.',
    severity: 'secondary',
    icon: 'pi-sparkles',
  },
];

@Component({
  selector: 'app-portal-recommendations',
  standalone: true,
  imports: [CommonModule, CardModule, SkeletonModule, TagModule, ButtonModule],
  template: `
    <header class="page-header">
      <div>
        <h1>Canasta estratégica</h1>
        <p class="subtitle" *ngIf="basket() as b">
          {{ b.total_recommendations }} sugerencias
          <span *ngIf="b.computed_at">— actualizado {{ fmtDate(b.computed_at) }}</span>
        </p>
      </div>
      <button
        pButton
        label="Ir al catálogo completo"
        icon="pi pi-list"
        severity="secondary"
        (click)="goCatalog()"
      ></button>
    </header>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <p-card *ngIf="!loading() && (basket()?.total_recommendations || 0) === 0">
      <div class="empty">
        <i class="pi pi-info-circle"></i>
        <p>Aún no hay recomendaciones para tu cuenta.</p>
        <small>Compra un par de productos y el sistema empezará a sugerirte.</small>
      </div>
    </p-card>

    <div *ngIf="!loading() && basket()" class="categories">
      <ng-container *ngFor="let cat of categories">
        <ng-container *ngIf="itemsByCategory()[cat.key]?.length">
          <section class="category-section">
            <header class="cat-header">
              <i class="pi {{ cat.icon }}"></i>
              <div>
                <h2>{{ cat.title }}</h2>
                <p>{{ cat.description }}</p>
              </div>
              <p-tag
                [value]="(itemsByCategory()[cat.key]?.length || 0) + ' items'"
                [severity]="cat.severity"
              ></p-tag>
            </header>

            <div class="items-grid">
              <article
                *ngFor="let item of itemsByCategory()[cat.key]"
                class="item-card"
              >
                <header class="item-head">
                  <span class="brand" *ngIf="item.brand_name">{{ item.brand_name }}</span>
                  <p-tag
                    [value]="(item.score * 100).toFixed(0) + '%'"
                    [severity]="cat.severity"
                    styleClass="score-tag"
                  ></p-tag>
                </header>
                <h3>{{ item.product_name }}</h3>
                <p class="reason">{{ item.reason }}</p>
                <footer class="item-foot">
                  <span class="price">{{ fmtMoney(item.sample_price) }}</span>
                  <button
                    pButton
                    icon="pi pi-shopping-cart"
                    label="Ver"
                    size="small"
                    severity="secondary"
                    (click)="goCatalogAndScroll(item.product_id)"
                  ></button>
                </footer>
              </article>
            </div>
          </section>
        </ng-container>
      </ng-container>
    </div>
  `,
  styles: [
    `
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 1.5rem;
      }
      .page-header h1 { margin: 0; font-size: 1.5rem; }
      .subtitle { margin: 0.25rem 0 0; color: var(--text-color-secondary); font-size: 0.875rem; }
      .empty { text-align: center; padding: 2rem; color: var(--text-color-secondary); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty small { display: block; margin-top: 0.5rem; font-size: 0.8rem; }

      .categories {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }
      .category-section {
        background: var(--surface-card, white);
        border: 1px solid var(--surface-border, #e5e7eb);
        border-radius: 8px;
        padding: 1rem 1.25rem;
      }
      .cat-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .cat-header i {
        font-size: 1.5rem;
        color: var(--primary-color);
      }
      .cat-header div { flex: 1; }
      .cat-header h2 { margin: 0; font-size: 1.125rem; }
      .cat-header p { margin: 0; font-size: 0.8rem; color: var(--text-color-secondary); }

      .items-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 0.875rem;
      }
      .item-card {
        background: var(--surface-50, #f9fafb);
        border: 1px solid var(--surface-border, #e5e7eb);
        border-radius: 6px;
        padding: 0.875rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .item-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .brand {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-color-secondary);
      }
      .score-tag ::ng-deep .p-tag { font-size: 0.7rem; padding: 0.15rem 0.45rem; }
      .item-card h3 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
        line-height: 1.25;
      }
      .reason {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-color-secondary);
        flex: 1;
      }
      .item-foot {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 0.25rem;
      }
      .price {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--primary-color);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalRecommendationsComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly categories = CATEGORIES;
  readonly loading = signal(true);
  readonly basket = signal<RecommendedBasketDto | null>(null);

  /** Mapa categoría → items, precomputado para el template. */
  readonly itemsByCategory = computed(() => {
    const b = this.basket();
    if (!b) return {} as Record<RecommendationCategory, RecommendationItem[]>;
    const grouped: Record<RecommendationCategory, RecommendationItem[]> = {
      base: [],
      focus: [],
      exploration: [],
      innovation: [],
    };
    for (const it of b.items) {
      (grouped[it.category] ||= []).push(it);
    }
    return grouped;
  });

  ngOnInit(): void {
    this.api
      .myRecommendations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (b) => {
          this.basket.set(b);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.message || err.message,
          });
        },
      });
  }

  goCatalog(): void {
    this.router.navigateByUrl('/portal/catalog');
  }

  goCatalogAndScroll(_productId: string): void {
    // Para MVP solo navega al catálogo. Scroll-to-product es deferred.
    this.router.navigateByUrl('/portal/catalog');
  }

  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  fmtDate(s: string): string {
    return new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' } as any);
  }
}
