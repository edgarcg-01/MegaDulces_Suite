import { Injectable } from '@angular/core';

/**
 * Efectos GSAP centrados en el carrito (lazy, fuera del árbol de Angular):
 *  - fly(): clona la imagen del producto y la hace volar en arco hasta el ícono
 *    de carrito (.cart-fx-target), que late al recibirla.
 *  - celebrate(): al cruzar el mínimo de pedido, pop de la barra + burst de
 *    "confeti" candy (Physics2D).
 * Todo apagado bajo prefers-reduced-motion. GSAP + plugins se cargan una vez.
 */
@Injectable({ providedIn: 'root' })
export class CartFxService {
  private G: any = null;
  private loading?: Promise<any>;

  private get reduced(): boolean {
    return (
      typeof window === 'undefined' ||
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }

  private gsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod: any = await import('gsap');
      const g = mod.gsap || mod.default;
      try {
        const mp = (await import('gsap/MotionPathPlugin')).MotionPathPlugin;
        const p2 = (await import('gsap/Physics2DPlugin')).Physics2DPlugin;
        g.registerPlugin(mp, p2);
      } catch {
        /* plugins opcionales — sin ellos hay fallback */
      }
      this.G = g;
      return g;
    })();
    return this.loading;
  }

  private findTarget(): HTMLElement | null {
    const els = Array.from(
      document.querySelectorAll('.cart-fx-target'),
    ) as HTMLElement[];
    return els.find((e) => e.offsetWidth > 0) || els[0] || null;
  }

  /** Vuela la imagen del producto desde `fromEl` hasta el carrito. */
  async fly(fromEl: HTMLElement | null, imageUrl: string | null): Promise<void> {
    if (this.reduced || typeof document === 'undefined' || !fromEl) return;
    const target = this.findTarget();
    if (!target) return;

    const s = fromEl.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (!s.width || !t.width) return;

    const size = Math.min(64, Math.max(40, s.width));
    const startX = s.left + s.width / 2 - size / 2;
    const startY = s.top + s.height / 2 - size / 2;
    const dx = t.left + t.width / 2 - size / 2 - startX;
    const dy = t.top + t.height / 2 - size / 2 - startY;

    const clone = document.createElement('div');
    clone.style.cssText =
      `position:fixed;left:${startX}px;top:${startY}px;width:${size}px;height:${size}px;` +
      `border-radius:50%;z-index:9999;pointer-events:none;overflow:hidden;background:#fff;` +
      `box-shadow:0 10px 24px -6px rgba(0,0,0,0.35);will-change:transform,opacity;`;
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;padding:4px;';
      clone.appendChild(img);
    } else {
      clone.style.background = 'var(--brand-400, #FDE707)';
    }
    document.body.appendChild(clone);

    try {
      const gsap = await this.gsap();
      gsap
        .timeline({ onComplete: () => { clone.remove(); this.pulse(gsap, target); } })
        .to(
          clone,
          {
            duration: 0.62,
            ease: 'power1.in',
            motionPath: { path: [{ x: dx * 0.5, y: dy * 0.5 - 170 }, { x: dx, y: dy }], curviness: 1.3 },
          },
          0,
        )
        .to(clone, { duration: 0.62, scale: 0.28, ease: 'power2.in' }, 0)
        .to(clone, { duration: 0.18, opacity: 0, ease: 'power1.in' }, 0.46);
    } catch {
      clone.remove();
    }
  }

  private pulse(gsap: any, el: HTMLElement): void {
    gsap.fromTo(
      el,
      { scale: 1 },
      { scale: 1.28, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.out', transformOrigin: 'center' },
    );
  }

  /** Celebración al alcanzar el mínimo de pedido: pop de la barra + burst candy. */
  async celebrate(): Promise<void> {
    if (this.reduced || typeof document === 'undefined') return;
    const anchor = (document.querySelector('.portal-cartbar') as HTMLElement) || this.findTarget();
    if (!anchor) return;
    let gsap: any;
    try {
      gsap = await this.gsap();
    } catch {
      return;
    }
    gsap.fromTo(
      anchor,
      { scale: 1 },
      { scale: 1.04, duration: 0.16, yoyo: true, repeat: 1, ease: 'power2.out', transformOrigin: 'center' },
    );

    const r = anchor.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const colors = ['#FDE707', '#F05A28', '#F8B400', '#16a34a', '#3B82F6'];
    const dots: HTMLElement[] = [];
    for (let i = 0; i < 16; i++) {
      const d = document.createElement('span');
      d.style.cssText =
        `position:fixed;left:${cx}px;top:${cy}px;width:9px;height:9px;border-radius:2px;` +
        `background:${colors[i % colors.length]};z-index:9999;pointer-events:none;will-change:transform,opacity;`;
      document.body.appendChild(d);
      dots.push(d);
    }
    try {
      gsap.to(dots, {
        duration: 1,
        physics2D: { velocity: 'random(240, 460)', angle: 'random(200, 340)', gravity: 700 },
        rotation: 'random(-180, 180)',
        opacity: 0,
        ease: 'power1.out',
        onComplete: () => dots.forEach((d) => d.remove()),
      });
    } catch {
      dots.forEach((d) => d.remove());
    }
  }
}
