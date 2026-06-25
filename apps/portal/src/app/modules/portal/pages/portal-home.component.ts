import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe, CurrencyPipe } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { switchMap } from 'rxjs/operators';
import { forkJoin } from 'rxjs';
import { PortalService, Order, PromotionRow, CatalogHistoryRow, CatalogFacets, CatalogSuggestedRow, PriceRow } from '../portal.service';
import { AuthService } from '../../../core/services/auth.service';
import { HapticService } from '../../../core/services/haptic.service';
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { ProductsOfMonthCarouselComponent } from '../ui/products-of-month-carousel.component';
import { BrandsCarouselComponent } from '../ui/brands-carousel.component';
import { FeaturedPromoComponent } from '../ui/featured-promo.component';
import { PromosCarouselComponent } from '../ui/promos-carousel.component';
import { TopProductsComponent } from '../ui/top-products.component';
import { ProductSheetComponent } from '../ui/product-sheet.component';
import { MX_TRENDS } from '../data/mx-market-trends';
import { CartFxService } from '../cart-fx.service';

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
    SkeletonModule,
    ProductsOfMonthCarouselComponent,
    BrandsCarouselComponent,
    FeaturedPromoComponent,
    PromosCarouselComponent,
    TopProductsComponent,
    ProductSheetComponent,
  ],
  template: `
    <!-- [1] LIVE STATUS RIBBON — greeting + ongoing en una línea -->
    <div class="ph-ribbon">
      <div class="ph-ribbon-greet">
        <span class="ph-ribbon-dot" [class.is-live]="!!ongoingOrder()" aria-hidden="true"></span>
        <span class="ph-ribbon-text">
          <span class="ph-ribbon-prefix">{{ greetingPrefix() }},</span>
          <strong>{{ username() || 'cliente' }}</strong>
        </span>
      </div>
      <a *ngIf="ongoingOrder() as oo" class="ph-ribbon-live" [routerLink]="['/portal/orders', oo.id]">
        <span class="ph-ribbon-live-text">{{ ongoingBannerCopy().title }}</span>
        <i class="pi pi-arrow-right" aria-hidden="true"></i>
      </a>
    </div>

    <!-- [REABASTECIMIENTO PREDICTIVO] recurrentes que llevan tiempo sin pedirse -->
    <section *ngIf="restockProducts().length > 0" class="ph-section ph-restock ph-reveal">
      <header class="ph-section-head">
        <h2>Hora de reabastecer</h2>
      </header>
      <div class="ph-restock-strip" role="list">
        <article
          *ngFor="let p of restockProducts(); trackBy: trackByProduct"
          class="ph-restock-card"
          role="listitem"
          (click)="openMonthly(p)"
        >
          <div
            class="ph-restock-media"
            [class.is-ph]="!hasImg(p)"
            [style.background]="hasImg(p) ? null : phStyle(p)"
          >
            <img *ngIf="hasImg(p)" [src]="p.image_url" [alt]="p.product_name" loading="lazy" decoding="async" (error)="onImgError(p)" />
            <span *ngIf="!hasImg(p)" class="ph-restock-initials">{{ initials(p) }}</span>
          </div>
          <div class="ph-restock-body">
            <span class="ph-restock-name" [title]="p.product_name">{{ p.product_name }}</span>
            <span class="ph-restock-ago">
              <i class="pi pi-history" aria-hidden="true"></i>
              hace {{ daysSince(p.last_ordered_at) }} días
            </span>
          </div>
          <button
            type="button"
            class="ph-restock-add"
            [class.is-added]="addedIds().has(p.product_id)"
            [disabled]="addingId() === p.product_id"
            (click)="$event.stopPropagation(); reorderAdd(p, $event)"
            [attr.aria-label]="'Reordenar ' + p.product_name"
          >
            <i *ngIf="addingId() === p.product_id" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
            <i *ngIf="addingId() !== p.product_id && addedIds().has(p.product_id)" class="pi pi-check" aria-hidden="true"></i>
            <i *ngIf="addingId() !== p.product_id && !addedIds().has(p.product_id)" class="pi pi-refresh" aria-hidden="true"></i>
          </button>
        </article>
      </div>
    </section>

    <!-- [REORDEN-PRIMERO] "Comprar de nuevo" sube al primer pliegue, sobre el
         hero (Baymard: el cliente B2B es transaccional, no exploratorio). -->
    <section *ngIf="frequentProducts().length > 0" class="ph-section ph-section-reorder ph-reveal">
      <header class="ph-section-head">
        <h2>Comprar de nuevo</h2>
        <a routerLink="/portal/catalog" class="ph-section-link">Ver catálogo →</a>
      </header>
      <div class="ph-reorder-strip" role="list">
        <article *ngFor="let p of frequentProducts(); trackBy: trackByProduct" class="ph-reorder-card" role="listitem">
          <div
            class="ph-reorder-media"
            [class.is-ph]="!hasImg(p)"
            [style.background]="hasImg(p) ? null : phStyle(p)"
          >
            <img *ngIf="hasImg(p)" [src]="p.image_url" [alt]="p.product_name" loading="lazy" decoding="async" (error)="onImgError(p)" />
            <span *ngIf="!hasImg(p)" class="ph-reorder-initials">{{ initials(p) }}</span>
            <span *ngIf="p.times_ordered > 1" class="ph-reorder-freq">{{ p.times_ordered }}×</span>
          </div>
          <div class="ph-reorder-body">
            <span class="ph-reorder-brand">{{ p.brand_name || 'Sin marca' }}</span>
            <span class="ph-reorder-name" [title]="p.product_name">{{ p.product_name }}</span>
            <span class="ph-reorder-price">{{ +(p.price || 0) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
          </div>
          <button
            type="button"
            class="ph-reorder-add"
            [class.is-added]="addedIds().has(p.product_id)"
            [disabled]="addingId() === p.product_id"
            (click)="reorderAdd(p, $event)"
            [attr.aria-label]="'Agregar ' + p.product_name"
          >
            <i *ngIf="addingId() === p.product_id" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
            <i *ngIf="addingId() !== p.product_id && addedIds().has(p.product_id)" class="pi pi-check" aria-hidden="true"></i>
            <i *ngIf="addingId() !== p.product_id && !addedIds().has(p.product_id)" class="pi pi-plus" aria-hidden="true"></i>
            {{ addedIds().has(p.product_id) ? 'Agregado' : 'Agregar' }}
          </button>
        </article>
      </div>
    </section>

    <!-- [MARCAS TOP] marquee auto-scroll (GSAP) — incita a explorar por marca -->
    <portal-brands-carousel [brands]="topBrands()"></portal-brands-carousel>

    <!-- [1.5] BANNER DE MARKETING (arte propio de una promo activa) -->
    <a
      *ngIf="bannerPromo() as bp"
      class="ph-banner ph-reveal"
      routerLink="/portal/promotions"
      [attr.aria-label]="'Ver promoción: ' + bp.name"
    >
      <img [src]="bp.banner_url" [alt]="bp.name" class="ph-banner-img" />
    </a>

    <!-- [PROMO DESTACADA] "Escaparate vivo" — productos Nutresa que rotan -->
    <portal-featured-promo
      [images]="['/assets/brands/nucita.webp', '/assets/brands/creminobi4.png']"
    ></portal-featured-promo>

    <!-- [2] HERO EDITORIAL — desactivado: lo reemplaza la promo destacada de arriba.
         Se conserva como fallback genérico (catálogo) por si se reactiva. -->
    <section
      *ngIf="false"
      class="ph-hero"
      [class.ph-hero-promo]="!loadingPromos() && featuredPromo()"
      role="region"
      aria-label="Bienvenida"
      (click)="onHeroClick()"
    >
      <div class="ph-hero-text">
        <span class="ph-hero-eyebrow">
          @if (featuredPromo()) {
            <i class="pi pi-bolt" aria-hidden="true"></i>
            Promo destacada
          } @else {
            Catálogo Mega Dulces
          }
        </span>
        <h1 class="ph-hero-h1">
          @if (featuredPromo()) {
            Aprovecha la promo<br>del mes.
          } @else {
            Reabastece tu tienda<br>en minutos.
          }
        </h1>
        @if (featuredPromo(); as fp) {
          <div class="ph-hero-promo-name">{{ titleCase(fp.name) }}</div>
        }
        <p class="ph-hero-lead">
          @if (featuredPromo()?.description) {
            {{ featuredPromo()!.description }}
          } @else {
            Más de 500 SKUs de dulces, chocolates y snacks listos para tu próximo pedido.
          }
        </p>
        <div class="ph-hero-actions">
          <button type="button" class="portal-btn-hero portal-btn-pill" (click)="goCatalog(); $event.stopPropagation()">
            <i class="pi pi-shopping-cart" aria-hidden="true"></i>
            Ver catálogo
          </button>
          <button *ngIf="featuredPromo()" type="button" class="portal-btn-ghost portal-btn-pill ph-btn-ghost" (click)="goPromos(); $event.stopPropagation()">
            Ver promo
            <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <!-- Ilustración SVG propia (sin fotos reales) -->
      <div class="ph-hero-illust" aria-hidden="true">
        <svg viewBox="0 0 280 220" xmlns="http://www.w3.org/2000/svg">
          <!-- background blob warm -->
          <circle cx="200" cy="120" r="110" fill="var(--brand-100)" opacity="0.55"/>
          <!-- sparkle decorativos -->
          <g stroke="var(--brand-700)" stroke-width="2" stroke-linecap="round" fill="none">
            <path d="M50 40 L50 56 M42 48 L58 48"/>
            <path d="M250 180 L250 196 M242 188 L258 188"/>
          </g>
          <circle cx="60" cy="160" r="4" fill="var(--brand-700)"/>
          <circle cx="240" cy="50" r="3" fill="var(--brand-700)"/>

          <!-- caramelo wrapped (envoltura twist a los lados) -->
          <g transform="translate(70, 95) rotate(-12)">
            <path d="M-30 0 L-15 -8 L-12 0 L-15 8 Z" fill="var(--brand-200)"/>
            <path d="M30 0 L15 -8 L12 0 L15 8 Z" fill="var(--brand-200)"/>
            <ellipse cx="0" cy="0" rx="22" ry="14" fill="var(--brand-700)"/>
            <ellipse cx="-6" cy="-4" rx="6" ry="3" fill="var(--brand-400)" opacity="0.6"/>
          </g>

          <!-- paleta (lollipop) -->
          <g transform="translate(170, 110)">
            <rect x="-1.5" y="0" width="3" height="58" fill="var(--neutral-800)" rx="1.5"/>
            <circle cx="0" cy="0" r="32" fill="var(--brand-400)"/>
            <circle cx="0" cy="0" r="32" fill="none" stroke="var(--brand-700)" stroke-width="3" stroke-dasharray="8 6" opacity="0.6"/>
            <circle cx="-8" cy="-8" r="8" fill="var(--brand-100)" opacity="0.7"/>
          </g>

          <!-- bonbon pequeño -->
          <g transform="translate(220, 170)">
            <circle cx="0" cy="0" r="14" fill="var(--brand-600)"/>
            <circle cx="-4" cy="-4" r="4" fill="var(--brand-300)" opacity="0.7"/>
          </g>

          <!-- estrella grande -->
          <path d="M120 30 L125 42 L138 42 L128 50 L132 62 L120 54 L108 62 L112 50 L102 42 L115 42 Z" fill="var(--brand-400)" stroke="var(--brand-700)" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </div>
    </section>

    <!-- [3] SEARCH BAR + chips trending -->
    <button type="button" class="ph-search" (click)="goSearch()" aria-label="Buscar en el catálogo">
      <i class="pi pi-search ph-search-icon" aria-hidden="true"></i>
      <span class="ph-search-placeholder">Buscar 500+ SKUs por nombre, marca, código…</span>
      <span class="ph-search-kbd" aria-hidden="true">⌘K</span>
    </button>
    <nav class="ph-chips" aria-label="Categorías más buscadas">
      <button
        *ngFor="let chip of trendingChips"
        type="button"
        class="ph-chip"
        (click)="goCatalog(chip.slug)"
      >{{ chip.label }}</button>
    </nav>

    <!-- [4] TRUST STRIP — datos operativos B2B -->
    <section class="ph-trust ph-reveal" aria-label="Información de servicio">
      <div class="ph-trust-item">
        <span class="ph-trust-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 3h15v13H1z"/>
            <path d="M16 8h4l3 3v5h-7V8z"/>
            <circle cx="5.5" cy="18.5" r="2.5"/>
            <circle cx="18.5" cy="18.5" r="2.5"/>
          </svg>
        </span>
        <div class="ph-trust-text">
          <strong>Entrega 24-48h</strong>
          <span>Pide hoy, recibe mañana</span>
        </div>
      </div>
      <div class="ph-trust-divider" aria-hidden="true"></div>
      <div class="ph-trust-item">
        <span class="ph-trust-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="6" width="20" height="14" rx="2"/>
            <path d="M2 10h20"/>
            <path d="M6 16h4"/>
          </svg>
        </span>
        <div class="ph-trust-text">
          <strong>Mín. $2,500</strong>
          <span>Sin penalización</span>
        </div>
      </div>
      <div class="ph-trust-divider" aria-hidden="true"></div>
      <div class="ph-trust-item">
        <span class="ph-trust-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/>
          </svg>
        </span>
        <div class="ph-trust-text">
          <strong>+500 SKUs</strong>
          <span>Catálogo completo</span>
        </div>
      </div>
      <div class="ph-trust-divider" aria-hidden="true"></div>
      <div class="ph-trust-item">
        <span class="ph-trust-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 5.7C3 4.76 3.76 4 4.7 4h2.3a1 1 0 0 1 1 .76l1.27 5.08a1 1 0 0 1-.27.96l-2.2 2.2a16 16 0 0 0 6.2 6.2l2.2-2.2a1 1 0 0 1 .96-.27l5.08 1.27a1 1 0 0 1 .76 1V20.3c0 .94-.76 1.7-1.7 1.7C10.6 22 2 13.4 2 5.7z"/>
          </svg>
        </span>
        <div class="ph-trust-text">
          <strong>WhatsApp</strong>
          <span>Soporte directo</span>
        </div>
      </div>
    </section>

    <!-- [SUGERIDOS IA] canasta D.4 con razón por producto -->
    <portal-top-products
      *ngIf="suggestedProducts().length > 0"
      class="ph-suggested"
      [products]="suggestedProducts()"
      [notes]="suggestedNotes()"
      eyebrow="Para ti"
      heading="Sugeridos para ti"
      meta="Según tu historial"
      [showRank]="false"
      [addingId]="addingId()"
      [addedIds]="addedIds()"
      (open)="openMonthly($event)"
      (add)="addMonthly($event)"
    ></portal-top-products>

    <!-- [4.5] PRODUCTOS TOP — tendencia del mercado MX cruzada con el catálogo -->
    <portal-top-products
      *ngIf="trendProducts().length > 0"
      class="ph-toptrends"
      [products]="trendProducts()"
      [notes]="trendNotes()"
      [addingId]="addingId()"
      [addedIds]="addedIds()"
      (open)="openMonthly($event)"
      (add)="addMonthly($event)"
    ></portal-top-products>

    <!-- [PRODUCTOS DEL MES] carrusel top-sellers con capa de motion GSAP -->
    <portal-products-of-month
      *ngIf="monthlyProducts().length > 0"
      [products]="monthlyProducts()"
      [addingId]="addingId()"
      [addedIds]="addedIds()"
      (open)="openMonthly($event)"
      (add)="addMonthly($event)"
    ></portal-products-of-month>

    <!-- [5] PROMOS DEL MES — rail swipeable con capa de motion GSAP -->
    <portal-promos-carousel
      *ngIf="!loadingPromos() && promotions().length > 0"
      [promos]="promotions()"
    ></portal-promos-carousel>

    <div *ngIf="loadingPromos()" class="ph-skel-grid">
      <p-skeleton width="100%" height="200px" borderRadius="20px"></p-skeleton>
    </div>

    <!-- [7] HISTORIAL — últimos 3 pedidos compactos -->
    <section class="ph-section ph-history ph-reveal" *ngIf="!loadingOrders()">
      <header class="ph-section-head">
        <h2>Tu historial</h2>
        <a routerLink="/portal/orders" class="ph-section-link">Ver todos →</a>
      </header>

      <div *ngIf="orders().length === 0" class="ph-empty">
        <h3>Aún no tienes pedidos</h3>
        <p>Explora el catálogo y arma tu primer pedido en minutos.</p>
        <button type="button" class="portal-btn-hero portal-btn-pill" (click)="goCatalog()">
          Explorar catálogo
          <i class="pi pi-arrow-right" aria-hidden="true"></i>
        </button>
      </div>

      <ul *ngIf="orders().length > 0" class="ph-history-list" role="list">
        <li
          *ngFor="let o of orders().slice(0, 3)"
          class="ph-history-row"
          (click)="onOrderAction(o)"
          role="listitem"
          tabindex="0"
          (keydown.enter)="onOrderAction(o)"
        >
          <span class="ph-history-status" [class]="'is-' + o.status">
            <i [class]="statusIcon(o.status)" aria-hidden="true"></i>
          </span>
          <div class="ph-history-info">
            <span class="ph-history-summary">{{ orderSummary(o) }}</span>
            <span class="ph-history-meta">
              <code>{{ o.code }}</code>
              <span class="ph-history-dot" aria-hidden="true">·</span>
              {{ o.created_at | date:'dd MMM' }}
              <span class="ph-history-dot" aria-hidden="true">·</span>
              {{ statusLabel(o.status) }}
            </span>
          </div>
          <span class="ph-history-total">{{ +o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
          <i class="pi pi-chevron-right ph-history-chevron" aria-hidden="true"></i>
        </li>
      </ul>
    </section>

    <div *ngIf="loadingOrders()" class="ph-skel-list">
      <p-skeleton *ngFor="let i of [1,2,3]" width="100%" height="64px" borderRadius="14px"></p-skeleton>
    </div>

    <!-- TOP-SHEET de detalle de producto (baja desde arriba al tocar un card) -->
    <portal-product-sheet
      [product]="sheetProduct()"
      [note]="sheetNoteText()"
      [adding]="addingId() === sheetProduct()?.product_id"
      (close)="closeSheet()"
      (add)="addFromSheet($event)"
    ></portal-product-sheet>

    <!-- [8] FOOTER OPERATIVO -->
    <footer class="ph-foot ph-reveal">
      <div class="ph-foot-item">
        <strong>Soporte</strong>
        <span>Lun-Vie · 8am-7pm</span>
      </div>
      <div class="ph-foot-item">
        <strong>WhatsApp</strong>
        <span>+52 (55) 0000 0000</span>
      </div>
      <div class="ph-foot-item">
        <strong>Mín. pedido</strong>
        <span>$2,500 MXN</span>
      </div>
      <div class="ph-foot-item">
        <strong>Devoluciones</strong>
        <span>Producto dañado únicamente</span>
      </div>
    </footer>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        max-width: 1120px;
        margin: 0 auto;
        font-family: var(--font-body);
      }

      /* ── Jerarquía de vista del home (Opción A: buscar/descubrir primero).
         El orden visual se asigna aquí; ajustar = cambiar el número. ── */
      .ph-ribbon                 { order: 0; }
      .ph-search                 { order: 1; }
      .ph-chips                  { order: 2; }
      portal-brands-carousel     { order: 3; }
      .ph-restock                { order: 4; }
      .ph-section-reorder        { order: 5; }
      portal-top-products.ph-suggested { order: 6; }
      portal-products-of-month   { order: 7; }
      .ph-banner                 { order: 8; }
      portal-featured-promo, .ph-hero { order: 9; }
      portal-promos-carousel, .ph-skel-grid { order: 10; }
      portal-top-products.ph-toptrends { order: 11; }
      .ph-trust                  { order: 12; }
      .ph-history, .ph-skel-list { order: 13; }
      .ph-foot                   { order: 14; }

      /* ── REVEAL POR LOTES (scroll-driven nativo) ────────────────────
         Cada sección entra al cruzar el viewport. CSS scroll-driven corre
         en el compositor (cero JS, ideal mobile). Gateado por @supports +
         prefers-reduced-motion: sin soporte / con motion reducido el
         contenido se muestra normal (nunca queda en opacity:0). ── */
      @supports (animation-timeline: view()) {
        @media (prefers-reduced-motion: no-preference) {
          .ph-reveal {
            animation: phReveal linear both;
            animation-timeline: view();
            animation-range: entry 2% cover 18%;
          }
        }
      }
      @keyframes phReveal {
        from { opacity: 0; transform: translateY(26px); }
        to   { opacity: 1; transform: none; }
      }

      /* ── [1] LIVE STATUS RIBBON ─────────────────────────────────── */
      .ph-ribbon {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.5rem 0;
        margin-bottom: 1.5rem;
        font-size: var(--fs-body);
        flex-wrap: wrap;
      }
      .ph-ribbon-greet {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }
      .ph-ribbon-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--neutral-400);
        flex-shrink: 0;
      }
      .ph-ribbon-dot.is-live {
        background: var(--ok-fg);
        animation: phPulse 2.4s ease-in-out infinite;
      }
      @keyframes phPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.5); }
        50%      { box-shadow: 0 0 0 6px rgba(22, 163, 74, 0); }
      }
      .ph-ribbon-prefix { color: var(--text-muted); }
      .ph-ribbon-text strong { color: var(--text-main); font-weight: 700; margin-left: 0.25rem; }

      .ph-ribbon-live {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        text-decoration: none;
        font-weight: 700;
        color: var(--brand-700);
        background: var(--brand-50);
        border: 1px solid var(--brand-100);
        border-radius: var(--r-pill);
        padding: 0.375rem 0.875rem;
        transition: background 180ms var(--ease-standard), transform 180ms var(--ease-standard);
      }
      .ph-ribbon-live:hover {
        background: var(--brand-700);
        color: #fff;
        transform: translateX(2px);
      }
      .ph-ribbon-live i { font-size: var(--fs-micro); }

      /* ── [1.5] BANNER DE MARKETING ──────────────────────────────── */
      .ph-banner {
        display: block;
        width: 100%;
        margin-bottom: 2rem;
        border-radius: var(--r-xl);
        overflow: hidden;
        border: 1px solid var(--border-color);
        box-shadow: var(--shadow-float);
        cursor: pointer;
        transition: transform 220ms var(--ease-spring), box-shadow 220ms var(--ease-standard);
      }
      .ph-banner:hover {
        transform: translateY(-3px);
        box-shadow: var(--shadow-hover);
      }
      .ph-banner-img { display: block; width: 100%; height: auto; }
      /* Parallax scroll-driven nativo dentro del marco recortado: la imagen
         deriva al scrollear (escala 1.12 para no descubrir bordes). */
      @supports (animation-timeline: view()) {
        @media (prefers-reduced-motion: no-preference) {
          .ph-banner-img {
            transform: scale(1.12);
            animation: phBannerParallax linear both;
            animation-timeline: view();
            animation-range: cover;
          }
        }
      }
      @keyframes phBannerParallax {
        from { transform: translateY(-5%) scale(1.12); }
        to   { transform: translateY(5%) scale(1.12); }
      }

      /* ── [2] HERO EDITORIAL ─────────────────────────────────────── */
      .ph-hero {
        position: relative;
        overflow: hidden;
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 2rem;
        align-items: center;
        padding: 2.5rem 2.5rem 2.5rem;
        margin-bottom: 2.5rem;
        background:
          radial-gradient(ellipse at top right, var(--brand-100) 0%, transparent 60%),
          var(--brand-50);
        border: 1px solid var(--brand-100);
        border-radius: var(--r-2xl);
        cursor: pointer;
        transition: transform 220ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .ph-hero:hover {
        transform: translateY(-2px);
        box-shadow: 0 20px 44px -20px rgba(240, 90, 40, 0.22);
      }
      .ph-hero.ph-hero-promo {
        background:
          radial-gradient(ellipse at top right, rgba(253, 231, 7, 0.45) 0%, transparent 60%),
          linear-gradient(135deg, var(--brand-50) 0%, var(--brand-100) 100%);
      }
      .ph-hero-text { z-index: 1; min-width: 0; }
      .ph-hero-eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: var(--fs-micro);
        font-weight: 800;
        color: var(--brand-700);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 1rem;
      }
      .ph-hero-eyebrow i { font-size: var(--fs-micro); }
      .ph-hero-h1 {
        font-family: var(--font-display);
        font-optical-sizing: auto;
        font-size: var(--text-display-xl);
        font-weight: 800;
        letter-spacing: -0.02em;
        line-height: 1.02;
        margin: 0 0 1rem;
        color: var(--neutral-950);
      }
      .ph-hero-promo-name {
        display: inline-block;
        font-family: var(--font-body);
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--brand-700);
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid var(--brand-100);
        padding: 0.375rem 0.875rem;
        border-radius: var(--r-pill);
        margin: 0 0 1rem;
        letter-spacing: -0.005em;
      }
      .ph-hero-lead {
        font-size: var(--fs-h3);
        line-height: 1.5;
        color: var(--neutral-700);
        margin: 0 0 1.75rem;
        max-width: 36ch;
        font-weight: 500;
      }
      .ph-hero-actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      /* Botones del hero usan los átomos .portal-btn-hero / .portal-btn-ghost
         (ver styles.css). Acá solo la microinteracción del ícono del ghost. */
      .ph-btn-ghost i { font-size: var(--fs-micro); transition: transform 180ms var(--ease-standard); }
      .ph-btn-ghost:hover i { transform: translateX(3px); }

      .ph-hero-illust {
        display: grid;
        place-items: center;
        position: relative;
      }
      .ph-hero-illust svg { width: 100%; max-width: 360px; height: auto; }

      @media (max-width: 720px) {
        .ph-hero {
          grid-template-columns: 1fr;
          padding: 2rem 1.5rem 2.25rem;
          gap: 1rem;
        }
        .ph-hero-illust svg { max-width: 220px; }
      }

      /* ── [3] SEARCH BAR + chips ─────────────────────────────────── */
      .ph-search {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.875rem 1.125rem;
        margin-bottom: 0.75rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-float);
        cursor: pointer;
        font-family: var(--font-body);
        text-align: left;
        transition: transform 200ms var(--ease-spring), border-color 180ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .ph-search:hover {
        border-color: var(--brand-700);
        transform: translateY(-2px);
        box-shadow: var(--shadow-hover);
      }
      .ph-search:active { transform: translateY(0); }
      .ph-search-icon {
        font-size: var(--fs-h3);
        color: var(--brand-700);
        flex-shrink: 0;
      }
      .ph-search-placeholder {
        flex: 1;
        font-size: var(--fs-body);
        font-weight: 500;
        color: var(--text-muted);
      }
      .ph-search-kbd {
        font-family: var(--font-mono);
        font-size: var(--fs-micro);
        font-weight: 700;
        padding: 0.25rem 0.5rem;
        background: var(--neutral-100);
        border: 1px solid var(--neutral-200);
        border-radius: 6px;
        color: var(--text-muted);
      }

      .ph-chips {
        display: flex;
        gap: 0.5rem;
        flex-wrap: nowrap;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        margin-bottom: 2.25rem;
        padding-bottom: 2px;
      }
      .ph-chips::-webkit-scrollbar { display: none; }
      .ph-chip {
        flex: 0 0 auto;
        white-space: nowrap;
        padding: 0.4rem 0.875rem;
        background: transparent;
        border: 1px solid var(--neutral-200);
        border-radius: var(--r-pill);
        font-family: var(--font-body);
        font-size: var(--fs-sm);
        font-weight: 600;
        color: var(--text-main);
        cursor: pointer;
        transition: all 160ms var(--ease-standard);
      }
      .ph-chip:hover {
        background: var(--neutral-950);
        color: #fff;
        border-color: var(--neutral-950);
      }

      /* ── [4] TRUST STRIP ────────────────────────────────────────── */
      .ph-trust {
        display: grid;
        grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr;
        align-items: center;
        gap: 0.875rem;
        padding: 1.25rem 1.5rem;
        margin-bottom: 2.5rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-float);
      }
      .ph-trust-item {
        display: inline-flex;
        align-items: center;
        gap: 0.75rem;
        min-width: 0;
      }
      .ph-trust-icon {
        flex-shrink: 0;
        width: 38px;
        height: 38px;
        border-radius: var(--r-md);
        background: var(--brand-50);
        color: var(--brand-700);
        display: grid;
        place-items: center;
      }
      .ph-trust-text { display: flex; flex-direction: column; min-width: 0; }
      .ph-trust-text strong {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--neutral-950);
        line-height: 1.2;
      }
      .ph-trust-text span {
        font-size: var(--fs-xs);
        color: var(--text-muted);
        line-height: 1.3;
      }
      .ph-trust-divider {
        width: 1px;
        height: 32px;
        background: var(--neutral-200);
      }
      @media (max-width: 880px) {
        .ph-trust {
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        .ph-trust-divider { display: none; }
      }

      /* ── [5] PROMOS DEL MES ─────────────────────────────────────── */
      .ph-section { margin-bottom: 2.75rem; }
      .ph-section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1.25rem;
      }
      .ph-section-head h2 {
        font-family: var(--font-display);
        font-optical-sizing: auto;
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--neutral-950);
        margin: 0;
        line-height: 1.1;
      }
      .ph-section-link {
        font-size: var(--fs-sm);
        font-weight: 700;
        color: var(--brand-700);
        text-decoration: none;
        white-space: nowrap;
      }
      .ph-section-link:hover { text-decoration: underline; }


      /* ── [7] HISTORIAL — lista compacta tipo "feed" ─────────────── */
      .ph-history-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .ph-history-row {
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        align-items: center;
        gap: 1rem;
        padding: 0.875rem 1.125rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-float);
        cursor: pointer;
        transition: border-color 180ms var(--ease-standard), transform 180ms var(--ease-spring), box-shadow 200ms var(--ease-standard);
      }
      .ph-history-row:hover {
        border-color: var(--brand-700);
        transform: translateY(-2px);
        box-shadow: var(--shadow-hover);
      }
      .ph-history-row:focus-visible {
        outline: 2px solid var(--brand-700);
        outline-offset: 2px;
      }
      .ph-history-status {
        width: 36px;
        height: 36px;
        border-radius: var(--r-md);
        display: grid;
        place-items: center;
        background: var(--neutral-100);
        color: var(--text-main);
        flex-shrink: 0;
      }
      .ph-history-status.is-fulfilled { background: rgba(22, 163, 74, 0.10); color: var(--ok-fg); }
      .ph-history-status.is-confirmed { background: var(--brand-50); color: var(--brand-700); }
      .ph-history-status.is-pending_approval { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .ph-history-status.is-draft { background: var(--neutral-100); color: var(--text-muted); }
      .ph-history-status.is-cancelled { background: var(--bad-soft-bg); color: var(--bad-fg); }
      .ph-history-status i { font-size: var(--fs-body); }
      .ph-history-info { display: flex; flex-direction: column; min-width: 0; }
      .ph-history-summary {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--neutral-950);
        line-height: 1.25;
      }
      .ph-history-meta {
        font-size: var(--fs-xs);
        color: var(--text-muted);
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .ph-history-meta code {
        font-family: var(--font-mono);
        font-size: var(--fs-micro);
        background: var(--neutral-100);
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
      }
      .ph-history-dot { color: var(--neutral-300); }
      .ph-history-total {
        font-size: var(--fs-h3);
        font-weight: 800;
        color: var(--neutral-950);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
        white-space: nowrap;
      }
      .ph-history-chevron {
        color: var(--text-muted);
        font-size: var(--fs-body);
        flex-shrink: 0;
      }

      .ph-empty {
        text-align: center;
        padding: 2.5rem 1.5rem;
        background: var(--card-bg);
        border: 1px dashed var(--neutral-200);
        border-radius: var(--r-lg);
      }
      .ph-empty h3 {
        font-family: var(--font-display);
        font-size: var(--fs-h2);
        font-weight: 700;
        margin: 0 0 0.5rem;
        color: var(--neutral-950);
        letter-spacing: -0.015em;
      }
      .ph-empty p { color: var(--text-muted); margin: 0 0 1.25rem; }

      /* ── [8] FOOTER OPERATIVO ───────────────────────────────────── */
      .ph-foot {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1.5rem;
        padding: 1.75rem 0 2.5rem;
        margin-top: 2rem;
        border-top: 1px solid var(--neutral-200);
      }
      @media (max-width: 720px) {
        .ph-foot { grid-template-columns: repeat(2, 1fr); }
      }
      .ph-foot-item { display: flex; flex-direction: column; gap: 0.2rem; }
      .ph-foot-item strong {
        font-size: var(--fs-micro);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
      }
      .ph-foot-item span {
        font-size: var(--fs-body);
        font-weight: 600;
        color: var(--neutral-950);
        line-height: 1.3;
      }

      /* ── [4.4] COMPRAR DE NUEVO (productos frecuentes) ──────────── */
      .ph-reorder-strip {
        display: flex;
        gap: 0.75rem;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        padding-bottom: 0.5rem;
        scrollbar-width: thin;
      }
      .ph-reorder-card {
        flex: 0 0 auto;
        width: 160px;
        scroll-snap-align: start;
        display: flex;
        flex-direction: column;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-float);
        overflow: hidden;
      }
      .ph-reorder-media {
        position: relative;
        aspect-ratio: 1;
        background: var(--brand-50);
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .ph-reorder-media img { width: 100%; height: 100%; object-fit: contain; }
      .ph-reorder-media.is-ph::before {
        content: '';
        position: absolute;
        inset: 0;
        background-image:
          radial-gradient(circle at 20% 26%, rgba(255, 255, 255, 0.32) 0, rgba(255, 255, 255, 0) 8px),
          radial-gradient(circle at 80% 24%, rgba(255, 255, 255, 0.26) 0, rgba(255, 255, 255, 0) 6px),
          radial-gradient(circle at 70% 78%, rgba(255, 255, 255, 0.28) 0, rgba(255, 255, 255, 0) 7px);
        pointer-events: none;
      }
      .ph-reorder-initials {
        position: relative;
        z-index: 1;
        font-family: var(--font-display);
        font-size: var(--text-display-md);
        font-weight: 700;
        color: #fff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.14);
      }
      .ph-reorder-freq {
        position: absolute;
        top: 6px;
        left: 6px;
        font-size: var(--fs-micro);
        font-weight: 700;
        padding: 0.1rem 0.4rem;
        border-radius: var(--r-pill);
        background: var(--neutral-950);
        color: #fff;
      }
      .ph-reorder-body {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        padding: 0.6rem 0.7rem 0.4rem;
        min-width: 0;
      }
      .ph-reorder-brand {
        font-size: var(--fs-micro);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ph-reorder-name {
        font-size: var(--fs-sm);
        font-weight: 600;
        color: var(--neutral-950);
        line-height: 1.25;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        min-height: 2.1em;
      }
      .ph-reorder-price {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--neutral-950);
        margin-top: 0.15rem;
        font-variant-numeric: tabular-nums;
      }
      .ph-reorder-add {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        margin: 0 0.5rem 0.6rem;
        min-height: 40px;
        border: none;
        border-radius: var(--r-md);
        background: var(--brand-700);
        color: #fff;
        font-size: var(--fs-sm);
        font-weight: 700;
        cursor: pointer;
        transition: background-color 150ms ease, transform 100ms ease;
      }
      .ph-reorder-add:hover:not(:disabled) { background: var(--brand-800); }
      .ph-reorder-add:active:not(:disabled) { transform: scale(0.97); }
      .ph-reorder-add:disabled { opacity: 0.6; cursor: default; }
      .ph-reorder-add.is-added { background: var(--ok-fg); }
      @media (max-width: 640px) {
        .ph-reorder-card { width: 140px; }
      }

      /* ── REABASTECIMIENTO PREDICTIVO ────────────────────────────── */
      .ph-restock-strip {
        display: flex;
        gap: 0.75rem;
        overflow-x: auto;
        scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        padding-bottom: 0.4rem;
      }
      .ph-restock-strip::-webkit-scrollbar { display: none; }
      .ph-restock-card {
        flex: 0 0 auto;
        width: 244px;
        scroll-snap-align: start;
        display: flex;
        align-items: center;
        gap: 0.7rem;
        padding: 0.55rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-float);
        cursor: pointer;
        transition: transform 180ms var(--ease-spring), box-shadow 200ms var(--ease-standard);
      }
      .ph-restock-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); }
      .ph-restock-media {
        position: relative;
        flex: 0 0 auto;
        width: 52px;
        height: 52px;
        border-radius: var(--r-md);
        background: var(--card-bg);
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .ph-restock-media img { width: 100%; height: 100%; object-fit: contain; padding: 4px; }
      .ph-restock-initials {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--fs-body);
        color: #fff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      }
      .ph-restock-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
      .ph-restock-name {
        font-size: var(--fs-sm);
        font-weight: 600;
        color: var(--neutral-950);
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ph-restock-ago {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: var(--fs-xs);
        font-weight: 700;
        color: var(--brand-700);
      }
      .ph-restock-ago i { font-size: var(--fs-micro); }
      .ph-restock-add {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border: none;
        border-radius: 50%;
        background: var(--brand-700);
        color: #fff;
        display: grid;
        place-items: center;
        cursor: pointer;
        font-size: var(--fs-body);
        transition: background-color 150ms ease, transform 120ms var(--ease-spring);
      }
      .ph-restock-add:active:not(:disabled) { transform: scale(0.9); }
      .ph-restock-add:disabled { opacity: 0.6; cursor: default; }
      .ph-restock-add.is-added { background: var(--ok-fg); }

      /* ── SKELETONS ──────────────────────────────────────────────── */
      .ph-skel-grid, .ph-skel-list {
        margin-bottom: 2.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
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
  private readonly cartFx = inject(CartFxService);

  /** Vuela la imagen al carrito desde el strip y reordena (restock / comprar de nuevo). */
  reorderAdd(p: CatalogHistoryRow, ev: Event): void {
    const art = (ev.currentTarget as HTMLElement).closest('article');
    const media = art?.querySelector('.ph-restock-media, .ph-reorder-media') as HTMLElement | null;
    this.cartFx.fly(media, p.image_url || null);
    this.addFrequent(p);
  }

  readonly username = signal<string>(this.formatDisplayName(this.auth.user()?.username || ''));
  readonly orders = signal<Order[]>([]);
  readonly promotions = signal<PromotionRow[]>([]);
  readonly loadingOrders = signal(true);
  readonly loadingPromos = signal(true);
  readonly reordering = signal(false);

  /** "Comprar de nuevo": productos frecuentes (myCatalogHistory) + estado de add 1-tap. */
  readonly frequentProducts = signal<CatalogHistoryRow[]>([]);
  readonly addingId = signal<string | null>(null);
  readonly addedIds = signal<Set<string>>(new Set<string>());
  private custId: string | null = null;
  private whId: string | null = null;
  private readonly imgFailed = new Set<string>();

  /** Carrusel "Marcas top": facets del catálogo (el componente maneja logo + fallback + marquee). */
  readonly brandFacets = signal<CatalogFacets | null>(null);
  readonly topBrands = computed(() => {
    const f = this.brandFacets();
    if (!f) return [];
    return f.brands
      .filter((b) => b.brand_id && b.brand_name && !/clasificar|abarrotes|bolsas/i.test(b.brand_name))
      .slice(0, 40);
  });

  /** "Productos del mes" = top-sellers del price_list del cliente (data real ERP). */
  readonly monthlyProducts = signal<PriceRow[]>([]);
  /**
   * "Productos top" = benchmark del mercado mexicano CRUZADO contra nuestro
   * catálogo. Cada tendencia MX (chamoy, tamarindo, enchilado…) se busca por
   * nombre y se muestra la mejor coincidencia de NUESTRO catálogo. No per-user.
   */
  readonly trendProducts = signal<PriceRow[]>([]);
  /** product_id → etiqueta de la tendencia MX que matchea (badge "por qué"). */
  readonly trendNotes = signal<Record<string, string>>({});

  /** "Sugeridos para ti" = canasta IA (D.4) con su razón por producto. */
  readonly suggestedProducts = signal<CatalogSuggestedRow[]>([]);
  readonly suggestedNotes = computed<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const p of this.suggestedProducts()) {
      if (p.rec_reason) m[p.product_id] = p.rec_reason;
    }
    return m;
  });

  /**
   * Reabastecimiento predictivo: productos recurrentes (≥2 pedidos) que llevan
   * ≥18 días sin pedirse → "toca reordenar". Reusa el historial ya cargado.
   */
  readonly RESTOCK_DAYS = 18;
  readonly restockProducts = computed<CatalogHistoryRow[]>(() => {
    const now = Date.now();
    return this.frequentProducts()
      .filter((p) => {
        if ((p.times_ordered || 0) < 2 || !p.last_ordered_at) return false;
        const days = (now - new Date(p.last_ordered_at).getTime()) / 86_400_000;
        return days >= this.RESTOCK_DAYS;
      })
      .sort(
        (a, b) =>
          new Date(a.last_ordered_at || 0).getTime() - new Date(b.last_ordered_at || 0).getTime(),
      )
      .slice(0, 6);
  });

  /** Días desde el último pedido de un producto (para el copy "hace N días"). */
  daysSince(iso?: string | null): number {
    if (!iso) return 0;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  }
  /** Producto abierto en el top-sheet de detalle (null = cerrado). */
  readonly sheetProduct = signal<PriceRow | null>(null);
  /** Etiqueta de tendencia MX del producto abierto (para el badge del sheet). */
  readonly sheetNoteText = computed<string>(() => {
    const p = this.sheetProduct();
    return p ? this.trendNotes()[p.product_id] || '' : '';
  });

  /** Tocar un card de producto → abre el top-sheet (baja desde arriba). */
  openMonthly(p: PriceRow): void {
    this.haptic.selection();
    this.sheetProduct.set(p);
  }
  closeSheet(): void {
    this.sheetProduct.set(null);
  }

  /** Add desde el top-sheet con la cantidad elegida (ensureDraft + addLine). */
  addFromSheet(ev: { product: PriceRow; qty: number }): void {
    const p = ev.product;
    if (this.addingId() || !this.custId || !this.whId || p.price == null) return;
    this.haptic.selection();
    this.addingId.set(p.product_id);
    this.portal
      .ensureDraft(this.custId, this.whId)
      .pipe(switchMap((draft) => this.portal.addLine(draft.id, p.product_id, Math.max(1, ev.qty))))
      .subscribe({
        next: () => {
          this.addingId.set(null);
          this.haptic.notification('success');
          this.addedIds.update((s) => new Set(s).add(p.product_id));
          this.closeSheet();
        },
        error: () => {
          this.addingId.set(null);
          this.haptic.notification('error');
        },
      });
  }
  addMonthly(p: PriceRow): void {
    if (this.addingId() || !this.custId || !this.whId || p.price == null) return;
    this.haptic.selection();
    this.addingId.set(p.product_id);
    const qty = Math.max(1, Number(p.min_qty) || 1);
    this.portal
      .ensureDraft(this.custId, this.whId)
      .pipe(switchMap((draft) => this.portal.addLine(draft.id, p.product_id, qty)))
      .subscribe({
        next: () => {
          this.addingId.set(null);
          this.haptic.notification('success');
          this.addedIds.update((s) => new Set(s).add(p.product_id));
        },
        error: () => {
          this.addingId.set(null);
          this.haptic.notification('error');
        },
      });
  }

  /**
   * Cruza el benchmark del mercado MX contra nuestro catálogo. UNA sola llamada
   * (cacheada) al catálogo + matching en cliente → cero riesgo de rate-limit.
   * Por cada tendencia vigente (filtra estacionales fuera de mes) toma la mejor
   * coincidencia con precio (imagen primero); una por tendencia → variedad.
   */
  private loadMxTrends(): void {
    const month = new Date().getMonth() + 1;
    const eligible = MX_TRENDS.filter((t) => !t.season || t.season.includes(month));
    this.portal.listCatalogProducts(this.whId || undefined).subscribe({
      next: (all) => {
        const norm = (s: string) =>
          (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const seen = new Set<string>();
        const notes: Record<string, string> = {};
        const picked: PriceRow[] = [];
        for (const t of eligible) {
          if (picked.length >= 6) break;
          const q = norm(t.query);
          const best = all
            .filter(
              (p) =>
                p.price != null &&
                !seen.has(p.product_id) &&
                norm(`${p.product_name} ${p.brand_name || ''}`).includes(q),
            )
            .sort((a, b) => (a.image_url ? 0 : 1) - (b.image_url ? 0 : 1))[0];
          if (best) {
            seen.add(best.product_id);
            notes[best.product_id] = t.label;
            picked.push(best);
          }
        }
        this.trendNotes.set(notes);
        this.trendProducts.set(picked);
      },
      error: () => this.trendProducts.set([]),
    });
  }

  /** Chips trending bajo el search — mock por ahora. */
  readonly trendingChips = [
    { slug: 'caramelos',    label: 'Caramelos' },
    { slug: 'chocolates',   label: 'Chocolates' },
    { slug: 'mazapanes',    label: 'Mazapanes' },
    { slug: 'importados',   label: 'Importados' },
    { slug: 'sin-azucar',   label: 'Sin azúcar' },
  ];

  readonly greetingPrefix = computed(() => {
    const h = new Date().getHours();
    if (h < 6) return 'Madrugada';
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  });

  readonly featuredPromo = computed(() => this.promotions()[0] || null);
  readonly secondaryPromos = computed(() => this.promotions().slice(1));
  /** Promo con arte de marketing propio → banner destacado arriba del home. */
  readonly bannerPromo = computed(() => this.promotions().find((p) => !!p.banner_url) || null);

  /** Title-case con respeto a conectores ES (de, en, del, la, etc.) y números/SKUs.
   *  "3x2 en BOLIS SURTIDOS 24PZ" → "3x2 en Bolis Surtidos 24pz". */
  titleCase(raw: string): string {
    if (!raw) return '';
    const conectores = new Set(['de', 'del', 'en', 'la', 'el', 'los', 'las', 'y', 'o', 'a', 'al', 'por', 'con', 'para', 'sin']);
    return raw
      .toLowerCase()
      .split(/(\s+)/)
      .map((part, i) => {
        if (/^\s+$/.test(part)) return part;
        if (i > 0 && conectores.has(part)) return part;
        if (/^\d/.test(part)) return part;
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('');
  }

  /** Convierte `cliente_demo` / `juan.perez` → "Cliente Demo" / "Juan Perez". */
  private formatDisplayName(raw: string): string {
    if (!raw) return '';
    return raw
      .replace(/[._-]+/g, ' ')
      .split(' ')
      .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(' ')
      .trim();
  }

  /** Badge corto que destaca el tipo de promo — copy comercial. */
  tileBadge(p: PromotionRow): string {
    const map: Record<string, string> = {
      percent_off_product: 'Descuento',
      percent_off_basket: 'En todo',
      nxm: 'Lleva más',
      volume_discount: 'Mayoreo',
      bundle_fixed_price: 'Combo',
      cross_sell_discount: 'Cross-sell',
    };
    return map[p.promotion_type] || 'Promo';
  }

  readonly lastFulfilled = computed(() =>
    this.orders().find((o) => o.status === 'fulfilled' || o.status === 'confirmed') || null,
  );

  /** Pedido "vivo" para banner top destacado. */
  readonly ongoingOrder = computed(() => {
    const list = this.orders();
    return (
      list.find((o) => o.status === 'confirmed') ||
      list.find((o) => o.status === 'pending_approval') ||
      list.find((o) => o.status === 'draft') ||
      null
    );
  });

  ongoingBannerCopy(): { title: string } {
    const o = this.ongoingOrder();
    if (!o) return { title: '' };
    const code = o.code || '—';
    switch (o.status) {
      case 'confirmed':         return { title: `Pedido ${code} en camino` };
      case 'pending_approval':  return { title: `${code} esperando confirmación` };
      case 'draft':             return { title: `Borrador ${code} esperándote` };
      default:                  return { title: '' };
    }
  }

  constructor() {
    this.portal.myOrders({ pageSize: 6 }).subscribe({
      next: (r) => {
        const list = r.data || [];
        this.orders.set(list);
        this.loadingOrders.set(false);
        // "Comprar de nuevo": deriva customer/warehouse del pedido más reciente
        // (sin llamadas extra) y trae los productos frecuentes para add 1-tap.
        const ref = list[0];
        if (ref) {
          this.custId = ref.customer_id;
          this.whId = ref.warehouse_id;
          this.portal.myCatalogHistory(ref.warehouse_id || undefined, { limit: 10 }).subscribe({
            next: (rows) => this.frequentProducts.set(rows.filter((p) => p.price != null)),
            error: () => this.frequentProducts.set([]),
          });
        }
      },
      error: () => {
        this.orders.set([]);
        this.loadingOrders.set(false);
      },
    });

    this.portal.catalogFacets(undefined, 80).subscribe({
      next: (f) => this.brandFacets.set(f),
      error: () => this.brandFacets.set(null),
    });

    // Resuelve cliente + almacén default (custId/whId fiables para el add 1-tap)
    // y carga "Productos del mes" = top-sellers del price_list del cliente.
    forkJoin({
      customer: this.portal.myCustomerInfo(),
      warehouses: this.portal.listWarehouses(),
    }).subscribe({
      next: ({ customer, warehouses }: any) => {
        if (customer?.id) this.custId = customer.id;
        const wh = (warehouses || []).find((w: any) => w.is_default) || (warehouses || [])[0];
        if (wh?.id) this.whId = wh.id;
        this.loadMxTrends();
        this.portal.myCatalogSuggested(this.whId || undefined).subscribe({
          next: (rows) => this.suggestedProducts.set((rows || []).filter((r) => r.price != null).slice(0, 10)),
          error: () => this.suggestedProducts.set([]),
        });
        const plId = customer?.default_price_list_id;
        if (!plId) {
          this.monthlyProducts.set([]);
          return;
        }
        this.portal.listTopSellers(plId, this.whId || undefined, 12).subscribe({
          next: (rows) => this.monthlyProducts.set((rows || []).filter((r) => r.price != null).slice(0, 12)),
          error: () => this.monthlyProducts.set([]),
        });
      },
      error: () => this.monthlyProducts.set([]),
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

  onHeroClick(): void {
    if (this.featuredPromo()) {
      this.goPromos();
    } else {
      this.goCatalog();
    }
  }

  goCatalog(category?: string): void {
    this.haptic.selection();
    if (category) {
      this.router.navigate(['/portal/catalog'], { queryParams: { category } });
    } else {
      this.router.navigateByUrl('/portal/catalog');
    }
  }

  goSearch(): void {
    this.haptic.selection();
    this.router.navigate(['/portal/catalog'], { queryParams: { focus: 'search' } });
  }

  goPromos(): void {
    this.haptic.selection();
    this.router.navigateByUrl('/portal/promotions');
  }

  goAi(): void {
    this.haptic.selection();
    this.router.navigateByUrl('/portal/recommendations');
  }

  // ── "Comprar de nuevo" (productos frecuentes) ─────────────────────
  hasImg(p: CatalogHistoryRow): boolean {
    return !!p.image_url && !this.imgFailed.has(p.product_id);
  }
  /** Gradiente de placeholder de marca (mismo lenguaje que el catálogo). */
  phStyle(p: CatalogHistoryRow): string {
    return brandPlaceholderGradient(p.product_id || p.product_name);
  }
  onImgError(p: CatalogHistoryRow): void {
    this.imgFailed.add(p.product_id);
    this.frequentProducts.update((l) => [...l]); // re-render → cae a iniciales
  }
  initials(p: CatalogHistoryRow): string {
    const src = (p.brand_name || p.product_name || '?').trim();
    return (
      src
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0] || '')
        .join('')
        .toUpperCase() || '?'
    );
  }
  trackByProduct = (_i: number, p: CatalogHistoryRow) => p.product_id;

  /** Agrega un producto frecuente al carrito en 1 tap (ensureDraft + addLine). */
  addFrequent(p: CatalogHistoryRow): void {
    if (this.addingId() || !this.custId || !this.whId) return;
    this.haptic.selection();
    this.addingId.set(p.product_id);
    const qty = Math.max(1, Number(p.min_qty) || 1);
    this.portal
      .ensureDraft(this.custId, this.whId)
      .pipe(switchMap((draft) => this.portal.addLine(draft.id, p.product_id, qty)))
      .subscribe({
        next: () => {
          this.addingId.set(null);
          this.haptic.notification('success');
          this.addedIds.update((s) => new Set(s).add(p.product_id));
        },
        error: () => {
          this.addingId.set(null);
          this.haptic.notification('error');
        },
      });
  }

  goLastOrder(): void {
    const l = this.lastFulfilled();
    if (!l || this.reordering()) return;
    this.haptic.selection();
    this.reordering.set(true);
    // Repetir en 1 tap: clona las líneas del último pedido al carrito y lleva
    // directo al carrito. Si nada quedó disponible, cae al detalle del pedido.
    this.portal.reorder(l).subscribe({
      next: ({ added }) => {
        this.reordering.set(false);
        this.router.navigate(added > 0 ? ['/portal/cart'] : ['/portal/orders', l.id]);
      },
      error: () => {
        this.reordering.set(false);
        this.router.navigate(['/portal/orders', l.id]);
      },
    });
  }

  statusLabel(s: string): string {
    const m: Record<string, string> = {
      draft: 'Borrador',
      pending_approval: 'Esperando',
      confirmed: 'Confirmado',
      fulfilled: 'Entregado',
      cancelled: 'Cancelado',
    };
    return m[s] || s;
  }

  typeLabel(t: string): string {
    return PROMOTION_TYPE_LABELS[t] || t;
  }

  statusIcon(s: string): string {
    const m: Record<string, string> = {
      draft: 'pi pi-pencil',
      pending_approval: 'pi pi-hourglass',
      confirmed: 'pi pi-truck',
      fulfilled: 'pi pi-check',
      cancelled: 'pi pi-times',
    };
    return m[s] || 'pi pi-receipt';
  }

  orderSummary(o: Order): string {
    const n = Array.isArray(o.lines) ? o.lines.length : 0;
    if (n === 0) return 'Pedido sin líneas';
    return `${n} producto${n === 1 ? '' : 's'}`;
  }

  onOrderAction(o: Order): void {
    this.haptic.selection();
    this.router.navigate(['/portal/orders', o.id]);
  }
}
