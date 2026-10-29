import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy,
  effect, input, output, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

/**
 * **Un solo campo para los tres modos de dar con el producto.**
 *
 * En el anaquel el operador usa lo que tenga a la mano, y el campo no puede
 * cambiar según eso:
 *
 *  - **Pistola de la cajera** (lector HID, "wedge"): no es una cámara ni un
 *    dispositivo que haya que abrir — *teclea* el código en el campo con foco y
 *    manda `Enter`. Por eso esto es un `input` normal y el `Enter` resuelve:
 *    apuntar y disparar, sin tocar la pantalla entre lectura y lectura.
 *    ⭐ [P2.9.3] **No toda pistola manda `Enter`** (depende de su configuración de
 *    sufijo). Sin él, el código quedaba escrito esperando la lupa — reportado en
 *    Caducidades el 2026-10-29. Ahora el campo también dispara SOLO cuando entra un
 *    código completo: una ráfaga de pistola (caracteres a < 50 ms) o un código de
 *    barras numérico de 8–14 dígitos, tras 250 ms sin teclas. Un SKU tecleado a
 *    mano a ritmo humano sigue esperando `Enter`: así no se busca a medio escribir.
 *  - **Cámara del teléfono** (botón): para quien recorre el estante sin pistola.
 *  - **Tecleado**: cuando la etiqueta está rota o borrada, o cuando el código es
 *    el de anaquel y no un código de barras.
 *
 * **Por qué un campo y no tres:** dos inputs compitiendo por el foco es lo que
 * rompe una pistola en modo wedge — el disparo se va al elemento equivocado. El
 * foco vuelve solo tras cada resolución (`refocoTick`), que es lo que permite
 * escanear en ráfaga.
 *
 * Gemelo del `ScanFieldComponent` del Andén: aquél **filtra una lista local**,
 * éste **resuelve contra la API**. Comparten el cableado de zxing; si aparece un
 * tercer consumidor, conviene extraer la cámara a una primitiva compartida.
 */
/** Silencio tras la última tecla para dar por terminado un código escaneado. */
export const AUTO_MS = 250;
/** Entre teclas de una pistola: una persona no teclea a este ritmo. */
const RAFAGA_MS = 50;

/** ¿El texto es un código que conviene buscar solo, sin esperar `Enter`? */
export function esCodigoCompleto(code: string, rafaga: boolean): boolean {
  const c = code.trim();
  if (!c) return false;
  if (rafaga && c.length >= 4) return true; // lo tecleó una pistola
  return /^\d{8,14}$/.test(c); // EAN-8, UPC-A, EAN-13, ITF-14: códigos de barras completos
}

