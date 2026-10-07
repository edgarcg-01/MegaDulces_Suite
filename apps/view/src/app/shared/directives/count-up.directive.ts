import {
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';

type CountUpFormat = 'int' | 'decimal1' | 'percent1' | 'money' | 'money-short' | 'money2';

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

  /**
   * `[TDA.7]` La compuerta on-view NO puede decidir si el número es correcto.
   *
   * Como estaba: `ngOnInit` escribía `0` y `maybeStart()` no arrancaba hasta que el
   * `IntersectionObserver` reportara la intersección. Si el elemento no llegaba a estar ≥20 % en
   * viewport, **la cifra se quedaba en cero** — y `prefers-reduced-motion` tampoco rescataba,
   * porque la compuerta de visibilidad corre antes que la del movimiento. Se curaba con scroll,
   * que es justo lo que nadie hace en un mostrador.
   *
   * En el verificador eso significaba publicar "Te ahorras $0.00" cuando la pastilla caía abajo
   * del pliegue. Lo que reemplazó era interpolación directa: siempre correcta. ADR-056 lo dice
   * por nombre — lo que no se pudo medir se declara, nunca se dibuja como cero.
   *
   * Ahora: en modo `live` la cifra es DATO y el count-up es una mejora, así que se anima de una
   * sin esperar intersección (el motivo del gate —cards abajo del pliegue en un tablero largo—
   * no aplica a una tarjeta de captura que está en pantalla por construcción). Y si el navegador
   * no trae `IntersectionObserver`, se anima igual en vez de quedarse mudo.
   */
  ngOnInit(): void {
    if (this.appCountUpLive || typeof IntersectionObserver === 'undefined') {
      this.visible = true;
      this.maybeStart();
      return;
    }
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
    // `[TDA.7]` Ya no exige `this.io`: en modo live y sin IntersectionObserver no hay observador
    // que esperar, y pedirlo dejaba la cifra congelada en el valor inicial.
    if (this.done || !this.visible) return;
    this.done = true;
    this.io?.disconnect();

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
      /**
       * `[TDA.6]` Dinero CON centavos. Faltaba, y la ausencia no era neutral: los tres
       * formatos de dinero de acá redondean (`money` a peso entero, `money-short` a K/M),
       * así que un importe al centavo se publicaba distinto del que dice la fuente —
       * $25.77 salía **$26**. En un KPI de tablero eso es una decisión de densidad; en el
       * mostrador es otro número.
       * Replica exacto el `money()` del verificador (`minimum` y `maximum` en 2), para que
       * la cifra que termina de contar sea idéntica a la que ya se pinta al lado.
       */
      case 'money2':
        return new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
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
