import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { PageTabsComponent } from '../../shared/components/page-tabs/page-tabs.component';
import { almacenTabsForUrl } from './almacen-tabs';

/**
 * Fase WMS.1 — shell de área del proyecto Almacén.
 *
 * Monta la barra de tabs **una sola vez** para todas las páginas del área, en
 * vez de repetir `<app-page-tabs>` en los ~19 componentes. El orden visual es
 * el mismo que ya usa Contabilidad con `variant="liquid"`: la barra va ARRIBA
 * del `surf-page-head` de la página.
 *
 * Las rutas hijas conservan sus paths — este shell es un padre con `path: ''`,
 * así que las URLs no cambian y los deep-links siguen valiendo.
 *
 * **Excepción handheld:** `/almacen/inventory/count` (con `countFocusGuard`) y
 * el detalle de vale `/recepcion-sesiones/:id` cuelgan FUERA de este shell. Son
 * pantallas de foco: una barra de tabs ahí invita al operario a irse a otra
 * pantalla a media tarima.
 */
@Component({
  selector: 'app-almacen-area-shell',
  standalone: true,
  imports: [RouterOutlet, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tabs().length > 1) {
      <div class="alm-area-tabs">
        <app-page-tabs [tabs]="tabs()" variant="liquid" />
      </div>
    }
    <router-outlet />
  `,
  styles: [
    `
      /* El host es un elemento extra entre el <main> del layout y la página;
         sin display:block quedaría inline y arruinaría el ancho. */
      :host {
        display: block;
        width: 100%;
      }
      /* Alineado con el padding horizontal de .surf-page (0 1.5rem) para que la
         barra quede a ras del page-head de la página que envuelve. */
      .alm-area-tabs {
        padding: var(--sp-3) 1.5rem 0;
      }
      @media (max-width: 768px) {
        .alm-area-tabs {
          padding: var(--sp-2) 1rem 0;
        }
      }
    `,
  ],
})
export class AlmacenAreaShellComponent {
  private router = inject(Router);

  private currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * `app-page-tabs` ya se esconde solo con 1 tab visible, pero el `@if` de
   * arriba evita además reservar el padding del contenedor cuando el rol solo
   * alcanza una superficie del área.
   */
  readonly tabs = computed(() => almacenTabsForUrl(this.currentUrl()));
}
