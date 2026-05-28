import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * Guard del Modo Vendedor. Requiere:
 *   - Sesión autenticada
 *   - Role compatible con toma de pedido: colaborador, supervisor, admin, superadmin.
 *
 * Si customer_b2b → redirect a /portal (su flujo natural).
 * Si no auth → /login.
 */
export const vendorGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/login');
    return false;
  }

  const role = auth.user()?.role_name;
  if (role === 'customer_b2b') {
    router.navigateByUrl('/portal/catalog');
    return false;
  }
  // Resto de roles internos pueden tomar pedidos.
  return true;
};
