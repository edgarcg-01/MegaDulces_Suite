import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { PortalService, PriceRow, PromotionRow } from '../portal.service';
import { AuthService } from '../../../core/services/auth.service';

const TYPE_LABELS: Record<string, string> = {
  percent_off_product: '% sobre producto',
  percent_off_basket: '% sobre canasta',
  nxm: 'NxM',
  volume_discount: 'Descuento por volumen',
  bundle_fixed_price: 'Bundle precio fijo',
  cross_sell_discount: 'Cross-sell',
};

const TYPE_SHORT: Record<string, string> = {
  percent_off_product: '% Off',
  percent_off_basket: 'Canasta',
  nxm: 'NxM',
  volume_discount: 'Volumen',
  bundle_fixed_price: 'Bundle',
  cross_sell_discount: 'Cross',
};

const TYPE_ICONS: Record<string, string> = {
  percent_off_product: 'pi pi-percentage',
  percent_off_basket:  'pi pi-shopping-bag',
  nxm:                 'pi pi-clone',
  volume_discount:     'pi pi-database',
  bundle_fixed_price:  'pi pi-box',
  cross_sell_discount: 'pi pi-share-alt',
};

type FilterKey = 'all' | 'percent_off_product' | 'percent_off_basket' | 'nxm' | 'volume_discount' | 'bundle_fixed_price' | 'cross_sell_discount';

interface ResolvedItem {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  qty: number;
  price: number;
}

interface PromoWithItems extends PromotionRow {
  resolvedItems: ResolvedItem[];
  addable: boolean;
  badge: string;
  shortBadge: string;
  icon: string;
}

interface OfferCard {
  promo: PromoWithItems;
  item: ResolvedItem;
  discountPct: number;
  originalPrice: number;
  finalPrice: number;
  qty: number;
}

