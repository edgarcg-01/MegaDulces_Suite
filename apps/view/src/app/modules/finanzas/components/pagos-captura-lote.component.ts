import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PagosComprobantesService, DepositOcr, PagoCandidate, ProofFile } from '../pagos-comprobantes.service';
import { CRITERIOS, Clasificacion, Chequeo, ETIQUETA_CRITERIO, clasificar, coincidencias, llavePago, pagosRepetidos, textoMotivo } from '../pagos-captura-lote';

type Criterio = (typeof CRITERIOS)[number];

/** Cuántos comprobantes se leen a la vez (OCR + búsqueda). Más satura el modelo sin acelerar. */
const EN_PARALELO = 3;
const MAX_BYTES = 10 * 1024 * 1024;

type Fase = 'en_cola' | 'leyendo' | 'buscando' | 'listo' | 'guardando' | 'guardado' | 'duplicado' | 'error';

/** Lo que devolvió el servidor al adjuntar (los controles de cuenta propia y clave repetida). */
interface ResultadoGuardado {
  status: string; monto_match: boolean | null; cuenta_propia?: boolean | null; ref_duplicada?: boolean; ref_otros?: string[];
  /** `[PC.6]` lo validó el servidor solo (cuatro coincidencias + lectura verificada) */
  auto_validado?: boolean; diferencias?: string[]; motivo_no_automatico?: string | null;
}

/** `[PC.6]` Lo que la página necesita saber al terminar un guardado por lote. */
export interface LoteGuardado { guardados: number; validados: number }

export interface FilaLote {
  id: number;
  nombre: string;
  bytes: number;
  dataUri: string;
  fase: Fase;
  ocr: DepositOcr | null;
  subido: ProofFile | null;
  candidatos: PagoCandidate[];
  clasif: Clasificacion<PagoCandidate> | null;
  /** El pago al que se va a ligar. */
  elegido: PagoCandidate | null;
  /** El clic de la persona. «listo» llega en true; todo lo demás, en false. */
  confirmado: boolean;
  /** Búsqueda manual (sin pago / quiere otro). */
  busqueda: string;
  resultados: PagoCandidate[];
  buscando: boolean;
  resultado: ResultadoGuardado | null;
  error: string | null;
  /** Nombre del archivo del lote del que esta fila es copia (fase «duplicado»). */
  copiaDe: string | null;
}

/**
 * `[PC.3]` — **Captura por lote de comprobantes de pago a proveedor.**
 *
 * Se sueltan varios PDFs a la vez. Por cada uno: se sube y se lee con OCR (de 3 en 3), se buscan
 * los pagos de Kepler con ese monto, y la regla `clasificar` decide si la propuesta viene
 * pre-marcada. ⛔ Nada se guarda sin el botón «Guardar»: la IA propone, la persona confirma.
 */
