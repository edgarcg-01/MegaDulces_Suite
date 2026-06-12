import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * Guard del Modo Vendedor. Whitelist explícita de roles:
 *   - `vendedor` (target principal)
 *   - `admin` / `superadmin` (testing / soporte)
 *   - `jefe_marketing` / `supervisor` (override gerencial)
 *
 * Bloqueados con redirect explícito:
 *   - `customer_b2b` → /portal/catalog (su flujo natural)
 *   - `tele_operator` → /televenta/queue (NO debería entrar acá, tienen su propio modo)
 *   - cualquier otro role no autorizado → /dashboard
 *
 * Antes este guard solo bloqueaba `customer_b2b` y dejaba pasar a cualquier
 * otro role autenticado — incluido `tele_operator`, que tiene su propio flow
 * y no debe interferir con la cartera de vendedores en campo.
 */
const VENDOR_ALLOWED_ROLES = new Set([
  'vendedor',
  'admin',
  'superadmin',
  'jefe_marketing',
  'supervisor',
]);

export const vendorGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/login');
    return false;
  }

  const role = auth.user()?.role_name;
  if (!role) {
    router.navigateByUrl('/login');
    return false;
  }
  if (role === 'customer_b2b') {
    router.navigateByUrl('/portal/catalog');
    return false;
  }
  if (role === 'tele_operator') {
    router.navigateByUrl('/televenta/queue');
    return false;
  }
  if (!VENDOR_ALLOWED_ROLES.has(role)) {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};
