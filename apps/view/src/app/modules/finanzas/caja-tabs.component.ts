import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PageTabsComponent } from '../../shared/components/page-tabs/page-tabs.component';
import { pestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { CAJA_TABS } from './caja-tabs';

/**
 * `[CG.121]` — **La barra de pestañas del área Caja** (Captura · Expediente · Caja Fuerte).
 *
 * ── ⛔ Por qué se EMBEBE en cada pantalla y no hay shell de ruta ────────────────────────────
 *
 * El patrón bonito es el de Gastos y Almacén: un padre con `path: ''` que pinta la barra una
 * sola vez y deja un `<router-outlet>`. **No se puede usar acá, y no es cuestión de gusto:**
 * un padre con path vacío matchea cualquier URL restante, así que sólo puede haber UNO por
 * bloque de rutas y tiene que ir al final — en `/finanzas` ese lugar ya lo ocupa Gastos
 * (`app.routes.ts`, «Va AL FINAL»). Pagos chocó contra lo mismo en `[TP.20.3]` y resolvió
 * igual. Un segundo padre vacío no da error de compilación: se come rutas en silencio.
 *
 * ⚠️ El costo de embeberla, dicho: **una pantalla nueva del área puede nacer sin barra y nadie
 * se entera** — queda encerrada, se entra pero no se sale a sus hermanas. Por eso hay un
 * candado en `finanzas-tabs.spec.ts` que comprueba que las tres la monten.
 *
 * Con una sola pestaña visible **no se pinta barra**: un selector de una opción no elige, ocupa
 * lugar y sugiere que hay algo más.
 */
@Component({
  selector: 'app-caja-tabs',
  standalone: true,
  imports: [PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visibles().length > 1) {
      <div class="cj-area-tabs">
        <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de caja" />
      </div>
    }
  `,
  styles: [`
    /* Sin display:block el host queda inline y arruina el ancho de la pagina. */
    :host { display:block; width:100%; }
    /* Alineado con el padding horizontal de .surf-page, igual que Almacen, Gastos y Pagos. */
    .cj-area-tabs { padding:var(--sp-3) 1.5rem 0; }
    @container (max-width: 48rem) {
      .cj-area-tabs { padding:var(--sp-2) 1rem 0; }
    }

    /* La captura NO monta la barra afuera de su surf-page: su host es position:absolute e
       inset:0, y colgarle un hermano arriba le rompe la cadena de altura que [CG.113b] acaba de
       enderezar. Ahi la barra entra COMO HIJA de .cg-app -- que ya es la columna flex que
       reparte el alto -- y el padding horizontal lo pone el surf-page de afuera, asi que aca
       sobra y se quita. Es un modificador declarado por el componente, no un ::ng-deep del
       consumidor: la pantalla pide la variante, no se mete a editar esta hoja. */
    :host(.cj-sin-margen) .cj-area-tabs { padding-left:0; padding-right:0; }
  `],
})
export class CajaTabsComponent {
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly tabs = [...CAJA_TABS];

  /** Las pestañas que esta persona ve: la MISMA regla con que `app-page-tabs` las pinta. */
  readonly visibles = computed(() => {
    if (this.perms.isAdmin()) return this.tabs;
    const tiene = (p: Permission) => this.auth.user()?.permissions?.[p] === true;
    return this.tabs.filter((t) => pestanaVisible(t, tiene));
  });
}
