import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { departamentoDe, diaLargo, faltasDelPeriodo, horarioDe } from '../reporte-formato';

/**
 * Fase RH · `[RH.1.7c]` — Faltas (`/rh/asistencia/faltas`): cada día que una persona normalmente trabaja y en el que
 * no checó, con el botón para capturar la incidencia que la justifica. El día de hoy no cuenta: todavía no termina.
 * Si el reloj de la plaza no ha reportado, se dice arriba: un día sin dato no es una falta.
 */
@Component({
  selector: 'app-rh-faltas',
  standalone: true,
  imports: [ButtonModule, LoadStateComponent, RhMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rf-page">
      <app-rh-marco [barra]="true" [franja]="true" />
      <app-load-state [loading]="est.loading() && !est.datos()" [error]="est.error()" (retry)="est.asegurar(true)">
        <section class="rf-card" aria-label="Faltas">
          <p class="rf-nota">Una <b>falta</b> es un día que esa persona normalmente trabaja y en el que no checó. Sólo se cuenta entre su primera checada
            y la última, y el día de hoy no entra hasta que termine. Se justifica capturando una incidencia (vacaciones, permiso, incapacidad…).</p>
          @if (!faltas().length) {
            <p class="rf-vacio">Nadie faltó en este periodo.</p>
          } @else {
            <div class="rf-scroll">
              <table class="rf-tabla">
                <thead><tr><th scope="col">Clv</th><th scope="col">Nombre</th><th scope="col">Departamento</th><th scope="col">Día</th><th scope="col">Su horario</th>
                  <th scope="col"><span class="sr-only">Acción</span></th></tr></thead>
                <tbody>
                  @for (f of faltas(); track f.persona.codigo + f.fecha) {
                    <tr>
                      <td class="mono">{{ f.persona.codigo }}</td>
                      <td><button type="button" class="rf-nom" (click)="ver(f.persona)">{{ f.persona.nombreCompleto || f.persona.nombre }}</button></td>
                      <td>{{ depto(f.persona) }}</td>
                      <td class="mono">{{ dia(f.fecha) }}@if (f.inc) { <span class="rf-inc">{{ f.inc }}</span> }</td>
                      <td>{{ horario(f.persona) }}</td>
                      <td class="rf-acc">
                        @if (puedeCapturar()) {
                          <p-button label="Capturar incidencia" severity="secondary" [outlined]="true" size="small" (onClick)="capturar(f.persona, f.fecha)" />
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rf-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rf-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rf-nota { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .rf-nota b { color: var(--text-main); }
    .rf-vacio { margin: 0; padding: var(--sp-4) var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); }
    .rf-scroll { overflow-x: auto; }
    .rf-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rf-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rf-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rf-nom { border: 0; background: none; padding: 0; font: inherit; font-weight: 700; color: var(--text-main); cursor: pointer; text-align: left; }
    .rf-nom:hover { text-decoration: underline; }
    .rf-nom:focus-visible { outline: 2px solid var(--focus-ring); }
    .rf-inc { display: inline-block; margin-left: var(--sp-1); font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 4px; border-radius: var(--r-sm);
      background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .rf-acc { text-align: right; white-space: nowrap; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 40rem) { .rf-page { padding: var(--sp-3); } }
  `],
})
export class RhFaltasComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);

  readonly faltas = computed(() => faltasDelPeriodo(this.est.datos(), this.est.hoy()));
  readonly puedeCapturar = computed(() => this.perms.has(Permission.HR_INCIDENTS_CAPTURAR));

  depto(p: HrPersonaAsistencia): string { return departamentoDe(p); }
  dia(f: string): string { return diaLargo(f); }
  horario(p: HrPersonaAsistencia): string { return horarioDe(p).texto; }

  ver(p: HrPersonaAsistencia): void {
    this.est.fichaPendiente.set(p.codigo);
    void this.router.navigate(['/rh/asistencia']);
  }

  /** La captura vive en Incidencias: se llega con la persona, la plaza y el día ya puestos. */
  capturar(p: HrPersonaAsistencia, fecha: string): void {
    void this.router.navigate(['/rh/incidencias'], { queryParams: { nueva: 1, site: this.est.sitio(), persona: p.codigo, desde: fecha } });
  }
}
