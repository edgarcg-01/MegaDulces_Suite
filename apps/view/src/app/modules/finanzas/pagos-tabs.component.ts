import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PageTabsComponent } from '../../shared/components/page-tabs/page-tabs.component';
import { pestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { PAGOS_TABS } from './pagos-tabs';

/**
 * `[TP.20.3]` — **La barra de pestañas del área Pagos** (objetivo O5).
 *
 * Es el mismo organismo que usan Almacén y Gastos (`app-page-tabs`), con la diferencia de dónde
 * se monta: aquéllas tienen un shell de ruta y ésta se embebe en cada una de sus cuatro pantallas.
 * El porqué está en `pagos-tabs.ts` — en corto: `/finanzas` sólo admite un padre con `path: ''`
 * al final y ya lo ocupa Gastos, y el router no se puede comprobar sin levantar la app.
 *
 * Con una sola pestaña visible **no se pinta barra**: un selector de una opción no elige, ocupa
 * lugar y sugiere que hay algo más. (Hoy las cuatro comparten `FINANCE_PAYMENTS_VER`, así que o
 * se ven las cuatro o ninguna — pero la regla se respeta igual, porque ese permiso puede partirse
 * mañana y nadie volvería a mirar este archivo.)
 */
@Component({
  selector: 'app-pagos-tabs',
  standalone: true,
  imports: [PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visibles().length > 1) {
      <div class="pg-area-tabs">
        <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de pagos" />
      </div>
    }
  `,
  styles: [`
    /* Sin display:block el host queda inline y arruina el ancho de la página. */
    :host { display: block; width: 100%; }
    /* Alineado con el padding horizontal de .surf-page, igual que Almacén y Gastos. */
    .pg-area-tabs { padding: var(--sp-3) 1.5rem 0; }
    @container (max-width: 48rem) {
      .pg-area-tabs { padding: var(--sp-2) 1rem 0; }
    }
  `],
})
export class PagosTabsComponent {
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly tabs = [...PAGOS_TABS];

  /** Las pestañas que esta persona ve: la MISMA regla con que `app-page-tabs` las pinta. */
  readonly visibles = computed(() => {
    if (this.perms.isAdmin()) return this.tabs;
    const tiene = (p: Permission) => this.auth.user()?.permissions?.[p] === true;
    return this.tabs.filter((t) => pestanaVisible(t, tiene));
  });
}
