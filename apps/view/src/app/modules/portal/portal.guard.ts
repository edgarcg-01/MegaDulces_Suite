import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * Guard del Portal B2B. Requiere:
 *   - Sesión autenticada (token válido)
 *   - role_name === 'customer_b2b'
 *
 * Si no autenticado → redirect a /portal/login.
 * Si autenticado pero rol distinto → redirect a /dashboard (admin view).
 */
export const customerB2bGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/portal/login');
    return false;
  }

  const role = auth.user()?.role_name;
  if (role !== 'customer_b2b') {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};
