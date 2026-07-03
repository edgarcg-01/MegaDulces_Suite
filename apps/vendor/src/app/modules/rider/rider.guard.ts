import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * ¿El usuario es REPARTIDOR (entrega a domicilio) y no vendedor de ruta?
 * Señal por capacidad: reparte guías y NO toma pedidos, o role_name='repartidor'.
 * Vendedor y repartidor son dominios SEPARADOS: cada uno tiene su propia rama
 * de rutas y su propio shell (/vendor vs /rider).
 */
export function isRiderUser(user: { role_name?: string; permissions?: Record<string, boolean> } | null | undefined): boolean {
  if (!user) return false;
  if (user.role_name === 'repartidor') return true;
  const p = user.permissions || {};
  return p['LOGISTICS_GUIDES_GESTIONAR'] === true && p['COMMERCIAL_ORDERS_CREAR'] !== true;
}

/** Guard de la app del repartidor. Solo repartidores; los demás → /vendor. */
export const riderGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    router.navigateByUrl('/login');
    return false;
  }
  if (!isRiderUser(auth.user())) {
    router.navigateByUrl('/vendor');
    return false;
  }
  return true;
};
