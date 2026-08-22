import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { SkeletonModule } from 'primeng/skeleton';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ComprobacionesService, ExpenseProofDetail, ProofFile } from '../comprobaciones.service';
import { ExpenseRequestRow } from '../../comercial/comercial.service';
import { money } from '../../../shared/util';
import { dmy } from '../pages/finanzas-format';

/** Un adjunto listo para pintar. `safeUrl` se sanitiza UNA vez: hacerlo en el template
 *  recrearía el iframe en cada ciclo de detección. */
interface PeekDoc { role: string; label: string; url: string; isPdf: boolean; safeUrl: SafeResourceUrl | null; failed: boolean; }

const ETIQUETAS: Record<string, string> = {
  comprobante_1: 'Comprobante — hoja 1', comprobante_2: 'Comprobante — hoja 2',
  evidencia_1: 'Evidencia 1', evidencia_2: 'Evidencia 2', evidencia_3: 'Evidencia 3',
  solicitud_kepler: 'Solicitud de gasto firmada',
};

/**
 * Expediente de una solicitud de gasto: lo que dice Kepler + la evidencia que tenemos,
 * y la decisión, en un solo lugar y sin perder la lista.
 *
 * Vive fuera de la página porque reemplaza a la bandeja `/finanzas/comprobaciones`, que
 * existía sólo para volver a mostrar datos que Kepler ya tiene. El tablero es
 * `/finanzas/solicitudes`; esto es su detalle.
 *
 * Las URLs de los adjuntos se piden AL ABRIR: la lista las firma con TTL de 10 min y
 * quien revisa trabaja la bandeja un buen rato.
 */