@Component({
  selector: 'app-product-scan-field',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="psf">
      <div class="psf-row">
        <span class="psf-ico" aria-hidden="true"><i class="pi" [class.pi-qrcode]="!ocupado()" [class.pi-spinner]="ocupado()" [class.pi-spin]="ocupado()"></i></span>
        <input
          #campo
          class="psf-in"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          inputmode="text"
          [attr.aria-label]="etiqueta()"
          [placeholder]="placeholder()"
          [disabled]="deshabilitado()"
          [ngModel]="valor()"
          (ngModelChange)="alEscribir($event)"
          (keyup.enter)="disparar()"
          (keyup.escape)="limpiar()"
          (focus)="activo.set(true)"
          (blur)="activo.set(false)"
        />
        @if (valor()) {
          <button type="button" class="psf-btn" aria-label="Limpiar el código" (click)="limpiar()">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        }
        <button type="button" class="psf-btn psf-cam" aria-label="Escanear con la cámara"
          [disabled]="deshabilitado()" (click)="abrirCamara()">
          <i class="pi pi-camera" aria-hidden="true"></i>
        </button>
        <button type="button" class="psf-btn psf-go" aria-label="Buscar este código"
          [disabled]="deshabilitado() || !valor()" (click)="disparar()">
          <i class="pi pi-search" aria-hidden="true"></i>
        </button>
      </div>

      @if (camaraAbierta()) {
        <div class="psf-cam-ov" role="dialog" aria-modal="true" aria-label="Escaneo con la cámara">
          <p class="psf-cam-tip">Encuadra el código de barras</p>
          <video #video class="psf-cam-vid" playsinline muted></video>
          <button #cancelar type="button" class="psf-cam-x" (click)="cerrarCamara()" (keyup.escape)="cerrarCamara()">Cancelar</button>
        </div>
      }

      <div class="psf-pie">
        <span class="psf-est" [class.on]="activo()">
          <span class="psf-dot" aria-hidden="true"></span>
          {{ activo() ? 'Pistola lista — dispara' : 'Toca el campo para usar la pistola' }}
        </span>
        <span class="psf-help">Al escanear busca solo · Enter busca · Esc limpia</span>
      </div>
    </div>
  `,
  styles: [`
    /* NO lleva container-type, a proposito: .psf-cam-ov es un overlay de camara
       con position: fixed; inset: 0, y container-type implica contencion de
       layout - el host pasaria a ser su bloque contenedor y el overlay, en vez
       de cubrir la pantalla, se encogeria al tamano del campo. Es la trampa que
       DESIGN §R marca explicitamente. Aca no hace falta: el desborde se arregla
       con flex-wrap, no con queries de contenedor. */
    :host { display: block; }
    /* Envuelve: el renglon es icono + campo + hasta 3 botones de 48px. Sin
       wrap su min-content era 365px y no cabia en el paso de captura de un
       telefono (326px utiles). El campo cede hasta 8rem y despues bajan los
       botones al renglon siguiente, que es mejor que un campo de 2 caracteres. */
    .psf-row { display: flex; gap: .4rem; align-items: stretch; flex-wrap: wrap; }
    .psf-ico {
      display: flex; align-items: center; justify-content: center; width: 2.5rem;
      border: 1px solid var(--border-color); border-right: 0;
      border-radius: var(--r-md, 8px) 0 0 var(--r-md, 8px);
      background: var(--surface-ground); color: var(--text-muted);
    }
    .psf-row > .psf-ico + .psf-in { border-radius: 0 var(--r-md, 8px) var(--r-md, 8px) 0; margin-left: -.4rem; }
    .psf-in {
      flex: 1 1 8rem; min-width: 0; min-height: 48px; padding: .5rem .75rem;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      font: inherit; font-size: 1rem; font-weight: 500;
      /* 1rem a propósito: por debajo de 16px iOS hace zoom al enfocar, y en una
         ráfaga de escaneo el zoom deja la pantalla corrida. */
      font-variant-numeric: tabular-nums;
    }
    .psf-in:focus { outline: none; border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .psf-in::placeholder { color: var(--text-faint); font-weight: 400; }
    .psf-btn {
      flex: 0 0 auto; min-width: 48px; min-height: 48px;
      background: var(--card-bg); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      font: inherit; cursor: pointer;
    }
    .psf-btn:hover:not(:disabled) { border-color: var(--action); color: var(--action); }
    .psf-btn:disabled { opacity: .45; cursor: default; }
    .psf-btn:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .psf-go { background: var(--action); color: var(--action-fg, #fff); border-color: var(--action); }
    .psf-go:hover:not(:disabled) { color: var(--action-fg, #fff); filter: brightness(1.05); }
    .psf-pie {
      display: flex; align-items: center; justify-content: space-between; gap: .5rem;
      flex-wrap: wrap; margin-top: .3rem; font-size: var(--fs-micro, .69rem);
    }
    .psf-est { display: inline-flex; align-items: center; gap: 6px; color: var(--text-faint); }
    .psf-est.on { color: var(--ok-soft-fg); }
    .psf-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .psf-help { color: var(--text-faint); }
    .psf-cam-ov {
      position: fixed; inset: 0; z-index: 1200;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .75rem;
      background: var(--layout-bg); padding: 1rem;
    }
    .psf-cam-tip { margin: 0; color: var(--text-muted); font-size: var(--fs-sm, .85rem); }
    .psf-cam-vid {
      width: min(100%, 520px); aspect-ratio: 4 / 3; object-fit: cover;
      background: var(--surface-ground); border-radius: var(--r-md, 8px);
    }
    .psf-cam-x {
      min-height: 48px; min-width: 160px; padding: 0 1.25rem;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
      font: inherit; font-weight: 700; cursor: pointer;
    }
    @media (max-width: 40rem) { .psf-help { display: none; } }
  `],
})
export class ProductScanFieldComponent implements AfterViewInit, OnDestroy {
  readonly valor = input.required<string>();
  readonly etiqueta = input('Escanea o escribe el código');
  readonly placeholder = input('Escanea con la pistola, la cámara o escribe el código');
  readonly deshabilitado = input(false);
  /** Resolviendo contra la API: el ícono gira y no se aceptan disparos nuevos. */
  readonly ocupado = input(false);
  /** Reenfoca cuando cambia: el padre lo incrementa tras resolver o guardar renglón. */
  readonly refocoTick = input(0);

  readonly valorChange = output<string>();
  /** El operador disparó: pistola (Enter), cámara (lectura) o botón de lupa. */
  readonly buscar = output<string>();
  /** Motivo por el que la cámara no abrió, para que el padre lo muestre. */
  readonly sinCamara = output<string>();

  readonly activo = signal(false);
  readonly camaraAbierta = signal(false);
  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly cancelar = viewChild<ElementRef<HTMLButtonElement>>('cancelar');
  private lector?: BrowserMultiFormatReader;
  private controles?: IScannerControls;
  private temporizador: ReturnType<typeof setTimeout> | null = null;
  private ultimaTecla = 0;
  /** Intervalos entre teclas del texto actual: si todos son de pistola, es una ráfaga. */
  private intervalos: number[] = [];

  constructor() {
    effect(() => { this.refocoTick(); this.enfocar(); });
  }

  ngAfterViewInit(): void { this.enfocar(); }

  /** Devuelve el foco y selecciona: el siguiente disparo pisa lo anterior. */
  enfocar(): void {
    setTimeout(() => {
      const el = this.campo()?.nativeElement;
      if (!el || this.deshabilitado()) return;
      el.focus();
      el.select();
    }, 0);
  }

  disparar(): void {
    this.cancelarAuto();
    const code = (this.valor() || '').trim();
    if (!code || this.ocupado() || this.deshabilitado()) return;
    this.buscar.emit(code);
  }

  /**
   * [P2.9.3] Cada cambio del texto: lo reporta al padre y, si al quedarse quieto
   * parece un código completo, dispara solo. El `Enter` de la pistola sigue
   * funcionando y cancela este disparo, así que no se busca dos veces.
   */
  alEscribir(v: string): void {
    this.valorChange.emit(v);
    const ahora = Date.now();
    const texto = String(v ?? '');
    if (texto.length <= 1) this.intervalos = [];
    else if (this.ultimaTecla) this.intervalos.push(ahora - this.ultimaTecla);
    this.ultimaTecla = ahora;
    this.cancelarAuto();
    const rafaga = this.intervalos.length >= 3 && this.intervalos.every((ms) => ms < RAFAGA_MS);
    if (!esCodigoCompleto(texto, rafaga)) return;
    this.temporizador = setTimeout(() => {
      this.temporizador = null;
      if ((this.valor() || '').trim() === texto.trim()) this.disparar();
    }, AUTO_MS);
  }

  private cancelarAuto(): void {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
  }

  limpiar(): void {
    this.cancelarAuto();
    this.intervalos = [];
    this.valorChange.emit('');
    this.enfocar();
  }

  // ── Cámara (para quien recorre el anaquel sin pistola) ────────────────────

  async abrirCamara(): Promise<void> {
    // `getUserMedia` no existe fuera de contexto seguro: en http de LAN el botón
    // tiene que decir POR QUÉ no abre, no quedarse mudo.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.sinCamara.emit('Este equipo no da acceso a la cámara (requiere HTTPS). Usa la pistola o escribe el código.');
      return;
    }
    this.camaraAbierta.set(true);
    setTimeout(() => this.cancelar()?.nativeElement?.focus(), 150);
    setTimeout(async () => {
      const v = this.video()?.nativeElement;
      if (!v) return;
      const hints = new Map();
      // Solo formatos de retail: menos trabajo por intento, engancha antes.
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.ITF,
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
        this.sinCamara.emit('No se pudo abrir la cámara. Revisa los permisos del navegador (requiere HTTPS).');
      }
    }, 80);
  }

  private leido(raw: string): void {
    // El zumbido confirma sin mirar la pantalla: en el anaquel se lee de reojo.
    if (navigator.vibrate) navigator.vibrate(80);
    const code = raw.trim();
    this.cerrarCamara();
    this.valorChange.emit(code);
    // Un tick para que el padre reciba el valor antes de resolverlo.
    setTimeout(() => this.buscar.emit(code), 0);
  }

  cerrarCamara(): void {
    this.camaraAbierta.set(false);
    try { this.controles?.stop(); } catch { /* la cámara ya estaba cerrada */ }
    this.controles = undefined;
    this.lector = undefined;
    this.enfocar();
  }

  ngOnDestroy(): void { this.cancelarAuto(); this.cerrarCamara(); }
}
