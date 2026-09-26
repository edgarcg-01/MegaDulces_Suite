import { ChangeDetectionStrategy, Component, computed, inject, input, model, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { parseLocalDate } from '../../../core/utils/mx-date';
import {
  CLASIFICACION_LABEL, type ExpenseClasificacion, type ProofFile, type ValeGasto,
} from '../comprobaciones.service';

/** Qué se puede hacer con el vale desde acá. Lo decide la PÁGINA, no este visor. */
export type AccionVale = 'aprobar' | 'comprobar' | 'rechazar';

const FORMA_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia',
  cheque: 'Cheque', vales: 'Vales', otro: 'Otro',
};

/** Cómo se llama cada estado en voz alta. La clave cruda es cómo se guarda, no cómo se dice. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma',
  aprobada: 'Aprobado · falta ejercer',
  revision: 'El cuadre no dio',
  validada: 'Comprobado',
  rechazada: 'Rechazado',
};

/** Cómo se llama cada adjunto. La clave (`comprobante_1`) es el rol, no el nombre. */
const ARCHIVO_LABEL: Record<string, string> = {
  comprobante_1: 'Comprobante — hoja 1', comprobante_2: 'Comprobante — hoja 2',
  solicitud_kepler: 'Solicitud de gasto firmada', cotizacion: 'Cotización',
  evidencia_1: 'Evidencia 1', evidencia_2: 'Evidencia 2', evidencia_3: 'Evidencia 3',
};

/**
 * Un adjunto listo para pintar.
 *
 * ⚠️ `safeUrl` se sanitiza **una vez**. Hacerlo en el template recrearía el `iframe` en cada
 * ciclo de detección — o sea que el PDF se recargaría solo, sin parar.
 */
interface DocDelExpediente {
  role: string;
  label: string;
  url: string;
  isPdf: boolean;
  safeUrl: SafeResourceUrl | null;
}

/**
 * `[GX.27]` — **El vale de gasto, completo.** Panel lateral compartido.
 *
 * Nació dentro de la pantalla de Aprobación (`[GX.20.10]`) y se extrajo acá en cuanto el
 * **Historial** necesitó lo mismo: un visor duplicado son dos sitios donde arreglar el mismo
 * error, y dos sitios que pueden empezar a mostrar cosas distintas del mismo expediente.
 *
 * ## ⛔ El visor no decide ni pide nada
 * No llama al servidor y no sabe qué se puede hacer con el vale: recibe el expediente ya
 * cargado y la lista de acciones permitidas, y **emite**. Quien manda es la página — que es
 * la que conoce el permiso de quien mira. Así el Historial lo usa de sólo lectura sin tener
 * que apagar botones uno por uno.
 *
 * ## ⚠️ «No vino el dato» no es «no hay dato»
 * `created_hora` y `concepto` llegan `undefined` desde los endpoints que no los seleccionan.
 * En ese caso **se omiten**, no se pintan como «—»: un guion afirma que el expediente no lo
 * tiene, y eso sería falso.
 */
