import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { prepararFirma, type FirmaCanvas } from '@megadulces/ui-web';
import type { ContextoFirma } from '@megadulces/contracts';
import { CajaSocketService } from '../../caja-socket.service';

/**
 * `[CG.68]` **La pantalla del teléfono del mostrador: acá se firma.**
 *
 * Edgar: *"si esto lo estoy usando en pc, ¿cómo hago que esto se envíe a mi teléfono para que se
 * firme?"*. La caja muestra un código de seis caracteres; acá se teclea, aparece QUÉ se está
 * firmando, se firma, y el trazo vuelve a la pantalla de la caja por una room que es de los dos.
 *
 * ── Por qué es una PÁGINA de esta app y no una superficie nueva ──────────────────────────────
 *
 * El teléfono es **del mostrador** (decisión de Edgar) y entra con su propio usuario, así que no
 * hace falta ninguna superficie pública, ni enlaces con token, ni QR — y no se agrega ninguna.
 * Es la regla del proyecto: *una superficie nueva es un MÓDULO o una PÁGINA dentro de una app del
 * monorepo, nunca un artefacto suelto.*
 *
 * ── ⚠️ Lo que esta pantalla NO puede hacer, a propósito ─────────────────────────────────────
 *
 * No lee la caja, no lista movimientos y no guarda nada. Ve **cuatro datos** del movimiento
 * (tipo, monto, beneficiario, documento) y manda un PNG. El teléfono se le pasa a otras personas
 * para que firmen: todo lo que esta pantalla pueda mostrar, lo va a ver quien firma. Por eso el
 * servidor la atiende con permiso de **lectura** (`FINANCE_CAJA_VER`), no de gestión.
 */
