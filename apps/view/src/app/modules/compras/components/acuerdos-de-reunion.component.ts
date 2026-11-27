import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ETIQUETA_SITUACION_ACUERDO, type AcuerdoVista, type AcuerdosDeReunion, type SituacionAcuerdo } from '@megadulces/contracts';
import { motivoHttp } from '../../almacen/shared/http-motivo';
import { AcuerdosProveedoresService } from '../acuerdos-proveedores.service';
import { areaAcuerdo, plazoAparte, responsableEnPalabras, SEVERIDAD_ACUERDO } from '../acuerdos-proveedores';
import { AcuerdoFormComponent } from './acuerdo-form.component';

/**
 * `[PQ.3.10]` Los acuerdos dentro del detalle de una cita (anexo C §10.20): los de ESTA reunión y lo que sigue abierto
 * con el mismo proveedor de otras reuniones (con eso se abre la siguiente). Aquí se CAPTURA, porque un acuerdo siempre
 * sale de una reunión realizada (DC45); se trabaja (iniciar, cumplir, editar, cancelar) en la pestaña Acuerdos, a la
 * que lleva cada renglón. Si la reunión no recibe acuerdos, se dice por qué (la misma regla que frena la escritura).
 */
@Component({
  selector: 'app-acuerdos-de-reunion',
  standalone: true,
  imports: [RouterLink, ButtonModule, TagModule, AcuerdoFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ar">
      <div class="ar-cabeza">
        <h3>Acuerdos de esta reunión</h3>
        @if (puedeAgendar() && datos() && !datos()!.no_recibe) {
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="capturar()">
            <i class="pi pi-plus" aria-hidden="true"></i><span class="p-button-label">Capturar acuerdo</span>
          </button>
        }
      </div>
      @if (aviso()) { <p class="ar-aviso" role="status">{{ aviso() }}</p> }
      @if (cargando()) { <p class="ar-nota">Cargando los acuerdos…</p> }
      @if (error()) {
        <p class="ar-error" role="alert">{{ error() }}</p>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="cargar()"><span class="p-button-label">Reintentar</span></button>
      }
      @if (datos(); as d) {
        @if (d.acuerdos.length) {
          <ul class="ar-lista">
            @for (a of d.acuerdos; track a.id) {
              <li>
                <a class="ar-desc" [routerLink]="['/compras/acuerdos']" [queryParams]="{ acuerdo: a.id }">{{ a.description }}</a>
                <span class="ar-meta">
                  <p-tag [value]="etiqueta(a.situacion)" [severity]="sev(a.situacion)" />
                  <span class="ar-sub">{{ linea(a, d.hoy) }}</span>
                </span>
              </li>
            }
          </ul>
        } @else if (d.no_recibe) {
          <p class="ar-falta">{{ d.no_recibe }}</p>
        } @else {
          <p class="ar-falta">Sin acuerdos capturados.{{ puedeAgendar() ? ' Captura lo que se decidió, con su responsable y su fecha.' : '' }}</p>
        }

        @if (d.del_proveedor.total) {
          <h3 class="ar-otro">Sigue abierto con este proveedor, de otras reuniones ({{ d.del_proveedor.total }})</h3>
          <ul class="ar-lista">
            @for (a of d.del_proveedor.acuerdos; track a.id) {
              <li>
                <a class="ar-desc" [routerLink]="['/compras/acuerdos']" [queryParams]="{ acuerdo: a.id }">{{ a.description }}</a>
                <span class="ar-meta">
                  <p-tag [value]="etiqueta(a.situacion)" [severity]="sev(a.situacion)" />
                  <span class="ar-sub">{{ linea(a, d.hoy) }}</span>
                </span>
              </li>
            }
          </ul>
          @if (d.del_proveedor.total > d.del_proveedor.acuerdos.length) {
            <p class="ar-nota">Se ven los {{ d.del_proveedor.acuerdos.length }} que vencen primero de {{ d.del_proveedor.total }}: todos están en la pestaña Acuerdos.</p>
          }
        }
      }
    </section>
    <app-acuerdo-form (guardado)="alGuardar($event)" />
  `,
  styles: [`
    :host { display: block; }
    .ar { display: flex; flex-direction: column; gap: var(--sp-1); align-items: stretch; }
    .ar-cabeza { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    h3 {
      margin: 0; font-size: var(--fs-micro); font-weight: var(--fw-medium);
      text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2);
    }
    .ar-otro { margin-top: var(--sp-3); }
    .ar-lista { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ar-lista li { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
    /* La etiqueta va en el renglón de área, responsable y plazo: sola en su renglón alargaba la lista (prueba visual). */
    .ar-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); }
    .ar-desc { font-weight: var(--fw-medium); color: var(--fg-1); text-decoration: none; overflow-wrap: anywhere; }
    .ar-desc:hover { text-decoration: underline; }
    .ar-desc:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .ar-sub, .ar-nota { margin: 0; font-size: var(--fs-xs); color: var(--fg-2); }
    .ar-falta { margin: 0; color: var(--fg-2); font-style: italic; }
    .ar-aviso { margin: 0; padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); font-size: var(--fs-xs); }
    .ar-error {
      margin: 0; padding: var(--sp-1) var(--sp-2); border: 1px solid var(--bad-border); border-radius: var(--r-md);
      background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-xs);
    }
    @media (pointer: coarse) {
      button[pButton] { min-height: var(--tap-min, 44px); }
      .ar-desc { display: inline-flex; align-items: center; min-height: var(--tap-min, 44px); }
    }
  `],
})
export class AcuerdosDeReunionComponent {
  private readonly api = inject(AcuerdosProveedoresService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly form = viewChild.required(AcuerdoFormComponent);

  readonly meetingId = input.required<string>();
  /** El proveedor en palabras (para el encabezado del formulario). */
  readonly proveedor = input.required<string>();
  readonly puedeAgendar = input(false);

  readonly datos = signal<AcuerdosDeReunion | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);

  /** Área · responsable · plazo (sólo si agrega algo a la etiqueta), en un renglón junto a la etiqueta. */
  linea = (a: AcuerdoVista, hoy: string) => [areaAcuerdo(a.area), responsableEnPalabras(a).quien, plazoAparte(a, hoy)].filter(Boolean).join(' · ');
  etiqueta = (s: SituacionAcuerdo) => ETIQUETA_SITUACION_ACUERDO[s];
  sev = (s: SituacionAcuerdo) => SEVERIDAD_ACUERDO[s];

  constructor() {
    // Otra reunión abierta en el mismo detalle: sus acuerdos, no los de la anterior.
    effect(() => {
      this.meetingId();
      untracked(() => { this.aviso.set(null); this.cargar(); });
    });
  }

  cargar(): void {
    const id = this.meetingId();
    this.cargando.set(true);
    this.error.set(null);
    this.api.deReunion(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { if (d.meeting_id === this.meetingId()) this.datos.set(d); this.cargando.set(false); },
      error: (e) => { this.error.set(motivoHttp(e, 'leer los acuerdos de la reunión')); this.cargando.set(false); },
    });
  }

  capturar(): void {
    const d = this.datos();
    if (!d) return;
    this.aviso.set(null);
    this.form().capturar({ meetingId: d.meeting_id, meetingDate: d.meeting_date, proveedor: this.proveedor(), organizador: d.organizer.nombre });
  }

  alGuardar(mensaje: string): void {
    this.aviso.set(mensaje);
    this.cargar();
  }
}
