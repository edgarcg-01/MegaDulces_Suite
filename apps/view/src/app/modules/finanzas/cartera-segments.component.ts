import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { SegmentedComponent } from '../../shared/components/segmented/segmented.component';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Selector de vista de **Cartera** — las dos mitades del mismo oficio bajo un solo control.
 *
 *   · **Cartera**  (`/finanzas/cartera`)  — lo que te DEBEN: saldo por cliente, aging,
 *     y las aplicaciones de cada factura (cobros, notas de crédito, devoluciones).
 *   · **Cobranza** (`/finanzas/cobranza`) — lo que te PAGARON: la ficha de depósito
 *     adjunta a cada cobro de Kepler, con su cuadre por OCR.
 *
 * ⛔ CADA SEGMENTO SE GATEA CON SU PROPIO PERMISO, y no es celo de más: las dos rutas
 * nacieron con permisos DISTINTOS (`FINANCE_RECEIVABLES_VER` y `FINANCE_COLLECTIONS_VER`)
 * y siguen así. Un contenedor con un guard único le habría enseñado a alguien la pestaña
 * de la mitad que no puede ver — o peor, la habría dejado entrar. Van juntos en el preset
 * `finanzas`, sí, pero el preset NO es el estado vivo: los mapas se editan desde
 * /admin/roles y ahí las claves se reparten de a una.
 *
 * Por eso esto NO es un shell con guard propio: las dos rutas conservan el suyo intacto,
 * este control sólo NAVEGA entre ellas. Los enlaces profundos siguen valiendo igual.
 *
 * ⚠️ Con una sola vista visible no se renderiza nada. Un selector de una opción no elige:
 * ocupa lugar y sugiere que hay algo más del otro lado.
 */
@Component({
  selector: 'app-cartera-segments',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SegmentedComponent],
  template: `
    @if (opciones().length > 1) {
      <div class="cs-wrap">
        <app-segmented
          [options]="opciones()"
          [value]="actual()"
          ariaLabel="Vista de crédito"
          (valueChange)="ir($event)" />
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .cs-wrap { margin: var(--sp-3) 0 var(--sp-2); }
  `],
})
export class CarteraSegmentsComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** Lookup por CLAVE EXACTA (ADR-054): el permiso es una clave, no una tupla acción/sujeto. */
  private tiene(p: Permission): boolean {
    return this.perms.isAdmin() || this.auth.user()?.permissions?.[p] === true;
  }

  readonly opciones = computed(() => {
    const o: { label: string; value: string }[] = [];
    if (this.tiene(Permission.FINANCE_RECEIVABLES_VER)) o.push({ label: 'Crédito', value: '/finanzas/cartera' });
    if (this.tiene(Permission.FINANCE_COLLECTIONS_VER)) o.push({ label: 'Cobranza', value: '/finanzas/cobranza' });
    return o;
  });

  /** La ruta viva, para que el segmento marcado sea el que se está viendo. */
  readonly actual = computed(() => {
    const url = this.router.url.split('?')[0];
    return this.opciones().find((o) => url.startsWith(o.value))?.value ?? '';
  });

  ir(destino: string): void {
    if (destino === this.actual()) return;
    // `queryParamsHandling` NO se preserva a propósito: los filtros de una vista no
    // significan lo mismo en la otra, y arrastrarlos abriría la de al lado con un
    // recorte que nadie pidió.
    this.router.navigateByUrl(destino);
  }
}
