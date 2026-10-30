import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { FileUploadModule } from 'primeng/fileupload';
import { TextareaModule } from 'primeng/textarea';
import {
  MAX_ARCHIVO_GASTO_BYTES, MAX_ARCHIVO_GASTO_MB, MAX_ARCHIVOS_EVIDENCIA_ADICIONAL,
  ROL_EVIDENCIA_ADICIONAL, faltaParaEvidenciaAdicional,
} from '@megadulces/contracts';
import { ComprobacionesService, type ProofFile, type ValeGasto } from '../comprobaciones.service';
import { money } from '../../../shared/util';

/** `[GX.87]` Lo que avisa el diálogo al terminar: el vale y sus archivos, ya firmados. */
export interface EvidenciaAgregada { id: string; files: ProofFile[]; }

/** Un archivo elegido. `subido` se llena al subirlo: si el envío falla, no se re-sube. */
interface Elegido { clave: string; nombre: string; dataUri: string; subido: ProofFile | null; }

/**
 * `[GX.87]` **Agregar evidencia a un vale que ya existe — con su porqué.**
 *
 * La evidencia del alta (`expense-evidence-dialog`) tiene casillas fijas: solicitud,
 * comprobante, hoja 2, tres fotos. Lo que llega DESPUÉS —la factura definitiva, el ticket
 * que apareció, la foto que pidió quien revisa— no tenía dónde entrar sin reabrir el vale.
 * Esto lo SUMA: no reemplaza nada y no cambia el estado.
 *
 * ⛔ El porqué es obligatorio. Un archivo que aparece en un expediente cerrado sin decir por
 * qué se lee como una alteración; con su motivo, quién y cuándo, se lee como lo que es.
 * El quién y el cuándo los pone el servidor — acá sólo viaja el motivo.
 */
