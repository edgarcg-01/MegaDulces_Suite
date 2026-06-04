import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe, CurrencyPipe } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
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
    SkeletonModule,
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

    <!-- [1.5] BANNER DE MARKETING (arte propio de una promo activa) -->
    <a
      *ngIf="bannerPromo() as bp"
      class="ph-banner"
      routerLink="/portal/promotions"
      [attr.aria-label]="'Ver promoción: ' + bp.name"
    >
      <img [src]="bp.banner_url" [alt]="bp.name" class="ph-banner-img" />
    </a>

    <!-- [2] HERO EDITORIAL — display + ilustración SVG propia -->
    <section
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
            Aprovechá la promo<br>del mes.
          } @else {
            Reabastecé tu tienda<br>en minutos.
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
    <section class="ph-trust" aria-label="Información de servicio">
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
          <span>Pedí hoy, recibí mañana</span>
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

    <!-- [5] PROMOS DEL MES — 1 feature + 2 secondary -->
    <section *ngIf="!loadingPromos() && promotions().length > 0" class="ph-section">
      <header class="ph-section-head">
        <h2>Promos del mes</h2>
        <a routerLink="/portal/promotions" class="ph-section-link">Ver todas →</a>
      </header>
      <div class="ph-promos-grid" *ngIf="promotions().length > 0">
        <article
          *ngIf="featuredPromo() as fp"
          class="ph-promo ph-promo-feature"
          routerLink="/portal/promotions"
        >
          <span class="ph-promo-badge">{{ tileBadge(fp) }}</span>
          <h3>{{ fp.name }}</h3>
          <p *ngIf="fp.description">{{ fp.description }}</p>
          <span class="ph-promo-cta">
            Aprovechar
            <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </span>
        </article>
        <article
          *ngFor="let p of secondaryPromos().slice(0, 2)"
          class="ph-promo ph-promo-side"
          routerLink="/portal/promotions"
        >
          <span class="ph-promo-badge ph-promo-badge-side">{{ tileBadge(p) }}</span>
          <h3>{{ p.name }}</h3>
          <p *ngIf="p.description">{{ p.description }}</p>
          <footer *ngIf="p.ends_at">Hasta {{ p.ends_at | date:'dd MMM' }}</footer>
        </article>
      </div>
    </section>

    <div *ngIf="loadingPromos()" class="ph-skel-grid">
      <p-skeleton width="100%" height="200px" borderRadius="20px"></p-skeleton>
    </div>

    <!-- [6] ATAJOS OPERATIVOS — 4 tiles compactos -->
    <section class="ph-section">
      <header class="ph-section-head">
        <h2>Atajos rápidos</h2>
      </header>
      <div class="ph-shortcuts">
        <button type="button" class="ph-shortcut" (click)="goCatalog()">
          <span class="ph-shortcut-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5"/>
              <rect x="14" y="3" width="7" height="7" rx="1.5"/>
              <rect x="3" y="14" width="7" height="7" rx="1.5"/>
              <rect x="14" y="14" width="7" height="7" rx="1.5"/>
            </svg>
          </span>
          <span class="ph-shortcut-label">Catálogo</span>
        </button>
        <button *ngIf="lastFulfilled()" type="button" class="ph-shortcut" (click)="goLastOrder()" [disabled]="reordering()">
          <span class="ph-shortcut-icon">
            <svg *ngIf="!reordering()" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
            <i *ngIf="reordering()" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
          </span>
          <span class="ph-shortcut-label">{{ reordering() ? 'Agregando…' : 'Repetir último' }}</span>
        </button>
        <button type="button" class="ph-shortcut" routerLink="/portal/orders">
          <span class="ph-shortcut-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <path d="M14 2v6h6M8 13h8M8 17h5"/>
            </svg>
          </span>
          <span class="ph-shortcut-label">Mis pedidos</span>
        </button>
        <button type="button" class="ph-shortcut ph-shortcut-ai" (click)="goAi()">
          <span class="ph-shortcut-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2 L14 8 L20 10 L14 12 L12 18 L10 12 L4 10 L10 8 Z"/>
              <path d="M19 3 L20 5 M21 4 L20 5" stroke-width="1.5"/>
              <path d="M5 17 L6 19 M7 18 L6 19" stroke-width="1.5"/>
            </svg>
          </span>
          <span class="ph-shortcut-label">Recomendado IA</span>
        </button>
      </div>
    </section>

    <!-- [7] HISTORIAL — últimos 3 pedidos compactos -->
    <section class="ph-section" *ngIf="!loadingOrders()">
      <header class="ph-section-head">
        <h2>Tu historial</h2>
        <a routerLink="/portal/orders" class="ph-section-link">Ver todos →</a>
      </header>

      <div *ngIf="orders().length === 0" class="ph-empty">
        <h3>Aún no tenés pedidos</h3>
        <p>Explorá el catálogo y armá tu primer pedido en minutos.</p>
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

    <!-- [8] FOOTER OPERATIVO -->
    <footer class="ph-foot">
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
        display: block;
        max-width: 1120px;
        margin: 0 auto;
        font-family: var(--font-body);
      }

      /* ── [1] LIVE STATUS RIBBON ─────────────────────────────────── */
      .ph-ribbon {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.5rem 0;
        margin-bottom: 1.5rem;
        font-size: 0.875rem;
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
        border-radius: 999px;
        padding: 0.375rem 0.875rem;
        transition: background 180ms var(--ease-standard), transform 180ms var(--ease-standard);
      }
      .ph-ribbon-live:hover {
        background: var(--brand-700);
        color: #fff;
        transform: translateX(2px);
      }
      .ph-ribbon-live i { font-size: 0.7rem; }

      /* ── [1.5] BANNER DE MARKETING ──────────────────────────────── */
      .ph-banner {
        display: block;
        width: 100%;
        margin-bottom: 2rem;
        border-radius: 20px;
        overflow: hidden;
        border: 1px solid var(--neutral-200);
        cursor: pointer;
        transition: transform 220ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .ph-banner:hover {
        transform: translateY(-2px);
        box-shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.22);
      }
      .ph-banner-img { display: block; width: 100%; height: auto; }

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
        border-radius: 24px;
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
        font-size: 0.7rem;
        font-weight: 800;
        color: var(--brand-700);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        margin-bottom: 1rem;
      }
      .ph-hero-eyebrow i { font-size: 0.7rem; }
      .ph-hero-h1 {
        font-family: var(--font-display);
        font-size: var(--text-display-xl);
        font-weight: 800;
        letter-spacing: -0.035em;
        line-height: 1.02;
        margin: 0 0 1rem;
        color: var(--neutral-950);
      }
      .ph-hero-promo-name {
        display: inline-block;
        font-family: var(--font-body);
        font-size: 0.9375rem;
        font-weight: 700;
        color: var(--brand-700);
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid var(--brand-100);
        padding: 0.375rem 0.875rem;
        border-radius: 999px;
        margin: 0 0 1rem;
        letter-spacing: -0.005em;
      }
      .ph-hero-lead {
        font-size: 1.0625rem;
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
      .ph-btn-ghost i { font-size: 0.7rem; transition: transform 180ms var(--ease-standard); }
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
        border: 1.5px solid var(--neutral-200);
        border-radius: 16px;
        cursor: pointer;
        font-family: var(--font-body);
        text-align: left;
        transition: border-color 180ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
      }
      .ph-search:hover {
        border-color: var(--brand-700);
        box-shadow: 0 12px 26px -14px rgba(240, 90, 40, 0.25);
      }
      .ph-search-icon {
        font-size: 1.125rem;
        color: var(--brand-700);
        flex-shrink: 0;
      }
      .ph-search-placeholder {
        flex: 1;
        font-size: 0.9375rem;
        font-weight: 500;
        color: var(--text-muted);
      }
      .ph-search-kbd {
        font-family: var(--font-mono);
        font-size: 0.7rem;
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
        flex-wrap: wrap;
        margin-bottom: 2.25rem;
      }
      .ph-chip {
        padding: 0.4rem 0.875rem;
        background: transparent;
        border: 1px solid var(--neutral-200);
        border-radius: 999px;
        font-family: var(--font-body);
        font-size: 0.8125rem;
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
        border: 1px solid var(--neutral-200);
        border-radius: 18px;
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
        border-radius: 12px;
        background: var(--brand-50);
        color: var(--brand-700);
        display: grid;
        place-items: center;
      }
      .ph-trust-text { display: flex; flex-direction: column; min-width: 0; }
      .ph-trust-text strong {
        font-size: 0.875rem;
        font-weight: 700;
        color: var(--neutral-950);
        line-height: 1.2;
      }
      .ph-trust-text span {
        font-size: 0.75rem;
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
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.025em;
        color: var(--neutral-950);
        margin: 0;
        line-height: 1.1;
      }
      .ph-section-link {
        font-size: 0.8125rem;
        font-weight: 700;
        color: var(--brand-700);
        text-decoration: none;
        white-space: nowrap;
      }
      .ph-section-link:hover { text-decoration: underline; }

      .ph-promos-grid {
        display: grid;
        grid-template-columns: 1.5fr 1fr;
        gap: 1rem;
      }
      @media (max-width: 720px) {
        .ph-promos-grid { grid-template-columns: 1fr; }
      }
      .ph-promo {
        position: relative;
        overflow: hidden;
        padding: 1.75rem 1.75rem 1.5rem;
        border-radius: 20px;
        cursor: pointer;
        transition: transform 200ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        text-decoration: none;
        color: inherit;
      }
      .ph-promo:hover {
        transform: translateY(-3px);
        box-shadow: 0 18px 32px -14px rgba(0, 0, 0, 0.16);
      }
      .ph-promo-feature {
        background: linear-gradient(135deg, var(--brand-700) 0%, var(--brand-600) 100%);
        color: #fff;
        min-height: 220px;
      }
      .ph-promo-feature::after {
        content: '';
        position: absolute;
        width: 220px;
        height: 220px;
        right: -60px;
        bottom: -70px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(253, 231, 7, 0.32), transparent 70%);
        pointer-events: none;
      }
      .ph-promo-feature h3 {
        font-family: var(--font-display);
        font-size: var(--text-display-md);
        font-weight: 700;
        letter-spacing: -0.015em;
        margin: 0;
        line-height: 1.15;
        color: #fff;
      }
      .ph-promo-feature p {
        font-size: 0.9375rem;
        margin: 0;
        opacity: 0.9;
        line-height: 1.45;
        max-width: 38ch;
      }

      .ph-promo-side {
        background: var(--card-bg);
        border: 1px solid var(--neutral-200);
        min-height: 104px;
      }
      .ph-promo-side h3 {
        font-family: var(--font-display);
        font-size: 1.125rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0;
        line-height: 1.2;
        color: var(--neutral-950);
      }
      .ph-promo-side p {
        font-size: 0.8125rem;
        color: var(--text-muted);
        margin: 0;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .ph-promo-side footer {
        font-size: 0.75rem;
        color: var(--text-muted);
        font-weight: 600;
        margin-top: auto;
      }

      .ph-promo-badge {
        align-self: flex-start;
        font-size: 0.65rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        padding: 0.3rem 0.75rem;
        border-radius: 999px;
        background: rgba(255,255,255,0.18);
        color: #fff;
        backdrop-filter: blur(4px);
      }
      .ph-promo-badge-side {
        background: var(--brand-100);
        color: var(--brand-900);
      }
      .ph-promo-cta {
        margin-top: auto;
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        font-size: 0.875rem;
        font-weight: 800;
        color: var(--brand-400);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ph-promo-cta i { font-size: 0.75rem; transition: transform 180ms var(--ease-standard); }
      .ph-promo:hover .ph-promo-cta i { transform: translateX(3px); }

      /* ── [6] ATAJOS OPERATIVOS ──────────────────────────────────── */
      .ph-shortcuts {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.875rem;
      }
      @media (max-width: 720px) {
        .ph-shortcuts { grid-template-columns: repeat(2, 1fr); }
      }
      .ph-shortcut {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.875rem;
        padding: 1.5rem 0.75rem;
        background: var(--card-bg);
        border: 1px solid var(--neutral-200);
        border-radius: 18px;
        cursor: pointer;
        font-family: var(--font-body);
        color: var(--neutral-950);
        transition: transform 180ms var(--ease-standard), border-color 180ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ph-shortcut:hover {
        transform: translateY(-2px);
        border-color: var(--brand-700);
        box-shadow: 0 14px 26px -14px rgba(240, 90, 40, 0.2);
      }
      .ph-shortcut-icon {
        width: 52px;
        height: 52px;
        border-radius: 14px;
        background: var(--brand-50);
        color: var(--brand-700);
        display: grid;
        place-items: center;
        transition: transform 180ms var(--ease-standard);
      }
      .ph-shortcut:hover .ph-shortcut-icon { transform: scale(1.05); }
      .ph-shortcut-label {
        font-size: 0.875rem;
        font-weight: 700;
        letter-spacing: -0.005em;
      }
      .ph-shortcut-ai {
        background: linear-gradient(135deg, var(--neutral-950) 0%, var(--neutral-900) 100%);
        color: #fff;
        border-color: var(--neutral-900);
      }
      .ph-shortcut-ai .ph-shortcut-icon {
        background: rgba(253, 231, 7, 0.16);
        color: var(--brand-400);
      }

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
        border: 1px solid var(--neutral-200);
        border-radius: 14px;
        cursor: pointer;
        transition: border-color 180ms var(--ease-standard), transform 180ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ph-history-row:hover {
        border-color: var(--brand-700);
        transform: translateX(2px);
        box-shadow: 0 8px 18px -10px rgba(240, 90, 40, 0.18);
      }
      .ph-history-row:focus-visible {
        outline: 2px solid var(--brand-700);
        outline-offset: 2px;
      }
      .ph-history-status {
        width: 36px;
        height: 36px;
        border-radius: 10px;
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
      .ph-history-status i { font-size: 0.9rem; }
      .ph-history-info { display: flex; flex-direction: column; min-width: 0; }
      .ph-history-summary {
        font-size: 0.9375rem;
        font-weight: 700;
        color: var(--neutral-950);
        line-height: 1.25;
      }
      .ph-history-meta {
        font-size: 0.75rem;
        color: var(--text-muted);
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .ph-history-meta code {
        font-family: var(--font-mono);
        font-size: 0.7rem;
        background: var(--neutral-100);
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
      }
      .ph-history-dot { color: var(--neutral-300); }
      .ph-history-total {
        font-size: 1rem;
        font-weight: 800;
        color: var(--neutral-950);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
        white-space: nowrap;
      }
      .ph-history-chevron {
        color: var(--text-muted);
        font-size: 0.85rem;
        flex-shrink: 0;
      }

      .ph-empty {
        text-align: center;
        padding: 2.5rem 1.5rem;
        background: var(--card-bg);
        border: 1px dashed var(--neutral-200);
        border-radius: 18px;
      }
      .ph-empty h3 {
        font-family: var(--font-display);
        font-size: 1.5rem;
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
        font-size: 0.7rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-muted);
      }
      .ph-foot-item span {
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--neutral-950);
        line-height: 1.3;
      }

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

  readonly username = signal<string>(this.formatDisplayName(this.auth.user()?.username || ''));
  readonly orders = signal<Order[]>([]);
  readonly promotions = signal<PromotionRow[]>([]);
  readonly loadingOrders = signal(true);
  readonly loadingPromos = signal(true);
  readonly reordering = signal(false);

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
