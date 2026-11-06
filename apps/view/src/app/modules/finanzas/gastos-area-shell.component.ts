import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageTabsComponent } from '../../shared/components/page-tabs/page-tabs.component';
import { pestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { GASTOS_TABS } from './gastos-tabs';
import { BuscadorGastosEstado } from './components/buscador-gastos.estado';

/**
 * `[GX.80]` — **Shell del área Gastos.** Pinta la barra de pestañas UNA vez para las cuatro
 * pantallas (Aprobación · Mis gastos · Expediente · Historial), en vez de repetirla en cada una.
 *
 * Es el mismo patrón que `AlmacenAreaShellComponent`: un padre con `path: ''`, así que las URLs
 * de las pantallas NO cambian y los enlaces guardados siguen valiendo.
 *
 * Con una sola pestaña visible no hay barra: quien sólo captura ve «Mis gastos» sin nada
 * encima. Un selector de una opción no elige — ocupa lugar y sugiere que hay algo más.
 *
 * `[GX.101]` El buscador de gastos ya NO se pinta aquí arriba (pedido del usuario, 2026-11-06: «a
 * uno más visible»): su caja va junto al título de cada una de las cuatro pantallas y sus
 * resultados debajo de ese encabezado. El shell sigue dando el ESTADO, para que lo escrito se
 * conserve al cambiar de pestaña.
 */
@Component({
  selector: 'app-gastos-area-shell',
  standalone: true,
  imports: [RouterOutlet, PageTabsComponent],
  // `[GX.88]` El estado del buscador vive AQUÍ: el shell no se destruye al cambiar de pestaña,
  // así que lo escrito y los resultados se conservan. Las pantallas lo inyectan.
  providers: [BuscadorGastosEstado],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visibles().length > 1) {
      <div class="gx-area-tabs">
        <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de gastos" />
      </div>
    }
    <router-outlet />
  `,
  styles: [
    `
      /* El host es un elemento extra entre el <main> del layout y la página: sin display:block
         quedaría inline y arruinaría el ancho. */
      :host {
        display: block;
        width: 100%;
      }
      /* Alineado con el padding horizontal de .surf-page (0 1.5rem), igual que Almacén. */
      .gx-area-tabs {
        padding: var(--sp-3) 1.5rem 0;
      }
      @media (max-width: 48rem) {
        .gx-area-tabs {
          padding: var(--sp-2) 1rem 0;
        }
      }
    `,
  ],
})
export class GastosAreaShellComponent {
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly tabs = [...GASTOS_TABS];

  /** Las pestañas que esta persona ve: la MISMA regla que usa `app-page-tabs` para pintarlas. */
  readonly visibles = computed(() => {
    if (this.perms.isAdmin()) return this.tabs;
    const tiene = (p: Permission) => this.auth.user()?.permissions?.[p] === true;
    return this.tabs.filter((t) => pestanaVisible(t, tiene));
  });
}
