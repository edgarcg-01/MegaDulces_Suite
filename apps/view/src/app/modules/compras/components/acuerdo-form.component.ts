import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import {
  AREAS_ACUERDO, DIAS_MAX_COMPROMISO, ETIQUETA_AREA_ACUERDO, MAX_CONTACTO_PROVEEDOR, MAX_DESCRIPCION_ACUERDO,
  type AcuerdoVista, type AreaAcuerdo, type CapturarAcuerdoDto, type PersonaCitas,
} from '@megadulces/contracts';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { motivoHttp } from '../../almacen/shared/http-motivo';
import { CitasProveedoresService } from '../citas-proveedores.service';
import { AcuerdosProveedoresService } from '../acuerdos-proveedores.service';
import { diaLargo, fechaDeIso, fechaIso, sumarDiasIso } from '../citas-proveedores';
import { dtoDeAcuerdo, faltaAcuerdo, ptDialogoTactil } from '../acuerdos-proveedores';

/** De qué reunión sale (o salió) el acuerdo: lo que el formulario necesita saber de ella. */
export interface ReunionDelForm {
  readonly meetingId: string;
  /** El día de la reunión (`AAAA-MM-DD`): la fecha compromiso no puede ser antes. */
  readonly meetingDate: string;
  readonly proveedor: string;
  /** Quien organizó la reunión: sigue los acuerdos del proveedor (DC43). `null` si la pantalla no lo sabe. */
  readonly organizador: string | null;
}

/**
 * `[PQ.3.10]` Capturar o editar un acuerdo (anexo C §10.20). Lo usan el detalle de la cita (capturar: un acuerdo
 * siempre sale de una reunión, DC45) y la pestaña Acuerdos (editar).
 *
 * Por qué así: el área decide el resto. Del proveedor → el nombre de su persona, y en la Suite lo sigue quien organizó
 * la reunión (lo pone el servidor; aquí sólo se dice). De Mega Dulces → el responsable, entre quien AGENDA Citas (DC44:
 * cada responsable cierra el suyo; quien sólo ve no podría).
 * La fecha compromiso arranca en el día de la reunión y llega a dos años. Lo que falta se dice ANTES de mandar; la API
 * vuelve a revisarlo todo y su mensaje manda.
 */
