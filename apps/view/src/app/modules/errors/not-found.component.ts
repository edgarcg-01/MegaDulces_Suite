import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { AUTHZ_TREE } from '../../core/constants/authz-tree';
import { Permission } from '../../core/constants/permissions';
import { rankRoutes } from './route-suggest';

/** Ruta candidata, aplanada del árbol de autorización. */
interface Target {
  label: string;
  route: string;
  project: string;
  icon: string;
  perms: Permission[];
}

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
 * las resuelve `permissionGuard` mandando a /dashboard, así que acá sólo llegan
 * direcciones que de verdad no existen.
 */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="nf">
      <p class="nf-code">Error 404</p>
      <h1 class="nf-title">Esta página no existe</h1>

      <p class="nf-path">
        <span class="sr-only">Dirección que intentaste abrir:</span>
        <code>{{ attempted() }}</code>
      </p>

      <p class="nf-lead">
        Puede que la sección haya cambiado de nombre, que el enlace que seguiste
        esté viejo, o que se haya colado un error de dedo.
      </p>

      @if (suggestions().length) {
        <div class="nf-sug">
          <h2 class="nf-sug-h">¿Buscabas alguna de estas?</h2>
          <ul class="nf-sug-list">
            @for (s of suggestions(); track s.route) {
              <li>
                <a class="nf-sug-item" [routerLink]="s.route">
                  <i class="nf-sug-ico" [class]="s.icon" aria-hidden="true"></i>
                  <span class="nf-sug-txt">
                    <span class="nf-sug-label">{{ s.label }}</span>
                    <span class="nf-sug-route">{{ s.project }} · {{ s.route }}</span>
                  </span>
                  <i class="pi pi-arrow-right nf-sug-go" aria-hidden="true"></i>
                </a>
              </li>
            }
          </ul>
        </div>
      }

      <div class="nf-actions">
        <button pButton severity="contrast" size="small" (click)="back()">
          <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
          <span class="p-button-label">Volver</span>
        </button>
        <a pButton [outlined]="true" severity="secondary" size="small" routerLink="/projects">
          <span class="p-button-icon p-button-icon-left pi pi-th-large" aria-hidden="true"></span>
          <span class="p-button-label">Ver todos los proyectos</span>
        </a>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }

    .nf {
      max-width: 44rem;
      margin: 0 auto;
      padding: var(--sp-12) var(--sp-4) var(--sp-8);
    }

    /* El código va de antetítulo discreto: en una herramienta interna importa
       más QUÉ dirección falló que un "404" gigante de decoración. */
    .nf-code {
      margin: 0 0 var(--sp-2);
      font-family: var(--font-mono);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--c-text-3);
    }
    .nf-title {
      margin: 0;
      font-size: var(--fs-h1);
      font-weight: var(--fw-bold);
      letter-spacing: -0.02em;
      color: var(--c-text-1);
      text-wrap: balance;
    }

    /* La dirección fallida es el dato accionable: casi siempre viene de un
       marcador viejo o de un enlace que alguien pegó. */
    .nf-path { margin: var(--sp-4) 0 0; min-width: 0; }
    .nf-path code {
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
    .nf-lead {
      margin: var(--sp-3) 0 0;
      font-size: var(--fs-sm);
      line-height: 1.5;
      color: var(--c-text-2);
      max-width: 38rem;
    }

    /* ── Sugerencias ─────────────────────────────────────────────────── */
    .nf-sug { margin-top: var(--sp-8); }
    .nf-sug-h {
      margin: 0 0 var(--sp-2);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: var(--fw-bold);
      color: var(--c-text-3);
    }
    .nf-sug-list { list-style: none; margin: 0; padding: 0; }
    .nf-sug-item {
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
    .nf-sug-item:hover { background: var(--overlay-hover); border-color: var(--c-text-3); }
    .nf-sug-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .nf-sug-ico { color: var(--c-text-3); font-size: var(--fs-body); }
    .nf-sug-txt { display: flex; flex-direction: column; min-width: 0; }
    .nf-sug-label {
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      color: var(--c-text-1);
    }
    .nf-sug-route {
      font-size: var(--fs-micro);
      color: var(--c-text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nf-sug-go { color: var(--c-text-3); font-size: var(--fs-xs); }
    .nf-sug-item:hover .nf-sug-go { color: var(--action); }

    .nf-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2);
      margin-top: var(--sp-8);
    }
  `],
})
export class NotFoundComponent {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** La URL que se pidió. El comodín no la consume: `router.url` la conserva. */
  readonly attempted = computed(() => this.router.url);

  /** Catálogo plano de rutas de la plataforma web, con su proyecto y sus permisos. */
  private readonly targets: Target[] = (AUTHZ_TREE.find((a) => a.id === 'view')?.projects ?? [])
    .flatMap((p) =>
      p.modules
        .filter((m) => !!m.route)
        .map((m) => ({
          label: m.label,
          route: m.route as string,
          project: p.label,
          icon: p.icon,
          perms: [...m.view, ...m.manage],
        })),
    );

  /**
   * Sugerencias por parecido — pero SÓLO las que el usuario puede abrir.
   * Ofrecer una ruta que el guard va a rebotar a /dashboard convierte la ayuda
   * en otro callejón sin salida.
   */
  readonly suggestions = computed<Target[]>(() => {
    // El filtro de permisos va ANTES del ranking: si no, una ruta muy parecida
    // pero vedada ocuparía uno de los tres lugares y desplazaría a una útil.
    return rankRoutes(this.attempted(), this.targets.filter((t) => this.canOpen(t)));
  });

  private canOpen(t: Target): boolean {
    if (this.perms.can('manage', 'all')) return true;
    const mine = this.auth.user()?.permissions ?? {};
    return t.perms.some((p) => !!mine[p]);
  }

  back(): void {
    // history.back() cuando hay de dónde volver; si se llegó pegando la URL en
    // la barra, el back saldría del sitio, así que ahí va al índice de proyectos.
    if (history.length > 1) this.location.back();
    else this.router.navigate(['/projects']);
  }
}
