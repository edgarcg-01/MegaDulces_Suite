import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { departamentoDe, hora12, rebasados } from '../reporte-formato';

/**
 * Fase RH · `[RH.1.7c]` — Tolerancia (`/rh/asistencia/tolerancia`): quién ya se pasó de los minutos de tolerancia de
 * su semana, del que más se pasó al que menos. Como en Mega Talento, la regla se dice una vez y a la vista, y quien
 * tiene el número BLOQUEADO (su horario todavía no se puede dar por bueno) va aparte: el pendiente es de RH, no de la
 * persona. En las sucursales no hay hora límite: ahí no se mide.
 */
@Component({
  selector: 'app-rh-tolerancia',
  standalone: true,
  imports: [NgTemplateOutlet, LoadStateComponent, RhMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rt-page">
      <app-rh-marco [barra]="true" [franja]="true" />
      <app-load-state [loading]="est.loading() && !est.datos()" [error]="est.error()" (retry)="est.asegurar(true)">
        <section class="rt-card" aria-label="Tolerancia rebasada">
          @if (!mide()) {
            <p class="rt-nota"><b>Esta plaza no tiene hora límite de entrada.</b> En las sucursales cada quien entra en su turno —hay quien entra tarde
              porque ése es su horario—, así que aquí no se mide retardo ni tolerancia. Las faltas y los descansos sí se cuentan.</p>
          } @else {
            <p class="rt-nota">Cada semana (de jueves a miércoles) trae <b>{{ bolsa() }} minutos</b> de tolerancia. El horario contra el que se mide es de
              <b>hora en punto o media hora</b> y sale de las propias checadas de la persona: quien entra 8:32 y 8:36 tiene horario de 8:30, no de 8:00.
              Los minutos de más se suman día por día, y aquí aparece quien <b>ya se pasó de los {{ bolsa() }}</b>: se cobra sólo el excedente.</p>
            @if (!lista().usables.length && !lista().porConfirmar.length) {
              <p class="rt-vacio">Nadie agotó su tolerancia en este periodo. Los minutos sueltos que hubo cupieron en los {{ bolsa() }} de su semana.</p>
            }
            @if (lista().usables.length) {
              <ng-container [ngTemplateOutlet]="tabla" [ngTemplateOutletContext]="{ $implicit: lista().usables }" />
            }
            @if (lista().porConfirmar.length) {
              <h3 class="rt-sub">Por confirmar ({{ lista().porConfirmar.length }})</h3>
              <p class="rt-nota rt-chica">También se pasaron, pero su horario todavía no se puede dar por bueno. Primero se confirma el horario; el pendiente es de RH.</p>
              <ng-container [ngTemplateOutlet]="tabla" [ngTemplateOutletContext]="{ $implicit: lista().porConfirmar }" />
            }
          }
        </section>
      </app-load-state>
    </div>

    <ng-template #tabla let-personas>
      <div class="rt-scroll">
        <table class="rt-tabla">
          <thead><tr><th scope="col">Clv</th><th scope="col">Nombre</th><th scope="col">Departamento</th><th scope="col">Entra</th>
            <th class="num" scope="col">Min. tarde</th><th class="num" scope="col">Tolerancia</th><th class="num" scope="col">Excede</th></tr></thead>
          <tbody>
            @for (p of personas; track p.codigo) {
              <tr tabindex="0" (click)="ver(p)" (keydown.enter)="ver(p)" [attr.aria-label]="'Abrir la ficha de ' + (p.nombreCompleto || p.nombre)">
                <td class="mono">{{ p.codigo }}</td>
                <td><b>{{ p.nombreCompleto || p.nombre }}</b></td>
                <td>{{ depto(p) }}</td>
                <td class="mono">{{ entra(p) }}</td>
                <td class="num">{{ p.atrasoBrutoMin }}</td>
                <td class="num">{{ bolsa() }}</td>
                <td class="num rt-exc">{{ p.retardoRealMin }} min</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </ng-template>
  `,
  styles: [`
    :host { display: block; }
    .rt-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rt-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rt-nota { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .rt-nota b { color: var(--text-main); }
    .rt-chica { padding-top: 0; font-size: var(--fs-xs); }
    .rt-sub { margin: var(--sp-3) var(--sp-3) 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .rt-vacio { margin: 0; padding: var(--sp-4) var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); }
    .rt-scroll { overflow-x: auto; }
    .rt-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rt-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rt-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); }
    .rt-tabla tbody tr { cursor: pointer; }
    .rt-tabla tbody tr:hover td { background: var(--surface-hover-bg); }
    .rt-tabla tbody tr:focus-visible td { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    th.num { text-align: right; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rt-exc { color: var(--bad-fg); font-weight: 700; }
    @media (max-width: 40rem) { .rt-page { padding: var(--sp-3); } }
  `],
})
export class RhToleranciaComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly router = inject(Router);

  readonly mide = computed(() => this.est.datos()?.mideRetardo ?? true);
  readonly bolsa = computed(() => this.est.datos()?.bolsaSemanalMin ?? 15);
  readonly lista = computed(() => rebasados(this.est.datos()));

  depto(p: HrPersonaAsistencia): string { return departamentoDe(p); }
  entra(p: HrPersonaAsistencia): string { return hora12(p.horarioAsignado?.entrada ?? p.horario ?? '') || '—'; }

  /** Su ficha, en Checadas: ahí se justifica o se le asigna horario. */
  ver(p: HrPersonaAsistencia): void {
    this.est.fichaPendiente.set(p.codigo);
    void this.router.navigate(['/rh/asistencia']);
  }
}
