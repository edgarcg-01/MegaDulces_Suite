import {
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';

type CountUpFormat = 'int' | 'decimal1' | 'percent1' | 'money' | 'money-short';

/**
 * Count-up del valor de una KPI card (DESIGN.md "Motion de KPI cards" #3).
 * - Arranca on-view (IntersectionObserver), UNA sola vez. Nunca re-tween en refresh.
 * - ~900ms, ease-out (rAF → sin librería). Bajo prefers-reduced-motion: valor final instantáneo.
 * - Escribe el textContent del host; el formato replica los `fmt*` del Command Center.
 *
 * Uso: <span [appCountUp]="overview()?.orders?.fulfilled ?? 0" countUpFormat="int"></span>
 */
@Directive({
  selector: '[appCountUp]',
  standalone: true,
})
export class CountUpDirective implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>).nativeElement;

  private target = 0;
  private visible = false;
  private done = false;
  private raf = 0;
  private io?: IntersectionObserver;

  private current = 0;

  @Input('appCountUp') set value(v: number | null | undefined) {
    this.target = Number(v) || 0;
    if (this.done) {
      // Ya animó una vez. Live (J17): re-anima el cambio (número que "rueda").
      // Default (refresh normal): valor final instantáneo.
      if (this.appCountUpLive && !this.reduce()) this.tween(this.current, this.target, 600);
      else this.render(this.target);
    } else {
      this.maybeStart();
    }
  }

  /** Modo dato-vivo (J17): en cada cambio posterior al primer paint, re-anima de valor anterior → nuevo. */
  @Input() appCountUpLive = false;

  @Input() countUpFormat: CountUpFormat = 'int';

  ngOnInit(): void {
    this.render(0);
    this.io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.visible = true;
          this.maybeStart();
        }
      },
      { threshold: 0.2 },
    );
    this.io.observe(this.el);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.io?.disconnect();
  }

  private maybeStart(): void {
    if (this.done || !this.visible || !this.io) return;
    this.done = true;
    this.io.disconnect();

    if (this.reduce() || this.target === 0) {
      this.render(this.target);
      return;
    }
    this.tween(0, this.target, 900);
  }

  private reduce(): boolean {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** Anima de `from` a `to` (ease-out cubic, rAF). Reusado por el primer paint y por live. */
  private tween(from: number, to: number, dur: number): void {
    cancelAnimationFrame(this.raf);
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      this.render(from + (to - from) * eased);
      if (p < 1) this.raf = requestAnimationFrame(step);
      else this.render(to);
    };
    this.raf = requestAnimationFrame(step);
  }

  private render(v: number): void {
    this.current = v;
    this.el.textContent = this.format(v);
  }

  private format(v: number): string {
    switch (this.countUpFormat) {
      case 'money-short': {
        if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
        if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
        return '$' + Math.round(v).toFixed(0);
      }
      case 'money':
        return new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          maximumFractionDigits: 0,
        }).format(v);
      case 'percent1':
        return (
          new Intl.NumberFormat('es-MX', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }).format(v) + '%'
        );
      case 'decimal1':
        return new Intl.NumberFormat('es-MX', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(v);
      default:
        return new Intl.NumberFormat('es-MX', {
          maximumFractionDigits: 0,
        }).format(v);
    }
  }
}
