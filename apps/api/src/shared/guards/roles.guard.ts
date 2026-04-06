import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Prioridad: Revisar si el endpoint requiere PERMISOS específicos (RBAC v2)
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 2. Compatibilidad: Revisar si requiere ROLES específicos (RBAC v1)
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
        throw new ForbiddenException('Usuario no autenticado.');
    }

    // SI HAY PERMISOS REQUERIDOS: Validar contra el objeto permissions del JWT
    if (requiredPermissions && requiredPermissions.length > 0) {
        const hasPermission = requiredPermissions.every(p => user.permissions && user.permissions[p] === true);
        if (!hasPermission) {
            throw new ForbiddenException('No tienes los permisos dinámicos necesarios (JSONB) para esta acción.');
        }
        return true; 
    }

    // SI NO HAY PERMISOS PERO HAY ROLES: Validar contra rol o role_name (Legacy)
    if (requiredRoles && requiredRoles.length > 0) {
        const hasRole = requiredRoles.includes(user.rol) || requiredRoles.includes(user.role_name);
        if (!hasRole) {
            throw new ForbiddenException('No tienes el rol estático necesario para esta acción.');
        }
        return true;
    }

    // Si no se requiere nada, permitir paso
    return true;
  }
}
