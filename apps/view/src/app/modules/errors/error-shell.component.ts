import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Armazón común de las pantallas de error (404 · 403 · falla inesperada).
 *
 * Existe para que sean una FAMILIA y no tres páginas sueltas: misma jerarquía,
 * mismo ritmo, mismo lugar para el dato técnico. Lo que cambia entre una y otra
 * es el contenido, no la forma.
 *
 * Composición, de arriba a abajo:
 *   1. Antetítulo con el código, discreto. En una herramienta interna importa
 *      más QUÉ falló que un número gigante de decoración.
 *   2. Titular en lenguaje de persona, no de protocolo.
 *   3. El dato con el que el usuario puede hacer algo: la dirección que no
 *      existe, el permiso que falta, el identificador para reportar.
 *   4. Cuerpo proyectado: explicación y salidas concretas.
 *   5. Acciones.
 *
 * Superficie Operations: sin ilustraciones, sin Fraunces, sin condescendencia.
 */
@Component({
  selector: 'app-error-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="es">
      <p class="es-eyebrow">{{ eyebrow() }}</p>
      <h1 class="es-title">{{ title() }}</h1>

      @if (detail()) {
        <p class="es-detail">
          @if (detailLabel()) { <span class="sr-only">{{ detailLabel() }}</span> }
          <code>{{ detail() }}</code>
        </p>
      }

      <div class="es-body">
        <ng-content />
      </div>

      <div class="es-actions">
        <ng-content select="[error-actions]" />
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }

    .es {
      max-width: 44rem;
      margin: 0 auto;
      padding: var(--sp-12) var(--sp-4) var(--sp-8);
    }

    .es-eyebrow {
      margin: 0 0 var(--sp-2);
      font-family: var(--font-mono);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--c-text-3);
    }
    .es-title {
      margin: 0;
      font-size: var(--fs-h1);
      font-weight: var(--fw-bold);
      letter-spacing: -0.02em;
      color: var(--c-text-1);
      text-wrap: balance;
    }

    /* El dato técnico va en mono y con scroll propio: una URL larga o un id no
       deben desbordar la página ni partirse en cinco renglones. */
    .es-detail { margin: var(--sp-4) 0 0; min-width: 0; }
    .es-detail code {
      display: block;
      overflow-x: auto;
      white-space: nowrap;
      padding: var(--sp-2) var(--sp-3);
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-sm);
      font-family: var(--font-mono);
      font-size: var(--fs-sm);
      color: var(--c-text-2);
    }

    .es-body { margin-top: var(--sp-3); }
    .es-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2);
      margin-top: var(--sp-8);
    }
    .es-actions:empty { display: none; }
  `],
})
export class ErrorShellComponent {
  /** Código o categoría, en mono discreto. Ej: "Error 404". */
  readonly eyebrow = input.required<string>();
  /** Titular en lenguaje de persona. Ej: "Esta página no existe". */
  readonly title = input.required<string>();
  /** Dato accionable en mono. Ej: la URL fallida, el id del error. */
  readonly detail = input<string | null>(null);
  /** Qué es ese dato, sólo para lectores de pantalla. */
  readonly detailLabel = input<string>('');
}
