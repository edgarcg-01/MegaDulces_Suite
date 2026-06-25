import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  inject,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import type { PriceRow } from '../portal.service';
import { cldImage } from '../../../core/util/cloudinary';
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { CartFxService } from '../cart-fx.service';

/**
 * Carrusel "Productos del mes" (top-sellers). Presentacional: recibe los
 * productos por input y emite open/add. Capa de motion progresiva con GSAP
 * (lazy import + IntersectionObserver), apagada bajo prefers-reduced-motion —
 * el carrusel base es scroll-snap nativo, accesible y funciona sin JS.
 */
@Component({
  selector: 'portal-products-of-month',
  standalone: true,
  imports: [CommonModule, CurrencyPipe],
  template: `
    <section class="pom" *ngIf="products?.length">
      <header class="pom-head">
        <div class="pom-title">
          <span class="pom-eyebrow">Top ventas</span>
          <h2>Productos del mes</h2>
        </div>
        <div class="pom-head-right">
          <span class="pom-meta">Últimos 90 días</span>
          <div class="pom-nav">
            <button type="button" class="pom-arrow" (click)="onArrow(-1)" aria-label="Anterior">
              <i class="pi pi-chevron-left" aria-hidden="true"></i>
            </button>
            <button type="button" class="pom-arrow" (click)="onArrow(1)" aria-label="Siguiente">
              <i class="pi pi-chevron-right" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </header>

      <div class="pom-rail" role="list">
        <article
          *ngFor="let p of products; let i = index; trackBy: trackById"
          class="pom-card"
          role="listitem"
          tabindex="0"
          [attr.aria-label]="'Top ' + (i + 1) + ': ' + p.product_name"
          (click)="open.emit(p)"
          (keydown.enter)="open.emit(p)"
          (keydown.space)="open.emit(p); $event.preventDefault()"
        >
          <div
            class="pom-media"
            [class.has-photo]="hasImg(p)"
            [style.background]="hasImg(p) ? null : ph(p)"
          >
            <img
              *ngIf="hasImg(p)"
              [src]="img(p)"
              [alt]="p.product_name"
              loading="lazy"
              decoding="async"
              (error)="onImgError(p)"
            />
            <span *ngIf="!hasImg(p)" class="pom-mono">{{ initials(p) }}</span>
            <span class="pom-rank">#{{ i + 1 }}</span>
          </div>

          <div class="pom-body">
            <span class="pom-brand">{{ p.brand_name || 'Sin marca' }}</span>
            <span class="pom-name" [title]="p.product_name">{{ p.product_name }}</span>
            <span class="pom-price" *ngIf="p.price != null">
              {{ +p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}
            </span>
            <span class="pom-price pom-price-na" *ngIf="p.price == null">Sin precio</span>
          </div>

          <button
            type="button"
            class="pom-add"
            [class.is-added]="addedIds.has(p.product_id)"
            [disabled]="addingId === p.product_id || p.price == null"
            (click)="$event.stopPropagation(); onAdd(p, $event)"
            [attr.aria-label]="'Agregar ' + p.product_name"
          >
            <i *ngIf="addingId === p.product_id" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
            <i *ngIf="addingId !== p.product_id && addedIds.has(p.product_id)" class="pi pi-check" aria-hidden="true"></i>
            <i *ngIf="addingId !== p.product_id && !addedIds.has(p.product_id)" class="pi pi-plus" aria-hidden="true"></i>
          </button>
        </article>
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; margin-bottom: 2.5rem; }

      .pom-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        margin: 0 0.1rem 0.9rem;
      }
      .pom-eyebrow {
        display: block;
        font-size: var(--fs-micro);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--brand-700);
        margin-bottom: 0.2rem;
      }
      .pom-title h2 {
        font-family: var(--font-display);
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.05;
        color: var(--neutral-950);
        margin: 0;
      }
      .pom-head-right { display: flex; align-items: center; gap: 0.75rem; }
      .pom-meta {
        font-size: var(--fs-xs);
        font-weight: 600;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .pom-nav { display: none; gap: 0.4rem; }
      @media (hover: hover) and (pointer: fine) { .pom-nav { display: inline-flex; } }
      .pom-arrow {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 1px solid var(--neutral-200);
        background: var(--card-bg);
        color: var(--neutral-700);
        display: grid;
        place-items: center;
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard), transform 120ms var(--ease-spring);
      }
      .pom-arrow:hover { background: var(--neutral-100); border-color: var(--neutral-300); color: var(--neutral-950); }
      .pom-arrow:active { transform: scale(0.9); }
      .pom-arrow i { font-size: var(--fs-sm); }

      .pom-rail {
        display: flex;
        gap: 0.85rem;
        overflow-x: auto;
        scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch;
        padding: 0.25rem 0.1rem 0.6rem;
        scrollbar-width: thin;
      }

      .pom-card {
        position: relative;
        flex: 0 0 auto;
        width: 172px;
        scroll-snap-align: start;
        display: flex;
        flex-direction: column;
        background: var(--card-bg);
        border: 1px solid var(--neutral-200);
        border-radius: var(--r-lg);
        overflow: hidden;
        cursor: pointer;
        transition: transform 180ms var(--ease-standard), box-shadow 220ms var(--ease-standard), border-color 200ms var(--ease-standard);
      }
      .pom-card:hover {
        transform: translateY(-4px);
        border-color: var(--neutral-300);
        box-shadow: 0 18px 34px -20px rgba(16, 13, 9, 0.36);
      }
      .pom-card:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
      .pom-card:active { transform: translateY(-1px); }

      .pom-media {
        position: relative;
        aspect-ratio: 1;
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .pom-media.has-photo { background: var(--card-bg); }
      .pom-media img { width: 100%; height: 100%; object-fit: contain; padding: 12px; }
      .pom-mono {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--text-display-md);
        color: #fff;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25), 0 2px 10px rgba(0, 0, 0, 0.14);
      }
      .pom-rank {
        position: absolute;
        top: 8px;
        left: 8px;
        font-family: var(--font-mono);
        font-size: var(--fs-micro);
        font-weight: 800;
        color: #fff;
        background: rgba(16, 13, 9, 0.82);
        border-radius: var(--r-pill);
        padding: 0.12rem 0.45rem;
        font-variant-numeric: tabular-nums;
      }

      .pom-body {
        display: flex;
        flex-direction: column;
        gap: 0.12rem;
        padding: 0.6rem 0.7rem 0.7rem;
        min-width: 0;
        flex: 1;
      }
      .pom-brand {
        font-size: var(--fs-nano);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pom-name {
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
      .pom-price {
        font-size: var(--fs-h3);
        font-weight: 800;
        color: var(--neutral-950);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
        margin-top: 0.15rem;
      }
      .pom-price-na { font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); }

      .pom-add {
        position: absolute;
        right: 0.6rem;
        bottom: 0.6rem;
        z-index: 2;
        width: 40px;
        height: 40px;
        border-radius: var(--r-pill);
        border: none;
        background: var(--neutral-950);
        color: var(--brand-400);
        display: grid;
        place-items: center;
        cursor: pointer;
        font-size: var(--fs-h3);
        box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.3), inset 0 -2px 0 rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1);
        transition: transform 140ms var(--ease-spring), box-shadow 200ms var(--ease-spring);
      }
      .pom-add:hover:not(:disabled) { transform: translateY(-2px) scale(1.06); box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.3), 0 0 0 4px rgba(253, 231, 7, 0.22); }
      .pom-add:active:not(:disabled) { transform: translateY(1px) scale(0.94); }
      .pom-add:disabled { opacity: 0.4; cursor: not-allowed; }
      .pom-add.is-added { background: var(--ok-fg); color: #fff; }

      /* Pre-animación: oculta las cards hasta que GSAP las revele. Solo se
         aplica cuando vamos a animar (no en reduced-motion / sin JS). */
      :host(.pom-pending) .pom-card { opacity: 0; }

      @media (prefers-reduced-motion: reduce) {
        .pom-card:hover { transform: none; }
      }
      @media (max-width: 640px) {
        .pom-card { width: 150px; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductsOfMonthCarouselComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) products: PriceRow[] = [];
  @Input() addingId: string | null = null;
  @Input() addedIds = new Set<string>();

  @Output() open = new EventEmitter<PriceRow>();
  @Output() add = new EventEmitter<PriceRow>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cartFx = inject(CartFxService);

  /** Vuela la imagen al carrito + emite el add. */
  onAdd(p: PriceRow, ev: Event): void {
    const card = (ev.currentTarget as HTMLElement).closest('.pom-card');
    const media = (card?.querySelector('.pom-media') as HTMLElement) || (ev.currentTarget as HTMLElement);
    this.cartFx.fly(media, this.hasImg(p) ? this.img(p) : null);
    this.add.emit(p);
  }

  private viewReady = false;
  private armed = false;
  private io?: IntersectionObserver;
  private readonly imgFailed = new Set<string>();

  // GSAP cargado lazy y cacheado.
  private G: any = null;
  private Draggable: any = null;
  private gsapLoading?: Promise<any>;
  private drag?: { kill: () => void };

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.tryArm();
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  ngOnChanges(): void {
    this.tryArm();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.io?.disconnect();
    this.drag?.kill?.();
  }

  /** Arma el reveal una sola vez, cuando hay datos + vista lista + se permite motion. */
  private tryArm(): void {
    if (this.armed || !this.viewReady || !this.products?.length) return;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.armed = true;

    const el = this.host.nativeElement as HTMLElement;
    el.classList.add('pom-pending');
    this.io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.io?.disconnect();
          this.reveal(el);
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    this.io.observe(el);
  }

  /** Carga GSAP + plugins una sola vez (cacheado). Devuelve null si falla. */
  private ensureGsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = (async () => {
      const mod: any = await import('gsap');
      const gsap = mod.gsap || mod.default;
      try {
        const Drag = (await import('gsap/Draggable')).Draggable;
        const Inertia = (await import('gsap/InertiaPlugin')).InertiaPlugin;
        gsap.registerPlugin(Drag, Inertia);
        this.Draggable = Drag;
      } catch {
        /* plugins opcionales — sin ellos solo no hay drag-inertia */
      }
      this.G = gsap;
      return gsap;
    })();
    return this.gsapLoading;
  }

  /** Reveal escalonado (lazy GSAP) + arma el drag con inercia. Fuera de zona. */
  private async reveal(el: HTMLElement): Promise<void> {
    try {
      const gsap = await this.ensureGsap();
      this.zone.runOutsideAngular(() => {
        const cards = el.querySelectorAll('.pom-card');
        if (cards.length) {
          gsap.set(cards, { opacity: 0, y: 20 });
          el.classList.remove('pom-pending');
          gsap.to(cards, {
            opacity: 1,
            y: 0,
            duration: 0.5,
            stagger: 0.06,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          });
        } else {
          el.classList.remove('pom-pending');
        }
        this.setupDrag(el);
      });
    } catch {
      el.classList.remove('pom-pending');
    }
  }

  /** Drag-to-scroll con momentum (solo puntero fino — touch usa scroll nativo). */
  private setupDrag(el: HTMLElement): void {
    if (this.drag || !this.Draggable) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const rail = el.querySelector('.pom-rail') as HTMLElement | null;
    if (!rail) return;
    const created = this.Draggable.create(rail, {
      type: 'scrollLeft',
      inertia: true,
      dragClickables: true,
      cursor: 'grab',
      activeCursor: 'grabbing',
      edgeResistance: 0.92,
    });
    this.drag = created?.[0];
  }

  /** Flechas prev/next (desktop): scroll suave ~80% del viewport del rail. */
  async onArrow(dir: number): Promise<void> {
    const el = this.host.nativeElement as HTMLElement;
    const rail = el.querySelector('.pom-rail') as HTMLElement | null;
    if (!rail) return;
    const amount = Math.max(220, rail.clientWidth * 0.8) * dir;
    const target = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, rail.scrollLeft + amount));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      rail.scrollTo({ left: target });
      return;
    }
    const gsap = await this.ensureGsap().catch(() => null);
    if (gsap) {
      this.zone.runOutsideAngular(() => gsap.to(rail, { scrollLeft: target, duration: 0.5, ease: 'power2.out' }));
    } else {
      rail.scrollTo({ left: target, behavior: 'smooth' });
    }
  }

  trackById = (_i: number, p: PriceRow) => p.product_id;

  hasImg(p: PriceRow): boolean {
    return !!p.image_url && !this.imgFailed.has(p.product_id);
  }
  img(p: PriceRow): string {
    return cldImage(p.image_url, 400);
  }
  onImgError(p: PriceRow): void {
    this.imgFailed.add(p.product_id);
  }
  ph(p: PriceRow): string {
    return brandPlaceholderGradient(p.product_id || p.product_name);
  }
  initials(p: PriceRow): string {
    const words = (p.product_name || '?').trim().split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }
}
