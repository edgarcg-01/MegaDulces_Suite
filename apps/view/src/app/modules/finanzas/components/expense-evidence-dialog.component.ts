import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { FileUploadModule } from 'primeng/fileupload';
import { TextareaModule } from 'primeng/textarea';
import { ComprobacionesService, ProofFile, ProofFileRole, ProofPhotoOcr } from '../comprobaciones.service';
import { ExpenseRequestRow } from '../../comercial/comercial.service';
import { money } from '../../../shared/util';
import { dmy } from '../pages/finanzas-format';

interface FileSlot { role: ProofFileRole; label: string; required: boolean; accept: string; }

/**
 * Adjuntar la evidencia de una solicitud de gasto.
 *
 * No pide NADA que Kepler ya tenga: la solicitud llega como input y solicitante,
 * beneficiario, sucursal, fecha e importe se muestran de solo lectura. La única tarea es
 * subir el comprobante. Antes esto vivía en `/finanzas/comprobaciones` con un formulario
 * de 8 campos que duplicaba —y podía contradecir— al ERP.
 *
 * El comprobante se lee con Claude Vision AL ADJUNTARLO, contra el importe de la
 * solicitud, y el veredicto se ve antes de enviar. El servidor vuelve a leerlo por su
 * cuenta (esa es la lectura autoritativa); esta viaja como respaldo por si allá no puede.
 */
