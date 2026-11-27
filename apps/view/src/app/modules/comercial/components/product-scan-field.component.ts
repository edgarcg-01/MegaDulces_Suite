import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy,
  effect, input, output, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { controlesSiSigueAbierta, detenerLector } from '../../../shared/util/lector-camara.util';

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
      @if (!soloCamara()) {
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
      }

      @if (camaraAbierta()) {
        <!-- [NP.7.L.24] Cámara a pantalla completa con una VENTANA con forma de código de barras (ancho y bajo):
             la persona sabe dónde ponerlo y a qué distancia. La ventana es guía visual; zxing sigue leyendo el
             cuadro entero, así que nada que antes se leía deja de leerse. -->
        <div class="psf-cam-ov" role="dialog" aria-modal="true" aria-label="Escaneo con la cámara" (keydown.escape)="cerrarCamara()">
          <video #video class="psf-cam-vid" playsinline muted></video>
          <div class="psf-cam-win" aria-hidden="true"><i></i><i></i><i></i><i></i><span class="psf-cam-laser"></span></div>
          <div class="psf-cam-top">
            <button #cancelar type="button" class="psf-cam-rb" aria-label="Cerrar la cámara" (click)="cerrarCamara()"><i class="pi pi-times" aria-hidden="true"></i></button>
            <span class="psf-cam-ttl">Escanear código</span>
            @if (linternaDisponible()) {
              <button type="button" class="psf-cam-rb" [class.on]="linterna()" [attr.aria-pressed]="linterna()" aria-label="Linterna" (click)="alternarLinterna()"><i class="pi pi-bolt" aria-hidden="true"></i></button>
            } @else { <span class="psf-cam-rb-vacio" aria-hidden="true"></span> }
          </div>
          <p class="psf-cam-tip">Centra el código de barras en el recuadro<small>Lee solo, sin apretar nada. Acerca el teléfono si no lo lee.</small></p>
          <div class="psf-cam-bottom">
            <button type="button" class="psf-cam-x" (click)="teclear()"><i class="pi pi-pencil" aria-hidden="true"></i> Teclear el código</button>
          </div>
        </div>
      }

      @if (conPie()) {
      <div class="psf-pie">
        <span class="psf-est" [class.on]="activo()">
          <span class="psf-dot" aria-hidden="true"></span>
          {{ activo() ? 'Pistola lista — dispara' : 'Toca el campo para usar la pistola' }}
        </span>
        <span class="psf-help">Al escanear busca solo · Enter busca · Esc limpia</span>
      </div>
      }
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
    /* [NP.7.L.24] Escaner a pantalla completa. Encima del video va siempre fondo oscuro, en claro y en
       oscuro: es una camara, el texto blanco se lee sobre la imagen. */
    .psf-cam-ov { position: fixed; inset: 0; z-index: 1200; background: #000; color: #fff; overflow: hidden; }
    .psf-cam-vid { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    /* La ventana: ancha y baja como un codigo de barras (2.3:1). La sombra enorme oscurece todo lo demas. */
    .psf-cam-win {
      position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%);
      width: min(80vw, 340px); aspect-ratio: 2.3 / 1; border-radius: var(--r-md, 12px);
      box-shadow: 0 0 0 100vmax rgba(0, 0, 0, .55);
    }
    .psf-cam-win i { position: absolute; width: 28px; height: 28px; border: 0 solid #fff; }
    .psf-cam-win i:nth-child(1) { top: 0; left: 0; border-width: 3px 0 0 3px; border-top-left-radius: 12px; }
    .psf-cam-win i:nth-child(2) { top: 0; right: 0; border-width: 3px 3px 0 0; border-top-right-radius: 12px; }
    .psf-cam-win i:nth-child(3) { bottom: 0; left: 0; border-width: 0 0 3px 3px; border-bottom-left-radius: 12px; }
    .psf-cam-win i:nth-child(4) { bottom: 0; right: 0; border-width: 0 3px 3px 0; border-bottom-right-radius: 12px; }
    .psf-cam-laser { position: absolute; left: 12px; right: 12px; top: 50%; height: 2px; background: var(--action); box-shadow: 0 0 12px 2px var(--action); }
    .psf-cam-top {
      position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between;
      padding: max(16px, env(safe-area-inset-top, 0)) 16px 16px;
    }
    .psf-cam-ttl { font-weight: 700; font-size: var(--fs-body, .875rem); }
    .psf-cam-rb, .psf-cam-rb-vacio { width: 44px; height: 44px; border-radius: 50%; }
    .psf-cam-rb {
      display: grid; place-items: center; background: rgba(0, 0, 0, .45); color: #fff;
      border: 1px solid rgba(255, 255, 255, .22); cursor: pointer; font: inherit;
    }
    .psf-cam-rb.on { background: #fff; color: #000; }
    .psf-cam-rb:focus-visible, .psf-cam-x:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .psf-cam-tip {
      position: absolute; left: 0; right: 0; top: calc(45% + min(80vw, 340px) / 4.6 + 20px);
      margin: 0; padding: 0 2rem; text-align: center; color: #fff; font-size: var(--fs-sm, .8125rem); font-weight: 600;
    }
    .psf-cam-tip small { display: block; margin-top: 4px; color: rgba(255, 255, 255, .72); font-size: var(--fs-xs, .75rem); font-weight: 400; }
    .psf-cam-bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 16px 16px max(24px, env(safe-area-inset-bottom, 0)); }
    .psf-cam-x {
      width: 100%; min-height: 48px; display: flex; align-items: center; justify-content: center; gap: .5rem;
      background: rgba(24, 24, 27, .85); color: #fff;
      border: 1px solid rgba(255, 255, 255, .22); border-radius: var(--r-md, 8px);
      font: inherit; font-weight: 600; cursor: pointer;
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
  /**
   * `[NP.7]` El pie «Pistola lista — dispara»: sirve en el mostrador con pistola, confunde en un celular.
   * Por defecto se muestra (las pantallas que ya lo usan no cambian); el levantamiento lo apaga.
   */
  readonly conPie = input(true);
  /**
   * `[NP.7]` Tomar el foco solo (al cargar y con `refocoTick`): lo que hace funcionar la pistola del
   * mostrador. En un celular abre el teclado y tapa media pantalla, así que el levantamiento lo apaga.
   */
  readonly autoEnfoque = input(true);
  /**
   * `[NP.7.L.24]` Sólo la cámara, sin el renglón del campo: la pantalla pone su propio botón «Escanear» y su
   * buscador, y usa este componente por su escáner. Por defecto el campo se ve (las demás pantallas no cambian).
   */
  readonly soloCamara = input(false);

  readonly valorChange = output<string>();
  /** El operador disparó: pistola (Enter), cámara (lectura) o botón de lupa. */
  readonly buscar = output<string>();
  /** Motivo por el que la cámara no abrió, para que el padre lo muestre. */
  readonly sinCamara = output<string>();
  /** `[NP.7.L.24]` «Teclear el código» desde la cámara: el padre decide a dónde llevar a la persona. */
  readonly pidioTeclear = output<void>();

  readonly activo = signal(false);
  readonly camaraAbierta = signal(false);
  /** `[NP.7.L.24]` La linterna sólo se ofrece si la cámara la tiene (Chrome en Android; Safari no la expone). */
  readonly linternaDisponible = signal(false);
  readonly linterna = signal(false);
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
    effect(() => { this.refocoTick(); if (this.autoEnfoque()) this.enfocar(); });
  }

  ngAfterViewInit(): void { if (this.autoEnfoque()) this.enfocar(); }

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
    if (this.autoEnfoque()) this.enfocar();
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
        this.controles = controlesSiSigueAbierta(await this.lector.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          v,
          (r) => { if (r) this.leido(r.getText()); },
        ), this.camaraAbierta());
        this.revisarLinterna(v);
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

  /** La pista de video que está mostrando la cámara (null si no hay). */
  private pista(v?: HTMLVideoElement | null): MediaStreamTrack | null {
    const flujo = (v ?? this.video()?.nativeElement)?.srcObject as MediaStream | null | undefined;
    return flujo?.getVideoTracks?.()[0] ?? null;
  }

  private revisarLinterna(v: HTMLVideoElement): void {
    try {
      const cap = this.pista(v)?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      this.linternaDisponible.set(!!cap?.torch);
    } catch {
      this.linternaDisponible.set(false);
    }
  }

  /** Prende o apaga la linterna. Si el teléfono la rechaza, se deja de ofrecer (no se finge prendida). */
  async alternarLinterna(): Promise<void> {
    const pista = this.pista();
    if (!pista) return;
    const quiere = !this.linterna();
    try {
      await pista.applyConstraints({ advanced: [{ torch: quiere } as MediaTrackConstraintSet] });
      this.linterna.set(quiere);
    } catch {
      this.linternaDisponible.set(false);
      this.linterna.set(false);
    }
  }

  /** «Teclear el código»: cierra la cámara y lleva al campo (o, sin campo, avisa al padre). */
  teclear(): void {
    this.cerrarCamara();
    this.pidioTeclear.emit();
    if (!this.soloCamara()) setTimeout(() => this.campo()?.nativeElement?.focus(), 0);
  }

  cerrarCamara(): void {
    this.camaraAbierta.set(false);
    this.linterna.set(false);
    this.linternaDisponible.set(false);
    detenerLector(this.controles);
    this.controles = undefined;
    this.lector = undefined;
    // Sin auto-enfoque (celular) cerrar la cámara no abre el teclado encima del aviso.
    if (this.autoEnfoque()) this.enfocar();
  }

  ngOnDestroy(): void { this.cancelarAuto(); this.cerrarCamara(); }
}
