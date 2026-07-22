import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  NgZone,
  OnInit,
  ViewChild,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComercialService } from '../comercial.service';

export interface ThotImage {
  name: string;
  mediaType: string;
  /** base64 sin el prefijo data: (lo que espera Anthropic). */
  data: string;
}

export interface ThotAsk {
  text: string;
  think: boolean;
  deepSearch: boolean;
  image?: ThotImage | null;
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
    <div class="aci" [class.expanded]="active() || !!value() || !!attached()" [class.has-attach]="!!attached()" (click)="activate()">
      <!-- Fila de input -->
      <div class="aci-row">
        <button class="aci-ic" type="button" tabindex="-1" aria-label="Adjuntar imagen"
                title="Adjuntar imagen" (click)="pickFile($event)">
          <i class="pi pi-paperclip" aria-hidden="true"></i>
        </button>
        <input #fileInp type="file" accept="image/*" hidden (change)="onFile($event)" />

        <div class="aci-field">
          <input
            #inp
            type="text"
            [ngModel]="value()"
            (ngModelChange)="value.set($event)"
            (focus)="activate()"
            (keydown.enter)="submit()"
            [attr.aria-label]="hintBase()"
            [attr.placeholder]="(recording() || transcribing() || sttError()) ? '' : hintBase()"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
          />
          @if (recording()) {
            <div class="aci-rec" aria-hidden="true">
              <span class="aci-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
              {{ mmss(recSeconds()) }} · Grabando…
            </div>
          } @else if (transcribing()) {
            <div class="aci-rec aci-rec-busy" aria-hidden="true">Transcribiendo…</div>
          } @else if (sttError()) {
            <div class="aci-rec aci-rec-err" role="alert">{{ sttError() }}</div>
          }
        </div>

        @if (micSupported) {
          <button class="aci-ic aci-mic" type="button" tabindex="-1"
                  [class.recording]="recording()"
                  [disabled]="transcribing()"
                  [attr.aria-label]="recording() ? 'Detener y transcribir' : 'Dictar por voz'"
                  [title]="recording() ? 'Detener y transcribir' : (transcribing() ? 'Transcribiendo…' : 'Dictar por voz')"
                  (click)="toggleMic($event)">
            @if (transcribing()) {
              <i class="pi pi-spinner pi-spin" aria-hidden="true"></i>
            } @else if (recording()) {
              <i class="pi pi-stop-circle" aria-hidden="true"></i>
            } @else {
              <i class="pi pi-microphone" aria-hidden="true"></i>
            }
          </button>
        }
        <button
          class="aci-send"
          type="button"
          (click)="submit(); $event.stopPropagation()"
          [disabled]="!value().trim() && !attached()"
          aria-label="Enviar"
          title="Enviar"
        >
          <i class="pi pi-send" aria-hidden="true"></i>
        </button>
      </div>

      <!-- Adjunto (imagen) -->
      @if (attached(); as att) {
        <div class="aci-attach">
          <i class="pi pi-image" aria-hidden="true"></i>
          <span class="aci-attach-name">{{ att.name }}</span>
          <button type="button" class="aci-attach-x" (click)="removeAttached($event)" aria-label="Quitar imagen" title="Quitar">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        </div>
      }

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

    /* Píldora — tokenizada (surface + borde hairline; dark-safe). */
    .aci {
      max-width: 48rem;
      margin: 0 auto;
      background: var(--card-bg);
      color: var(--text-main);
      border: 1px solid var(--border-color);
      border-radius: 32px;
      box-shadow: var(--shadow-light, 0 2px 8px rgba(0, 0, 0, 0.08));
      height: 68px;
      overflow: hidden;
      cursor: text;
      transition: height 350ms cubic-bezier(0.34, 1.4, 0.5, 1),
        box-shadow 350ms cubic-bezier(0.34, 1.4, 0.5, 1);
    }
    .aci:focus-within { outline: 2px solid var(--action); outline-offset: 2px; }
    .aci.expanded { height: 128px; box-shadow: var(--shadow-hover, 0 8px 32px rgba(0, 0, 0, 0.16)); }
    .aci.has-attach.expanded { height: 172px; }

