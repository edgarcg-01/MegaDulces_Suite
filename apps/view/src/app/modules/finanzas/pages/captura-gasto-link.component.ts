import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { CapturaGastoService, CapturaContext, CapturaMia, LecturaTicket } from '../captura-gasto.service';
import { CameraShotComponent } from '../components/camera-shot.component';
import { ProofFile, ProofFileRole, ExpenseClasificacion, requiereEvidencia } from '../comprobaciones.service';
import { money } from '../../../shared/util';
import { dmy } from './finanzas-format';

/** Una foto pendiente de subir, con lo que hace falta para mostrarla y mandarla. */
interface Toma { role: ProofFileRole; dataUri: string; camera: 'live' | 'file'; }

/**
 * GX.9 — la pantalla que ve el trabajador en el celular. Pública: sin cuenta, sin sesión,
 * autorizada por el token del link.
 *
 * Existe porque el orden real de los hechos era al revés del que el sistema aceptaba: se
 * recibe la solicitud firmada en papel, se gasta, se juntan tickets — y recién después
 * alguien en oficina lo captura en Kepler. Antes la evidencia se quedaba en el celular
 * esperando que existiera un folio. Acá se entrega en el momento, y el folio se le pone
 * después en oficina (ver la bandeja "Sin folio").
 *
 * Tres decisiones que gobiernan la pantalla:
 *   · **Una tarea por vez.** Es un celular en la calle, a una mano, con datos móviles: las
 *     fotos primero (que es lo que se pierde), los datos después.
 *   · **Lo devuelto va ARRIBA de todo.** Si a alguien le rechazaron un ticket, enterarse es
 *     más urgente que capturar el siguiente — y este link es el único lugar donde puede.
 *   · **Nada de la empresa.** No lista gastos ajenos ni toca Kepler: sólo lo que subió este
 *     mismo link.
 */
