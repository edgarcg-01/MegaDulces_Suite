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
import { isPlatformAdminRole } from '../ability/platform-admin';

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
    //
    // `[ID.13]` Los permisos son la UNIÓN de los roles del usuario (perfil base
    // + complementos de `identity.user_roles`), no los de una sola columna. Si
    // el usuario no tiene filas ahí, cae al comportamiento anterior con
    // `role_name` — nunca a cero permisos.
    const permissions = await this.permsCache.getPermissionsForUser(
      user.sub ?? user.id,
      user.tenant_id,
      user.role_name,
    );
    // Adjuntamos al request para que controllers/services downstream consulten
    // `req.user.permissions` fresco (anti-escalation, /me).
    //
    // Ya NO se construye una ability de CASL acá. No aportaba: la decisión de abajo es un lookup
    // por clave exacta sobre este mismo mapa, y el god-mode se resuelve por rol. Lo único que
    // hacía era serializar `rules` al request — una copia paralela del permiso, incompleta por
    // construcción (51 de 164 claves del enum no tienen subject en `ability.factory`) y que ya
    // causó los dos errores opuestos: dejar pasar de más (el colapso a subject que documenta el
    // comentario de abajo) y de menos (`can('manage','catalogs')` con reglas
    // `['read','create','update','delete']` da false → 403 a todo rol no-admin).
    request.user.permissions = permissions;

    // God-mode de plataforma (admin/superadmin) pasa todo. Ya no depende de un
    // permiso de negocio (ver ability.factory: isPlatformAdminRole).
    if (isPlatformAdminRole(user.role_name)) {
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
