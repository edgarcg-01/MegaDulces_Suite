import {
  Directive,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  inject,
} from '@angular/core';

/**
 * Anima un número hacia su nuevo valor (count-up) escribiendo el texto del
 * elemento. GSAP lazy + fuera de zona; bajo prefers-reduced-motion (o primer
 * render) escribe el valor final directo. `countCurrency` formatea como MXN.
 *
 *   <span [countUp]="cart.cartTotal()"></span>
 *   <span [countUp]="subtotal" [countCurrency]="false"></span>
 */
@Directive({
  selector: '[countUp]',
  standalone: true,
})
export class CountUpDirective implements OnChanges {
  @Input('countUp') value: number | string | null = 0;
  @Input() countCurrency = true;

  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);

  private prev = 0;
  private first = true;
  private G: any = null;
  private loading?: Promise<any>;
  private tween?: { kill: () => void };

  ngOnChanges(): void {
    const target = Number(this.value) || 0;
    const from = this.prev;
    this.prev = target;

    const reduced =
      typeof window === 'undefined' ||
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (this.first || reduced || from === target) {
      this.first = false;
      this.write(target);
      return;
    }
    this.run(from, target);
  }

  private async run(from: number, target: number): Promise<void> {
    try {
      const gsap = await this.gsap();
      this.zone.runOutsideAngular(() => {
        this.tween?.kill?.();
        const obj = { v: from };
        this.tween = gsap.to(obj, {
          v: target,
          duration: 0.5,
          ease: 'power2.out',
          onUpdate: () => this.write(obj.v),
          onComplete: () => this.write(target),
        });
      });
    } catch {
      this.write(target);
    }
  }

  private write(v: number): void {
    this.el.nativeElement.textContent = this.fmt(v);
  }

  private fmt(v: number): string {
    if (!this.countCurrency) return Math.round(v).toLocaleString('es-MX');
    try {
      return new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(v);
    } catch {
      return `$${v.toFixed(2)}`;
    }
  }

  private gsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod: any = await import('gsap');
      this.G = mod.gsap || mod.default;
      return this.G;
    })();
    return this.loading;
  }
}
