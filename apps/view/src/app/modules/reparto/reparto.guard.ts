import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Guard del módulo Reparto (entrega a domicilio, personal de tienda).
 * Requiere sesión + permiso REPARTO_DESPACHAR (el que despacha desde la tienda:
 * jefe_de_tienda, auxiliar_de_tienda, encargado_sucursal, admin/superadmin).
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
  if (!isAdmin && perms[Permission.REPARTO_DESPACHAR] !== true) {
    router.navigateByUrl('/projects');
    return false;
  }
  return true;
};
