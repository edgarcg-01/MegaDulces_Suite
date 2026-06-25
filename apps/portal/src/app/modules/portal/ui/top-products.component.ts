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
 * "Productos top" — rail horizontal de la tendencia del mercado mexicano cruzada
 * contra nuestro catálogo. Cards verticales flotantes con badge de la tendencia
 * que matchea + ranking. Capa de motion GSAP: reveal escalonado + drag-to-scroll
 * con inercia (puntero fino) + flechas, y foco intra-rail (scale via view(inline),
 * cero JS). Apagado bajo prefers-reduced-motion — el rail base es scroll-snap
 * nativo, accesible. Presentacional: emite open/add.
 */
@Component({
  selector: 'portal-top-products',
  standalone: true,
  imports: [CommonModule, CurrencyPipe],
  template: `
    <section class="tp" *ngIf="products?.length">
      <header class="tp-head">
        <div class="tp-title">
          <span class="tp-eyebrow">{{ eyebrow }}</span>
          <h2>{{ heading }}</h2>
        </div>
        <div class="tp-head-right">
          <span class="tp-meta">{{ meta }}</span>
          <div class="tp-nav">
            <button type="button" class="tp-arrow" (click)="onArrow(-1)" aria-label="Anterior">
              <i class="pi pi-chevron-left" aria-hidden="true"></i>
            </button>
            <button type="button" class="tp-arrow" (click)="onArrow(1)" aria-label="Siguiente">
              <i class="pi pi-chevron-right" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </header>

      <div class="tp-rail" role="list">
        <article
          *ngFor="let p of products; let i = index; trackBy: trackById"
          class="tp-card"
          [class.tp-card-lead]="i === 0"
          role="listitem"
          tabindex="0"
          [attr.aria-label]="'Top ' + (i + 1) + ': ' + p.product_name"
          (click)="open.emit(p)"
          (keydown.enter)="open.emit(p)"
          (keydown.space)="open.emit(p); $event.preventDefault()"
        >
          <div
            class="tp-media"
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
            <span *ngIf="!hasImg(p)" class="tp-mono">{{ initials(p) }}</span>
            <span *ngIf="showRank" class="tp-rank" [class.is-gold]="i === 0">#{{ i + 1 }}</span>
          </div>

          <div class="tp-body">
            <span class="tp-trend">
              <i class="pi pi-bolt" aria-hidden="true"></i>
              {{ noteFor(p, i) }}
            </span>
            <span class="tp-brand">{{ p.brand_name || 'Sin marca' }}</span>
            <h3 class="tp-name" [title]="p.product_name">{{ p.product_name }}</h3>
            <div class="tp-foot">
              <span class="tp-price" *ngIf="p.price != null">
                {{ +p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}
              </span>
              <span class="tp-price tp-price-na" *ngIf="p.price == null">Sin precio</span>
              <button
                type="button"
                class="tp-add"
                [class.is-added]="addedIds.has(p.product_id)"
                [disabled]="addingId === p.product_id || p.price == null"
                (click)="$event.stopPropagation(); onAdd(p, $event)"
                [attr.aria-label]="'Agregar ' + p.product_name"
              >
                <i *ngIf="addingId === p.product_id" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
                <i *ngIf="addingId !== p.product_id && addedIds.has(p.product_id)" class="pi pi-check" aria-hidden="true"></i>
                <i *ngIf="addingId !== p.product_id && !addedIds.has(p.product_id)" class="pi pi-plus" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; margin-bottom: 2.75rem; }

      .tp-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        margin: 0 0.1rem 0.9rem;
      }
      .tp-eyebrow {
        display: block;
        font-size: var(--fs-micro);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--brand-700);
        margin-bottom: 0.2rem;
      }
      .tp-title h2 {
        font-family: var(--font-display);
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.05;
        color: var(--neutral-950);
        margin: 0;
      }
      .tp-head-right { display: flex; align-items: center; gap: 0.75rem; }
      .tp-meta {
        font-size: var(--fs-xs);
        font-weight: 600;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .tp-nav { display: none; gap: 0.4rem; }
      @media (hover: hover) and (pointer: fine) { .tp-nav { display: inline-flex; } }
      .tp-arrow {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 1px solid var(--border-color);
        background: var(--card-bg);
        color: var(--neutral-700);
        display: grid;
        place-items: center;
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard), transform 120ms var(--ease-spring);
      }
      .tp-arrow:hover { background: var(--neutral-100); border-color: var(--neutral-300); color: var(--neutral-950); }
      .tp-arrow:active { transform: scale(0.9); }
      .tp-arrow i { font-size: var(--fs-sm); }

      .tp-rail {
        display: flex;
        gap: 0.85rem;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        padding: 0.25rem 0.1rem 0.6rem;
      }
      .tp-rail::-webkit-scrollbar { display: none; }

      .tp-card {
        position: relative;
        flex: 0 0 auto;
        width: clamp(184px, 62vw, 220px);
        scroll-snap-align: start;
        display: flex;
        flex-direction: column;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-xl);
        box-shadow: var(--shadow-float);
        overflow: hidden;
        cursor: pointer;
        transition: transform 200ms var(--ease-spring), box-shadow 220ms var(--ease-standard), border-color 200ms var(--ease-standard);
      }
      .tp-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-hover); border-color: var(--neutral-300); }
      .tp-card:active { transform: translateY(-1px); }
      .tp-card:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

      .tp-media {
        position: relative;
        aspect-ratio: 1;
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .tp-media.has-photo { background: var(--card-bg); }
      .tp-media img { width: 100%; height: 100%; object-fit: contain; padding: 12px; }
      .tp-mono {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--text-display-md);
        color: #fff;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25), 0 2px 10px rgba(0, 0, 0, 0.14);
      }
      .tp-rank {
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
      .tp-rank.is-gold { background: var(--brand-400); color: var(--neutral-950); }

      .tp-body {
        display: flex;
        flex-direction: column;
        gap: 0.18rem;
        padding: 0.65rem 0.7rem 0.7rem;
        min-width: 0;
        flex: 1;
      }
      .tp-trend {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        max-width: 100%;
        font-size: var(--fs-nano);
        font-weight: 800;
        letter-spacing: 0.01em;
        color: var(--brand-700);
        background: var(--brand-50);
        padding: 0.18rem 0.5rem;
        border-radius: var(--r-pill);
        margin-bottom: 0.25rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tp-trend i { font-size: var(--fs-nano); flex-shrink: 0; }
      .tp-brand {
        font-size: var(--fs-nano);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tp-name {
        font-size: var(--fs-sm);
        font-weight: 600;
        color: var(--neutral-950);
        line-height: 1.25;
        margin: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        min-height: 2.1em;
      }
      .tp-foot {
        margin-top: auto;
        padding-top: 0.45rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .tp-price {
        font-size: var(--fs-h3);
        font-weight: 800;
        color: var(--neutral-950);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .tp-price-na { font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); }

      .tp-add {
        flex-shrink: 0;
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
      .tp-add:hover:not(:disabled) { transform: translateY(-2px) scale(1.06); box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.3), 0 0 0 4px rgba(253, 231, 7, 0.22); }
      .tp-add:active:not(:disabled) { transform: translateY(1px) scale(0.94); }
      .tp-add:disabled { opacity: 0.4; cursor: not-allowed; }
      .tp-add.is-added { background: var(--ok-fg); color: #fff; }

      /* Card lead (#1) = espresso oscuro, jerarquía por contraste. */
      .tp-card-lead { background: var(--neutral-950); border-color: var(--neutral-900); }
      .tp-card-lead .tp-media.has-photo { background: var(--neutral-900); }
      .tp-card-lead .tp-trend { background: rgba(253, 231, 7, 0.16); color: var(--brand-400); }
      .tp-card-lead .tp-brand { color: rgba(255, 255, 255, 0.6); }
      .tp-card-lead .tp-name { color: #fff; }
      .tp-card-lead .tp-price { color: #fff; }
      .tp-card-lead .tp-add { background: var(--brand-400); color: var(--neutral-950); }

      /* Pre-animación: oculta las cards hasta que GSAP las revele. */
      :host(.tp-pending) .tp-card { opacity: 0; }

      /* Foco intra-rail (scroll-driven nativo, cero JS): la card centrada queda
         a tamaño full y las de los bordes se encogen. Usa 'scale' para NO pisar
         el reveal de GSAP (transform/opacity). iOS Safari sin soporte → estático. */
      @supports (animation-timeline: view()) {
        @media (prefers-reduced-motion: no-preference) {
          .tp-card {
            animation: tpFocus linear both;
            animation-timeline: view(inline);
            transform-origin: center;
          }
        }
      }
      @keyframes tpFocus {
        0%   { scale: 0.95; }
        50%  { scale: 1; }
        100% { scale: 0.95; }
      }

      @media (prefers-reduced-motion: reduce) {
        .tp-card:hover { transform: none; }
      }
      @media (max-width: 380px) {
        .tp-card { width: 64vw; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopProductsComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) products: PriceRow[] = [];
  /** product_id → etiqueta del badge "por qué" (tendencia MX, razón IA…). Pisa la señal de venta. */
  @Input() notes: Record<string, string> = {};
  @Input() eyebrow = 'Tendencia en México';
  @Input() heading = 'Productos top';
  @Input() meta = 'Lo que mueve el mercado';
  /** Muestra el ribbon de ranking #N (apagar para recomendaciones). */
  @Input() showRank = true;
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
    const card = (ev.currentTarget as HTMLElement).closest('.tp-card');
    const media = (card?.querySelector('.tp-media') as HTMLElement) || (ev.currentTarget as HTMLElement);
    this.cartFx.fly(media, this.hasImg(p) ? this.img(p) : null);
    this.add.emit(p);
  }

  private viewReady = false;
  private armed = false;
  private io?: IntersectionObserver;
  private readonly imgFailed = new Set<string>();
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

  private tryArm(): void {
    if (this.armed || !this.viewReady || !this.products?.length) return;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.armed = true;

    const el = this.host.nativeElement as HTMLElement;
    el.classList.add('tp-pending');
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

  private async reveal(el: HTMLElement): Promise<void> {
    try {
      const gsap = await this.ensureGsap();
      this.zone.runOutsideAngular(() => {
        const cards = el.querySelectorAll('.tp-card');
        if (cards.length) {
          gsap.set(cards, { opacity: 0, y: 22 });
          el.classList.remove('tp-pending');
          gsap.to(cards, {
            opacity: 1,
            y: 0,
            duration: 0.5,
            stagger: 0.07,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          });
        } else {
          el.classList.remove('tp-pending');
        }
        this.setupDrag(el);
      });
    } catch {
      el.classList.remove('tp-pending');
    }
  }

  /** Drag-to-scroll con momentum (solo puntero fino — touch usa scroll nativo). */
  private setupDrag(el: HTMLElement): void {
    if (this.drag || !this.Draggable) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const rail = el.querySelector('.tp-rail') as HTMLElement | null;
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
    const rail = el.querySelector('.tp-rail') as HTMLElement | null;
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

  /** Nota del card: tendencia MX que matchea (si vino) o señal de venta. */
  noteFor(p: PriceRow, i: number): string {
    return this.notes[p.product_id] || this.salesNote(p, i);
  }

  /** "Descripción" = prueba social a partir de las señales de venta del MV. */
  salesNote(p: PriceRow, i: number): string {
    const units = Number(p.units_total ?? p.units_sold ?? 0);
    if (units > 0) return `${this.fmt(units)} piezas vendidas`;
    const cases = Number(p.cases_sold ?? 0);
    if (cases > 0) return `${this.fmt(cases)} cajas vendidas`;
    return i === 0 ? 'El más pedido' : 'Top ventas';
  }

  private fmt(n: number): string {
    try {
      return Math.round(n).toLocaleString('es-MX');
    } catch {
      return String(Math.round(n));
    }
  }

  trackById = (_i: number, p: PriceRow) => p.product_id;

  hasImg(p: PriceRow): boolean {
    return !!p.image_url && !this.imgFailed.has(p.product_id);
  }
  img(p: PriceRow): string {
    return cldImage(p.image_url, 320);
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
