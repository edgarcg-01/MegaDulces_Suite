import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ErrorShellComponent } from './error-shell.component';
import { RouteLinksComponent } from './route-links.component';
import { AccessibleRoutesService } from './accessible-routes.service';
import { rankRoutes } from './route-suggest';

/**
 * 404 de la plataforma web.
 *
 * Se monta DENTRO del layout a propósito: el sidebar es la salida más rápida, y
 * como el layout deduce el proyecto leyendo la URL, un 404 bajo /comercial/… ya
 * aparece con el menú de Comercial al lado.
 *
 * Antes el comodín mandaba a /login, que con la sesión viva se leía como "se te
 * cayó la sesión": el usuario perdía dónde estaba por un dedazo en la URL.
 *
 * No confunde "no existe" con "no tenés permiso": las denegaciones de permiso
 * las manda `permissionGuard` a /sin-acceso, así que acá sólo llegan direcciones
 * que de verdad no existen.
 */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, ButtonModule, ErrorShellComponent, RouteLinksComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-error-shell
      eyebrow="Error 404"
      title="Esta página no existe"
      [detail]="attempted()"
      detailLabel="Dirección que intentaste abrir:">
      <p class="es-lead">
        Puede que la sección haya cambiado de nombre, que el enlace que seguiste
        esté viejo, o que se haya colado un error de dedo.
      </p>

      <app-route-links heading="¿Buscabas alguna de estas?" [items]="suggestions()" />

      <div error-actions>
        <button pButton severity="contrast" size="small" (click)="back()">
          <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
          <span class="p-button-label">Volver</span>
        </button>
        <a pButton [outlined]="true" severity="secondary" size="small" routerLink="/projects">
          <span class="p-button-icon p-button-icon-left pi pi-th-large" aria-hidden="true"></span>
          <span class="p-button-label">Ver todos los proyectos</span>
        </a>
      </div>
    </app-error-shell>
  `,
  styles: [`
    :host { display: block; }
    .es-lead {
      margin: 0;
      font-size: var(--fs-sm);
      line-height: 1.5;
      color: var(--c-text-2);
      max-width: 38rem;
    }
  `],
})
export class NotFoundComponent {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly routes = inject(AccessibleRoutesService);

  /** La URL que se pidió. El comodín no la consume: `router.url` la conserva. */
  readonly attempted = computed(() => this.router.url);

  /**
   * Sugerencias por parecido, sólo entre lo que el usuario puede abrir. El
   * filtro de permisos ya viene aplicado por `AccessibleRoutesService`.
   */
  readonly suggestions = computed(() => rankRoutes(this.attempted(), this.routes.accessible()));

  back(): void {
    // history.back() cuando hay de dónde volver; si se llegó pegando la URL en
    // la barra, el back saldría del sitio, así que ahí va al índice de proyectos.
    if (history.length > 1) this.location.back();
    else this.router.navigate(['/projects']);
  }
}
