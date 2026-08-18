import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ErrorShellComponent } from './error-shell.component';
import { RouteLinksComponent } from './route-links.component';
import { AccessibleRoutesService } from './accessible-routes.service';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { PERMISSION_META } from '../../core/constants/permission-meta';
import { Permission } from '../../core/constants/permissions';

/**
 * 403 — la sección existe, pero este rol no la abre.
 *
 * Antes esto era una redirección MUDA a /dashboard: hacías clic, aparecías en
 * otro lado y nunca sabías si te faltaba permiso, si la sección se había movido
 * o si le habías errado. Es el error más frecuente de la app (96 rutas con
 * permiso, permisos restrictivos que arrancan sin asignar), y era el único que
 * no decía nada.
 *
 * Tres decisiones de fondo:
 *
 *  - **No culpa al usuario.** Que falte un permiso es una cuestión de
 *    configuración, no un error de quien hizo clic. El texto lo trata así.
 *  - **Nombra el permiso en castellano**, con `PERMISSION_META`, no la clave del
 *    enum. "Te falta Ver Precios" es pedible; "COMMERCIAL_PRICING_VER" no.
 *  - **Avisa lo del re-login.** Que te asignen el permiso no basta: viaja en el
 *    JWT y no aparece hasta volver a entrar. Es la confusión recurrente del
 *    proyecto ("ya me lo diste y sigo sin verlo") y el mejor lugar para
 *    contarla es justo acá.
 */
@Component({
  selector: 'app-forbidden',
  standalone: true,
  imports: [RouterLink, ButtonModule, ErrorShellComponent, RouteLinksComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-error-shell
      eyebrow="Acceso denegado"
      title="Tu rol no abre esta sección"
      [detail]="attempted()"
      detailLabel="Sección a la que intentaste entrar:">

      @if (missing(); as m) {
        <p class="fb-lead">
          Hace falta el permiso <b>{{ m.label }}</b>, que hoy tu rol
          <b>{{ roleName() }}</b> no tiene.
        </p>
        @if (m.description) {
          <p class="fb-what">{{ m.description }}</p>
        }
      } @else {
        <p class="fb-lead">
          Tu rol <b>{{ roleName() }}</b> no tiene permiso para entrar acá.
        </p>
      }

      <div class="fb-how">
        <h2 class="fb-how-h">Cómo se resuelve</h2>
        @if (canManageRoles()) {
          <p>
            Podés asignártelo vos mismo desde la administración de roles.
          </p>
        } @else {
          <p>
            Pedíselo a quien administre los roles del sistema, mencionando el
            nombre del permiso de arriba.
          </p>
        }
        <p class="fb-relogin">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Después de que te lo asignen tenés que <b>cerrar sesión y volver a
          entrar</b>: los permisos viajan en tu sesión y no se actualizan solos.
        </p>
      </div>

      <app-route-links heading="Esto sí podés abrir" [items]="alternatives()" />

      <!-- Sin "Volver": se llegó acá por una redirección del guard, así que atrás
           es la ruta vedada y rebotaría de nuevo. Desde un 403 los movimientos
           que sirven son hacia adelante. -->
      <div error-actions>
        @if (canManageRoles()) {
          <a pButton [outlined]="true" severity="secondary" size="small" routerLink="/admin/roles">
            <span class="p-button-icon p-button-icon-left pi pi-shield" aria-hidden="true"></span>
            <span class="p-button-label">Administrar roles</span>
          </a>
        }
        <a pButton [outlined]="true" severity="secondary" size="small" routerLink="/projects">
          <span class="p-button-icon p-button-icon-left pi pi-th-large" aria-hidden="true"></span>
          <span class="p-button-label">Ver todos los proyectos</span>
        </a>
      </div>
    </app-error-shell>
  `,
  styles: [`
    :host { display: block; }

    .fb-lead {
      margin: 0;
      font-size: var(--fs-sm);
      line-height: 1.5;
      color: var(--c-text-2);
      max-width: 38rem;
    }
    .fb-lead b { color: var(--c-text-1); font-weight: var(--fw-bold); }
    .fb-what {
      margin: var(--sp-2) 0 0;
      font-size: var(--fs-sm);
      line-height: 1.5;
      color: var(--c-text-3);
      max-width: 38rem;
    }

    /* El "cómo se resuelve" va en su propio bloque: es la parte accionable y
       compite con la explicación si queda como un párrafo más. */
    .fb-how {
      margin-top: var(--sp-6);
      padding: var(--sp-4);
      background: var(--c-surface-2);
      border-radius: var(--r-sm);
    }
    .fb-how-h {
      margin: 0 0 var(--sp-2);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: var(--fw-bold);
      color: var(--c-text-3);
    }
    .fb-how p {
      margin: 0;
      font-size: var(--fs-sm);
      line-height: 1.5;
      color: var(--c-text-2);
    }
    /* Lo del re-login es la trampa que más tiempo hace perder: se marca. */
    /* Especificidad en vez de !important para ganarle al 'margin: 0' de arriba. */
    .fb-how .fb-relogin {
      margin-top: var(--sp-3);
      padding-top: var(--sp-3);
      border-top: 1px solid var(--c-divider);
      display: flex;
      gap: var(--sp-2);
    }
    .fb-relogin i { color: var(--c-warn); margin-top: 2px; flex: none; }
    .fb-relogin b { color: var(--c-text-1); font-weight: var(--fw-bold); }
  `],
})
export class ForbiddenComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly routes = inject(AccessibleRoutesService);

  /** Ruta que se quiso abrir; la pasa el guard en `?from=`. */
  readonly attempted = computed(() => this.route.snapshot.queryParamMap.get('from') ?? '—');

  /** Permiso que faltó, ya traducido a lenguaje de persona. */
  readonly missing = computed(() => {
    const key = this.route.snapshot.queryParamMap.get('perm');
    return key ? PERMISSION_META[key] ?? null : null;
  });

  readonly roleName = computed(() => this.auth.user()?.role_name ?? 'actual');

  readonly canManageRoles = computed(
    () => this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.ROLES_VER],
  );

  /** Lo accesible dentro del MISMO proyecto: el usuario ya sabía a dónde iba. */
  readonly alternatives = computed(() => {
    const from = this.route.snapshot.queryParamMap.get('from') ?? '';
    const near = this.routes.inProject(from);
    return near.length ? near : this.routes.accessible().slice(0, 4);
  });

}
