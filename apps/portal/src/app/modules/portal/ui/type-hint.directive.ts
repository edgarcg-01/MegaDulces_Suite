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
 * Placeholder "typewriter" rotativo para inputs de búsqueda, manejado por GSAP.
 * Escribe el `typeHintPrefix` fijo + cada frase de `typeHint` letra por letra,
 * con caret parpadeante, la mantiene, la borra y pasa a la siguiente (loop).
 *
 * - Se pausa cuando el input está enfocado o tiene valor; reanuda al desenfocar
 *   vacío (no distrae mientras se teclea, y el screen-reader oye el base estable).
 * - Bajo prefers-reduced-motion deja el `typeHintBase` estático, sin animar.
 * - GSAP lazy + fuera de zona (cero change-detection). Guard de generación para
 *   no encadenar timelines al cambiar de frases (p.ej. al togglear IA).
 *
 *   <input [typeHint]="['chocolates','paletas']" typeHintPrefix="Buscar "
 *          typeHintBase="Buscar producto o marca…" />
 */
@Directive({
  selector: '[typeHint]',
  standalone: true,
})
export class TypeHintDirective implements OnChanges, OnDestroy {
  @Input('typeHint') phrases: string[] = [];
  @Input() typeHintPrefix = '';
  @Input() typeHintBase = '';

  private readonly el = inject<ElementRef<HTMLInputElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  private G: any = null;
  private gsapLoading?: Promise<any>;
  private tl?: { kill: () => void };
  private gen = 0;
  private listening = false;
  private reduced = false;

  ngOnChanges(): void {
    this.reduced =
      typeof window === 'undefined' ||
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.attachListeners();
    this.restart();
  }

  ngOnDestroy(): void {
    this.gen++;
    this.tl?.kill?.();
    const el = this.el.nativeElement;
    el.removeEventListener('focus', this.onFocus);
    el.removeEventListener('blur', this.onBlur);
    el.removeEventListener('input', this.onInput);
  }

  private attachListeners(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    const el = this.el.nativeElement;
    el.addEventListener('focus', this.onFocus, { passive: true });
    el.addEventListener('blur', this.onBlur, { passive: true });
    el.addEventListener('input', this.onInput, { passive: true });
  }

  private onFocus = (): void => this.stop();
  private onBlur = (): void => {
    if (!this.el.nativeElement.value) this.restart();
  };
  private onInput = (): void => {
    if (this.el.nativeElement.value) this.stop();
  };

  /** Detiene la animación y deja el placeholder base (estado en reposo/pausa). */
  private stop(): void {
    this.gen++;
    this.tl?.kill?.();
    this.tl = undefined;
    this.el.nativeElement.placeholder = this.typeHintBase;
  }

  private write(text: string, caret = true): void {
    this.el.nativeElement.placeholder =
      this.typeHintPrefix + text + (caret ? '|' : '');
  }

  private restart(): void {
    this.tl?.kill?.();
    this.tl = undefined;
    const el = this.el.nativeElement;
    const myGen = ++this.gen;

    // Sin animación: deja el base (reduced-motion, sin frases, enfocado o con valor).
    if (
      this.reduced ||
      !this.phrases?.length ||
      el === (typeof document !== 'undefined' ? document.activeElement : null) ||
      el.value
    ) {
      el.placeholder = this.typeHintBase;
      return;
    }

    this.zone.runOutsideAngular(async () => {
      let gsap: any;
      try {
        gsap = await this.ensureGsap();
      } catch {
        el.placeholder = this.typeHintBase;
        return;
      }
      // El estado pudo cambiar mientras cargaba GSAP (focus, valor, nuevas frases).
      if (myGen !== this.gen || el === document.activeElement || el.value) return;

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
    });
  }

  private ensureGsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = import('gsap').then((m: any) => (this.G = m.gsap || m.default));
    return this.gsapLoading;
  }
}
