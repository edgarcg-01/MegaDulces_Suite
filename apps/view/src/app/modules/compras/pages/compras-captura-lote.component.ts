import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import {
  textoMotivoIdentificacion, type ExpedienteCubo, type IdentificacionCandidata, type IdentificacionEntrada,
} from '@megadulces/contracts';
import { EntradasService, ProofFile, RemisionOcr } from '../entradas.service';
import { esImagen, esPdf, imagenesAPdf } from '../imagenes-a-pdf';
import { branchName } from '../../../core/constants/store-branches';

/** Cuántos papeles se leen a la vez (OCR + identificación). Más satura el modelo sin acelerar. */
const EN_PARALELO = 3;
const MAX_BYTES = 10 * 1024 * 1024;

type Fase = 'preparando' | 'en_cola' | 'leyendo' | 'buscando' | 'listo' | 'guardando' | 'guardado' | 'duplicado' | 'error';

/** La entrada a la que se va a ligar el papel. */
interface Destino { sucursal: string; folio: string; proveedor_nombre: string | null; monto: number; receipt_date: string | null; deposits: number }

interface FilaLote {
  id: number;
  nombre: string;
  bytes: number;
  /** El PDF que se sube (las fotos se convierten a un PDF por foto). */
  dataUri: string;
  deFoto: boolean;
  fase: Fase;
  ocr: RemisionOcr | null;
  rol: 'factura' | 'remision';
  ident: IdentificacionEntrada | null;
  elegido: Destino | null;
  /** El clic de la persona. «listo» llega en true; todo lo demás, en false. */
  confirmado: boolean;
  busqueda: string;
  resultados: Destino[];
  buscando: boolean;
  /** Tras guardar: el veredicto del expediente (pasa sola / revisar). */
  cubo: ExpedienteCubo | null;
  motivoExpediente: string | null;
  error: string | null;
  copiaDe: string | null;
}

/** Resumen de una corrida de «Guardar». */
export interface CapturaLoteGuardada { guardados: number; pasanSolas: number }

/**
 * `[RE.35.7]` — **Captura por lote de facturas recibidas.** Lo que vale del papel escaneado es el
 * SELLO de recibido y la FIRMA (Francisco, 2026-10-06): por eso se archiva. Se sueltan varios PDF o
 * fotos a la vez; por cada uno: OCR (de 3 en 3) → su CFDI en ContPAQi → la entrada de Kepler que
 * cuadra (`/identificar`). Mismo patrón que la captura de pagos (`[PC.3]`).
 * ⛔ Nada se guarda sin el botón «Guardar»: la IA propone, la persona confirma.
 */