@Component({
  selector: 'app-expense-evidence-dialog',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, FileUploadModule, TextareaModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="open()" (visibleChange)="onToggle($event)" [modal]="true"
              [style]="{ width: '36rem', maxWidth: '95vw' }" [draggable]="false" header="Adjuntar evidencia">
      @if (solicitud(); as s) {
        <div class="ev-form">
          <!-- Lo que el ERP ya sabe, de solo lectura. Volver a pedirlo era hacer teclear
               lo que el sistema ya tiene, y habilitaba contradecir a Kepler. -->
          <div class="ev-sol">
            <div class="ev-sol-h"><i class="pi pi-link" aria-hidden="true"></i> Solicitud {{ s.folio }} · ya en Kepler</div>
            <dl class="ev-sol-g">
              @if (s.solicitante) { <div><dt>Solicitante</dt><dd>{{ s.solicitante }}</dd></div> }
              @if (s.acreedor || s.beneficiario) { <div><dt>Beneficiario</dt><dd>{{ s.acreedor || s.beneficiario }}</dd></div> }
              @if (s.sucursal) { <div><dt>Sucursal</dt><dd>{{ s.sucursal_nombre || s.sucursal }}</dd></div> }
              @if (s.fecha) { <div><dt>Fecha</dt><dd>{{ dmy(s.fecha) }}</dd></div> }
              <div><dt>Importe</dt><dd class="ev-num">{{ money(s.importe) }}</dd></div>
              @if (s.concepto) { <div class="ev-wide"><dt>Concepto</dt><dd>{{ s.concepto }}</dd></div> }
            </dl>
          </div>

          @for (slot of fileSlots; track slot.role) {
            <div class="ev-f">
              <span class="ev-lbl">{{ slot.label }} @if (slot.required) { <b class="ev-req">*</b> }</span>
              <p-fileupload mode="basic" [auto]="true" [customUpload]="true" [accept]="slot.accept"
                            [maxFileSize]="10485760" chooseIcon="pi pi-paperclip" chooseLabel="Elegir archivo"
                            chooseStyleClass="p-button-sm p-button-outlined"
                            (onSelect)="onFilePicked($event, slot.role)" />
              @if (fileNames()[slot.role]) { <span class="ev-pick"><i class="pi pi-paperclip" aria-hidden="true"></i> {{ fileNames()[slot.role] }}</span> }
              @if (vision()[slot.role]; as v) {
                @if (v === 'cargando') {
                  <span class="ev-vision is-load"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo con Claude Vision…</span>
                } @else {
                  <span class="ev-vision" [class.is-ok]="visionTone(v) === 'ok'" [class.is-warn]="visionTone(v) === 'warn'">
                    <i class="pi" [class.pi-check-circle]="visionTone(v) === 'ok'" [class.pi-exclamation-triangle]="visionTone(v) === 'warn'" aria-hidden="true"></i>
                    {{ visionMsg(v) }}
                  </span>
                }
              }
            </div>
          }

          <div class="ev-f">
            <span class="ev-lbl">Comentarios</span>
            <textarea pTextarea [(ngModel)]="comentarios" rows="2" class="ev-txt"></textarea>
          </div>
          @if (error()) { <div class="ev-err" role="alert">{{ error() }}</div> }
        </div>
      }
      <ng-template #footer>
        <button pButton type="button" text (click)="onToggle(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" [loading]="saving()" (click)="enviar()">
          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
          <span class="p-button-label">Enviar evidencia</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ev-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ev-sol { padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .ev-sol-h { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm);
      font-weight: var(--fw-bold); color: var(--fg-1); margin-bottom: var(--sp-2); }
    .ev-sol-h i { color: var(--action); }
    .ev-sol-g { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--sp-2) var(--sp-3); margin: 0; }
    .ev-sol-g dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em; color: var(--fg-3); }
    .ev-sol-g dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .ev-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .ev-wide { grid-column: 1 / -1; }
    .ev-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ev-lbl { font-size: var(--fs-xs); color: var(--fg-2); }
    .ev-req { color: var(--bad-fg); }
    .ev-txt { width: 100%; font-size: var(--fs-sm); }
    .ev-pick { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--ok-fg); }
    .ev-vision { display: inline-flex; align-items: flex-start; gap: var(--sp-1); font-size: var(--fs-xs); line-height: 1.4; color: var(--fg-2); }
    .ev-vision.is-ok { color: var(--ok-fg); }
    .ev-vision.is-warn { color: var(--warn-fg); }
    .ev-err { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--bad-fg);
      border: 1px solid var(--bad-border, var(--border-color)); border-radius: var(--r-sm); }
  `],
})
export class ExpenseEvidenceDialogComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = model(false);
  readonly solicitud = input<ExpenseRequestRow | null>(null);
  readonly saved = output<string>();

  /** Ya no se pide la solicitud de Kepler: existe en el ERP y se lee por folio. */
  readonly fileSlots: FileSlot[] = [
    { role: 'comprobante_1', label: 'Comprobante — hoja 1', required: true, accept: '.pdf,image/*' },
    { role: 'comprobante_2', label: 'Comprobante — hoja 2', required: false, accept: '.pdf,image/*' },
    { role: 'evidencia_1', label: 'Evidencia fotográfica 1', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_2', label: 'Evidencia fotográfica 2', required: false, accept: 'image/*,.pdf' },
    { role: 'evidencia_3', label: 'Evidencia fotográfica 3', required: false, accept: 'image/*,.pdf' },
  ];

  readonly fileNames = signal<Record<string, string>>({});
  readonly vision = signal<Record<string, ProofPhotoOcr | 'cargando' | null>>({});
  readonly error = signal<string>('');
  readonly saving = signal(false);
  comentarios = '';
  private fileData: Record<string, string> = {};
  private uploaded: Record<string, ProofFile> = {};

  readonly money = money;
  readonly dmy = dmy;

  onToggle(v: boolean) {
    this.open.set(v);
    if (!v) this.reset();
  }
  private reset() {
    this.fileData = {}; this.uploaded = {}; this.comentarios = '';
    this.fileNames.set({}); this.vision.set({}); this.error.set(''); this.saving.set(false);
  }

  /** `p-fileupload` (modo básico) entrega el archivo en el evento, ya tipado. */
  onFilePicked(ev: { currentFiles?: File[] } | null, role: string) {
    const file = ev?.currentFiles?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { this.error.set(`"${file.name}" supera 10 MB.`); return; }
    this.error.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      this.fileData[role] = dataUri;      // data URI (el backend detecta PDF vs imagen)
      delete this.uploaded[role];          // archivo nuevo → re-subir
      this.fileNames.update((m) => ({ ...m, [role]: file.name }));
      this.leerConVision(role, dataUri);
    };
    reader.readAsDataURL(file);
  }

  /** Vista previa de Vision contra el importe de la solicitud: el veredicto se ve ANTES de enviar. */
  private leerConVision(role: string, dataUri: string) {
    if (!role.startsWith('comprobante')) return;
    const importe = Number(this.solicitud()?.importe || 0);
    if (!importe) return; // sin importe esperado no hay nada que cuadrar
    this.vision.update((m) => ({ ...m, [role]: 'cargando' }));
    this.svc.validatePhoto(dataUri, importe).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.vision.update((m) => ({ ...m, [role]: r })),
      // Que falle la lectura no impide capturar: el backend la reintenta al guardar.
      error: () => this.vision.update((m) => ({ ...m, [role]: null })),
    });
  }
  visionMsg(v: ProofPhotoOcr): string {
    if (v.ocr_status === 'sin_key') return 'Claude Vision no está configurado en el servidor — se validará a mano.';
    if (v.ocr_status === 'ilegible') return 'Claude Vision no pudo leer el importe en la foto — se validará a mano.';
    const leido = money(v.monto_ocr ?? v.total ?? v.subtotal ?? 0);
    if (v.monto_match) return `Claude Vision leyó ${leido} y cuadra con la solicitud (${money(v.importe_esperado)}).`;
    return `Claude Vision leyó ${leido} y la solicitud dice ${money(v.importe_esperado)}` +
      `${v.diff != null ? ` — difieren ${money(Math.abs(v.diff))}` : ''}. Entra en revisión.`;
  }
  visionTone(v: ProofPhotoOcr): 'ok' | 'warn' { return v.ocr_status === 'ok' && v.monto_match ? 'ok' : 'warn'; }

  enviar() {
    const s = this.solicitud();
    if (!s || this.saving()) return;
    for (const slot of this.fileSlots) {
      if (slot.required && !this.fileData[slot.role] && !this.uploaded[slot.role]) {
        this.error.set(`Falta: ${slot.label}.`); return;
      }
    }
    this.error.set('');
    this.saving.set(true);

    // Sube SOLO lo que aún no subió; cada archivo con su propio catch → un fallo NO tira
    // los demás. Los que suben OK quedan en `uploaded` y no se re-suben.
    const presentes = this.fileSlots.map((x) => x.role).filter((r) => this.fileData[r] || this.uploaded[r]);
    const faltantes = presentes.filter((r) => !this.uploaded[r]);
    if (!faltantes.length) { this.crear(presentes); return; }

    const ups = faltantes.map((r) => this.svc.uploadFile(this.fileData[r], r as ProofFileRole).pipe(
      map((f) => ({ role: r, file: f as ProofFile | null })),
      catchError(() => of({ role: r, file: null as ProofFile | null })),
    ));
    forkJoin(ups).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((res) => {
      const fallaron: string[] = [];
      for (const x of res) {
        if (x.file) { this.uploaded[x.role] = x.file; delete this.fileData[x.role]; }
        else fallaron.push(x.role);
      }
      if (fallaron.length) {
        this.saving.set(false);
        const ok = res.length - fallaron.length;
        this.error.set(`No se pudieron subir ${fallaron.length} archivo(s).${ok ? ` (${ok} sí quedaron guardados.)` : ''} Reintentá.`);
        return;
      }
      this.crear(presentes);
    });
  }

  private crear(roles: string[]) {
    const s = this.solicitud()!;
    const files = roles.map((r) => this.uploaded[r]).filter(Boolean) as ProofFile[];
    const v = this.vision()['comprobante_1'] ?? this.vision()['comprobante_2'];
    const ocr = v && v !== 'cargando' ? v : null;
    this.svc.create({
      folio_solicitud: s.folio,
      solicitante: s.solicitante || undefined,
      proveedor: s.acreedor || s.beneficiario || undefined,
      sucursal: s.sucursal || undefined,
      fecha_gasto: s.fecha ? String(s.fecha).slice(0, 10) : undefined,
      importe: s.importe || undefined,
      comentarios: this.comentarios || s.concepto || undefined,
      files,
      monto_ocr: ocr ? ocr.monto_ocr ?? ocr.total : undefined,
      subtotal_ocr: ocr ? ocr.subtotal : undefined,
      receipt_legible: ocr ? ocr.ocr_status === 'ok' : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.saved.emit(s.folio); this.onToggle(false); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.message || 'No se pudo enviar la evidencia.'); },
    });
  }
}
