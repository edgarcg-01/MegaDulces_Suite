import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated) {
    return true; // Permitimos navegar a la ruta privada
  }

  // Bloqueado temporalmente (Sin Token), enviamos a Login
  router.navigate(['/login']);
  return false;
};
