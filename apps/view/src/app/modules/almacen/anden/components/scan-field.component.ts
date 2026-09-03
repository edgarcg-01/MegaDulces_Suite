import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, effect, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

/**
 * **La barra única del Andén — escanear y buscar son el mismo campo.**
 *
 * No es un campo de escaneo con un buscador al lado: **dos inputs compitiendo por
 * el foco es justo lo que rompe una pistola en modo wedge**, porque el disparo se
 * va al elemento equivocado y el operario tiene que tocar la pantalla con guantes
 * antes de cada lectura.
 *
 * Con un solo campo:
 *  - **La pistola dispara** y, si el código deja una sola coincidencia, `Enter`
 *    abre ese renglón. Ese es el gesto completo: apuntar y disparar.
 *  - **Tecleando filtra en vivo** por nombre, SKU y —en Ubicación— por rack, sin
 *    acentos ni mayúsculas. Es la salida cuando la etiqueta está rota.
 *  - **El mismo Enter sirve para los dos.** El operario no tiene que saber en qué
 *    modo está.
 *
 * El foco vuelve solo tras cada disparo, cada guardado y cada cierre de panel: el
 * padre llama `enfocar()`. Sin eso no hay ráfaga.
 */
@Component({
  selector: 'app-scan-field',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sf">
      <div class="sf-row">
        <input
          #campo
          class="sf-in"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          [attr.inputmode]="numerico() ? 'numeric' : 'text'"
          [attr.aria-label]="etiqueta()"
          [placeholder]="placeholder()"
          [ngModel]="valor()"
          (ngModelChange)="valorChange.emit($event)"
          (keyup.enter)="enter.emit()"
          (keyup.escape)="limpiar()"
          (focus)="activo.set(true)"
          (blur)="activo.set(false)"
        />
        @if (valor()) {
          <button type="button" class="sf-x icon-btn" aria-label="Limpiar" (click)="limpiar()">✕</button>
        }
        @if (conCamara()) {
          <button type="button" class="sf-cam icon-btn" aria-label="Escanear con la cámara" (click)="abrirCamara()">
            <i class="pi pi-camera" aria-hidden="true"></i>
          </button>
        }
      </div>

      @if (camaraAbierta()) {
        <div class="sf-cam-ov" role="dialog" aria-modal="true" aria-label="Escaneo con la cámara">
          <video #video class="sf-cam-vid" playsinline muted></video>
          <button #cancelar type="button" class="sf-cam-x" (click)="cerrarCamara()"
            (keyup.escape)="cerrarCamara()">Cancelar</button>
        </div>
      }

      <div class="sf-pie">
        <span class="sf-est" [class.sf-listo]="activo()">
          <span class="sf-dot" aria-hidden="true"></span>
          {{ activo() ? 'Pistola lista' : 'Tocá el campo para activar la pistola' }}
        </span>
        @if (valor()) {
          <span class="sf-cnt">{{ visibles() }} de {{ total() }}</span>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sf-row { display: flex; gap: var(--sp-2); }
    .sf-in {
      flex: 1; min-width: 0;
      /* 52px: se teclea con guantes. No se deja al --tap-min porque ése vale 0
         en puntero fino, y el andén también corre en equipos que se declaran así. */
      min-height: 52px; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      font: inherit; font-size: var(--fs-body); font-weight: var(--fw-medium);
    }
    .sf-in:focus {
      outline: none; border-color: var(--action);
      box-shadow: 0 0 0 3px var(--action-ring);
    }
    .sf-in::placeholder { color: var(--text-faint); font-weight: var(--fw-regular); }
    /* La clase icon-btn va a propósito: es el selector que ya aplica --tap-min
       en styles.css. Renombrarla rompe el tamaño táctil sin que se note. */
    .sf-x, .sf-cam {
      flex: 0 0 auto; min-width: 52px; min-height: 52px;
      background: var(--card-bg); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      font: inherit; cursor: pointer;
    }
    .sf-x:hover, .sf-cam:hover { border-color: var(--action); color: var(--action); }
    .sf-pie {
      display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
      margin-top: var(--sp-1); font-size: var(--fs-micro);
    }
    .sf-est { display: flex; align-items: center; gap: 6px; color: var(--text-faint); }
    .sf-listo { color: var(--ok-soft-fg); }
    .sf-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .sf-cnt { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sf-cam-ov {
      position: fixed; inset: 0; z-index: 1200;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3);
      /* Fondo propio, no un negro puro: el token vale en ambos temas. */
      background: var(--layout-bg); padding: var(--sp-3);
    }
    .sf-cam-vid { width: min(100%, 520px); aspect-ratio: 4 / 3; object-fit: cover;
      background: var(--surface-ground); border-radius: var(--r-md); }
    .sf-cam-x {
      min-height: 52px; min-width: 160px; padding: 0 var(--sp-4);
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      font: inherit; font-weight: var(--fw-bold); cursor: pointer;
    }
  `],
})
export class ScanFieldComponent implements AfterViewInit, OnDestroy {
  readonly valor = input.required<string>();
  readonly etiqueta = input('Escaneá o buscá');
  readonly placeholder = input('Escaneá o escribí para buscar');
  readonly numerico = input(false);
  readonly conCamara = input(true);
  /** Coincidencias visibles / total, para el contador `N de M`. */
  readonly visibles = input(0);
  readonly total = input(0);
  /** Reenfoca cuando cambia: el padre lo incrementa tras guardar o cerrar panel. */
  readonly refocoTick = input(0);

  readonly valorChange = output<string>();
  readonly enter = output<void>();
  /** Motivo por el que la cámara no abrió, para que el padre lo muestre. */
  readonly sinCamara = output<string>();

  readonly activo = signal(false);
  readonly camaraAbierta = signal(false);
  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly cancelar = viewChild<ElementRef<HTMLButtonElement>>('cancelar');
  private lector?: BrowserMultiFormatReader;
  private controles?: IScannerControls;

  constructor() {
    effect(() => {
      this.refocoTick();
      this.enfocar();
    });
  }

  ngAfterViewInit(): void { this.enfocar(); }

  /** Devuelve el foco y selecciona: el siguiente disparo pisa lo anterior. */
  enfocar(): void {
    setTimeout(() => {
      const el = this.campo()?.nativeElement;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
  }

  limpiar(): void {
    this.valorChange.emit('');
    this.enfocar();
  }

  // ── Cámara (respaldo cuando no hay pistola o la etiqueta no lee) ───────────

  /**
   * La cámara es **respaldo**, no el camino principal: en el andén la pistola es
   * más rápida y no obliga a encuadrar. Sirve cuando el handheld no la trae, o
   * cuando el código quedó arrugado y la pistola no engancha.
   */
  async abrirCamara(): Promise<void> {
    // `getUserMedia` no existe fuera de contexto seguro: en http de LAN el botón
    // tiene que decir por qué no abre, no quedarse mudo.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.sinCamara.emit('Este equipo no da acceso a la cámara (requiere HTTPS). Usá la pistola o tecleá el código.');
      return;
    }
    this.camaraAbierta.set(true);
    setTimeout(() => this.cancelar()?.nativeElement?.focus(), 150);
    setTimeout(async () => {
      const v = this.video()?.nativeElement;
      if (!v) return;
      const hints = new Map();
      // Sólo los formatos de retail: menos trabajo por intento, engancha antes.
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
      ]);
      this.lector = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
      try {
        this.controles = await this.lector.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          v,
          (r) => { if (r) this.leido(r.getText()); },
        );
      } catch {
        this.cerrarCamara();
        this.sinCamara.emit('No se pudo abrir la cámara. Revisá los permisos (requiere HTTPS).');
      }
    }, 80);
  }

  private leido(raw: string): void {
    // El zumbido confirma sin mirar la pantalla: en el andén se lee de reojo.
    if (navigator.vibrate) navigator.vibrate(80);
    this.cerrarCamara();
    this.valorChange.emit(raw.trim());
    // Un tick para que el padre recalcule el filtro antes de resolver el Enter.
    setTimeout(() => this.enter.emit(), 0);
  }

  cerrarCamara(): void {
    this.camaraAbierta.set(false);
    try { this.controles?.stop(); } catch { /* la cámara ya estaba cerrada */ }
    this.controles = undefined;
    this.lector = undefined;
    this.enfocar();
  }

  ngOnDestroy(): void { this.cerrarCamara(); }
}