@Component({
  selector: 'app-portal-promotions',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    DatePipe,
    CurrencyPipe,
    SkeletonModule,
    TooltipModule,
    ConfirmDialogModule,
    ToastModule,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirmDialog></p-confirmDialog>
    <p-toast position="top-right"></p-toast>

    <div *ngIf="isAdmin()" class="portal-banner" role="status">
      <i class="pi pi-eye" aria-hidden="true"></i>
      <span><b>Vista administrador</b> — las acciones de carrito están deshabilitadas. Iniciá sesión como cliente para aprovechar promos.</span>
    </div>

    <!-- PAGE HEADER -->
    <header class="portal-page-head">
      <div class="portal-page-head-text">
        <span class="portal-eyebrow">
          <i class="pi pi-megaphone" aria-hidden="true"></i>
          Promociones
        </span>
        <h1>Promociones exclusivas</h1>
        <p class="portal-page-sub" *ngIf="!loading()">
          Ofertas diseñadas para tu negocio
          <span *ngIf="filteredPromos().length > 0">
            · {{ filteredPromos().length }} vigente{{ filteredPromos().length === 1 ? '' : 's' }}
          </span>
        </p>
      </div>
    </header>

    <!-- SEARCH BAR -->
    <div class="pp-search" *ngIf="!loading() && promos().length > 0">
      <i class="pi pi-search pp-search-icon" aria-hidden="true"></i>
      <input
        type="text"
        [(ngModel)]="searchTerm"
        (ngModelChange)="onSearchChange($event)"
        placeholder="Buscar promociones..."
        aria-label="Buscar promociones"
      />
      <button
        *ngIf="searchTerm"
        type="button"
        class="pp-search-clear"
        (click)="clearSearch()"
        aria-label="Limpiar búsqueda"
      ><i class="pi pi-times" aria-hidden="true"></i></button>
    </div>

    <!-- CATEGORY FILTER CHIPS -->
    <nav
      *ngIf="!loading() && promos().length > 0"
      class="pp-chip-rail"
      aria-label="Filtrar por tipo de promoción"
      role="tablist"
    >
      <button
        *ngFor="let f of filters; trackBy: trackByFilter"
        type="button"
        class="pp-chip"
        [class.active]="filter() === f.key"
        (click)="setFilter(f.key)"
        role="tab"
        [attr.aria-selected]="filter() === f.key"
      >
        {{ f.label }}
        <span class="pp-chip-count" *ngIf="f.count > 0">{{ f.count }}</span>
      </button>
    </nav>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <!-- EMPTY (sin promos en absoluto) -->
    <div *ngIf="!loading() && promos().length === 0" class="portal-empty">
      <div class="portal-empty-icon"><i class="pi pi-megaphone" aria-hidden="true"></i></div>
      <h2>Sin promociones vigentes</h2>
      <p>No hay promociones activas en este momento. Volvé pronto.</p>
      <div class="portal-empty-actions">
        <button type="button" class="portal-btn-primary" (click)="goCatalog()">
          <i class="pi pi-arrow-right" aria-hidden="true"></i> Ir al catálogo
        </button>
      </div>
    </div>

    <!-- EMPTY (filtro sin resultados) -->
    <div
      *ngIf="!loading() && promos().length > 0 && filteredPromos().length === 0"
      class="portal-empty"
    >
      <div class="portal-empty-icon"><i class="pi pi-filter-slash" aria-hidden="true"></i></div>
      <h2>Sin resultados</h2>
      <p>No encontramos promociones con esos filtros.</p>
      <div class="portal-empty-actions">
        <button type="button" class="portal-btn-ghost" (click)="resetFilters()">
          <i class="pi pi-refresh" aria-hidden="true"></i> Limpiar filtros
        </button>
      </div>
    </div>

    <ng-container *ngIf="!loading() && filteredPromos().length > 0">
      <!-- BANNER DE MARKETING (si la promo tiene arte propio) -->
      <a
        *ngIf="bannerPromo() as bp"
        class="pp-banner"
        (click)="onBentoClick(bp)"
        role="button"
        tabindex="0"
        [attr.aria-label]="'Ver promoción: ' + bp.name"
        (keydown.enter)="onBentoClick(bp)"
      >
        <img [src]="bp.banner_url" [alt]="bp.name" class="pp-banner-img" />
      </a>

      <!-- HERO BENTO GRID (top 3 promos protagonistas) -->
      <section class="pp-bento" aria-label="Promociones destacadas">
        <!-- Main featured (large) -->
        <article
          *ngIf="featuredPromo() as fp"
          class="pp-bento-main"
          [class.pp-bento-disabled]="!fp.addable && fp.promotion_type !== 'percent_off_basket'"
          (click)="onBentoClick(fp)"
          role="button"
          tabindex="0"
          [attr.aria-label]="'Promoción destacada: ' + fp.name"
          (keydown.enter)="onBentoClick(fp)"
        >
          <div class="pp-bento-main-bg" aria-hidden="true">
            <i [class]="fp.icon + ' pp-bento-main-ico'"></i>
          </div>
          <div class="pp-bento-main-content">
            <span class="pp-bento-tag">{{ fp.shortBadge }}</span>
            <h3 class="pp-bento-main-title">{{ heroTitleFor(fp) }}</h3>
            <p class="pp-bento-main-desc">{{ heroDescFor(fp) }}</p>
            <span class="pp-bento-main-cta">
              Ver detalles <i class="pi pi-arrow-right" aria-hidden="true"></i>
            </span>
          </div>
        </article>

        <!-- Secondary 1 -->
        <article
          *ngIf="secondaryPromos()[0] as sp1"
          class="pp-bento-side"
          (click)="onBentoClick(sp1)"
          role="button"
          tabindex="0"
          [attr.aria-label]="sp1.name"
          (keydown.enter)="onBentoClick(sp1)"
        >
          <div class="pp-bento-side-icon" aria-hidden="true">
            <i [class]="sp1.icon"></i>
          </div>
          <h4 class="pp-bento-side-title">{{ sp1.name }}</h4>
          <p class="pp-bento-side-sub">{{ sp1.badge }}</p>
          <span class="pp-bento-side-cta">
            Ver catálogo <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </span>
        </article>

        <!-- Secondary 2 -->
        <article
          *ngIf="secondaryPromos()[1] as sp2"
          class="pp-bento-side pp-bento-side-accent"
          (click)="onBentoClick(sp2)"
          role="button"
          tabindex="0"
          [attr.aria-label]="sp2.name"
          (keydown.enter)="onBentoClick(sp2)"
        >
          <div class="pp-bento-side-flash">
            <span class="pp-bento-flash-icon" aria-hidden="true">
              <i class="pi pi-bolt"></i>
            </span>
            <span class="pp-bento-flash-label">Ventas Flash</span>
          </div>
          <h4 class="pp-bento-side-title">{{ sp2.name }}</h4>
          <p class="pp-bento-side-sub">{{ sp2.badge }}</p>
        </article>
      </section>

      <!-- OFERTAS DESTACADAS — product cards generados de resolvedItems -->
      <section class="pp-offers" *ngIf="offerCards().length > 0" aria-label="Ofertas destacadas">
        <header class="portal-section-head">
          <h2><i class="pi pi-tag" aria-hidden="true"></i>Ofertas destacadas</h2>
          <span class="portal-section-count">
            {{ offerCards().length }} producto{{ offerCards().length === 1 ? '' : 's' }}
          </span>
        </header>

        <div class="pp-offers-grid">
          <article
            *ngFor="let oc of offerCards(); trackBy: trackByOffer"
            class="pp-offer"
          >
            <!-- Image placeholder con avatar de iniciales -->
            <div class="pp-offer-cover" aria-hidden="true">
              <span
                *ngIf="oc.discountPct > 0"
                class="pp-offer-discount"
              >−{{ oc.discountPct }}%</span>
              <span
                class="pp-offer-cover-avatar"
                [style.background]="avatarColor(oc.item.product_id)"
              >{{ avatarInitials(oc.item.product_name) }}</span>
            </div>

            <!-- Body -->
            <div class="pp-offer-body">
              <span class="pp-offer-brand">{{ oc.item.brand_name || 'Sin marca' }}</span>
              <h4 class="pp-offer-name" [title]="oc.item.product_name">{{ oc.item.product_name }}</h4>
              <div class="pp-offer-prices">
                <span
                  *ngIf="oc.discountPct > 0"
                  class="pp-offer-price-old"
                >{{ oc.originalPrice | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                <span class="pp-offer-price-new">
                  {{ oc.finalPrice | currency:'MXN':'symbol-narrow':'1.2-2' }}
                </span>
              </div>
              <p class="pp-offer-promo-name" *ngIf="oc.promo.ends_at">
                <i class="pi pi-calendar" aria-hidden="true"></i>
                Hasta {{ oc.promo.ends_at | date:'dd MMM' }}
              </p>
            </div>

            <!-- Footer: stepper + agregar -->
            <div class="pp-offer-actions">
              <div class="pp-offer-stepper" role="group" [attr.aria-label]="'Cantidad de ' + oc.item.product_name">
                <button
                  type="button"
                  class="pp-offer-step"
                  (click)="changeQty(oc, -1); $event.stopPropagation()"
                  [disabled]="oc.qty <= 1"
                  [attr.aria-label]="'Disminuir cantidad'"
                >−</button>
                <span class="pp-offer-qty">{{ oc.qty }}</span>
                <button
                  type="button"
                  class="pp-offer-step"
                  (click)="changeQty(oc, 1); $event.stopPropagation()"
                  [attr.aria-label]="'Aumentar cantidad'"
                >+</button>
              </div>
              <button
                type="button"
                class="portal-btn-primary pp-offer-add"
                [disabled]="isAdmin() || adding()[oc.promo.id]"
                (click)="addOffer(oc); $event.stopPropagation()"
                [pTooltip]="isAdmin() ? 'Vista admin — solo lectura' : ''"
              >
                <i [class]="adding()[oc.promo.id] ? 'pi pi-spin pi-spinner' : 'pi pi-plus'" aria-hidden="true"></i>
                Agregar
              </button>
            </div>
          </article>
        </div>
      </section>

      <!-- Tipos sin productos resolvibles (basket %) — listado mini -->
      <section *ngIf="basketPromos().length > 0" class="pp-basket-section" aria-label="Descuentos sobre canasta">
        <header class="portal-section-head">
          <h2><i class="pi pi-shopping-bag" aria-hidden="true"></i>Descuentos sobre canasta</h2>
        </header>
        <div class="pp-basket-grid">
          <article
            *ngFor="let p of basketPromos(); trackBy: trackByPromo"
            class="pp-basket-card"
          >
            <span class="pp-basket-icon" aria-hidden="true">
              <i [class]="p.icon"></i>
            </span>
            <div class="pp-basket-body">
              <span class="pp-basket-type">{{ p.badge }}</span>
              <h3 class="pp-basket-name">{{ p.name }}</h3>
              <p class="pp-basket-desc" *ngIf="p.description">{{ p.description }}</p>
              <p class="pp-basket-info">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Se aplica automáticamente al confirmar el pedido.
              </p>
            </div>
          </article>
        </div>
      </section>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; max-width: 1200px; margin: 0 auto; }

      /* ── SEARCH BAR ────────────────────────────────────────────── */
      .pp-search {
        position: relative;
        display: flex;
        align-items: center;
        background: var(--card-bg);
        border: 1.5px solid var(--border-color);
        border-radius: 10px;
        padding: 0 0.75rem;
        margin-bottom: 1rem;
        max-width: 640px;
        transition: border-color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard);
      }
      .pp-search:focus-within {
        border-color: var(--neutral-700);
        box-shadow: 0 0 0 3px rgba(253, 231, 7, 0.16);
      }
      .pp-search-icon {
        color: var(--text-faint);
        font-size: 1rem;
        flex-shrink: 0;
      }
      .pp-search input {
        flex: 1;
        border: none;
        background: transparent;
        outline: none;
        padding: 0.75rem;
        font-size: 0.9375rem;
        color: var(--text-main);
        min-width: 0;
      }
      .pp-search input::placeholder { color: var(--text-faint); }
      .pp-search-clear {
        background: var(--neutral-100);
        border: none;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        color: var(--text-muted);
        cursor: pointer;
        display: grid;
        place-items: center;
      }
      .pp-search-clear:hover { background: var(--neutral-200); color: var(--text-main); }

      /* ── CHIP RAIL (filtros por tipo) ──────────────────────────── */
      .pp-chip-rail {
        display: flex;
        gap: 0.5rem;
        overflow-x: auto;
        scrollbar-width: none;
        padding-bottom: 0.5rem;
        margin-bottom: 1.25rem;
      }
      .pp-chip-rail::-webkit-scrollbar { display: none; }
      .pp-chip {
        flex-shrink: 0;
        background: var(--card-bg);
        border: 1.5px solid var(--border-color);
        border-radius: 999px;
        padding: 0.45rem 1rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        white-space: nowrap;
        transition: all 150ms var(--ease-standard);
      }
      .pp-chip:hover { border-color: var(--neutral-400); color: var(--text-main); }
      .pp-chip.active {
        background: var(--neutral-900);
        border-color: var(--neutral-900);
        color: #fff;
      }
      .pp-chip-count {
        background: var(--neutral-100);
        color: var(--text-muted);
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        font-variant-numeric: tabular-nums;
      }
      .pp-chip.active .pp-chip-count {
        background: rgba(255,255,255,0.22);
        color: #fff;
      }

      /* ── BANNER DE MARKETING (arte propio de la promo) ────────── */
      .pp-banner {
        display: block;
        width: 100%;
        margin-bottom: 1.5rem;
        border-radius: 16px;
        overflow: hidden;
        cursor: pointer;
        border: 1px solid var(--border-color);
        transition: transform 200ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .pp-banner:hover {
        transform: translateY(-2px);
        box-shadow: 0 14px 30px -14px rgba(0, 0, 0, 0.22);
      }
      .pp-banner:focus-visible {
        outline: 2px solid var(--action, var(--brand-500));
        outline-offset: 2px;
      }
      .pp-banner-img { display: block; width: 100%; height: auto; }

      /* ── BENTO GRID HERO ──────────────────────────────────────── */
      .pp-bento {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.875rem;
        margin-bottom: 2rem;
      }
      @media (min-width: 768px) {
        .pp-bento {
          grid-template-columns: 2fr 1fr;
          grid-template-rows: 1fr 1fr;
          grid-template-areas:
            "main side1"
            "main side2";
          min-height: 420px;
        }
        .pp-bento-main { grid-area: main; }
        .pp-bento-side:nth-of-type(2) { grid-area: side1; }
        .pp-bento-side:nth-of-type(3) { grid-area: side2; }
      }

      /* Main featured: dark + brand-400 accent (identidad Mega Dulces) */
      .pp-bento-main {
        position: relative;
        overflow: hidden;
        background: linear-gradient(135deg, var(--neutral-950) 0%, var(--neutral-900) 100%);
        border: 1px solid var(--neutral-900);
        border-radius: 14px;
        padding: 1.75rem;
        color: #fff;
        min-height: 240px;
        cursor: pointer;
        transition: transform 200ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
        box-shadow: 0 12px 28px -10px rgba(0, 0, 0, 0.35);
      }
      .pp-bento-main:hover { transform: translateY(-2px); }
      .pp-bento-main:focus-visible {
        outline: 2px solid var(--brand-400);
        outline-offset: 2px;
      }
      .pp-bento-main-bg {
        position: absolute;
        right: -3rem;
        top: -3rem;
        width: 280px;
        height: 280px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(253, 231, 7, 0.18), transparent 70%);
        display: grid;
        place-items: center;
        pointer-events: none;
      }
      .pp-bento-main-ico {
        font-size: 8rem;
        color: rgba(253, 231, 7, 0.12);
      }
      .pp-bento-main-content {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        height: 100%;
        max-width: 70%;
      }
      .pp-bento-tag {
        display: inline-block;
        align-self: flex-start;
        background: var(--brand-400);
        color: var(--neutral-950);
        font-size: 0.7rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 0.3rem 0.75rem;
        border-radius: 6px;
        margin-bottom: 0.875rem;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
      }
      .pp-bento-main-title {
        font-size: clamp(1.5rem, 5vw, 2.75rem);
        font-weight: 800;
        margin: 0 0 0.5rem;
        letter-spacing: -0.025em;
        line-height: 1.05;
      }
      .pp-bento-main-desc {
        font-size: 0.9375rem;
        opacity: 0.9;
        margin: 0;
        max-width: 100%;
        line-height: 1.45;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pp-bento-main-cta {
        margin-top: auto;
        padding-top: 1rem;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.8125rem;
        font-weight: 700;
        color: var(--brand-400);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .pp-bento-main-cta i { font-size: 0.75rem; transition: transform 200ms var(--ease-standard); }
      .pp-bento-main:hover .pp-bento-main-cta i { transform: translateX(3px); }
      .pp-bento-disabled { opacity: 0.85; }

      /* Side banners */
      .pp-bento-side {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        padding: 1.25rem 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        cursor: pointer;
        position: relative;
        overflow: hidden;
        transition: border-color 150ms var(--ease-standard), transform 200ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .pp-bento-side:hover {
        border-color: var(--neutral-300);
        transform: translateY(-2px);
        box-shadow: 0 8px 18px -8px rgba(0, 0, 0, 0.10);
      }
      .pp-bento-side:focus-visible {
        outline: 2px solid var(--brand-500);
        outline-offset: 2px;
      }
      .pp-bento-side-icon {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        background: var(--neutral-100);
        color: var(--text-main);
        display: grid;
        place-items: center;
        font-size: 1.25rem;
        margin-bottom: 0.25rem;
      }
      .pp-bento-side-title {
        font-size: 1.125rem;
        font-weight: 800;
        color: var(--text-main);
        margin: 0;
        letter-spacing: -0.01em;
        line-height: 1.25;
      }
      .pp-bento-side-sub {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin: 0;
      }
      .pp-bento-side-cta {
        margin-top: auto;
        padding-top: 0.5rem;
        font-size: 0.8125rem;
        font-weight: 700;
        color: var(--text-main);
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        transition: gap 180ms var(--ease-standard);
      }
      .pp-bento-side:hover .pp-bento-side-cta { gap: 0.5rem; }
      .pp-bento-side-cta i { color: var(--brand-700); font-size: 0.75rem; }

      /* Accent variant (Ventas Flash) */
      .pp-bento-side-accent {
        background: var(--neutral-100);
        border-color: var(--border-color);
      }
      .pp-bento-side-flash {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.25rem;
      }
      .pp-bento-flash-icon {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--neutral-950);
        color: var(--brand-400);
        display: grid;
        place-items: center;
        font-size: 0.85rem;
      }
      .pp-bento-flash-label {
        font-size: 0.7rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-main);
      }

      /* ── OFFERS GRID ──────────────────────────────────────────── */
      .pp-offers { margin-bottom: 2rem; }
      .pp-offers-grid {
        display: grid;
        gap: 0.875rem;
        grid-template-columns: repeat(2, 1fr);
      }
      @media (min-width: 640px) {
        .pp-offers-grid { grid-template-columns: repeat(3, 1fr); }
      }
      @media (min-width: 960px) {
        .pp-offers-grid { grid-template-columns: repeat(4, 1fr); }
      }

      .pp-offer {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        padding: 0.875rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        transition: border-color 150ms var(--ease-standard), transform 200ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .pp-offer:hover {
        border-color: var(--neutral-300);
        transform: translateY(-2px);
        box-shadow: 0 12px 24px -10px rgba(0, 0, 0, 0.10);
      }

      .pp-offer-cover {
        position: relative;
        aspect-ratio: 1;
        background: var(--neutral-100);
        border-radius: 10px;
        overflow: hidden;
        display: grid;
        place-items: center;
      }
      .pp-offer-discount {
        position: absolute;
        top: 0.5rem;
        left: 0.5rem;
        background: var(--brand-400);
        color: var(--neutral-950);
        font-size: 0.7rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        padding: 0.2rem 0.45rem;
        border-radius: 4px;
        z-index: 1;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.10);
      }
      .pp-offer-cover-avatar {
        width: 64%;
        aspect-ratio: 1;
        border-radius: 50%;
        color: #fff;
        display: grid;
        place-items: center;
        font-size: 1.5rem;
        font-weight: 800;
        letter-spacing: 0.02em;
        box-shadow: inset 0 -6px 14px rgba(0, 0, 0, 0.12);
      }

      .pp-offer-body {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        flex: 1;
        min-width: 0;
      }
      .pp-offer-brand {
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
      }
      .pp-offer-name {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-main);
        margin: 0;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pp-offer-prices {
        display: flex;
        flex-direction: column;
        gap: 0.05rem;
        margin-top: auto;
        padding-top: 0.4rem;
      }
      .pp-offer-price-old {
        font-size: 0.75rem;
        color: var(--text-faint);
        text-decoration: line-through;
        font-variant-numeric: tabular-nums;
      }
      .pp-offer-price-new {
        font-size: 1.125rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .pp-offer-promo-name {
        font-size: 0.7rem;
        color: var(--text-muted);
        margin: 0.25rem 0 0;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }

      .pp-offer-actions {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .pp-offer-stepper {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border: 1.5px solid var(--border-color);
        border-radius: 10px;
        height: 44px;
        overflow: hidden;
        background: var(--card-bg);
      }
      .pp-offer-step {
        width: 44px;
        height: 100%;
        border: none;
        background: transparent;
        color: var(--text-main);
        font-weight: 700;
        font-size: 1rem;
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: background-color 120ms var(--ease-standard);
      }
      .pp-offer-step:hover:not(:disabled) { background: var(--neutral-100); }
      .pp-offer-step:disabled { opacity: 0.4; cursor: not-allowed; }
      .pp-offer-qty {
        flex: 1;
        text-align: center;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--text-main);
        font-size: 0.875rem;
      }
      .pp-offer-add {
        width: 100%;
        padding: 0 0.75rem;
        font-size: 0.8125rem;
      }

      /* ── BASKET PROMOS section (% sobre canasta) ──────────────── */
      .pp-basket-section { margin-bottom: 2rem; }
      .pp-basket-grid {
        display: grid;
        gap: 0.875rem;
        grid-template-columns: 1fr;
      }
      @media (min-width: 640px) {
        .pp-basket-grid { grid-template-columns: repeat(2, 1fr); }
      }

      .pp-basket-card {
        display: grid;
        grid-template-columns: 48px 1fr;
        gap: 0.875rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-left: 3px solid var(--brand-500);
        border-radius: 14px;
        padding: 1rem 1.125rem;
        transition: border-color 150ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .pp-basket-card:hover {
        border-color: var(--neutral-300);
        box-shadow: 0 8px 18px -8px rgba(0, 0, 0, 0.08);
      }
      .pp-basket-icon {
        width: 48px;
        height: 48px;
        border-radius: 12px;
        background: var(--neutral-100);
        color: var(--text-main);
        display: grid;
        place-items: center;
        font-size: 1.25rem;
        flex-shrink: 0;
      }
      .pp-basket-body {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
      }
      .pp-basket-type {
        font-size: 0.65rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
      }
      .pp-basket-name {
        font-size: 1rem;
        font-weight: 800;
        color: var(--text-main);
        margin: 0;
        line-height: 1.25;
        letter-spacing: -0.01em;
      }
      .pp-basket-desc {
        font-size: 0.8125rem;
        color: var(--text-muted);
        margin: 0;
        line-height: 1.4;
      }
      .pp-basket-info {
        font-size: 0.75rem;
        color: var(--text-faint);
        margin: 0.25rem 0 0;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }

      @media (prefers-reduced-motion: reduce) {
        .pp-bento-main,
        .pp-bento-side,
        .pp-offer { transition-duration: 0.01ms !important; transform: none !important; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalPromotionsComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly isAdmin = signal<boolean>(this.auth.user()?.role_name === 'superadmin');
  readonly loading = signal(true);
  readonly promos = signal<PromoWithItems[]>([]);
  readonly adding = signal<Record<string, boolean>>({});
  readonly filter = signal<FilterKey>('all');
  readonly searchSignal = signal<string>('');

  searchTerm = '';
  private searchDebounce: any = null;

  private customerId = '';
  private warehouseId = '';

  private avatarPalette = [
    '#3F3F46', '#52525B', '#71717A', '#27272A',
    '#404040', '#525252', '#262626', '#171717',
  ];

  readonly filteredPromos = computed(() => {
    const f = this.filter();
    const q = this.searchSignal().trim().toLowerCase();
    return this.promos().filter((p) => {
      if (f !== 'all' && p.promotion_type !== f) return false;
      if (q && !p.name.toLowerCase().includes(q) && !(p.description || '').toLowerCase().includes(q) && !p.code.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  readonly featuredPromo = computed(() => this.filteredPromos()[0] || null);
  /** Primera promo con arte de marketing propio (banner_url) → hero full-width. */
  readonly bannerPromo = computed(() => this.filteredPromos().find((p) => !!p.banner_url) || null);
  readonly secondaryPromos = computed(() => this.filteredPromos().slice(1, 3));
  readonly basketPromos = computed(() =>
    this.filteredPromos().filter((p) => p.promotion_type === 'percent_off_basket' && p !== this.featuredPromo() && !this.secondaryPromos().includes(p))
  );

  /** Aplana resolvedItems de todas las promos visibles (a partir de la 3ra) en cards de oferta. */
  readonly offerCards = computed<OfferCard[]>(() => {
    const skip = new Set<PromoWithItems>([this.featuredPromo() as any, ...this.secondaryPromos()]);
    const out: OfferCard[] = [];
    for (const p of this.filteredPromos()) {
      if (skip.has(p)) continue;
      if (p.promotion_type === 'percent_off_basket') continue;
      for (const it of p.resolvedItems) {
        const { discountPct, finalPrice } = this.computeDiscount(p, it);
        out.push({
          promo: p,
          item: it,
          discountPct,
          originalPrice: it.price,
          finalPrice,
          qty: it.qty || 1,
        });
      }
    }
    return out;
  });

  readonly filters: { key: FilterKey; label: string; count: number }[] = [];

  ngOnInit(): void {
    this.loading.set(true);
    forkJoin({
      promos: this.api.listActivePromotions(50),
      customer: this.api.myCustomerInfo(),
      warehouses: this.api.listWarehouses(),
      priceLists: this.api.listPriceLists(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ promos, customer, warehouses, priceLists }) => {
          if (customer) this.customerId = customer.id;
          const wh = warehouses.find((w: any) => w.is_default) || warehouses[0];
          this.warehouseId = wh?.id || '';

          const pl = customer?.default_price_list_id
            ? priceLists.find((x: any) => x.id === customer.default_price_list_id)
            : priceLists.find((x: any) => x.is_default) || priceLists[0];

          const finalize = (enriched: PromoWithItems[]) => {
            this.promos.set(enriched);
            this.rebuildFilters(enriched);
            this.loading.set(false);
          };

          if (!pl) {
            finalize(promos.map((p) => this.enrichPromo(p, new Map())));
            return;
          }
          this.api.listPricesForList(pl.id, this.warehouseId || undefined).subscribe({
            next: (rows) => {
              const priceMap = new Map<string, PriceRow>();
              for (const r of rows) priceMap.set(r.product_id, r);
              finalize(promos.map((p) => this.enrichPromo(p, priceMap)));
            },
            error: () => finalize(promos.map((p) => this.enrichPromo(p, new Map()))),
          });
        },
        error: () => this.loading.set(false),
      });
  }

  private rebuildFilters(promos: PromoWithItems[]): void {
    const base: FilterKey[] = ['all', 'percent_off_product', 'percent_off_basket', 'nxm', 'volume_discount', 'bundle_fixed_price', 'cross_sell_discount'];
    const out: { key: FilterKey; label: string; count: number }[] = [];
    for (const k of base) {
      if (k === 'all') {
        out.push({ key: k, label: 'Todos', count: promos.length });
        continue;
      }
      const count = promos.filter((p) => p.promotion_type === k).length;
      if (count > 0) out.push({ key: k, label: TYPE_SHORT[k] || k, count });
    }
    this.filters.length = 0;
    this.filters.push(...out);
  }

  private enrichPromo(p: PromotionRow, priceMap: Map<string, PriceRow>): PromoWithItems {
    const rules: any = (p as any).rules || {};
    const items: ResolvedItem[] = [];

    const push = (pid: string | undefined, qty: number) => {
      if (!pid) return;
      const pr = priceMap.get(pid);
      if (!pr) return;
      items.push({
        product_id: pid,
        product_name: pr.product_name,
        brand_name: pr.brand_name || null,
        qty,
        price: Number(pr.price) || 0,
      });
    };

    switch (p.promotion_type) {
      case 'percent_off_product': push(rules.product_id, 1); break;
      case 'nxm': push(rules.product_id, Number(rules.n_buy) || 1); break;
      case 'volume_discount': {
        const minQty = Array.isArray(rules.tiers) && rules.tiers[0]?.min_qty ? Number(rules.tiers[0].min_qty) : 1;
        push(rules.product_id, minQty);
        break;
      }
      case 'bundle_fixed_price':
        if (Array.isArray(rules.items)) {
          for (const it of rules.items) push(it.product_id, Number(it.quantity) || 1);
        }
        break;
      case 'cross_sell_discount':
        push(rules.trigger_product_id, 1);
        push(rules.target_product_id, 1);
        break;
      default: break;
    }

    return {
      ...p,
      resolvedItems: items,
      addable: items.length > 0,
      badge: TYPE_LABELS[p.promotion_type] || p.promotion_type,
      shortBadge: TYPE_SHORT[p.promotion_type] || p.promotion_type,
      icon: TYPE_ICONS[p.promotion_type] || 'pi pi-tag',
    };
  }

  /** Calcula descuento aproximado para mostrar en cards (no es el cálculo final del backend). */
  private computeDiscount(p: PromoWithItems, it: ResolvedItem): { discountPct: number; finalPrice: number } {
    const rules: any = (p as any).rules || {};
    if (p.promotion_type === 'percent_off_product') {
      const pct = Number(rules.percent || rules.percent_off) || 0;
      return { discountPct: Math.round(pct), finalPrice: it.price * (1 - pct / 100) };
    }
    if (p.promotion_type === 'volume_discount') {
      const tier = Array.isArray(rules.tiers) ? rules.tiers[0] : null;
      const pct = tier ? Number(tier.percent || 0) : 0;
      return { discountPct: Math.round(pct), finalPrice: it.price * (1 - pct / 100) };
    }
    if (p.promotion_type === 'nxm') {
      const n = Number(rules.n_buy) || 1;
      const m = Number(rules.m_pay) || 1;
      const pct = n > 0 ? Math.round(((n - m) / n) * 100) : 0;
      return { discountPct: pct, finalPrice: it.price * (m / n) };
    }
    return { discountPct: 0, finalPrice: it.price };
  }

  trackByFilter = (_i: number, f: { key: FilterKey }) => f.key;
  trackByPromo = (_i: number, p: PromoWithItems) => p.id;
  trackByOffer = (_i: number, oc: OfferCard) => `${oc.promo.id}::${oc.item.product_id}`;

  setFilter(f: FilterKey): void {
    this.filter.set(f);
  }
  resetFilters(): void {
    this.filter.set('all');
    this.searchTerm = '';
    this.searchSignal.set('');
  }
  onSearchChange(v: string): void {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.searchSignal.set(v || ''), 200);
  }
  clearSearch(): void {
    this.searchTerm = '';
    this.searchSignal.set('');
  }

  changeQty(oc: OfferCard, delta: number): void {
    const next = Math.max(1, (oc.qty || 1) + delta);
    oc.qty = next;
  }

  onBentoClick(p: PromoWithItems): void {
    if (this.isAdmin()) {
      this.toast.add({ severity: 'info', summary: 'Vista admin', detail: 'Solo lectura.' });
      return;
    }
    if (!p.addable && p.promotion_type !== 'percent_off_basket') return;
    this.confirmAdd(p);
  }

  confirmAdd(p: PromoWithItems): void {
    if (this.isAdmin()) return;
    if (!p.addable) {
      this.toast.add({ severity: 'info', summary: p.name, detail: 'Esta promo se aplica al confirmar el pedido.' });
      return;
    }
    const total = p.resolvedItems.reduce((acc, it) => acc + it.qty * it.price, 0);
    this.confirmSvc.confirm({
      header: `Agregar "${p.name}"`,
      message: `Se agregarán ${p.resolvedItems.length} producto(s) al carrito (≈ $${total.toFixed(2)} antes del descuento).`,
      icon: 'pi pi-shopping-cart',
      acceptLabel: 'Agregar',
      rejectLabel: 'Cancelar',
      accept: () => this.addPromo(p, p.resolvedItems.map((it) => ({ product_id: it.product_id, qty: it.qty }))),
    });
  }

  addOffer(oc: OfferCard): void {
    if (this.isAdmin()) {
      this.toast.add({ severity: 'info', summary: 'Vista admin', detail: 'Solo lectura.' });
      return;
    }
    this.addPromo(oc.promo, [{ product_id: oc.item.product_id, qty: oc.qty }]);
  }

  private addPromo(p: PromoWithItems, lines: { product_id: string; qty: number }[]): void {
    if (!this.customerId || !this.warehouseId) {
      this.toast.add({ severity: 'error', summary: 'Sin customer', detail: 'No hay cliente linkeado o almacén default.' });
      return;
    }
    this.adding.update((a) => ({ ...a, [p.id]: true }));
    this.api.ensureDraft(this.customerId, this.warehouseId).subscribe({
      next: (draft) => {
        const batch = lines.map((ln) => ({
          product_id: ln.product_id,
          quantity: ln.qty,
        }));
        this.api.addLinesBatch(draft.id, batch).subscribe({
          next: (results) => {
            const added = results.filter((r) => r.ok).length;
            const failed = results.length - added;
            this.finish(p, added, failed);
          },
          error: (e) => {
            this.adding.update((a) => ({ ...a, [p.id]: false }));
            this.toast.add({ severity: 'error', summary: 'Error al agregar', detail: e?.error?.message || e?.message });
          },
        });
      },
      error: (e) => {
        this.adding.update((a) => ({ ...a, [p.id]: false }));
        this.toast.add({ severity: 'error', summary: 'Error draft', detail: e.error?.message || e.message });
      },
    });
  }

  private finish(p: PromoWithItems, added: number, failed: number): void {
    this.adding.update((a) => ({ ...a, [p.id]: false }));
    this.toast.add({
      severity: failed === 0 ? 'success' : 'warn',
      summary: failed === 0 ? '¡Agregado al carrito!' : 'Parcial',
      detail: failed === 0
        ? `${added} producto(s) en el carrito. El descuento se aplica al confirmar.`
        : `${added} agregados, ${failed} fallaron.`,
    });
  }

  goCatalog(): void {
    this.router.navigateByUrl('/portal/catalog');
  }

  heroTitleFor(p: PromoWithItems): string {
    const rules: any = (p as any).rules || {};
    if (p.promotion_type === 'percent_off_product' || p.promotion_type === 'percent_off_basket') {
      const pct = Number(rules.percent || rules.percent_off) || 0;
      if (pct > 0) return `${Math.round(pct)}% OFF`;
    }
    if (p.promotion_type === 'nxm') {
      const n = rules.n_buy || '?';
      const m = rules.m_pay || '?';
      return `${n}×${m}`;
    }
    if (p.promotion_type === 'volume_discount') {
      const tier = Array.isArray(rules.tiers) ? rules.tiers[0] : null;
      if (tier?.percent) return `−${Math.round(Number(tier.percent))}%`;
    }
    return p.name;
  }

  heroDescFor(p: PromoWithItems): string {
    if (p.description) return p.description;
    return p.name;
  }

  avatarInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]).join('').toUpperCase();
  }
  avatarColor(key: string): string {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return this.avatarPalette[Math.abs(h) % this.avatarPalette.length];
  }
}
