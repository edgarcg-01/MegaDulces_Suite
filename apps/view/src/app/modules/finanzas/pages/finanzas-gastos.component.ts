import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasSolicitudesComponent } from './finanzas-solicitudes.component';
import { FinanzasCapturarGastoComponent } from './finanzas-capturar-gasto.component';

/**
 * GX.10 — **Gastos**: la única puerta al ciclo del gasto. Reemplaza tres tabs que
 * resolvían el mismo trámite en tres lugares distintos («Solicitudes de gasto»,
 * «Capturas de campo» y «Capturar gasto»).
 *
 * Por qué una ruta y no una pantalla: son **dos públicos**, y está medido.
 *   · 11 roles / **75 usuarios activos** (32 cajeros, 19 promotores de ruta, 9 encargados
 *     de tienda…) tienen `FINANCE_EXPENSES_CAPTURAR` pero **no** `FINANCE_EXPENSES_VER`.
 *     Para ellos el tablero de toda la empresa no es útil —y no deberían verlo—: su
 *     trabajo es pegar un folio y subir fotos.
 *   · Otros 5 roles (`finanzas`, `direccion`, `auditor_externo`, `credito_cobranza`,
 *     `auxiliar finanzas`) ven sin capturar.
 *   · Sólo 7 roles tienen los dos, y eran los únicos que sufrían la duplicación.
 *
 * Fundirlos en una pantalla que exigiera VER habría dejado afuera a los 75 que capturan.
 * Así que la ruta es una sola y el contenido se decide acá. Para quien tiene VER, la
 * página de captura además **no aportaba nada**: el tablero ya trae la captura como
 * diálogo, con los datos de Kepler cargados.
 *
 * El guard de la ruta es `anyPermissionGuard(VER, CAPTURAR)`; este componente sólo elige
 * cuál de las dos superficies renderizar. No hay tercera rama: si el guard te dejó pasar,
 * tenés al menos uno de los dos.
 */
@Component({
  selector: 'app-finanzas-gastos',
  standalone: true,
  imports: [FinanzasSolicitudesComponent, FinanzasCapturarGastoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (verTablero()) {
      <app-finanzas-solicitudes />
    } @else {
      <app-finanzas-capturar-gasto />
    }
  `,
})
export class FinanzasGastosComponent {
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /**
   * Quien puede ver el tablero, lo ve — la captura vive adentro como diálogo. Quien sólo
   * captura recibe la superficie mínima. `isAdmin()` primero por el mismo motivo que en
   * `PageTabs`: un superadmin cuyo JSONB no tenga la clave literal igual debe entrar.
   */
  readonly verTablero = computed(() => this.perms.isAdmin()
    || this.auth.user()?.permissions?.[Permission.FINANCE_EXPENSES_VER] === true);
}