@Component({
  selector: 'app-expense-evidence-peek',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, TagModule, TextareaModule, SkeletonModule, SelectButtonModule, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-side-peek [open]="open()" (openChange)="onToggle($event)"
                   title="Expediente de la solicitud" [subtitle]="sub()">
      @if (solicitud(); as s) {
        <!-- Q.1 — la conclusión primero: ¿esto se puede autorizar? -->
        <div class="ep-verdict" [class.ok]="tono() === 'ok'" [class.warn]="tono() === 'warn'" [class.mute]="tono() === 'mute'">
          <i class="pi" [class.pi-check-circle]="tono() === 'ok'" [class.pi-exclamation-circle]="tono() === 'warn'"
             [class.pi-inbox]="tono() === 'mute'" aria-hidden="true"></i>
          <div>
            <h3>{{ titulo() }}</h3>
            <p>{{ lectura() }}</p>
          </div>
        </div>

        <div class="ep-tri">
          <div><span class="ep-k">Solicitud Kepler</span><span class="ep-v">{{ money(s.importe) }}</span><span class="ep-m">{{ s.folio }}</span></div>
          <div><span class="ep-k">Leído del comprobante</span><span class="ep-v">{{ proof()?.monto_ocr != null ? money(proof()!.monto_ocr!) : '—' }}</span><span class="ep-m">{{ proof()?.monto_ocr != null ? 'Claude Vision' : 'sin lectura' }}</span></div>
          <div><span class="ep-k">Diferencia</span><span class="ep-v">{{ diffTxt() }}</span><span class="ep-m">tolera $1 o 1%</span></div>
        </div>

        @if (proof()?.status === 'validada' && proof()?.tiene_comprobacion != null) {
          <p class="ep-note" [class.is-ok]="proof()!.tiene_comprobacion">
            <i class="pi" [class.pi-check-circle]="proof()!.tiene_comprobacion" [class.pi-minus-circle]="!proof()!.tiene_comprobacion" aria-hidden="true"></i>
            {{ proof()!.tiene_comprobacion ? 'Declarado CON comprobación' : 'Declarado SIN comprobación' }}{{ proof()!.comprobacion_nota ? ' — ' + proof()!.comprobacion_nota : '' }}
          </p>
        }
        @if (proof()?.status === 'revision' && proof()?.revision_nota) { <p class="ep-note"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ proof()!.revision_nota }}</p> }
        @if (proof()?.status === 'rechazada' && proof()?.motivo_rechazo) { <p class="ep-note is-bad"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ proof()!.motivo_rechazo }}</p> }

        <!-- Lo primero que necesita quien aprueba: qué hay y qué falta. -->
        <h4 class="ep-sec">Expediente</h4>
        <ul class="ep-check">
          <li [class.ok]="tieneComprobante()" [class.no]="!tieneComprobante()">
            <i class="pi" [class.pi-check-circle]="tieneComprobante()" [class.pi-times-circle]="!tieneComprobante()" aria-hidden="true"></i>
            <span>Comprobante del gasto</span>
            <em>{{ tieneComprobante() ? 'adjunto' : 'obligatorio — sin esto no se aprueba' }}</em>
            @if (!tieneComprobante()) { <button type="button" class="ep-add" (click)="attach.emit()">Agregar</button> }
          </li>
          <li [class.ok]="tieneSolicitud()" [class.warn]="!tieneSolicitud()">
            <i class="pi" [class.pi-check-circle]="tieneSolicitud()" [class.pi-minus-circle]="!tieneSolicitud()" aria-hidden="true"></i>
            <span>Solicitud firmada</span>
            <em>{{ tieneSolicitud() ? 'adjunta' : 'falta — es la evidencia de la autorización' }}</em>
            @if (!tieneSolicitud()) { <button type="button" class="ep-add" (click)="attach.emit()">Agregar</button> }
          </li>
          <li [class.ok]="comprobacionOk()" [class.warn]="!comprobacionOk()">
            <i class="pi" [class.pi-check-circle]="comprobacionOk()" [class.pi-minus-circle]="!comprobacionOk()" aria-hidden="true"></i>
            <span>Comprobación (XA1001)</span>
            <em>{{ comprobacionTxt() }}</em>
          </li>
        </ul>

        <h4 class="ep-sec">Evidencia</h4>
        @if (loading()) {
          <p-skeleton height="12rem" />
        } @else if (docs().length) {
          @for (d of docs(); track d.url) {
            <figure class="ep-doc">
              <figcaption>{{ d.label }}</figcaption>
              @if (d.failed) {
                <div class="ep-broken">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  <span>No se pudo cargar el archivo. El enlace se firma al abrir y expira; cerrá y volvé a abrir. Si sigue, hay que volver a subirlo.</span>
                </div>
              } @else if (d.isPdf) {
                <iframe [src]="d.safeUrl" [title]="d.label" class="ep-frame"></iframe>
              } @else {
                <img [src]="d.url" [alt]="d.label" class="ep-img" (error)="onDocError(d.url)" />
              }
              <a [href]="d.url" target="_blank" rel="noopener" class="ep-open"><i class="pi pi-external-link" aria-hidden="true"></i> Abrir a tamaño completo</a>
            </figure>
          }
        } @else {
          <div class="ep-broken">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <span>{{ proof()?.storage_ok === false ? 'Hay adjuntos pero el almacenamiento no está configurado en el servidor — avisá a sistemas.' : 'Esta solicitud todavía no tiene evidencia adjunta.' }}</span>
          </div>
          <button pButton type="button" class="p-button-sm" (click)="attach.emit()">
            <span class="p-button-icon p-button-icon-left pi pi-upload" aria-hidden="true"></span>
            <span class="p-button-label">Adjuntar evidencia</span></button>
        }

        <!-- Lo que Kepler ya sabe. Antes había que teclearlo de nuevo en otra pantalla. -->
        <h4 class="ep-sec">Lo que dice Kepler</h4>
        <dl class="ep-dl">
          <dt>Fecha</dt><dd>{{ s.fecha ? dmy(s.fecha) : '—' }}</dd>
          <dt>Solicitante</dt><dd>{{ s.solicitante || '—' }}</dd>
          <dt>Beneficiario</dt><dd>{{ s.acreedor || s.beneficiario || '—' }}</dd>
          @if (s.cuenta_clave) { <dt>Cuenta</dt><dd class="ep-mono">{{ s.cuenta_clave }}<span class="ep-grp">{{ s.cuenta_grupo }}</span></dd> }
          @if (s.rfc || s.acreedor_rfc) { <dt>RFC</dt><dd class="ep-mono">{{ s.rfc || s.acreedor_rfc }}</dd> }
          <dt>Concepto</dt><dd>{{ s.concepto || '—' }}</dd>
          @if (s.iva) { <dt>IVA</dt><dd class="ep-mono">{{ money(s.iva) }}</dd> }
          @if (s.forma_pago) { <dt>Forma de pago</dt><dd>{{ formaPago(s.forma_pago) }}</dd> }
          @if (s.autoriza) { <dt>Autoriza</dt><dd>{{ s.autoriza }}</dd> }
          @if (s.referencia) { <dt>Referencia</dt><dd>{{ s.referencia }}</dd> }
          <dt>Sucursal</dt><dd>{{ s.sucursal_nombre || s.sucursal || '—' }}</dd>
          <dt>Aplicación</dt><dd>{{ s.aplicada ? ('Gasto ' + (s.gasto_folio || '')) : 'Sin aplicar' }}</dd>
        </dl>

        @if (puedeResolver() && proof()) {
          <div class="ep-acts">
            @if (proof()!.status !== 'validada') {
              <button pButton type="button" severity="success" [loading]="acting()" [disabled]="acting() || !tieneComprobante()" (click)="abrirValidar()"
                      [title]="tieneComprobante() ? 'Marcar el expediente como validado' : 'Sin comprobante no se puede validar'">
                <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Validado</span></button>
            }
            @if (proof()!.status !== 'rechazada') {
              <button pButton type="button" severity="danger" text [disabled]="acting()" (click)="showReject.set(true)">
                <span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">No validado</span></button>
            }
          </div>
        }
      }
    </app-side-peek>

    <!-- Validar exige declarar si el gasto lleva comprobación: hay solicitudes que nunca
         la generan, y sin este dato no se distingue «no llegó» de «no va a llegar». -->
    <p-dialog [visible]="showValidar()" (visibleChange)="showValidar.set($event)" [modal]="true"
              [style]="{ width: '28rem' }" [draggable]="false" header="Validar el gasto">
      <p class="ep-dlg-hint">¿Este gasto tiene comprobación en Kepler (XA1001)?</p>
      <p-selectbutton [options]="siNo" [(ngModel)]="tieneComp" optionLabel="label" optionValue="value"
                      [allowEmpty]="false" ariaLabelledBy="Tiene comprobación" />
      <p class="ep-dlg-hint ep-dlg-sub">
        {{ tieneComp === false ? 'Decí por qué no la lleva — es lo que va a leer quien revise esto después.' : 'Opcional: el folio de la comprobación, si lo tenés a mano.' }}
      </p>
      <textarea pTextarea [(ngModel)]="compNota" rows="2" class="ep-dlg-txt"
                [placeholder]="tieneComp === false ? 'Ej. reembolso de caja chica, no genera comprobación' : 'Ej. folio 0004312'"></textarea>
      <ng-template #footer>
        <button pButton type="button" text (click)="showValidar.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="success" [disabled]="tieneComp === null || (tieneComp === false && !compNota.trim())"
                (click)="confirmarValidacion()"><span class="p-button-label">Validar</span></button>
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="showReject()" (visibleChange)="showReject.set($event)" [modal]="true"
              [style]="{ width: '26rem' }" [draggable]="false" header="Marcar como NO validado">
      <p class="ep-dlg-hint">El motivo lo lee quien capturó, así que decí qué corregir.</p>
      <textarea pTextarea [(ngModel)]="motivo" rows="3" class="ep-dlg-txt"
                placeholder="Ej. comprobante ilegible, no corresponde a la solicitud…"></textarea>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [disabled]="!motivo.trim()" (click)="rechazar()">
          <span class="p-button-label">No validado</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ep-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3);
      border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-md); }
    .ep-verdict.ok { border-left-color: var(--ok-fg); }
    .ep-verdict.warn { border-left-color: var(--warn-fg); }
    .ep-verdict.mute { border-left-color: var(--border-color); }
    .ep-verdict > i { font-size: var(--fs-h3); }
    .ep-verdict.ok > i { color: var(--ok-fg); }
    .ep-verdict.warn > i { color: var(--warn-fg); }
    .ep-verdict.mute > i { color: var(--fg-3); }
    .ep-verdict h3 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--fg-1); }
    .ep-verdict p { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45; }

    .ep-tri { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); margin-top: var(--sp-3); }
    .ep-tri > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .ep-k { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em; color: var(--fg-3); }
    .ep-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-h3);
      font-weight: var(--fw-bold); color: var(--fg-1); }
    .ep-m { font-size: var(--fs-xs); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .ep-note { display: flex; gap: var(--sp-2); margin: var(--sp-3) 0 0; font-size: var(--fs-sm); color: var(--warn-fg); line-height: 1.4; }
    .ep-note.is-bad { color: var(--bad-fg); }
    .ep-sec { margin: var(--sp-5) 0 var(--sp-2); font-size: var(--fs-micro); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); font-weight: var(--fw-medium); }

    .ep-doc { margin: 0 0 var(--sp-4); }
    .ep-doc figcaption { font-size: var(--fs-xs); color: var(--fg-2); margin-bottom: var(--sp-1); }
    .ep-img { display: block; width: 100%; height: auto; max-height: 60vh; object-fit: contain;
      background: var(--layout-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ep-frame { display: block; width: 100%; height: 55vh; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--layout-bg); }
    .ep-open { display: inline-flex; align-items: center; gap: var(--sp-1); margin-top: var(--sp-1);
      font-size: var(--fs-xs); color: var(--action); text-decoration: none; }
    .ep-open:hover { text-decoration: underline; }
    .ep-broken { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3); margin-bottom: var(--sp-2);
      font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45;
      border: 1px dashed var(--border-color); border-radius: var(--r-sm); }
    .ep-broken i { color: var(--warn-fg); }

    /* Checklist: el estado es icono + texto, nunca sólo color. */
    .ep-check { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ep-check li { display: flex; align-items: baseline; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--fg-1); }
    .ep-check li > i { font-size: var(--fs-body); }
    .ep-check li.ok > i { color: var(--ok-fg); }
    .ep-check li.warn > i { color: var(--warn-fg); }
    .ep-check li.no > i { color: var(--bad-fg); }
    .ep-check em { font-style: normal; font-size: var(--fs-xs); color: var(--fg-3); }
    .ep-add { margin-left: auto; border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-xs);
      color: var(--action); cursor: pointer; text-decoration: underline; }
    .ep-add:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }

    .ep-dl { display: grid; grid-template-columns: 9rem 1fr; gap: var(--sp-1) var(--sp-3); margin: 0; }
    .ep-dl dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .ep-dl dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .ep-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ep-grp { display: inline-block; margin-left: var(--sp-1); padding: 0 4px; font-size: var(--fs-nano);
      color: var(--fg-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ep-acts { display: flex; gap: var(--sp-2); margin-top: var(--sp-5);
      padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .ep-dlg-hint { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45; }
    .ep-dlg-sub { margin: var(--sp-3) 0 var(--sp-2); font-size: var(--fs-xs); }
    .ep-note.is-ok { color: var(--ok-fg); }
    .ep-dlg-txt { width: 100%; font-size: var(--fs-sm); }
  `],
})
export class ExpenseEvidencePeekComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = model(false);
  /** La fila de Kepler (autoridad). Trae los 23 campos de la vista viva. */
  readonly solicitud = input<ExpenseRequestRow | null>(null);
  /** Id del comprobante ya capturado, si existe (viene del mapa folio→estado). */
  readonly proofId = input<string | null>(null);
  /** Quien puede validar/rechazar. Lo decide la página; acá sólo se respeta. */
  readonly puedeResolver = input(false);
  /** ¿La comprobación (XA1001) ya existe? Lo sabe el tablero, no este detalle. */
  readonly comprobacionEnKepler = input(false);

  readonly resolved = output<void>();
  readonly attach = output<void>();

  readonly proof = signal<ExpenseProofDetail | null>(null);
  readonly docs = signal<PeekDoc[]>([]);
  readonly loading = signal(false);
  readonly acting = signal(false);
  readonly showReject = signal(false);
  motivo = '';
  readonly showValidar = signal(false);
  readonly siNo = [{ label: 'Sí, tiene', value: true }, { label: 'No lleva', value: false }];
  tieneComp: boolean | null = null;
  compNota = '';

  readonly money = money;
  readonly dmy = dmy;

  constructor() {
    // Al abrir con un comprobante, se piden URLs frescas. Sin comprobante, no hay nada
    // que traer: el expediente se arma solo con Kepler.
    effect(() => {
      const id = this.proofId();
      if (!this.open()) return;
      this.proof.set(null); this.docs.set([]);
      if (!id) return;
      this.loading.set(true);
      this.svc.detail(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.proof.set(d); this.buildDocs(d.files || []); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
    });
  }

  onToggle(v: boolean) {
    this.open.set(v);
    if (!v) { this.docs.set([]); this.proof.set(null); } // suelta los iframes
  }

  sub(): string {
    const s = this.solicitud();
    return s ? `${s.folio} · ${s.acreedor || s.beneficiario || 's/beneficiario'}` : '';
  }

  private buildDocs(files: ProofFile[]) {
    this.docs.set((files || []).filter((f) => f?.url).map((f) => {
      const isPdf = f.kind === 'pdf' || /\.pdf(\?|$)/i.test(f.url);
      const role = String(f.role);
      return {
        role, label: ETIQUETAS[role] || role, url: f.url, isPdf,
        safeUrl: isPdf ? this.sanitizer.bypassSecurityTrustResourceUrl(f.url) : null,
        failed: false,
      };
    }));
  }
  readonly tieneComprobante = computed(() => this.docs().some((d) => d.role.startsWith('comprobante')));
  readonly tieneSolicitud = computed(() => this.docs().some((d) => d.role === 'solicitud_kepler'));
  /** Resuelta = ya existe en Kepler, o quien validó declaró que no lleva. */
  readonly comprobacionOk = computed(() =>
    this.comprobacionEnKepler() || this.proof()?.tiene_comprobacion === false);
  comprobacionTxt(): string {
    if (this.comprobacionEnKepler()) return 'registrada en Kepler';
    const d = this.proof()?.tiene_comprobacion;
    if (d === false) return `no lleva — ${this.proof()?.comprobacion_nota || 'sin motivo'}`;
    if (d === true) return 'declarada, y todavía no aparece en Kepler';
    return 'sin declarar — se pregunta al validar';
  }

  onDocError(url: string) {
    this.docs.update((ds) => ds.map((d) => d.url === url ? { ...d, failed: true } : d));
  }

  // ── Veredicto ────────────────────────────────────────────────────────────
  readonly tono = computed<'ok' | 'warn' | 'mute'>(() => {
    const p = this.proof();
    if (!p) return 'mute';
    if (p.status === 'rechazada') return 'warn';
    return p.monto_match === true ? 'ok' : 'warn';
  });
  titulo(): string {
    const p = this.proof();
    if (!p) return 'Sin evidencia';
    if (p.status === 'rechazada') return 'Comprobante rechazado';
    if (p.monto_match === true) return 'El comprobante cuadra';
    if (p.monto_ocr == null) return 'Sin lectura automática';
    return `Difiere ${money(Math.abs((this.solicitud()?.importe || 0) - p.monto_ocr))}`;
  }
  lectura(): string {
    const s = this.solicitud();
    const p = this.proof();
    const sol = money(s?.importe || 0);
    if (!p) return `La solicitud ${s?.folio} pide ${sol} y todavía no tiene comprobante adjunto.`;
    if (p.status === 'rechazada') return 'Se pidió corregir el comprobante. Hasta que se vuelva a subir, la solicitud queda sin respaldo válido.';
    if (p.monto_match === true) return `Claude Vision leyó ${money(p.monto_ocr ?? 0)} y la solicitud ${s?.folio} pide ${sol}.`;
    if (p.monto_ocr == null) return `No hay lectura automática. Revisá la foto a ojo contra los ${sol} de la solicitud ${s?.folio}.`;
    return `La solicitud ${s?.folio} pide ${sol} y el comprobante dice ${money(p.monto_ocr)}. Revisá antes de validar.`;
  }
  diffTxt(): string {
    const p = this.proof();
    return p?.monto_ocr == null ? '—' : money(Math.abs((this.solicitud()?.importe || 0) - p.monto_ocr));
  }
  /** Catálogo SAT c_FormaPago, sólo los que aparecen en el dato. */
  formaPago(c: string): string {
    return ({ '01': 'Efectivo', '02': 'Cheque', '03': 'Transferencia', '04': 'Tarjeta de crédito',
      '06': 'Dinero electrónico', '07': 'Monedero', '98': 'Por definir', '99': 'Por definir' } as Record<string, string>)[c] || c;
  }

  // ── Resolución ───────────────────────────────────────────────────────────
  abrirValidar() { this.tieneComp = null; this.compNota = ''; this.showValidar.set(true); }
  confirmarValidacion() {
    if (this.tieneComp === null) return;
    // Un «no» sin motivo no es auditable.
    if (this.tieneComp === false && !this.compNota.trim()) return;
    this.showValidar.set(false);
    this.resolver('validar');
  }
  rechazar() {
    const m = this.motivo.trim();
    if (!m) return; // sin motivo no se rechaza: quien capturó tiene que saber qué corregir
    this.showReject.set(false);
    this.resolver('rechazar', m);
  }
  private resolver(accion: 'validar' | 'rechazar', motivo?: string) {
    const p = this.proof();
    if (!p || this.acting()) return;
    this.acting.set(true);
    const req = accion === 'validar'
      ? this.svc.validate(p.id, { tiene_comprobacion: this.tieneComp === true, comprobacion_nota: this.compNota.trim() || undefined })
      : this.svc.reject(p.id, motivo);
    req.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.acting.set(false); this.onToggle(false); this.resolved.emit(); },
      error: () => this.acting.set(false),
    });
  }
}
