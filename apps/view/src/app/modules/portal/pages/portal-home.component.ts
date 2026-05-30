import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe, CurrencyPipe } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { PortalService, Order, PromotionRow } from '../portal.service';
import { AuthService } from '../../../core/services/auth.service';
import { HapticService } from '../../../core/services/haptic.service';

const PROMOTION_TYPE_LABELS: Record<string, string> = {
  percent_off_product: '% sobre producto',
  percent_off_basket: '% sobre canasta',
  nxm: 'NxM',
  volume_discount: 'Descuento por volumen',
  bundle_fixed_price: 'Bundle precio fijo',
  cross_sell_discount: 'Cross-sell',
};

@Component({
  selector: 'app-portal-home',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    DatePipe,
    CurrencyPipe,
    ButtonModule,
    TagModule,
    ProgressSpinnerModule,
  ],
  template: `
    <!-- GREETING (page header pattern) -->
    <header class="portal-page-head">
      <div class="portal-page-head-text">
        <span class="portal-eyebrow">
          <i class="pi pi-sun" aria-hidden="true"></i>
          {{ greetingPrefix() }}
        </span>
        <h1>Hola, <span class="ph-name">{{ username() }}</span></h1>
        <p class="portal-page-sub">¿Qué vas a pedir hoy?</p>
      </div>
    </header>

    <!-- HERO PROMO (Rappi-style top banner — protagonista) -->
    <section
      *ngIf="!loadingPromos() && featuredPromo() as fp"
      class="ph-hero"
      role="region"
      aria-label="Promoción destacada"
      routerLink="/portal/promotions"
    >
      <div class="ph-hero-content">
        <span class="ph-hero-tag">
          <i class="pi pi-bolt" aria-hidden="true"></i>
          {{ typeLabel(fp.promotion_type) }}
        </span>
        <h2 class="ph-hero-title">{{ fp.name }}</h2>
        <p class="ph-hero-desc" *ngIf="fp.description">{{ fp.description }}</p>
        <span class="ph-hero-cta">
          Comprar
          <i class="pi pi-arrow-right" aria-hidden="true"></i>
        </span>
      </div>
      <div class="ph-hero-art" aria-hidden="true">
        <div class="ph-hero-art-circle"></div>
        <i class="pi pi-percentage ph-hero-art-icon"></i>
      </div>
    </section>

    <!-- MAIN CATEGORIES (2x2 grandes, Stitch style) -->
    <section class="ph-main-cats" aria-label="Accesos principales">
      <button type="button" class="ph-main-cat ph-main-cat-catalog" (click)="goCatalog()">
        <span class="ph-main-cat-icon" aria-hidden="true">
          <i class="pi pi-th-large"></i>
        </span>
        <span class="ph-main-cat-label">Catálogo</span>
      </button>

      <button type="button" class="ph-main-cat ph-main-cat-promos" routerLink="/portal/promotions">
        <span class="ph-main-cat-icon" aria-hidden="true">
          <i class="pi pi-percentage"></i>
        </span>
        <span class="ph-main-cat-label">Promociones</span>
      </button>

      <button
        type="button"
        class="ph-main-cat ph-main-cat-repeat"
        (click)="goLastOrder()"
        [disabled]="!lastFulfilled()"
      >
        <span class="ph-main-cat-icon" aria-hidden="true">
          <i class="pi pi-replay"></i>
        </span>
        <span class="ph-main-cat-label">Repetir</span>
      </button>

      <button type="button" class="ph-main-cat ph-main-cat-ai" (click)="goAi()">
        <span class="ph-main-cat-icon" aria-hidden="true">
          <i class="pi pi-bolt"></i>
        </span>
        <span class="ph-main-cat-label">Pedir con IA</span>
      </button>
    </section>

    <!-- QUICK PROMO TILES (4-cols sub, promos reales como botones rápidos) -->
    <section
      *ngIf="tilePromos().length > 0"
      class="ph-quick-tiles"
      aria-label="Promociones rápidas"
    >
      <a
        *ngFor="let p of tilePromos().slice(0, 4); let i = index; trackBy: trackByPromo"
        routerLink="/portal/promotions"
        [queryParams]="{ code: p.code }"
        class="ph-quick-tile"
        [class]="'ph-quick-tile-' + tileTheme(i)"
      >
        <span class="ph-quick-tile-icon" aria-hidden="true">
          <i [class]="tileIcon(p.promotion_type)"></i>
        </span>
        <span class="ph-quick-tile-label" [title]="p.name">{{ tileBadge(p) }}</span>
      </a>
    </section>

    <!-- PROMOS SECONDARY STRIP -->
    <section *ngIf="!loadingPromos() && secondaryPromos().length > 0" class="ph-block">
      <header class="portal-section-head">
        <h2><i class="pi pi-megaphone" aria-hidden="true"></i>Más promociones</h2>
        <a routerLink="/portal/promotions" class="portal-section-link">Ver todas →</a>
      </header>
      <div class="ph-promos-strip" role="list">
        <article
          *ngFor="let p of secondaryPromos()"
          class="ph-promo-card"
          role="listitem"
          routerLink="/portal/promotions"
        >
          <span class="ph-promo-card-type">{{ typeLabel(p.promotion_type) }}</span>
          <h3 [title]="p.name">{{ p.name }}</h3>
          <p *ngIf="p.description" [title]="p.description">{{ p.description }}</p>
          <footer class="ph-promo-card-foot" *ngIf="p.ends_at">
            <i class="pi pi-calendar" aria-hidden="true"></i>
            Hasta {{ p.ends_at | date:'dd MMM' }}
          </footer>
        </article>
      </div>
    </section>

    <!-- RECENT ORDERS STRIP -->
    <section class="ph-block">
      <header class="portal-section-head">
        <h2><i class="pi pi-receipt" aria-hidden="true"></i>Tus pedidos recientes</h2>
        <a routerLink="/portal/orders" class="portal-section-link">Ver todos →</a>
      </header>

      <div *ngIf="loadingOrders()" class="ph-loading">
        <p-progressSpinner styleClass="ph-spinner"></p-progressSpinner>
      </div>

      <div *ngIf="!loadingOrders() && orders().length === 0" class="portal-empty">
        <div class="portal-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div>
        <h2>Aún no tenés pedidos</h2>
        <p>Explorá el catálogo y armá tu primer pedido en minutos.</p>
        <div class="portal-empty-actions">
          <button type="button" class="portal-btn-primary" (click)="goCatalog()">
            <i class="pi pi-arrow-right" aria-hidden="true"></i>
            Explorar catálogo
          </button>
        </div>
      </div>

      <div
        *ngIf="!loadingOrders() && orders().length > 0"
        class="ph-orders-strip"
        role="list"
      >
        <article
          *ngFor="let o of orders()"
          class="ph-order"
          [class]="'ph-order-' + o.status"
          role="listitem"
        >
          <header class="ph-order-head">
            <span class="portal-status-pill" [class]="'is-' + o.status">
              {{ statusLabel(o.status) }}
            </span>
            <span class="ph-order-time">{{ o.created_at | date:'dd MMM' }}</span>
          </header>

          <div class="ph-order-body">
            <span class="ph-order-avatar" aria-hidden="true">
              <i [class]="statusIcon(o.status)"></i>
            </span>
            <div class="ph-order-info">
              <span class="ph-order-summary">{{ orderSummary(o) }}</span>
              <span class="ph-order-code">{{ o.code }}</span>
            </div>
          </div>

          <footer class="ph-order-foot">
            <span class="ph-order-total">{{ +o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            <button
              type="button"
              class="ph-order-action"
              (click)="onOrderAction(o); $event.stopPropagation()"
            >{{ orderActionLabel(o.status) }}</button>
          </footer>
        </article>
      </div>
    </section>

  `,
  styles: [
    `
      :host {
        display: block;
        max-width: 1100px;
        margin: 0 auto;
      }

      /* ── GREETING accent (acento amarillo bajo nombre) ──────────── */
      .ph-name {
        color: var(--text-main);
        border-bottom: 3px solid var(--brand-500);
        padding-bottom: 1px;
      }

      /* ── HERO PROMO (banner protagonista, radius lg) ───────────── */
      .ph-hero {
        position: relative;
        overflow: hidden;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 1rem;
        align-items: center;
        margin-bottom: 1.5rem;
        padding: 1.125rem 1.25rem;
        border-radius: 18px;
        background:
          linear-gradient(135deg, var(--neutral-950) 0%, var(--neutral-900) 100%);
        color: #fff;
        cursor: pointer;
        transition: transform 200ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
        box-shadow: 0 12px 28px -10px rgba(0, 0, 0, 0.35);
      }
      .ph-hero:hover { transform: translateY(-2px); }
      .ph-hero-content { position: relative; z-index: 1; min-width: 0; }
      .ph-hero-tag {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.65rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: var(--brand-400);
        color: var(--neutral-950);
        padding: 0.25rem 0.625rem;
        border-radius: 999px;
        margin-bottom: 0.625rem;
      }
      .ph-hero-title {
        margin: 0 0 0.25rem;
        font-size: clamp(1.125rem, 4vw, 1.5rem);
        font-weight: 800;
        letter-spacing: -0.015em;
        line-height: 1.15;
      }
      .ph-hero-desc {
        margin: 0 0 0.75rem;
        font-size: 0.8125rem;
        opacity: 0.85;
        max-width: 90%;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .ph-hero-cta {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.8125rem;
        font-weight: 800;
        color: var(--brand-400);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ph-hero-cta i { font-size: 0.75rem; transition: transform 200ms var(--ease-standard); }
      .ph-hero:hover .ph-hero-cta i { transform: translateX(3px); }
      .ph-hero-art {
        position: relative;
        width: 96px;
        height: 96px;
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .ph-hero-art-circle {
        position: absolute;
        inset: 0;
        background: radial-gradient(circle, rgba(253, 231, 7, 0.18), transparent 70%);
        border-radius: 50%;
      }
      .ph-hero-art-icon {
        position: relative;
        font-size: 2.5rem;
        color: var(--brand-400);
        z-index: 1;
      }

      /* ── MAIN CATEGORIES 2x2 (radius lg para acceso primario) ──── */
      .ph-main-cats {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.75rem;
        margin-bottom: 1.5rem;
      }
      @media (min-width: 900px) {
        .ph-main-cats { grid-template-columns: repeat(4, 1fr); }
      }
      .ph-main-cat {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 1.5rem 0.75rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        cursor: pointer;
        text-decoration: none;
        color: var(--text-main);
        transition: transform 180ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ph-main-cat:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 12px 24px -10px rgba(0, 0, 0, 0.12);
      }
      .ph-main-cat:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }
      .ph-main-cat:focus-visible {
        outline: 2px solid var(--brand-500);
        outline-offset: 2px;
      }
      .ph-main-cat-icon {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--neutral-100);
        color: var(--text-main);
        transition: transform 180ms var(--ease-standard);
      }
      .ph-main-cat:hover .ph-main-cat-icon { transform: scale(1.06); }
      .ph-main-cat-icon i { font-size: 1.875rem; }
      .ph-main-cat-label {
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--text-main);
        text-align: center;
      }
      /* Variantes por categoría: tint pastel del icono */
      .ph-main-cat-catalog .ph-main-cat-icon {
        background: #DBEAFE; color: #1D4ED8;
      }
      .ph-main-cat-promos .ph-main-cat-icon {
        background: #FCE7F3; color: #BE185D;
      }
      .ph-main-cat-repeat .ph-main-cat-icon {
        background: #D1FAE5; color: #047857;
      }
      .ph-main-cat-ai .ph-main-cat-icon {
        background: var(--neutral-950); color: var(--brand-400);
      }

      /* ── QUICK TILES (4-cols sub-categorías, Stitch style) ─────── */
      .ph-quick-tiles {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.625rem;
        padding-top: 0.5rem;
        margin-bottom: 1.5rem;
      }
      .ph-quick-tile {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        text-decoration: none;
        color: inherit;
        cursor: pointer;
      }
      .ph-quick-tile-icon {
        width: 56px;
        height: 56px;
        border-radius: 14px;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        display: grid;
        place-items: center;
        transition: box-shadow 200ms var(--ease-standard), transform 180ms var(--ease-standard);
      }
      .ph-quick-tile:hover .ph-quick-tile-icon {
        box-shadow: 0 8px 18px -8px rgba(0, 0, 0, 0.14);
        transform: translateY(-1px);
      }
      .ph-quick-tile-icon i { font-size: 1.5rem; }
      .ph-quick-tile-label {
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--text-muted);
        text-align: center;
        line-height: 1.15;
      }
      /* Variantes color por tema */
      .ph-quick-tile-brand .ph-quick-tile-icon { color: var(--brand-700); }
      .ph-quick-tile-rose .ph-quick-tile-icon { color: #EC4899; }
      .ph-quick-tile-sky .ph-quick-tile-icon { color: #0EA5E9; }
      .ph-quick-tile-mint .ph-quick-tile-icon { color: #10B981; }
      .ph-quick-tile-lilac .ph-quick-tile-icon { color: #8B5CF6; }
      .ph-quick-tile-amber .ph-quick-tile-icon { color: #F59E0B; }

      /* ── PROMOS STRIP (protagonista central, cards prominentes) ── */
      .ph-promos-strip {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(300px, 360px);
        gap: 1rem;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        padding-bottom: 0.75rem;
        margin: 0 -0.25rem;
        padding-left: 0.25rem;
        padding-right: 0.25rem;
        -webkit-overflow-scrolling: touch;
      }
      .ph-promos-strip::-webkit-scrollbar { height: 6px; }
      .ph-promos-strip::-webkit-scrollbar-thumb {
        background: var(--neutral-200);
        border-radius: 3px;
      }
      .ph-promo-card {
        scroll-snap-align: start;
        position: relative;
        overflow: hidden;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-left: 4px solid var(--brand-500);
        border-radius: 14px;
        padding: 1.25rem 1.25rem 1.125rem;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-height: 168px;
        transition: transform 180ms var(--ease-standard), border-color 200ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .ph-promo-card::after {
        content: '';
        position: absolute;
        width: 140px;
        height: 140px;
        right: -50px;
        top: -50px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(253, 231, 7, 0.10), transparent 70%);
        pointer-events: none;
      }
      .ph-promo-card:hover {
        transform: translateY(-3px);
        box-shadow: 0 12px 28px -12px rgba(0, 0, 0, 0.18);
      }
      .ph-promo-card-type {
        font-size: 0.65rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--brand-700);
        background: var(--brand-100);
        border: 1px solid var(--brand-200);
        border-radius: 999px;
        padding: 0.25rem 0.625rem;
        align-self: flex-start;
      }
      .ph-promo-card h3 {
        font-size: 1.0625rem;
        font-weight: 800;
        margin: 0;
        color: var(--text-main);
        line-height: 1.25;
        letter-spacing: -0.01em;
      }
      .ph-promo-card p {
        font-size: 0.875rem;
        color: var(--text-muted);
        margin: 0;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .ph-promo-card-foot {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-muted);
        margin-top: auto;
        padding-top: 0.625rem;
        border-top: 1px solid var(--border-color);
        display: flex;
        gap: 0.35rem;
        align-items: center;
      }

      /* ── BLOCKS spacing ────────────────────────────────────────── */
      .ph-block { margin-bottom: 2rem; }
      .ph-loading {
        display: flex;
        justify-content: center;
        padding: 2rem;
      }

      /* ── ORDERS STRIP (cards horizontales Stitch style) ─────────── */
      .ph-orders-strip {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(280px, 320px);
        gap: 0.875rem;
        overflow-x: auto;
        scrollbar-width: none;
        scroll-snap-type: x mandatory;
        padding-bottom: 0.5rem;
        margin: 0 -0.25rem;
        padding-left: 0.25rem;
        padding-right: 0.25rem;
      }
      .ph-orders-strip::-webkit-scrollbar { display: none; }
      .ph-order {
        scroll-snap-align: start;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        transition: box-shadow 200ms var(--ease-standard), border-color 150ms var(--ease-standard);
      }
      .ph-order:hover {
        box-shadow: 0 8px 18px -8px rgba(0, 0, 0, 0.10);
        border-color: var(--neutral-300);
      }

      .ph-order-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .ph-order-time {
        font-size: 0.75rem;
        color: var(--text-muted);
      }

      .ph-order-body {
        display: flex;
        align-items: center;
        gap: 0.625rem;
      }
      .ph-order-avatar {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        background: var(--neutral-100);
        color: var(--text-main);
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .ph-order-avatar i { font-size: 1.125rem; }
      .ph-order-info {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .ph-order-summary {
        font-size: 0.875rem;
        font-weight: 700;
        color: var(--text-main);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ph-order-code {
        font-size: 0.75rem;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.02em;
      }

      .ph-order-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-top: 0.625rem;
        border-top: 1px solid var(--border-color);
      }
      .ph-order-total {
        font-size: 1.0625rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .ph-order-action {
        background: transparent;
        border: none;
        color: var(--text-main);
        font-size: 0.8125rem;
        font-weight: 700;
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        border-radius: 8px;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ph-order-action:hover {
        background: var(--neutral-100);
        color: var(--brand-700);
      }

    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalHomeComponent {
  private readonly portal = inject(PortalService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly haptic = inject(HapticService);

  readonly username = signal<string>(this.auth.user()?.username || '');
  readonly orders = signal<Order[]>([]);
  readonly promotions = signal<PromotionRow[]>([]);
  readonly loadingOrders = signal(true);
  readonly loadingPromos = signal(true);

  readonly greetingPrefix = computed(() => {
    const h = new Date().getHours();
    if (h < 6) return 'Madrugada';
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  });

  readonly featuredPromo = computed(() => this.promotions()[0] || null);
  /** Próximas 6 promos después del hero — se renderizan como tiles botón. */
  readonly tilePromos = computed(() => this.promotions().slice(1, 7));
  /** El resto va a la strip secundaria horizontal abajo. */
  readonly secondaryPromos = computed(() => this.promotions().slice(7));

  /** Tema visual por índice (cycling) para diferenciar tiles. */
  private readonly TILE_THEMES = ['brand', 'rose', 'sky', 'mint', 'lilac', 'amber'];

  /** Ícono según tipo de promoción. */
  private readonly PROMO_ICONS: Record<string, string> = {
    percent_off_product: 'pi pi-percentage',
    percent_off_basket: 'pi pi-shopping-bag',
    nxm: 'pi pi-clone',
    volume_discount: 'pi pi-database',
    bundle_fixed_price: 'pi pi-box',
    cross_sell_discount: 'pi pi-share-alt',
  };

  trackByPromo = (_i: number, p: PromotionRow) => p.id;

  tileTheme(i: number): string {
    return this.TILE_THEMES[i % this.TILE_THEMES.length];
  }
  tileIcon(type: string): string {
    return this.PROMO_ICONS[type] || 'pi pi-tag';
  }
  /** Badge corto que destaca el tipo de promo. */
  tileBadge(p: PromotionRow): string {
    const map: Record<string, string> = {
      percent_off_product: '% Off',
      percent_off_basket: '% Total',
      nxm: 'NxM',
      volume_discount: 'Vol',
      bundle_fixed_price: 'Bundle',
      cross_sell_discount: 'Cross',
    };
    return map[p.promotion_type] || 'Promo';
  }

  readonly lastFulfilled = computed(() =>
    this.orders().find((o) => o.status === 'fulfilled' || o.status === 'confirmed') || null,
  );

  constructor() {
    this.portal.myOrders({ pageSize: 6 }).subscribe({
      next: (r) => {
        this.orders.set(r.data || []);
        this.loadingOrders.set(false);
      },
      error: () => {
        this.orders.set([]);
        this.loadingOrders.set(false);
      },
    });

    this.portal.listActivePromotions(6).subscribe({
      next: (r) => {
        this.promotions.set(r);
        this.loadingPromos.set(false);
      },
      error: () => {
        this.promotions.set([]);
        this.loadingPromos.set(false);
      },
    });
  }

  goCatalog(): void {
    this.haptic.selection();
    this.router.navigateByUrl('/portal/catalog');
  }

  goAi(): void {
    this.haptic.selection();
    this.router.navigateByUrl('/portal/recommendations');
  }

  goLastOrder(): void {
    const l = this.lastFulfilled();
    if (!l) return;
    this.haptic.selection();
    this.router.navigate(['/portal/orders', l.id]);
  }

  statusLabel(s: string): string {
    const m: Record<string, string> = {
      draft: 'Borrador',
      pending_approval: 'Esperando confirmación',
      confirmed: 'Confirmado',
      fulfilled: 'Entregado',
      cancelled: 'Cancelado',
    };
    return m[s] || s;
  }

  statusSeverity(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    const m: Record<string, 'success' | 'info' | 'warn' | 'danger' | 'secondary'> = {
      draft: 'secondary',
      pending_approval: 'warn',
      confirmed: 'info',
      fulfilled: 'success',
      cancelled: 'danger',
    };
    return m[s] || 'secondary';
  }

  typeLabel(t: string): string {
    return PROMOTION_TYPE_LABELS[t] || t;
  }

  statusIcon(s: string): string {
    const m: Record<string, string> = {
      draft: 'pi pi-pencil',
      pending_approval: 'pi pi-hourglass',
      confirmed: 'pi pi-check',
      fulfilled: 'pi pi-truck',
      cancelled: 'pi pi-times',
    };
    return m[s] || 'pi pi-receipt';
  }

  /** Resumen corto del pedido (N producto(s)) — placeholder hasta que el backend traiga product_name. */
  orderSummary(o: Order): string {
    const n = Array.isArray(o.lines) ? o.lines.length : 0;
    if (n === 0) return 'Pedido sin líneas';
    return `${n} producto${n === 1 ? '' : 's'}`;
  }

  /** Label del botón contextual según estado del pedido. */
  orderActionLabel(s: string): string {
    const m: Record<string, string> = {
      draft: 'Continuar',
      pending_approval: 'Ver',
      confirmed: 'Rastrear',
      fulfilled: 'Repetir',
      cancelled: 'Ver',
    };
    return m[s] || 'Ver';
  }

  /** Acción al click del botón contextual: por defecto navega al detalle. */
  onOrderAction(o: Order): void {
    this.haptic.selection();
    this.router.navigate(['/portal/orders', o.id]);
  }
}
