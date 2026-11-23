import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpParams } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import type { HrRegistroLegalDto } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';

/** `[RH.15.9]` Lo más largo que se pide de una vez: un año más el margen (el servidor topa igual). */
export const DIAS_REGISTRO = 400;

/**
 * Fase RH · `[RH.15.9]` — «Registro para la autoridad», en la ficha de la persona.
 *
 * LFT 132-XXXIV: el patrón entrega el registro de la jornada cuando la autoridad lo pide. Baja un CSV con las
 * checadas tal como las entregó el reloj y su huella sha256 al final, para demostrar que no se tocó. Por defecto, el
 * último año (lo que se conserva después de una baja, art. 804).
 */
@Component({
  selector: 'app-rh-registro-legal',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rl" role="group" aria-label="Registro para la autoridad">
      <span class="rl-tit">Registro para la autoridad</span>
      <label>Del <input type="date" [ngModel]="desde()" (ngModelChange)="desde.set($event)" [max]="hasta()" /></label>
      <label>al <input type="date" [ngModel]="hasta()" (ngModelChange)="hasta.set($event)" [min]="desde()" /></label>
      <p-button label="Bajar CSV" icon="pi pi-download" size="small" [outlined]="true" [disabled]="!!falta() || bajando()" [loading]="bajando()" (onClick)="bajar()" />
      @if (falta(); as f) { <span class="rl-nota" role="status">{{ f }}</span> }
      @else if (listo(); as l) { <span class="rl-nota" role="status">{{ l }}</span> }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rl { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-2) 0; font-size: var(--fs-sm); color: var(--text-main); }
    .rl-tit { font-weight: 600; }
    .rl label { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .rl input[type='date'] { min-height: var(--tap-min); border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 0 var(--sp-1); background: var(--card-bg); color: var(--text-main); }
    .rl-nota { font-size: var(--fs-xs); color: var(--text-muted); }
  `],
})
export class RhRegistroLegalComponent {
  private readonly http = inject(HttpClient);
  private readonly est = inject(RhAsistenciaEstado);
  private readonly destroyRef = inject(DestroyRef);

  readonly codigo = input.required<string>();
  readonly hoy = input.required<string>();

  readonly hasta = signal('');
  readonly desde = signal('');
  readonly bajando = signal(false);
  readonly listo = signal<string | null>(null);

  readonly falta = computed<string | null>(() => {
    const d = this.desde() || this.porDefecto().desde, h = this.hasta() || this.porDefecto().hasta;
    if (!d || !h) return 'Elige el periodo.';
    if (h < d) return 'La fecha final es anterior a la inicial.';
    const dias = Math.round((Date.parse(`${h}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000);
    return dias > DIAS_REGISTRO ? `Más de ${DIAS_REGISTRO} días: pídelo en dos partes.` : null;
  });

  /** El último año hasta hoy. */
  readonly porDefecto = computed(() => {
    const h = this.hoy();
    const d = new Date(`${h}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return { desde: d.toISOString().slice(0, 10), hasta: h };
  });

  constructor() {
    queueMicrotask(() => { if (!this.desde()) { this.desde.set(this.porDefecto().desde); this.hasta.set(this.porDefecto().hasta); } });
  }

  bajar(): void {
    const site = this.est.sitio();
    if (!site || this.bajando() || this.falta()) return;
    this.bajando.set(true);
    this.listo.set(null);
    const params = new HttpParams().set('site_code', site).set('person_code', this.codigo())
      .set('date_from', this.desde()).set('date_to', this.hasta());
    this.http.get<HrRegistroLegalDto>(`${environment.apiUrl}/hr/attendance/registro`, { params })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.bajando.set(false);
          const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
          const a = document.createElement('a');
          a.href = url; a.download = `registro-jornada_${r.site_code}_${r.person_code}_${r.date_from}_${r.date_to}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          this.listo.set(`${r.filas} checadas · huella ${r.sha256.slice(0, 12)}…`);
        },
        error: (e) => {
          this.bajando.set(false);
          const m = (e as { error?: { message?: string } })?.error?.message;
          this.listo.set(m || 'No se pudo bajar el registro.');
        },
      });
  }
}