@Component({
  selector: 'app-evidencia-adicional-dialog',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, FileUploadModule, TextareaModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Sin cierre implícito, como el alta: Esc o la X tirando archivos ya elegidos es la
         pérdida silenciosa que DESIGN.md §8 prohíbe. Cancelar pregunta si hay algo. -->
    <p-dialog [visible]="open()" [modal]="true" [closable]="false" [closeOnEscape]="false"
              [style]="{ width: '34rem', maxWidth: '95vw' }" [draggable]="false" header="Agregar evidencia">
      @if (vale(); as v) {
        <div class="ea-form">
          <!-- A qué vale se le agrega, para no subirlo al de al lado. -->
          <p class="ea-vale">
            <span class="ea-mono">{{ v.folio_solicitud || 'sin folio' }}</span>
            · {{ v.proveedor || 'sin proveedor' }} · <span class="ea-mono">{{ money(v.importe) }}</span>
          </p>
          <p class="ea-hint">Se suma al expediente. No reemplaza lo que ya tiene ni cambia su estado.</p>

          <div class="ea-f">
            <label class="ea-lbl" for="ea-motivo">¿Por qué la agregas? <b class="ea-req" aria-hidden="true">*</b><span class="sr-only">(obligatorio)</span></label>
            <textarea pTextarea id="ea-motivo" [(ngModel)]="motivoV" (ngModelChange)="motivo.set($event)" rows="2" class="ea-txt"
                      placeholder="Ej. llegó la factura definitiva del proveedor"></textarea>
          </div>

          <div class="ea-f">
            <span class="ea-lbl">Archivos <b class="ea-req" aria-hidden="true">*</b><span class="sr-only">(obligatorio)</span>
              <span class="ea-cuenta">{{ elegidos().length }} de {{ maxArchivos }}</span></span>
            @if (elegidos().length) {
              <ul class="ea-lista">
                @for (e of elegidos(); track e.clave) {
                  <li>
                    <i class="pi pi-paperclip" aria-hidden="true"></i>
                    <span class="ea-nom">{{ e.nombre }}</span>
                    <button type="button" class="ea-quitar" [disabled]="saving()" (click)="quitar(e.clave)"
                            [attr.aria-label]="'Quitar ' + e.nombre"><i class="pi pi-times" aria-hidden="true"></i></button>
                  </li>
                }
              </ul>
            }
            @if (elegidos().length < maxArchivos) {
              <p-fileupload mode="basic" [auto]="true" [customUpload]="true" [multiple]="true"
                            [maxFileSize]="maxArchivoBytes" chooseIcon="pi pi-plus" chooseLabel="Elegir archivo"
                            chooseStyleClass="p-button-sm p-button-outlined" [disabled]="saving()"
                            (onSelect)="onFilePicked($event)" />
            }
            <em class="ea-hint">Foto, PDF o cualquier documento · hasta {{ maxMb }} MB cada uno.</em>
          </div>

          @if (error()) { <div class="ea-err" role="alert">{{ error() }}</div> }
        </div>
      }

      <ng-template #footer>
        @if (confirmClose()) {
          <span class="ea-confirm">Hay archivos o un motivo escritos. ¿Descartarlos?</span>
          <button pButton type="button" text (click)="confirmClose.set(false)"><span class="p-button-label">Seguir</span></button>
          <button pButton type="button" severity="danger" text (click)="descartar()"><span class="p-button-label">Descartar</span></button>
        } @else {
          <button pButton type="button" text [disabled]="saving()" (click)="pedirCerrar()"><span class="p-button-label">Cancelar</span></button>
          <!-- Poka-yoke: deshabilitado mientras falte algo, y el porqué de lo que falta en el title. -->
          <button pButton type="button" [loading]="saving()" [disabled]="!!falta() || saving()" (click)="enviar()"
                  [title]="falta() || 'Agregar al expediente'">
            <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
            <span class="p-button-label">Agregar al expediente</span></button>
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ea-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ea-vale { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .ea-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ea-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ea-lbl { display: flex; align-items: baseline; gap: var(--sp-1); font-size: var(--fs-micro);
      font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .06em; color: var(--fg-3); }
    .ea-cuenta { margin-left: auto; text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums; }
    .ea-req { color: var(--bad-fg); }
    .ea-hint { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); font-style: normal; }
    .ea-txt { width: 100%; font-size: var(--fs-sm); }
    .ea-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .ea-lista li { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--fg-1); }
    .ea-nom { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ea-quitar { display: inline-flex; align-items: center; justify-content: center;
      min-width: var(--tap-min, 2rem); min-height: var(--tap-min, 2rem); border: 0; background: none;
      color: var(--fg-3); cursor: pointer; border-radius: var(--r-sm); }
    .ea-quitar:hover { color: var(--bad-fg); }
    .ea-quitar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ea-confirm { margin-right: auto; font-size: var(--fs-sm); color: var(--fg-2); }
    .ea-err { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--bad-fg);
      border: 1px solid var(--bad-border, var(--border-color)); border-radius: var(--r-sm); }
  `],
})
export class EvidenciaAdicionalDialogComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = model(false);
  /** El vale al que se le suma. `null` = no hay nada que mostrar. */
  readonly vale = input<ValeGasto | null>(null);
  /**
   * Se agregó. Viaja el expediente COMPLETO, ya firmado por el servidor: la página lo pone en
   * el visor sin pedir el detalle otra vez.
   */
  readonly agregado = output<EvidenciaAgregada>();

  readonly maxArchivos = MAX_ARCHIVOS_EVIDENCIA_ADICIONAL;
  readonly maxArchivoBytes = MAX_ARCHIVO_GASTO_BYTES;
  readonly maxMb = MAX_ARCHIVO_GASTO_MB;
  readonly money = money;

  readonly elegidos = signal<Elegido[]>([]);
  readonly motivo = signal('');
  motivoV = '';
  readonly error = signal('');
  readonly saving = signal(false);
  readonly confirmClose = signal(false);
  private siguiente = 0;

  /**
   * Lo que falta para poder enviar, con la MISMA regla que aplica el servidor: si la
   * pantalla deja pasar algo, el servidor lo rechaza con el mismo texto.
   */
  readonly falta = computed<string | null>(() => {
    const elegidos = this.elegidos();
    const archivos = elegidos.map((e) => ({ role: ROL_EVIDENCIA_ADICIONAL, url: e.nombre }));
    // Poka-yoke: mientras el navegador lee un archivo, el botón espera y dice por qué, en vez de
    // dejar apretar y contestar con un error. En una máquina lenta la lectura tarda.
    return faltaParaEvidenciaAdicional({ motivo: this.motivo(), archivos })
      ?? (elegidos.some((e) => !e.subido && !e.dataUri) ? 'Todavía se está leyendo un archivo.' : null);
  });

  constructor() {
    // Al abrir OTRO vale, lo elegido para el anterior no se arrastra.
    effect(() => { this.vale(); this.reset(); }, { allowSignalWrites: true });
  }

  pedirCerrar(): void {
    if (this.elegidos().length || this.motivo().trim()) { this.confirmClose.set(true); return; }
    this.cerrar();
  }
  descartar(): void { this.confirmClose.set(false); this.cerrar(); }
  private cerrar(): void { this.open.set(false); this.reset(); }
  private reset(): void {
    this.elegidos.set([]); this.motivo.set(''); this.motivoV = '';
    this.error.set(''); this.saving.set(false); this.confirmClose.set(false);
  }

  quitar(clave: string): void { this.elegidos.update((l) => l.filter((e) => e.clave !== clave)); }

  /** `p-fileupload` (modo básico) entrega los archivos en el evento. */
  onFilePicked(ev: { currentFiles?: File[] } | null): void {
    const files = ev?.currentFiles ?? [];
    this.error.set('');
    for (const file of files) {
      if (this.elegidos().length >= MAX_ARCHIVOS_EVIDENCIA_ADICIONAL) {
        this.error.set(`Son ${MAX_ARCHIVOS_EVIDENCIA_ADICIONAL} archivos como máximo por envío.`); break;
      }
      if (file.size > MAX_ARCHIVO_GASTO_BYTES) { this.error.set(`"${file.name}" supera ${MAX_ARCHIVO_GASTO_MB} MB.`); continue; }
      const clave = `a${this.siguiente++}`;
      // Se reserva el lugar ANTES de leer: el tope se cuenta bien aunque lleguen varios juntos.
      this.elegidos.update((l) => [...l, { clave, nombre: file.name, dataUri: '', subido: null }]);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = String(reader.result || '');
        this.elegidos.update((l) => l.map((e) => (e.clave === clave ? { ...e, dataUri } : e)));
      };
      reader.onerror = () => {
        this.quitar(clave);
        this.error.set(`No se pudo leer "${file.name}".`);
      };
      reader.readAsDataURL(file);
    }
  }

  enviar(): void {
    const v = this.vale();
    if (!v || this.saving() || this.falta()) return;
    this.error.set('');
    this.saving.set(true);   // síncrono, antes de esperar nada: el doble clic no sube dos veces

    // Sube SOLO lo que falta; cada uno con su catch → un fallo no tira los demás, y los que
    // subieron no se re-suben al reintentar.
    const pendientes = this.elegidos().filter((e) => !e.subido);
    if (!pendientes.length) { this.registrar(v.id); return; }
    forkJoin(pendientes.map((e) => this.svc.uploadFile(e.dataUri, ROL_EVIDENCIA_ADICIONAL).pipe(
      map((f) => ({ clave: e.clave, f: f as ProofFile | null })),
      catchError(() => of({ clave: e.clave, f: null as ProofFile | null })),
    ))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((res) => {
      const ok = new Map(res.filter((x) => x.f).map((x) => [x.clave, x.f as ProofFile]));
      this.elegidos.update((l) => l.map((e) => (ok.has(e.clave) ? { ...e, subido: ok.get(e.clave) ?? null, dataUri: '' } : e)));
      const fallaron = res.length - ok.size;
      if (fallaron) {
        this.saving.set(false);
        this.error.set(`No se pudieron subir ${fallaron} archivo(s). Nada se agregó todavía: vuelve a intentar.`);
        return;
      }
      this.registrar(v.id);
    });
  }

  private registrar(id: string): void {
    const files = this.elegidos().map((e) => ({ ...(e.subido as ProofFile), name: e.nombre }));
    this.svc.agregarEvidenciaAdicional(id, files, this.motivo().trim())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.saving.set(false); this.agregado.emit({ id, files: r.files ?? [] }); this.cerrar(); },
        error: (e) => {
          this.saving.set(false);
          this.error.set(e?.error?.message || 'No se pudo agregar la evidencia. Vuelve a intentar.');
        },
      });
  }
}

