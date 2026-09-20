import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * `[TDA.A1]` Sección declarada pero todavía sin datos.
 *
 * Las 4 pestañas de Análisis de ventas se publicaron juntas porque la estructura es
 * parte de lo que se pidió: ver de entrada que el análisis se organiza en Tráfico,
 * Productos, Clientes y Promociones. Dos de ellas aún no tienen dato.
 *
 * Lo que NO hacen: pintar tarjetas en cero, gráficas de ejemplo ni tablas vacías con
 * cara de "no hubo venta". Un cero dibujado por no haber podido medir es exactamente lo
 * que prohíbe ADR-056, y en una pestaña nueva es peor: el que la abre no tiene forma de
 * saber si el negocio está en cero o el módulo no existe. Así que dicen qué va a vivir
 * ahí, con qué fuente, y qué falta para tenerlo.
 *
 * OJO: acá adentro NO van acentos graves (template literal de JS).
 */
@Component({
  selector: 'app-analisis-proxima-etapa',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card-premium card-flat pe-card">
      <i [class]="icon() + ' pe-icon'" aria-hidden="true"></i>
      <div class="pe-body">
        <h2 class="pe-title">{{ titulo() }}</h2>
        <p class="pe-lead">{{ lead() }}</p>

        <h3 class="pe-h3">Qué va a vivir acá</h3>
        <ul class="pe-list">
          @for (p of puntos(); track p) { <li>{{ p }}</li> }
        </ul>

        <h3 class="pe-h3">Qué falta para tenerlo</h3>
        <p class="pe-falta">{{ falta() }}</p>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .pe-card { display: flex; align-items: flex-start; gap: 1rem; padding: 1.4rem; max-width: 74ch; }
      .pe-icon { font-size: 1.6rem; color: var(--text-muted); margin-top: .15rem; }
      .pe-body { min-width: 0; }
      .pe-title { margin: 0; font-size: 1rem; font-weight: 700; }
      .pe-lead { margin: .35rem 0 0; font-size: .82rem; color: var(--text-muted); }
      .pe-h3 { margin: 1.1rem 0 .35rem; font-size: .72rem; font-weight: 700; letter-spacing: .05em;
               text-transform: uppercase; color: var(--text-muted); }
      .pe-list { margin: 0; padding-left: 1.1rem; font-size: .82rem; line-height: 1.6; }
      .pe-falta { margin: 0; font-size: .82rem; color: var(--text-muted); }
    `,
  ],
})
export class AnalisisProximaEtapaComponent {
  readonly icon = input<string>('pi pi-clock');
  readonly titulo = input.required<string>();
  readonly lead = input.required<string>();
  readonly puntos = input.required<string[]>();
  readonly falta = input.required<string>();
}
