import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * Guard del Portal B2B. Permite entrar a:
 *   - customer_b2b (uso normal)
 *   - superadmin (vista admin/QA desde /projects)
 */
export const customerB2bGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/portal/login');
    return false;
  }

  const role = auth.user()?.role_name;
  if (role !== 'customer_b2b' && role !== 'superadmin') {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};
