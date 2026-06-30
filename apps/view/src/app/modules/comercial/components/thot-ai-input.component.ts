import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  NgZone,
  OnInit,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface ThotAsk {
  text: string;
  think: boolean;
  deepSearch: boolean;
}

/**
 * Entrada de IA para Thot — puerto fiel del patrón "ai-chat-input" (shadcn/React).
 * Adaptado a nuestro stack: animaciones CSS (sin motion/react) y PrimeIcons (sin lucide),
 * pero conservando el look original (píldora blanca, expansión spring, placeholder con
 * reveal letra-por-letra y blur, toggles Think / Deep Search). Emite (ask) al enviar.
 */
@Component({
  selector: 'app-thot-ai-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="aci" [class.expanded]="active() || !!value" (click)="activate()">
      <!-- Fila de input -->
      <div class="aci-row">
        <button class="aci-ic" type="button" tabindex="-1" aria-label="Adjuntar" title="Adjuntar">
          <i class="pi pi-paperclip" aria-hidden="true"></i>
        </button>

        <div class="aci-field">
          <input
            #inp
            type="text"
            [(ngModel)]="value"
            (focus)="activate()"
            (keydown.enter)="submit()"
            [attr.aria-label]="hintBase()"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
          />
          @if (!active() && !value) {
            <div class="aci-ph" aria-hidden="true">
              <span class="aci-ph-line">
                @for (ch of letters(); track phIndex() + ':' + $index) {
                  <span
                    class="aci-ch"
                    [class.is-out]="phOut()"
                    [style.--i]="$index"
                    [style.--o]="letters().length - 1 - $index"
                  >{{ ch === ' ' ? ' ' : ch }}</span>
                }
              </span>
            </div>
          }
        </div>

        <button class="aci-ic" type="button" tabindex="-1" aria-label="Dictar" title="Dictar por voz">
          <i class="pi pi-microphone" aria-hidden="true"></i>
        </button>
        <button
          class="aci-send"
          type="button"
          (click)="submit(); $event.stopPropagation()"
          [disabled]="!value.trim()"
          aria-label="Enviar"
          title="Enviar"
        >
          <i class="pi pi-send" aria-hidden="true"></i>
        </button>
      </div>

      <!-- Controles expandibles -->
      <div class="aci-ctrls">
        <button
          class="aci-tg"
          type="button"
          [class.on]="think()"
          [attr.aria-pressed]="think()"
          (click)="toggleThink($event)"
          title="Razonar"
        >
          <i class="pi pi-bolt" aria-hidden="true"></i> Think
        </button>

        <button
          class="aci-tg aci-tg-grow"
          type="button"
          [class.on]="deepSearch()"
          [attr.aria-pressed]="deepSearch()"
          (click)="toggleDeep($event)"
          title="Deep Search"
        >
          <i class="pi pi-globe" aria-hidden="true"></i>
          <span class="aci-tg-label">Deep Search</span>
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }

    /* Píldora — look original (blanca, redondeada, sombra suave). */
    .aci {
      max-width: 48rem;
      margin: 0 auto;
      background: #fff;
      color: #000;
      border-radius: 32px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      height: 68px;
      overflow: hidden;
      cursor: text;
      transition: height 450ms cubic-bezier(0.34, 1.4, 0.5, 1),
        box-shadow 450ms cubic-bezier(0.34, 1.4, 0.5, 1);
    }
    .aci.expanded { height: 128px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16); }

    .aci-row { display: flex; align-items: center; gap: 8px; padding: 12px; height: 68px; }

    .aci-ic {
      flex-shrink: 0;
      width: 44px; height: 44px;
      display: grid; place-items: center;
      border: none; background: transparent;
      color: #1f2937;
      border-radius: 9999px;
      cursor: pointer;
      transition: background-color 200ms ease;
    }
    .aci-ic:hover { background: #f3f4f6; }
    .aci-ic i { font-size: 1.15rem; }

    .aci-field { position: relative; flex: 1; min-width: 0; }
    .aci-field input {
      width: 100%;
      border: none; outline: none; background: transparent;
      color: #000;
      font-family: var(--font-body);
      font-size: 16px;
      padding: 8px 4px;
    }

    .aci-ph {
      position: absolute; inset: 0;
      display: flex; align-items: center;
      padding: 0 4px;
      pointer-events: none;
      overflow: hidden;
    }
    .aci-ph-line { white-space: nowrap; color: #9ca3af; font-size: 16px; }

    /* Reveal letra-por-letra (entra con blur + stagger; sale en reversa). */
    .aci-ch {
      display: inline-block;
      animation: aciChIn 450ms cubic-bezier(0.23, 1, 0.32, 1) both;
      animation-delay: calc(var(--i, 0) * 25ms);
    }
    .aci-ch.is-out {
      animation: aciChOut 300ms cubic-bezier(0.23, 1, 0.32, 1) both;
      animation-delay: calc(var(--o, 0) * 15ms);
    }
    @keyframes aciChIn {
      from { opacity: 0; filter: blur(12px); transform: translateY(10px); }
      to   { opacity: 1; filter: blur(0);    transform: translateY(0); }
    }
    @keyframes aciChOut {
      from { opacity: 1; filter: blur(0);    transform: translateY(0); }
      to   { opacity: 0; filter: blur(12px); transform: translateY(-10px); }
    }

    .aci-send {
      flex-shrink: 0;
      width: 44px; height: 44px;
      display: grid; place-items: center;
      border: none;
      background: #000; color: #fff;
      border-radius: 9999px;
      cursor: pointer;
      transition: background-color 200ms ease, transform 100ms ease, opacity 150ms ease;
    }
    .aci-send:hover:not(:disabled) { background: #3f3f46; }
    .aci-send:active:not(:disabled) { transform: scale(0.94); }
    .aci-send:disabled { opacity: 0.4; cursor: default; }
    .aci-send i { font-size: 1rem; }

    /* Controles (Think / Deep Search) */
    .aci-ctrls {
      display: flex; gap: 12px; align-items: center;
      padding: 0 16px 12px;
      opacity: 0; transform: translateY(20px); pointer-events: none;
      transition: opacity 250ms ease, transform 350ms ease;
    }
    .aci.expanded .aci-ctrls {
      opacity: 1; transform: translateY(0); pointer-events: auto;
      transition-delay: 80ms;
    }

    .aci-tg {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 8px 16px;
      border: none;
      background: #f3f4f6;
      color: #374151;
      border-radius: 9999px;
      font-family: var(--font-body);
      font-size: 14px; font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 200ms ease, color 200ms ease, outline-color 200ms ease;
    }
    .aci-tg:hover { background: #e5e7eb; }
    .aci-tg.on {
      background: rgba(37, 99, 235, 0.10);
      outline: 1px solid rgba(37, 99, 235, 0.6);
      color: #172554;
    }
    .aci-tg i { font-size: 1.05rem; }
    .aci-tg:hover .pi-bolt { color: #facc15; }

    /* Deep Search: crece al activarse (icono → icono + label). */
    .aci-tg-grow .aci-tg-label {
      max-width: 0; opacity: 0; overflow: hidden;
      transition: max-width 280ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms ease, margin-left 280ms ease;
    }
    .aci-tg-grow.on .aci-tg-label { max-width: 160px; opacity: 1; margin-left: 4px; }

    @media (prefers-reduced-motion: reduce) {
      .aci, .aci-ch, .aci-ch.is-out, .aci-ctrls, .aci-tg, .aci-tg-grow .aci-tg-label, .aci-send {
        transition: none; animation: none;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThotAiInputComponent implements OnInit {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  readonly placeholders = input<string[]>([
    '¿Cuánto vendí los últimos 30 días?',
    'Top 10 productos del mes',
    '¿Qué está en rotura de stock?',
    'Margen por categoría del trimestre',
    'Clientes inactivos hace más de 30 días',
    '¿Qué marca conviene empujar este mes?',
  ]);
  readonly hintBase = input<string>('Pregúntale a Thot sobre tus ventas…');

  readonly ask = output<ThotAsk>();

  value = '';
  readonly active = signal(false);
  readonly think = signal(false);
  readonly deepSearch = signal(false);
  readonly phIndex = signal(0);
  readonly phOut = signal(false);

  readonly letters = computed(() => this.placeholders()[this.phIndex()].split(''));

  @ViewChild('inp') private inp?: ElementRef<HTMLInputElement>;

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.zone.runOutsideAngular(() => {
      const id = setInterval(() => {
        if (this.active() || this.value) return;
        this.zone.run(() => {
          if (reduced) {
            this.phIndex.update((i) => (i + 1) % this.placeholders().length);
            return;
          }
          this.phOut.set(true);
          setTimeout(() => {
            this.phIndex.update((i) => (i + 1) % this.placeholders().length);
            this.phOut.set(false);
          }, 400);
        });
      }, 3000);
      this.destroyRef.onDestroy(() => clearInterval(id));
    });
  }

  activate(): void {
    this.active.set(true);
    queueMicrotask(() => this.inp?.nativeElement?.focus());
  }

  toggleThink(ev: Event): void {
    ev.stopPropagation();
    this.think.update((t) => !t);
  }

  toggleDeep(ev: Event): void {
    ev.stopPropagation();
    this.deepSearch.update((d) => !d);
  }

  submit(): void {
    const text = this.value.trim();
    if (!text) return;
    this.ask.emit({ text, think: this.think(), deepSearch: this.deepSearch() });
    this.value = '';
  }

  @HostListener('document:mousedown', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (this.host.nativeElement.contains(ev.target as Node)) return;
    if (!this.value) this.active.set(false);
  }
}
