import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FinanzasCapturarGastoComponent } from './finanzas-capturar-gasto.component';

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
 * Este componente ya no decide nada — queda como el punto de entrada de la ruta. Si algún
 * día no tiene que hacer nada más, se puede cargar el de captura directo desde la ruta.
 */
@Component({
  selector: 'app-finanzas-gastos',
  standalone: true,
  imports: [FinanzasCapturarGastoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-finanzas-capturar-gasto />`,
})
export class FinanzasGastosComponent {}