@Component({
  selector: 'app-vale-gasto-peek',
  standalone: true,
  imports: [CommonModule, ButtonModule, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <!-- ── El vale, completo ──────────────────────────────────────────────────── -->
  <!-- 820px: adentro va el comprobante, y un documento financiero no se lee en un
       overlay apretado (DESIGN.md O.1). -->
  <app-side-peek [open]="open()" (openChange)="open.set($event)" [width]="820"
                 title="Vale de gasto" [subtitle]="subtituloPeek()">
    @if (vale(); as p) {
      <div class="vp">
        <div class="vp-top">
          <div>
            <div class="vp-imp">{{ money(p.importe) }}</div>
            <div class="vp-prov">{{ p.proveedor || '—' }}</div>
          </div>
          <span class="ap-chip" [class.ok]="p.status === 'validada'"
                [class.warn]="p.status === 'revision'" [class.bad]="p.status === 'rechazada'">
            {{ estado(p.status) }}
          </span>
        </div>

        @if (p.concepto) { <p class="vp-con">{{ p.concepto }}</p> }

        <dl class="vp-datos">
          <div><dt>Folio</dt><dd class="vp-mono">{{ p.folio_solicitud || 'sin folio' }}</dd></div>
          <div><dt>Sucursal</dt><dd>{{ p.sucursal || '—' }}</dd></div>
          <div><dt>Departamento</dt><dd>{{ p.departamento || p.solicitante || 'sin departamento' }}</dd></div>
          <div><dt>Levantado</dt><dd>{{ diaLocal(p.created_at) | date: 'dd/MM/yy' }}@if (p.created_hora) { {{ p.created_hora }} } · {{ p.created_by || '—' }}</dd></div>
          <!-- Las dos fechas, siempre: el gasto puede ser de otro día que el levantamiento. -->
          <div><dt>Fecha del gasto</dt><dd>{{ p.fecha_gasto ? (diaLocal(p.fecha_gasto) | date: 'dd/MM/yy') : 'no declarada' }}</dd></div>
          @if (p.clasificacion !== undefined) {
                <div><dt>Tipo</dt><dd>{{ p.clasificacion ? tipoGasto(p.clasificacion) : 'sin clasificar' }}</dd></div>
              }
          @if (p.forma_pago !== undefined) {
                <div><dt>Pago</dt><dd>{{ p.forma_pago ? formaPago(p.forma_pago) : 'sin forma de pago' }}@if (p.forma_pago_detalle) { · {{ p.forma_pago_detalle }} }</dd></div>
              }
          @if (p.validated_by) { <div><dt>Cerrado por</dt><dd>{{ p.validated_by }}</dd></div> }
        </dl>

        @if (p.comentarios) { <p class="vp-nota">“{{ p.comentarios }}”</p> }
        @if (p.revision_nota) { <p class="vp-nota warn">{{ p.revision_nota }}</p> }
        @if (p.motivo_rechazo) { <p class="vp-nota bad">Rechazado: {{ p.motivo_rechazo }}</p> }

        <!-- ── Los papeles ──────────────────────────────────────────────────── -->
        <h3 class="vp-h">Evidencia</h3>
        @if (!docs().length) {
          <!-- «No hay archivos» y «no los puedo mostrar» son dos cosas distintas. -->
          <div class="vp-sin">
            <i class="pi pi-file-excel" aria-hidden="true"></i>
            <span>Este vale no trae ningún archivo adjunto.</span>
          </div>
        } @else {
          @for (d of docs(); track d.url) {
            <figure class="vp-doc">
              <figcaption>
                <span>{{ d.label }}</span>
                <a [href]="d.url" target="_blank" rel="noopener">abrir aparte</a>
              </figcaption>
              @if (d.isPdf) {
                <iframe [src]="d.safeUrl" [title]="d.label" loading="lazy"></iframe>
              } @else {
                <img [src]="d.url" [alt]="d.label" loading="lazy" (error)="fallo(d.url)" />
              }
              @if (fallidos().has(d.url)) {
                <!-- Que la imagen no cargue NO es que no exista: se dice cuál de las dos. -->
                <p class="vp-fallo">No se pudo mostrar el archivo. Probá «abrir aparte».</p>
              }
            </figure>
          }
        }

        <!-- ── La decisión, al pie del documento ───────────────────────────── -->
        @if (acciones().length) {
          <div class="vp-act">
            @if (p.status === 'aprobada' && p.requiere_evidencia && !p.tiene_evidencia) {
              <!-- La evidencia la sube quien capturó, no quien firma. Decirlo evita que
                   el aprobador busque un botón que no le toca. -->
              <span class="ap-faint">la evidencia la sube quien lo levantó</span>
            }
            <span class="ap-grow"></span>
            <button pButton type="button" class="p-button-text" [disabled]="ocupado()"
                    (click)="rechazar.emit(p)">Rechazar</button>
            @if (acciones().includes('aprobar')) {
              <button pButton type="button" [loading]="ocupado()" (click)="aprobar.emit(p)">Aprobar</button>
            } @else {
              <button pButton type="button" class="p-button-outlined" [loading]="ocupado()"
                      (click)="comprobar.emit(p)">Dar por comprobado</button>
            }
          </div>
        } @else {
          <p class="ap-faint vp-cerrado">Este vale ya se resolvió: no hay nada que decidir.</p>
        }
      </div>
    }
  </app-side-peek>
  `,
  styles: [`
  /* ── El vale, completo ──────────────────────────────────────────────────── */
  .vp { display: flex; flex-direction: column; gap: var(--sp-3); }
  .vp-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
  .vp-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: var(--fs-h1); font-weight: var(--fw-bold); line-height: 1.1; }
  .vp-prov { font-size: var(--fs-sm); color: var(--fg-2); }
  .vp-con { font-size: var(--fs-sm); color: var(--fg-1); margin: 0; }
  .vp-datos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2) var(--sp-4);
    margin: 0; padding: var(--sp-3); background: var(--layout-bg); border-radius: var(--r-md); }
  .vp-datos dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
  .vp-datos dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
  .vp-mono { font-family: var(--font-mono); }
  .vp-nota { font-size: var(--fs-sm); color: var(--fg-2); font-style: italic; margin: 0; }
  .vp-nota.warn { color: var(--warn-fg); font-style: normal; }
  .vp-nota.bad { color: var(--bad-fg); font-style: normal; }
  .vp-h { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em;
    color: var(--fg-3); margin: var(--sp-2) 0 0; }
  .vp-sin { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--fg-2);
    padding: var(--sp-4); border: 1px dashed var(--border-color); border-radius: var(--r-md); }
  .vp-doc { margin: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
  .vp-doc figcaption { display: flex; align-items: center; justify-content: space-between;
    gap: var(--sp-2); padding: 6px var(--sp-3); background: var(--layout-bg);
    font-size: var(--fs-xs); color: var(--fg-2); }
  .vp-doc figcaption a { font-size: var(--fs-xs); }
  .vp-doc img { display: block; width: 100%; height: auto; background: var(--layout-bg); }
  .vp-doc iframe { display: block; width: 100%; height: 62vh; border: 0; background: var(--layout-bg); }
  .vp-fallo { font-size: var(--fs-xs); color: var(--warn-fg); padding: var(--sp-2) var(--sp-3); margin: 0; }
  .vp-act { display: flex; align-items: center; gap: var(--sp-2); position: sticky; bottom: 0;
    margin-top: var(--sp-2); padding-top: var(--sp-3); background: var(--card-bg);
    border-top: 1px solid var(--c-divider); }
  .vp-cerrado { padding-top: var(--sp-3); border-top: 1px solid var(--c-divider); }

  @media (max-width: 48rem) { .vp-datos { grid-template-columns: 1fr; } }
  `],
})
export class ValeGastoPeekComponent {
  private readonly sanitizer = inject(DomSanitizer);

  readonly open = model(false);
  /** El expediente a mostrar. `null` = no hay nada que ver. */
  readonly vale = input<ValeGasto | null>(null);
  /** Qué botones ofrece el pie. Vacío = sólo lectura. Lo decide la página. */
  readonly acciones = input<readonly AccionVale[]>([]);
  /** La página está resolviendo algo sobre este vale: los botones se bloquean. */
  readonly ocupado = input(false);

  readonly aprobar = output<ValeGasto>();
  readonly comprobar = output<ValeGasto>();
  readonly rechazar = output<ValeGasto>();

  /** Las urls que el navegador no pudo pintar. Ver `fallo()`. */
  private readonly fallidosSet = signal<ReadonlySet<string>>(new Set());
  readonly fallidos = this.fallidosSet.asReadonly();

  subtituloPeek(): string {
    const p = this.vale();
    if (!p) return '';
    return `${p.folio_solicitud || 'sin folio'} · ${p.departamento || p.solicitante || 'sin departamento'}`;
  }

  readonly docs = computed<DocDelExpediente[]>(() => {
    const p = this.vale();
    if (!p) return [];
    return (p.files ?? []).filter((f: ProofFile) => f?.url).map((f: ProofFile) => {
      const role = String(f.role ?? '');
      const isPdf = f.kind === 'pdf' || /\.pdf(\?|$)/i.test(f.url);
      return {
        role,
        label: ARCHIVO_LABEL[role] ?? role ?? 'Archivo',
        url: f.url,
        isPdf,
        safeUrl: isPdf ? this.sanitizer.bypassSecurityTrustResourceUrl(f.url) : null,
      };
    });
  });

  /** Que el navegador no pueda pintarlo NO es que el archivo no exista: se dice cuál de las dos. */
  fallo(url: string): void {
    this.fallidosSet.update((s) => new Set(s).add(url));
  }

  /**
   * La fecha ISO como `Date` **local**, para que el pipe no corra el día.
   *
   * ⚠️ `new Date('2026-09-25')` es medianoche **UTC**, y en México (−06:00) eso es el 24 a las
   * 18:00 — el pipe imprimiría «24 sep». Se usa el helper compartido del repo.
   */
  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  formaPago(id: string): string { return FORMA_PAGO_LABEL[id] ?? id; }
  estado(s: string): string { return ESTADO_LABEL[s] ?? s; }
  /** El tipo de gasto en palabras. Sin la clave cruda: `no_fiscal_comprobable` es cómo se
   *  guarda, no cómo se dice. */
  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }
}
