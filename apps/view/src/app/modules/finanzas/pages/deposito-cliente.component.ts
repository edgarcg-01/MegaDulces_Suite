import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { DepositoClienteService, ContextoDeposito, ArchivoSubido, FichaEnviada } from '../deposito-cliente.service';

/** Monto como lo teclean: «12,500.00», «$12500» o «12500». null si no es un número positivo (Postel: forma sí, significado no). */
export function leerMonto(t: string | number | null | undefined): number | null {
  const limpio = String(t ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
  const n = Number(limpio);
  return n > 0 ? n : null;
}

/** Fecha de hoy en México (AAAA-MM-DD). */
const hoyMx = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

/**
 * Reduce una foto a 1600 px por lado (JPEG 0.82) antes de subirla: una foto de celular pasa de ~4 MB a ~0.3 MB, que
 * es lo que importa con datos móviles. Un PDF va tal cual. Misma regla que `CameraShotComponent.recomprimir`
 * (⬜ deuda con nombre: dos copias de la reducción; sube a `shared/` si aparece una tercera).
 */
function reducir(dataUri: string, maxLado = 1600): Promise<string> {
  if (!dataUri.startsWith('data:image/')) return Promise.resolve(dataUri);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
      const ctx = c.getContext('2d');
      if (!ctx) { resolve(dataUri); return; }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

/**
 * `[CC.20]` **El cliente sube su ficha de depósito desde su celular.** Edgar, 2026-11-17: «lo más práctico y lo más
 * fácil posible». Llega por un enlace personal (WhatsApp o el QR del estado de cuenta), sin usuario ni contraseña.
 *
 * Cuestionario de diseño (skill `diseno` §0b):
 *  1. **Qué ve primero:** su nombre y UN botón grande para subir la foto. Si le rechazaron una ficha, eso va arriba,
 *     con el motivo: enterarse es más urgente que subir otra.
 *  2. **Qué no ve:** saldos, facturas ni nada de otra cuenta (el enlace se puede reenviar). Ni menús ni la Suite.
 *  3. **Accesibilidad:** tres toques (foto → revisar → enviar). La Suite LEE monto y fecha de la ficha y los propone;
 *     el teclado del monto es el numérico; botones de 48 px; todo con texto, nada sólo por color.
 *  4. **Ligado a:** la bandeja de Cobranza (`/finanzas/cobranza`) y la ficha del cliente en Cartera.
 *  5. **¿Le toca?** Sí: es el único lugar donde el cliente hace algo.
 */
@Component({
  selector: 'app-deposito-cliente',
  standalone: true,
  imports: [FormsModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="dc">
      <header class="dc-head">
        <span class="dc-marca">Mega Dulces</span>
        <span class="dc-sub">Crédito y Cobranza</span>
      </header>

      <!-- Los tres estados con la pieza del sistema: abriendo · no se pudo (con el porqué y «Reintentar») · la página. -->
      <app-load-state [loading]="cargando()" [error]="muerto()" errorTitle="Este enlace no se puede usar" [skeletonRows]="4" (retry)="recargar()">
      @if (ctx(); as c) {
        <h1 class="dc-hola">Hola, {{ c.cliente }}</h1>

        @if (rechazadas().length) {
          <section class="dc-card dc-rech" role="alert">
            <h2>Revisa {{ rechazadas().length === 1 ? 'esta ficha' : 'estas fichas' }}</h2>
            @for (f of rechazadas(); track f.id) {
              <p><b>{{ money(f.monto) }}</b> del {{ fechaCorta(f.fecha) }}: {{ f.motivo_rechazo }}</p>
            }
          </section>
        }

        @switch (paso()) {
          @case ('elegir') {
            <section class="dc-card">
              <p class="dc-intro">Sube la foto de tu ficha de depósito o la captura de tu transferencia. Nosotros la revisamos y la aplicamos a tu cuenta.</p>
              <label class="dc-btn dc-btn-main">
                <input type="file" accept="image/*,application/pdf" (change)="elegido($event)" class="dc-file" />
                Subir mi ficha
              </label>
              <p class="dc-hint">Puedes tomar la foto ahora o elegirla de tu galería. También sirve un PDF.</p>
            </section>
          }
          @case ('revisar') {
            <section class="dc-card">
              @if (vista(); as v) {
                @if (esPdf()) { <p class="dc-pdf">PDF listo para enviar</p> }
                @else { <img [src]="v" alt="Tu ficha de depósito" class="dc-foto" /> }
              }
              @if (leyendo()) {
                <p class="dc-estado" role="status">Leyendo tu ficha…</p>
              } @else {
                <p class="dc-hint">{{ leida() ? 'Leímos tu ficha. Revisa que esté bien.' : 'Escribe el monto y la fecha de tu depósito.' }}</p>
              }
              <label class="dc-campo">
                <span>Monto depositado</span>
                <input type="text" inputmode="decimal" autocomplete="off" [(ngModel)]="montoTxt" placeholder="0.00" aria-label="Monto depositado" />
              </label>
              <label class="dc-campo">
                <span>Fecha del depósito</span>
                <input type="date" [(ngModel)]="fecha" [max]="hoy" aria-label="Fecha del depósito" />
              </label>
              <label class="dc-campo">
                <span>Nota (opcional)</span>
                <input type="text" [(ngModel)]="nota" maxlength="200" placeholder="Por ejemplo: pago de la factura 4820" aria-label="Nota" />
              </label>
              @if (error(); as e) { <p class="dc-error" role="alert">{{ e }}</p> }
              <button type="button" class="dc-btn dc-btn-main" [disabled]="!puedeEnviar()" (click)="enviar()">
                {{ enviando() ? 'Enviando…' : (subiendo() ? 'Subiendo la foto…' : 'Enviar') }}
              </button>
              <button type="button" class="dc-btn dc-btn-sec" [disabled]="enviando()" (click)="reiniciar()">Cambiar foto</button>
            </section>
          }
          @case ('listo') {
            <section class="dc-card dc-ok" role="status">
              <h2>¡Listo! Recibimos tu ficha</h2>
              <p>{{ money(montoEnviado()) }} del {{ fechaCorta(fechaEnviada()) }}. Crédito y Cobranza la revisa y la aplica a tu cuenta. Aquí mismo verás cuando quede aplicada.</p>
              @if (yaEstaba()) { <p class="dc-hint">Esta ficha ya la habías enviado: no se duplicó.</p> }
              <button type="button" class="dc-btn dc-btn-sec" (click)="reiniciar()">Subir otra ficha</button>
            </section>
          }
        }

        <!-- [CC.20.2] El PDF que el mensaje de WhatsApp no puede llevar: el mismo documento que imprime Cobranza. -->
        <a class="dc-btn dc-btn-sec dc-ec" [href]="pdfUrl" target="_blank" rel="noopener" data-testid="estado-cuenta-pdf">
          Descargar mi estado de cuenta (PDF)
        </a>

        @if (c.fichas.length) {
          <section class="dc-hist">
            <h2>Tus fichas enviadas</h2>
            <ul>
              @for (f of c.fichas; track f.id) {
                <li>
                  <span><b>{{ money(f.monto) }}</b> · {{ fechaCorta(f.fecha) }}</span>
                  <span class="dc-chip" [class.dc-chip-ok]="f.status === 'validado'" [class.dc-chip-bad]="f.status === 'rechazado'">{{ estadoTexto(f) }}</span>
                </li>
              }
            </ul>
          </section>
        }
        <p class="dc-pie">¿Dudas? Llama a Crédito y Cobranza o a tu vendedor.</p>
      }
      </app-load-state>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--surface-ground, var(--layout-bg)); color: var(--text-main); }
    .dc { max-width: 30rem; margin: 0 auto; padding: var(--sp-4) var(--sp-4) var(--sp-8); }
    .dc-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--sp-4); }
    .dc-marca { font-weight: 700; font-size: var(--fs-lg, 1.125rem); }
    .dc-sub { font-size: var(--fs-sm); color: var(--text-muted); }
    .dc-hola { font-size: var(--fs-xl, 1.25rem); font-weight: 700; margin: 0 0 var(--sp-3); }
    .dc-card { background: var(--surface-card); border: 1px solid var(--border-color); border-radius: var(--r-lg, 12px); padding: var(--sp-4); margin-bottom: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .dc-card h1, .dc-card h2 { margin: 0; font-size: var(--fs-body); font-weight: 700; }
    .dc-card p { margin: 0; line-height: 1.45; }
    .dc-intro { font-size: var(--fs-body); }
    .dc-hint { font-size: var(--fs-sm); color: var(--text-muted); }
    .dc-estado { font-size: var(--fs-sm); color: var(--text-muted); }
    .dc-btn { display: flex; align-items: center; justify-content: center; min-height: 48px; border-radius: var(--r-md, 8px); font: inherit; font-weight: 700; cursor: pointer; position: relative; width: 100%; }
    .dc-btn:focus-visible, .dc-campo input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .dc-btn-main { background: var(--action); color: var(--action-fg, #fff); border: 0; font-size: var(--fs-body); }
    .dc-btn-main[disabled] { opacity: .55; cursor: default; }
    .dc-btn-sec { background: transparent; color: var(--text-main); border: 1px solid var(--border-color); }
    .dc-file { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .dc-foto { width: 100%; max-height: 18rem; object-fit: contain; border-radius: var(--r-md, 8px); background: var(--surface-2); }
    .dc-pdf { padding: var(--sp-3); background: var(--surface-2); border-radius: var(--r-md, 8px); text-align: center; }
    .dc-campo { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-muted); }
    .dc-campo input { min-height: 48px; font-size: 16px; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); background: var(--surface-card); color: var(--text-main); }
    .dc-error { color: var(--bad-soft-fg); background: var(--bad-soft-bg); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md, 8px); font-size: var(--fs-sm); }
    .dc-rech { border-color: var(--bad-border); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .dc-ok { border-color: var(--ok-border); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .dc-hist h2 { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-2); font-weight: 700; }
    .dc-hist ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .dc-hist li { display: flex; justify-content: space-between; gap: var(--sp-2); align-items: center; font-size: var(--fs-sm); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .dc-chip { font-size: var(--fs-xs); padding: 2px 8px; border-radius: var(--r-pill, 999px); background: var(--surface-2); color: var(--text-main); white-space: nowrap; }
    .dc-chip-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .dc-chip-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .dc-ec { margin-bottom: var(--sp-6); text-decoration: none; }
    .dc-ec:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .dc-pie { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); text-align: center; }
  `],
})
export class DepositoClienteComponent {
  private readonly svc = inject(DepositoClienteService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly token = this.route.snapshot.paramMap.get('token') || '';
  /** `[CC.20.2]` Su estado de cuenta en PDF, autorizado por el mismo enlace. */
  readonly pdfUrl = this.svc.estadoCuentaUrl(this.token);
  readonly hoy = hoyMx();

  readonly cargando = signal(true);
  readonly muerto = signal<string | null>(null);
  readonly ctx = signal<ContextoDeposito | null>(null);
  readonly paso = signal<'elegir' | 'revisar' | 'listo'>('elegir');

  readonly vista = signal<string | null>(null);
  readonly esPdf = signal(false);
  readonly subiendo = signal(false);
  readonly leyendo = signal(false);
  readonly leida = signal(false);
  readonly enviando = signal(false);
  readonly error = signal<string | null>(null);
  private archivo: ArchivoSubido | null = null;

  montoTxt = '';
  fecha = this.hoy;
  nota = '';

  readonly montoEnviado = signal<number | null>(null);
  readonly fechaEnviada = signal<string | null>(null);
  readonly yaEstaba = signal(false);

  readonly rechazadas = computed(() => (this.ctx()?.fichas || []).filter((f) => f.status === 'rechazado').slice(0, 3));

  constructor() { this.cargar(); }

  recargar(): void { this.cargando.set(true); this.muerto.set(null); this.cargar(); }

  private cargar(): void {
    if (!this.token) { this.cargando.set(false); this.muerto.set('El enlace está incompleto. Ábrelo de nuevo desde el mensaje que te mandamos.'); return; }
    this.svc.contexto(this.token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.ctx.set(c); this.cargando.set(false); },
      error: (e) => {
        this.cargando.set(false);
        this.muerto.set(e?.status === 403 ? (e?.error?.message || 'Este enlace ya no sirve.') : 'No se pudo abrir. Revisa tu señal y vuelve a intentar.');
      },
    });
  }

  /** Eligió una foto o PDF: se reduce, se sube y se lee AL MISMO TIEMPO; los campos se llenan con lo leído. */
  elegido(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024 && file.type === 'application/pdf') { this.error.set('El PDF es muy grande (máximo 8 MB).'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      reducir(String(reader.result || '')).then((dataUri) => this.procesar(dataUri));
    };
    reader.readAsDataURL(file);
  }

  private procesar(dataUri: string): void {
    this.error.set(null); this.archivo = null; this.leida.set(false);
    this.esPdf.set(dataUri.startsWith('data:application/pdf'));
    this.vista.set(dataUri);
    this.paso.set('revisar');
    this.subiendo.set(true); this.leyendo.set(true);
    forkJoin({ sub: this.svc.subir(this.token, dataUri), lec: this.svc.leer(this.token, dataUri) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: ({ sub, lec }) => {
          this.archivo = { ...sub, sha256: lec.sha256 };
          this.subiendo.set(false); this.leyendo.set(false);
          // La lectura PROPONE; lo que el cliente ya escribió no se pisa.
          if (lec.monto != null && !this.montoTxt.trim()) this.montoTxt = Number(lec.monto).toFixed(2);
          if (lec.fecha && /^\d{4}-\d{2}-\d{2}$/.test(lec.fecha) && lec.fecha <= this.hoy) this.fecha = lec.fecha;
          this.leida.set(lec.monto != null || !!lec.fecha);
        },
        error: (e) => {
          this.subiendo.set(false); this.leyendo.set(false);
          this.error.set(e?.error?.message || 'No se pudo subir la foto. Revisa tu señal y vuelve a intentar.');
        },
      });
  }

  readonly puedeEnviar = (): boolean => !this.enviando() && !this.subiendo() && !!this.archivo && leerMonto(this.montoTxt) != null && !!this.fecha;

  enviar(): void {
    const monto = leerMonto(this.montoTxt);
    if (!this.archivo || monto == null || !this.fecha || this.enviando()) return;
    this.enviando.set(true); this.error.set(null);
    this.svc.enviar(this.token, { files: [this.archivo], monto, fecha: this.fecha, nota: this.nota.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.enviando.set(false);
          this.montoEnviado.set(monto); this.fechaEnviada.set(this.fecha); this.yaEstaba.set(!!r.ya_estaba);
          this.paso.set('listo');
          this.svc.contexto(this.token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (c) => this.ctx.set(c), error: () => undefined });
        },
        // Lo capturado se queda: se puede reintentar sin volver a tomar la foto.
        error: (e) => { this.enviando.set(false); this.error.set(e?.error?.message || 'No se pudo enviar. Revisa tu señal y vuelve a intentar.'); },
      });
  }

  reiniciar(): void {
    this.paso.set('elegir'); this.vista.set(null); this.archivo = null; this.error.set(null);
    this.montoTxt = ''; this.fecha = this.hoy; this.nota = ''; this.leida.set(false);
  }

  estadoTexto(f: FichaEnviada): string {
    if (f.status === 'validado') return 'Aplicada';
    if (f.status === 'rechazado') return 'Rechazada';
    return 'Por revisar';
  }
  money(v: number | null | undefined): string {
    return v == null ? '—' : Number(v).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  fechaCorta(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  }
}
