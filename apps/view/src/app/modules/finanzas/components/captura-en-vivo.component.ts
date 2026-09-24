import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';

/**
 * `[GX.14]` — **La foto del comprobante se toma en el momento, o no se toma.**
 *
 * Reemplaza al `<input type="file" capture="environment">` que había antes. Ese atributo
 * es una *sugerencia*: en escritorio abre el explorador de archivos y en móvil la mayoría
 * de los navegadores igual ofrecen la galería. O sea: no imponía nada.
 *
 * Acá el único camino es `getUserMedia` → `<video>` → `<canvas>` → JPEG. No hay input de
 * archivo, ni arrastrar y soltar, ni PDF. Lo que sale lleva el sello `live` y la hora.
 *
 * ## ⚠️ Lo que este componente NO logra
 * El sello `live` lo pone el cliente. Alguien con las herramientas del navegador puede
 * falsificarlo. Esto **no es una prueba criptográfica de que la foto es de hoy**: es que
 * la interfaz no ofrece otro camino y que el archivo llega diciendo de dónde salió.
 * El límite está escrito, no escondido — ver `aporte-solicitante.contract.ts`.
 *
 * ## ⚠️ Y lo que puede impedir usarlo
 * `getUserMedia` exige **contexto seguro** (HTTPS o `localhost`) y permiso de la persona.
 * Si el navegador lo niega, este componente **no cae a subir archivo**: eso anularía la
 * regla entera. Muestra el motivo y sugiere el celular. Es una decisión, no un olvido.
 */
