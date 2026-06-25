import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  NgZone,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * "Escaparate de bienvenida" del login: un producto real de dulcería CAE con
 * rebote sobre su sombra de contacto bajo un spotlight ámbar, con dos destellos
 * que titilan una vez. Mismo lenguaje que el escaparate del home. Toda la
 * coreografía en UNA timeline GSAP (lazy, fuera de zona, CustomEase para el
 * asentamiento), apagada bajo prefers-reduced-motion (producto estático).
 * Parallax sutil ligado al scroll con view() nativo (cero JS).
 */
@Component({
  selector: 'portal-auth-stage',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="as" aria-hidden="true">
      <span class="as-spot"></span>
      <span class="as-shadow"></span>
      <img class="as-product" [src]="image" alt="" decoding="async" />
      <span class="as-spark as-spark-1"></span>
      <span class="as-spark as-spark-2"></span>
    </div>
  `,
  styles: [
    `
      :host { display: block; width: 100%; height: 100%; }

      .as {
        position: relative;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        overflow: visible;
      }
      .as-spot {
        position: absolute;
        width: min(360px, 92%);
        aspect-ratio: 1;
        border-radius: 50%;
        background: radial-gradient(circle,
          rgba(248, 180, 0, 0.32) 0%,
          rgba(248, 180, 0, 0.10) 42%,
          transparent 70%);
        filter: blur(6px);
        z-index: 0;
        pointer-events: none;
      }
      .as-product {
        position: relative;
        z-index: 1;
        width: clamp(150px, 46vw, 240px);
        height: auto;
        object-fit: contain;
        filter: drop-shadow(0 20px 26px rgba(16, 13, 9, 0.22));
        will-change: transform;
      }
      .as-shadow {
        position: absolute;
        z-index: 0;
        bottom: 12%;
        left: 50%;
        transform: translateX(-50%);
        width: clamp(100px, 30vw, 168px);
        height: 24px;
        border-radius: 50%;
        background: radial-gradient(ellipse at center,
          rgba(16, 13, 9, 0.30) 0%,
          rgba(16, 13, 9, 0.13) 45%,
          rgba(16, 13, 9, 0) 72%);
        filter: blur(7px);
        pointer-events: none;
      }
      .as-spark {
        position: absolute;
        z-index: 2;
        border-radius: 50%;
        pointer-events: none;
      }
      .as-spark-1 { width: 9px; height: 9px; background: var(--brand-400, #FDE707); top: 18%; right: 22%; }
      .as-spark-2 { width: 6px; height: 6px; background: var(--action, #F05A28); top: 32%; left: 20%; }

      /* Pre-hide solo mientras vamos a animar (no en reduced-motion / sin JS). */
      :host(.as-pending) .as-spot,
      :host(.as-pending) .as-shadow,
      :host(.as-pending) .as-product,
      :host(.as-pending) .as-spark { opacity: 0; }

      /* Parallax sutil al scroll (compositor, cero JS). Usa 'translate' (no
         'transform') para no pisar el transform de la entrada GSAP. */
      @supports (animation-timeline: view()) {
        @media (prefers-reduced-motion: no-preference) {
          .as-product {
            animation: asParallax linear both;
            animation-timeline: view();
          }
        }
      }
      @keyframes asParallax {
        from { translate: 0 -12px; }
        to   { translate: 0 16px; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthStageComponent implements AfterViewInit {
  @Input() image = '/assets/brands/nucita.webp';

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tweens: any[] = [];

  ngAfterViewInit(): void {
    if (
      typeof window === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return; // estático
    }
    const el = this.host.nativeElement;
    el.classList.add('as-pending');
    this.animate(el);
    this.destroyRef.onDestroy(() => this.tweens.forEach((t) => t?.kill?.()));
  }

  private async animate(el: HTMLElement): Promise<void> {
    let gsap: any;
    let settle = 'back.out(1.5)';
    try {
      const mod: any = await import('gsap');
      gsap = mod.gsap || mod.default;
      try {
        const CustomEase = (await import('gsap/CustomEase')).CustomEase;
        gsap.registerPlugin(CustomEase);
        CustomEase.create('asSettle', 'M0,0 C0.18,0 0.1,1.12 0.42,1.04 0.64,0.98 0.82,1 1,1');
        settle = 'asSettle';
      } catch {
        /* sin CustomEase → back.out */
      }
    } catch {
      el.classList.remove('as-pending');
      return;
    }

    this.zone.runOutsideAngular(() => {
      const spot = el.querySelector('.as-spot');
      const product = el.querySelector('.as-product');
      const shadow = el.querySelector('.as-shadow');
      const sparks = el.querySelectorAll('.as-spark');
      el.classList.remove('as-pending');

      const tl = gsap.timeline();
      tl.from(spot, { scale: 0.4, opacity: 0, duration: 0.7, ease: 'power2.out' })
        .from(
          product,
          { y: -110, scale: 0.64, rotation: -9, opacity: 0, duration: 1.0, ease: settle, clearProps: 'transform' },
          '-=0.5',
        )
        .from(shadow, { scaleX: 0.35, opacity: 0, duration: 0.5, ease: 'power2.out' }, '-=0.3')
        .from(sparks, { scale: 0, opacity: 0, duration: 0.5, stagger: 0.12, ease: 'back.out(2.2)' }, '-=0.45');
      this.tweens.push(tl);

      // Un solo titileo de los destellos (no loop) — brillo, sin distraer.
      const twinkle = gsap.to(sparks, {
        scale: 1.35,
        opacity: 0.55,
        duration: 0.6,
        stagger: 0.18,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut',
        delay: 1.3,
      });
      this.tweens.push(twinkle);
    });
  }
}
