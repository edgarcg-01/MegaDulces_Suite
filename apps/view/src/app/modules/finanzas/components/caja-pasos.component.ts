import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PASOS_CORTE, type PasoCorte } from '../pages/caja-general/caja-captura.util';

/**
 * `[CGP-V.1]` En qué paso va el corte: abrir → contar a ciegas → revisar la diferencia → cerrar →
 * autorizar. Sólo pinta; el paso lo decide `pasoDelCorte()` con lo que dice el servidor.
 *
 * ⚠️ No hay stepper compartido (`DESIGN.md` lo lista entre los huecos). Es de sólo lectura a
 * propósito: el `p-stepper` de PrimeNG es navegable, y acá saltar de paso no existe.
 * El estado no depende sólo del color: cada paso lleva su icono, el actual va en negrita y con
 * `aria-current="step"`, y los hechos se anuncian como hechos.
 */
@Component({
  selector: 'app-caja-pasos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="cp-pasos" aria-label="Pasos del corte">
      @for (p of pasos; track p.paso; let i = $index) {
        <li class="cp-paso" [class.cp-hecho]="i < indice()" [class.cp-actual]="i === indice()"
            [attr.aria-current]="i === indice() ? 'step' : null">
          <i class="pi" aria-hidden="true" [class.pi-check]="i < indice()"
             [class.pi-arrow-right]="i === indice()" [class.pi-circle]="i > indice()"></i>
          <span>{{ p.label }}</span>
          @if (i < indice()) { <span class="sr-only">, hecho</span> }
        </li>
      }
    </ol>
    @if (texto()) { <p class="cp-sigue">{{ texto() }}</p> }
  `,
  styles: [`
    :host { display: block; }
    .cp-pasos {
      display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3);
      margin: 0; padding: 0; list-style: none;
      font-size: var(--fs-xs); color: var(--text-faint);
    }
    .cp-paso { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .cp-paso .pi { font-size: var(--fs-micro); }
    .cp-hecho { color: var(--text-muted); }
    .cp-actual { color: var(--text-main); font-weight: 600; }
    .cp-actual .pi { color: var(--action); }
    .cp-sigue { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class CajaPasosComponent {
  paso = input.required<PasoCorte>();
  /** Qué sigue, en una frase. Vacío = sólo los pasos (el diálogo ya trae sus propios avisos). */
  texto = input<string>('');
  readonly pasos = PASOS_CORTE;
  indice = computed(() => PASOS_CORTE.findIndex((p) => p.paso === this.paso()));
}
