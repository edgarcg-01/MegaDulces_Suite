import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { PermissionsCacheService } from '../ability/permissions-cache.service';
import { buildAbility } from '../ability/ability.factory';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private reflector: Reflector,
    private permsCache: PermissionsCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── Metadata primero (seguro como guard GLOBAL) ─────────────────────
    // Si la ruta no declara @RequirePermissions no hay nada que autorizar acá
    // (rutas @Public como login, o rutas solo-auth): devolvemos true SIN tocar
    // `user`. La autenticación ya la garantizó JwtAuthGuard.
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    // OR-group: @RequireAnyPermission(...) — basta con tener UNO. Se resuelve
    // por handler/clase igual que el AND-group; los dos grupos coexisten.
    const anyPermissions = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasAnd = !!requiredPermissions && requiredPermissions.length > 0;
    const hasAny = !!anyPermissions && anyPermissions.length > 0;
    if (!hasAnd && !hasAny) {
      return true;
    }

    // WS/otros transportes: este guard es HTTP. Los gateways validan su JWT.
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    // ── PERMISOS FRESCOS por request ────────────────────────────────────
    // Fuente de verdad = `role_permissions` en DB (no el snapshot del JWT),
    // cacheada en memoria con TTL 30s + invalidación en update. Así un cambio
    // en /admin/roles aplica al instante sin re-login.
    const permissions = await this.permsCache.getPermissionsForRole(
      user.role_name,
      user.tenant_id,
    );
    const ability = buildAbility(permissions, { roleName: user.role_name });

    // Adjuntamos al request para que controllers/services downstream consulten
    // `req.user.permissions` fresco (anti-escalation, /me).
    request.user.permissions = permissions;
    request.user.rules = ability.rules;

    // God-mode de plataforma (admin/superadmin) pasa todo. Ya no depende de un
    // permiso de negocio (ver ability.factory: isPlatformAdminRole).
    if (ability.can('manage', 'all')) {
      return true;
    }

    // Chequeo por CLAVE EXACTA (no colapso a subject). Antes el guard resolvía
    // Permission → subject y aceptaba `can('read', subject)`, así que cualquier
    // clave del módulo (p.ej. ORDERS_VER) abría TODAS las rutas del módulo
    // (ORDERS_FULFILL/CANCELAR/…). Ahora @RequirePermissions(X) exige que el rol
    // tenga literalmente `X: true`.
    const andOk = !hasAnd || requiredPermissions!.every((perm) => permissions[perm] === true);
    // OR-group: al menos uno presente.
    const anyOk = !hasAny || anyPermissions!.some((perm) => permissions[perm] === true);

    if (!andOk || !anyOk) {
      const missingAnd = hasAnd ? requiredPermissions!.filter((p) => permissions[p] !== true) : [];
      const missingAny = !anyOk ? `uno de [${anyPermissions!.join(', ')}]` : '';
      this.logger.warn(
        `Bloqueo 403. Usuario: ${user.username} (rol ${user.role_name}). Faltan permisos: ${[missingAnd.join(', '), missingAny].filter(Boolean).join(' + ')}`,
      );
      throw new ForbiddenException(
        'No tienes los permisos dinámicos necesarios.',
      );
    }
    return true;
  }
}
