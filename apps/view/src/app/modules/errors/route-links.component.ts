import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Destino ofrecido al usuario desde una pantalla de error. */
export interface RouteLink {
  label: string;
  route: string;
  project: string;
  icon: string;
}

/**
 * Lista de salidas de una pantalla de error.
 *
 * La usan el 404 ("¿buscabas alguna de estas?") y el 403 ("esto sí podés
 * abrir"). Es el mismo organismo porque cumple la misma función: convertir un
 * callejón sin salida en un camino. Quien la usa se encarga de que TODO lo que
 * pasa acá sea abrible por el usuario — ofrecer algo que el guard va a rebotar
 * es peor que no ofrecer nada.
 */
@Component({
  selector: 'app-route-links',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length) {
      <nav class="rl" [attr.aria-label]="heading()">
        <h2 class="rl-h">{{ heading() }}</h2>
        <ul class="rl-list">
          @for (i of items(); track i.route) {
            <li>
              <a class="rl-item" [routerLink]="i.route">
                <i class="rl-ico" [class]="i.icon" aria-hidden="true"></i>
                <span class="rl-txt">
                  <span class="rl-label">{{ i.label }}</span>
                  <span class="rl-route">{{ i.project }} · {{ i.route }}</span>
                </span>
                <i class="pi pi-arrow-right rl-go" aria-hidden="true"></i>
              </a>
            </li>
          }
        </ul>
      </nav>
    }
  `,
  styles: [`
    :host { display: block; }
    .rl { margin-top: var(--sp-8); }
    .rl-h {
      margin: 0 0 var(--sp-2);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: var(--fw-bold);
      color: var(--c-text-3);
    }
    .rl-list { list-style: none; margin: 0; padding: 0; }
    .rl-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--sp-3);
      padding: var(--sp-3);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-sm);
      margin-bottom: var(--sp-2);
      text-decoration: none;
      color: inherit;
      transition: background-color var(--dur-micro) var(--ease-standard),
                  border-color var(--dur-micro) var(--ease-standard);
    }
    .rl-item:hover { background: var(--overlay-hover); border-color: var(--c-text-3); }
    .rl-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .rl-ico { color: var(--c-text-3); font-size: var(--fs-body); }
    .rl-txt { display: flex; flex-direction: column; min-width: 0; }
    .rl-label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--c-text-1); }
    .rl-route {
      font-size: var(--fs-micro);
      color: var(--c-text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rl-go { color: var(--c-text-3); font-size: var(--fs-xs); }
    .rl-item:hover .rl-go { color: var(--action); }
  `],
})
export class RouteLinksComponent {
  readonly heading = input.required<string>();
  readonly items = input.required<RouteLink[]>();
}
