import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest();

    // 1. Validar que el usuario exista
    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    // 2. LA LLAVE MAESTRA: Acceso total para superadmin
    if (user.role_name === 'superoot') {
      return true;
    }

    // 3. Revisar permisos dinámicos (JSONB)
    // FIX: Los contextos deben ir dentro de un array []
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredPermissions && requiredPermissions.length > 0) {
      const hasPermission = requiredPermissions.every(
        (p) => user.permissions && user.permissions[p] === true,
      );

      if (!hasPermission) {
        throw new ForbiddenException(
          'No tienes los permisos dinámicos necesarios.',
        );
      }
      return true; 
    }

    // 4. Revisar roles estáticos (Legacy)
    // FIX: Los contextos deben ir dentro de un array []
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = requiredRoles.includes(user.role_name);
      if (!hasRole) {
        throw new ForbiddenException('No tienes el rol necesario.');
      }
      return true;
    }

    // Si no se requiere ni rol ni permiso específico, permitimos el paso
    return true;
  }
}