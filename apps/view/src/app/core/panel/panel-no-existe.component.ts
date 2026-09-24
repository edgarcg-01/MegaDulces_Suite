import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * `[MT.5.2]` Lo que muestra el PANEL cuando el camino que le pidieron no existe.
 *
 * ── Por qué no se reusa el 404 de la app ──────────────────────────────────────
 * `NotFoundComponent` es una pantalla completa: trae sugerencias, "Volver" y
 * "Ver todos los proyectos". Metida en una columna de 500 px se ve rota, y sus
 * botones sacan de la pantalla que quedó a la izquierda — justo lo contrario de
 * para lo que existe el panel. Acá alcanza con decir qué pasó; la salida es la
 * X que ya está arriba.
 *
 * ── Por qué existe en vez de dejar que no matchee ─────────────────────────────
 * Si NINGUNA ruta del espejo matchea, **falla la navegación entera** y la app
 * queda en blanco (`NG04002`) — es el incidente del 2026-09-24. El panel tiene
 * que poder decir "esto no existe" sin tumbar lo de al lado.
 */
@Component({
  selector: 'app-panel-no-existe',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pne">
      <i class="pi pi-link" aria-hidden="true"></i>
      <p class="pne-t">Esto no se puede abrir al lado</p>
      <p class="pne-d">La dirección que se pidió para el panel no corresponde a ninguna pantalla.</p>
    </div>
  `,
  styles: [`
    .pne { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; padding: 2rem 1.25rem; }
    .pne i { font-size: 1.25rem; color: var(--c-text-3); }
    .pne-t { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--c-text-1); }
    .pne-d { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--c-text-2); max-width: 28rem; }
  `],
})
export class PanelNoExisteComponent {}
