import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    // Check against JWT payload keys (often .rol or .role based on previous configs)
    if (!user || (!requiredRoles.includes(user.rol) && !requiredRoles.includes(user.role_name))) {
        throw new ForbiddenException('No tienes permisos suficientes para realizar esta acción.');
    }

    return true;
  }
}
