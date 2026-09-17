import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Guard del proyecto Reparto. Requiere sesión + permiso de **alguna** de sus pantallas.
 *
 * ⚠️ Antes exigía `REPARTO_DESPACHAR` para TODO `/reparto`, y eso es un rebote esperando a pasar:
 * en cuanto el proyecto gana una pantalla con otro permiso, quien la tiene entra por la landing y
 * el guard del proyecto lo echa antes de que la ruta hija pueda decidir. Es el defecto que
 * `landing-guards.spec.ts` (SN.4) persigue.
 *
 * Pasó apenas se sumó **Surtido** (Fase SU, ADR-067): `almacenista` —la persona que surte— tiene
 * `REPARTO_DESPACHAR` en **false explícito** (medido 2026-09-17), así que habría quedado fuera de
 * su propia pantalla. Y darle `REPARTO_DESPACHAR` para resolverlo sería peor: le abriría también
 * el despacho a domicilio y los cortes del repartidor, que no son su trabajo.
 *
 * El guard sólo cuida la PUERTA del proyecto; cada ruta hija sigue con su `permissionGuard`.
 */
export const repartoGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/login');
    return false;
  }
  const user = auth.user();
  if (user?.role_name === 'customer_b2b') {
    router.navigateByUrl('/login');
    return false;
  }
  const perms = user?.permissions || {};
  const isAdmin = user?.role_name === 'admin' || user?.role_name === 'superadmin';
  // Cualquiera de las pantallas del proyecto abre la puerta. La ruta hija decide el resto.
  const puertas = [
    Permission.REPARTO_DESPACHAR, // asignar · pedidos WhatsApp · seguimiento · cortes
    Permission.REPARTO_ENTREGAR, // el repartidor (el árbol ya apuntaba acá y rebotaba)
    Permission.COMMERCIAL_PICKING_VER, // Surtido (Fase SU)
  ];
  if (!isAdmin && !puertas.some((p) => perms[p] === true)) {
    router.navigateByUrl('/projects');
    return false;
  }
  return true;
};
