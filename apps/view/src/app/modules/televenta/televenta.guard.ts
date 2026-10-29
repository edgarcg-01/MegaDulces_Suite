import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { Permission } from '../../core/constants/permissions';
import { loginUrlTree } from '../../core/auth/login-redirect';

/**
 * Guard del PROYECTO Telemarketing (la puerta, no cada pantalla). Requiere:
 *   - Sesión autenticada.
 *   - Permiso de **alguna** de sus pantallas: `COMMERCIAL_TELEVENTA_OPERATE` (el operador) o
 *     `COMMERCIAL_SALES_DOCS_VER` (Facturación TM).
 *
 * `[AX.16]` Antes exigía OPERATE para todo `/telemarketing`. Al mudarse Facturación TM acá eso
 * habría dejado fuera a 10 roles que la ven sin operar el canal (medido en prod 2026-10-29:
 * vendedor_ruta 20 usuarios, encargado_tienda 10, credito_cobranza, facturacion, direccion…) —
 * el rebote que `repartoGuard` ya documenta. OPERATE lo exige ahora cada ruta del operador.
 *
 * El customer_b2b usa la app Portal standalone (otro servicio), no esta app.
 * Si no auth → /login.
 */
export const televentaGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    return loginUrlTree(router, state.url, 'required');
  }

  const user = auth.user();
  if (user?.role_name === 'customer_b2b') {
    // El portal B2B vive en su app standalone; aquí no tiene UI.
    //
    // SIN 'returnUrl' a propósito, y es la única diferencia con el caso de
    // arriba: acá la sesión es VÁLIDA, lo que no corresponde es la app. Volver
    // a esta ruta después de entrar lo rebotaría de nuevo — sería un bucle, no
    // una cortesía. (Que el destino sea el login teniendo sesión válida es una
    // rareza anterior a este cambio; se conserva tal cual.)
    return loginUrlTree(router, null, 'required');
  }

  const perms = user?.permissions || {};
  const puertas = [Permission.COMMERCIAL_TELEVENTA_OPERATE, Permission.COMMERCIAL_SALES_DOCS_VER];
  if (!puertas.some((p) => perms[p] === true)) {
    router.navigateByUrl('/projects');
    return false;
  }
  return true;
};