@Component({
  selector: 'md-captura-en-vivo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (estado() === 'idle') {
      <button type="button" class="cv-abrir" (click)="abrir()">
        <i class="pi pi-camera" aria-hidden="true"></i> {{ etiqueta() }}
      </button>
      <p class="cv-nota">
        <i class="pi pi-lock" aria-hidden="true"></i>
        Se toma en el momento. No se puede subir un archivo guardado ni un PDF.
      </p>
    }

    @if (estado() === 'pidiendo') {
      <div class="cv-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Pidiendo permiso a la cámara…</div>
    }

    @if (estado() === 'viva') {
      <div class="cv-visor">
        <video #video class="cv-video" playsinline muted autoplay aria-label="Lo que ve la cámara"></video>
        <span class="cv-live"><span class="cv-punto"></span> EN VIVO</span>
        <span class="cv-guia" aria-hidden="true"></span>
      </div>
      <p class="cv-tip">Que se vean el total y la fecha del comprobante.</p>
      <div class="cv-barra">
        <button type="button" class="cv-cancel" (click)="cerrar()">Cancelar</button>
        <button type="button" class="cv-disparar" (click)="disparar()" aria-label="Capturar la evidencia"></button>
        <span class="cv-hueco"></span>
      </div>
    }

    @if (estado() === 'error') {
      <div class="cv-error" role="alert">
        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
        <div>
          <strong>{{ error() }}</strong>
          <div class="cv-error-sub">
            El comprobante sólo se acepta tomado en el momento, así que no hay opción de subir
            un archivo. Si esta computadora no tiene cámara, hacelo desde el celular.
          </div>
        </div>
      </div>
      <button type="button" class="cv-reintentar" (click)="abrir()">Reintentar</button>
    }

    <canvas #lienzo hidden></canvas>
  `,
  styles: [`
    :host { display: block; }

    .cv-abrir {
      width: 100%; height: 40px; display: flex; align-items: center; justify-content: center; gap: 7px;
      border: 1px solid var(--action); background: var(--action); color: var(--action-ink);
      border-radius: var(--radius-sm); font: inherit; font-size: var(--fs-body); font-weight: 600; cursor: pointer;
    }
    .cv-abrir:hover { background: var(--action-hover); border-color: var(--action-hover); }
    .cv-abrir:focus-visible, .cv-cancel:focus-visible, .cv-disparar:focus-visible, .cv-reintentar:focus-visible {
      outline: 2px solid var(--action); outline-offset: 2px;
    }

    .cv-nota {
      display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0;
      font-size: var(--fs-xs); line-height: 1.45; color: var(--c-text-2);
    }
    .cv-nota .pi { margin-top: 2px; }

    .cv-msg { padding: 14px; font-size: var(--fs-sm); color: var(--c-text-2); text-align: center; }

    .cv-visor {
      position: relative; border-radius: var(--radius-md); overflow: hidden;
      background: var(--neutral-900); aspect-ratio: 3 / 4; max-height: 320px; margin-inline: auto;
    }
    .cv-video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cv-live {
      position: absolute; left: 10px; top: 10px; display: flex; align-items: center; gap: 5px;
      background: var(--bad-fg); color: #FFF; border-radius: var(--radius-sm);
      padding: 2px 8px; font-size: var(--fs-nano); font-weight: 700; letter-spacing: .05em;
    }
    .cv-punto { width: 6px; height: 6px; border-radius: 50%; background: #FFF; }
    .cv-guia {
      position: absolute; inset: 12% 14%; border: 2px solid var(--action-ring); border-radius: var(--radius-sm);
    }

    .cv-tip { margin: 8px 0 0; font-size: var(--fs-xs); color: var(--c-text-3); text-align: center; }

    .cv-barra { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
    .cv-cancel, .cv-hueco { width: 88px; }
    .cv-cancel {
      height: 36px; border: 1px solid var(--c-divider); background: var(--c-surface-1);
      color: var(--c-text-2); border-radius: var(--radius-sm); font: inherit; font-size: var(--fs-sm); cursor: pointer;
    }
    .cv-disparar {
      width: 56px; height: 56px; border-radius: 50%; border: 3px solid var(--c-divider);
      background: var(--c-text-1); cursor: pointer; flex-shrink: 0;
    }
    .cv-disparar:hover { background: var(--action); border-color: var(--action-ring); }

    .cv-error {
      display: flex; gap: 9px; align-items: flex-start; padding: 12px;
      border: 1px solid var(--bad-border); background: var(--bad-bg, transparent); color: var(--bad-fg);
      border-radius: var(--radius-md); font-size: var(--fs-sm);
    }
    .cv-error-sub { margin-top: 4px; font-size: var(--fs-xs); line-height: 1.45; color: var(--c-text-2); }
    .cv-reintentar {
      width: 100%; height: 36px; margin-top: 8px; border: 1px solid var(--c-divider);
      background: var(--c-surface-1); color: var(--c-text-1); border-radius: var(--radius-sm);
      font: inherit; font-size: var(--fs-sm); font-weight: 500; cursor: pointer;
    }

    @media (prefers-reduced-motion: reduce) { .cv-punto { animation: none; } }
  `],
})
export class CapturaEnVivoComponent {
  private readonly destroyRef = inject(DestroyRef);

  /** Texto del botón que abre la cámara. */
  readonly etiqueta = input('Capturar evidencia');

  /** La foto tomada: data URI JPEG + el momento exacto en que se disparó. */
  readonly capturada = output<{ dataUrl: string; capturedAt: string }>();

  readonly estado = signal<'idle' | 'pidiendo' | 'viva' | 'error'>('idle');
  readonly error = signal('');

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly lienzo = viewChild<ElementRef<HTMLCanvasElement>>('lienzo');
  private stream: MediaStream | null = null;

  constructor() {
    // Soltar la cámara al destruir la pantalla. Sin esto el indicador del sistema queda
    // encendido y en algunos equipos la cámara no la puede tomar otra app.
    this.destroyRef.onDestroy(() => this.soltar());
  }

  async abrir(): Promise<void> {
    this.estado.set('pidiendo');
    this.error.set('');
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      // Pasa de verdad: por HTTP sin `localhost` el navegador ni expone la API.
      this.fallar('Este navegador no da acceso a la cámara (hace falta una conexión segura).');
      return;
    }
    try {
      // `environment` = la cámara trasera del celular, que es la que apunta al ticket.
      // Si el equipo no la tiene, el navegador entrega la que haya.
      this.stream = await md.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      this.estado.set('viva');
      // El <video> recién existe después de que Angular pinte la rama 'viva'.
      queueMicrotask(() => {
        const el = this.video()?.nativeElement;
        if (el && this.stream) { el.srcObject = this.stream; void el.play().catch(() => undefined); }
      });
    } catch (e: unknown) {
      const nombre = (e as { name?: string })?.name ?? '';
      // Se distinguen porque la acción de la persona es distinta en cada caso.
      if (nombre === 'NotAllowedError') this.fallar('No diste permiso para usar la cámara.');
      else if (nombre === 'NotFoundError') this.fallar('Esta computadora no tiene cámara.');
      else this.fallar('No se pudo abrir la cámara.');
    }
  }

  /** Congela el cuadro actual y lo entrega como JPEG. */
  disparar(): void {
    const v = this.video()?.nativeElement;
    const c = this.lienzo()?.nativeElement;
    if (!v || !c || !v.videoWidth) return; // todavía no hay cuadro: no se entrega una foto negra
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) { this.fallar('No se pudo procesar la imagen.'); return; }
    ctx.drawImage(v, 0, 0, c.width, c.height);
    // 0.85: el cuadre lo hace Claude Vision leyendo el total, y a 0.7 empezaba a costarle.
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    const capturedAt = new Date().toISOString();
    this.cerrar();
    this.capturada.emit({ dataUrl, capturedAt });
  }

  /** Cierra el visor y suelta la cámara. */
  cerrar(): void {
    this.soltar();
    this.estado.set('idle');
  }

  private fallar(msg: string): void {
    this.soltar();
    this.error.set(msg);
    this.estado.set('error');
  }

  private soltar(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const el = this.video()?.nativeElement;
    if (el) el.srcObject = null;
  }
}
