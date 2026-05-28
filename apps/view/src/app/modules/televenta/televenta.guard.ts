import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Guard del módulo Televenta. Requiere:
 *   - Sesión autenticada.
 *   - Permiso `COMMERCIAL_TELEVENTA_OPERATE` (rol `tele_operator` o roles
 *     más altos: superadmin, admin, supervisor).
 *
 * Si customer_b2b → redirect a /portal.
 * Si no auth → /login.
 */
export const televentaGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/login');
    return false;
  }

  const user = auth.user();
  if (user?.role_name === 'customer_b2b') {
    router.navigateByUrl('/portal/catalog');
    return false;
  }

  const perms = user?.permissions || {};
  if (perms[Permission.COMMERCIAL_TELEVENTA_OPERATE] !== true) {
    router.navigateByUrl('/projects');
    return false;
  }
  return true;
};
