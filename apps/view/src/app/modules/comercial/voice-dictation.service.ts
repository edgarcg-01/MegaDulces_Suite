import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ComercialService } from './comercial.service';

/**
 * **Dictado por voz reutilizable**: micrófono → texto.
 *
 * Graba con `MediaRecorder` y manda el audio a
 * `POST /commercial/expiry-reviews/voice/transcribe` (Groq Whisper
 * large-v3-turbo en español). La API key vive solo en el server; acá nunca.
 *
 * **Por qué no el endpoint de dictado de Thot:** ése exige
 * `COMMERCIAL_ORDERS_VER` y quien captura caducidades no lo tiene — daba 403 al
 * primer intento de hablar. El proveedor es el mismo (`SpeechToTextService`),
 * el gate es el del dominio que lo usa.
 *
 * Extraído del patrón que ya usaba `thot-ai-input.component.ts` (que lo tiene
 * embebido): cuando esa entrada se toque, conviene que consuma este servicio en
 * vez de mantener la segunda copia.
 *
 * Se provee **a nivel de componente** (no root): así cada pantalla tiene su
 * grabación aislada y al destruirse suelta el micrófono.
 */
@Injectable()
export class VoiceDictationService {
  private readonly api = inject(ComercialService);
  private readonly zone = inject(NgZone);

  /** Grabando ahora. */
  readonly recording = signal(false);
  /** Audio enviado, esperando la transcripción. */
  readonly transcribing = signal(false);
  /** Último error, en texto ya mostrable. */
  readonly error = signal<string | null>(null);
  /** Segundos grabados (para el indicador). */
  readonly seconds = signal(0);

  /** Texto transcrito. Se emite una vez por grabación. */
  readonly transcript$ = new Subject<string>();

  /** `MediaRecorder` no existe en todos los navegadores/webviews. */
  readonly supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof (window as any).MediaRecorder !== 'undefined';

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer: any = null;

  /** Un solo gesto: toca para hablar, toca para enviar. */
  toggle(): void {
    if (this.transcribing()) return;
    if (this.recording()) { this.stop(); return; }
    void this.start();
  }

  async start(): Promise<void> {
    if (!this.supported) {
      // Fuera de contexto seguro `getUserMedia` no existe: hay que decir el
      // motivo real (pasa en http de LAN), no dejar el botón mudo.
      this.flash('Este equipo no da acceso al micrófono (requiere HTTPS).');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true, // sube voces bajas → mejor transcripción
          channelCount: 1,
        },
      });
    } catch {
      this.flash('No pude acceder al micrófono (revisá permisos).');
      return;
    }
    const mime = this.pickMime();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.onstop = () => this.onStop();
    this.recorder.start();
    this.error.set(null);
    this.recording.set(true);
    this.seconds.set(0);
    // El contador corre fuera de Angular: un tick por segundo no tiene por qué
    // disparar change-detection de toda la pantalla.
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => this.zone.run(() => this.seconds.update((s) => s + 1)), 1000);
    });
  }

  /** Detiene y transcribe. */
  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.clearTimer();
    this.recording.set(false);
  }

  /** Corta sin transcribir (al cerrar el panel). */
  cancel(): void {
    this.chunks = [];
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null as any;
      this.recorder.stop();
    }
    this.release();
    this.clearTimer();
    this.recording.set(false);
    this.transcribing.set(false);
  }

  private onStop(): void {
    this.release();
    const type = this.recorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.recorder = null;
    if (!blob.size) { this.flash('No grabé audio. Probá de nuevo.'); return; }
    this.zone.run(() => this.transcribing.set(true));
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '').split(',')[1] || '';
      this.api.transcribeExpiry(data, type).subscribe({
        next: (r) => {
          this.transcribing.set(false);
          if (r?.error) {
            this.flash(r.error === 'no_key'
              ? 'El dictado no está configurado en el servidor (falta GROQ_API_KEY).'
              : 'No se pudo transcribir.');
            return;
          }
          const t = (r?.text || '').trim();
          if (t) this.transcript$.next(t);
          else this.flash('No te entendí, probá de nuevo.');
        },
        error: () => { this.transcribing.set(false); this.flash('No se pudo transcribir.'); },
      });
    };
    reader.readAsDataURL(blob);
  }

  private pickMime(): string {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const MR: any = (window as any).MediaRecorder;
    return cands.find((c) => MR?.isTypeSupported?.(c)) || '';
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private clearTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private flash(msg: string): void {
    this.transcribing.set(false);
    this.error.set(msg);
    setTimeout(() => { if (this.error() === msg) this.error.set(null); }, 4000);
  }
}