@Component({
  selector: 'app-acuerdo-form',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, DatePickerModule, InputTextModule, SelectModule, TextareaModule, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="abierto()" (visibleChange)="abierto.set($event)" [modal]="true" [draggable]="false" [style]="{ width: 'min(36rem, 96vw)' }"
              [header]="editando() ? 'Editar el acuerdo' : 'Capturar acuerdo'" [pt]="ptDialogo">
      <div class="af-form">
        @if (reunion(); as r) {
          <p class="af-sub">De la reunión con {{ r.proveedor }} del {{ diaLargo(r.meetingDate) }}.</p>
        }

        <span class="af-label" id="af-area-l">De qué área</span>
        <app-segmented [options]="opcionesArea" [value]="fArea ?? ''" (valueChange)="fArea = $any($event)" ariaLabel="De qué área es el acuerdo" />

        <label class="af-label" for="af-desc">Qué se acordó</label>
        <textarea pTextarea id="af-desc" rows="3" [(ngModel)]="fDesc" [maxlength]="maxDesc" placeholder="Ej. Mandar la lista de precios 2027"></textarea>
        <p class="af-nota">{{ fDesc.length }} de {{ maxDesc }} caracteres.</p>

        @if (fArea === 'supplier') {
          <label class="af-label" for="af-contacto">Quién del proveedor se comprometió</label>
          <input pInputText id="af-contacto" [(ngModel)]="fContacto" [maxlength]="maxContacto" autocomplete="off" placeholder="Nombre de la persona" />
          <p class="af-nota">En la Suite lo sigue {{ reunion()?.organizador || 'quien organizó la reunión' }}: le aparece en «Mi trabajo».</p>
        } @else if (fArea) {
          <label class="af-label" for="af-resp">Responsable</label>
          <p-select inputId="af-resp" [options]="personasOpciones()" [(ngModel)]="fResponsable" optionLabel="label" optionValue="value"
                    [filter]="true" filterBy="label" placeholder="Quién de Mega Dulces" appendTo="body" [fluid]="true" />
          @if (personasError()) { <p class="af-error" role="alert">{{ personasError() }}</p> }
          @else { <p class="af-nota">Sólo aparecen quienes agendan Citas: el acuerdo le llega a su «Mi trabajo» y lo cierra con una nota.</p> }
        }

        <label class="af-label" for="af-fecha">Fecha compromiso</label>
        <p-datepicker inputId="af-fecha" [(ngModel)]="fFecha" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                      [minDate]="minFecha()" [maxDate]="maxFecha()" />

        @if (falta(); as f) { <p class="af-nota" role="status">{{ f }}</p> }
        @if (error()) { <p class="af-error" role="alert">{{ error() }}</p> }
      </div>
      <ng-template #footer>
        <button pButton type="button" class="p-button-text p-button-secondary" (click)="abierto.set(false)"><span class="p-button-label">Cerrar sin guardar</span></button>
        <button pButton type="button" (click)="guardar()" [disabled]="!!falta() || guardando()">
          <span class="p-button-label">{{ guardando() ? 'Guardando…' : (editando() ? 'Guardar cambios' : 'Guardar acuerdo') }}</span>
        </button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    .af-form { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .af-label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); margin-top: var(--sp-2); }
    .af-sub, .af-nota { margin: 0; font-size: var(--fs-xs); color: var(--fg-2); }
    .af-error {
      margin: 0; padding: var(--sp-1) var(--sp-2); border: 1px solid var(--bad-border); border-radius: var(--r-md);
      background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-xs);
    }
    textarea { width: 100%; resize: vertical; }
    /* Táctil: 44 px al dedo (Fitts). El anfitrión de PrimeNG es la caja y lleva el atributo de este componente. */
    @media (pointer: coarse) {
      button[pButton], input[pInputText], p-select, p-datepicker { min-height: var(--tap-min, 44px); }
    }
  `],
})
export class AcuerdoFormComponent {
  private readonly api = inject(AcuerdosProveedoresService);
  private readonly citas = inject(CitasProveedoresService);
  private readonly destroyRef = inject(DestroyRef);

  /** Lo guardado, en una frase para el aviso de la pantalla que abrió el formulario. */
  readonly guardado = output<string>();

  readonly maxDesc = MAX_DESCRIPCION_ACUERDO;
  readonly ptDialogo = ptDialogoTactil();
  readonly maxContacto = MAX_CONTACTO_PROVEEDOR;
  readonly diaLargo = diaLargo;
  readonly opcionesArea: SegOption[] = AREAS_ACUERDO.map((a) => ({ label: ETIQUETA_AREA_ACUERDO[a], value: a }));

  readonly abierto = signal(false);
  readonly reunion = signal<ReunionDelForm | null>(null);
  private readonly editandoId = signal<string | null>(null);
  readonly editando = computed(() => !!this.editandoId());
  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);

  private readonly personas = signal<readonly PersonaCitas[]>([]);
  readonly personasError = signal<string | null>(null);
  /** Sólo quien agenda puede ser responsable (DC44); la API lo vuelve a exigir. */
  readonly personasOpciones = computed(() => this.personas().filter((p) => p.agenda).map((p) => ({ label: p.nombre, value: p.user_id })));

  readonly minFecha = computed(() => (this.reunion() ? fechaDeIso(this.reunion()!.meetingDate) : null));
  readonly maxFecha = computed(() => (this.reunion() ? fechaDeIso(sumarDiasIso(this.reunion()!.meetingDate, DIAS_MAX_COMPROMISO)) : null));

  fArea: AreaAcuerdo | null = null;
  fDesc = '';
  fContacto = '';
  fResponsable: string | null = null;
  fFecha: Date | null = null;

  /** Capturar uno nuevo de `reunion`. */
  capturar(reunion: ReunionDelForm): void {
    this.reunion.set(reunion);
    this.editandoId.set(null);
    this.fArea = null;
    this.fDesc = '';
    this.fContacto = '';
    this.fResponsable = null;
    this.fFecha = null;
    this.abrir();
  }

  /** Editar `a` (sólo abierto: la API lo vuelve a exigir). */
  editar(a: AcuerdoVista, reunion: ReunionDelForm): void {
    const dto = dtoDeAcuerdo(a);
    this.reunion.set(reunion);
    this.editandoId.set(a.id);
    this.fArea = dto.area;
    this.fDesc = dto.description;
    this.fContacto = dto.supplier_contact ?? '';
    this.fResponsable = dto.assigned_to ?? null;
    this.fFecha = fechaDeIso(dto.due_date);
    this.abrir();
  }

  private abrir(): void {
    this.error.set(null);
    this.guardando.set(false);
    this.cargarPersonas();
    this.abierto.set(true);
  }

  private cargarPersonas(): void {
    if (this.personas().length) return;
    this.personasError.set(null);
    this.citas.opciones().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => this.personas.set(o.personas),
      error: (e) => this.personasError.set(motivoHttp(e, 'leer quién puede ser responsable')),
    });
  }

  private dto(): CapturarAcuerdoDto {
    const proveedor = this.fArea === 'supplier';
    return {
      area: this.fArea as AreaAcuerdo,
      description: this.fDesc.trim(),
      due_date: this.fFecha ? fechaIso(this.fFecha) : '',
      assigned_to: proveedor ? null : this.fResponsable,
      supplier_contact: proveedor ? this.fContacto.trim() : null,
    };
  }

  falta(): string | null {
    return faltaAcuerdo(this.dto());
  }

  guardar(): void {
    const r = this.reunion();
    if (!r || this.falta() || this.guardando()) return;
    const id = this.editandoId();
    this.guardando.set(true);
    this.error.set(null);
    const peticion = id ? this.api.editar(id, this.dto()) : this.api.capturar(r.meetingId, this.dto());
    peticion.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardando.set(false);
        this.abierto.set(false);
        this.guardado.emit(id ? 'Cambios guardados.' : `Acuerdo guardado: ya le aparece a su responsable en «Mi trabajo».`);
      },
      error: (e) => { this.guardando.set(false); this.error.set(motivoHttp(e, id ? 'guardar los cambios' : 'guardar el acuerdo')); },
    });
  }
}