@Component({
  selector: 'app-pagos-captura-lote',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="pl-drop" [class.drag]="arrastrando()" [class.compact]="filas().length > 0"
             (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)"
             aria-label="Captura de comprobantes de pago">
      <i class="pi pi-file-pdf pl-drop-ico" aria-hidden="true"></i>
      <div class="pl-drop-txt">
        <strong>Suelta aquí los comprobantes de pago (PDF)</strong>
        <span>Puedes soltar varios a la vez. La IA lee cada uno y busca su pago en Kepler; tú confirmas antes de guardar.</span>
      </div>
      <label class="pl-pick">
        <i class="pi pi-upload" aria-hidden="true"></i> Elegir PDFs
        <input type="file" accept="application/pdf,.pdf" multiple hidden (change)="onPick($event)" />
      </label>
      @if (live()) { <span class="pl-live" title="Cambios de otros usuarios se reflejan al momento"><span class="pl-live-dot"></span> En vivo</span> }
    </section>
    @if (aviso()) { <div class="pl-aviso" role="status">{{ aviso() }}</div> }

    @if (filas().length) {
      <section class="pl-tray" aria-label="Comprobantes en captura">
        <header class="pl-head">
          <div class="pl-head-t">
            <strong>{{ filas().length }} {{ filas().length === 1 ? 'comprobante' : 'comprobantes' }}</strong>
            <span class="pl-counts">
              @if (cuenta().procesando) { <span><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> {{ cuenta().procesando }} en proceso</span> }
              @if (cuenta().listos) { <span class="ok">{{ cuenta().listos }} listos</span> }
              @if (cuenta().porConfirmar) { <span class="warn">{{ cuenta().porConfirmar }} por confirmar</span> }
              @if (cuenta().sinPago) { <span class="bad">{{ cuenta().sinPago }} sin pago</span> }
              @if (cuenta().guardados) { <span class="ok"><i class="pi pi-check" aria-hidden="true"></i> {{ cuenta().guardados }} guardados</span> }
            </span>
          </div>
          <div class="pl-head-a">
            @if (cuenta().guardados) { <button pButton type="button" size="small" text (click)="quitarGuardados()" [disabled]="guardando()"><span class="p-button-label">Quitar guardados</span></button> }
            <button pButton type="button" size="small" text severity="secondary" (click)="descartarTodo()" [disabled]="guardando()"><span class="p-button-label">Descartar todo</span></button>
            <button pButton type="button" size="small" (click)="guardar()" [loading]="guardando()" [disabled]="!guardables().length || guardando()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
              <span class="p-button-label">Guardar {{ guardables().length || '' }}</span>
            </button>
          </div>
        </header>

        <div class="pl-cols" aria-hidden="true">
          <span></span><span>Comprobante</span><span>Lo que leyó la IA</span><span>Pago de Kepler</span><span></span>
        </div>

        @for (f of filas(); track f.id) {
          <div class="pl-row" [attr.data-fase]="f.fase" [attr.data-conf]="f.clasif?.confianza" [attr.data-res]="f.resultado ? (f.resultado.status === 'validado' ? 'validado' : 'diferencias') : null">
            <!-- confirmación -->
            <div class="pl-chk">
              @if (f.fase === 'listo' && f.elegido) {
                <input type="checkbox" [checked]="f.confirmado" (change)="toggle(f.id)" [disabled]="guardando()"
                       [attr.aria-label]="'Confirmo que ' + f.nombre + ' es el comprobante de ' + llave(f.elegido)" />
              } @else if (f.fase === 'guardado') {
                @if (f.resultado?.status === 'validado') { <i class="pi pi-check-circle pl-ok" aria-label="Guardado y validado"></i> } @else { <i class="pi pi-exclamation-circle warn" aria-label="Guardado con diferencias"></i> }
              }
            </div>

            <!-- archivo -->
            <div class="pl-file">
              <span class="pl-name" [title]="f.nombre">{{ f.nombre }}</span>
              <span class="pl-sub">
                @switch (f.fase) {
                  @case ('en_cola') { En cola… }
                  @case ('leyendo') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo con IA… }
                  @case ('buscando') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando el pago… }
                  @case ('guardando') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Guardando… }
                  @case ('duplicado') { <span class="bad">Repetido{{ f.copiaDe ? ': es igual a ' + f.copiaDe : ' en este lote' }} — no se guarda</span> }
                  @case ('error') { <span class="bad">{{ f.error }}</span> }
                  @default { {{ kb(f.bytes) }} }
                }
              </span>
            </div>

            <!-- lectura -->
            <div class="pl-ocr">
              @if (f.ocr; as o) {
                <span class="pl-monto">{{ o.monto != null ? money(o.monto) : 'sin monto' }}</span>
                <span class="pl-sub">{{ o.fecha || 'sin fecha' }}@if (o.concepto) { · {{ o.concepto }} }</span>
                <span class="pl-sub">{{ o.beneficiario || 'sin beneficiario' }}</span>
                <span class="pl-sub mono">Cta. origen {{ o.cuenta_origen || '—' }}</span>
                @if (o.ocr_status === 'sin_key') { <span class="pl-sub bad">OCR no disponible</span> }
              } @else if (f.fase !== 'duplicado' && f.fase !== 'error') { <span class="pl-sub">—</span> }
            </div>

            <!-- pago -->
            <div class="pl-pago">
              @if (f.fase === 'guardado') {
                <span class="pl-pk mono">{{ llave(f.elegido!) }}</span>
                <span class="pl-tags">
                  <!-- [PC.6] la decisión la toma el SERVIDOR: puede no validar algo que aquí se veía «listo» -->
                  @if (f.resultado?.status === 'validado') { <span class="pl-tag ok" title="Coinciden banco, fecha, monto y proveedor">Validado automático</span> }
                  @else { <span class="pl-tag warn" [title]="f.resultado?.motivo_no_automatico || ''">Con diferencias{{ f.resultado?.motivo_no_automatico ? ': ' + f.resultado?.motivo_no_automatico : '' }}</span> }
                  @if (f.resultado?.monto_match === true) { <span class="pl-tag ok">Cuadra</span> }
                  @else if (f.resultado?.monto_match === false) { <span class="pl-tag bad">Monto no cuadra</span> }
                  @if (f.resultado?.cuenta_propia === false) { <span class="pl-tag bad">Cuenta origen NO reconocida</span> }
                  @if (f.resultado?.ref_duplicada) { <span class="pl-tag warn" [title]="(f.resultado?.ref_otros || []).join(', ')">Clave de rastreo repetida</span> }
                </span>
              } @else if (f.fase === 'listo') {
                @if (f.elegido; as p) {
                  <div class="pl-elegido">
                    <span class="pl-pk"><span class="mono">{{ llave(p) }}</span> · {{ p.proveedor_nombre || p.proveedor_code || '—' }}</span>
                    <span class="pl-sub">{{ p.pago_date | date:'dd/MM/yy' }} · {{ money(p.monto) }}@if (p.banco_nombre) { · {{ p.banco_nombre }} }@if (p.concepto) { · {{ p.concepto }} }</span>
                    <ng-container *ngTemplateOutlet="chips; context: { $implicit: f, p: p }" />
                    <span class="pl-motivo" [attr.data-conf]="f.clasif?.confianza">
                      @if (f.clasif?.propuesto === p) { {{ motivo(f) }} } @else { Elegido por ti }
                      @if (repetidos().has(llave(p))) { · <strong class="bad">otro comprobante del lote va a este mismo pago</strong> }
                    </span>
                    @if (f.candidatos.length > 1 || f.clasif?.propuesto !== p) { <button type="button" class="pl-link" (click)="cambiar(f.id)">Cambiar pago</button> }
                  </div>
                } @else if (f.clasif?.confianza === 'elegir') {
                  <span class="pl-motivo" data-conf="elegir">{{ motivo(f) }}</span>
                  <div class="pl-cands" role="list">
                    @for (c of f.candidatos; track llave(c)) {
                      <button type="button" class="pl-cand" role="listitem" (click)="elegir(f.id, c)">
                        <span class="mono">{{ llave(c) }}</span>
                        <span class="pl-cand-p">{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
                        <span class="pl-sub">{{ c.pago_date | date:'dd/MM/yy' }} · {{ money(c.monto) }}@if (c.banco_nombre) { · {{ c.banco_nombre }} }@if (c.concepto_match) { · <em class="ok">factura coincide</em> }@if (c.deposits > 0) { · <em class="warn">ya tiene comprobante</em> }</span>
                        <ng-container *ngTemplateOutlet="chips; context: { $implicit: f, p: c }" />
                      </button>
                    }
                  </div>
                } @else {
                  <span class="pl-motivo" data-conf="sin_pago">{{ motivo(f) }}</span>
                  <div class="pl-search">
                    <input pInputText [ngModel]="f.busqueda" (ngModelChange)="setBusqueda(f.id, $event)" (keyup.enter)="buscar(f.id)"
                           placeholder="Folio, proveedor, RFC, monto…" [attr.aria-label]="'Buscar el pago de ' + f.nombre" />
                    <button pButton type="button" size="small" text (click)="buscar(f.id)" [loading]="f.buscando" aria-label="Buscar"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                  </div>
                  @if (f.resultados.length) {
                    <div class="pl-cands" role="list">
                      @for (c of f.resultados; track llave(c)) {
                        <button type="button" class="pl-cand" role="listitem" (click)="elegir(f.id, c)">
                          <span class="mono">{{ llave(c) }}</span>
                          <span class="pl-cand-p">{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
                          <span class="pl-sub">{{ c.pago_date | date:'dd/MM/yy' }} · {{ money(c.monto) }}@if (c.deposits > 0) { · <em class="warn">ya tiene comprobante</em> }</span>
                        </button>
                      }
                    </div>
                  }
                }
              }
            </div>

            <div class="pl-x">
              @if (f.fase !== 'guardando' && f.fase !== 'guardado') {
                <button type="button" class="pl-xbtn" (click)="quitar(f.id)" [disabled]="guardando()" [attr.aria-label]="'Quitar ' + f.nombre"><i class="pi pi-times" aria-hidden="true"></i></button>
              }
            </div>
          </div>
        }
      </section>
    }

    <!-- [PC.5] Las cuatro coincidencias exactas: banco · fecha · monto · proveedor -->
    <ng-template #chips let-f let-p="p">
      <span class="pl-c4">
        @for (k of criterios; track k) {
          @let v = chequeo(f, p, k);
          <span class="pl-c" [attr.data-v]="v" [title]="detalle(f, p, k)">
            <i class="pi" [ngClass]="v === 'ok' ? 'pi-check' : v === 'difiere' ? 'pi-times' : 'pi-question'" aria-hidden="true"></i>
            {{ etiqueta[k] }}<span class="sr-only">: {{ v === 'ok' ? 'coincide' : v === 'difiere' ? 'no coincide' : 'no se pudo leer' }}</span>
          </span>
        }
      </span>
    </ng-template>
  `,
  styles: [`
    :host { display: block; margin-bottom: 1rem; }
    .pl-drop { display: flex; align-items: center; gap: 1rem; padding: 1.4rem 1.2rem; border: 2px dashed var(--border-color);
      border-radius: var(--r-md, .5rem); background: var(--surface-card); transition: border-color .15s, background .15s, padding .15s; }
    .pl-drop.compact { padding: .8rem 1.1rem; }
    .pl-drop.drag { border-color: var(--action); background: color-mix(in srgb, var(--action) 6%, var(--surface-card)); }
    .pl-drop-ico { font-size: var(--fs-h1); color: var(--action); flex: 0 0 auto; }
    .pl-drop-txt { display: flex; flex-direction: column; gap: .15rem; flex: 1 1 auto; min-width: 0; }
    .pl-drop-txt strong { font-size: var(--fs-body); color: var(--fg-1); }
    .pl-drop-txt span { font-size: var(--fs-sm); color: var(--fg-2); }
    .pl-pick { display: inline-flex; align-items: center; gap: .45rem; padding: .55rem 1rem; border-radius: var(--r-sm, .4rem);
      background: var(--action); color: var(--action-ink, #fff); font-size: var(--fs-body); font-weight: 600; cursor: pointer; flex: 0 0 auto; }
    .pl-pick:hover { background: var(--action-hover); }
    .pl-pick:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pl-live { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--fs-xs); color: var(--ok-fg); font-weight: 600; flex: 0 0 auto; }
    .pl-live-dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--ok-fg); animation: pl-pulse 1.8s ease-in-out infinite; }
    @keyframes pl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
    @media (prefers-reduced-motion: reduce) { .pl-live-dot { animation: none; } .pl-drop { transition: none; } }
    .pl-aviso { margin-top: .5rem; font-size: var(--fs-sm); color: var(--warn-fg); }

    .pl-tray { margin-top: .75rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-card); overflow: hidden; }
    .pl-head { display: flex; align-items: center; justify-content: space-between; gap: .8rem; flex-wrap: wrap; padding: .6rem .9rem;
      border-bottom: 1px solid var(--border-color); }
    .pl-head-t { display: flex; align-items: baseline; gap: .9rem; flex-wrap: wrap; font-size: var(--fs-body); color: var(--fg-1); }
    .pl-counts { display: inline-flex; gap: .8rem; font-size: var(--fs-xs); color: var(--fg-2); }
    .pl-head-a { display: flex; align-items: center; gap: .4rem; }
    .ok { color: var(--ok-fg); } .warn { color: var(--warn-fg); } .bad { color: var(--bad-fg); }

    .pl-cols, .pl-row { display: grid; grid-template-columns: 2rem minmax(10rem, 1.1fr) minmax(9rem, .9fr) minmax(16rem, 2fr) 2rem; gap: .8rem; align-items: start; }
    .pl-cols { padding: .4rem .9rem; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3);
      border-bottom: 1px solid var(--border-color); }
    .pl-row { padding: .6rem .9rem; border-bottom: 1px solid var(--border-color); border-left: 3px solid transparent; }
    .pl-row:last-child { border-bottom: 0; }
    .pl-row[data-conf="listo"] { border-left-color: var(--ok-fg); }
    .pl-row[data-conf="revisar"], .pl-row[data-conf="elegir"] { border-left-color: var(--warn-fg); }
    .pl-row[data-conf="sin_pago"], .pl-row[data-fase="error"], .pl-row[data-fase="duplicado"] { border-left-color: var(--bad-fg); }
    .pl-row[data-fase="guardado"] { background: var(--ok-soft-bg); border-left-color: var(--ok-fg); }
    /* [PC.6] guardado pero NO validado solo: queda en «Con diferencias» y se ve distinto */
    .pl-row[data-fase="guardado"][data-res="diferencias"] { background: var(--warn-soft-bg); border-left-color: var(--warn-fg); }
    .pl-chk { padding-top: .15rem; display: flex; justify-content: center; }
    .pl-chk input { width: 1.05rem; height: 1.05rem; accent-color: var(--action); cursor: pointer; }
    .pl-ok { color: var(--ok-fg); }
    .pl-file, .pl-ocr, .pl-elegido { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
    .pl-name { font-size: var(--fs-body); color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pl-sub { font-size: var(--fs-xs); color: var(--fg-2); }
    .pl-sub .pi { font-size: var(--fs-xs); }
    .pl-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
    .pl-pago { display: flex; flex-direction: column; gap: .35rem; min-width: 0; }
    .pl-pk { font-size: var(--fs-body); color: var(--fg-1); }
    .mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
    .pl-motivo { font-size: var(--fs-xs); font-weight: 600; }
    .pl-motivo[data-conf="listo"] { color: var(--ok-fg); }
    .pl-motivo[data-conf="revisar"], .pl-motivo[data-conf="elegir"] { color: var(--warn-fg); }
    .pl-motivo[data-conf="sin_pago"] { color: var(--bad-fg); }
    .pl-link { align-self: flex-start; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .pl-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pl-cands { display: flex; flex-direction: column; gap: .3rem; }
    .pl-cand { display: grid; grid-template-columns: auto 1fr; gap: .1rem .6rem; text-align: left; padding: .4rem .6rem; border: 1px solid var(--border-color);
      border-radius: var(--r-sm, .4rem); background: var(--surface-ground); color: var(--fg-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .pl-cand:hover { border-color: var(--action); }
    .pl-cand:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pl-cand .pl-sub { grid-column: 1 / -1; }
    .pl-cand-p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pl-cand em { font-style: normal; }
    .pl-search { display: flex; gap: .3rem; }
    .pl-search input { flex: 1 1 auto; font-size: var(--fs-sm); }
    .pl-tags { display: flex; gap: .35rem; flex-wrap: wrap; }
    .pl-tag { font-size: var(--fs-xs); padding: .1rem .45rem; border-radius: var(--r-sm, .4rem); border: 1px solid currentColor; }
    .pl-c4 { display: flex; gap: .3rem; flex-wrap: wrap; }
    .pl-c { display: inline-flex; align-items: center; gap: .25rem; font-size: var(--fs-micro); font-weight: 600; padding: .05rem .4rem;
      border-radius: var(--r-sm, .4rem); border: 1px solid currentColor; }
    .pl-c .pi { font-size: var(--fs-nano); }
    .pl-c[data-v="ok"] { color: var(--ok-fg); }
    .pl-c[data-v="difiere"] { color: var(--bad-fg); }
    .pl-c[data-v="sin_dato"] { color: var(--warn-fg); border-style: dashed; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .pl-x { display: flex; justify-content: center; }
    .pl-xbtn { border: 0; background: none; color: var(--fg-3); cursor: pointer; padding: .2rem .3rem; border-radius: var(--r-sm, .4rem); }
    .pl-xbtn:hover { color: var(--bad-fg); background: var(--hover-bg); }
    .pl-xbtn:focus-visible { outline: 2px solid var(--focus-ring); }
    @media (max-width: 47.5rem) {
      .pl-drop { flex-wrap: wrap; }
      .pl-cols { display: none; }
      .pl-row { grid-template-columns: 2rem 1fr 2rem; }
      .pl-file { grid-column: 2; } .pl-x { grid-column: 3; grid-row: 1; }
      .pl-ocr, .pl-pago { grid-column: 2 / 4; }
    }
  `],
})
export class PagosCapturaLoteComponent {
  private readonly svc = inject(PagosComprobantesService);
  private readonly destroyRef = inject(DestroyRef);

  /** El indicador «En vivo» de la página vive en la zona de carga. */
  readonly live = input(false);
  /** Se guardaron comprobantes: la página recarga su tabla. */
  readonly guardados = output<LoteGuardado>();

  readonly filas = signal<FilaLote[]>([]);
  readonly arrastrando = signal(false);
  readonly guardando = signal(false);
  readonly aviso = signal('');
  private seq = 0;
  private activos = 0;
  private destruido = false;

  constructor() { this.destroyRef.onDestroy(() => { this.destruido = true; }); }

  /** Pagos a los que apunta más de una fila: ninguna de esas se puede guardar. */
  readonly repetidos = computed(() => pagosRepetidos(
    this.filas().filter((f) => f.fase === 'listo' || f.fase === 'guardado').map((f) => (f.elegido ? llavePago(f.elegido) : null)),
  ));
  readonly guardables = computed(() => this.filas().filter((f) =>
    f.fase === 'listo' && !!f.elegido && f.confirmado && !this.repetidos().has(llavePago(f.elegido))));
  readonly cuenta = computed(() => {
    const fs = this.filas();
    const enMesa = fs.filter((f) => f.fase === 'listo');
    return {
      procesando: fs.filter((f) => f.fase === 'en_cola' || f.fase === 'leyendo' || f.fase === 'buscando').length,
      listos: enMesa.filter((f) => f.elegido && f.confirmado).length,
      porConfirmar: enMesa.filter((f) => f.elegido && !f.confirmado).length + enMesa.filter((f) => !f.elegido && f.clasif?.confianza === 'elegir').length,
      sinPago: enMesa.filter((f) => !f.elegido && f.clasif?.confianza !== 'elegir').length + fs.filter((f) => f.fase === 'error').length,
      guardados: fs.filter((f) => f.fase === 'guardado').length,
    };
  });

  llave(c: PagoCandidate): string { return llavePago(c); }

  readonly criterios = CRITERIOS;
  readonly etiqueta = ETIQUETA_CRITERIO;
  chequeo(f: FilaLote, p: PagoCandidate, k: Criterio): Chequeo {
    return f.ocr ? coincidencias(f.ocr, p)[k] : 'sin_dato';
  }
  /** Qué dice cada lado, para el tooltip de la marca. */
  detalle(f: FilaLote, p: PagoCandidate, k: Criterio): string {
    const o = f.ocr;
    const lado = (a: string | null | undefined, b: string | null | undefined) => `Comprobante: ${a || 'no se leyó'} · Kepler: ${b || 'sin dato'}`;
    switch (k) {
      case 'banco': return lado(o?.cuenta_origen, p.banco_nombre || p.clave_banco);
      case 'fecha': return lado(o?.fecha, p.pago_dia || (p.pago_date || '').slice(0, 10));
      case 'monto': return lado(o?.monto != null ? this.money(o.monto) : null, this.money(p.monto));
      case 'proveedor': return lado(o?.beneficiario, p.proveedor_nombre);
    }
  }
  motivo(f: FilaLote): string { return f.clasif ? textoMotivo(f.clasif.motivo) : ''; }
  money(v: number | string | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }
  kb(b: number): string { return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }

  // ── entrada de archivos ────────────────────────────────────────────────────
  onDragOver(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); if (!this.arrastrando()) this.arrastrando.set(true); }
  onDragLeave(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); this.arrastrando.set(false); }
  onDrop(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation();
    this.arrastrando.set(false);
    this.agregar(ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : []);
  }
  onPick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    this.agregar(files);
  }

  private async agregar(files: File[]) {
    const omitidos: string[] = [];
    for (const file of files) {
      const esPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!esPdf) { omitidos.push(`${file.name} (no es PDF)`); continue; }
      if (file.size > MAX_BYTES) { omitidos.push(`${file.name} (más de 10 MB)`); continue; }
      let dataUri: string;
      try { dataUri = await this.leer(file); } catch { omitidos.push(`${file.name} (no se pudo leer)`); continue; }
      // El mismo archivo dos veces en el lote no se lee dos veces.
      const igual = this.filas().find((f) => f.fase !== 'guardado' && f.bytes === file.size && f.dataUri === dataUri);
      this.filas.update((l) => l.concat(this.nueva(file, dataUri, igual?.nombre ?? null)));
    }
    this.aviso.set(omitidos.length ? `No se agregaron: ${omitidos.join(' · ')}. Las fotos del gasto se adjuntan desde el renglón del pago.` : '');
    this.bombear();
  }

  private nueva(file: File, dataUri: string, copiaDe: string | null): FilaLote {
    return {
      id: ++this.seq, nombre: file.name, bytes: file.size, dataUri, fase: copiaDe ? 'duplicado' : 'en_cola', copiaDe,
      ocr: null, subido: null, candidatos: [], clasif: null, elegido: null, confirmado: false,
      busqueda: '', resultados: [], buscando: false, resultado: null, error: null,
    };
  }

  private leer(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = () => rej(r.error || new Error('read'));
      r.readAsDataURL(file);
    });
  }

  // ── procesamiento (de 3 en 3) ──────────────────────────────────────────────
  private bombear() {
    while (this.activos < EN_PARALELO) {
      const sig = this.filas().find((f) => f.fase === 'en_cola');
      if (!sig) return;
      this.activos++;
      this.patch(sig.id, { fase: 'leyendo' });
      this.procesar(sig.id).finally(() => { this.activos--; if (!this.destruido) this.bombear(); });
    }
  }

  private async procesar(id: number) {
    const f = this.fila(id);
    if (!f) return;
    // La subida corre al lado del OCR; si falla, se reintenta al guardar.
    firstValueFrom(this.svc.uploadFile(f.dataUri, 'comprobante'))
      .then((subido) => this.patch(id, { subido }))
      .catch(() => { /* se reintenta en guardar() */ });
    let ocr: DepositOcr;
    try {
      ocr = await firstValueFrom(this.svc.ocr(f.dataUri));
    } catch {
      this.patch(id, { fase: 'error', error: 'No se pudo leer el comprobante' });
      return;
    }
    if (!this.fila(id)) return; // la quitaron mientras se leía
    // Mismo contenido que otra fila ya leída → el mismo papel dos veces.
    const gemela = ocr.sha256 ? this.filas().find((o) => o.id !== id && o.ocr?.sha256 === ocr.sha256) : undefined;
    if (gemela) { this.patch(id, { ocr, fase: 'duplicado', copiaDe: gemela.nombre }); return; }
    this.patch(id, { ocr, fase: 'buscando', busqueda: ocr.concepto || '' });
    let candidatos: PagoCandidate[] = [];
    if (ocr.monto != null && Number(ocr.monto) > 0) {
      try { candidatos = (await firstValueFrom(this.svc.matchPago(ocr.monto, ocr.fecha, ocr.concepto))).pagos || []; }
      catch { candidatos = []; }
    }
    const clasif = clasificar(ocr, candidatos);
    this.patch(id, {
      fase: 'listo', candidatos, clasif,
      elegido: clasif.propuesto, confirmado: clasif.confianza === 'listo',
    });
  }

  // ── acciones de la persona ─────────────────────────────────────────────────
  toggle(id: number) { const f = this.fila(id); if (f) this.patch(id, { confirmado: !f.confirmado }); }
  elegir(id: number, c: PagoCandidate) { this.patch(id, { elegido: c, confirmado: true, resultados: [] }); }
  cambiar(id: number) {
    const f = this.fila(id);
    if (!f) return;
    // Vuelve a la lista de candidatos (o a la búsqueda si sólo había uno).
    const clasif: Clasificacion<PagoCandidate> = f.candidatos.length > 1
      ? { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' }
      : { confianza: 'sin_pago', propuesto: null, motivo: f.clasif?.motivo === 'sin_monto' ? 'sin_monto' : 'sin_candidatos' };
    this.patch(id, { elegido: null, confirmado: false, clasif });
  }
  setBusqueda(id: number, v: string) { this.patch(id, { busqueda: v }); }
  async buscar(id: number) {
    const f = this.fila(id);
    const q = f?.busqueda.trim();
    if (!f || !q) return;
    this.patch(id, { buscando: true });
    try {
      const r = await firstValueFrom(this.svc.list({ search: q }));
      this.patch(id, { buscando: false, resultados: (r.rows || []).slice(0, 8) });
    } catch {
      this.patch(id, { buscando: false, resultados: [] });
    }
  }
  quitar(id: number) { this.filas.update((l) => l.filter((f) => f.id !== id)); }
  quitarGuardados() { this.filas.update((l) => l.filter((f) => f.fase !== 'guardado')); }
  descartarTodo() { this.filas.update((l) => l.filter((f) => f.fase === 'guardando')); this.aviso.set(''); }

  /** El clic de confirmación: guarda, uno por uno, lo que la persona dejó marcado. */
  async guardar() {
    const lote = this.guardables();
    if (!lote.length || this.guardando()) return;
    this.guardando.set(true);
    let ok = 0;
    let validados = 0;
    for (const f of lote) {
      const p = f.elegido!;
      this.patch(f.id, { fase: 'guardando' });
      try {
        const subido = this.fila(f.id)?.subido ?? await firstValueFrom(this.svc.uploadFile(f.dataUri, 'comprobante'));
        const hoja: ProofFile = { ...subido, name: f.nombre, sha256: f.ocr?.sha256 };
        const res = await firstValueFrom(this.svc.attach({
          sucursal: p.sucursal, folio: p.folio, doc_prefix: p.doc_prefix, files: [hoja], ocr: f.ocr ?? undefined,
        }));
        this.patch(f.id, { fase: 'guardado', subido, resultado: res });
        ok++;
        if (res.status === 'validado') validados++;
      } catch (e: unknown) {
        const msg = (e as { error?: { message?: string } })?.error?.message;
        this.patch(f.id, { fase: 'listo', error: null });
        this.aviso.set(`No se pudo guardar ${f.nombre}${msg ? `: ${msg}` : ''}.`);
      }
    }
    this.guardando.set(false);
    if (ok) this.guardados.emit({ guardados: ok, validados });
  }

  private fila(id: number): FilaLote | undefined { return this.filas().find((f) => f.id === id); }
  private patch(id: number, p: Partial<FilaLote>) {
    if (this.destruido) return;
    this.filas.update((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)));
  }
}
