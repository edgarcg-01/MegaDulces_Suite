import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  Output,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import type { PriceRow } from '../portal.service';
import { cldImage } from '../../../core/util/cloudinary';
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { CartFxService } from '../cart-fx.service';
import { CountUpDirective } from './count-up.directive';

/**
 * Bottom-sheet de detalle de producto al estilo Rappi: SUBE desde abajo, imagen
 * grande arriba, contenido scrolleable, y barra fija inferior con stepper +
 * "Agregar · $subtotal". Se abre al tocar un card de producto en el home.
 * Presentacional: el padre controla apertura (product != null) y maneja el add.
 */
@Component({
  selector: 'portal-product-sheet',
  standalone: true,
  imports: [CommonModule, CurrencyPipe, CountUpDirective],
  template: `
    <div
      class="psheet-backdrop"
      [class.open]="!!product"
      (click)="close.emit()"
      aria-hidden="true"
    ></div>

    <section
      class="psheet"
      [class.open]="!!product"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="product?.product_name || 'Detalle de producto'"
      (keydown.escape)="close.emit()"
    >
      <ng-container *ngIf="product as p">
        <div class="psheet-scroll">
          <div
            class="psheet-media"
            [class.has-photo]="hasImg(p)"
            [style.background]="hasImg(p) ? null : ph(p)"
          >
            <img *ngIf="hasImg(p)" [src]="img(p)" [alt]="p.product_name" decoding="async" />
            <span *ngIf="!hasImg(p)" class="psheet-mono">{{ initials(p) }}</span>
            <button type="button" class="psheet-close" (click)="close.emit()" aria-label="Cerrar">
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>

          <div class="psheet-info">
            <div class="psheet-pricerow">
              <span class="psheet-price" *ngIf="p.price != null">
                {{ +p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}
              </span>
              <span class="psheet-price psheet-price-na" *ngIf="p.price == null">Sin precio</span>
              <span class="psheet-min" *ngIf="p.min_qty > 1">Mín. {{ p.min_qty }}</span>
            </div>

            <span *ngIf="note" class="psheet-trend">
              <i class="pi pi-bolt" aria-hidden="true"></i> {{ note }}
            </span>

            <span class="psheet-brand">{{ p.brand_name || 'Sin marca' }}</span>
            <h2 class="psheet-name">{{ p.product_name }}</h2>

            <div class="psheet-stock" *ngIf="p.stock_available != null">
              <i class="pi pi-box" aria-hidden="true"></i>
              {{ p.stock_available > 0 ? p.stock_available + ' disponibles' : 'Sin stock' }}
            </div>
          </div>
        </div>

        <footer class="psheet-foot">
          <div class="psheet-stepper" role="group" aria-label="Cantidad">
            <button type="button" (click)="dec(p)" [disabled]="qty() <= (p.min_qty || 1)" aria-label="Quitar">
              <i class="pi pi-minus" aria-hidden="true"></i>
            </button>
            <span class="psheet-qty">{{ qty() }}</span>
            <button type="button" (click)="inc()" aria-label="Agregar uno">
              <i class="pi pi-plus" aria-hidden="true"></i>
            </button>
          </div>
          <button
            type="button"
            class="psheet-add"
            [disabled]="adding || p.price == null"
            (click)="onAdd(p)"
          >
            <i *ngIf="adding" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
            <ng-container *ngIf="!adding">
              Agregar
              <span class="psheet-add-sub" *ngIf="p.price != null">
                · <span [countUp]="qty() * +p.price"></span>
              </span>
            </ng-container>
          </button>
        </footer>
      </ng-container>
    </section>
  `,
  styles: [
    `
      :host { display: contents; }

      .psheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(16, 13, 9, 0.5);
        opacity: 0;
        visibility: hidden;
        z-index: 55;
        transition: opacity 280ms var(--ease-standard), visibility 280ms;
        backdrop-filter: blur(2px);
      }
      .psheet-backdrop.open { opacity: 1; visibility: visible; }

      /* Bottom sheet: anclado abajo, sube desde fuera de pantalla. */
      .psheet {
        position: fixed;
        bottom: 0;
        left: 50%;
        width: min(560px, 100%);
        max-height: 92dvh;
        z-index: 60;
        display: flex;
        flex-direction: column;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-bottom: none;
        border-radius: var(--r-2xl) var(--r-2xl) 0 0;
        box-shadow: 0 -24px 60px -20px rgba(0, 0, 0, 0.45);
        transform: translate(-50%, 100%);
        transition: transform 440ms var(--ease-spring);
        overflow: hidden;
      }
      .psheet.open { transform: translate(-50%, 0); }

      .psheet-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }

      .psheet-media {
        position: relative;
        width: 100%;
        height: clamp(220px, 48vw, 320px);
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .psheet-media.has-photo { background: #fff; }
      .psheet-media img { width: 100%; height: 100%; object-fit: contain; padding: 1.5rem; }
      .psheet-mono {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--text-display-xl);
        color: #fff;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      }
      .psheet-close {
        position: absolute;
        top: calc(0.85rem + env(safe-area-inset-top));
        left: 0.85rem;
        width: 38px;
        height: 38px;
        border: none;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.92);
        color: var(--neutral-950);
        display: grid;
        place-items: center;
        cursor: pointer;
        box-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.25);
        backdrop-filter: blur(4px);
        transition: transform 140ms var(--ease-spring);
      }
      .psheet-close:active { transform: scale(0.9); }
      .psheet-close i { font-size: var(--fs-body); }

      .psheet-info {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        padding: 1.15rem 1.25rem 1.4rem;
      }
      .psheet-pricerow { display: flex; align-items: baseline; gap: 0.7rem; }
      .psheet-price {
        font-size: var(--text-display-md);
        font-weight: 800;
        color: var(--neutral-950);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      .psheet-price-na { font-size: var(--fs-h2); font-weight: 700; color: var(--text-muted); }
      .psheet-min {
        font-size: var(--fs-xs);
        font-weight: 700;
        color: var(--brand-700);
        background: var(--brand-50);
        padding: 0.12rem 0.5rem;
        border-radius: var(--r-pill);
      }
      .psheet-trend {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: var(--fs-nano);
        font-weight: 800;
        color: var(--brand-700);
        background: var(--brand-50);
        padding: 0.2rem 0.55rem;
        border-radius: var(--r-pill);
        margin-top: 0.2rem;
      }
      .psheet-trend i { font-size: var(--fs-nano); }
      .psheet-brand {
        font-size: var(--fs-micro);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        margin-top: 0.35rem;
      }
      .psheet-name {
        font-family: var(--font-display);
        font-size: var(--text-display-md);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.12;
        margin: 0;
        color: var(--neutral-950);
      }
      .psheet-stock {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: var(--fs-sm);
        font-weight: 600;
        color: var(--text-muted);
        margin-top: 0.5rem;
      }
      .psheet-stock i { font-size: var(--fs-xs); }

      /* Barra fija inferior (no scrollea) — patrón Rappi. */
      .psheet-foot {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.9rem 1.25rem max(0.9rem, env(safe-area-inset-bottom));
        border-top: 1px solid var(--border-color);
        background: var(--card-bg);
      }
      .psheet-stepper {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 0.2rem;
        background: var(--neutral-100);
        border-radius: var(--r-pill);
        padding: 0.2rem;
      }
      .psheet-stepper button {
        width: 40px;
        height: 40px;
        border: none;
        border-radius: 50%;
        background: var(--card-bg);
        color: var(--neutral-950);
        display: grid;
        place-items: center;
        cursor: pointer;
        box-shadow: var(--shadow-light);
        transition: transform 120ms var(--ease-spring);
      }
      .psheet-stepper button:active:not(:disabled) { transform: scale(0.9); }
      .psheet-stepper button:disabled { opacity: 0.4; cursor: not-allowed; }
      .psheet-qty {
        min-width: 2ch;
        text-align: center;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        font-size: var(--fs-body);
      }
      .psheet-add {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        min-height: 52px;
        border: none;
        border-radius: var(--r-pill);
        background: var(--action);
        color: #fff;
        font-family: var(--font-body);
        font-size: var(--fs-body);
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 12px 26px -10px var(--action-ring, rgba(240, 90, 40, 0.5)),
                    inset 0 -3px 0 rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.18);
        transition: transform 140ms var(--ease-spring), background-color 160ms var(--ease-standard);
      }
      .psheet-add:active:not(:disabled) { transform: translateY(1px) scale(0.99); }
      .psheet-add:disabled { opacity: 0.55; cursor: not-allowed; }
      .psheet-add-sub { font-weight: 700; opacity: 0.92; }

      @media (prefers-reduced-motion: reduce) {
        .psheet, .psheet-backdrop { transition: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductSheetComponent {
  @Input() note: string | null = null;
  @Input() adding = false;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly cartFx = inject(CartFxService);
  private G: any = null;
  private gsapLoading?: Promise<any>;
  private entranceTl?: { kill: () => void };

  /** Producto a mostrar; null = cerrado. Al cambiar, resetea la cantidad y anima entrada. */
  private _product: PriceRow | null = null;
  @Input() set product(p: PriceRow | null) {
    this._product = p;
    if (p) {
      this.qty.set(Math.max(1, p.min_qty || 1));
      this.animateIn();
    } else {
      this.entranceTl?.kill?.();
    }
  }
  get product(): PriceRow | null {
    return this._product;
  }

  @Output() close = new EventEmitter<void>();
  @Output() add = new EventEmitter<{ product: PriceRow; qty: number }>();

  readonly qty = signal<number>(1);

  /** Vuela la imagen al carrito + emite el add con la cantidad elegida. */
  onAdd(p: PriceRow): void {
    const media = this.host.nativeElement.querySelector('.psheet-media') as HTMLElement | null;
    this.cartFx.fly(media, this.hasImg(p) ? this.img(p) : null);
    this.add.emit({ product: p, qty: this.qty() });
  }

  /** Entrada escalonada GSAP: imagen escala, info sube, barra inferior entra. */
  private animateIn(): void {
    if (
      typeof window === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    this.zone.runOutsideAngular(() =>
      requestAnimationFrame(async () => {
        try {
          const gsap = await this.gsap();
          const el = this.host.nativeElement;
          const media = el.querySelector('.psheet-media');
          if (!media) return;
          const info = el.querySelectorAll('.psheet-info > *');
          const foot = el.querySelector('.psheet-foot');
          this.entranceTl?.kill?.();
          const tl = gsap.timeline({ delay: 0.1 });
          tl.from(media, { scale: 0.82, opacity: 0, duration: 0.45, ease: 'back.out(1.4)' })
            .from(info, { y: 18, opacity: 0, duration: 0.4, stagger: 0.06, ease: 'power3.out' }, '-=0.2')
            .from(foot, { y: 26, opacity: 0, duration: 0.4, ease: 'power3.out' }, '-=0.25');
          this.entranceTl = tl;
        } catch {
          /* sin GSAP el sheet entra con el slide CSS, sin stagger */
        }
      }),
    );
  }

  private gsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = (async () => {
      const mod: any = await import('gsap');
      this.G = mod.gsap || mod.default;
      return this.G;
    })();
    return this.gsapLoading;
  }

  inc(): void {
    this.qty.update((v) => v + 1);
  }
  dec(p: PriceRow): void {
    const min = Math.max(1, p.min_qty || 1);
    this.qty.update((v) => Math.max(min, v - 1));
  }

  hasImg(p: PriceRow): boolean {
    return !!p.image_url;
  }
  img(p: PriceRow): string {
    return cldImage(p.image_url, 600);
  }
  ph(p: PriceRow): string {
    return brandPlaceholderGradient(p.product_id || p.product_name);
  }
  initials(p: PriceRow): string {
    const words = (p.product_name || '?').trim().split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }
}
