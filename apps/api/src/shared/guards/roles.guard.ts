import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { PermissionsCacheService } from '../ability/permissions-cache.service';
// Fuente única de verdad para el mapeo Permission → subject. Antes había una
// copia local desactualizada acá que omitía TIENDAS_VER y todos los
// COMMERCIAL_*/LOGISTICS_* nuevos → el guard tiraba 403 aunque el rol tuviera
// la permission en DB. Importamos directo del ability.factory.
import { buildAbility, permissionToSubject } from '../ability/ability.factory';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permsCache: PermissionsCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    // ── PERMISOS FRESCOS por request ────────────────────────────────────
    // Antes leíamos `user.rules` del JWT (snapshot del momento del login),
    // así que cambios en /admin/roles no se reflejaban hasta que el usuario
    // re-logueaba. Ahora la fuente de verdad es siempre `role_permissions`
    // en DB, cacheada en memoria con TTL 30s + invalidación en update.
    const permissions = await this.permsCache.getPermissionsForRole(
      user.role_name,
    );
    const ability = buildAbility(permissions);

    // También adjuntamos al request para que controllers/services downstream
    // puedan consultar `req.user.permissions` con datos frescos (algunos lo
    // usan para anti-escalation y para el response /me).
    request.user.permissions = permissions;
    request.user.rules = ability.rules;

    if (ability.can('manage', 'all')) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredPermissions && requiredPermissions.length > 0) {
      const allGranted = requiredPermissions.every((perm) => {
        const subject = permissionToSubject[perm];
        if (!subject) return false;
        return ability.can('read', subject) || ability.can('manage', subject);
      });

      if (!allGranted) {
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

    return true;
  }
}
