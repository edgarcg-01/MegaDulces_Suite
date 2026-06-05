import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import type { PriceRow } from '../portal.service';

/**
 * Átomo: card de producto del catálogo (grid + lista). Presentacional —
 * recibe el producto + estado de carrito por inputs y emite eventos
 * (open/add/inc/dec). Reemplaza la card inline de portal-catalog.
 * `[list]` activa el layout de fila (modo lista densa).
 */
@Component({
  selector: 'portal-product-card',
  standalone: true,
  imports: [CommonModule, CurrencyPipe, TooltipModule],
  host: { '[class.is-list]': 'list' },
  template: `
    <article
      class="cat-card"
      [class.cat-card-active]="inCart"
      (click)="open.emit()"
      tabindex="0"
      role="button"
      [attr.aria-label]="'Ver detalles de ' + product.product_name"
      (keydown.enter)="open.emit()"
      (keydown.space)="open.emit(); $event.preventDefault()"
    >
      <div class="cat-card-img" [class.has-photo]="showImg" [style.background]="'var(--brand-50)'">
        <img
          *ngIf="showImg"
          [src]="product.image_url"
          [alt]="product.product_name"
          loading="lazy"
          decoding="async"
          class="cat-card-img-real"
          (error)="broken = true"
        />
        <span *ngIf="!showImg" class="cat-card-img-initials">{{ initials() }}</span>
        <span
          *ngIf="promo"
          class="cat-card-promo-pill"
          [attr.title]="promo.promo_name"
        >
          <i class="pi pi-tag"></i>
          {{ promoLabel(promo.promo_type) }}
        </span>
        <span
          *ngIf="product.stock_available != null && product.stock_available <= 5"
          class="cat-card-stock-pill"
        >
          <i class="pi pi-exclamation-circle"></i>
          {{ product.stock_available }} en stock
        </span>
        <span
          *ngIf="score"
          class="cat-card-score-pill"
          [attr.title]="'Relevancia semántica: ' + score + '%'"
        >
          <i class="pi pi-bolt"></i>
          {{ score }}%
        </span>
      </div>

      <div class="cat-card-body">
        <span class="cat-card-brand">{{ product.brand_name || 'Sin marca' }}</span>
        <h3 class="cat-card-name" [title]="product.product_name">{{ product.product_name }}</h3>

        <div class="cat-card-price-row">
          <span class="cat-card-price" *ngIf="product.price != null">
            {{ +product.price | currency:'MXN':'symbol-narrow':'1.2-2' }}
          </span>
          <span class="cat-card-price cat-card-price-na" *ngIf="product.price == null">
            Sin precio
          </span>
          <span class="cat-card-min" *ngIf="product.min_qty > 1">
            mín {{ product.min_qty }}
          </span>
        </div>

        <button
          *ngIf="!inCart"
          type="button"
          class="cat-add"
          [disabled]="adding || isAdmin || product.price == null"
          (click)="$event.stopPropagation(); add.emit()"
          [attr.aria-label]="'Agregar ' + product.product_name + ' al carrito'"
          [pTooltip]="isAdmin ? 'Solo lectura (admin)' : (product.price == null ? 'Producto sin precio configurado' : 'Agregar al carrito')"
        >
          <i [class]="adding ? 'pi pi-spin pi-spinner' : 'pi pi-plus'"></i>
        </button>

        <div
          *ngIf="inCart"
          class="cat-stepper"
          role="group"
          (click)="$event.stopPropagation()"
          [attr.aria-label]="'Ajustar cantidad de ' + product.product_name"
        >
          <button
            type="button"
            class="cat-stepper-btn"
            [disabled]="adding || isAdmin"
            (click)="$event.stopPropagation(); dec.emit()"
            [attr.aria-label]="qty <= 1 ? 'Quitar del carrito' : 'Disminuir'"
          >
            <i [class]="qty <= 1 ? 'pi pi-trash' : 'pi pi-minus'"></i>
          </button>
          <span class="cat-stepper-val" aria-live="polite">{{ adding ? '…' : qty }}</span>
          <button
            type="button"
            class="cat-stepper-btn"
            [disabled]="adding || isAdmin"
            (click)="$event.stopPropagation(); inc.emit()"
            aria-label="Aumentar"
          >
            <i class="pi pi-plus"></i>
          </button>
        </div>
      </div>
    </article>
  `,
  styles: [
    `
      :host { display: block; }

      .cat-card {
        position: relative;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
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
      .cat-card:active { transform: translateY(0); }
      .cat-card-active { border-left: 4px solid var(--brand-500); }
      .cat-card-active:hover { border-left-color: var(--brand-500); }

      .cat-card-img {
        position: relative;
        aspect-ratio: 4 / 3;
        display: grid;
        place-items: center;
        overflow: hidden;
        border-bottom: 1px solid var(--border-color);
      }
      .cat-card-img.has-photo { background: var(--card-bg) !important; }
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
      .cat-card-promo-pill {
        position: absolute;
        top: 0.5rem;
        left: 0.5rem;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.2rem 0.5rem;
        border-radius: var(--r-pill);
        font-size: 0.7rem;
        font-weight: 600;
        background: var(--bad-fg);
        color: #fff;
        z-index: 2;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15);
      }
      .cat-card-promo-pill i { font-size: 0.7rem; }
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
        border-radius: var(--r-pill);
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
        border-radius: var(--r-pill);
        font-variant-numeric: tabular-nums;
      }
      .cat-card-score-pill i { font-size: 0.6rem; color: var(--brand-700); }

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
        color: var(--text-muted);
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
        border-radius: var(--r-pill);
      }

      .cat-add {
        position: absolute;
        right: 0.625rem;
        bottom: 0.625rem;
        z-index: 3;
        width: 44px;
        height: 44px;
        border-radius: var(--r-pill);
        border: none;
        background: var(--neutral-950);
        color: var(--brand-400);
        font-size: 0.95rem;
        cursor: pointer;
        display: grid;
        place-items: center;
        box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.28), 0 0 0 0 rgba(253, 231, 7, 0);
        transition: transform 140ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .cat-add:hover:not(:disabled) {
        transform: scale(1.08);
        box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.28), 0 0 0 4px rgba(253, 231, 7, 0.22);
      }
      .cat-add:active:not(:disabled) { transform: scale(0.94); }
      .cat-add:disabled { opacity: 0.35; cursor: not-allowed; }

      .cat-stepper {
        position: absolute;
        right: 0.625rem;
        bottom: 0.625rem;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        width: auto;
        min-width: 132px;
        height: 44px;
        padding: 0;
        background: var(--neutral-900);
        color: var(--brand-400);
        border-radius: var(--r-pill);
        box-shadow: 0 4px 12px -3px rgba(0, 0, 0, 0.25);
        overflow: hidden;
        animation: ppcStepperIn 240ms cubic-bezier(0.34, 1.4, 0.5, 1) both;
      }
      @keyframes ppcStepperIn {
        from { opacity: 0; transform: scale(0.7); }
        to   { opacity: 1; transform: scale(1); }
      }
      .cat-stepper-btn {
        width: 44px;
        height: 44px;
        background: transparent;
        border: none;
        color: var(--brand-400);
        cursor: pointer;
        display: grid;
        place-items: center;
        font-size: 0.85rem;
        border-radius: var(--r-pill);
        transition: background-color 120ms var(--ease-standard), transform 120ms var(--ease-standard);
      }
      .cat-stepper-btn:hover:not(:disabled) { background: rgba(253, 231, 7, 0.18); }
      .cat-stepper-btn:active:not(:disabled) { transform: scale(0.88); }
      .cat-stepper-btn:disabled { opacity: 0.45; cursor: not-allowed; }
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

      /* ── Modo lista (densa) ── */
      :host(.is-list) .cat-card {
        flex-direction: row;
        align-items: stretch;
        border-radius: var(--r-md);
        padding-right: 12px;
      }
      :host(.is-list) .cat-card:hover { transform: none; }
      :host(.is-list) .cat-card-img {
        width: 60px;
        flex-shrink: 0;
        aspect-ratio: auto;
        border-bottom: none;
        border-right: 1px solid var(--border-color);
      }
      :host(.is-list) .cat-card-img-initials { font-size: 1.1rem; }
      :host(.is-list) .cat-card-stock-pill,
      :host(.is-list) .cat-card-score-pill,
      :host(.is-list) .cat-card-promo-pill { display: none; }
      :host(.is-list) .cat-card-body {
        flex: 1;
        display: grid;
        grid-template-columns: 1fr auto auto;
        grid-template-areas:
          'brand price action'
          'name  price action';
        align-items: center;
        column-gap: 14px;
        row-gap: 0;
        padding: 8px 0 8px 12px;
        min-width: 0;
      }
      :host(.is-list) .cat-card-brand { grid-area: brand; }
      :host(.is-list) .cat-card-name {
        grid-area: name;
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        -webkit-line-clamp: unset;
        display: block;
      }
      :host(.is-list) .cat-card-price-row {
        grid-area: price;
        flex-direction: column;
        align-items: flex-end;
        gap: 0;
      }
      :host(.is-list) .cat-add,
      :host(.is-list) .cat-stepper {
        position: static;
        grid-area: action;
        align-self: center;
      }
      :host(.is-list) .cat-stepper { animation: none; }

      @media (prefers-reduced-motion: reduce) {
        .cat-card:hover, .cat-add:hover { transform: none !important; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalProductCardComponent {
  @Input({ required: true }) product!: PriceRow;
  @Input() list = false;
  @Input() inCart = false;
  @Input() qty = 0;
  @Input() adding = false;
  @Input() isAdmin = false;
  @Input() promo: { promo_name: string; promo_type: string } | null = null;
  @Input() score: number | null = null;

  @Output() open = new EventEmitter<void>();
  @Output() add = new EventEmitter<void>();
  @Output() inc = new EventEmitter<void>();
  @Output() dec = new EventEmitter<void>();

  broken = false;

  get showImg(): boolean {
    return !!this.product?.image_url && !this.broken;
  }

  initials(): string {
    const name = this.product?.product_name || '?';
    const words = name.trim().split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }

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
}
