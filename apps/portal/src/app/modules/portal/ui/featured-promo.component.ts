import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  NgZone,
  OnDestroy,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

/**
 * "Escaparate vivo" — promo destacada que ROTA entre varios productos (uno a la
 * vez): cada uno entra dramático y queda quieto; swap suave con GSAP; dots de
 * navegación; pausa al hover. Título cinético (SplitText) + subrayado dibujado
 * (DrawSVG) + CTA magnético. Todo lazy/fuera de zona; estático bajo reduced-motion.
 */
@Component({
  selector: 'portal-featured-promo',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <section class="fp" *ngIf="images.length">
      <div class="fp-text">
        <span class="fp-eyebrow"><i class="pi pi-bolt" aria-hidden="true"></i> {{ eyebrow }}</span>
        <h2 class="fp-title">{{ title }}</h2>
        <svg class="fp-underline" viewBox="0 0 220 16" aria-hidden="true" preserveAspectRatio="none">
          <path d="M5 9 C 55 2, 130 2, 215 7" fill="none" stroke="var(--brand-700)" stroke-width="3.5" stroke-linecap="round" />
        </svg>
        <p class="fp-lead">{{ lead }}</p>
        <div class="fp-row">
          <span class="fp-badge">{{ badge }}</span>
          <a class="fp-cta" [routerLink]="ctaLink" [attr.aria-label]="ctaLabel">
            {{ ctaLabel }}
            <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </a>
        </div>
      </div>

      <div class="fp-stage" aria-hidden="true">
        <span class="fp-shadow"></span>
        <img class="fp-jar" alt="" decoding="async" />
      </div>

      <div class="fp-dots" *ngIf="images.length > 1" role="tablist" aria-label="Productos de la promo">
        <button
          *ngFor="let im of images; let i = index"
          type="button"
          class="fp-dot"
          (click)="goTo(i)"
          [attr.aria-label]="'Ver producto ' + (i + 1)"
        ></button>
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; }

      .fp {
        position: relative;
        overflow: hidden;
        display: grid;
        grid-template-columns: 1.15fr 1fr;
        align-items: center;
        gap: 1.5rem;
        min-height: 300px;
        padding: 2.25rem 2.25rem;
        border-radius: var(--r-2xl);
        background: var(--card-bg, #fff);
        border: 1px solid var(--border-color, #ECE7DE);
        box-shadow: var(--shadow-float);
        color: var(--text-main, #100D09);
        isolation: isolate;
      }

      .fp-text { position: relative; z-index: 2; min-width: 0; }
      .fp-eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: var(--fs-micro);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--brand-700, #F05A28);
        margin-bottom: 0.9rem;
      }
      .fp-eyebrow i { font-size: var(--fs-micro); }
      .fp-title {
        font-family: var(--font-display);
        font-size: var(--text-display-lg);
        font-weight: 800;
        line-height: 1.02;
        letter-spacing: -0.02em;
        margin: 0 0 0.5rem;
        color: var(--neutral-950, #100D09);
      }
      .fp-underline {
        display: block;
        width: clamp(150px, 20vw, 220px);
        height: 14px;
        margin: -2px 0 1rem;
        overflow: visible;
      }
      .fp-lead {
        font-size: var(--fs-h3);
        line-height: 1.5;
        color: var(--text-muted, #5E564B);
        margin: 0 0 1.4rem;
        max-width: 40ch;
      }
      .fp-row { display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; }
      .fp-badge {
        font-family: var(--font-display);
        font-weight: 800;
        font-size: var(--fs-h3);
        letter-spacing: -0.01em;
        color: var(--neutral-950, #100d09);
        background: var(--brand-400, #FDE707);
        padding: 0.4rem 0.85rem;
        border-radius: var(--r-pill);
        box-shadow: 0 8px 20px -10px rgba(248, 180, 0, 0.6);
      }
      .fp-cta {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 700;
        font-size: 0.95rem;
        color: #fff;
        background: var(--action, #F05A28);
        border-radius: var(--r-pill);
        padding: 0.8rem 1.4rem;
        min-height: 48px;
        text-decoration: none;
        box-shadow: 0 12px 26px -10px var(--action-ring, rgba(240, 90, 40, 0.5)),
                    inset 0 -3px 0 rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.18);
        transition: background-color 160ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
        will-change: transform;
      }
      .fp-cta:hover { background: var(--action-hover, #D2451C); }
      .fp-cta i { transition: transform 180ms var(--ease-standard); }
      .fp-cta:hover i { transform: translateX(3px); }

      .fp-stage {
        position: relative;
        z-index: 1;
        display: grid;
        place-items: center;
        height: 100%;
        min-height: 240px;
      }
      .fp-jar {
        position: relative;
        z-index: 1;
        width: clamp(150px, 24vw, 240px);
        height: auto;
        object-fit: contain;
        filter: drop-shadow(0 18px 22px rgba(16, 13, 9, 0.20));
        will-change: transform, opacity;
      }
      /* Sombra de contacto en el "piso": el producto flota sobre ella y aterriza
         en la entrada/swap. Estática (no la mueve GSAP) — solo el producto bobea. */
      .fp-shadow {
        position: absolute;
        z-index: 0;
        bottom: 9%;
        left: 50%;
        width: clamp(108px, 17vw, 172px);
        height: 26px;
        transform: translateX(-50%);
        border-radius: 50%;
        background: radial-gradient(ellipse at center,
          rgba(16, 13, 9, 0.30) 0%,
          rgba(16, 13, 9, 0.14) 44%,
          rgba(16, 13, 9, 0) 72%);
        filter: blur(7px);
        pointer-events: none;
      }
      @media (max-width: 760px) {
        .fp-shadow { width: clamp(70px, 24vw, 120px); height: 18px; filter: blur(5px); }
      }

      .fp-dots {
        position: absolute;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        gap: 6px;
        z-index: 3;
      }
      .fp-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        border: none;
        padding: 0;
        background: var(--neutral-300);
        cursor: pointer;
        transition: background-color 0.2s var(--ease-standard), width 0.25s var(--ease-standard);
      }
      .fp-dot.is-active { background: var(--action, #F05A28); width: 18px; }

      /* Móvil: NO se apila — texto a la izquierda, producto a la derecha. */
      @media (max-width: 760px) {
        .fp {
          grid-template-columns: 1.25fr 0.85fr;
          padding: 1.4rem 1.15rem 1.7rem;
          gap: 0.85rem;
          min-height: 196px;
        }
        .fp-title { font-size: var(--fs-h1); }
        .fp-lead { font-size: var(--fs-body); margin-bottom: 1rem; }
        .fp-stage { min-height: 140px; }
        .fp-jar { width: clamp(92px, 32vw, 150px); }
        .fp-cta { padding: 0.7rem 1.1rem; }
      }

      /* Parallax scroll-driven nativo: el producto deriva sutil al scrollear,
         dando profundidad. Va sobre .fp-stage (el padre) — GSAP solo anima
         .fp-jar (el hijo), así que no chocan. Compositor, cero JS. */
      @supports (animation-timeline: view()) {
        @media (prefers-reduced-motion: no-preference) {
          .fp-stage {
            animation: fpStageParallax linear both;
            animation-timeline: view();
            animation-range: cover;
          }
        }
      }
      @keyframes fpStageParallax {
        from { transform: translateY(18px); }
        to   { transform: translateY(-18px); }
      }

      @media (prefers-reduced-motion: reduce) {
        .fp-jar, .fp-cta { will-change: auto; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeaturedPromoComponent implements AfterViewInit, OnDestroy {
  @Input() eyebrow = 'Promo destacada';
  @Input() title = 'Llévate un exhibidor gratis';
  @Input() lead = 'En la compra de 6 productos Nutresa, te regalamos 1 exhibidor de Nucita Trisabor.';
  @Input() badge = '6 + 1 GRATIS';
  @Input() ctaLabel = 'Aprovechar';
  @Input() ctaLink = '/portal/promotions';
  /** Productos que rotan en el escaparate. */
  @Input({ required: true }) images: string[] = [];

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private io?: IntersectionObserver;
  private armed = false;
  private G: any = null;
  private SplitTextCtor: any = null;
  private split: any = null;
  private gsapLoading?: Promise<any>;
  private readonly cleanupFns: Array<() => void> = [];
  private readonly tweens: any[] = [];

  private index = 0;
  private timer: any = null;
  private jar?: HTMLImageElement;
  private dots: HTMLElement[] = [];

  ngAfterViewInit(): void {
    const el = this.host.nativeElement as HTMLElement;
    this.jar = el.querySelector('.fp-jar') as HTMLImageElement;
    this.dots = Array.from(el.querySelectorAll('.fp-dot')) as HTMLElement[];

    // Primer producto visible siempre (también bajo reduced-motion / sin GSAP).
    if (this.jar && this.images.length) this.jar.setAttribute('src', this.images[0]);
    this.setActive(0);
    // Preload para que el swap no parpadee.
    if (typeof Image !== 'undefined') this.images.forEach((s) => { const i = new Image(); i.src = s; });

    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return; // estático + dots

    this.io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.io?.disconnect();
          this.animate(el);
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    this.io.observe(el);
    this.destroyRef.onDestroy(() => this.teardown());
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  private teardown(): void {
    this.io?.disconnect();
    this.stopTimer();
    this.tweens.forEach((t) => t?.kill?.());
    this.split?.revert?.();
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns.length = 0;
  }

  private setActive(i: number): void {
    this.dots.forEach((d, idx) => d.classList.toggle('is-active', idx === i));
  }

  private ensureGsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = (async () => {
      const mod: any = await import('gsap');
      const gsap = mod.gsap || mod.default;
      try {
        const [draw, split] = await Promise.all([
          import('gsap/DrawSVGPlugin'),
          import('gsap/SplitText'),
        ]);
        gsap.registerPlugin(draw.DrawSVGPlugin, split.SplitText);
        this.SplitTextCtor = split.SplitText;
      } catch {
        /* plugins opcionales */
      }
      this.G = gsap;
      return gsap;
    })();
    return this.gsapLoading;
  }

  private async animate(el: HTMLElement): Promise<void> {
    if (this.armed) return;
    this.armed = true;
    let gsap: any;
    try {
      gsap = await this.ensureGsap();
    } catch {
      return;
    }

    const card = el.querySelector('.fp') as HTMLElement;
    const jar = this.jar;
    const cta = el.querySelector('.fp-cta') as HTMLElement;
    if (!card || !jar) return;

    this.zone.runOutsideAngular(() => {
      // Título cinético (SplitText) — fallback al <h2> entero.
      let titleTargets: any = el.querySelector('.fp-title');
      try {
        if (this.SplitTextCtor && titleTargets) {
          this.split = new this.SplitTextCtor(titleTargets, { type: 'chars' });
          titleTargets = this.split.chars;
        }
      } catch {
        /* sin SplitText */
      }

      // Entrada DRAMÁTICA del producto; luego queda inmóvil.
      const tl = gsap.timeline();
      tl.from(jar, { y: 70, scale: 0.66, rotation: -8, opacity: 0, duration: 0.9, ease: 'back.out(1.7)' })
        .from('.fp-eyebrow', { y: 14, opacity: 0, duration: 0.4 }, '-=0.55')
        .from(titleTargets, { y: 22, opacity: 0, stagger: 0.025, duration: 0.5, ease: 'back.out(1.4)' }, '-=0.35')
        .from('.fp-underline path', { drawSVG: 0, duration: 0.6, ease: 'power2.out' }, '-=0.15')
        .from('.fp-lead', { y: 14, opacity: 0, duration: 0.45 }, '-=0.4')
        .from('.fp-row', { y: 14, opacity: 0, duration: 0.45 }, '-=0.3');
      this.tweens.push(tl);

      // CTA magnético.
      if (cta) {
        const cx = gsap.quickTo(cta, 'x', { duration: 0.4, ease: 'power3' });
        const cy = gsap.quickTo(cta, 'y', { duration: 0.4, ease: 'power3' });
        const cMove = (e: PointerEvent) => {
          const r = cta.getBoundingClientRect();
          cx(((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * 6);
          cy(((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * 6);
        };
        const cLeave = () => { cx(0); cy(0); };
        cta.addEventListener('pointermove', cMove);
        cta.addEventListener('pointerleave', cLeave);
        this.cleanupFns.push(() => {
          cta.removeEventListener('pointermove', cMove);
          cta.removeEventListener('pointerleave', cLeave);
        });
      }

      // Rotación de productos (pausa al hover).
      if (this.images.length > 1) {
        const pause = () => this.stopTimer();
        const resume = () => this.startTimer();
        card.addEventListener('pointerenter', pause);
        card.addEventListener('pointerleave', resume);
        this.cleanupFns.push(() => {
          card.removeEventListener('pointerenter', pause);
          card.removeEventListener('pointerleave', resume);
        });
        // Arranca tras la entrada.
        tl.add(() => this.startTimer());
      }
    });
  }

  private startTimer(): void {
    this.stopTimer();
    if (this.images.length > 1) this.timer = setInterval(() => this.swap((this.index + 1) % this.images.length), 4800);
  }
  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Click en un dot (corre en zona) → swap manual + reinicia el ciclo. */
  goTo(i: number): void {
    if (i === this.index) return;
    this.stopTimer();
    this.swap(i);
    this.startTimer();
  }

  private swap(toIdx: number): void {
    const jar = this.jar;
    if (!jar || toIdx === this.index || !this.images[toIdx]) return;
    const src = this.images[toIdx];
    if (!this.G) {
      jar.setAttribute('src', src);
      this.index = toIdx;
      this.setActive(toIdx);
      return;
    }
    const gsap = this.G;
    this.zone.runOutsideAngular(() => {
      gsap
        .timeline()
        .to(jar, { y: -22, scale: 0.92, opacity: 0, duration: 0.32, ease: 'power2.in' })
        .add(() => {
          jar.setAttribute('src', src);
          this.index = toIdx;
          this.setActive(toIdx);
        })
        .fromTo(
          jar,
          { y: 44, scale: 0.7, rotation: -6, opacity: 0 },
          { y: 0, scale: 1, rotation: 0, opacity: 1, duration: 0.75, ease: 'back.out(1.6)' },
        );
    });
  }
}
