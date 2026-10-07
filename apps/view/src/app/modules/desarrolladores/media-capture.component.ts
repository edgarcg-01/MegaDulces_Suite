import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, output, signal, viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';

export type CaptureMode = 'foto' | 'video';

export interface CapturedMedia {
  blob: Blob;
  fileName: string;
  source: 'camara' | 'grabacion';
}

/** El primer formato de video que el navegador sepa grabar. Chrome/Edge: webm; Safari: mp4. */
export function pickRecorderMime(isSupported: (t: string) => boolean): string {
  const opciones = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return opciones.find((t) => isSupported(t)) ?? '';
}

/** `foto-2026-10-01-1015.jpg` — un nombre que dice qué es y cuándo, para que la lista se lea. */
export function captureFileName(kind: CaptureMode, mime: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ext = kind === 'foto' ? 'jpg' : mime.includes('mp4') ? 'mp4' : 'webm';
  return `${kind}-${stamp}.${ext}`;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * `[DEV.7]` Tomar una foto o grabar un video con la cámara del equipo, sin salir de la pantalla.
 *
 * Se monta sólo mientras el diálogo está abierto (el padre lo pone dentro de un `@if`), así que
 * `ngOnDestroy` siempre apaga la cámara: dejarla encendida es la luz del equipo prendida sin que
 * nadie sepa por qué.
 */
@Component({
  selector: 'app-media-capture',
  standalone: true,
  imports: [ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mc">
      @if (error(); as e) {
        <p class="mc-error" role="alert">{{ e }}</p>
      }

      <div class="mc-stage">
        @if (!preview()) {
          <video #live class="mc-video" autoplay playsinline [muted]="true"></video>
          @if (recording()) {
            <span class="mc-rec" aria-live="polite"><span class="mc-dot"></span>REC {{ clock() }}</span>
          }
        } @else {
          @if (mode() === 'foto') {
            <img class="mc-video" [src]="preview()" alt="Foto tomada" />
          } @else {
            <video class="mc-video" [src]="preview()" controls playsinline></video>
          }
        }
      </div>

      <div class="mc-actions">
        @if (!preview()) {
          @if (mode() === 'foto') {
            <p-button icon="pi pi-camera" label="Tomar foto" (onClick)="snap()" [disabled]="!ready()" />
          } @else if (!recording()) {
            <p-button icon="pi pi-circle-fill" label="Grabar" severity="danger" (onClick)="startRec()" [disabled]="!ready()" />
          } @else {
            <p-button icon="pi pi-stop" label="Detener" severity="danger" (onClick)="stopRec()" />
          }
          @if (cameras().length > 1 && !recording()) {
            <p-button icon="pi pi-sync" label="Cambiar cámara" severity="secondary" [outlined]="true" (onClick)="switchCamera()" />
          }
        } @else {
          <p-button icon="pi pi-check" label="Usar" (onClick)="accept()" />
          <p-button icon="pi pi-replay" label="Repetir" severity="secondary" [outlined]="true" (onClick)="retake()" />
        }
        <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="cancel.emit()" />
      </div>
    </div>
  `,
  styles: [`
    .mc { display: flex; flex-direction: column; gap: var(--sp-3); }
    .mc-stage { position: relative; background: #111111; border-radius: var(--r-md); overflow: hidden;
      aspect-ratio: 4 / 3; display: grid; place-items: center; }
    .mc-video { width: 100%; height: 100%; object-fit: contain; }
    .mc-rec { position: absolute; top: var(--sp-2); left: var(--sp-2); display: inline-flex; align-items: center;
      gap: var(--sp-1); padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--bad-soft-bg);
      color: var(--bad-fg); font: 600 var(--fs-xs)/1.4 var(--font-mono); }
    .mc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
    @media (prefers-reduced-motion: no-preference) { .mc-dot { animation: mc-blink 1s steps(2) infinite; } }
    @keyframes mc-blink { 50% { opacity: 0; } }
    .mc-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .mc-error { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
      background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
  `],
})
export class MediaCaptureComponent implements OnDestroy {
  readonly mode = input<CaptureMode>('foto');
  readonly captured = output<CapturedMedia>();
  readonly cancel = output<void>();

  private readonly live = viewChild<ElementRef<HTMLVideoElement>>('live');

  readonly error = signal<string | null>(null);
  readonly ready = signal(false);
  readonly recording = signal(false);
  readonly elapsed = signal(0);
  readonly preview = signal<string | null>(null);
  readonly cameras = signal<MediaDeviceInfo[]>([]);
  readonly clock = computed(() => formatClock(this.elapsed()));

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private result: Blob | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cameraIndex = 0;
  private mime = '';

  constructor() {
    // Arranca en el siguiente tick: el <video #live> tiene que existir antes de colgarle el stream.
    queueMicrotask(() => void this.open());
  }

  async open(): Promise<void> {
    this.error.set(null);
    this.ready.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set('Este navegador no deja usar la cámara desde la página (requiere HTTPS o localhost). Usa «Adjuntar archivos».');
      return;
    }
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? [];
      this.cameras.set(devices.filter((d) => d.kind === 'videoinput'));
      const cam = this.cameras()[this.cameraIndex];
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: cam?.deviceId ? { deviceId: { exact: cam.deviceId } } : { facingMode: 'environment' },
        audio: this.mode() === 'video',
      });
      const v = this.live()?.nativeElement;
      if (v) {
        v.srcObject = this.stream;
        await v.play().catch(() => undefined);
      }
      this.ready.set(true);
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name ?? '';
      this.error.set(
        name === 'NotAllowedError'
          ? 'No se dio permiso a la cámara. Actívalo en el candado de la barra de direcciones.'
          : name === 'NotFoundError'
            ? 'No se encontró una cámara en este equipo.'
            : 'No se pudo abrir la cámara.',
      );
    }
  }

  snap(): void {
    const v = this.live()?.nativeElement;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    c.toBlob((b) => {
      if (!b) return;
      this.result = b;
      this.preview.set(URL.createObjectURL(b));
      this.stopStream();
    }, 'image/jpeg', 0.9);
  }

  startRec(): void {
    if (!this.stream || typeof MediaRecorder === 'undefined') {
      this.error.set('Este navegador no puede grabar video desde la página.');
      return;
    }
    this.mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    this.chunks = [];
    this.recorder = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (ev) => { if (ev.data.size) this.chunks.push(ev.data); };
    this.recorder.onstop = () => {
      const type = this.mime.split(';')[0] || this.recorder?.mimeType || 'video/webm';
      this.result = new Blob(this.chunks, { type });
      this.preview.set(URL.createObjectURL(this.result));
      this.stopStream();
    };
    this.recorder.start(1000);
    this.recording.set(true);
    this.elapsed.set(0);
    this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
  }

  stopRec(): void {
    this.clearTimer();
    this.recording.set(false);
    if (this.recorder?.state !== 'inactive') this.recorder?.stop();
  }

  accept(): void {
    if (!this.result) return;
    const mode = this.mode();
    this.captured.emit({
      blob: this.result,
      fileName: captureFileName(mode, this.result.type),
      source: mode === 'foto' ? 'camara' : 'grabacion',
    });
  }

  retake(): void {
    this.revokePreview();
    this.result = null;
    void this.open();
  }

  switchCamera(): void {
    const n = this.cameras().length;
    if (n < 2) return;
    this.cameraIndex = (this.cameraIndex + 1) % n;
    this.stopStream();
    void this.open();
  }

  ngOnDestroy(): void {
    this.clearTimer();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.stopStream();
    this.revokePreview();
  }

  private stopStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ready.set(false);
  }

  private revokePreview(): void {
    const p = this.preview();
    if (p) URL.revokeObjectURL(p);
    this.preview.set(null);
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