@Component({
  selector: 'app-captura-gasto-link',
  standalone: true,
  imports: [CommonModule, FormsModule, CameraShotComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cg">
      @if (cargando()) {
        <div class="cg-boot"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Abriendo…</div>
      } @else if (muerto()) {
        <!-- Link vencido o dado de baja. Sin jerga y con la salida real: pedir otro. -->
        <div class="cg-dead" role="alert">
          <i class="pi pi-lock" aria-hidden="true"></i>
          <h1>{{ muerto() }}</h1>
          <p>Pídele a tu jefe o a Finanzas que te mande un link nuevo.</p>
        </div>
      } @else if (ctx(); as c) {
        <header class="cg-head">
          <div>
            <p class="cg-eyebrow">Gastos · Mega Dulces</p>
            <h1>Hola, {{ primerNombre(c.persona) }}</h1>
          </div>
        </header>

        @if (enviado()) {
          <!-- Acuse. Lo único que importa acá es que sepa que llegó y qué sigue. -->
          <div class="cg-ok" role="status">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <h2>Listo, ya lo recibimos</h2>
            <p>Lo va a revisar Finanzas. Si falta algo te lo devuelven y lo vas a ver acá mismo.</p>
            <button type="button" class="cg-btn" (click)="otro()">Subir otro gasto</button>
          </div>
        } @else {

          <!-- ── Lo devuelto, antes que nada ──────────────────────────────── -->
          @if (devueltas().length) {
            <section class="cg-back" aria-label="Gastos que te devolvieron">
              <h2 class="cg-back-t"><i class="pi pi-replay" aria-hidden="true"></i>
                Te devolvieron {{ devueltas().length }} {{ devueltas().length === 1 ? 'gasto' : 'gastos' }}</h2>
              @for (d of devueltas(); track d.id) {
                <div class="cg-back-i">
                  <div class="cg-back-h">
                    <strong>{{ d.proveedor }}</strong>
                    <span class="cg-num">{{ money(d.importe) }}</span>
                  </div>
                  <p class="cg-back-why">{{ d.motivo_rechazo || 'Hay que corregirlo.' }}</p>
                </div>
              }
              <p class="cg-back-how">Súbelo de nuevo con la corrección, aquí abajo.</p>
            </section>
          }

          <!-- ── Paso 1: el tipo ──────────────────────────────────────────────
               Va PRIMERO porque decide los dos pasos que siguen: si hay ticket que
               fotografiar, y si hay que explicar por qué no lo hay. Estaba abajo, y así
               nadie podía saber qué fotografiar antes de contestarlo. -->
          <section class="cg-sec">
            <h2 class="cg-sec-t"><span class="cg-step">1</span> ¿Qué tipo de gasto es?</h2>
            <div class="cg-seg" role="radiogroup" aria-label="Tipo de gasto">
              @for (o of clasOpts; track o.value) {
                <button type="button" role="radio" [attr.aria-checked]="clasificacion() === o.value"
                        class="cg-seg-b" [class.on]="clasificacion() === o.value"
                        (click)="clasificacion.set(o.value)">{{ o.label }}</button>
              }
            </div>
            <em class="cg-hint cg-hint-sep">{{ clasHint() }}</em>
          </section>

          <!-- Todo lo que sigue depende del tipo: hasta que se elija, no hay nada que
               contestar sin adivinar. -->
          @if (clasificacion()) {
          <!-- ── Paso 2: las fotos ────────────────────────────────────────── -->
          <section class="cg-sec">
            <h2 class="cg-sec-t"><span class="cg-step">2</span> Las fotos</h2>

            <div class="cg-shots">
              <!-- La firmada va SIEMPRE, sea cual sea el tipo de gasto: es la autorización
                   que respalda la salida de dinero, no la comprobación del gasto. -->
              <ng-container *ngTemplateOutlet="shot; context: { $implicit: 'solicitud_kepler', t: 'Solicitud firmada', req: true }" />
              @if (llevaTicket()) {
                <ng-container *ngTemplateOutlet="shot; context: { $implicit: 'comprobante_1', t: 'Ticket o factura', req: true }" />
                <ng-container *ngTemplateOutlet="shot; context: { $implicit: 'comprobante_2', t: 'Segundo ticket', req: false }" />
              }
            </div>
          </section>

          <!-- ── Paso 3: los datos ────────────────────────────────────────── -->
          <section class="cg-sec">
            <h2 class="cg-sec-t"><span class="cg-step">3</span> Los datos</h2>

            <div class="cg-f">
              <label class="cg-lbl" for="cg-imp">¿De cuánto fue?</label>
              <div class="cg-money">
                <span aria-hidden="true">$</span>
                <input id="cg-imp" type="number" inputmode="decimal" step="0.01" min="0"
                       [(ngModel)]="importe" placeholder="0.00" (input)="importeTocado = true" />
              </div>
              <!-- De dónde salió el número. Se dice SIEMPRE que lo puso la foto: un campo que
                   se llena solo y no avisa parece un error del sistema, y nadie lo revisa. -->
              @if (leyendo()) {
                <em class="cg-hint"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo el ticket…</em>
              } @else if (lectura(); as l) {
                @if (l.legible && !importeTocado) {
                  <em class="cg-hint is-ok"><i class="pi pi-check-circle" aria-hidden="true"></i>
                    Lo tomamos de la foto del ticket. Si no es correcto, corrígelo.</em>
                } @else if (!l.legible && l.motivo === 'ilegible') {
                  <em class="cg-hint"><i class="pi pi-info-circle" aria-hidden="true"></i>
                    No alcanzamos a leer el ticket — escribe el monto tú.</em>
                }
              }
            </div>

            <div class="cg-f">
              <label class="cg-lbl" for="cg-ben">¿A quién le pagaste?</label>
              <input id="cg-ben" type="text" [(ngModel)]="beneficiario"
                     placeholder="Nombre del negocio, como sale en el ticket" />
            </div>

            <div class="cg-f">
              <label class="cg-lbl" for="cg-con">¿De qué fue?</label>
              <input id="cg-con" type="text" [(ngModel)]="concepto"
                     placeholder="Ej. gasolina de la camioneta, comida de ruta…" />
            </div>

            <div class="cg-row">
              <div class="cg-f">
                <label class="cg-lbl" for="cg-suc">Sucursal</label>
                <select id="cg-suc" [(ngModel)]="sucursal" (ngModelChange)="onSucursal($event)">
                  @for (s of c.sucursales; track s.code) { <option [value]="s.code">{{ s.label }}</option> }
                  <!-- Una plaza nueva existe en la calle antes que en el catálogo. Sin esta
                       salida, el gasto se captura con la sucursal equivocada o no se captura. -->
                  <option value="__otra__">Otra — no está en la lista</option>
                </select>
                @if (sucursal === '__otra__') {
                  <input class="cg-suc-otra" type="text" [(ngModel)]="sucursalOtra"
                         placeholder="¿Cuál? Escribe el nombre" aria-label="Nombre de la sucursal" />
                  <em class="cg-hint">La va a revisar Finanzas: si es nueva, la dan de alta.</em>
                }
              </div>
              <div class="cg-f">
                <label class="cg-lbl" for="cg-fec">¿Qué día?</label>
                <input id="cg-fec" type="date" [(ngModel)]="fecha" [max]="hoy" />
              </div>
            </div>

            <!-- Sólo cuando se declaró que NO hay comprobante. Con la condición puesta en
                 !llevaTicket() esto aparecía también antes de elegir tipo (porque sin tipo
                 tampoco "lleva ticket"), preguntando por un ticket que nadie había descartado. -->
            @if (clasificacion() === 'no_comprobable') {
              <div class="cg-f">
                <label class="cg-lbl" for="cg-mot">¿Por qué no hay ticket?</label>
                <textarea id="cg-mot" rows="3" [(ngModel)]="motivo"
                          placeholder="Ej. propina, no me dieron recibo…"></textarea>
                <em class="cg-hint">Esto lo lee quien lo autoriza, así que cuéntanos qué pasó.</em>
              </div>
            }
          </section>
          }

          @if (error()) { <p class="cg-err" role="alert">{{ error() }}</p> }

          <!-- Botón pegado abajo: en un celular es donde llega el pulgar. -->
          <div class="cg-send">
            <button type="button" class="cg-btn cg-btn-lg" (click)="enviar()"
                    [disabled]="!listo() || enviando()" [attr.aria-describedby]="listo() ? null : 'cg-falta'">
              @if (enviando()) {
                <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Mandando…
              } @else { Mandar el gasto }
            </button>
            @if (!listo()) { <p class="cg-falta" id="cg-falta">{{ falta() }}</p> }
          </div>

          <!-- ── Lo que ya mandó ──────────────────────────────────────────── -->
          @if (previas().length) {
            <section class="cg-prev">
              <h2 class="cg-prev-t">Lo que ya mandaste</h2>
              @for (p of previas(); track p.id) {
                <div class="cg-prev-i">
                  <div class="cg-prev-l">
                    <strong>{{ p.proveedor }}</strong>
                    <span class="cg-prev-d">{{ dmy(p.fecha_gasto) }}</span>
                  </div>
                  <div class="cg-prev-r">
                    <span class="cg-num">{{ money(p.importe) }}</span>
                    <span class="cg-tag" [class.ok]="p.status === 'validada'">{{ p.estado }}</span>
                  </div>
                </div>
              }
            </section>
          }
        }
      }
    </div>

    <!-- Una cámara por rol, para que cada botón sepa a dónde va su foto. -->
    <ng-template #shot let-role let-t="t" let-req="req">
      <div class="cg-shot" [class.done]="!!toma(role)">
        <div class="cg-shot-l">
          <span class="cg-shot-t">{{ t }}@if (req) { <b aria-hidden="true">*</b> }</span>
          @if (toma(role); as tm) {
            <img [src]="tm.dataUri" [alt]="'Foto de ' + t" class="cg-thumb" />
          } @else {
            <span class="cg-shot-no">Sin foto</span>
          }
        </div>
        <div class="cg-shot-a">
          <button type="button" class="cg-shot-b" (click)="tomarFoto(role, t)"
                  [attr.aria-label]="(toma(role) ? 'Repetir la foto de ' : 'Tomar la foto de ') + t">
            <i class="pi" [class.pi-camera]="!toma(role)" [class.pi-refresh]="!!toma(role)" aria-hidden="true"></i>
            {{ toma(role) ? 'Repetir' : 'Tomar' }}
          </button>
        </div>
      </div>
    </ng-template>

    <!-- UNA sola cámara para toda la pantalla: sabe a qué rol va por lo que dejó
         tomarFoto(). Con una por rol habría que abrirlas por índice del DOM, que se
         desalinea solo en cuanto cambie el orden o la condición de alguna. -->
    <app-camera-shot [etiqueta]="rolPendienteLabel()" (tomada)="guardarFoto($event)" />
  `,
  styles: [`
    /* Operations en touch: herramienta, sin decoración, targets grandes. No hereda el shell
       de la app — esta pantalla vive fuera del layout con sidebar. */
    :host { display: block; min-height: 100dvh; background: var(--bg-1, #fafaf9); }
    .cg { max-width: 34rem; margin: 0 auto; padding: var(--sp-3);
      padding-bottom: calc(var(--sp-6) + env(safe-area-inset-bottom, 0)); }

    .cg-boot, .cg-dead { display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: var(--sp-2); min-height: 70dvh; text-align: center; color: var(--fg-2); }
    .cg-dead i { font-size: 2rem; color: var(--fg-3); }
    .cg-dead h1 { margin: 0; font-size: var(--fs-h3); color: var(--fg-1); }
    .cg-dead p { margin: 0; max-width: 24rem; font-size: var(--fs-sm); }

    .cg-head { padding: var(--sp-3) 0 var(--sp-4); }
    .cg-eyebrow { margin: 0 0 2px; font-size: var(--fs-micro); text-transform: uppercase;
      letter-spacing: .08em; color: var(--fg-3); }
    .cg-head h1 { margin: 0; font-size: var(--fs-h2); color: var(--fg-1); }

    /* ── Devueltos: lo primero, y se ve que duele ─────────────────────────── */
    .cg-back { margin-bottom: var(--sp-4); padding: var(--sp-3); border-radius: var(--r-md);
      border: 1px solid var(--warn-border); background: var(--warn-bg, transparent); }
    .cg-back-t { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2);
      font-size: var(--fs-body); color: var(--warn-fg); }
    .cg-back-i { padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); }
    .cg-back-h { display: flex; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-sm); }
    .cg-back-why { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.4; }
    .cg-back-how { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--fg-2); }

    /* ── Secciones ────────────────────────────────────────────────────────── */
    .cg-sec { margin-bottom: var(--sp-5); }
    .cg-sec-t { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-3);
      font-size: var(--fs-body); color: var(--fg-1); }
    .cg-step { display: inline-flex; align-items: center; justify-content: center;
      width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--action); color: #fff;
      font-size: var(--fs-xs); font-weight: var(--fw-bold); }

    /* ── Fotos ────────────────────────────────────────────────────────────── */
    .cg-shots { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cg-shot { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); }
    .cg-shot.done { border-color: var(--ok-border, var(--border-color)); }
    .cg-shot-l { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
    .cg-shot-t { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); }
    .cg-shot-t b { color: var(--action); }
    .cg-shot-no { font-size: var(--fs-xs); color: var(--fg-3); }
    .cg-thumb { width: 44px; height: 44px; object-fit: cover; border-radius: var(--r-sm);
      border: 1px solid var(--border-color); }
    .cg-shot-a { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-1); }
    .cg-shot-b { display: inline-flex; align-items: center; gap: var(--sp-1);
      min-height: var(--tap-min); padding: 0 var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: transparent; color: var(--fg-1);
      font-size: var(--fs-sm); font-weight: var(--fw-medium); cursor: pointer; white-space: nowrap; }
    .cg-shot-b:active { background: var(--overlay-hover); }
    .cg-shot-b:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    /* ── Campos ───────────────────────────────────────────────────────────── */
    .cg-f { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-3); }
    .cg-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    .cg-lbl { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); }
    .cg-hint { font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.4; }
    .cg-hint.is-ok { color: var(--ok-fg); }
    .cg-hint i { margin-right: 3px; }
    /* La sucursal escrita a mano: se separa de su select para que se lea como su respuesta. */
    .cg-suc-otra { margin-top: var(--sp-1); }
    .cg-hint-sep { display: block; margin-top: var(--sp-2); }
    /* 16px reales en los inputs: por debajo, iOS hace zoom al enfocar y descuadra la página. */
    .cg-f input, .cg-f select, .cg-f textarea, .cg-money input {
      width: 100%; min-height: var(--tap-min); padding: var(--sp-2); font-size: 16px;
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--fg-1); font-family: inherit; }
    .cg-f textarea { min-height: 5rem; resize: vertical; }
    .cg-f input:focus-visible, .cg-f select:focus-visible, .cg-f textarea:focus-visible,
    .cg-money input:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -1px; }
    .cg-money { display: flex; align-items: center; gap: var(--sp-2); }
    .cg-money > span { font-size: var(--fs-h3); color: var(--fg-2); }
    .cg-money input { font-size: 20px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .cg-seg { display: flex; gap: var(--sp-1); }
    .cg-seg-b { flex: 1; min-height: var(--tap-min); padding: var(--sp-2) var(--sp-1);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg);
      color: var(--fg-2); font-size: var(--fs-xs); font-weight: var(--fw-medium); cursor: pointer; }
    .cg-seg-b.on { border-color: var(--action); background: var(--overlay-selected); color: var(--fg-1); }
    .cg-seg-b:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    /* ── Enviar ───────────────────────────────────────────────────────────── */
    .cg-send { position: sticky; bottom: 0; padding: var(--sp-3) 0 calc(var(--sp-2) + env(safe-area-inset-bottom, 0));
      background: linear-gradient(to top, var(--bg-1, #fafaf9) 65%, transparent); }
    .cg-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
      min-height: var(--tap-min); padding: 0 var(--sp-4); border: 0; border-radius: var(--r-md);
      background: var(--action); color: #fff; font-size: var(--fs-body); font-weight: var(--fw-bold);
      font-family: inherit; cursor: pointer; }
    .cg-btn-lg { width: 100%; min-height: 3rem; }
    .cg-btn:disabled { opacity: .45; cursor: default; }
    .cg-btn:active:not(:disabled) { background: var(--action-press); }
    .cg-btn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .cg-falta { margin: var(--sp-1) 0 0; text-align: center; font-size: var(--fs-xs); color: var(--fg-2); }
    .cg-err { margin: 0 0 var(--sp-2); padding: var(--sp-2); border-radius: var(--r-md);
      border: 1px solid var(--bad-border, var(--border-color)); color: var(--bad-fg, var(--fg-1));
      font-size: var(--fs-sm); }

    /* ── Acuse ────────────────────────────────────────────────────────────── */
    .cg-ok { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      padding: var(--sp-5) var(--sp-3); text-align: center; }
    .cg-ok i { font-size: 2.5rem; color: var(--ok-fg); }
    .cg-ok h2 { margin: 0; font-size: var(--fs-h3); color: var(--fg-1); }
    .cg-ok p { margin: 0 0 var(--sp-3); max-width: 26rem; font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.5; }

    /* ── Historial ────────────────────────────────────────────────────────── */
    .cg-prev { margin-top: var(--sp-5); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .cg-prev-t { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .cg-prev-i { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
      padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .cg-prev-l { display: flex; flex-direction: column; min-width: 0; }
    .cg-prev-l strong { font-size: var(--fs-sm); color: var(--fg-1); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .cg-prev-d { font-size: var(--fs-xs); color: var(--fg-3); }
    .cg-prev-r { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
    .cg-tag { font-size: var(--fs-nano); color: var(--fg-2); }
    .cg-tag.ok { color: var(--ok-fg); }
    .cg-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
  `],
})
export class CapturaGastoLinkComponent {
  private readonly svc = inject(CapturaGastoService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly camara = viewChild(CameraShotComponent);

  private token = '';
  readonly ctx = signal<CapturaContext | null>(null);
  readonly cargando = signal(true);
  /** Mensaje de link vencido/revocado. Es terminal: no hay nada que reintentar. */
  readonly muerto = signal<string | null>(null);
  readonly error = signal<string>('');
  readonly enviando = signal(false);
  readonly enviado = signal(false);

  readonly clasificacion = signal<ExpenseClasificacion | null>(null);
  private readonly tomas = signal<Record<string, Toma>>({});

  importe: number | null = null;
  concepto = '';
  beneficiario = '';
  sucursal = '';
  motivo = '';
  readonly hoy = new Date().toISOString().slice(0, 10);
  fecha = this.hoy;

  readonly money = money;
  readonly dmy = dmy;

  readonly clasOpts: { value: ExpenseClasificacion; label: string }[] = [
    { value: 'fiscal', label: 'Con factura' },
    { value: 'no_fiscal_comprobable', label: 'Sólo ticket' },
    { value: 'no_comprobable', label: 'Sin comprobante' },
  ];

  constructor() {
    this.token = this.route.snapshot.paramMap.get('token') || '';
    this.cargar();
  }

  private cargar(): void {
    if (!this.token) { this.cargando.set(false); this.muerto.set('Este link no es válido'); return; }
    this.svc.context(this.token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => {
        this.ctx.set(c);
        this.sucursal = c.sucursal || c.sucursales[0]?.code || '';
        this.cargando.set(false);
      },
      error: (e) => {
        this.cargando.set(false);
        // 403 = revocado o vencido, y el backend ya lo dice en llano. Otra cosa es red.
        this.muerto.set(e?.status === 403
          ? (e?.error?.message || 'Este link ya no sirve')
          : 'No se pudo abrir. Revisa tu señal y vuelve a intentar.');
      },
    });
  }

  primerNombre(p: string): string {
    const n = (p || '').trim().split(/\s+/)[0] || '';
    return n ? n.charAt(0) + n.slice(1).toLowerCase() : '';
  }

  readonly llevaTicket = computed(() => requiereEvidencia(this.clasificacion()));
  clasHint(): string {
    switch (this.clasificacion()) {
      case 'fiscal': return 'Te dieron factura. Sacale foto junto con la solicitud firmada.';
      case 'no_fiscal_comprobable': return 'Te dieron ticket o nota, pero no factura.';
      case 'no_comprobable': return 'No hay ticket ni factura. Vas a tener que contar por qué.';
      default: return 'Elige una para continuar.';
    }
  }

  /** Lo devuelto va arriba: enterarse es más urgente que capturar lo siguiente. */
  readonly devueltas = computed(() => (this.ctx()?.capturas || []).filter((c) => c.status === 'rechazada'));
  readonly previas = computed(() => (this.ctx()?.capturas || []).filter((c) => c.status !== 'rechazada'));

  toma(role: string): Toma | null { return this.tomas()[role] ?? null; }

  /** A qué rol le toca la foto que se está por tomar, y cómo se llama en pantalla. */
  private readonly rolPendiente = signal<ProofFileRole>('solicitud_kepler');
  readonly rolPendienteLabel = signal('Foto');

  tomarFoto(role: ProofFileRole, etiqueta: string): void {
    this.rolPendiente.set(role);
    this.rolPendienteLabel.set(etiqueta);
    this.camara()?.abrir();
  }

  guardarFoto(ev: { dataUri: string; camera: 'live' | 'file' }): void {
    const role = this.rolPendiente();
    this.tomas.update((m) => ({ ...m, [role]: { role, dataUri: ev.dataUri, camera: ev.camera } }));
    this.error.set('');
    // El ticket trae el importe impreso: lo leemos apenas se toma la foto.
    if (role.startsWith('comprobante')) this.leerTicket(ev.dataUri);
  }

  // ── Lo que Claude Vision lee del ticket ──────────────────────────────────
  readonly leyendo = signal(false);
  readonly lectura = signal<LecturaTicket | null>(null);
  /** ¿El trabajador ya tocó el importe a mano? Entonces la foto NO lo pisa. */
  importeTocado = false;

  /**
   * Lee el ticket y PROPONE los datos. Tres reglas:
   *   · Nunca pisa lo que la persona ya escribió — el humano manda sobre la máquina.
   *   · Lo llenado por la foto se DICE en pantalla; un campo que se llena solo y no avisa
   *     parece un error del sistema, y entonces nadie lo revisa.
   *   · Si falla, no pasa nada: se teclea como antes. Leer el ticket es una ayuda, no un paso.
   */
  private leerTicket(dataUri: string): void {
    this.leyendo.set(true);
    this.lectura.set(null);
    this.svc.leerTicket(this.token, dataUri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => {
        this.leyendo.set(false);
        this.lectura.set(l);
        if (!l.legible) return;
        if (l.total != null && !this.importeTocado && !this.importe) this.importe = l.total;
        if (l.comercio && !this.beneficiario.trim()) this.beneficiario = l.comercio;
        // La fecha del ticket sólo si es de hoy o antes: una futura es lectura mala.
        if (l.fecha && /^\d{4}-\d{2}-\d{2}$/.test(l.fecha) && l.fecha <= this.hoy) this.fecha = l.fecha;
      },
      error: () => { this.leyendo.set(false); this.lectura.set(null); },
    });
  }

  /** La sucursal escrita a mano cuando no está en el catálogo. */
  sucursalOtra = '';
  onSucursal(v: string): void { if (v !== '__otra__') this.sucursalOtra = ''; }
  /** Lo que se manda: el código del catálogo, o lo tecleado si eligió «Otra». */
  private sucursalFinal(): string {
    return this.sucursal === '__otra__' ? this.sucursalOtra.trim() : this.sucursal;
  }

  /** ¿Se puede mandar? Mismas reglas que valida el servidor, dichas antes de tocar el botón. */
  readonly listo = computed(() => {
    if (!this.clasificacion()) return false;
    if (!this.tomas()['solicitud_kepler']) return false;
    if (this.llevaTicket() && !this.tomas()['comprobante_1']) return false;
    return true;
  });
  /** Qué falta, en el orden en que se llena. */
  falta(): string {
    if (!this.clasificacion()) return 'Elige qué tipo de gasto es';
    if (!this.tomas()['solicitud_kepler']) return 'Falta la foto de la solicitud firmada';
    return 'Falta la foto del ticket';
  }

  enviar(): void {
    if (!this.listo() || this.enviando()) return;

    const imp = Number(this.importe) || 0;
    if (!(imp > 0)) { this.error.set('Escribe de cuánto fue el gasto.'); return; }
    if (!this.beneficiario.trim()) { this.error.set('Escribe a quién le pagaste.'); return; }
    if (!this.concepto.trim()) { this.error.set('Escribe en una línea de qué fue.'); return; }
    if (!this.sucursalFinal()) { this.error.set('Dinos de qué sucursal es el gasto.'); return; }
    if (!this.llevaTicket() && !this.motivo.trim()) { this.error.set('Escribe por qué no hay ticket.'); return; }

    this.error.set('');
    this.enviando.set(true);

    // Una subida por foto, cada una con su propio catch: en un celular con datos móviles,
    // que falle una no puede tirar las demás.
    const pendientes = Object.values(this.tomas());
    const ups = pendientes.map((t) => this.svc.uploadFile(this.token, t.dataUri, t.role).pipe(
      map((f) => ({ role: t.role, file: f as ProofFile | null })),
      catchError(() => of({ role: t.role, file: null as ProofFile | null })),
    ));

    forkJoin(ups).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((res) => {
      const fallaron = res.filter((r) => !r.file);
      if (fallaron.length) {
        this.enviando.set(false);
        this.error.set(`No se pudieron subir ${fallaron.length} foto(s). Revisa tu señal y vuelve a intentar.`);
        return;
      }
      const files = res.map((r) => r.file!) as ProofFile[];
      const algunaEnVivo = pendientes.some((t) => t.camera === 'live');

      this.svc.submit(this.token, {
        importe: imp,
        concepto: this.concepto.trim(),
        beneficiario: this.beneficiario.trim(),
        sucursal: this.sucursalFinal(),
        fecha_gasto: this.fecha || undefined,
        clasificacion: this.clasificacion()!,
        comentarios: this.motivo.trim() || undefined,
        files,
        camera: algunaEnVivo ? 'live' : 'file',
        captured_at: new Date().toISOString(),
        user_agent: navigator.userAgent,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.enviando.set(false); this.enviado.set(true); },
        error: (e) => {
          this.enviando.set(false);
          this.error.set(e?.error?.message || 'No se pudo mandar. Revisa tu señal y vuelve a intentar.');
        },
      });
    });
  }

  /** Limpia para el siguiente gasto y vuelve a pedir el contexto (para ver lo recién subido). */
  otro(): void {
    this.tomas.set({});
    this.clasificacion.set(null);
    this.importe = null; this.concepto = ''; this.beneficiario = ''; this.motivo = '';
    this.importeTocado = false; this.lectura.set(null); this.leyendo.set(false); this.sucursalOtra = '';
    this.fecha = this.hoy;
    this.enviado.set(false);
    this.error.set('');
    this.cargando.set(true);
    this.cargar();
  }
}
