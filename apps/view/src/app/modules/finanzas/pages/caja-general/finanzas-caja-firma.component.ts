import { ChangeDetectionStrategy, Component, ElementRef, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { prepararFirma, type FirmaCanvas } from '@megadulces/ui-web';
import { textoFalloFirma, type ContextoFirma } from '@megadulces/contracts';
import { CajaFirmaApiService } from '../../caja-firma-api.service';

/**
 * `[CG.68]` **La pantalla del teléfono: acá se firma.**
 *
 * La caja muestra un QR; el teléfono lo escanea, aparece QUÉ se está firmando, se firma, y la PC
 * lo recibe. Pública (`/firmar`, lista en `rutas-publicas.ts`): no pide sesión (`[CG.203]`) y se
 * entra sólo por QR (`[CG.207]`, Edgar: *«no necesitamos el código, solo el qr»*).
 *
 * ── ⭐⭐ `[CG.201]`/`[CG.204]` Por HTTP, y sin rendirse ─────────────────────────────────────────
 *
 * Antes hablaba por un socket: al bloquear el teléfono el socket caía, `socket.io` se rendía tras
 * 5 intentos y la firma no salía — la persona firmaba otra vez (Edgar: *«hasta 3 veces»*). Ahora:
 *
 *   · el pedido vive en el servidor, así que volver del bloqueo no pierde nada;
 *   · ver y enviar **se reintentan solos** cuando no hubo respuesta (red), con techo visible;
 *   · **«Firma enviada» sólo se dice cuando el servidor confirmó que la guardó**;
 *   · el envío es idempotente del lado del servidor: un reintento cuyo primer acuse se perdió
 *     contesta OK, no «ya firmada»;
 *   · cada fallo tiene UNA frase y UNA acción (`textoFalloFirma`, compartida con la PC).
 *
 * ── ⚠️ Lo que esta pantalla NO puede hacer, a propósito ─────────────────────────────────────
 *
 * No lee la caja, no lista movimientos y no guarda nada. Ve **cuatro datos** del movimiento
 * (tipo, monto, beneficiario, documento) y manda un PNG. El teléfono se le pasa a otras personas
 * para que firmen: todo lo que esta pantalla pueda mostrar, lo va a ver quien firma.
 */
@Component({
  selector: 'app-finanzas-caja-firma',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, MessageModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    /* Sin esto el host es inline y el alto de 100vh de .fm no tiene contra qué medirse. Las otras
       dos pantallas del módulo ya lo declaran; ésta se había quedado afuera. */
    :host { display:block; }
    .fm { min-height:100vh; display:flex; flex-direction:column; gap:var(--sp-4);
          padding:var(--sp-4); max-width:32rem; margin:0 auto; }
    .fm h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.02em; }
    .fm-sub { margin:0; font-size:var(--fs-sm); color:var(--text-muted); }
    .fm-que { display:flex; flex-direction:column; gap:var(--sp-1);
              padding:var(--sp-3); border:1px solid var(--border-color);
              border-radius:var(--r-md); background:var(--card-bg); }
    .fm-monto { font-size:var(--fs-display); font-weight:700; letter-spacing:-.03em;
                line-height:1; font-variant-numeric:tabular-nums; }
    .fm-quien { font-size:var(--fs-h3); font-weight:700; }
    .fm-doc { font-family:var(--font-mono); font-size:var(--fs-xs); color:var(--text-muted); }
    /* ⛔ touch-action:none es lo que impide que el dedo SCROLLEE en vez de dibujar. Sin esto, en
       un teléfono la firma es imposible: el gesto se lo come la página. */
    .fm-pad { width:100%; height:14rem; touch-action:none; background:#FFFFFF;
              border:1px dashed var(--border-color); border-radius:var(--r-md); }
    .fm-acciones { display:flex; gap:var(--sp-2); }
    .fm-acciones > * { flex:1 1 auto; }
    .fm-legal { font-size:var(--fs-xs); color:var(--text-muted); line-height:1.45; }
    .fm-listo { display:flex; flex-direction:column; align-items:flex-start; gap:var(--sp-2);
                padding:var(--sp-6) var(--sp-2); color:var(--text-muted); }
    .fm-listo i { font-size:var(--fs-h1); color:var(--ok-soft-fg); }
    .fm-listo strong { color:var(--fg-1); font-size:var(--fs-h3); }
  `],
  template: `
    <div class="fm">
      <header>
        <h1>Firmar un movimiento de caja</h1>
        <p class="fm-sub">{{ ctx() ? 'Firma donde dice, y toca Enviar.' : 'Escanea el QR que muestra la caja.' }}</p>
      </header>

      @if (aviso(); as a) { <p-message severity="warn">{{ a }}</p-message> }

      @if (enviada()) {
        <!-- Vacío operacional: NO centrado, y dice qué pasó y qué sigue. Se llega acá SOLO con el
             acuse del servidor: antes decía enviada con la firma todavía en el aire. -->
        <div class="fm-listo">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <strong>Firma enviada</strong>
          <p>Ya está en la pantalla de la caja. Puedes devolver el teléfono.</p>
        </div>
      } @else if (ctx(); as c) {
        <!-- ⭐ QUÉ se está firmando, antes de firmar. Una firma sobre algo que no se leyó no es
             conformidad: es un trámite. -->
        <div class="fm-que">
          <span class="lbl">{{ c.tipo === 'gasto' ? 'Recibes de la caja' : 'Movimiento de caja' }}</span>
          <span class="fm-monto">{{ money(c.monto) }}</span>
          @if (c.beneficiario) { <span class="fm-quien">{{ c.beneficiario }}</span> }
          @if (c.documento) { <span class="fm-doc">{{ c.documento }}</span> }
        </div>

        <canvas #pad class="fm-pad"
                (pointerdown)="abajo($event)" (pointermove)="mueve($event)"
                (pointerup)="arriba()" (pointerleave)="arriba()"
                aria-label="Firma acá con el dedo"></canvas>

        <input type="text" pInputText [(ngModel)]="nombre" placeholder="Tu nombre"
               maxlength="120" aria-label="Nombre de quien firma" />

        <div class="fm-acciones">
          <p-button label="Borrar" icon="pi pi-eraser" severity="secondary" [text]="true"
                    [disabled]="!hecha() || enviando()" (onClick)="limpiar()"></p-button>
          <!-- Con loading: pone el spinner Y desactiva, que es lo que impide el segundo toque. -->
          <p-button label="Enviar" icon="pi pi-send" [loading]="enviando()"
                    [disabled]="!hecha() || enviando()" (onClick)="enviar()"></p-button>
        </div>
        @if (reintentando(); as n) {
          <p class="fm-sub">Sin señal: reintentando el envío ({{ n }} de {{ maxIntentos }})… No cierres esta pantalla.</p>
        }

        <p class="fm-legal">Vale como constancia de que recibiste el efectivo, igual que firmar el
          ticket en papel. No es una firma electrónica con validez fiscal.</p>
      } @else if (!token) {
        <!-- ⭐⭐ CG.207 SOLO EL QR. Sin el token del QR esta pantalla no tiene nada que hacer, y lo
             dice. (Sin acentos graves aca adentro: esto vive en un template literal y uno lo CIERRA.) -->
        <p class="fm-sub">Abre la cámara del teléfono y apunta al QR que muestra la pantalla de la
          caja. No hace falta iniciar sesión.</p>
      } @else if (cargando()) {
        <p class="fm-sub">Abriendo el pedido de la caja…</p>
      } @else if (aviso() && reintentable()) {
        <p-button label="Reintentar" icon="pi pi-refresh" severity="secondary" [outlined]="true"
                  (onClick)="abrir()"></p-button>
      }
    </div>
  `,
})
export class FinanzasCajaFirmaComponent implements OnInit {
  private readonly api = inject(CajaFirmaApiService);

  @ViewChild('pad') padRef?: ElementRef<HTMLCanvasElement>;
  private firma: FirmaCanvas | null = null;
  private firmaEl: HTMLCanvasElement | null = null;

  /** El token del QR (`?t=`). Sin él no hay nada que firmar. */
  token = '';
  nombre = '';
  readonly ctx = signal<ContextoFirma | null>(null);
  readonly cargando = signal(false);
  readonly enviando = signal(false);
  readonly enviada = signal(false);
  readonly aviso = signal<string | null>(null);
  /** El último fallo fue de red: tiene sentido ofrecer Reintentar. Uno del servidor, no. */
  readonly reintentable = signal(false);
  /** Número de reintento de envío en curso, o `null`. Se DICE: un spinner mudo parece colgado. */
  readonly reintentando = signal<number | null>(null);
  /** Señal y no el primitivo: el primitivo no es reactivo y la plantilla no se enteraría. */
  readonly hecha = signal(false);

  /** Techo de reintentos y espera entre ellos. Ver `[CG.204]`: sin techo, gira para siempre. */
  readonly maxIntentos = 6;
  /** Inyectable para las pruebas: el reloj real haría esperar ~30 s a cada caso. */
  esperaMs = (intento: number): number => Math.min(8000, 1000 * 2 ** (intento - 1));

  /** El id de ESTE teléfono: lo que permite volver (bloqueo, recarga) sin contar como otro. */
  readonly telefono = idDeTelefono();

  readonly money = (v: number) =>
    (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

  ngOnInit(): void {
    this.token = new URLSearchParams(location.search).get('t') ?? '';
    if (this.token) void this.abrir();
  }

  /** Abre el pedido del QR. Si no hay red, reintenta solo; si el servidor dice que no, lo dice. */
  async abrir(): Promise<void> {
    this.aviso.set(null);
    this.reintentable.set(false);
    this.cargando.set(true);
    try {
      for (let intento = 1; ; intento++) {
        const r = await this.api.ver(this.token, this.telefono);
        if (r.ok) {
          // El mismo teléfono que ya firmó (volvió a abrir el QR): ya quedó, no se pide otra firma.
          if (r.v.estado === 'firmada') { this.enviada.set(true); return; }
          this.ctx.set(r.v.contexto);
          return;
        }
        if (r.fallo !== 'red' || intento >= this.maxIntentos) {
          this.aviso.set(r.fallo === 'red'
            ? 'No hay conexión con el servidor. Revisa la señal del teléfono y toca Reintentar.'
            : textoFalloFirma(r.fallo));
          this.reintentable.set(r.fallo === 'red');
          return;
        }
        await dormir(this.esperaMs(intento));
      }
    } finally {
      this.cargando.set(false);
    }
  }

  /**
   * ⭐ `[CG.204]` Envía y **no se rinde por la red**: reintenta con espera creciente hasta el techo,
   * diciendo en qué intento va. El trazo se conserva entre intentos. «Enviada» sólo con acuse.
   */
  async enviar(): Promise<void> {
    const png = this.pad()?.aPng();
    // ⚠️ Se vuelve a preguntar al primitivo en vez de confiar en la señal: entre que se habilitó
    // el botón y el toque pudo pasar un "Borrar".
    if (!png) { this.aviso.set('Todavía no hay firma. Firma en el recuadro blanco.'); return; }
    this.aviso.set(null);
    this.enviando.set(true);
    try {
      for (let intento = 1; ; intento++) {
        const r = await this.api.firmar(this.token, this.telefono, png, this.nombre.trim() || null);
        if (r.ok) { this.enviada.set(true); return; }
        if (r.fallo !== 'red') { this.aviso.set(textoFalloFirma(r.fallo)); return; }
        if (intento >= this.maxIntentos) {
          this.aviso.set('No se pudo enviar: no hay señal. Tu firma sigue acá; toca Enviar cuando vuelva la señal.');
          return;
        }
        this.reintentando.set(intento);
        await dormir(this.esperaMs(intento));
      }
    } finally {
      this.reintentando.set(null);
      this.enviando.set(false);
    }
  }

  /**
   * ⛔ Se re-prepara cuando el `<canvas>` cambia de identidad: el `@if` lo destruye y lo re-crea,
   * y un pad apuntando a un canvas desprendido dibuja en la nada — la persona firma, no ve nada,
   * y se manda una firma vacía.
   */
  private pad(): FirmaCanvas | null {
    const c = this.padRef?.nativeElement;
    if (!c) return null;
    if (!this.firma || this.firmaEl !== c) { this.firma = prepararFirma(c); this.firmaEl = c; }
    return this.firma;
  }

  abajo(ev: PointerEvent): void { this.pad()?.abajo(ev.offsetX, ev.offsetY); }
  mueve(ev: PointerEvent): void {
    const p = this.pad();
    if (!p) return;
    p.mueve(ev.offsetX, ev.offsetY);
    if (p.firmada() !== this.hecha()) this.hecha.set(p.firmada());
  }
  arriba(): void {
    const p = this.pad();
    if (!p) return;
    p.arriba();
    this.hecha.set(p.firmada());
  }
  limpiar(): void { this.pad()?.limpiar(); this.hecha.set(false); }
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Un id estable por teléfono, guardado en el navegador. ⚠️ No es una credencial: sólo distingue
 * «el mismo teléfono que vuelve» de «otro teléfono». Si el navegador no deja guardar (modo
 * privado), vive en memoria: volver del bloqueo sigue funcionando; recargar cuenta como otro.
 */
function idDeTelefono(): string {
  const CLAVE = 'caja.firma.telefono';
  try {
    const previo = localStorage.getItem(CLAVE);
    if (previo && /^[A-Za-z0-9_-]{8,64}$/.test(previo)) return previo;
  } catch { /* sin almacenamiento */ }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = 'tel_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(CLAVE, id); } catch { /* sin almacenamiento: queda en memoria */ }
  return id;
}
