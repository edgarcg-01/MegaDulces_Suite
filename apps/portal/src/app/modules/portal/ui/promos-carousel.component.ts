import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  inject,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import type { PromotionRow } from '../portal.service';

/**
 * Carrusel "Promos del mes" — rail horizontal swipeable de cards flotantes
 * monocromáticas (la primera espresso oscuro = jerarquía por contraste). Capa
 * de motion progresiva con GSAP (lazy + IntersectionObserver): reveal
 * escalonado + drag-to-scroll con inercia (puntero fino) + flechas. Apagada
 * bajo prefers-reduced-motion — el rail base es scroll-snap nativo, accesible
 * y funciona sin JS. Mismo patrón que productos-del-mes.
 */
@Component({
  selector: 'portal-promos-carousel',
  standalone: true,
  imports: [CommonModule, DatePipe, RouterModule],
  template: `
    <section class="pc" *ngIf="promos?.length">
      <header class="pc-head">
        <div class="pc-title">
          <span class="pc-eyebrow">Ofertas</span>
          <h2>Promos del mes</h2>
        </div>
        <div class="pc-head-right">
          <a routerLink="/portal/promotions" class="pc-link">Ver todas →</a>
          <div class="pc-nav">
            <button type="button" class="pc-arrow" (click)="onArrow(-1)" aria-label="Anterior">
              <i class="pi pi-chevron-left" aria-hidden="true"></i>
            </button>
            <button type="button" class="pc-arrow" (click)="onArrow(1)" aria-label="Siguiente">
              <i class="pi pi-chevron-right" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </header>

      <div class="pc-rail" role="list">
        <article
          *ngFor="let p of promos; let i = index; trackBy: trackByPromo"
          class="pc-card"
          [class.pc-card-lead]="i === 0"
          role="listitem"
          routerLink="/portal/promotions"
        >
          <div class="pc-top">
            <span class="pc-icon"><i [class]="promoIcon(p.promotion_type)" aria-hidden="true"></i></span>
            <span class="pc-badge">{{ tileBadge(p) }}</span>
          </div>
          <h3>{{ p.name }}</h3>
          <p *ngIf="p.description">{{ p.description }}</p>
          <footer class="pc-foot">
            <span *ngIf="p.ends_at" class="pc-exp">
              <i class="pi pi-clock" aria-hidden="true"></i>
              Hasta {{ p.ends_at | date:'dd MMM' }}
            </span>
            <span class="pc-cta">
              Aprovechar
              <i class="pi pi-arrow-right" aria-hidden="true"></i>
            </span>
          </footer>
        </article>
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; margin-bottom: 2.5rem; }

      .pc-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        margin: 0 0.1rem 0.9rem;
      }
      .pc-eyebrow {
        display: block;
        font-size: var(--fs-micro);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--brand-700);
        margin-bottom: 0.2rem;
      }
      .pc-title h2 {
        font-family: var(--font-display);
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.05;
        color: var(--neutral-950);
        margin: 0;
      }
      .pc-head-right { display: flex; align-items: center; gap: 0.875rem; }
      .pc-link {
        font-size: var(--fs-sm);
        font-weight: 700;
        color: var(--brand-700);
        text-decoration: none;
        white-space: nowrap;
      }
      .pc-link:hover { text-decoration: underline; }
      .pc-nav { display: none; gap: 0.4rem; }
      @media (hover: hover) and (pointer: fine) { .pc-nav { display: inline-flex; } }
      .pc-arrow {
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
      .pc-arrow:hover { background: var(--neutral-100); border-color: var(--neutral-300); color: var(--neutral-950); }
      .pc-arrow:active { transform: scale(0.9); }
      .pc-arrow i { font-size: var(--fs-sm); }

      /* Rail horizontal swipeable. Deja asomar la siguiente card. */
      .pc-rail {
        display: flex;
        gap: 0.85rem;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        padding: 0.25rem 0.1rem 0.6rem;
      }
      .pc-rail::-webkit-scrollbar { display: none; }

      .pc-card {
        position: relative;
        flex: 0 0 auto;
        width: clamp(248px, 78vw, 300px);
        scroll-snap-align: start;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
        padding: 1.25rem 1.25rem 1.1rem;
        border-radius: var(--r-xl);
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        box-shadow: var(--shadow-float);
        text-decoration: none;
        color: inherit;
        cursor: pointer;
        transition: transform 200ms var(--ease-spring), box-shadow 220ms var(--ease-standard);
      }
      .pc-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-hover); }
      .pc-card:active { transform: translateY(0); }
      .pc-card:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

      .pc-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .pc-icon {
        width: 40px;
        height: 40px;
        border-radius: var(--r-md);
        display: grid;
        place-items: center;
        background: var(--brand-50);
        color: var(--brand-700);
        flex-shrink: 0;
      }
      .pc-icon i { font-size: var(--fs-h3); }
      .pc-badge {
        font-size: var(--fs-nano);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        padding: 0.28rem 0.65rem;
        border-radius: var(--r-pill);
        background: var(--brand-100);
        color: var(--brand-900);
      }
      .pc-card h3 {
        font-family: var(--font-display);
        font-size: var(--fs-h2);
        font-weight: 700;
        letter-spacing: -0.015em;
        line-height: 1.18;
        margin: 0;
        color: var(--neutral-950);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pc-card p {
        font-size: var(--fs-sm);
        color: var(--text-muted);
        line-height: 1.4;
        margin: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pc-foot {
        margin-top: auto;
        padding-top: 0.6rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        border-top: 1px solid var(--border-color);
      }
      .pc-exp {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: var(--fs-xs);
        font-weight: 600;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .pc-exp i { font-size: var(--fs-micro); }
      .pc-cta {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: var(--fs-sm);
        font-weight: 800;
        color: var(--action);
        white-space: nowrap;
      }
      .pc-cta i { font-size: var(--fs-micro); transition: transform 180ms var(--ease-standard); }
      .pc-card:hover .pc-cta i { transform: translateX(3px); }

      /* Card lead (primera) = espresso oscuro. */
      .pc-card-lead {
        background: var(--neutral-950);
        border-color: var(--neutral-900);
        color: #fff;
      }
      .pc-card-lead h3 { color: #fff; }
      .pc-card-lead p { color: rgba(255, 255, 255, 0.82); }
      .pc-card-lead .pc-icon { background: rgba(253, 231, 7, 0.16); color: var(--brand-400); }
      .pc-card-lead .pc-badge { background: var(--brand-400); color: var(--neutral-950); }
      .pc-card-lead .pc-foot { border-top-color: rgba(255, 255, 255, 0.14); }
      .pc-card-lead .pc-exp { color: rgba(255, 255, 255, 0.7); }
      .pc-card-lead .pc-cta { color: var(--brand-400); }

      /* Pre-animación: oculta las cards hasta que GSAP las revele. Solo cuando
         vamos a animar (no en reduced-motion / sin JS). */
      :host(.pc-pending) .pc-card { opacity: 0; }

      /* Foco intra-rail (scroll-driven nativo, cero JS): la card centrada queda
         a tamaño full y las de los bordes se encogen → spotlight al deslizar.
         Usa la propiedad 'scale' (no 'transform') para NO pisar el reveal de
         GSAP, que anima transform/opacity. Corre en el compositor — la inercia
         táctil nativa queda intacta. view(inline) = posición en el scroller
         horizontal. iOS Safari sin soporte → cards estáticas (gateado). */
      @supports (animation-timeline: view()) {
        @media (prefers-reduced-motion: no-preference) {
          .pc-card {
            animation: pcFocus linear both;
            animation-timeline: view(inline);
            transform-origin: center;
          }
        }
      }
      @keyframes pcFocus {
        0%   { scale: 0.94; }
        50%  { scale: 1; }
        100% { scale: 0.94; }
      }

      @media (prefers-reduced-motion: reduce) {
        .pc-card:hover { transform: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PromosCarouselComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) promos: PromotionRow[] = [];

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private viewReady = false;
  private armed = false;
  private io?: IntersectionObserver;

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
    if (this.armed || !this.viewReady || !this.promos?.length) return;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.armed = true;

    const el = this.host.nativeElement as HTMLElement;
    el.classList.add('pc-pending');
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
        const cards = el.querySelectorAll('.pc-card');
        if (cards.length) {
          gsap.set(cards, { opacity: 0, y: 22 });
          el.classList.remove('pc-pending');
          gsap.to(cards, {
            opacity: 1,
            y: 0,
            duration: 0.5,
            stagger: 0.07,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          });
        } else {
          el.classList.remove('pc-pending');
        }
        this.setupDrag(el);
      });
    } catch {
      el.classList.remove('pc-pending');
    }
  }

  /** Drag-to-scroll con momentum (solo puntero fino — touch usa scroll nativo). */
  private setupDrag(el: HTMLElement): void {
    if (this.drag || !this.Draggable) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const rail = el.querySelector('.pc-rail') as HTMLElement | null;
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
    const rail = el.querySelector('.pc-rail') as HTMLElement | null;
    if (!rail) return;
    const amount = Math.max(260, rail.clientWidth * 0.8) * dir;
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

  trackByPromo = (_i: number, p: PromotionRow) => p.id;

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

  promoIcon(type: string): string {
    const map: Record<string, string> = {
      percent_off_product: 'pi pi-percentage',
      percent_off_basket: 'pi pi-percentage',
      nxm: 'pi pi-clone',
      volume_discount: 'pi pi-box',
      bundle_fixed_price: 'pi pi-gift',
      cross_sell_discount: 'pi pi-sitemap',
    };
    return map[type] || 'pi pi-bolt';
  }
}