    .aci-row { display: flex; align-items: center; gap: 8px; padding: 12px; height: 68px; }

    .aci-ic {
      flex-shrink: 0;
      width: 44px; height: 44px;
      display: grid; place-items: center;
      border: none; background: transparent;
      color: var(--text-muted);
      border-radius: 9999px;
      cursor: pointer;
      transition: background-color 200ms ease;
    }
    .aci-ic:hover { background: var(--surface-hover-bg); }
    .aci-ic i { font-size: 1.15rem; }
    /* Mic grabando: rojo + pulso. */
    .aci-ic.recording { color: var(--bad-fg); }
    .aci-ic.recording::after {
      content: ''; position: absolute; inset: 0; border-radius: 9999px;
      box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.45);
      animation: aciPulse 1.4s ease-out infinite;
    }
    .aci-ic { position: relative; }
    @keyframes aciPulse {
      0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.45); }
      100% { box-shadow: 0 0 0 12px rgba(220, 38, 38, 0); }
    }

    /* Chip de imagen adjunta. */
    .aci-attach {
      display: inline-flex; align-items: center; gap: 8px;
      margin: 0 14px 8px;
      padding: 6px 8px 6px 10px;
      background: var(--surface-hover-bg); border-radius: 12px;
      font-size: 13px; color: var(--text-muted); max-width: calc(100% - 28px);
    }
    .aci-attach > .pi-image { color: var(--action); }
    .aci-attach-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aci-attach-x {
      flex-shrink: 0; width: 22px; height: 22px; display: grid; place-items: center;
      border: none; background: transparent; color: var(--text-faint); cursor: pointer; border-radius: 9999px;
    }
    .aci-attach-x:hover { background: var(--surface-hover-bg); color: var(--text-main); }

    /* Overlay de grabación / transcripción dentro del campo. */
    .aci-rec {
      position: absolute; inset: 0;
      display: flex; align-items: center; gap: 8px;
      padding: 0 4px;
      font-size: 15px; color: var(--bad-fg); font-weight: 600;
      pointer-events: none;
      font-variant-numeric: tabular-nums;
    }
    .aci-rec-busy { color: var(--text-muted); }
    .aci-rec-err { color: var(--bad-fg); font-weight: 500; }
    .aci-rec-dot {
      width: 9px; height: 9px; border-radius: 9999px; background: var(--bad-fg);
      animation: aciRecBlink 1.1s ease-in-out infinite;
    }
    @keyframes aciRecBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

    /* Onda de voz reactiva (JS escribe scaleY); CSS anima como fallback. */
    .aci-wave { display: inline-flex; align-items: center; gap: 3px; height: 20px; }
    .aci-wave i {
      width: 3px; height: 100%; border-radius: 2px; background: var(--bad-fg);
      transform: scaleY(0.3); transform-origin: center;
      animation: aciWave 0.85s ease-in-out infinite alternate;
    }
    .aci-wave i:nth-child(2) { animation-delay: .12s; }
    .aci-wave i:nth-child(3) { animation-delay: .24s; }
    .aci-wave i:nth-child(4) { animation-delay: .08s; }
    .aci-wave i:nth-child(5) { animation-delay: .30s; }
    .aci-wave i:nth-child(6) { animation-delay: .16s; }
    .aci-wave i:nth-child(7) { animation-delay: .04s; }
    @keyframes aciWave { from { transform: scaleY(0.25); } to { transform: scaleY(1); } }

    @media (prefers-reduced-motion: reduce) {
      .aci-rec-dot, .aci-wave i { animation: none; }
    }

    .aci-field { position: relative; flex: 1; min-width: 0; }
    .aci-field input {
      width: 100%;
      border: none !important; outline: none !important; box-shadow: none !important;
      background: transparent;
      color: var(--text-main);
      font-family: var(--font-body);
      font-size: 16px;
      padding: 8px 4px;
    }
    .aci-field input::placeholder { color: var(--text-faint); }

    .aci-send {
      flex-shrink: 0;
      width: 44px; height: 44px;
      display: grid; place-items: center;
      border: none;
      background: var(--action); color: var(--action-ink);
      border-radius: 9999px;
      cursor: pointer;
      transition: background-color 200ms ease, transform 100ms ease, opacity 150ms ease;
    }
    .aci-send:hover:not(:disabled) { background: var(--action-hover); }
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
      background: color-mix(in srgb, var(--text-main) 6%, transparent);
      color: var(--text-muted);
      border-radius: 9999px;
      font-family: var(--font-body);
      font-size: 14px; font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 200ms ease, color 200ms ease, outline-color 200ms ease;
    }
    .aci-tg:hover { background: color-mix(in srgb, var(--text-main) 10%, transparent); }
    .aci-tg:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    /* Activo = IA ember (nunca azul/morado). */
    .aci-tg.on {
      background: var(--ember-soft);
      outline: 1px solid var(--ember-border);
      color: var(--action);
    }
    .aci-tg i { font-size: 1.05rem; }
    .aci-tg:hover .pi-bolt { color: var(--action); }

    /* Deep Search: crece al activarse (icono → icono + label). */
    .aci-tg-grow .aci-tg-label {
      max-width: 0; opacity: 0; overflow: hidden;
      transition: max-width 280ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms ease, margin-left 280ms ease;
    }
    .aci-tg-grow.on .aci-tg-label { max-width: 160px; opacity: 1; margin-left: 4px; }

    @media (prefers-reduced-motion: reduce) {
      .aci, .aci-ctrls, .aci-tg, .aci-tg-grow .aci-tg-label, .aci-send {
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
  private readonly api = inject(ComercialService);

  readonly hintBase = input<string>('Pregúntale a Thot sobre tus ventas…');

  readonly ask = output<ThotAsk>();

  readonly value = signal('');
  readonly active = signal(false);
  readonly think = signal(false);
  readonly deepSearch = signal(false);
  readonly attached = signal<ThotImage | null>(null);
  readonly recording = signal(false);
  readonly transcribing = signal(false);
  readonly recSeconds = signal(0);
  readonly sttError = signal<string | null>(null);
  readonly micSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof (window as any).MediaRecorder !== 'undefined';

  @ViewChild('inp') private inp?: ElementRef<HTMLInputElement>;
  @ViewChild('fileInp') private fileInp?: ElementRef<HTMLInputElement>;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private recTimer: any = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => {
      this.stopTimer();
      this.releaseStream();
    });
  }

  /** Segundos → m:ss para el timer de grabación. */
  mmss(s: number): string {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
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
    const text = this.value().trim();
    const img = this.attached();
    if (!text && !img) return;
    if (this.recording()) this.cancelRec();
    this.ask.emit({ text, think: this.think(), deepSearch: this.deepSearch(), image: img });
    this.value.set('');
    this.attached.set(null);
  }

  // ── Adjuntar imagen (Claude vision) ───────────────────────────────
  pickFile(ev: Event): void {
    ev.stopPropagation();
    this.fileInp?.nativeElement?.click();
  }

  onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // permite re-elegir el mismo archivo
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) return; // tope 5MB
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const data = dataUrl.split(',')[1] || '';
      this.zone.run(() => {
        this.attached.set({ name: file.name, mediaType: file.type, data });
        this.active.set(true);
      });
    };
    reader.readAsDataURL(file);
  }

  removeAttached(ev: Event): void {
    ev.stopPropagation();
    this.attached.set(null);
  }

  // ── Dictado por voz (MediaRecorder → Groq Whisper, calidad ChatGPT) ──
  toggleMic(ev: Event): void {
    ev.stopPropagation();
    if (this.transcribing()) return;
    if (this.recording()) { this.finishRec(); return; }
    void this.startRec();
  }

  private async startRec(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,   // sube voces bajas → mejor transcripción
          channelCount: 1,
        },
      });
    } catch {
      this.flashSttError('No pude acceder al micrófono (revisá permisos).');
      return;
    }
    const mime = this.pickMime();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.onstop = () => this.onRecStop();
    this.recorder.start();
    this.active.set(true);
    this.recording.set(true);
    this.recSeconds.set(0);
    this.zone.runOutsideAngular(() => {
      this.recTimer = setInterval(() => this.zone.run(() => this.recSeconds.update((s) => s + 1)), 1000);
    });
    this.startMeter();
  }

  /** Analyser de Web Audio → barras de onda reactivas al volumen (escritas
   *  directo al DOM, fuera de Angular, para no disparar change-detection). */
  private startMeter(): void {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC || !this.stream) return;
      this.audioCtx = new AC();
      if (this.audioCtx!.state === 'suspended') this.audioCtx!.resume().catch(() => {});
      const src = this.audioCtx!.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx!.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;
      src.connect(this.analyser);
      // Dominio temporal → volumen RMS real: toda la onda reacciona a la voz
      // (con freq bins la energía caía solo en las primeras barras).
      const time = new Uint8Array(this.analyser.fftSize);
      let tick = 0;
      this.zone.runOutsideAngular(() => {
        const loop = () => {
          if (!this.analyser) return;
          const bars = this.host.nativeElement.querySelectorAll('.aci-wave i') as NodeListOf<HTMLElement>;
          if (bars.length) {
            this.analyser.getByteTimeDomainData(time);
            let sum = 0;
            for (let i = 0; i < time.length; i++) { const x = (time[i] - 128) / 128; sum += x * x; }
            const rms = Math.sqrt(sum / time.length);
            const level = Math.min(1, rms * 3.4);   // ganancia
            tick++;
            for (let i = 0; i < bars.length; i++) {
              // base mínima + volumen modulado por barra (efecto "baile")
              const wobble = 0.6 + 0.4 * Math.abs(Math.sin(tick * 0.18 + i * 0.9));
              const h = 0.16 + level * wobble * 0.84;
              bars[i].style.transform = `scaleY(${Math.min(1, h).toFixed(3)})`;
            }
          }
          this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
      });
    } catch {
      /* sin Web Audio: las barras animan por CSS (fallback) */
    }
  }

  private stopMeter(): void {
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.analyser = null;
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
  }

  /** Detener y transcribir. */
  private finishRec(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stopTimer();
    this.recording.set(false);
  }

  /** Cancelar sin transcribir (ej. al enviar manualmente). */
  private cancelRec(): void {
    this.chunks = [];
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null as any;
      this.recorder.stop();
    }
    this.releaseStream();
    this.stopTimer();
    this.recording.set(false);
  }

  private onRecStop(): void {
    this.releaseStream();
    const type = this.recorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.recorder = null;
    if (!blob.size) { this.flashSttError('No grabé audio. Probá de nuevo.'); return; }
    this.zone.run(() => this.transcribing.set(true));
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '').split(',')[1] || '';
      this.api.transcribe(data, type)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => {
            this.transcribing.set(false);
            if (r?.error) {
              this.flashSttError(r.error === 'no_key' ? 'Dictado no configurado (falta GROQ_API_KEY).' : 'No se pudo transcribir.');
              return;
            }
            const t = (r?.text || '').trim();
            if (t) {
              const base = this.value();
              this.value.set(base ? `${base} ${t}` : t);
              // Dictado → auto-enviar (estilo modo voz de ChatGPT).
              this.submit();
            } else {
              this.flashSttError('No te entendí, probá de nuevo.');
            }
          },
          error: () => { this.transcribing.set(false); this.flashSttError('No se pudo transcribir.'); },
        });
    };
    reader.readAsDataURL(blob);
  }

  /** Muestra un aviso efímero de error del dictado (3s). */
  private flashSttError(msg: string): void {
    this.sttError.set(msg);
    setTimeout(() => { if (this.sttError() === msg) this.sttError.set(null); }, 3000);
  }

  private pickMime(): string {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const MR: any = (window as any).MediaRecorder;
    return cands.find((c) => MR?.isTypeSupported?.(c)) || '';
  }

  private releaseStream(): void {
    this.stopMeter();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private stopTimer(): void {
    if (this.recTimer) { clearInterval(this.recTimer); this.recTimer = null; }
  }

  @HostListener('document:mousedown', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (this.host.nativeElement.contains(ev.target as Node)) return;
    if (!this.value() && !this.attached()) this.active.set(false);
  }
}
