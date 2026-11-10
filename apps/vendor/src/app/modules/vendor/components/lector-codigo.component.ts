import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, input, output, signal, viewChild,
} from '@angular/core';
import {
  TEXTO_SIN_ACCESO_A_CAMARA, abrirLectorCodigos, camaraDisponible, controlesSiSigueAbierta, detenerLector,
  motivoSinCamara,
} from '@megadulces/ui-web';

/** Lo mínimo que hace falta para apagar la cámara (los controles de zxing). */
type Controles = { stop: () => void };

/**
 * `[VTK.17]` `[VTK.18]` **El botón de la cámara y su capa: leer un código de barras.**
 *
 * La usan el checador de precios y el buscador de Tomar pedido. La lógica (zxing, los dos apagados,
 * el texto de por qué no abrió) vive en `@megadulces/ui-web`; esto es sólo la cáscara, repetida por
 * app porque ninguna librería del repo hospeda componentes de Angular — deuda declarada
 * (`[VTK.17.D1]`), la misma que la firma (`[CG.66]`).
 *
 * Reglas, cada una con su porqué:
 *  - **El permiso se pide al tocar el botón**, nunca al abrir la pantalla.
 *  - **Si no hay permiso o cámara, se dice** (`sinCamara`) y el campo de texto sigue ahí: la cámara
 *    es un atajo, no la única puerta.
 *  - **La cámara se apaga** al leer, al tocar «Cancelar», con `Esc`, al salir de la pantalla y
 *    cuando la app pasa a segundo plano. Una cámara prendida detrás de la pantalla gasta batería y
 *    es la luz verde que asusta a quien la ve.
 *  - **zxing se carga al tocar** el botón (`import()` dinámico en la librería): no pesa en Tomar
 *    pedido, donde la cámara es la excepción.
 */
@Component({
  selector: 'app-lector-codigo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button #boton type="button" class="lc-btn" [attr.aria-label]="etiqueta()" [title]="etiqueta()"
      [disabled]="deshabilitado()" (click)="abrir()">
      <i class="pi pi-camera" aria-hidden="true"></i>
    </button>
    @if (abierta()) {
      <div class="lc-ov" role="dialog" aria-modal="true" aria-label="Leer un código de barras con la cámara">
        <p class="lc-tip">Apunta la cámara al código de barras</p>
        <video #video class="lc-vid" playsinline muted></video>
        <button #cancelar type="button" class="lc-x" (click)="cerrar()">Cancelar</button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; flex: none; }
    .lc-btn {
      display: grid; place-items: center;
      min-width: max(var(--tap-min), 2.5rem); min-height: max(var(--tap-min), 2.5rem);
      border: 1px solid var(--border-color); border-radius: var(--r-pill);
      background: var(--card-bg); color: var(--text-main); cursor: pointer;
    }
    .lc-btn i { font-size: var(--fs-h3); }
    .lc-btn:disabled { opacity: .45; cursor: default; }
    .lc-btn:focus-visible, .lc-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* Fuera del contenedor sticky: position fixed cubre la pantalla entera, también la barra de abajo. */
    .lc-ov {
      position: fixed; inset: 0; z-index: 1200;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3);
      background: var(--layout-bg);
      padding: max(var(--sp-4), env(safe-area-inset-top)) var(--sp-4) max(var(--sp-4), env(safe-area-inset-bottom));
    }
    .lc-tip { margin: 0; color: var(--text-main); font-size: var(--fs-body); font-weight: var(--fw-bold); text-align: center; }
    .lc-vid {
      width: min(100%, 32rem); aspect-ratio: 4 / 3; object-fit: cover;
      background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-md);
    }
    .lc-x {
      min-height: max(var(--tap-min), 3rem); min-width: 10rem; padding: 0 var(--sp-4);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--text-main);
      font: inherit; font-size: var(--fs-body); font-weight: var(--fw-bold); cursor: pointer;
    }
  `],
})
export class LectorCodigoComponent implements OnDestroy {
  /** Lo que dice el botón al lector de pantalla (y su `title`). */
  readonly etiqueta = input('Leer código de barras con la cámara');
  readonly deshabilitado = input(false);

  /** El código leído, ya sin espacios. La cámara ya se apagó cuando esto sale. */
  readonly leido = output<string>();
  /** Por qué la cámara no abrió (permiso, sin cámara, navegador sin acceso): el padre lo muestra. */
  readonly sinCamara = output<string>();

  readonly abierta = signal(false);

  private readonly boton = viewChild<ElementRef<HTMLButtonElement>>('boton');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly cancelarBtn = viewChild<ElementRef<HTMLButtonElement>>('cancelar');
  private controles?: Controles;
  /** Cada apertura tiene su número: una cámara que llega tarde a un intento ya cerrado se apaga. */
  private intento = 0;

  async abrir(): Promise<void> {
    if (this.abierta() || this.deshabilitado()) return;
    if (!camaraDisponible()) {
      this.sinCamara.emit(TEXTO_SIN_ACCESO_A_CAMARA);
      return;
    }
    const intento = ++this.intento;
    this.abierta.set(true);
    // Esperar a que la capa (con su <video>) esté pintada.
    await new Promise<void>((r) => setTimeout(r, 30));
    const v = this.video()?.nativeElement;
    if (!v || intento !== this.intento || !this.abierta()) return;
    this.cancelarBtn()?.nativeElement.focus();
    try {
      const ctl = await abrirLectorCodigos(v, (codigo) => this.alLeer(codigo, intento));
      this.controles = controlesSiSigueAbierta(ctl, this.abierta() && intento === this.intento);
    } catch (e) {
      if (intento !== this.intento) return; // ya se había cerrado: no hay nada que avisar
      this.cerrar(false);
      this.sinCamara.emit(motivoSinCamara(e));
    }
  }

  /** Apaga la cámara y quita la capa. `devolverFoco` lo regresa al botón (teclado y lector de pantalla). */
  cerrar(devolverFoco = true): void {
    const estabaAbierta = this.abierta();
    this.intento++;
    this.abierta.set(false);
    detenerLector(this.controles);
    this.controles = undefined;
    if (devolverFoco && estabaAbierta) setTimeout(() => this.boton()?.nativeElement.focus(), 0);
  }

  private alLeer(codigo: string, intento: number): void {
    // zxing puede llamar otra vez antes de detenerse: sólo cuenta la primera lectura del intento vivo.
    if (!this.abierta() || intento !== this.intento) return;
    // El zumbido confirma sin mirar la pantalla.
    try { navigator.vibrate?.(80); } catch { /* sin vibración */ }
    this.cerrar(false);
    this.leido.emit(codigo);
  }

  @HostListener('document:keydown.escape')
  alEscape(): void {
    if (this.abierta()) this.cerrar();
  }

  /** La app pasó a segundo plano (otra app, pantalla bloqueada): la cámara no se queda prendida. */
  @HostListener('document:visibilitychange')
  alCambiarVisibilidad(): void {
    if (this.abierta() && typeof document !== 'undefined' && document.hidden) this.cerrar(false);
  }

  ngOnDestroy(): void {
    this.cerrar(false);
  }
}