@Component({
  selector: 'app-compras-captura-lote',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="cl-drop" [class.drag]="arrastrando()" [class.compact]="filas().length > 0"
             (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)"
             aria-label="Captura por lote de facturas recibidas">
      <i class="pi pi-copy cl-drop-ico" aria-hidden="true"></i>
      <div class="cl-drop-txt">
        <strong>Suelta aquí las facturas recibidas (PDF o fotos)</strong>
        <span>Varias a la vez, una recepción por archivo. La IA lee cada una (UUID, total, sello y firma), busca su CFDI en ContPAQi y su entrada en Kepler; tú confirmas antes de guardar.</span>
      </div>
      <label class="cl-pick">
        <i class="pi pi-upload" aria-hidden="true"></i> Elegir archivos
        <input type="file" accept="application/pdf,.pdf,image/*" multiple hidden (change)="onPick($event)" />
      </label>
    </section>
    @if (aviso()) { <div class="cl-aviso" role="status">{{ aviso() }}</div> }
    @if (resumen(); as r) {
      <div class="cl-resumen" role="status">
        <i class="pi pi-check-circle ok" aria-hidden="true"></i>
        <span><strong>{{ r.guardados }} {{ r.guardados === 1 ? 'archivada' : 'archivadas' }}</strong>
          · <span class="ok">{{ r.pasanSolas }} {{ r.pasanSolas === 1 ? 'pasa sola' : 'pasan solas' }}</span>
          @if (r.guardados - r.pasanSolas) { · <span class="warn">{{ r.guardados - r.pasanSolas }} por revisar</span> }</span>
        @if (r.guardados - r.pasanSolas) {
          <button type="button" class="cl-link" (click)="verPorRevisar.emit()">Ver por revisar</button>
        }
        <button type="button" class="cl-xbtn cl-resumen-x" (click)="resumen.set(null)" aria-label="Cerrar resumen"><i class="pi pi-times" aria-hidden="true"></i></button>
      </div>
    }

    @if (filas().length) {
      <section class="cl-tray" aria-label="Facturas en captura">
        <header class="cl-head">
          <div class="cl-head-t">
            <strong>{{ filas().length }} {{ filas().length === 1 ? 'archivo' : 'archivos' }}</strong>
            <span class="cl-counts">
              @if (cuenta().procesando) { <span><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> {{ cuenta().procesando }} en proceso</span> }
              @if (cuenta().listos) { <span class="ok">{{ cuenta().listos }} listas</span> }
              @if (cuenta().porConfirmar) { <span class="warn">{{ cuenta().porConfirmar }} por confirmar</span> }
              @if (cuenta().sinEntrada) { <span class="bad">{{ cuenta().sinEntrada }} sin entrada</span> }
            </span>
          </div>
          <div class="cl-head-a">
            <button pButton type="button" size="small" text severity="secondary" (click)="descartarTodo()" [disabled]="guardando()"><span class="p-button-label">Descartar todo</span></button>
            <button pButton type="button" size="small" (click)="guardar()" [loading]="guardando()" [disabled]="!guardables().length || guardando()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
              <span class="p-button-label">Guardar {{ guardables().length || '' }}</span>
            </button>
          </div>
        </header>

        <div class="cl-body">
          <div class="cl-cols" aria-hidden="true">
            <span></span><span>Archivo</span><span>Lo que leyó la IA</span><span>CFDI y entrada de Kepler</span><span></span>
          </div>

          @for (f of filas(); track f.id) {
            <div class="cl-row" [attr.data-fase]="f.fase" [attr.data-conf]="f.ident?.confianza" [attr.data-cubo]="f.cubo">
              <div class="cl-chk">
                @if (f.fase === 'listo' && f.elegido) {
                  <input type="checkbox" [checked]="f.confirmado" (change)="toggle(f.id)" [disabled]="guardando()"
                         [attr.aria-label]="'Confirmo que ' + f.nombre + ' es de la entrada ' + f.elegido.folio" />
                } @else if (f.fase === 'guardado') {
                  @if (f.cubo === 'auto') { <i class="pi pi-check-circle ok" aria-label="Archivada, pasa sola"></i> }
                  @else { <i class="pi pi-exclamation-circle warn" aria-label="Archivada, por revisar"></i> }
                }
              </div>

              <div class="cl-file">
                <span class="cl-name" [title]="f.nombre">{{ f.nombre }}</span>
                <span class="cl-sub">
                  @switch (f.fase) {
                    @case ('preparando') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Convirtiendo la foto a PDF… }
                    @case ('en_cola') { En cola… }
                    @case ('leyendo') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo con IA… }
                    @case ('buscando') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando CFDI y entrada… }
                    @case ('guardando') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Archivando… }
                    @case ('duplicado') { <span class="bad">Repetido{{ f.copiaDe ? ': ' + f.copiaDe : '' }} — no se guarda</span> }
                    @case ('error') { <span class="bad">{{ f.error }}</span> }
                    @default { {{ kb(f.bytes) }}{{ f.deFoto ? ' · foto → PDF' : '' }} · {{ f.rol === 'factura' ? 'Factura' : 'Remisión' }} }
                  }
                </span>
              </div>

              <div class="cl-ocr">
                @if (f.ocr; as o) {
                  <span class="cl-monto">{{ o.total != null ? money(o.total) : 'sin total' }}</span>
                  <span class="cl-sub">{{ o.proveedor || 'sin proveedor' }}</span>
                  <span class="cl-sub">{{ o.folio ? 'Folio ' + o.folio : 'sin folio' }} · {{ o.fecha || 'sin fecha' }}</span>
                  <span class="cl-prueba">
                    <span class="cl-c" [attr.data-v]="v(o.sello_recibido)" [title]="o.sello_evidencia || ''">
                      <i class="pi" [ngClass]="ico(o.sello_recibido)" aria-hidden="true"></i> Sello
                    </span>
                    <span class="cl-c" [attr.data-v]="v(o.firma_recibido)">
                      <i class="pi" [ngClass]="ico(o.firma_recibido)" aria-hidden="true"></i> Firma
                    </span>
                    @if (o.uuid) { <span class="cl-c" data-v="ok" [title]="o.uuid"><i class="pi pi-check" aria-hidden="true"></i> UUID</span> }
                  </span>
                  @if (o.ocr_status === 'sin_key') { <span class="cl-sub bad">OCR no disponible</span> }
                } @else if (f.fase !== 'duplicado' && f.fase !== 'error') { <span class="cl-sub">—</span> }
              </div>

              <div class="cl-dest">
                @if (f.ident?.cfdi; as c) {
                  <span class="cl-sub">CFDI <span class="mono" [title]="c.uuid">{{ c.uuid.slice(0, 8) }}…</span> · {{ c.emisor_nombre || c.emisor_rfc }} · {{ money(c.total) }}
                    @if (f.ident?.liga && !f.ident?.liga?.exacta) { · <em class="warn">sugerido</em> }</span>
                } @else if (f.fase === 'listo') { <span class="cl-sub warn">Sin CFDI en ContPAQi</span> }

                @if (f.fase === 'guardado' && f.elegido) {
                  <span class="cl-pk"><span class="mono">{{ etiqueta(f.elegido) }}</span> · {{ f.elegido.proveedor_nombre || '—' }}</span>
                  <span class="cl-motivo" [attr.data-conf]="f.cubo === 'auto' ? 'listo' : 'revisar'">
                    {{ f.cubo === 'auto' ? 'Expediente: pasa sola' : 'Expediente: revisar' }}{{ f.motivoExpediente ? ' · ' + f.motivoExpediente : '' }}
                  </span>
                } @else if (f.fase === 'listo') {
                  @if (f.elegido; as p) {
                    <span class="cl-pk"><span class="mono">{{ etiqueta(p) }}</span> · {{ p.proveedor_nombre || '—' }}</span>
                    <span class="cl-sub">{{ p.receipt_date || '' }} · {{ money(p.monto) }}@if (p.deposits > 0) { · <em class="warn">ya tiene documento</em> }</span>
                    <span class="cl-motivo" [attr.data-conf]="f.ident?.confianza">{{ motivos(f) }}</span>
                    @if ((f.ident?.candidatas?.length || 0) > 1 || !esPropuesta(f, p)) { <button type="button" class="cl-link" (click)="cambiar(f.id)">Cambiar entrada</button> }
                  } @else if ((f.ident?.candidatas?.length || 0) > 1) {
                    <span class="cl-motivo" data-conf="elegir">{{ motivos(f) }}</span>
                    <div class="cl-cands" role="list">
                      @for (c of f.ident?.candidatas || []; track c.sucursal + c.folio) {
                        <button type="button" class="cl-cand" role="listitem" (click)="elegir(f.id, c)">
                          <span class="mono">{{ etiqueta(c) }}</span>
                          <span class="cl-cand-p">{{ c.proveedor_nombre || '—' }}</span>
                          <span class="cl-sub">{{ c.receipt_date || '' }} · {{ money(c.monto) }}@if (c.deposits > 0) { · <em class="warn">ya tiene documento</em> }</span>
                        </button>
                      }
                    </div>
                  } @else {
                    <span class="cl-motivo" data-conf="sin_entrada">{{ motivos(f) }}</span>
                    <div class="cl-search">
                      <input pInputText [ngModel]="f.busqueda" (ngModelChange)="setBusqueda(f.id, $event)" (keyup.enter)="buscar(f.id)"
                             placeholder="Folio de entrada, proveedor, monto…" [attr.aria-label]="'Buscar la entrada de ' + f.nombre" />
                      <button pButton type="button" size="small" text (click)="buscar(f.id)" [loading]="f.buscando" aria-label="Buscar"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                    </div>
                    @if (f.resultados.length) {
                      <div class="cl-cands" role="list">
                        @for (c of f.resultados; track c.sucursal + c.folio) {
                          <button type="button" class="cl-cand" role="listitem" (click)="elegir(f.id, c)">
                            <span class="mono">{{ etiqueta(c) }}</span>
                            <span class="cl-cand-p">{{ c.proveedor_nombre || '—' }}</span>
                            <span class="cl-sub">{{ c.receipt_date || '' }} · {{ money(c.monto) }}@if (c.deposits > 0) { · <em class="warn">ya tiene documento</em> }</span>
                          </button>
                        }
                      </div>
                    }
                  }
                }
              </div>

              <div class="cl-x">
                @if (f.fase !== 'guardando' && f.fase !== 'guardado') {
                  <button type="button" class="cl-xbtn" (click)="quitar(f.id)" [disabled]="guardando()" [attr.aria-label]="'Quitar ' + f.nombre"><i class="pi pi-times" aria-hidden="true"></i></button>
                }
              </div>
            </div>
          }
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .cl-drop { display: flex; align-items: center; gap: 1rem; padding: 1.4rem 1.2rem; border: 2px dashed var(--border-color);
      border-radius: var(--r-md, .5rem); background: var(--surface-card); transition: border-color .15s, background .15s; }
    .cl-drop.compact { padding: .8rem 1.1rem; }
    .cl-drop.drag { border-color: var(--action); background: color-mix(in srgb, var(--action) 6%, var(--surface-card)); }
    .cl-drop-ico { font-size: var(--fs-h1); color: var(--action); flex: 0 0 auto; }
    .cl-drop-txt { display: flex; flex-direction: column; gap: .15rem; flex: 1 1 auto; min-width: 0; }
    .cl-drop-txt strong { font-size: var(--fs-body); color: var(--fg-1); }
    .cl-drop-txt span { font-size: var(--fs-sm); color: var(--fg-2); }
    .cl-pick { display: inline-flex; align-items: center; gap: .45rem; padding: .55rem 1rem; border-radius: var(--r-sm, .4rem);
      background: var(--action); color: var(--action-ink, #fff); font-size: var(--fs-body); font-weight: 600; cursor: pointer; flex: 0 0 auto; }
    .cl-pick:hover { background: var(--action-hover); }
    .cl-pick:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .cl-drop { transition: none; } }
    .cl-aviso { margin-top: .5rem; font-size: var(--fs-sm); color: var(--warn-fg); }
    .cl-resumen { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-top: .75rem; padding: .55rem .9rem;
      border: 1px solid var(--ok-border, var(--border-color)); border-radius: var(--r-md, .5rem); background: var(--ok-soft-bg);
      font-size: var(--fs-sm); color: var(--fg-1); }
    .cl-resumen-x { margin-left: auto; }

    .cl-tray { margin-top: .75rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-card); overflow: hidden; }
    .cl-body { max-height: min(60vh, 40rem); overflow-y: auto; overscroll-behavior: contain; }
    .cl-head { display: flex; align-items: center; justify-content: space-between; gap: .8rem; flex-wrap: wrap; padding: .6rem .9rem;
      border-bottom: 1px solid var(--border-color); }
    .cl-head-t { display: flex; align-items: baseline; gap: .9rem; flex-wrap: wrap; font-size: var(--fs-body); color: var(--fg-1); }
    .cl-counts { display: inline-flex; gap: .8rem; font-size: var(--fs-xs); color: var(--fg-2); }
    .cl-head-a { display: flex; align-items: center; gap: .4rem; }
    .ok { color: var(--ok-fg); } .warn { color: var(--warn-fg); } .bad { color: var(--bad-fg); }

    .cl-cols, .cl-row { display: grid; grid-template-columns: 2rem minmax(10rem, 1fr) minmax(10rem, 1fr) minmax(16rem, 2fr) 2rem; gap: .8rem; align-items: start; }
    .cl-cols { position: sticky; top: 0; z-index: 1; background: var(--surface-card); padding: .4rem .9rem; font-size: var(--fs-micro);
      text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); border-bottom: 1px solid var(--border-color); }
    .cl-row { padding: .6rem .9rem; border-bottom: 1px solid var(--border-color); border-left: 3px solid transparent; }
    .cl-row:last-child { border-bottom: 0; }
    .cl-row[data-conf="listo"] { border-left-color: var(--ok-fg); }
    .cl-row[data-conf="revisar"], .cl-row[data-conf="elegir"] { border-left-color: var(--warn-fg); }
    .cl-row[data-conf="sin_entrada"], .cl-row[data-fase="error"], .cl-row[data-fase="duplicado"] { border-left-color: var(--bad-fg); }
    .cl-row[data-fase="guardado"] { background: var(--ok-soft-bg); border-left-color: var(--ok-fg); }
    .cl-row[data-fase="guardado"][data-cubo="revisar"] { background: var(--warn-soft-bg); border-left-color: var(--warn-fg); }
    .cl-chk { padding-top: .15rem; display: flex; justify-content: center; }
    .cl-chk input { width: 1.05rem; height: 1.05rem; accent-color: var(--action); cursor: pointer; }
    .cl-file, .cl-ocr, .cl-dest { display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
    .cl-name { font-size: var(--fs-body); color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cl-sub { font-size: var(--fs-xs); color: var(--fg-2); }
    .cl-sub .pi { font-size: var(--fs-xs); }
    .cl-sub em, .cl-cand em { font-style: normal; }
    .cl-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
    .cl-pk { font-size: var(--fs-body); color: var(--fg-1); }
    .mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
    .cl-prueba { display: flex; gap: .3rem; flex-wrap: wrap; }
    .cl-c { display: inline-flex; align-items: center; gap: .25rem; font-size: var(--fs-micro); font-weight: 600; padding: .05rem .4rem;
      border-radius: var(--r-sm, .4rem); border: 1px solid currentColor; }
    .cl-c .pi { font-size: var(--fs-nano); }
    .cl-c[data-v="ok"] { color: var(--ok-fg); }
    .cl-c[data-v="no"] { color: var(--bad-fg); }
    .cl-c[data-v="sin_dato"] { color: var(--warn-fg); border-style: dashed; }
    .cl-motivo { font-size: var(--fs-xs); font-weight: 600; }
    .cl-motivo[data-conf="listo"] { color: var(--ok-fg); }
    .cl-motivo[data-conf="revisar"], .cl-motivo[data-conf="elegir"] { color: var(--warn-fg); }
    .cl-motivo[data-conf="sin_entrada"] { color: var(--bad-fg); }
    .cl-link { align-self: flex-start; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .cl-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cl-cands { display: flex; flex-direction: column; gap: .3rem; }
    .cl-cand { display: grid; grid-template-columns: auto 1fr; gap: .1rem .6rem; text-align: left; padding: .4rem .6rem; border: 1px solid var(--border-color);
      border-radius: var(--r-sm, .4rem); background: var(--surface-ground); color: var(--fg-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cl-cand:hover { border-color: var(--action); }
    .cl-cand:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cl-cand .cl-sub { grid-column: 1 / -1; }
    .cl-cand-p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cl-search { display: flex; gap: .3rem; }
    .cl-search input { flex: 1 1 auto; font-size: var(--fs-sm); }
    .cl-x { display: flex; justify-content: center; }
    .cl-xbtn { border: 0; background: none; color: var(--fg-3); cursor: pointer; padding: .2rem .3rem; border-radius: var(--r-sm, .4rem); }
    .cl-xbtn:hover { color: var(--bad-fg); background: var(--hover-bg); }
    .cl-xbtn:focus-visible { outline: 2px solid var(--focus-ring); }
    @media (max-width: 47.5rem) {
      .cl-drop { flex-wrap: wrap; }
      .cl-cols { display: none; }
      .cl-row { grid-template-columns: 2rem 1fr 2rem; }
      .cl-file { grid-column: 2; } .cl-x { grid-column: 3; grid-row: 1; }
      .cl-ocr, .cl-dest { grid-column: 2 / 4; }
    }
  `],
})
export class ComprasCapturaLoteComponent {
  private readonly svc = inject(EntradasService);
  private readonly destroyRef = inject(DestroyRef);

  /** Se archivaron facturas: la página recarga su tabla. */
  readonly guardados = output<CapturaLoteGuardada>();
  /** «Ver por revisar» del resumen: la página abre esa bandeja. */
  readonly verPorRevisar = output<void>();
  /** Archivos que llegan de afuera (lo soltado en la barra de costo por compra). Cada arreglo nuevo se agrega una vez. */
  readonly entrantes = input<File[] | null>(null);

  readonly filas = signal<FilaLote[]>([]);
  readonly arrastrando = signal(false);
  readonly guardando = signal(false);
  readonly aviso = signal('');
  readonly resumen = signal<CapturaLoteGuardada | null>(null);
  private seq = 0;
  private activos = 0;
  private destruido = false;

  constructor() {
    this.destroyRef.onDestroy(() => { this.destruido = true; });
    effect(() => {
      const files = this.entrantes();
      if (files?.length) untracked(() => this.agregar(files));
    });
  }

  readonly guardables = computed(() => this.filas().filter((f) => f.fase === 'listo' && !!f.elegido && f.confirmado));
  readonly cuenta = computed(() => {
    const l = this.filas();
    return {
      procesando: l.filter((f) => f.fase === 'preparando' || f.fase === 'en_cola' || f.fase === 'leyendo' || f.fase === 'buscando').length,
      listos: l.filter((f) => f.fase === 'listo' && f.confirmado).length,
      porConfirmar: l.filter((f) => f.fase === 'listo' && !f.confirmado && (!!f.elegido || f.ident?.confianza === 'elegir')).length,
      sinEntrada: l.filter((f) => f.fase === 'listo' && !f.elegido && f.ident?.confianza === 'sin_entrada').length,
    };
  });

  // ── formato ────────────────────────────────────────────────────────────────
  money(v: number | string | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }
  kb(b: number): string { return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }
  etiqueta(d: { sucursal: string; folio: string }): string { return `${branchName(d.sucursal)} · ${d.folio}`; }
  v(b: boolean | null | undefined): 'ok' | 'no' | 'sin_dato' { return b === true ? 'ok' : b === false ? 'no' : 'sin_dato'; }
  ico(b: boolean | null | undefined): string { return b === true ? 'pi-check' : b === false ? 'pi-times' : 'pi-question'; }
  motivos(f: FilaLote): string { return (f.ident?.motivos || []).map(textoMotivoIdentificacion).join(' · '); }
  esPropuesta(f: FilaLote, d: Destino): boolean { return f.ident?.propuesta?.sucursal === d.sucursal && f.ident?.propuesta?.folio === d.folio; }

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

  /** Lo usa la barra de costo por compra: lo que se suelta ahí con más de un archivo cae aquí. */
  async agregar(files: File[]) {
    this.resumen.set(null);
    const omitidos: string[] = [];
    for (const original of files) {
      const foto = esImagen(original);
      if (!esPdf(original) && !foto) { omitidos.push(`${original.name} (no es PDF ni foto)`); continue; }
      if (original.size > MAX_BYTES * (foto ? 3 : 1)) { omitidos.push(`${original.name} (demasiado grande)`); continue; }
      let file = original;
      // Cada foto es UNA recepción: se convierte a su propio PDF (el servidor sólo recibe PDF).
      if (foto) {
        try { file = await imagenesAPdf([original], original.name.replace(/\.[^.]+$/, '') + '.pdf'); }
        catch { omitidos.push(`${original.name} (no se pudo convertir la foto)`); continue; }
      }
      if (file.size > MAX_BYTES) { omitidos.push(`${original.name} (más de 10 MB)`); continue; }
      let dataUri: string;
      try { dataUri = await this.leer(file); } catch { omitidos.push(`${original.name} (no se pudo leer)`); continue; }
      const igual = this.filas().find((f) => f.fase !== 'guardado' && f.bytes === file.size && f.dataUri === dataUri);
      this.filas.update((l) => l.concat(this.nueva(original.name, file.size, dataUri, foto, igual?.nombre ?? null)));
    }
    this.aviso.set(omitidos.length ? `No se agregaron: ${omitidos.join(' · ')}.` : '');
    this.bombear();
  }

  private nueva(nombre: string, bytes: number, dataUri: string, deFoto: boolean, copiaDe: string | null): FilaLote {
    return {
      id: ++this.seq, nombre, bytes, dataUri, deFoto, fase: copiaDe ? 'duplicado' : 'en_cola', copiaDe,
      ocr: null, rol: 'factura', ident: null, elegido: null, confirmado: false,
      busqueda: '', resultados: [], buscando: false, cubo: null, motivoExpediente: null, error: null,
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
    let ocr: RemisionOcr;
    try {
      ocr = await firstValueFrom(this.svc.ocr(f.dataUri, 'factura'));
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message;
      this.patch(id, { fase: 'error', error: msg || 'No se pudo leer el archivo' });
      return;
    }
    if (!this.fila(id)) return;
    const gemela = ocr.sha256 ? this.filas().find((o) => o.id !== id && o.ocr?.sha256 === ocr.sha256) : undefined;
    if (gemela) { this.patch(id, { ocr, fase: 'duplicado', copiaDe: gemela.nombre }); return; }
    if (ocr.duplicate) {
      this.patch(id, { ocr, fase: 'duplicado', copiaDe: `ya está archivada en ${this.etiqueta(ocr.duplicate)}` });
      return;
    }
    // Qué es el papel: la orden de entrada de Kepler no es la factura del proveedor.
    const tipos = (ocr.documents_present || []).map((d) => d.type);
    if (tipos.length && tipos.every((t) => t === 'aplica_orden_entrada' || t === 'vale' || t === 'otro')) {
      this.patch(id, { ocr, fase: 'error', error: 'Es una hoja interna (orden de entrada o vale), no la factura del proveedor' });
      return;
    }
    const rol: 'factura' | 'remision' = tipos.includes('factura') || !!ocr.uuid ? 'factura' : tipos.includes('remision') ? 'remision' : 'factura';
    this.patch(id, { ocr, rol, fase: 'buscando', busqueda: ocr.proveedor || '' });
    let ident: IdentificacionEntrada;
    try {
      ident = await firstValueFrom(this.svc.identificar({
        uuid: ocr.uuid ?? null, rfc: ocr.rfc, proveedor: ocr.proveedor, folio: ocr.folio, total: ocr.total, fecha: ocr.fecha,
        sello: ocr.sello_recibido ?? null, firma: ocr.firma_recibido ?? null,
      }));
    } catch {
      this.patch(id, { fase: 'listo', ident: { cfdi: null, liga: null, candidatas: [], confianza: 'sin_entrada', propuesta: null, motivos: ['sin_candidatas'] } });
      return;
    }
    const prop = ident.propuesta
      ? ident.candidatas.find((c) => c.sucursal === ident.propuesta?.sucursal && c.folio === ident.propuesta?.folio) ?? null
      : null;
    this.patch(id, { fase: 'listo', ident, elegido: prop ? this.destino(prop) : null, confirmado: ident.confianza === 'listo' });
  }

  private destino(c: IdentificacionCandidata | Destino): Destino {
    return { sucursal: c.sucursal, folio: c.folio, proveedor_nombre: c.proveedor_nombre, monto: Number(c.monto), receipt_date: c.receipt_date, deposits: c.deposits };
  }

  // ── acciones de la persona ─────────────────────────────────────────────────
  toggle(id: number) { const f = this.fila(id); if (f) this.patch(id, { confirmado: !f.confirmado }); }
  elegir(id: number, c: IdentificacionCandidata | Destino) { this.patch(id, { elegido: this.destino(c), confirmado: true, resultados: [] }); }
  cambiar(id: number) { this.patch(id, { elegido: null, confirmado: false }); }
  setBusqueda(id: number, v: string) { this.patch(id, { busqueda: v }); }
  async buscar(id: number) {
    const f = this.fila(id);
    const q = f?.busqueda.trim();
    if (!f || !q) return;
    this.patch(id, { buscando: true });
    try {
      const r = await firstValueFrom(this.svc.matchByOcr({ search: q }));
      this.patch(id, {
        buscando: false,
        resultados: (r.entradas || []).slice(0, 8).map((e) => ({
          sucursal: e.sucursal, folio: e.folio, proveedor_nombre: e.proveedor_nombre ?? null, monto: Number(e.monto),
          receipt_date: e.receipt_date ? String(e.receipt_date).slice(0, 10) : null, deposits: Number(e.deposits) || 0,
        })),
      });
    } catch {
      this.patch(id, { buscando: false, resultados: [] });
    }
  }
  quitar(id: number) { this.filas.update((l) => l.filter((f) => f.id !== id)); }
  descartarTodo() { this.filas.update((l) => l.filter((f) => f.fase === 'guardando')); this.aviso.set(''); }

  /** El clic de confirmación: sube y adjunta, uno por uno, lo que la persona dejó marcado. */
  async guardar() {
    const lote = this.guardables();
    if (!lote.length || this.guardando()) return;
    this.guardando.set(true);
    let ok = 0;
    let pasan = 0;
    for (const f of lote) {
      const d = f.elegido as Destino;
      this.patch(f.id, { fase: 'guardando' });
      try {
        const subido = await firstValueFrom(this.svc.uploadFile(f.dataUri, f.rol));
        const o = f.ocr;
        const hoja: ProofFile = {
          ...subido, role: f.rol, name: f.nombre, sha256: o?.sha256,
          ocr_folio: o?.folio ?? null, ocr_total: o?.total ?? null, ocr_fecha: o?.fecha ?? null, ocr_rfc: o?.rfc ?? null,
        };
        await firstValueFrom(this.svc.attach({ sucursal: d.sucursal, folio: d.folio, files: [hoja], ocr: o ?? undefined }));
        // El veredicto lo da el expediente del servidor, no esta pantalla.
        let cubo: ExpedienteCubo | null = null;
        let motivo: string | null = null;
        try {
          const x = await firstValueFrom(this.svc.expediente(d.sucursal, d.folio));
          cubo = x.cubo; motivo = x.motivos[0] ?? null;
        } catch { /* el papel ya quedó archivado; el veredicto se ve en el listado */ }
        this.patch(f.id, { fase: 'guardado', cubo, motivoExpediente: motivo });
        ok++;
        if (cubo === 'auto') pasan++;
      } catch (e: unknown) {
        const msg = (e as { error?: { message?: string } })?.error?.message;
        this.patch(f.id, { fase: 'listo' });
        this.aviso.set(`No se pudo guardar ${f.nombre}${msg ? `: ${msg}` : ''}.`);
      }
    }
    this.guardando.set(false);
    // Como en pagos ([PC.8]): lo archivado SALE de la lista y queda el resumen. Se quedan sólo las
    // filas que todavía piden algo (sin confirmar, sin entrada, con error); la pantalla queda limpia
    // para el siguiente lote. Lo que quedó por revisar vive en la bandeja «Por revisar».
    if (ok) {
      this.filas.update((l) => l.filter((f) => f.fase !== 'guardado'));
      this.resumen.set({ guardados: ok, pasanSolas: pasan });
      this.guardados.emit({ guardados: ok, pasanSolas: pasan });
    }
  }

  private fila(id: number): FilaLote | undefined { return this.filas().find((f) => f.id === id); }
  private patch(id: number, p: Partial<FilaLote>) {
    if (this.destruido) return;
    this.filas.update((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)));
  }
}
