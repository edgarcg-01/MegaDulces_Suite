import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Guard del Modo Vendedor. El acceso se controla por el permiso
 * `VENDOR_APP_ACCESS`, administrable desde /admin/roles (viaja en el
 * `permissions` map del JWT).
 *
 * `LEGACY_VENDOR_ROLES` es un fallback TRANSITORIO por role_name: mantiene el
 * acceso de los usuarios cuyo JWT todavía no trae el permiso (token emitido
 * antes del backfill / sin re-login). Quitar cuando todos los roles relevantes
 * tengan VENDOR_APP_ACCESS en su role_permissions.
 *
 * Rechazo: cerrar sesión y volver a /login con aviso. NUNCA redirigir a
 * /dashboard, /portal/* ni /televenta/* — esas rutas NO existen en esta app
 * standalone y, combinadas con el catch-all '**', producían un loop infinito
 * de routing (el síntoma "se queda en loop" al entrar).
 */
const LEGACY_VENDOR_ROLES = new Set([
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

  const user = auth.user();
  const hasPermission =
    user?.permissions?.[Permission.VENDOR_APP_ACCESS] === true;
  const legacyAllowed =
    !!user?.role_name && LEGACY_VENDOR_ROLES.has(user.role_name);

  if (hasPermission || legacyAllowed) {
    return true;
  }

  auth.logout();
  router.navigate(['/login'], { queryParams: { denied: 'vendor' } });
  return false;
};
