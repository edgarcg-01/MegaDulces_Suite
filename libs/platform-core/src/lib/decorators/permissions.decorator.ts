import { SetMetadata } from '@nestjs/common';
import { Permission } from '../constants/permissions';

export const PERMISSIONS_KEY = 'permissions';
/** AND: el rol debe tener TODOS los permisos listados. */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const ANY_PERMISSIONS_KEY = 'any_permissions';
/**
 * OR: el rol debe tener AL MENOS UNO de los permisos listados. Para endpoints
 * utilitarios que consumen varios módulos (p.ej. lookup de ticket lo usan Tienda
 * y Reparto). Cada módulo aporta su propio permiso sin acoplar al del otro.
 * Combina con @RequirePermissions: si ambos están, deben cumplirse los dos grupos.
 */
export const RequireAnyPermission = (...permissions: Permission[]) => SetMetadata(ANY_PERMISSIONS_KEY, permissions);
