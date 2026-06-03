import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import {
  PortalService,
  PriceRow,
  SmartSearchResult,
  CatalogHistoryRow,
  CatalogSuggestedRow,
  CatalogWithPromoRow,
  CatalogFacets,
} from '../portal.service';
import { AuthService } from '../../../core/services/auth.service';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

interface BrandGroup {
  brand_id: string;
  brand_name: string;
  count: number;
  color: string;
  initial: string;
}

/**
 * Paleta de grises usada para los avatars/placeholders. Hash determinístico
 * sobre el id para variar levemente la luminosidad y que distintas marcas /
 * productos no queden idénticas — pero sin color saturado.
 */
const NEUTRAL_PALETTE = [
  '#3F3F46', '#52525B', '#71717A', '#27272A',
  '#404040', '#525252', '#262626', '#171717',
];

function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return NEUTRAL_PALETTE[Math.abs(h) % NEUTRAL_PALETTE.length];
}

function initial(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

@Component({
  selector: 'app-portal-catalog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    ButtonModule,
    SkeletonModule,
    InputNumberModule,
    InputTextModule,
    TagModule,
    TooltipModule,
  ],
  template: `
    <div *ngIf="isAdmin()" class="portal-banner" role="status">
      <i class="pi pi-eye" aria-hidden="true"></i>
      <span><b>Vista administrador</b> — catálogo default del tenant, solo lectura. Iniciá sesión como cliente para hacer pedidos.</span>
    </div>

    <header class="portal-page-head cat-page-head">
      <div class="portal-page-head-text">
        <span class="portal-eyebrow">
          <i class="pi pi-th-large" aria-hidden="true"></i>
          Catálogo
        </span>
        <h1 class="cat-h1">Productos disponibles</h1>
        <p class="portal-page-sub" *ngIf="customerName()">
          Lista de precios de <b>{{ customerName() }}</b>
        </p>
      </div>
      <button type="button" class="cat-ai-btn" (click)="goAi()">
        <i class="pi pi-sparkles" aria-hidden="true"></i>
        <span>Recomendado para ti</span>
      </button>
    </header>

    <!-- Hero mini: trust signals contextualizados al cliente -->
    <section class="cat-hero" *ngIf="!loading() && prices().length > 0" aria-label="Información de tu cuenta">
      <div class="cat-hero-item">
        <span class="cat-hero-label">Tu cartera</span>
        <strong>{{ customerName() || 'Mi tienda' }}</strong>
      </div>
      <div class="cat-hero-divider" aria-hidden="true"></div>
      <div class="cat-hero-item">
        <span class="cat-hero-label">Productos</span>
        <strong>{{ prices().length }} SKUs</strong>
      </div>
      <div class="cat-hero-divider" aria-hidden="true"></div>
      <div class="cat-hero-item">
        <span class="cat-hero-label">Entrega</span>
        <strong>24-48h hábiles</strong>
      </div>
      <div class="cat-hero-divider" aria-hidden="true"></div>
      <div class="cat-hero-item">
        <span class="cat-hero-label">Mín. pedido</span>
        <strong>$2,500 MXN</strong>
      </div>
    </section>

    <div class="cat-search-bar" *ngIf="!loading() && prices().length > 0">
      <i [class]="aiSearch() ? 'pi pi-bolt cat-search-icon cat-search-icon-ai' : 'pi pi-search cat-search-icon'"></i>
      <input
        type="text"
        [(ngModel)]="search"
        [placeholder]="aiSearch() ? 'Describí qué buscás (IA)…' : 'Buscar producto o marca...'"
        (ngModelChange)="onSearchChange($event)"
        autocomplete="off"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
      />
      <button
        *ngIf="search"
        type="button"
        class="cat-search-clear"
        (click)="clearSearch()"
        pTooltip="Limpiar"
        aria-label="Limpiar búsqueda"
      ><i class="pi pi-times"></i></button>
      <button
        type="button"
        class="cat-search-mode"
        [class.active]="aiSearch()"
        (click)="toggleAiSearch()"
        [pTooltip]="aiSearch() ? 'Búsqueda IA activa' : 'Activar búsqueda IA'"
        aria-label="Toggle búsqueda IA"
      ><i class="pi pi-bolt"></i> IA</button>
    </div>

    <div
      *ngIf="aiSearch() && !searching() && !searchSignal().trim() && searchHistory().length > 0"
      class="cat-history"
    >
      <span class="cat-history-label">
        <i class="pi pi-clock"></i> Búsquedas recientes
      </span>
      <div class="cat-history-chips">
        <button
          *ngFor="let q of searchHistory(); trackBy: trackByString"
          type="button"
          class="cat-history-chip"
          (click)="useHistory(q)"
        >{{ q }}</button>
        <button
          type="button"
          class="cat-history-clear"
          (click)="clearHistory()"
          aria-label="Limpiar historial"
          pTooltip="Limpiar historial"
        ><i class="pi pi-times"></i></button>
      </div>
    </div>

    <div *ngIf="searching()" class="cat-search-state">
      <i class="pi pi-spin pi-spinner"></i> Buscando con IA…
    </div>
    <div *ngIf="!searching() && aiSearch() && smartResults().length > 0" class="cat-search-state cat-search-state-info">
      <i class="pi pi-info-circle"></i>
      {{ smartResults().length }} resultado(s) por relevancia semántica
      <span *ngIf="smartMode() === 'fallback_like'" class="cat-search-state-warn">
        — sin LLM, fallback texto
      </span>
    </div>

    <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

    <div *ngIf="!loading() && prices().length === 0" class="portal-empty">
      <div class="portal-empty-icon"><i class="pi pi-info-circle" aria-hidden="true"></i></div>
      <h2>Catálogo vacío</h2>
      <p>Aún no hay productos con precio configurado. Contactá a tu administrador.</p>
    </div>

    <!-- Atajos personalizados (chips activos). Próximos pasos van a sumar
         "Con promo" y "Nuevos". -->
    <nav
      *ngIf="!loading() && prices().length > 0 && (historyProducts().length > 0 || suggestedProducts().length > 0 || promoProducts().length > 0)"
      class="cat-chip-rail cat-chip-rail-quick"
      aria-label="Atajos personalizados"
    >
      <button
        *ngIf="historyProducts().length > 0"
        type="button"
        class="cat-chip cat-chip-quick"
        [class.active]="quickFilter() === 'reorder'"
        (click)="toggleQuickFilter('reorder')"
        [attr.aria-pressed]="quickFilter() === 'reorder'"
      >
        <i class="pi pi-history" aria-hidden="true"></i>
        Reordenar
        <span class="cat-chip-count">{{ historyProducts().length }}</span>
      </button>
      <button
        *ngIf="suggestedProducts().length > 0"
        type="button"
        class="cat-chip cat-chip-quick cat-chip-ai"
        [class.active]="quickFilter() === 'suggested'"
        (click)="toggleQuickFilter('suggested')"
        [attr.aria-pressed]="quickFilter() === 'suggested'"
      >
        <i class="pi pi-sparkles" aria-hidden="true"></i>
        Sugeridos IA
        <span class="cat-chip-count">{{ suggestedProducts().length }}</span>
      </button>
      <button
        *ngIf="promoProducts().length > 0"
        type="button"
        class="cat-chip cat-chip-quick cat-chip-promo"
        [class.active]="quickFilter() === 'promo'"
        (click)="toggleQuickFilter('promo')"
        [attr.aria-pressed]="quickFilter() === 'promo'"
      >
        <i class="pi pi-tag" aria-hidden="true"></i>
        Con promo
        <span class="cat-chip-count">{{ promoProducts().length }}</span>
      </button>
    </nav>

    <!-- Toolbar de filtros: botón abre panel lateral con marca/precio/stock.
         Reemplaza al chip-rail de 438 marcas que era inmanejable. -->
    <div
      *ngIf="!loading() && prices().length > 0 && !quickFilter()"
      class="cat-toolbar"
    >
      <button
        type="button"
        class="cat-filters-btn"
        [class.has-filters]="activeFiltersCount() > 0"
        (click)="openFilters()"
        [attr.aria-expanded]="filtersOpen()"
      >
        <i class="pi pi-sliders-h" aria-hidden="true"></i>
        Filtros
        <span *ngIf="activeFiltersCount() > 0" class="cat-filters-badge">
          {{ activeFiltersCount() }}
        </span>
      </button>
      <button
        *ngIf="activeFiltersCount() > 0"
        type="button"
        class="cat-clear-btn"
        (click)="clearPanelFilters()"
      >
        <i class="pi pi-times" aria-hidden="true"></i>
        Limpiar
      </button>
      <span class="cat-toolbar-meta">{{ visibleProducts().length }} de {{ prices().length }}</span>
    </div>

    <!-- Panel slide-in: desktop = side-right, mobile = bottom-sheet
         (la diferencia es CSS responsive). -->
    <div
      *ngIf="filtersOpen()"
      class="cat-filters-backdrop"
      (click)="closeFilters()"
      aria-hidden="true"
    ></div>
    <aside
      *ngIf="filtersOpen()"
      class="cat-filters-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Filtros del catálogo"
    >
      <header class="cat-filters-head">
        <h3>Filtros</h3>
        <button
          type="button"
          class="cat-filters-close"
          (click)="closeFilters()"
          aria-label="Cerrar filtros"
        ><i class="pi pi-times"></i></button>
      </header>

      <div class="cat-filters-body">
        <!-- Sección: Marca -->
        <section class="cat-filters-section" *ngIf="facets()">
          <h4 class="cat-filters-section-title">Marca</h4>
          <div class="cat-filters-search">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input
              type="text"
              [ngModel]="brandPanelSearch()"
              (ngModelChange)="brandPanelSearch.set($event)"
              placeholder="Buscar marca..."
              autocomplete="off"
            />
          </div>
          <ul class="cat-filters-list">
            <li>
              <button
                type="button"
                class="cat-filters-row"
                [class.active]="selectedBrandId() === '__all__'"
                (click)="selectBrand('__all__')"
              >
                <span>Todas las marcas</span>
                <span class="cat-filters-row-count">{{ facets()!.total }}</span>
              </button>
            </li>
            <li *ngFor="let b of filteredBrandFacets(); trackBy: trackByBrandFacet">
              <button
                type="button"
                class="cat-filters-row"
                [class.active]="selectedBrandId() === b.brand_id"
                (click)="selectBrand(b.brand_id || '__unknown__')"
              >
                <span>{{ b.brand_name || 'Sin marca' }}</span>
                <span class="cat-filters-row-count">{{ b.count }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- Sección: Precio -->
        <section class="cat-filters-section" *ngIf="facets() && facets()!.price_buckets.length > 0">
          <h4 class="cat-filters-section-title">Precio</h4>
          <ul class="cat-filters-list">
            <li *ngFor="let b of facets()!.price_buckets; trackBy: trackByBucket">
              <button
                type="button"
                class="cat-filters-row"
                [class.active]="priceBucket()?.min === b.min && priceBucket()?.max === b.max"
                (click)="togglePriceBucket(b)"
                [disabled]="b.count === 0"
              >
                <span>{{ b.label }}</span>
                <span class="cat-filters-row-count">{{ b.count }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- Sección: Stock -->
        <section class="cat-filters-section" *ngIf="facets()?.stock">
          <h4 class="cat-filters-section-title">Disponibilidad</h4>
          <button
            type="button"
            class="cat-filters-row"
            [class.active]="onlyWithStock()"
            (click)="toggleStockOnly()"
          >
            <span>Solo con stock</span>
            <span class="cat-filters-row-count">{{ facets()!.stock!.with_stock }}</span>
          </button>
        </section>
      </div>

      <footer class="cat-filters-foot">
        <button
          type="button"
          class="cat-filters-clear"
          (click)="clearPanelFilters()"
          [disabled]="activeFiltersCount() === 0"
        >Limpiar todo</button>
        <button
          type="button"
          class="cat-filters-apply"
          (click)="closeFilters()"
        >Ver {{ visibleProducts().length }} producto(s)</button>
      </footer>
    </aside>

    <div *ngIf="!loading() && prices().length > 0" class="cat-layout">
      <section class="cat-main">
        <section *ngIf="topSellers().length > 0" class="cat-bestsellers" aria-label="Más vendidos">
          <header class="cat-bestsellers-head">
            <h3>
              <i class="pi pi-chart-line" aria-hidden="true"></i>
              Más vendidos
            </h3>
            <span class="cat-bestsellers-meta">{{ topSellers().length }} producto(s) — últimos 90 días</span>
          </header>
          <div class="cat-bestsellers-strip">
            <article
              *ngFor="let p of topSellers(); trackBy: trackByProduct"
              class="cat-bestseller-card"
              (click)="openSheet(p)"
              tabindex="0"
              role="button"
              [attr.aria-label]="'Más vendido #' + p.sales_rank + ' — ' + p.product_name"
              (keydown.enter)="openSheet(p)"
              (keydown.space)="openSheet(p); $event.preventDefault()"
            >
              <span class="cat-bestseller-rank">#{{ p.sales_rank }}</span>
              <div class="cat-bestseller-img" [class.has-photo]="hasImg(p)">
                <img *ngIf="hasImg(p)" [src]="p.image_url" [alt]="p.product_name" loading="lazy" decoding="async" (error)="onImgError(p)" />
                <span *ngIf="!hasImg(p)" class="cat-bestseller-img-initials">{{ productInitials(p) }}</span>
              </div>
              <div class="cat-bestseller-body">
                <span class="cat-bestseller-brand">{{ p.brand_name || 'Sin marca' }}</span>
                <h4 class="cat-bestseller-name" [title]="p.product_name">{{ p.product_name }}</h4>
                <span class="cat-bestseller-price">
                  {{ +(p.price || 0) | currency:'MXN':'symbol-narrow':'1.2-2' }}
                </span>
              </div>
            </article>
          </div>
        </section>

        <header class="cat-main-head">
          <h2>{{ selectedBrandName() }}</h2>
          <span class="cat-main-meta">
            <ng-container *ngIf="hasMorePages(); else allShown">
              Mostrando {{ visibleProducts().length }} de {{ totalCount() }}
            </ng-container>
            <ng-template #allShown>
              {{ visibleProducts().length }} producto(s)
            </ng-template>
          </span>
        </header>

        <div *ngIf="visibleProducts().length === 0" class="cat-empty-grid">
          <i class="pi pi-inbox"></i>
          <p>No hay productos que coincidan.</p>
        </div>

        <div class="cat-grid" *ngIf="visibleProducts().length > 0">
          <article
            *ngFor="let p of visibleProducts(); trackBy: trackByProduct"
            class="cat-card"
            [class.cat-card-active]="hasQty(p)"
            (click)="openSheet(p)"
            tabindex="0"
            role="button"
            [attr.aria-label]="'Ver detalles de ' + p.product_name"
            (keydown.enter)="openSheet(p)"
            (keydown.space)="openSheet(p); $event.preventDefault()"
          >
            <div
              class="cat-card-img"
              [class.has-photo]="hasImg(p)"
              [style.background]="cardGradient(p)"
            >
              <img
                *ngIf="hasImg(p)"
                [src]="p.image_url"
                [alt]="p.product_name"
                loading="lazy"
                decoding="async"
                class="cat-card-img-real"
                (error)="onImgError(p)"
              />
              <span *ngIf="!hasImg(p)" class="cat-card-img-initials">{{ productInitials(p) }}</span>
              <span
                *ngIf="promoByProductId()[p.product_id] as promo"
                class="cat-card-promo-pill"
                [attr.title]="promo.promo_name"
              >
                <i class="pi pi-tag"></i>
                {{ promoLabel(promo.promo_type) }}
              </span>
              <span
                *ngIf="p.stock_available != null && p.stock_available <= 5"
                class="cat-card-stock-pill"
              >
                <i class="pi pi-exclamation-circle"></i>
                {{ p.stock_available }} en stock
              </span>
              <span
                *ngIf="productScore(p) as score"
                class="cat-card-score-pill"
                [attr.title]="'Relevancia semántica: ' + score + '%'"
              >
                <i class="pi pi-bolt"></i>
                {{ score }}%
              </span>
            </div>

            <div class="cat-card-body">
              <span class="cat-card-brand">
                {{ p.brand_name || 'Sin marca' }}
              </span>
              <h3 class="cat-card-name" [title]="p.product_name">{{ p.product_name }}</h3>

              <div class="cat-card-price-row">
                <span class="cat-card-price" *ngIf="p.price != null">
                  {{ +p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}
                </span>
                <span class="cat-card-price cat-card-price-na" *ngIf="p.price == null">
                  Sin precio
                </span>
                <span class="cat-card-min" *ngIf="p.min_qty > 1">
                  mín {{ p.min_qty }}
                </span>
              </div>

              <!-- Botón "+" agrega directo al carrito (con stopPropagation para no abrir el sheet del card) -->
              <button
                *ngIf="!isInCart(p)"
                type="button"
                class="cat-add"
                [disabled]="!!adding[p.product_id] || isAdmin() || p.price == null"
                (click)="$event.stopPropagation(); addToCart(p)"
                [attr.aria-label]="'Agregar ' + p.product_name + ' al carrito'"
                [pTooltip]="isAdmin() ? 'Solo lectura (admin)' : (p.price == null ? 'Producto sin precio configurado' : 'Agregar al carrito')"
              >
                <i [class]="adding[p.product_id] ? 'pi pi-spin pi-spinner' : 'pi pi-plus'"></i>
              </button>

              <!-- Stepper inline cuando ya está en carrito (también no propaga) -->
              <div
                *ngIf="isInCart(p)"
                class="cat-stepper"
                role="group"
                (click)="$event.stopPropagation()"
                [attr.aria-label]="'Ajustar cantidad de ' + p.product_name"
              >
                <button
                  type="button"
                  class="cat-stepper-btn"
                  [disabled]="!!adding[p.product_id] || isAdmin()"
                  (click)="$event.stopPropagation(); decrementCartLine(p)"
                  [attr.aria-label]="cartLineQty(p) <= 1 ? 'Quitar del carrito' : 'Disminuir'"
                >
                  <i [class]="cartLineQty(p) <= 1 ? 'pi pi-trash' : 'pi pi-minus'"></i>
                </button>
                <span class="cat-stepper-val" aria-live="polite">
                  {{ adding[p.product_id] ? '…' : cartLineQty(p) }}
                </span>
                <button
                  type="button"
                  class="cat-stepper-btn"
                  [disabled]="!!adding[p.product_id] || isAdmin()"
                  (click)="$event.stopPropagation(); incrementCartLine(p)"
                  aria-label="Aumentar"
                >
                  <i class="pi pi-plus"></i>
                </button>
              </div>
            </div>
          </article>
        </div>

        <!-- Sentinel para infinite scroll: el IntersectionObserver dispara
             loadNextPage() cuando este div entra al viewport. Solo presente
             si quedan páginas por traer del backend. -->
        <div
          *ngIf="hasMorePages()"
          #scrollSentinel
          class="cat-scroll-sentinel"
          aria-hidden="true"
        >
          <i class="pi pi-spin pi-spinner"></i>
          <span>Cargando más productos…</span>
        </div>
      </section>
    </div>

    <button
      *ngIf="cart.cartLineCount() > 0"
      type="button"
      class="cat-fab"
      (click)="openDrawer()"
      [attr.aria-label]="'Abrir carrito (' + cart.cartLineCount() + ' items)'"
    >
      <span class="cat-fab-icon">
        <i class="pi pi-shopping-bag"></i>
        <span class="cat-fab-count">{{ cart.cartLineCount() }}</span>
      </span>
      <span class="cat-fab-divider" aria-hidden="true"></span>
      <span class="cat-fab-label">
        <span class="cat-fab-eyebrow">Carrito</span>
        <span class="cat-fab-total">{{ cart.cartTotal() | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
      </span>
    </button>

    <!-- ── PRODUCT DETAIL SHEET (click en `+`) ──────────────────── -->
    <div
      class="cat-sheet-backdrop"
      [class.open]="!!sheetProduct()"
      (click)="closeSheet()"
      aria-hidden="true"
    ></div>
    <aside
      class="cat-sheet"
      [class.open]="!!sheetProduct()"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cat-sheet-title"
    >
      @if (sheetProduct(); as sp) {
        <button
          type="button"
          class="cat-sheet-close"
          (click)="closeSheet()"
          aria-label="Cerrar detalle del producto"
        ><i class="pi pi-times" aria-hidden="true"></i></button>

        <div class="cat-sheet-img" [class.has-photo]="hasImg(sp)" [style.background]="cardGradient(sp)" aria-hidden="true">
          <img
            *ngIf="hasImg(sp)"
            [src]="sp.image_url"
            [alt]="sp.product_name"
            loading="lazy"
            decoding="async"
            class="cat-sheet-img-real"
            (error)="onImgError(sp)"
          />
          <span *ngIf="!hasImg(sp)" class="cat-sheet-img-initials">{{ productInitials(sp) }}</span>
        </div>

        <div class="cat-sheet-body">
          <span class="cat-sheet-brand">{{ sp.brand_name || 'Sin marca' }}</span>
          <h3 id="cat-sheet-title" class="cat-sheet-name">{{ sp.product_name }}</h3>

          <div class="cat-sheet-meta">
            @if (sp.price != null) {
              <span class="cat-sheet-meta-item">
                <i class="pi pi-tag" aria-hidden="true"></i>
                {{ +sp.price | currency:'MXN':'symbol-narrow':'1.2-2' }}/u
              </span>
            } @else {
              <span class="cat-sheet-meta-item cat-sheet-meta-warn">
                <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                Sin precio configurado
              </span>
            }
            @if (sp.min_qty > 1) {
              <span class="cat-sheet-meta-item">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Mínimo {{ sp.min_qty }} unidades
              </span>
            }
            @if (sp.stock_available != null) {
              <span
                class="cat-sheet-meta-item"
                [class.cat-sheet-meta-warn]="sp.stock_available <= 5"
              >
                <i class="pi pi-box" aria-hidden="true"></i>
                {{ sp.stock_available }} en stock
              </span>
            }
          </div>

          <div class="cat-sheet-qty-row">
            <span class="cat-sheet-qty-label">Cantidad</span>
            <div class="cat-sheet-stepper">
              <button
                type="button"
                class="cat-sheet-stepper-btn"
                (click)="sheetDec()"
                [disabled]="sheetQty() <= (sp.min_qty || 1)"
                aria-label="Disminuir"
              ><i class="pi pi-minus"></i></button>
              <span class="cat-sheet-qty-val" aria-live="polite">{{ sheetQty() }}</span>
              <button
                type="button"
                class="cat-sheet-stepper-btn"
                (click)="sheetInc()"
                aria-label="Aumentar"
              ><i class="pi pi-plus"></i></button>
            </div>
          </div>

          <div class="cat-sheet-subtotal">
            <span>Subtotal</span>
            <b>{{ sheetSubtotal() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
          </div>

          <div class="cat-sheet-actions">
            <button
              type="button"
              class="cat-sheet-btn cat-sheet-btn-secondary"
              (click)="closeSheet()"
            >Cancelar</button>
            <button
              type="button"
              class="cat-sheet-btn cat-sheet-btn-primary"
              [disabled]="!!adding[sp.product_id]"
              (click)="confirmAddFromSheet()"
            >
              <i [class]="adding[sp.product_id] ? 'pi pi-spin pi-spinner' : 'pi pi-shopping-cart'"></i>
              {{ adding[sp.product_id] ? 'Agregando…' : 'Agregar al carrito' }}
            </button>
          </div>
        </div>
      }
    </aside>

    <div
      class="cat-drawer-backdrop"
      [class.open]="drawerOpen()"
      (click)="closeDrawer()"
      aria-hidden="true"
    ></div>
    <aside
      class="cat-drawer"
      [class.open]="drawerOpen()"
      role="dialog"
      aria-label="Carrito"
    >
      <header class="cat-drawer-head">
        <div>
          <span class="cat-drawer-eyebrow">Tu carrito</span>
          <h3>{{ cart.cartLineCount() }} {{ cart.cartLineCount() === 1 ? 'producto' : 'productos' }}</h3>
        </div>
        <button
          type="button"
          class="cat-drawer-close"
          (click)="closeDrawer()"
          aria-label="Cerrar"
        ><i class="pi pi-times"></i></button>
      </header>

      <div class="cat-drawer-body">
        <div *ngIf="cart.cartLineCount() === 0" class="cat-drawer-empty">
          <i class="pi pi-shopping-bag"></i>
          <p>Tu carrito está vacío.</p>
        </div>

        <ng-container *ngIf="cart.cartLineCount() > 0">
          <ul class="cat-drawer-lines" *ngIf="cart.cartDetail()?.lines as lines">
            <li
              *ngFor="let l of lines; trackBy: trackByLineId"
              class="cat-drawer-line"
            >
              <div
                class="cat-drawer-line-avatar"
                [style.background]="lineGradient(l.product_id)"
              >{{ l.line_number }}</div>
              <div class="cat-drawer-line-info">
                <span class="cat-drawer-line-id">{{ shortId(l.product_id) }}</span>
                <span class="cat-drawer-line-price">
                  {{ +l.unit_price | currency:'MXN':'symbol-narrow':'1.2-2' }}/u
                </span>
              </div>
              <div class="cat-drawer-line-qty">
                <button
                  type="button"
                  class="cat-qty-btn"
                  (click)="bumpDrawerQty(l, -1)"
                  [disabled]="+l.quantity <= 1"
                  aria-label="Disminuir"
                >−</button>
                <span class="cat-drawer-qty-val">{{ l.quantity }}</span>
                <button
                  type="button"
                  class="cat-qty-btn"
                  (click)="bumpDrawerQty(l, 1)"
                  aria-label="Aumentar"
                >+</button>
              </div>
              <button
                type="button"
                class="cat-drawer-line-rm"
                (click)="removeDrawerLine(l)"
                pTooltip="Quitar"
                aria-label="Quitar línea"
              ><i class="pi pi-trash"></i></button>
            </li>
          </ul>

          <div *ngIf="!cart.cartDetail()" class="cat-drawer-loading">
            <i class="pi pi-spin pi-spinner"></i> Cargando líneas…
          </div>

          <div class="cat-drawer-total">
            <span>Total estimado</span>
            <b>{{ cart.cartTotal() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
          </div>
        </ng-container>
      </div>

      <footer class="cat-drawer-foot">
        <button
          type="button"
          class="cat-drawer-btn cat-drawer-btn-secondary"
          (click)="closeDrawer()"
        >Seguir comprando</button>
        <button
          type="button"
          class="cat-drawer-btn cat-drawer-btn-primary"
          [disabled]="cart.cartLineCount() === 0"
          (click)="goCart()"
        >
          Ver carrito
          <i class="pi pi-arrow-right"></i>
        </button>
      </footer>
    </aside>
  `,
  styles: [
    `
      :host { display: block; }

      /* ── Page head: Fraunces + AI button identitario ─────────────── */
      .cat-page-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .cat-h1 {
        font-family: var(--font-display, inherit);
        font-size: clamp(1.875rem, 4vw, 2.25rem);
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.1;
        margin: 0;
        color: var(--neutral-950);
      }
      .cat-ai-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.625rem 1.125rem;
        background: linear-gradient(135deg, var(--neutral-950) 0%, var(--neutral-900) 100%);
        color: var(--brand-400);
        border: none;
        border-radius: 999px;
        font-family: var(--font-body);
        font-size: 0.875rem;
        font-weight: 700;
        cursor: pointer;
        transition: transform 180ms var(--ease-standard), box-shadow 220ms var(--ease-standard);
        box-shadow: 0 6px 16px -8px rgba(0, 0, 0, 0.3);
        white-space: nowrap;
      }
      .cat-ai-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 24px -10px rgba(0, 0, 0, 0.4),
                    0 0 0 3px rgba(253, 231, 7, 0.18);
      }
      .cat-ai-btn i { font-size: 0.95rem; }

      /* ── Hero mini con trust signals contextualizados ─────────────── */
      .cat-hero {
        display: grid;
        grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr;
        align-items: center;
        gap: 1rem;
        padding: 1.125rem 1.5rem;
        margin: 0.5rem 0 1.25rem;
        background: var(--brand-50, var(--card-bg));
        border: 1px solid var(--brand-100, var(--border-color));
        border-radius: 16px;
      }
      .cat-hero-item {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        min-width: 0;
      }
      .cat-hero-label {
        font-size: 0.65rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-muted, var(--neutral-600));
      }
      .cat-hero-item strong {
        font-size: 0.9375rem;
        font-weight: 700;
        color: var(--neutral-950);
        letter-spacing: -0.005em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cat-hero-divider {
        width: 1px;
        height: 28px;
        background: var(--brand-200, var(--border-color));
      }
      @media (max-width: 900px) {
        .cat-hero {
          grid-template-columns: 1fr 1fr;
          gap: 0.875rem 1rem;
        }
        .cat-hero-divider { display: none; }
      }

      .cat-search-bar {
        position: sticky;
        top: 0;
        z-index: 11;
        margin: 0 -0.25rem 0.625rem;
        padding: 0.5rem 1rem;
        background: var(--card-bg);
        border: 1.5px solid var(--border-color);
        border-radius: 12px;
        display: flex;
        align-items: center;
        transition: border-color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard);
      }
      .cat-search-bar:focus-within {
        border-color: var(--neutral-950);
        box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
      }
      .cat-search-icon { color: var(--text-faint); font-size: 1rem; }
      .cat-search-icon-ai { color: var(--text-main); }
      .cat-search-mode {
        background: transparent;
        border: 1px solid var(--border-color);
        color: var(--text-muted);
        font-size: 0.75rem;
        font-weight: 700;
        padding: 0.3rem 0.625rem;
        border-radius: 999px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        margin-left: 0.5rem;
        transition: all 150ms var(--ease-standard);
      }
      .cat-search-mode:hover {
        border-color: var(--neutral-400);
        color: var(--text-main);
      }
      .cat-search-mode.active {
        background: var(--neutral-900);
        border-color: var(--neutral-900);
        color: #fff;
      }
      .cat-search-mode.active i { color: var(--brand-400); }
      .cat-search-state {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.8125rem;
        color: var(--text-muted);
        margin: -0.5rem 0 1rem;
        padding: 0 0.25rem;
      }
      .cat-search-state-info { color: var(--text-muted); }
      .cat-search-state-warn { color: var(--warn-fg); font-weight: 600; }
      .cat-search-bar input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 0.875rem 0.75rem;
        font-size: 0.9375rem;
        color: var(--text-main);
        outline: none;
        min-width: 0;
      }
      .cat-search-clear {
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
      .cat-search-clear:hover { color: var(--text-main); background: var(--neutral-200); }

      .cat-layout {
        display: block;
      }

      .cat-chip-rail {
        display: flex;
        gap: 0.5rem;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 0.5rem 0;
        margin-bottom: 1rem;
        scroll-padding-left: 0.25rem;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
        position: sticky;
        top: calc(2.75rem + 1rem);
        z-index: 10;
        background: var(--layout-bg, var(--surface-ground));
      }
      .cat-chip-rail::-webkit-scrollbar { height: 4px; }
      .cat-chip-rail::-webkit-scrollbar-thumb {
        background: var(--neutral-200);
        border-radius: 2px;
      }
      .cat-chip {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.5rem 0.875rem;
        border: 1px solid var(--border-color);
        background: var(--card-bg);
        color: var(--text-main);
        border-radius: 999px;
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: border-color 120ms var(--ease-standard);
      }
      .cat-chip:hover { border-color: var(--neutral-400); }
      .cat-chip.active {
        background: var(--neutral-900);
        border-color: var(--neutral-900);
        color: #fff;
        font-weight: 600;
      }
      .cat-chip-count {
        font-size: 0.7rem;
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
      }
      .cat-chip.active .cat-chip-count { opacity: 0.85; }

      /* Rail de atajos personalizados — un poco más arriba, sin sticky para
         que se quede al hacer scroll y ceda espacio al rail de marcas debajo. */
      .cat-chip-rail-quick {
        position: static;
        margin-bottom: 0.5rem;
        padding-bottom: 0;
      }
      .cat-chip-quick {
        background: linear-gradient(135deg, var(--accent-soft-bg, #fde68a22) 0%, var(--card-bg) 100%);
        border-color: var(--accent-border, var(--neutral-300));
      }
      .cat-chip-quick i { font-size: 0.85rem; opacity: 0.8; }
      .cat-chip-quick.active i { opacity: 1; }
      .cat-chip-quick.active {
        background: var(--neutral-900);
        border-color: var(--neutral-900);
        color: #fff;
      }
      .cat-chip-ai {
        background: linear-gradient(135deg, color-mix(in srgb, var(--ai-accent, #8b5cf6) 8%, var(--card-bg)) 0%, var(--card-bg) 100%);
        border-color: color-mix(in srgb, var(--ai-accent, #8b5cf6) 30%, var(--border-color));
      }
      .cat-chip-ai i { color: var(--ai-accent, #8b5cf6); }
      .cat-chip-ai.active {
        background: var(--ai-accent, #8b5cf6);
        border-color: var(--ai-accent, #8b5cf6);
        color: #fff;
      }
      .cat-chip-ai.active i { color: #fff; }
      .cat-chip-promo {
        background: linear-gradient(135deg, color-mix(in srgb, var(--promo-accent, #ef4444) 8%, var(--card-bg)) 0%, var(--card-bg) 100%);
        border-color: color-mix(in srgb, var(--promo-accent, #ef4444) 30%, var(--border-color));
      }
      .cat-chip-promo i { color: var(--promo-accent, #ef4444); }
      .cat-chip-promo.active {
        background: var(--promo-accent, #ef4444);
        border-color: var(--promo-accent, #ef4444);
        color: #fff;
      }
      .cat-chip-promo.active i { color: #fff; }

      .cat-card-promo-pill {
        position: absolute;
        top: 0.5rem;
        left: 0.5rem;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.2rem 0.5rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 600;
        background: var(--promo-accent, #ef4444);
        color: #fff;
        z-index: 2;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15);
      }
      .cat-card-promo-pill i { font-size: 0.7rem; }

      /* ── Toolbar de filtros (reemplaza chip-rail de brands) ── */
      .cat-toolbar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        margin-bottom: 1rem;
        position: sticky;
        top: calc(2.75rem + 1rem);
        z-index: 10;
        background: var(--layout-bg, var(--surface-ground));
      }
      .cat-filters-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.5rem 0.875rem;
        border: 1px solid var(--border-color);
        background: var(--card-bg);
        color: var(--text-main);
        border-radius: 999px;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        transition: border-color 120ms var(--ease-standard);
      }
      .cat-filters-btn:hover { border-color: var(--neutral-400); }
      .cat-filters-btn.has-filters {
        border-color: var(--neutral-900);
        background: var(--neutral-900);
        color: #fff;
      }
      .cat-filters-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.25rem;
        height: 1.25rem;
        padding: 0 0.35rem;
        border-radius: 999px;
        background: rgba(255,255,255,0.25);
        font-size: 0.7rem;
        font-weight: 700;
      }
      .cat-clear-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.4rem 0.7rem;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-muted);
        border-radius: 999px;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .cat-clear-btn:hover { color: var(--text-main); background: var(--neutral-100); }
      .cat-toolbar-meta {
        margin-left: auto;
        font-size: 0.8rem;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }

      /* ── Panel de filtros (drawer side-right) ── */
      .cat-filters-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.35);
        z-index: 80;
        animation: catFadeIn 180ms var(--ease-standard);
      }
      .cat-filters-panel {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(420px, 100vw);
        background: var(--card-bg);
        border-left: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        z-index: 81;
        box-shadow: -8px 0 24px rgba(0,0,0,0.12);
        animation: catSlideInRight 220ms var(--ease-standard);
      }
      .cat-filters-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border-color);
      }
      .cat-filters-head h3 { margin: 0; font-size: 1rem; font-weight: 600; }
      .cat-filters-close {
        background: transparent;
        border: 0;
        padding: 0.4rem;
        color: var(--text-muted);
        cursor: pointer;
        border-radius: 6px;
      }
      .cat-filters-close:hover { background: var(--neutral-100); color: var(--text-main); }

      .cat-filters-body {
        flex: 1;
        overflow-y: auto;
        padding: 1rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }
      .cat-filters-section { display: flex; flex-direction: column; gap: 0.5rem; }
      .cat-filters-section-title {
        margin: 0 0 0.25rem;
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }
      .cat-filters-search {
        position: relative;
        display: flex;
        align-items: center;
      }
      .cat-filters-search i {
        position: absolute;
        left: 0.65rem;
        color: var(--text-muted);
        font-size: 0.85rem;
        pointer-events: none;
      }
      .cat-filters-search input {
        width: 100%;
        padding: 0.45rem 0.75rem 0.45rem 2rem;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        background: var(--surface-ground);
        color: var(--text-main);
        font-size: 0.85rem;
      }
      .cat-filters-list {
        list-style: none;
        padding: 0;
        margin: 0;
        max-height: 280px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cat-filters-row {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.55rem 0.65rem;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-main);
        border-radius: 8px;
        font-size: 0.85rem;
        cursor: pointer;
        text-align: left;
      }
      .cat-filters-row:hover:not(:disabled) { background: var(--neutral-100); }
      .cat-filters-row.active {
        background: var(--neutral-900);
        color: #fff;
      }
      .cat-filters-row:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .cat-filters-row-count {
        font-size: 0.75rem;
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
      }
      .cat-filters-row.active .cat-filters-row-count { opacity: 0.9; }

      .cat-filters-foot {
        display: flex;
        gap: 0.75rem;
        padding: 0.875rem 1.25rem;
        border-top: 1px solid var(--border-color);
        background: var(--card-bg);
      }
      .cat-filters-clear {
        flex: 1;
        padding: 0.6rem;
        border: 1px solid var(--border-color);
        background: transparent;
        color: var(--text-main);
        border-radius: 8px;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .cat-filters-clear:disabled { opacity: 0.4; cursor: not-allowed; }
      .cat-filters-apply {
        flex: 1.5;
        padding: 0.6rem;
        border: 0;
        background: var(--neutral-900);
        color: #fff;
        border-radius: 8px;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
      }

      @keyframes catFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes catSlideInRight {
        from { transform: translateX(100%); }
        to { transform: translateX(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .cat-filters-backdrop, .cat-filters-panel { animation: none; }
      }

      /* Mobile: el panel se vuelve bottom-sheet */
      @media (max-width: 640px) {
        .cat-filters-panel {
          top: auto;
          left: 0;
          right: 0;
          bottom: 0;
          width: 100%;
          max-height: 85vh;
          border-left: 0;
          border-top: 1px solid var(--border-color);
          border-radius: 16px 16px 0 0;
          animation: catSlideInBottom 220ms var(--ease-standard);
        }
      }
      @keyframes catSlideInBottom {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
      }

      /* Sentinel del infinite scroll — un slot sutil al final del grid que
         indica "se sigue cargando" mientras el observer trae el próximo batch. */
      .cat-scroll-sentinel {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 1.5rem 0;
        color: var(--text-muted);
        font-size: 0.85rem;
      }
      .cat-scroll-sentinel i { font-size: 1rem; }

      .cat-main { display: flex; flex-direction: column; gap: 0.875rem; }
      .cat-main-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .cat-main-head h2 {
        margin: 0;
        font-family: var(--font-display, inherit);
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--text-main);
      }
      .cat-main-meta { font-size: 0.8125rem; color: var(--text-muted); }

      .cat-empty-grid {
        text-align: center;
        padding: 2rem;
        color: var(--text-muted);
      }
      .cat-empty-grid i { font-size: 1.75rem; display: block; margin-bottom: 0.5rem; }

      .cat-bestsellers { margin-bottom: 1.25rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
      .cat-bestsellers-head { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; margin-bottom: .625rem; }
      .cat-bestsellers-head h3 { font-size: 1rem; font-weight: 700; letter-spacing: -.01em; color: var(--text-color); margin: 0; display: inline-flex; align-items: center; gap: .4rem; }
      .cat-bestsellers-head h3 i { font-size: .85rem; color: var(--text-color-secondary); }
      .cat-bestsellers-meta { font-size: .7rem; color: var(--text-muted); }
      .cat-bestsellers-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(160px,180px); gap: .625rem; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; padding-bottom: .5rem; scrollbar-width: thin; }
      .cat-bestsellers-strip::-webkit-scrollbar { height: 6px; }
      .cat-bestsellers-strip::-webkit-scrollbar-thumb { background: var(--neutral-300); border-radius: 3px; }
      .cat-bestseller-card { position: relative; scroll-snap-align: start; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; cursor: pointer; transition: transform .2s var(--ease-standard), box-shadow .2s var(--ease-standard), border-color .2s var(--ease-standard); }
      .cat-bestseller-card:hover { transform: translateY(-2px); box-shadow: 0 8px 16px -8px rgba(0,0,0,.12); border-color: var(--neutral-300); }
      .cat-bestseller-card:focus-visible { outline: 2px solid var(--brand-500); outline-offset: 2px; }
      .cat-bestseller-rank { position: absolute; top: 6px; left: 6px; z-index: 2; font-size: .65rem; font-weight: 700; padding: .15rem .4rem; background: var(--neutral-950); color: var(--brand-400); border-radius: 999px; }
      .cat-bestseller-img { position: relative; aspect-ratio: 1/1; background: var(--brand-50); display: grid; place-items: center; overflow: hidden; }
      .cat-bestseller-img.has-photo { background: var(--surface-card,#fff); }
      .cat-bestseller-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; padding: 6px; }
      .cat-bestseller-img-initials { font-weight: 800; font-size: 1.4rem; color: var(--brand-700); opacity: .5; }
      .cat-bestseller-body { padding: .5rem .625rem .625rem; display: flex; flex-direction: column; gap: .2rem; }
      .cat-bestseller-brand { font-size: .65rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cat-bestseller-name { font-size: .75rem; font-weight: 600; color: var(--text-color); line-height: 1.25; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .cat-bestseller-price { margin-top: .15rem; font-size: .85rem; font-weight: 700; color: var(--text-color); }
      .cat-bestseller-noprice { margin-top: .15rem; font-size: .7rem; color: var(--text-muted); font-style: italic; }

      .cat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 0.875rem;
      }

      .cat-card {
        position: relative;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        cursor: pointer;
        transition:
          transform 180ms var(--ease-standard),
          box-shadow 200ms var(--ease-standard),
          border-color 200ms var(--ease-standard);
      }
      .cat-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 22px -10px rgba(0, 0, 0, 0.12);
        border-color: var(--neutral-300);
      }
      .cat-card:focus-visible {
        outline: 2px solid var(--brand-500);
        outline-offset: 2px;
      }
      .cat-card:active {
        transform: translateY(0);
      }
      .cat-card-active {
        border-left: 4px solid var(--brand-500);
      }
      .cat-card-active:hover {
        border-left-color: var(--brand-500);
      }

      .cat-card-img {
        position: relative;
        aspect-ratio: 4 / 3;
        display: grid;
        place-items: center;
        overflow: hidden;
        border-bottom: 1px solid var(--border-color);
      }
      .cat-card-img.has-photo {
        background: var(--surface-card, #fff) !important;
      }
      .cat-card-img-real {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 8px;
      }
      .cat-card-img-initials {
        position: relative;
        z-index: 1;
        font-weight: 800;
        font-size: clamp(1.5rem, 5vw, 2rem);
        letter-spacing: -0.02em;
        color: var(--brand-700);
        opacity: 0.5;
      }
      .cat-card-stock-pill {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.25rem 0.55rem;
        background: var(--warn-soft-bg);
        color: var(--warn-soft-fg);
        border: 1px solid var(--warn-border);
        border-radius: 999px;
      }
      .cat-card-stock-pill i { font-size: 0.7rem; }
      .cat-card-score-pill {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0.25rem 0.55rem;
        background: var(--card-bg);
        color: var(--text-main);
        border: 1px solid var(--border-color);
        border-radius: 999px;
        font-variant-numeric: tabular-nums;
      }
      .cat-card-score-pill i { font-size: 0.6rem; color: var(--brand-700); }

      .cat-history {
        margin: -0.5rem 0 1rem;
        padding: 0.625rem 0.875rem;
        background: var(--card-bg);
        border: 1px dashed var(--border-color);
        border-radius: 12px;
      }
      .cat-history-label {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
        margin-bottom: 0.5rem;
      }
      .cat-history-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        align-items: center;
      }
      .cat-history-chip {
        background: var(--neutral-100);
        border: 1px solid var(--border-color);
        color: var(--text-main);
        font-size: 0.75rem;
        font-weight: 600;
        padding: 0.25rem 0.625rem;
        border-radius: 999px;
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), transform 120ms var(--ease-standard);
      }
      .cat-history-chip:hover {
        background: var(--neutral-200);
        transform: translateY(-1px);
      }
      .cat-history-clear {
        background: transparent;
        border: none;
        color: var(--text-faint);
        width: 24px;
        height: 24px;
        border-radius: 999px;
        cursor: pointer;
        display: grid;
        place-items: center;
        margin-left: auto;
      }
      .cat-history-clear:hover {
        color: var(--bad-fg);
        background: rgba(220, 38, 38, 0.08);
      }

      .cat-drawer-lines {
        list-style: none;
        padding: 0;
        margin: 0 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cat-drawer-line {
        display: grid;
        grid-template-columns: 36px 1fr auto auto;
        gap: 0.5rem;
        align-items: center;
        padding: 0.5rem;
        border: 1px solid var(--border-color);
        border-radius: 10px;
      }
      .cat-drawer-line-avatar {
        width: 36px;
        height: 36px;
        border-radius: 8px;
        color: #fff;
        display: grid;
        place-items: center;
        font-weight: 800;
        font-size: 0.8125rem;
        box-shadow: inset 0 -4px 8px rgba(0,0,0,0.12);
      }
      .cat-drawer-line-info {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
        min-width: 0;
      }
      .cat-drawer-line-id {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.7rem;
        color: var(--text-main);
        background: var(--neutral-100);
        padding: 0.05rem 0.4rem;
        border-radius: 5px;
        align-self: flex-start;
      }
      .cat-drawer-line-price {
        font-size: 0.7rem;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }
      .cat-drawer-line-qty {
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }
      .cat-drawer-line-qty .cat-qty-btn {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        background: var(--surface-ground);
        border: none;
        cursor: pointer;
        color: var(--text-main);
        font-weight: 700;
        display: grid;
        place-items: center;
      }
      .cat-drawer-line-qty .cat-qty-btn:hover:not(:disabled) {
        background: var(--neutral-200);
        color: var(--text-main);
      }
      .cat-drawer-line-qty .cat-qty-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .cat-drawer-qty-val {
        font-size: 0.8125rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        min-width: 22px;
        text-align: center;
        color: var(--text-main);
      }
      .cat-drawer-line-rm {
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--text-faint);
        border-radius: 6px;
        cursor: pointer;
        display: grid;
        place-items: center;
      }
      .cat-drawer-line-rm:hover {
        background: rgba(220, 38, 38, 0.1);
        color: var(--bad-fg);
      }
      .cat-drawer-loading {
        text-align: center;
        padding: 1rem;
        color: var(--text-muted);
        font-size: 0.875rem;
      }

      .cat-card-body {
        padding: 0.75rem 0.875rem 0.875rem;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        flex: 1;
      }
      .cat-card-brand {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
      }
      .cat-card-name {
        font-size: 0.875rem;
        font-weight: 600;
        margin: 0;
        line-height: 1.3;
        color: var(--text-main);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .cat-card-price-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
        margin-top: 0.25rem;
      }
      .cat-card-price {
        font-size: 1.0625rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .cat-card-price-na {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-muted);
        letter-spacing: normal;
      }
      .cat-card-min {
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--text-muted);
        background: var(--neutral-100);
        padding: 0.1rem 0.5rem;
        border-radius: 999px;
      }

      .cat-add {
        position: absolute;
        right: 0.625rem;
        bottom: 0.625rem;
        z-index: 3;
        width: 38px;
        height: 38px;
        border-radius: 999px;
        border: none;
        background: var(--neutral-950);
        color: var(--brand-400);
        font-size: 0.95rem;
        cursor: pointer;
        display: grid;
        place-items: center;
        box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.28),
                    0 0 0 0 rgba(253, 231, 7, 0);
        transition: transform 140ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .cat-add:hover:not(:disabled) {
        transform: scale(1.08);
        box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.28),
                    0 0 0 4px rgba(253, 231, 7, 0.22);
      }
      .cat-add:active:not(:disabled) { transform: scale(0.94); }

      /* ── Inline stepper (cuando producto está en carrito) ── */
      .cat-stepper {
        position: absolute;
        right: 0.625rem;
        bottom: 0.625rem;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        width: auto;
        min-width: 116px;
        height: 36px;
        padding: 0;
        background: var(--neutral-900);
        color: var(--brand-400);
        border-radius: 999px;
        box-shadow: 0 4px 12px -3px rgba(0, 0, 0, 0.25);
        overflow: hidden;
        animation: stepperIn 240ms cubic-bezier(0.34, 1.4, 0.5, 1) both;
      }
      @keyframes stepperIn {
        from { opacity: 0; transform: scale(0.7); }
        to   { opacity: 1; transform: scale(1); }
      }
      .cat-stepper-btn {
        width: 32px;
        height: 36px;
        background: transparent;
        border: none;
        color: var(--brand-400);
        cursor: pointer;
        display: grid;
        place-items: center;
        font-size: 0.85rem;
        border-radius: 999px;
        transition: background-color 120ms var(--ease-standard), transform 120ms var(--ease-standard);
      }
      .cat-stepper-btn:hover:not(:disabled) {
        background: rgba(253, 231, 7, 0.18);
      }
      .cat-stepper-btn:active:not(:disabled) {
        transform: scale(0.88);
      }
      .cat-stepper-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .cat-stepper-val {
        min-width: 22px;
        text-align: center;
        font-size: 0.8125rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        color: var(--brand-400);
        line-height: 1;
        padding: 0 0.125rem;
      }

      .cat-add:disabled { opacity: 0.35; cursor: not-allowed; }

      /* Mini-cart FAB enriquecido (Stitch style: icon+badge | label+total) */
      .cat-fab {
        position: fixed;
        left: max(1rem, env(safe-area-inset-left));
        right: max(1rem, env(safe-area-inset-right));
        bottom: calc(5.25rem + env(safe-area-inset-bottom));
        z-index: 30;
        margin: 0 auto;
        max-width: 420px;
        display: inline-flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.625rem 0.875rem 0.625rem 0.625rem;
        background: var(--neutral-950);
        color: #fff;
        border: 1px solid rgba(63, 63, 70, 0.6);
        border-radius: 9999px;
        font-weight: 700;
        font-size: 0.8125rem;
        cursor: pointer;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3),
                    0 0 15px rgba(253, 231, 7, 0.15);
        animation: fabIn 320ms var(--ease-spring) both;
        transition: transform 200ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      @keyframes fabIn {
        from { transform: translateY(20px) scale(0.85); opacity: 0; }
        to   { transform: translateY(0) scale(1); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .cat-fab, .cat-stepper, .cat-sheet, .cat-drawer { animation: none !important; transition: none !important; }
        .cat-fab:hover, .cat-card:hover, .cat-add:hover { transform: none !important; }
      }
      .cat-fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4),
                    0 0 20px rgba(253, 231, 7, 0.25);
      }
      .cat-fab:active { transform: scale(0.97); }

      .cat-fab-icon {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        flex-shrink: 0;
      }
      .cat-fab-icon i { font-size: 1.125rem; }
      .cat-fab-count {
        position: absolute;
        top: -4px;
        right: -6px;
        background: var(--brand-400);
        color: var(--neutral-950);
        font-weight: 800;
        font-size: 0.625rem;
        min-width: 16px;
        height: 16px;
        line-height: 16px;
        border-radius: 999px;
        padding: 0 4px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .cat-fab-divider {
        width: 1px;
        height: 28px;
        background: rgba(255, 255, 255, 0.2);
      }
      .cat-fab-label {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        line-height: 1;
      }
      .cat-fab-eyebrow {
        font-size: 0.625rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: rgba(255, 255, 255, 0.65);
      }
      .cat-fab-total {
        font-variant-numeric: tabular-nums;
        font-size: 0.95rem;
        font-weight: 800;
      }
      @media (min-width: 900px) {
        .cat-fab {
          left: auto;
          margin: 0;
          right: max(1.5rem, env(safe-area-inset-right));
          bottom: max(1.5rem, env(safe-area-inset-bottom));
          max-width: 280px;
        }
      }

      .cat-drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        opacity: 0;
        visibility: hidden;
        transition: opacity 220ms var(--ease-standard), visibility 220ms;
        z-index: 100;
        backdrop-filter: blur(2px);
      }
      .cat-drawer-backdrop.open {
        opacity: 1;
        visibility: visible;
      }

      .cat-drawer {
        position: fixed;
        top: 0;
        right: 0;
        height: 100dvh;
        width: min(380px, 100vw);
        background: var(--card-bg);
        z-index: 101;
        display: flex;
        flex-direction: column;
        box-shadow: -12px 0 32px -8px rgba(0, 0, 0, 0.2);
        transform: translateX(100%);
        transition: transform 320ms var(--ease-emphasized);
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-right: env(safe-area-inset-right);
      }
      .cat-drawer.open { transform: translateX(0); }

      .cat-drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 1.25rem 1.25rem 0.875rem;
        border-bottom: 1px solid var(--border-color);
      }
      .cat-drawer-eyebrow {
        display: block;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 0.25rem;
      }
      .cat-drawer-head h3 {
        margin: 0;
        font-family: var(--font-display, inherit);
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--text-main);
      }
      .cat-drawer-close {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: var(--neutral-100);
        border: none;
        cursor: pointer;
        color: var(--text-muted);
        display: grid;
        place-items: center;
      }
      .cat-drawer-close:hover { background: var(--neutral-200); color: var(--text-main); }

      .cat-drawer-body {
        flex: 1;
        padding: 1.25rem;
        overflow-y: auto;
      }
      .cat-drawer-empty {
        text-align: center;
        padding: 2.5rem 1rem;
        color: var(--text-muted);
      }
      .cat-drawer-empty i {
        font-size: 2.5rem;
        display: block;
        margin-bottom: 0.75rem;
        color: var(--text-faint);
      }
      .cat-drawer-msg {
        margin: 0 0 1rem;
        color: var(--text-muted);
        font-size: 0.9375rem;
      }
      .cat-drawer-total {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 1rem;
        background: var(--neutral-100);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        border-left: 3px solid var(--brand-500);
      }
      .cat-drawer-total span {
        font-size: 0.8125rem;
        color: var(--text-muted);
        font-weight: 600;
      }
      .cat-drawer-total b {
        font-size: 1.375rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
      }

      .cat-drawer-foot {
        display: flex;
        gap: 0.5rem;
        padding: 1rem 1.25rem 1.25rem;
        border-top: 1px solid var(--border-color);
      }
      .cat-drawer-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        padding: 0.75rem 1rem;
        border-radius: 10px;
        font-weight: 700;
        font-size: 0.875rem;
        cursor: pointer;
        border: none;
        transition: filter 150ms var(--ease-standard), background-color 150ms var(--ease-standard);
      }
      .cat-drawer-btn-secondary {
        background: var(--neutral-100);
        color: var(--text-main);
      }
      .cat-drawer-btn-secondary:hover { background: var(--neutral-200); }
      .cat-drawer-btn-primary {
        background: var(--neutral-900);
        color: #fff;
      }
      .cat-drawer-btn-primary:hover:not(:disabled) {
        filter: brightness(1.18);
        box-shadow: inset 0 -2px 0 var(--brand-500);
      }
      .cat-drawer-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

      /* ── PRODUCT DETAIL SHEET ─────────────────────────────────── */
      .cat-sheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        opacity: 0;
        visibility: hidden;
        transition: opacity 220ms var(--ease-standard), visibility 220ms;
        z-index: 110;
        backdrop-filter: blur(4px);
      }
      .cat-sheet-backdrop.open { opacity: 1; visibility: visible; }

      .cat-sheet {
        position: fixed;
        z-index: 111;
        background: var(--card-bg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.35);

        /* Mobile: bottom sheet desde abajo */
        left: 0;
        right: 0;
        bottom: 0;
        max-height: 88dvh;
        border-radius: 20px 20px 0 0;
        transform: translateY(100%);
        transition: transform 360ms cubic-bezier(0.2, 0, 0, 1);
        padding-bottom: env(safe-area-inset-bottom);
      }
      .cat-sheet.open { transform: translateY(0); }

      @media (min-width: 720px) {
        /* Desktop / tablet: popover centrado */
        .cat-sheet {
          left: 50%;
          right: auto;
          bottom: auto;
          top: 50%;
          width: min(440px, 90vw);
          max-height: 86dvh;
          border-radius: 18px;
          transform: translate(-50%, calc(-50% + 24px));
          opacity: 0;
          transition: transform 320ms cubic-bezier(0.34, 1.4, 0.5, 1), opacity 220ms ease;
        }
        .cat-sheet.open {
          transform: translate(-50%, -50%);
          opacity: 1;
        }
      }

      .cat-sheet-close {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 2;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.9);
        border: none;
        color: var(--text-main);
        cursor: pointer;
        display: grid;
        place-items: center;
        backdrop-filter: blur(8px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      }
      .cat-sheet-close:hover { background: #fff; transform: scale(1.06); }

      .cat-sheet-img {
        width: 100%;
        aspect-ratio: 16 / 9;
        display: grid;
        place-items: center;
        color: rgba(255, 255, 255, 0.92);
        font-size: clamp(3.5rem, 12vw, 5rem);
        font-weight: 900;
        letter-spacing: -0.02em;
        position: relative;
        overflow: hidden;
      }
      .cat-sheet-img::after {
        content: '';
        position: absolute;
        inset: 0;
        background:
          radial-gradient(60% 50% at 30% 25%, rgba(255,255,255,0.20), transparent 60%),
          radial-gradient(80% 60% at 80% 90%, rgba(0,0,0,0.20), transparent 60%);
        pointer-events: none;
      }
      .cat-sheet-img.has-photo {
        background: var(--surface-card, #fff) !important;
      }
      .cat-sheet-img-real {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 16px;
      }
      .cat-sheet-img-initials {
        position: relative;
        z-index: 1;
        text-shadow: 0 2px 14px rgba(0, 0, 0, 0.18);
      }

      .cat-sheet-body {
        padding: 1.25rem 1.25rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.875rem;
        overflow-y: auto;
      }

      .cat-sheet-brand {
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
      }
      .cat-sheet-name {
        margin: 0;
        font-family: var(--font-display, inherit);
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--text-main);
        letter-spacing: -0.02em;
        line-height: 1.2;
      }

      .cat-sheet-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
      }
      .cat-sheet-meta-item {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-muted);
        background: var(--neutral-100);
        padding: 0.3rem 0.625rem;
        border-radius: 999px;
      }
      .cat-sheet-meta-item i { font-size: 0.7rem; }
      .cat-sheet-meta-warn {
        color: var(--bad-fg);
        background: var(--bad-soft-bg);
      }

      .cat-sheet-qty-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.75rem 0.875rem;
        background: var(--neutral-100);
        border-radius: 14px;
        margin-top: 0.25rem;
      }
      .cat-sheet-qty-label {
        font-size: 0.875rem;
        font-weight: 700;
        color: var(--text-main);
      }
      .cat-sheet-stepper {
        display: inline-flex;
        align-items: center;
        height: 42px;
        background: var(--card-bg);
        border: 1.5px solid var(--border-color);
        border-radius: 999px;
        overflow: hidden;
      }
      .cat-sheet-stepper-btn {
        width: 40px;
        height: 100%;
        background: transparent;
        border: none;
        color: var(--text-main);
        cursor: pointer;
        display: grid;
        place-items: center;
        font-size: 0.875rem;
        transition: background-color 120ms var(--ease-standard);
      }
      .cat-sheet-stepper-btn:hover:not(:disabled) { background: var(--neutral-100); }
      .cat-sheet-stepper-btn:active:not(:disabled) { transform: scale(0.92); }
      .cat-sheet-stepper-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .cat-sheet-qty-val {
        min-width: 40px;
        text-align: center;
        font-size: 1.0625rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        color: var(--text-main);
        padding: 0 0.25rem;
      }

      .cat-sheet-subtotal {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 0.875rem 1rem;
        background: var(--neutral-100);
        border-left: 3px solid var(--brand-500);
        border-radius: 10px;
      }
      .cat-sheet-subtotal span {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
      }
      .cat-sheet-subtotal b {
        font-size: 1.375rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.015em;
      }

      .cat-sheet-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.25rem;
      }
      .cat-sheet-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        padding: 0.875rem 1rem;
        border-radius: 12px;
        font-weight: 700;
        font-size: 0.875rem;
        cursor: pointer;
        border: none;
        transition: filter 150ms var(--ease-standard), background-color 150ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .cat-sheet-btn-secondary {
        background: var(--neutral-100);
        color: var(--text-main);
      }
      .cat-sheet-btn-secondary:hover { background: var(--neutral-200); }
      .cat-sheet-btn-primary {
        flex: 2;
        background: var(--neutral-950);
        color: #fff;
      }
      .cat-sheet-btn-primary:hover:not(:disabled) {
        filter: brightness(1.18);
        box-shadow: inset 0 -2px 0 var(--brand-500);
      }
      .cat-sheet-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalCatalogComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  readonly cart = inject(PortalService);

  readonly isAdmin = signal<boolean>(this.auth.user()?.role_name === 'superadmin');
  readonly loading = signal(true);
  readonly prices = signal<PriceRow[]>([]);
  readonly customerName = signal<string>('');
  readonly customerId = signal<string>('');
  readonly warehouseId = signal<string>('');
  readonly selectedBrandId = signal<string>('__all__');
  readonly searchSignal = signal<string>('');
  readonly drawerOpen = signal(false);

  /**
   * Productos que el customer ya pidió (90d). Driver del chip "Reordenar".
   * Vacío para admins/superadmin (no hay customer linkeado) o clientes nuevos
   * sin historial — el chip se oculta en ese caso.
   */
  readonly historyProducts = signal<CatalogHistoryRow[]>([]);
  /**
   * Canasta IA D.4 hidratada (chip "Sugeridos IA"). Cubre a customers sin
   * historial recurrente — la heurística mezcla base + focus + exploration +
   * innovation, así que casi siempre devuelve algo si el tenant tiene ventas.
   */
  readonly suggestedProducts = signal<CatalogSuggestedRow[]>([]);
  /**
   * Productos con promoción activa (chip "Con promo"). Una promo por
   * producto (la de mayor priority cuando aplica más de una).
   */
  readonly promoProducts = signal<CatalogWithPromoRow[]>([]);
  /**
   * Atajo personalizado activo. `null` = catálogo completo + brand filter.
   */
  readonly quickFilter = signal<'reorder' | 'suggested' | 'promo' | null>(null);

  /**
   * Top sellers del tenant (MV products_top_sellers — top 1000 últimos 90d).
   * Drive del strip "Más vendidos" al inicio del catálogo. Crece con volumen
   * real de ventas — al inicio puede tener pocos rows.
   */
  readonly topSellers = signal<PriceRow[]>([]);

  /** Counts agregados del backend para drive del panel de filtros. */
  readonly facets = signal<CatalogFacets | null>(null);
  /** Panel de filtros abierto/cerrado (desktop y mobile lo comparten). */
  readonly filtersOpen = signal<boolean>(false);
  /**
   * Bucket de precio activo (uno solo) — referencia al objeto del facets para
   * que el matcheo del computed sea por identidad (max=null = "más de X").
   */
  readonly priceBucket = signal<{ min: number; max: number | null } | null>(null);
  /** Toggle "solo con stock" (requiere warehouseId, sino el filtro no aplica). */
  readonly onlyWithStock = signal<boolean>(false);
  /** Search interno dentro del panel para los 30+ brands top. */
  readonly brandPanelSearch = signal<string>('');

  /**
   * # de filtros del panel activos (excluye los quick-chips y el search top).
   * Drive del badge "Filtros (N)" cuando hay algo aplicado.
   */
  readonly activeFiltersCount = computed<number>(() => {
    let n = 0;
    if (this.selectedBrandId() !== '__all__') n++;
    if (this.priceBucket()) n++;
    if (this.onlyWithStock()) n++;
    return n;
  });

  /**
   * Render-budget: cuántos cards del grid renderizar en DOM. Antes
   * cargábamos los 7,569 cards de una → lag de scroll en mobile y CD lento.
   * Ahora: 60 iniciales + 60 por batch al scrollear cerca del fondo (via
   * IntersectionObserver sobre `#scrollSentinel`). Reset a 60 cuando cambia
   * el set visible (filtro nuevo / search / quick-chip).
   */
  /**
   * Server-side pagination — el backend filtra y pagina. `prices()` acumula
   * los resultados del fetch inicial + las páginas siguientes cargadas vía
   * IntersectionObserver. Los quick-chips (history/suggested/promo) usan
   * sus propios endpoints (sets chicos) y no pasan por aquí.
   */
  private readonly PAGE_SIZE = 60;
  readonly currentPage = signal<number>(1);
  readonly totalCount = signal<number>(0);
  readonly loadingMore = signal<boolean>(false);
  readonly hasMorePages = computed<boolean>(() => {
    if (this.quickFilter()) return false;
    return this.prices().length < this.totalCount();
  });

  private _sentinelEl?: HTMLElement;
  @ViewChild('scrollSentinel')
  set scrollSentinelRef(ref: ElementRef<HTMLElement> | undefined) {
    // Setter porque el `*ngIf` del sentinel hace que el elemento aparezca y
    // desaparezca. Reobserva siempre que cambia la referencia (o desconecta
    // si quedó null).
    if (this._sentinelEl && this.scrollObserver) {
      this.scrollObserver.unobserve(this._sentinelEl);
    }
    this._sentinelEl = ref?.nativeElement;
    if (this._sentinelEl && this.scrollObserver) {
      this.scrollObserver.observe(this._sentinelEl);
    }
  }
  private scrollObserver?: IntersectionObserver;

  constructor() {
    // Effect: cuando cambian los filtros del panel (brand / bucket / stock)
    // → reset y fetch page 1 server-side. Search NO va aquí — usa su propio
    // pipeline con debounce en wireSmartSearch para no spamear al backend.
    effect(() => {
      // Dependencias explícitas que disparan el refetch.
      this.selectedBrandId();
      this.priceBucket();
      this.onlyWithStock();
      untracked(() => {
        // Solo dispara si ya pasamos por el load inicial (`prices` no vacío
        // o totalCount seteado). Sin esto el effect corre al construir el
        // componente cuando warehouseId aún es '' y mete una request basura.
        if (this.totalCount() > 0 || this.prices().length > 0) {
          this.resetAndFetch();
        }
      });
    });
  }

  readonly aiSearch = signal(false);
  readonly searching = signal(false);
  readonly smartResults = signal<SmartSearchResult[]>([]);
  readonly smartMode = signal<'semantic' | 'fallback_like' | null>(null);
  readonly scoreById = signal<Record<string, number>>({});
  readonly searchHistory = signal<string[]>([]);
  private readonly searchSubject = new Subject<string>();
  private readonly HISTORY_KEY = 'portal:catalog:search-history';
  private readonly HISTORY_LIMIT = 6;

  search = '';
  qtyByProduct: Record<string, number> = {};
  adding: Record<string, boolean> = {};

  /**
   * Sheet de detalle del producto (se abre con el botón `+`).
   * Muestra info extra del producto + stepper grande + botón "Agregar al carrito".
   * El commit es explícito (no auto-debounce).
   */
  readonly sheetProductId = signal<string | null>(null);
  readonly sheetQty = signal<number>(1);
  readonly sheetProduct = computed<PriceRow | null>(() => {
    const id = this.sheetProductId();
    if (!id) return null;
    return this.prices().find((p) => p.product_id === id) || null;
  });
  readonly sheetSubtotal = computed<number>(() => {
    const p = this.sheetProduct();
    if (!p) return 0;
    return this.sheetQty() * (Number(p.price) || 0);
  });


  /**
   * Index product_id → metadata de su promo activa. Permite al template
   * decorar el card del catálogo completo con un badge "Con promo", no solo
   * cuando el chip está activo. Lookup O(1).
   */
  readonly promoByProductId = computed<Record<string, { promo_code: string; promo_name: string; promo_type: string }>>(() => {
    const out: Record<string, { promo_code: string; promo_name: string; promo_type: string }> = {};
    for (const p of this.promoProducts()) {
      out[p.product_id] = {
        promo_code: p.promo_code,
        promo_name: p.promo_name,
        promo_type: p.promo_type,
      };
    }
    return out;
  });

  readonly brands = computed<BrandGroup[]>(() => {
    const map = new Map<string, BrandGroup>();
    for (const p of this.prices()) {
      const bid = p.brand_id || '__unknown__';
      const bname = p.brand_name || 'Sin marca';
      const g = map.get(bid) || {
        brand_id: bid,
        brand_name: bname,
        count: 0,
        color: 'var(--neutral-100)',
        initial: initial(bname),
      };
      g.count++;
      map.set(bid, g);
    }
    return [...map.values()].sort((a, b) => a.brand_name.localeCompare(b.brand_name));
  });

  readonly visibleProducts = computed<PriceRow[]>(() => {
    // Modo IA: el orden viene del KNN backend (no aplicamos brand filter local
    // porque sería contraintuitivo — el usuario pidió por semántica, no por marca).
    if (this.aiSearch() && this.searchSignal().trim()) {
      return this.smartResults().map((r) => ({
        id: r.product_id,
        product_id: r.product_id,
        product_name: r.product_name,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        price: r.price,
        tax_rate: r.tax_rate,
        min_qty: r.min_qty,
        stock_available: r.stock_available,
      }));
    }
    const term = this.searchSignal().trim().toLowerCase();

    // Quick filters: el set base viene del backend ya ordenado (frecuencia
    // para 'reorder', score IA para 'suggested'). Brand filter no aplica
    // para no confundir al cliente — la idea es "ver mi short-list", no
    // recortarla más.
    const qf = this.quickFilter();
    if (qf === 'reorder' || qf === 'suggested' || qf === 'promo') {
      let arr: PriceRow[] =
        qf === 'reorder' ? this.historyProducts()
        : qf === 'suggested' ? this.suggestedProducts()
        : this.promoProducts();
      if (term) {
        arr = arr.filter(
          (p) =>
            (p.product_name || '').toLowerCase().includes(term) ||
            (p.brand_name || '').toLowerCase().includes(term),
        );
      }
      return arr;
    }

    // Catálogo paginado: `prices()` ya viene filtrado por el backend con
    // brand/price/stock/q. No re-filtramos local — sería incorrecto contra
    // un set parcial (página 1 de N) y duplicaría trabajo del SQL.
    return this.prices();
  });

  readonly selectedBrandName = computed<string>(() => {
    if (this.aiSearch() && this.searchSignal().trim()) {
      return `Resultados para "${this.searchSignal().trim()}"`;
    }
    if (this.quickFilter() === 'reorder') {
      return 'Para reordenar — productos que ya pediste';
    }
    if (this.quickFilter() === 'suggested') {
      return 'Sugeridos para ti — canasta IA';
    }
    if (this.quickFilter() === 'promo') {
      return 'En promoción — descuentos vigentes';
    }
    const bid = this.selectedBrandId();
    if (bid === '__all__') return 'Todos los productos';
    const b = this.brands().find((x) => x.brand_id === bid);
    return b ? b.brand_name : '—';
  });

  ngOnInit(): void {
    this.loadAll();
    this.wireSmartSearch();
    this.loadHistory();
  }

  ngAfterViewInit(): void {
    // SSR-safe: IntersectionObserver no existe en server-side. La app es CSR
    // (Capacitor + browser puro) pero por defensividad chequeamos.
    if (typeof IntersectionObserver === 'undefined') return;
    this.scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && this.hasMorePages()) {
            this.loadNextPage();
          }
        }
      },
      // `rootMargin` 400px: empezar a cargar el siguiente batch ANTES de que
      // el sentinel sea visible — el usuario no debería ver el "Cargando..."
      // a menos que tipee scroll muy rápido.
      { rootMargin: '400px 0px' },
    );
    // Si el ViewChild ya se asignó antes del ngAfterViewInit (setter corrió
    // primero), reobservamos. Sino, el setter lo hará cuando el *ngIf monte.
    if (this._sentinelEl) {
      this.scrollObserver.observe(this._sentinelEl);
    }
  }

  ngOnDestroy(): void {
    this.scrollObserver?.disconnect();
  }

  private wireSmartSearch(): void {
    // Search debounced. Bifurca según `aiSearch()`:
    //   - aiSearch=true  → /catalog/search (vectorial Voyage + pgvector)
    //   - aiSearch=false → /catalog/products?q=... (ILIKE server-side paginado)
    // En ambos casos respetamos el quick-chip: si reorder/suggested/promo está
    // activo, el filtro corre en cliente sobre ese set (ver visibleProducts).
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((q) => {
        const term = (q || '').trim();
        if (this.aiSearch()) {
          if (!term) {
            this.searching.set(false);
            this.smartResults.set([]);
            this.smartMode.set(null);
            return;
          }
          this.searching.set(true);
          this.api.smartSearch(term, 24).subscribe({
            next: (res: any) => {
              this.searching.set(false);
              if (res && Array.isArray(res.results)) {
                this.smartResults.set(res.results);
                this.smartMode.set(res.mode);
                const scores: Record<string, number> = {};
                for (const r of res.results) scores[r.product_id] = r.score;
                this.scoreById.set(scores);
                this.pushHistory(this.search);
              }
            },
            error: () => {
              this.searching.set(false);
              this.smartResults.set([]);
              this.smartMode.set(null);
              this.scoreById.set({});
            },
          });
        } else {
          // Search regular: si hay quick-chip activo, el filtro se hace en
          // cliente vía visibleProducts (sobre history/suggested/promo).
          // Sin quick-chip, refetch del catálogo paginado.
          if (!this.quickFilter()) {
            this.resetAndFetch();
          }
          if (term) this.pushHistory(term);
        }
      });
  }

  private loadHistory(): void {
    try {
      const raw = localStorage.getItem(this.HISTORY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) this.searchHistory.set(arr.slice(0, this.HISTORY_LIMIT));
      }
    } catch { /* ignore corrupt storage */ }
  }

  private pushHistory(q: string): void {
    const t = (q || '').trim();
    if (!t || t.length < 3) return;
    const next = [t, ...this.searchHistory().filter((x) => x.toLowerCase() !== t.toLowerCase())]
      .slice(0, this.HISTORY_LIMIT);
    this.searchHistory.set(next);
    try { localStorage.setItem(this.HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  clearHistory(): void {
    this.searchHistory.set([]);
    try { localStorage.removeItem(this.HISTORY_KEY); } catch { /* ignore */ }
  }

  useHistory(q: string): void {
    this.search = q;
    this.searchSignal.set(q);
    if (!this.aiSearch()) this.aiSearch.set(true);
    this.searchSubject.next(q);
  }

  productScore(p: PriceRow): number | null {
    if (!this.aiSearch() || !this.searchSignal().trim()) return null;
    const s = this.scoreById()[p.product_id];
    return typeof s === 'number' ? Math.round(s * 100) : null;
  }

  toggleAiSearch(): void {
    const next = !this.aiSearch();
    this.aiSearch.set(next);
    if (next && this.search.trim()) {
      this.searchSubject.next(this.search);
    } else {
      this.smartResults.set([]);
      this.smartMode.set(null);
    }
  }

  private loadAll(): void {
    this.loading.set(true);

    // Nuevo flujo: el catálogo es la tabla `public.products` (la del RAG), no
    // `commercial.product_prices`. El backend `/catalog/products` hace LEFT JOIN
    // al precio del customer y al stock del warehouse, devolviendo TODOS los
    // productos activos del tenant. price=null si no hay precio configurado.
    const wsLoader = this.api.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef));

    if (this.isAdmin()) {
      this.customerName.set('Vista admin — sin customer linkeado');
      wsLoader.subscribe({
        next: (warehouses) => {
          const defaultWh = warehouses.find((w: any) => w.is_default) || warehouses[0];
          this.warehouseId.set(defaultWh?.id || '');
          this.fetchCatalog();
        },
        error: () => this.loading.set(false),
      });
      return;
    }

    forkJoin({
      customer: this.api.myCustomerInfo(),
      warehouses: this.api.listWarehouses(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ customer, warehouses }) => {
          if (!customer) {
            this.toast.add({
              severity: 'error',
              summary: 'Sin customer',
              detail: 'Tu usuario no está linkeado a un cliente B2B.',
            });
            this.loading.set(false);
            return;
          }
          this.customerName.set(customer.name);
          this.customerId.set(customer.id);
          const defaultWh = warehouses.find((w: any) => w.is_default) || warehouses[0];
          this.warehouseId.set(defaultWh?.id || '');
          this.fetchCatalog();
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
          this.loading.set(false);
        },
      });
  }

  private fetchCatalog(): void {
    // Catálogo paginado server-side. La página 1 se trae acá; las siguientes
    // se cargan via IntersectionObserver cuando el sentinel entra al viewport.
    this.loading.set(true);
    this.loadCatalogPage(1, /* replace */ true);

    // Cargar historial + canasta IA en paralelo. Para admin/sin customer
    // ambos endpoints devuelven [] (no error), así que los chips
    // simplemente no aparecen. La canasta IA puede demorar más (compute
    // si está stale >24h) — el chip aparece cuando termina, lazy.
    const wh = this.warehouseId() || undefined;
    this.api.myCatalogHistory(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.historyProducts.set(rows);
          rows.forEach((r) => {
            if (!this.qtyByProduct[r.product_id]) {
              this.qtyByProduct[r.product_id] = r.min_qty || 1;
            }
          });
        },
        error: () => this.historyProducts.set([]),
      });

    this.api.myCatalogSuggested(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.suggestedProducts.set(rows);
          rows.forEach((r) => {
            if (!this.qtyByProduct[r.product_id]) {
              this.qtyByProduct[r.product_id] = r.min_qty || 1;
            }
          });
        },
        error: () => this.suggestedProducts.set([]),
      });

    // Top sellers del tenant (MV refrescada cada 15min). Resuelve price_list
    // del customer via myCustomerInfo (default_price_list_id). Si no hay
    // customer o no tiene price_list asignada, el strip queda vacío sin error.
    this.api.myCustomerInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (customer: any) => {
          const plId = customer?.default_price_list_id;
          if (!plId) {
            this.topSellers.set([]);
            return;
          }
          this.api.listTopSellers(plId, wh, 1000)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (rows) => this.topSellers.set(rows || []),
              error: () => this.topSellers.set([]),
            });
        },
        error: () => this.topSellers.set([]),
      });

    this.api.myCatalogWithPromo(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.promoProducts.set(rows);
          rows.forEach((r) => {
            if (!this.qtyByProduct[r.product_id]) {
              this.qtyByProduct[r.product_id] = r.min_qty || 1;
            }
          });
        },
        error: () => this.promoProducts.set([]),
      });

    // Facets del backend — counts reales para los chips del panel.
    this.api.catalogFacets(wh, 30)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (f) => this.facets.set(f),
        error: () => this.facets.set(null),
      });
  }

  selectBrand(brandId: string): void {
    this.selectedBrandId.set(brandId);
  }

  /**
   * Fetch de UNA página del catálogo paginado. Si `replace=true`, reemplaza
   * `prices()` (usado para page 1 y resets). Si `false`, append (usado para
   * infinite scroll). `loadingMore` lockea contra carrera con observer.
   */
  private loadCatalogPage(page: number, replace: boolean): void {
    if (this.loadingMore()) return;
    this.loadingMore.set(true);
    const bid = this.selectedBrandId();
    const bucket = this.priceBucket();
    this.api
      .listCatalogPage({
        warehouseId: this.warehouseId() || undefined,
        page,
        pageSize: this.PAGE_SIZE,
        q: this.searchSignal().trim() || undefined,
        brandId: bid !== '__all__' ? bid : undefined,
        priceMin: bucket?.min,
        priceMax: bucket?.max ?? undefined,
        hasStock: this.onlyWithStock() || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (replace) this.prices.set(r.data);
          else this.prices.update((arr) => [...arr, ...r.data]);
          r.data.forEach((p) => {
            if (!this.qtyByProduct[p.product_id]) {
              this.qtyByProduct[p.product_id] = p.min_qty || 1;
            }
          });
          this.totalCount.set(r.pagination.total);
          this.currentPage.set(r.pagination.page);
          this.loadingMore.set(false);
          this.loading.set(false);
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
          if (replace) this.prices.set([]);
          this.loadingMore.set(false);
          this.loading.set(false);
        },
      });
  }

  /** Reset al cambiar filtros del panel o search — vuelve a página 1. */
  private resetAndFetch(): void {
    this.currentPage.set(1);
    this.loadCatalogPage(1, /* replace */ true);
  }

  /** Disparado por IntersectionObserver al ver el sentinel. */
  private loadNextPage(): void {
    if (!this.hasMorePages() || this.loadingMore()) return;
    this.loadCatalogPage(this.currentPage() + 1, /* replace */ false);
  }

  openFilters(): void { this.filtersOpen.set(true); }
  closeFilters(): void { this.filtersOpen.set(false); }

  togglePriceBucket(b: { min: number; max: number | null }): void {
    const cur = this.priceBucket();
    const same = cur && cur.min === b.min && cur.max === b.max;
    this.priceBucket.set(same ? null : { min: b.min, max: b.max });
  }

  toggleStockOnly(): void {
    this.onlyWithStock.set(!this.onlyWithStock());
  }

  /** Limpiar TODOS los filtros del panel (no quick-chips ni search). */
  clearPanelFilters(): void {
    this.selectedBrandId.set('__all__');
    this.priceBucket.set(null);
    this.onlyWithStock.set(false);
    this.brandPanelSearch.set('');
  }

  /**
   * Filtrado del listado de brands del panel: aplica el search interno del
   * panel sobre los top-N que vienen del facets. Para "ver todas" hace falta
   * un endpoint paginado dedicado (futuro).
   */
  readonly filteredBrandFacets = computed(() => {
    const f = this.facets();
    if (!f) return [];
    const term = this.brandPanelSearch().trim().toLowerCase();
    if (!term) return f.brands;
    return f.brands.filter((b) =>
      (b.brand_name || '').toLowerCase().includes(term),
    );
  });

  /**
   * Label corto del pill de promo en el card. La descripción larga del
   * descuento (porcentaje, tiers, n×m, bundle) requiere parsear `rules` —
   * el portal-promotions ya lo hace y es trabajo aparte. Acá solo tipo.
   */
  promoLabel(type: string): string {
    switch (type) {
      case 'percent_off_product': return '% OFF';
      case 'nxm': return 'N×M';
      case 'volume_discount': return 'Volumen';
      case 'bundle_fixed_price': return 'Combo';
      case 'cross_sell_discount': return 'Cross-sell';
      default: return 'Promo';
    }
  }

  /**
   * Activa/desactiva un atajo personalizado. Click sobre el mismo chip lo
   * apaga (vuelve al catálogo completo); click sobre otro lo cambia.
   */
  toggleQuickFilter(key: 'reorder' | 'suggested' | 'promo'): void {
    this.quickFilter.set(this.quickFilter() === key ? null : key);
    // Salir de IA / search al cambiar de modo — sino el grid queda en estado
    // raro mostrando KNN results del catálogo completo cuando el user pidió
    // "lo que ya compré" o "lo sugerido".
    if (this.quickFilter() && this.aiSearch()) {
      this.aiSearch.set(false);
      this.smartResults.set([]);
      this.smartMode.set(null);
    }
  }

  onSearchChange(v: string): void {
    this.searchSignal.set(v);
    // Siempre disparar el subject — wireSmartSearch decide adónde va el query
    // (smart-search IA si aiSearch=true, /catalog/products?q=... sino).
    this.searchSubject.next(v);
  }

  clearSearch(): void {
    this.search = '';
    this.searchSignal.set('');
    this.smartResults.set([]);
    this.smartMode.set(null);
    // Refetch sin q solo si no hay quick-chip activo (sino el filtro va sobre
    // el set in-memory del quick-chip).
    if (!this.quickFilter() && !this.loading()) {
      this.resetAndFetch();
    }
  }

  inc(p: PriceRow): void {
    this.qtyByProduct[p.product_id] = (Number(this.qtyByProduct[p.product_id]) || p.min_qty) + 1;
  }

  dec(p: PriceRow): void {
    const cur = Number(this.qtyByProduct[p.product_id]) || p.min_qty;
    this.qtyByProduct[p.product_id] = Math.max(p.min_qty, cur - 1);
  }

  addToCart(p: PriceRow): void {
    if (this.isAdmin()) {
      this.toast.add({
        severity: 'info',
        summary: 'Vista admin',
        detail: 'Solo lectura. Iniciá sesión como cliente para agregar al carrito.',
      });
      return;
    }
    if (!this.customerId() || !this.warehouseId()) {
      this.toast.add({
        severity: 'error',
        summary: 'No se pudo agregar',
        detail: 'Falta customer o warehouse. Recargá la página.',
      });
      return;
    }
    if (p.price == null) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin precio',
        detail: 'Este producto no tiene precio configurado para tu lista. Contactá a soporte.',
      });
      return;
    }
    const qty = Number(this.qtyByProduct[p.product_id]) || p.min_qty;
    if (qty < p.min_qty) {
      this.toast.add({
        severity: 'warn',
        summary: 'Cantidad mínima',
        detail: `Este producto requiere mínimo ${p.min_qty} unidades.`,
      });
      return;
    }
    this.adding[p.product_id] = true;
    this.api.ensureDraft(this.customerId(), this.warehouseId()).subscribe({
      next: (draft) => {
        this.api.addLine(draft.id, p.product_id, qty).subscribe({
          next: () => {
            this.adding[p.product_id] = false;
            this.toast.add({
              severity: 'success',
              summary: 'Agregado',
              detail: `${qty}× ${p.product_name}`,
              life: 2000,
            });
            this.openDrawer();
          },
          error: (err) => {
            this.adding[p.product_id] = false;
            this.toast.add({
              severity: 'error',
              summary: 'No se pudo agregar',
              detail: err.error?.message || err.message,
            });
          },
        });
      },
      error: (err) => {
        this.adding[p.product_id] = false;
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo crear el carrito',
          detail: err.error?.message || err.message,
        });
      },
    });
  }

  openDrawer(): void {
    this.drawerOpen.set(true);
    this.cart.refreshCartDetail();
  }
  closeDrawer(): void { this.drawerOpen.set(false); }

  bumpDrawerQty(line: any, delta: number): void {
    const cid = this.cart.cartId();
    if (!cid) return;
    const next = Math.max(1, Number(line.quantity) + delta);
    if (next === Number(line.quantity)) return;
    this.api.updateLine(cid, line.id, next).subscribe({
      error: (err) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        }),
    });
  }

  removeDrawerLine(line: any): void {
    const cid = this.cart.cartId();
    if (!cid) return;
    this.api.removeLine(cid, line.id).subscribe({
      error: (err) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        }),
    });
  }

  trackByLineId = (_i: number, l: any) => l.id;

  shortId(id: string): string {
    return id?.slice(0, 8) || '—';
  }

  lineGradient(_productId: string): string {
    // Estilo Rappi: avatares neutros, no colorful per-product (eso se ve a AI).
    return 'var(--neutral-100)';
  }

  goCart(): void {
    this.closeDrawer();
    this.router.navigateByUrl('/portal/cart');
  }

  trackByProduct(_i: number, p: PriceRow): string { return p.product_id; }
  trackByBrand(_i: number, b: BrandGroup): string { return b.brand_id; }
  trackByString = (_i: number, s: string) => s;
  trackByBrandFacet = (_i: number, b: { brand_id: string | null }) => b.brand_id || '__unknown__';
  trackByBucket = (_i: number, b: { min: number; max: number | null }) => `${b.min}-${b.max ?? 'inf'}`;

  hasQty(p: PriceRow): boolean {
    return this.isInCart(p);
  }

  isInCart(p: PriceRow): boolean {
    const lines = this.cart.cartDetail()?.lines;
    if (!lines) return false;
    return lines.some((l: any) => l.product_id === p.product_id);
  }

  cartLineQty(p: PriceRow): number {
    const lines = this.cart.cartDetail()?.lines;
    if (!lines) return 0;
    const line = lines.find((l: any) => l.product_id === p.product_id);
    return line ? Number(line.quantity) || 0 : 0;
  }

  private cartLineFor(p: PriceRow): any | null {
    const lines = this.cart.cartDetail()?.lines;
    if (!lines) return null;
    return lines.find((l: any) => l.product_id === p.product_id) || null;
  }

  // ── Sheet de detalle del producto ──────────────────────────────
  openSheet(p: PriceRow): void {
    if (this.isAdmin()) {
      this.toast.add({
        severity: 'info',
        summary: 'Vista admin',
        detail: 'Solo lectura. Iniciá sesión como cliente para agregar.',
      });
      return;
    }
    this.sheetQty.set(p.min_qty || 1);
    this.sheetProductId.set(p.product_id);
  }

  closeSheet(): void {
    this.sheetProductId.set(null);
  }

  sheetInc(): void {
    this.sheetQty.update((v) => v + 1);
  }

  sheetDec(): void {
    const p = this.sheetProduct();
    const min = p?.min_qty || 1;
    this.sheetQty.update((v) => Math.max(min, v - 1));
  }

  confirmAddFromSheet(): void {
    const p = this.sheetProduct();
    if (!p) return;
    const qty = this.sheetQty();
    if (qty < (p.min_qty || 1)) {
      this.toast.add({
        severity: 'warn',
        summary: 'Cantidad mínima',
        detail: `Este producto requiere mínimo ${p.min_qty} unidad(es).`,
      });
      return;
    }
    const id = p.product_id;
    this.adding[id] = true;
    this.api.ensureDraft(this.customerId(), this.warehouseId()).subscribe({
      next: (draft) => {
        this.api.addLine(draft.id, id, qty).subscribe({
          next: () => {
            this.adding[id] = false;
            this.toast.add({
              severity: 'success',
              summary: 'Agregado',
              detail: `${qty}× ${p.product_name}`,
              life: 1800,
            });
            this.closeSheet();
          },
          error: (err) => {
            this.adding[id] = false;
            this.toast.add({
              severity: 'error',
              summary: 'No se pudo agregar',
              detail: err.error?.message || err.message,
            });
          },
        });
      },
      error: (err) => {
        this.adding[id] = false;
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo crear carrito',
          detail: err.error?.message || err.message,
        });
      },
    });
  }

  incrementCartLine(p: PriceRow): void {
    if (this.isAdmin()) return;
    const cid = this.cart.cartId();
    const line = this.cartLineFor(p);
    if (!cid || !line) return;
    const next = (Number(line.quantity) || 0) + 1;
    this.adding[p.product_id] = true;
    this.api.updateLine(cid, line.id, next).subscribe({
      next: () => { this.adding[p.product_id] = false; },
      error: (err) => {
        this.adding[p.product_id] = false;
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        });
      },
    });
  }

  decrementCartLine(p: PriceRow): void {
    if (this.isAdmin()) return;
    const cid = this.cart.cartId();
    const line = this.cartLineFor(p);
    if (!cid || !line) return;
    const cur = Number(line.quantity) || 0;
    this.adding[p.product_id] = true;
    if (cur <= 1) {
      this.api.removeLine(cid, line.id).subscribe({
        next: () => { this.adding[p.product_id] = false; },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.message || err.message,
          });
        },
      });
    } else {
      this.api.updateLine(cid, line.id, cur - 1).subscribe({
        next: () => { this.adding[p.product_id] = false; },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.message || err.message,
          });
        },
      });
    }
  }

  goAi(): void {
    this.router.navigateByUrl('/portal/recommendations');
  }

  brandColor(_brandId?: string | null): string {
    return 'var(--text-muted)';
  }

  cardGradient(_p: PriceRow): string {
    return 'var(--brand-50)';
  }

  private imgFailedSet = new Set<string>();

  hasImg(p: PriceRow): boolean {
    return !!p.image_url && !this.imgFailedSet.has(p.product_id);
  }

  onImgError(p: PriceRow): void {
    this.imgFailedSet.add(p.product_id);
  }

  productInitials(p: PriceRow): string {
    const name = p.product_name || '?';
    const words = name.trim().split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }

  private darken(hex: string, amount: number): string {
    const h = hex.replace('#', '');
    const r = Math.max(0, parseInt(h.slice(0, 2), 16) - Math.round(255 * amount));
    const g = Math.max(0, parseInt(h.slice(2, 4), 16) - Math.round(255 * amount));
    const b = Math.max(0, parseInt(h.slice(4, 6), 16) - Math.round(255 * amount));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
}
