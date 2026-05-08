import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { createMongoAbility } from '@casl/ability';
import type { AppAbility, AppSubject } from '../ability/ability.types';
import { Permission } from '../constants/permissions';

const subjectMap: Record<string, AppSubject> = {
  [Permission.USUARIOS_VER]: 'users',
  [Permission.USUARIOS_GESTIONAR]: 'users',
  [Permission.USUARIOS_PASSWORDS]: 'users_passwords',
  [Permission.USUARIOS_ASIGNAR_RUTA]: 'users_assign_route',
  [Permission.REPORTES_VER_PROPIO]: 'reports_own',
  [Permission.REPORTES_VER_EQUIPO]: 'reports_team',
  [Permission.REPORTES_VER_GLOBAL]: 'reports_global',
  [Permission.REPORTES_EXPORTAR]: 'reports_export',
  [Permission.REPORTES_GESTIONAR]: 'reports_manage',
  [Permission.VISITAS_REGISTRAR]: 'visits',
  [Permission.VISITAS_VER]: 'visits',
  [Permission.VISITAS_AUDITAR]: 'visits_audit',
  [Permission.CATALOGO_GESTIONAR]: 'catalogs',
  [Permission.PLANOGRAMAS_GESTIONAR]: 'planograms',
  [Permission.ROLES_CONFIGURAR]: 'roles_config',
  [Permission.SCORING_CONFIG_VER]: 'scoring_config',
  [Permission.SCORING_CONFIG_GESTIONAR]: 'scoring_config',
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    const ability = createMongoAbility<AppAbility>(user.rules || []);

    if (ability.can('manage', 'all')) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredPermissions && requiredPermissions.length > 0) {
      const allGranted = requiredPermissions.every((perm) => {
        const subject = subjectMap[perm];
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
