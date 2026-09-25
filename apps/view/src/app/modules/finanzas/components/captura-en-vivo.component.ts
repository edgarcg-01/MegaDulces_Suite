import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';

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
      <button type="button" class="cv-reintentar" (click)="cerrar()">Cancelar</button>
    }

    @if (estado() === 'viva') {
      <div class="cv-visor">
        <video #video class="cv-video" playsinline muted autoplay
               (loadedmetadata)="marcarListo()" (playing)="marcarListo()"
               aria-label="Lo que ve la cámara"></video>
        <span class="cv-live"><span class="cv-punto"></span> EN VIVO</span>
        <span class="cv-guia" aria-hidden="true"></span>
        @if (!listo()) {
          <span class="cv-cargando"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Encendiendo la cámara…</span>
        }
      </div>
      <p class="cv-tip">{{ listo() ? tipListo : tipEsperando }}</p>
      @if (aviso()) { <p class="cv-aviso" role="status">{{ aviso() }}</p> }
      <div class="cv-barra">
        <button type="button" class="cv-cancel" (click)="cerrar()">Cancelar</button>
        <button type="button" class="cv-disparar" [disabled]="!listo()" (click)="disparar()"
                [attr.aria-label]="listo() ? tipAriaOk : tipAriaEsperando"></button>
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
    .cv-aviso { margin: 6px 0 0; font-size: var(--fs-xs); text-align: center; color: var(--bad-fg); }
    .cv-cargando {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 7px;
      color: #FFF; font-size: var(--fs-sm);
    }

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
    .cv-disparar:hover:not(:disabled) { background: var(--action); border-color: var(--action-ring); }
    .cv-disparar:disabled { opacity: .45; cursor: not-allowed; }

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

  /** El <video> ya entrega cuadros. Hasta entonces el disparador va apagado. */
  readonly listo = signal(false);
  /** Lo que se le dice a la persona cuando el disparo no pudo hacerse. */
  readonly aviso = signal('');

  readonly tipListo = 'Que se vean el total y la fecha del comprobante.';
  readonly tipEsperando = 'Esperá a que se vea la imagen para disparar.';
  readonly tipAriaOk = 'Capturar la evidencia';
  readonly tipAriaEsperando = 'La cámara todavía no da imagen';

  /**
   * Señal, no campo suelto: el `effect` que engancha la cámara al <video> necesita algo de
   * qué depender. Con un campo plano no se vuelve a ejecutar cuando el stream llega.
   */
  private readonly stream = signal<MediaStream | null>(null);

  /** Cuanto se espera al permiso antes de declarar que nadie contesto. */
  private readonly ESPERA_PERMISO_MS = 20_000;
  /** Numero de apertura, para descartar el stream de una que ya se cancelo. */
  private intento = 0;
  private reloj: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    /**
     * ⭐ El arreglo del visor NEGRO que no disparaba. Antes esto era un `queueMicrotask`
     * disparado justo después de `estado.set('viva')` — y ahí el <video> TODAVÍA NO EXISTE:
     * con señales, Angular pinta la rama `@if` en una tarea posterior, no en el microtask
     * siguiente. Resultado: `srcObject` no se asignaba nunca, el visor quedaba en negro y
     * `videoWidth` se quedaba en 0 — con lo que `disparar()` hacía `return` en silencio.
     * Dos síntomas, una sola causa.
     *
     * Un `effect` sí espera: se vuelve a correr cuando el `viewChild` aparece.
     */
    effect(() => {
      const el = this.video()?.nativeElement;
      const s = this.stream();
      if (!el || !s) return;
      if (el.srcObject !== s) el.srcObject = s;
      this.reproducir(el);
    });
    // Soltar la cámara al destruir la pantalla. Sin esto el indicador del sistema queda
    // encendido y en algunos equipos la cámara no la puede tomar otra app.
    this.destroyRef.onDestroy(() => this.soltar());
  }

  /**
   * `play()` no siempre devuelve una promesa: jsdom lo deja en `undefined` y los navegadores
   * viejos también. Encadenar `.catch` a ciegas revienta, y acá revienta DENTRO de un effect,
   * o sea que se lleva puesta la detección de cambios y el visor no se pinta.
   */
  private reproducir(el: HTMLVideoElement): void {
    try {
      const r: unknown = el.play?.();
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined);
    } catch { /* el autoplay lo puede negar el navegador; el visor sigue enganchado */ }
  }

  /**
   * El <video> ya tiene cuadro. Lo llaman `loadedmetadata` y `playing`: en algunos equipos
   * dispara sólo uno de los dos.
   */
  marcarListo(): void {
    if ((this.video()?.nativeElement.videoWidth ?? 0) > 0) this.listo.set(true);
  }

  async abrir(): Promise<void> {
    this.estado.set('pidiendo');
    this.error.set('');
    this.aviso.set('');
    this.listo.set(false);
    // Cada apertura lleva su numero. Si la persona cancela y el permiso se concede DESPUES,
    // el stream que llega es de una apertura vieja: se suelta en vez de encenderse solo.
    const mia = ++this.intento;
    /**
     * ⚠️ `getUserMedia` puede no resolver NUNCA: mientras el dialogo de permiso siga
     * abierto la promesa queda pendiente, y si nadie lo contesta -- o el navegador no lo
     * muestra, como pasa en un navegador sin camara -- la pantalla se queda en
     * «Pidiendo permiso…» sin boton, sin error y sin salida salvo recargar. Medido acá.
     */
    this.reloj = setTimeout(() => {
      if (this.intento === mia && this.estado() === 'pidiendo') {
        this.fallar('El navegador no respondió al permiso de cámara. Revisá el candado de la barra de direcciones y reintentá.');
      }
    }, this.ESPERA_PERMISO_MS);
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      // Pasa de verdad: por HTTP sin `localhost` el navegador ni expone la API.
      this.fallar('Este navegador no da acceso a la cámara (hace falta una conexión segura).');
      return;
    }
    try {
      // `environment` = la cámara trasera del celular, que es la que apunta al ticket.
      // Si el equipo no la tiene, el navegador entrega la que haya.
      const s = await md.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      // Llego tarde: alguien ya cancelo o cerro. Encender la camara ahora seria prender una
      // luz que nadie pidio -- se suelta y listo.
      if (this.intento !== mia) { s.getTracks().forEach((t) => t.stop()); return; }
      this.detenerReloj();
      this.stream.set(s);
      this.estado.set('viva');
      // El enganche al <video> lo hace el `effect` del constructor, cuando el elemento existe.
    } catch (e: unknown) {
      if (this.intento !== mia) return;
      this.detenerReloj();
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
    // ⚠️ Antes esto era un `return` PELADO. Con el visor en negro, apretar el botón no hacía
    // nada y no decía nada: la persona concluye que «no toma la foto» y tiene razón. Sigue sin
    // entregarse una foto negra, pero ahora se dice por qué.
    if (!v || !c || !v.videoWidth) {
      this.listo.set(false);
      this.aviso.set('La cámara todavía no da imagen. Esperá un segundo y volvé a intentar.');
      return;
    }
    this.aviso.set('');
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

  private detenerReloj(): void {
    if (this.reloj !== null) { clearTimeout(this.reloj); this.reloj = null; }
  }

  private soltar(): void {
    this.detenerReloj();
    // Sube el numero: cualquier apertura en vuelo queda invalidada.
    this.intento++;
    this.stream()?.getTracks().forEach((t) => t.stop());
    this.stream.set(null);
    this.listo.set(false);
    const el = this.video()?.nativeElement;
    if (el) el.srcObject = null;
  }
}
