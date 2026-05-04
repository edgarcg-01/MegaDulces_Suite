import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { Permission } from '../constants/permissions';

/**
 * Guard de permisos que verifica si el usuario tiene un permiso específico.
 * Si no tiene el permiso, redirige según su rol:
 * - Colaboradores → /dashboard/captures
 * - Otros roles → /dashboard
 */
export const permissionGuard = (requiredPermission: Permission): CanActivateFn => {
  return (route, state) => {
    const authService = inject(AuthService);
    const router = inject(Router);

    // Verificar autenticación
    if (!authService.isAuthenticated) {
      router.navigate(['/login']);
      return false;
    }

    // Verificar permiso específico
    if (!authService.hasPermission(requiredPermission)) {
      const user = authService.user();
      
      // Redirigir según el rol del usuario
      if (user?.role_name === 'colaborador') {
        router.navigate(['/dashboard/captures']);
      } else {
        router.navigate(['/dashboard']);
      }
      return false;
    }

    return true;
  };
};

/**
 * Guard específico para colaboradores.
 * Si el usuario es colaborador, solo permite acceso a capturas.
 * Para rutas no permitidas, redirige a /dashboard/captures
 */
export const colaboradorGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isAuthenticated) {
    router.navigate(['/login']);
    return false;
  }

  const user = authService.user();
  
  // Si es colaborador, verificar que la ruta sea permitida
  if (user?.role_name === 'colaborador') {
    const allowedRoutes = ['/dashboard/captures'];
    const currentRoute = state.url;
    
    // Permitir rutas hijas de captures
    if (currentRoute.startsWith('/dashboard/captures')) {
      return true;
    }
    
    // Redirigir a capturas si intenta acceder a otra ruta
    router.navigate(['/dashboard/captures']);
    return false;
  }

  return true;
};
