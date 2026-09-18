import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';

/**
 * GX.9 — tomar UNA foto con la cámara del dispositivo, sin pasar por el selector de archivos.
 *
 * Por qué no un input con capture: el atributo `capture` de un <input type="file"> es una
 * SUGERENCIA. iOS y Chrome-Android suelen abrir la cámara, pero varios navegadores y
 * launchers de Android igual ofrecen el carrete. Si la galería no debe ser una opción, la
 * cámara tiene que vivir dentro de la página: acá no hay selector que abrir.
 *
 * Y la parte honesta: esto es FRICCIÓN, no prueba. Nadie puede impedir que le tomen foto a
 * una pantalla. Lo que sí deja rastro es el sello de tiempo del servidor, el cuadre por
 * visión y el hash de la imagen — eso vive en el backend, no acá.
 *
 * Fallback deliberado: si `getUserMedia` no está o el permiso se niega, se cae al input con
 * `capture`. Un trabajador que no puede entregar su ticket es peor que una foto de galería.
 *
 * Suelta el stream en CADA salida (cerrar, tomar la foto, destruir el componente). Sin eso
 * la cámara del celular se queda prendida — con el LED encendido — hasta recargar la página.
 */
@Component({
  selector: 'app-camera-shot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (abierto()) {
      <div class="cs-overlay" role="dialog" aria-modal="true" [attr.aria-label]="'Tomar foto: ' + etiqueta()">
        <div class="cs-head">
          <span class="cs-title">{{ etiqueta() }}</span>
          <button type="button" class="cs-x" (click)="cerrar()" aria-label="Cancelar la foto">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        </div>

        <div class="cs-stage">
          <video #video class="cs-video" playsinline muted autoplay></video>
          @if (arrancando()) {
            <div class="cs-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Encendiendo la cámara…</div>
          }
        </div>

        <div class="cs-foot">
          <button type="button" class="cs-shoot" (click)="disparar()" [disabled]="arrancando()"
                  aria-label="Tomar la foto">
            <span class="cs-shoot-in"></span>
          </button>
          <p class="cs-hint">Encuadra el papel completo y que se alcance a leer el total.</p>
        </div>
      </div>
    }

    @if (error()) {
      <div class="cs-fallback">
        <p class="cs-fb-msg"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}</p>
        <label class="cs-fb-btn">
          <i class="pi pi-camera" aria-hidden="true"></i> Tomar foto
          <input type="file" accept="image/*" capture="environment" (change)="desdeInput($event)" />
        </label>
      </div>
    }

    <canvas #lienzo class="cs-canvas"></canvas>
  `,
  styles: [`
    :host { display: contents; }

    /* Pantalla completa: en un celular, encuadrar un ticket en una ventanita no se puede. */
    .cs-overlay { position: fixed; inset: 0; z-index: 2000; display: flex; flex-direction: column;
      background: #000; padding-bottom: env(safe-area-inset-bottom, 0); }
    .cs-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
      padding: calc(env(safe-area-inset-top, 0) + var(--sp-3)) var(--sp-3) var(--sp-3);
      color: #fff; }
    .cs-title { font-size: var(--fs-body); font-weight: var(--fw-medium); }
    .cs-x { display: inline-flex; align-items: center; justify-content: center;
      width: var(--tap-min); height: var(--tap-min); border: 0; border-radius: 50%;
      background: rgba(255,255,255,.14); color: #fff; cursor: pointer; }
    .cs-x:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

    .cs-stage { position: relative; flex: 1; min-height: 0; display: flex; }
    .cs-video { width: 100%; height: 100%; object-fit: contain; background: #000; }
    .cs-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      gap: var(--sp-2); color: #fff; font-size: var(--fs-sm); }

    .cs-foot { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      padding: var(--sp-4) var(--sp-3) var(--sp-5); }
    /* Obturador grande y centrado: es el único objetivo de la pantalla (Fitts en touch). */
    .cs-shoot { width: 72px; height: 72px; border-radius: 50%; border: 3px solid rgba(255,255,255,.9);
      background: transparent; padding: 5px; cursor: pointer; }
    .cs-shoot:disabled { opacity: .4; cursor: default; }
    .cs-shoot-in { display: block; width: 100%; height: 100%; border-radius: 50%; background: #fff;
      transition: transform var(--dur-short) var(--ease-standard); }
    .cs-shoot:active:not(:disabled) .cs-shoot-in { transform: scale(.88); }
    .cs-shoot:focus-visible { outline: 3px solid #fff; outline-offset: 4px; }
    .cs-hint { margin: 0; color: rgba(255,255,255,.72); font-size: var(--fs-xs); text-align: center; }
    @media (prefers-reduced-motion: reduce) { .cs-shoot-in { transition: none; } }

    /* Fallback: se ve como lo que es, un camino alterno, no un error fatal. */
    .cs-fallback { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cs-fb-msg { margin: 0; display: flex; align-items: flex-start; gap: var(--sp-1);
      font-size: var(--fs-xs); color: var(--warn-fg); line-height: 1.4; }
    .cs-fb-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
      min-height: var(--tap-min); padding: 0 var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); color: var(--fg-1);
      font-size: var(--fs-sm); font-weight: var(--fw-medium); cursor: pointer; }
    .cs-fb-btn input { display: none; }
    .cs-fb-btn:focus-within { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    .cs-canvas { display: none; }
  `],
})
export class CameraShotComponent {
  private readonly destroyRef = inject(DestroyRef);

  /** Qué se está fotografiando, para el encabezado y el aria-label. */
  readonly etiqueta = input<string>('Foto');
  /** Lado más largo de la imagen resultante. 1600 alcanza para que Vision lea un ticket
   *  y evita subir 8 MB desde datos móviles. */
  readonly maxLado = input<number>(1600);

  /** data URI de la foto + si salió de la cámara en vivo o del selector. */
  readonly tomada = output<{ dataUri: string; camera: 'live' | 'file' }>();

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly lienzo = viewChild<ElementRef<HTMLCanvasElement>>('lienzo');

  readonly abierto = signal(false);
  readonly arrancando = signal(false);
  readonly error = signal<string | null>(null);
  private stream: MediaStream | null = null;

  constructor() {
    // La cámara no se apaga sola si el usuario navega: hay que soltarla a mano.
    this.destroyRef.onDestroy(() => this.soltar());
  }

  /** Abre la cámara. Si no se puede, muestra el camino alterno en vez de dejarlo varado. */
  async abrir(): Promise<void> {
    this.error.set(null);
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      this.error.set('Este navegador no deja usar la cámara desde la página. Usá el botón de abajo.');
      return;
    }
    this.abierto.set(true);
    this.arrancando.set(true);
    try {
      this.stream = await md.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      const v = this.video()?.nativeElement;
      if (v) { v.srcObject = this.stream; await v.play().catch(() => undefined); }
      this.arrancando.set(false);
    } catch (e: any) {
      this.soltar();
      this.abierto.set(false);
      this.arrancando.set(false);
      const negado = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      this.error.set(negado
        ? 'No nos diste permiso de usar la cámara. Podés darlo en los ajustes del navegador, o usar el botón de abajo.'
        : 'No se pudo abrir la cámara. Usá el botón de abajo.');
    }
  }

  cerrar(): void { this.soltar(); this.abierto.set(false); }

  /** Congela el cuadro actual, lo escala y lo emite como JPEG. */
  disparar(): void {
    const v = this.video()?.nativeElement;
    const c = this.lienzo()?.nativeElement;
    if (!v || !c || !v.videoWidth) return;

    const max = this.maxLado();
    const escala = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * escala);
    c.height = Math.round(v.videoHeight * escala);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);

    // 0.82 es el punto donde un ticket sigue siendo legible para Vision sin pesar de más.
    const dataUri = c.toDataURL('image/jpeg', 0.82);
    this.cerrar();
    this.tomada.emit({ dataUri, camera: 'live' });
  }

  /** Camino alterno: el selector del sistema. Se re-comprime igual, viene de donde venga. */
  desdeInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.recomprimir(String(reader.result || '')).then((dataUri) => {
        this.tomada.emit({ dataUri, camera: 'file' });
        input.value = ''; // permite volver a elegir el MISMO archivo
      });
    };
    reader.readAsDataURL(file);
  }

  /** Reduce una imagen ya cargada al mismo tope que la cámara. */
  private recomprimir(dataUri: string): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = this.lienzo()?.nativeElement;
        const max = this.maxLado();
        if (!c || Math.max(img.width, img.height) <= max) { resolve(dataUri); return; }
        const escala = max / Math.max(img.width, img.height);
        c.width = Math.round(img.width * escala);
        c.height = Math.round(img.height * escala);
        const ctx = c.getContext('2d');
        if (!ctx) { resolve(dataUri); return; }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      // Si no se puede leer como imagen (p. ej. un PDF), va tal cual: el backend lo acepta.
      img.onerror = () => resolve(dataUri);
      img.src = dataUri;
    });
  }

  /** Apaga la cámara de verdad. Sin esto el LED del celular se queda prendido. */
  private soltar(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const v = this.video()?.nativeElement;
    if (v) v.srcObject = null;
  }
}