@Component({
  selector: 'app-finanzas-caja-firma',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, MessageModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .fm { min-height:100vh; display:flex; flex-direction:column; gap:var(--sp-4);
          padding:var(--sp-4); max-width:32rem; margin:0 auto; }
    .fm h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.02em; }
    .fm-sub { margin:0; font-size:var(--fs-sm); color:var(--text-muted); }
    /* El código se teclea mirando otra pantalla: campo grande, mono y espaciado. */
    .fm-cod { font-family:var(--font-mono); font-size:var(--fs-h1); letter-spacing:.18em;
              text-align:center; text-transform:uppercase; }
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
        <p class="fm-sub">{{ ctx() ? 'Firmá donde dice, y tocá Enviar.' : 'Escribí el código que muestra la caja.' }}</p>
      </header>

      @if (aviso(); as a) { <p-message severity="warn">{{ a }}</p-message> }

      @if (enviada()) {
        <!-- Vacío operacional: NO centrado, y dice qué pasó y qué sigue. -->
        <div class="fm-listo">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <strong>Firma enviada</strong>
          <p>Ya está en la pantalla de la caja. Podés devolver el teléfono.</p>
          <p-button label="Firmar otro" icon="pi pi-replay" size="small" severity="secondary"
                    [outlined]="true" (onClick)="reiniciar()"></p-button>
        </div>
      } @else if (ctx(); as c) {
        <!-- ⭐ QUÉ se está firmando, antes de firmar. Una firma sobre algo que no se leyó no es
             conformidad: es un trámite. -->
        <div class="fm-que">
          <span class="lbl">{{ c.tipo === 'gasto' ? 'Recibís de la caja' : 'Movimiento de caja' }}</span>
          <span class="fm-monto">{{ money(c.monto) }}</span>
          @if (c.beneficiario) { <span class="fm-quien">{{ c.beneficiario }}</span> }
          @if (c.documento) { <span class="fm-doc">{{ c.documento }}</span> }
        </div>

        <canvas #pad class="fm-pad"
                (pointerdown)="abajo($event)" (pointermove)="mueve($event)"
                (pointerup)="arriba()" (pointerleave)="arriba()"
                aria-label="Firmá acá con el dedo"></canvas>

        <input type="text" pInputText [(ngModel)]="nombre" placeholder="Tu nombre"
               maxlength="120" aria-label="Nombre de quien firma" />

        <div class="fm-acciones">
          <p-button label="Borrar" icon="pi pi-eraser" severity="secondary" [text]="true"
                    [disabled]="!hecha()" (onClick)="limpiar()"></p-button>
          <p-button label="Enviar" icon="pi pi-send"
                    [disabled]="!hecha() || enviando()" (onClick)="enviar()"></p-button>
        </div>

        <p class="fm-legal">Vale como constancia de que recibiste el efectivo, igual que firmar el
          ticket en papel. No es una firma electrónica con validez fiscal.</p>
      } @else {
        <input type="text" pInputText class="fm-cod" [(ngModel)]="codigo"
               placeholder="ABC234" maxlength="9" autocomplete="off"
               inputmode="text" aria-label="Código que muestra la caja"
               (keyup.enter)="tomar()" />
        <p-button label="Continuar" icon="pi pi-arrow-right"
                  [disabled]="codigo.trim().length < 6 || tomando()" (onClick)="tomar()"></p-button>
        @if (!caja.connected()) {
          <p-message severity="warn">Sin conexión con el servidor. Revisá la red del teléfono.</p-message>
        }
      }
    </div>
  `,
})
export class FinanzasCajaFirmaComponent implements OnInit, OnDestroy {
  readonly caja = inject(CajaSocketService);

  @ViewChild('pad') padRef?: ElementRef<HTMLCanvasElement>;
  private firma: FirmaCanvas | null = null;
  private firmaEl: HTMLCanvasElement | null = null;

  codigo = '';
  nombre = '';
  readonly ctx = signal<ContextoFirma | null>(null);
  readonly tomando = signal(false);
  readonly enviando = signal(false);
  readonly enviada = signal(false);
  readonly aviso = signal<string | null>(null);
  /** Señal y no el primitivo: el primitivo no es reactivo y la plantilla no se enteraría. */
  readonly hecha = signal(false);

  readonly money = (v: number) =>
    (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

  ngOnInit(): void { this.caja.connect(); }
  ngOnDestroy(): void { this.caja.disconnect(); }

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

  async tomar(): Promise<void> {
    this.aviso.set(null);
    this.tomando.set(true);
    try {
      const tecleado = this.codigo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = await this.caja.tomarFirma(tecleado);
      if (!r.ok || !('ctx' in r) || !r.ctx) { this.aviso.set(this.textoFallo(String((r as { error?: string }).error ?? ''))); return; }
      this.ctx.set(r.ctx);
      // ⛔ Se GUARDA el código: `enviar()` lo necesita para entregar, y el campo se limpia acá.
      // Sin esta línea el envío salía con el código vacío y el servidor lo rechazaba como
      // `no_existe` — con la firma ya hecha y la persona esperando.
      this.codigoVivo = tecleado;
      this.codigo = '';
    } finally { this.tomando.set(false); }
  }

  async enviar(): Promise<void> {
    const p = this.pad();
    const png = p?.aPng();
    // ⚠️ Se vuelve a preguntar al primitivo en vez de confiar en la señal: entre que se habilitó
    // el botón y el toque pudo pasar un "Borrar".
    if (!png) { this.aviso.set('Todavía no hay firma. Firmá en el recuadro blanco.'); return; }
    this.aviso.set(null);
    this.enviando.set(true);
    try {
      // El código ya no está en el campo: lo guarda el vínculo del lado del servidor, pero el
      // mensaje lo pide igual, así que se reusa el que vino con el contexto.
      const r = await this.caja.enviarFirma(this.codigoVivo, png, this.nombre.trim() || null);
      if (!r.ok) { this.aviso.set(this.textoFallo(String((r as { error?: string }).error ?? ''))); return; }
      this.enviada.set(true);
    } finally { this.enviando.set(false); }
  }

  reiniciar(): void {
    this.ctx.set(null);
    this.enviada.set(false);
    this.nombre = '';
    this.codigo = '';
    this.codigoVivo = '';
    this.limpiar();
  }

  /** El código con el que se reclamó, para poder entregar. */
  private codigoVivo = '';

  private textoFallo(e: string): string {
    switch (e) {
      // ⭐ `vencido` y `no_existe` son DOS cosas y la persona tiene que oír cosas distintas:
      // una se arregla pidiendo otro código, la otra revisando lo que tecleó.
      case 'vencido': return 'El código ya venció. Pedile uno nuevo a la caja.';
      case 'no_existe': return 'Ese código no existe. Revisá lo que escribiste.';
      case 'ya_tomado': return 'Ese código ya lo está usando otro teléfono.';
      case 'otro_tenant': return 'Ese código no es de esta empresa.';
      case 'no_es_suyo': return 'Este teléfono no es el que tomó el código.';
      case 'no_es_firma': return 'La firma no se pudo leer. Borrá y firmá de nuevo.';
      case 'sin_conexion': return 'Sin conexión con el servidor. Revisá la red del teléfono.';
      case 'sin_respuesta': return 'El servidor no contestó. Probá de nuevo.';
      default: return 'No se pudo continuar. Probá de nuevo.';
    }
  }
}
