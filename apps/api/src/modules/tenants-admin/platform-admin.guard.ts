import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { isPlatformAdminRole } from '@megadulces/platform-core';

/** Header con el secreto de operador de plataforma. */
export const PLATFORM_ADMIN_HEADER = 'x-platform-admin-key';

/**
 * `[AUTHZ.5]` — Guard de las operaciones CROSS-TENANT (`/admin/tenants`).
 *
 * Estas rutas estuvieron **sin ninguna protección** desde el Sprint A.0mt.5, con el TODO escrito en
 * el propio controller. Como `RolesGuard` es no-op en rutas sin `@RequirePermissions`, cualquier
 * usuario autenticado —incluidas las cuentas de portal `customer_b2b`— podía crear un tenant,
 * **listar todos** (fuga cross-tenant) y **desactivar** el tenant de Mega Dulces.
 *
 * Por qué NO alcanza el sistema de roles: los roles son **por tenant**. El superadmin de un tenant
 * no tiene por qué poder tocar los otros — darle la llave a `superadmin` convertiría a los 11
 * superadmin de Mega Dulces en operadores de la plataforma. Es la misma conclusión que ya estaba
 * escrita en el TODO original, y por eso el gate es un **secreto de despliegue**, no un permiso.
 *
 * Fail-CLOSED: sin `PLATFORM_ADMIN_KEY` en el entorno, estas rutas **no las abre nadie**. Es lo
 * correcto para operaciones que se usan un puñado de veces en la vida del sistema (dar de alta un
 * tenant) y cuyo costo de estar abiertas es total. Que haya que setear un env para usarlas es la
 * intención, no un efecto colateral.
 *
 * Se exige además sesión de plataforma-admin: el secreto solo no basta, así queda quién lo hizo en
 * el log.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return false;
    const request = context.switchToHttp().getRequest();

    const expected = process.env['PLATFORM_ADMIN_KEY'];
    if (!expected) {
      this.logger.warn(
        'Intento de operación cross-tenant sin PLATFORM_ADMIN_KEY configurada: denegado.',
      );
      throw new ForbiddenException(
        'Las operaciones de plataforma están deshabilitadas: falta configurar PLATFORM_ADMIN_KEY.',
      );
    }

    const provided = request.headers?.[PLATFORM_ADMIN_HEADER];
    // Comparación de longitud primero para no filtrar el largo del secreto por timing.
    if (typeof provided !== 'string' || provided.length !== expected.length || provided !== expected) {
      this.logger.warn(
        `Operación cross-tenant rechazada (${request.method} ${request.url}) — usuario: ${request.user?.username ?? 'sin sesión'}.`,
      );
      throw new ForbiddenException('Operación de plataforma no autorizada.');
    }

    if (!isPlatformAdminRole(request.user?.role_name)) {
      this.logger.warn(
        `Operación cross-tenant con secreto válido pero sesión no-admin: ${request.user?.username ?? 'sin sesión'}.`,
      );
      throw new ForbiddenException(
        'Las operaciones de plataforma exigen además una sesión de administrador.',
      );
    }

    this.logger.log(
      `Operación cross-tenant autorizada: ${request.method} ${request.url} por ${request.user?.username}.`,
    );
    return true;
  }
}
