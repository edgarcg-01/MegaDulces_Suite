import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    const userRole = user.role_name;

    if (userRole === 'superadmin') {
      console.log(' Acceso concedido por Llave Maestra (superadmin)');
      return true;
    }

    // 3. Revisar permisos dinámicos (JSONB)
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredPermissions && requiredPermissions.length > 0) {
      // Check if the user has any of the required permissions
      const hasPermission = requiredPermissions.every(
        (p) => user.permissions && user.permissions[p] === true,
      );

      if (!hasPermission) {
        console.error(
          ` Bloqueo 403. Usuario: ${user.username}. Faltan permisos:`,
          requiredPermissions,
        );
        throw new ForbiddenException(
          'No tienes los permisos dinámicos necesarios.',
        );
      }
      return true;
    }

    // 4. Si no hay requisitos de permisos, permitir acceso
    return true;
  }
}
