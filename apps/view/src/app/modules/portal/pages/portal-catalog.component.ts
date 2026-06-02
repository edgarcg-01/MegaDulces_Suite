import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
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
import { PortalService, PriceRow, SmartSearchResult } from '../portal.service';
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

    <nav
      *ngIf="!loading() && prices().length > 0"
      class="cat-chip-rail"
      aria-label="Filtrar por marca"
    >
      <button
        type="button"
        class="cat-chip"
        [class.active]="selectedBrandId() === '__all__'"
        (click)="selectBrand('__all__')"
      >
        Todos
        <span class="cat-chip-count">{{ prices().length }}</span>
      </button>
      <button
        *ngFor="let b of brands(); trackBy: trackByBrand"
        type="button"
        class="cat-chip"
        [class.active]="selectedBrandId() === b.brand_id"
        (click)="selectBrand(b.brand_id)"
      >
        {{ b.brand_name }}
        <span class="cat-chip-count">{{ b.count }}</span>
      </button>
    </nav>

    <div *ngIf="!loading() && prices().length > 0" class="cat-layout">
      <section class="cat-main">
        <header class="cat-main-head">
          <h2>{{ selectedBrandName() }}</h2>
          <span class="cat-main-meta">
            {{ visibleProducts().length }} producto(s)
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
              [style.background]="cardGradient(p)"
            >
              <span class="cat-card-img-initials">{{ productInitials(p) }}</span>
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

        <div class="cat-sheet-img" [style.background]="cardGradient(sp)" aria-hidden="true">
          <span class="cat-sheet-img-initials">{{ productInitials(sp) }}</span>
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
export class PortalCatalogComponent implements OnInit {
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
    const bid = this.selectedBrandId();
    let arr = this.prices();
    if (bid !== '__all__') arr = arr.filter((p) => (p.brand_id || '__unknown__') === bid);
    if (term) {
      arr = arr.filter(
        (p) =>
          (p.product_name || '').toLowerCase().includes(term) ||
          (p.brand_name || '').toLowerCase().includes(term),
      );
    }
    return arr;
  });

  readonly selectedBrandName = computed<string>(() => {
    if (this.aiSearch() && this.searchSignal().trim()) {
      return `Resultados para "${this.searchSignal().trim()}"`;
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

  private wireSmartSearch(): void {
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((q) => {
          if (!q.trim() || !this.aiSearch()) {
            this.searching.set(false);
            return [];
          }
          this.searching.set(true);
          return this.api.smartSearch(q.trim(), 24);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
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
    this.api.listCatalogProducts(this.warehouseId() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.prices.set(rows);
          rows.forEach((r) => (this.qtyByProduct[r.product_id] = r.min_qty || 1));
          this.loading.set(false);
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
          this.prices.set([]);
          this.loading.set(false);
        },
      });
  }

  selectBrand(brandId: string): void {
    this.selectedBrandId.set(brandId);
  }

  onSearchChange(v: string): void {
    this.searchSignal.set(v);
    if (this.aiSearch()) this.searchSubject.next(v);
  }

  clearSearch(): void {
    this.search = '';
    this.searchSignal.set('');
    this.smartResults.set([]);
    this.smartMode.set(null);
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
    // Card image area: fondo neutro plano. Cuando haya image_url real, se reemplaza
    // por un <img>. Mientras tanto, sin gradients colorful que parecen AI-placeholder.
    return 'var(--brand-50)';
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
