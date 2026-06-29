import {
  Directive,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  inject,
} from '@angular/core';

/**
 * Hint "typewriter" rotativo, manejado por GSAP. Sirve para:
 *  - `<input>`/`<textarea>`: anima el atributo `placeholder`. Se pausa al
 *    enfocar o cuando hay valor, y reanuda al desenfocar vacío.
 *  - cualquier otro elemento (p.ej. un `<span>` dentro de un botón "fake
 *    search"): anima su `textContent` y rota siempre (no hay focus/valor).
 *
 * Escribe el `typeHintPrefix` fijo + cada frase de `typeHint` letra por letra,
 * con caret parpadeante; la mantiene, la borra y pasa a la siguiente (loop).
 * GSAP lazy + fuera de zona (cero change-detection). Bajo prefers-reduced-motion
 * deja el `typeHintBase` estático. Guard de generación para no encadenar
 * timelines al cambiar de frases (p.ej. togglear IA).
 *
 *   <input [typeHint]="hints" typeHintPrefix="Buscar " typeHintBase="Buscar…" />
 *   <span  [typeHint]="hints" typeHintPrefix="Buscar " typeHintBase="Buscar…"></span>
 */
@Directive({
  selector: '[typeHint]',
  standalone: true,
})
export class TypeHintDirective implements OnChanges, OnDestroy {
  @Input('typeHint') phrases: string[] = [];
  @Input() typeHintPrefix = '';
  @Input() typeHintBase = '';

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  private G: any = null;
  private gsapLoading?: Promise<any>;
  private tl?: { kill: () => void };
  private gen = 0;
  private listening = false;
  private reduced = false;
  private io?: IntersectionObserver;

  /** El host como input (anima placeholder) o null si es otro elemento (textContent). */
  private get input(): HTMLInputElement | null {
    const el = this.el.nativeElement;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      ? (el as unknown as HTMLInputElement)
      : null;
  }

  ngOnChanges(): void {
    // En gama baja tratamos el typewriter como reduced-motion: hint estático, sin
    // timeline GSAP infinito (ahorra CPU/batería en idle). Mismo path que reduced.
    const lowEnd =
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('low-end');
    this.reduced =
      lowEnd ||
      typeof window === 'undefined' ||
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.attachListeners();
    this.restart();
  }

  ngOnDestroy(): void {
    this.gen++;
    this.tl?.kill?.();
    this.io?.disconnect();
    const el = this.el.nativeElement;
    el.removeEventListener('focus', this.onFocus);
    el.removeEventListener('blur', this.onBlur);
    el.removeEventListener('input', this.onInput);
  }

  /** Solo inputs tienen focus/valor → solo ellos llevan listeners de pausa. */
  private attachListeners(): void {
    if (this.listening || typeof window === 'undefined' || !this.input) return;
    this.listening = true;
    const el = this.el.nativeElement;
    // Fuera de zona: pausar/reanudar el typewriter no necesita change-detection.
    this.zone.runOutsideAngular(() => {
      el.addEventListener('focus', this.onFocus, { passive: true });
      el.addEventListener('blur', this.onBlur, { passive: true });
      el.addEventListener('input', this.onInput, { passive: true });
    });
  }

  private onFocus = (): void => this.stop();
  private onBlur = (): void => {
    if (!this.input?.value) this.restart();
  };
  private onInput = (): void => {
    if (this.input?.value) this.stop();
  };

  /** Escribe el hint en placeholder (input) o textContent (resto). */
  private setHint(value: string): void {
    const input = this.input;
    if (input) input.placeholder = value;
    else this.el.nativeElement.textContent = value;
  }

  /** Detiene la animación y deja el hint base (reposo/pausa). */
  private stop(): void {
    this.gen++;
    this.tl?.kill?.();
    this.tl = undefined;
    this.setHint(this.typeHintBase);
  }

  private write(text: string, caret = true): void {
    this.setHint(this.typeHintPrefix + text + (caret ? '|' : ''));
  }

  private restart(): void {
    this.tl?.kill?.();
    this.tl = undefined;
    const el = this.el.nativeElement;
    const myGen = ++this.gen;

    const focused =
      typeof document !== 'undefined' && el === document.activeElement;
    // Sin animación: deja el base (reduced-motion, sin frases, enfocado o con valor).
    if (this.reduced || !this.phrases?.length || focused || this.input?.value) {
      this.setHint(this.typeHintBase);
      return;
    }

    // Base inmediato: nunca un hint vacío mientras GSAP carga (lazy).
    this.setHint(this.typeHintBase);

    this.zone.runOutsideAngular(async () => {
      let gsap: any;
      try {
        gsap = await this.ensureGsap();
      } catch {
        this.setHint(this.typeHintBase);
        return;
      }
      // El estado pudo cambiar mientras cargaba GSAP (focus, valor, nuevas frases).
      if (myGen !== this.gen || el === document.activeElement || this.input?.value) return;

      const tl = gsap.timeline({ repeat: -1 });
      for (const phrase of this.phrases) {
        const st = { n: 0 };
        tl.to(st, {
          n: phrase.length,
          duration: Math.max(0.4, phrase.length * 0.05),
          ease: 'none',
          onUpdate: () => this.write(phrase.slice(0, Math.round(st.n))),
        });
        // Hold ~1.5s con caret parpadeante.
        for (let b = 0; b < 3; b++) {
          tl.to({}, { duration: 0.25, onComplete: () => this.write(phrase, false) })
            .to({}, { duration: 0.25, onComplete: () => this.write(phrase, true) });
        }
        // Borrado (más rápido) + respiro antes de la siguiente.
        tl.to(st, {
          n: 0,
          duration: Math.max(0.25, phrase.length * 0.03),
          ease: 'none',
          onUpdate: () => this.write(phrase.slice(0, Math.round(st.n))),
        }).to({}, { duration: 0.3 });
      }

      if (myGen !== this.gen) {
        tl.kill();
        return;
      }
      this.tl = tl;
      this.setupVisibility();
    });
  }

  /** Pausa el timeline cuando el host sale del viewport (no quema CPU fuera de vista). */
  private setupVisibility(): void {
    if (this.io || typeof IntersectionObserver === 'undefined') return;
    const el = this.el.nativeElement;
    this.zone.runOutsideAngular(() => {
      this.io = new IntersectionObserver((entries) => {
        const tl = this.tl as unknown as { play: () => void; pause: () => void } | undefined;
        if (!tl) return;
        if (entries.some((e) => e.isIntersecting)) {
          if (!this.input?.value && el !== document.activeElement) tl.play();
        } else {
          tl.pause();
        }
      });
      this.io.observe(el);
    });
  }

  private ensureGsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = import('gsap').then((m: any) => (this.G = m.gsap || m.default));
    return this.gsapLoading;
  }
}
