import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, type Observable } from 'rxjs';
import { FinanzasCapturarGastoComponent } from './finanzas-capturar-gasto.component';
import { FinanzasPedirGastoComponent } from './finanzas-pedir-gasto.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { AuthService } from '../../../core/services/auth.service';
import { SolicitudGastoService } from '../solicitud-gasto.service';

/**
 * `[GX.17]` — **Gastos**: la pantalla de quien CAPTURA. Pega el folio de Kepler, declara
 * cómo se pagó y sube la foto del comprobante.
 *
 * Antes (`[GX.10]`) esta ruta elegía entre DOS superficies según el permiso: tablero para
 * quien tenía `FINANCE_EXPENSES_VER`, captura para quien sólo tenía `_CAPTURAR`. Esa
 * bifurcación se retiró al partir la sección en dos por pedido del usuario:
 *
 *   · `/finanzas/gastos`            → esto: capturar. **Sin permiso, todos entran.**
 *   · `/finanzas/aprobacion-gastos` → dar luz verde. Gateada con `_COMPROBAR`.
 *   · `/finanzas/gastos-tablero`    → el tablero de GX.10, con su `_VER` de siempre.
 *
 * ⛔ El tablero **no se borró**: 25 personas con `FINANCE_EXPENSES_VER` lo usan para
 * revisar y buscar. Cambió de dirección, no de existencia.
 *
 * `[PGP.122]` **Dos maneras de dar de alta un gasto, mientras conviven Kepler y la Suite:**
 *   · «Registrar o pedir»: la solicitud nace aquí, prellenada, y al firmarse se escribe en Kepler;
 *   · «Tengo un folio de Kepler»: la captura de siempre, para lo que se capturó a mano en Kepler.
 * El selector SÓLO aparece donde hay algo que abrir: la sucursal de la persona abierta (la escritura en Kepler
 * encendida de punta a punta) o, para oficinas, alguna sucursal abierta. En cualquier otro caso se ve la captura
 * de siempre, sin pestañas: el día del despliegue, con todo apagado, nadie ve nada nuevo. Un enlace que ya trae
 * folio (`?folio=`) entra directo a la captura de siempre. Cambiar de pestaña no tira lo capturado (las dos se
 * conservan una vez abiertas).
 */
@Component({
  selector: 'app-finanzas-gastos',
  standalone: true,
  imports: [FinanzasCapturarGastoComponent, FinanzasPedirGastoComponent, SegmentedComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-load-state [loading]="hayPuerta() === null" [skeletonRows]="3">
      @if (hayPuerta()) {
        <div class="gd-modo">
          <app-segmented [options]="modos" [value]="modo()" (valueChange)="elegir($event)" ariaLabel="Cómo se da de alta el gasto" />
        </div>
        @if (vistos().has('pedir')) { <div [hidden]="modo() !== 'pedir'"><app-finanzas-pedir-gasto /></div> }
        @if (vistos().has('folio')) { <div [hidden]="modo() !== 'folio'"><app-finanzas-capturar-gasto /></div> }
      } @else {
        <app-finanzas-capturar-gasto />
      }
    </app-load-state>
  `,
  styles: [`
    :host { display: block; }
    .gd-modo { margin-bottom: var(--sp-4); max-width: 32rem; }
  `],
})
export class FinanzasGastosComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly solicitudes = inject(SolicitudGastoService);

  readonly modos: SegOption[] = [
    { label: 'Registrar o pedir', value: 'pedir' },
    { label: 'Tengo un folio de Kepler', value: 'folio' },
  ];

  /** El enlace trae folio: la captura de siempre. */
  private readonly conFolio = !!this.route.snapshot.queryParamMap.get('folio');
  /**
   * Las sucursales abiertas. Es sólo un INDICADOR para decidir si hay pestaña: esta puerta no muestra ningún dato que
   * envejezca (§9 no aplica aquí; «Registrar o pedir» muestra su propio estado de carga). `null` = todavía no contesta;
   * si falla, todo sigue como hoy (la captura de siempre).
   */
  private readonly abiertas = toSignal(
    (this.conFolio
      ? of([] as string[])
      : this.solicitudes.abiertas().pipe(map((r) => r.sucursales ?? []), catchError(() => of([] as string[])))) as Observable<string[] | null>,
    { initialValue: null },
  );
  /** ¿Hay algo que abrir para esta persona? `null` mientras se pregunta. */
  readonly hayPuerta = computed(() => {
    const a = this.abiertas();
    if (a === null) return null;
    const suc = String(this.auth.user()?.warehouse_code ?? '').trim();
    return /^\d{2}$/.test(suc) ? a.includes(suc) : a.length > 0;
  });
  /** Lo que la persona eligió a mano manda sobre el defecto. */
  private readonly aMano = signal(null as 'pedir' | 'folio' | null);
  readonly modo = computed(() => this.aMano() ?? (this.hayPuerta() ? 'pedir' : 'folio'));
  /** Las pestañas ya abiertas se conservan (ocultas), para no tirar lo capturado al cambiar. */
  readonly vistos = signal(new Set() as Set<string>);

  constructor() {
    effect(() => {
      const m = this.modo();
      if (this.hayPuerta() && !this.vistos().has(m)) this.vistos.update((v) => new Set([...v, m]));
    });
  }

  elegir(v: string): void {
    this.aMano.set(v === 'pedir' ? 'pedir' : 'folio');
  }
}
