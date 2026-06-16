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
 * El customer_b2b usa la app Portal standalone (otro servicio), no esta app.
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
    // El portal B2B vive en su app standalone; aquí no tiene UI.
    router.navigateByUrl('/login');
    return false;
  }

  const perms = user?.permissions || {};
  if (perms[Permission.COMMERCIAL_TELEVENTA_OPERATE] !== true) {
    router.navigateByUrl('/projects');
    return false;
  }
  return true;
};
