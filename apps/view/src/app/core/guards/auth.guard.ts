import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { loginUrlTree } from '../auth/login-redirect';

export const authGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated) {
    return true; // Permitimos navegar a la ruta privada
  }

  // Bloqueado (sin token) → login, LLEVÁNDOSE a dónde iba. Antes era un
  // 'navigate(["/login"])' pelado y el parámetro 'state' estaba ahí sin usarse:
  // el login sin 'returnUrl' cae a '/projects', así que abrir una ventana nueva
  // sobre una ruta profunda te perdía el destino. Ver 'login-redirect'.
  return loginUrlTree(router, state.url, 'required');
};
