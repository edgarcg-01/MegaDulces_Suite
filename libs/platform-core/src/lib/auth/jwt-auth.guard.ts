import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PermissionsCacheService } from '../ability/permissions-cache.service';

/**
 * Guard global que valida `Authorization: Bearer <jwt>` en cada request.
 *
 * Reemplaza la implementación previa donde el TenantContextInterceptor pasaba
 * silencioso si no había token (causaba 500 confuso porque RLS bloqueaba la
 * query downstream). Ahora:
 *   - Sin Bearer válido → 401 explícito antes de tocar service / DB.
 *   - Con `@Public()` decorator → bypass (login, health, etc.).
 *   - Con Bearer válido → puebla `request.user` y deja pasar. El interceptor
 *     downstream abrirá el AsyncLocalStorage scope con tenant_id si aplica.
 *
 * Solo se registra como APP_GUARD si `ENABLE_MULTITENANT=true`. Cuando el
 * toggle está off, la app usa el JwtAuthGuard legacy del módulo `auth`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly permsCache: PermissionsCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ 1. Endpoints marcados @Public() pasan sin auth                      │
    // └─────────────────────────────────────────────────────────────────────┘
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ 2. WebSocket handshakes: no aplicamos guard HTTP (cada gateway      │
    // │    maneja su propio JWT en el handshake).                            │
    // └─────────────────────────────────────────────────────────────────────┘
    const type = context.getType();
    if (type !== 'http') return true;

    const request = context.switchToHttp().getRequest();

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ 3. Extraer Bearer del header                                         │
    // └─────────────────────────────────────────────────────────────────────┘
    const auth = request.headers?.authorization;
    if (!auth || typeof auth !== 'string') {
      throw new UnauthorizedException('Falta header Authorization: Bearer <token>');
    }
    const [scheme, token] = auth.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Header Authorization debe ser "Bearer <token>"');
    }

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ 4. Verificar firma + expiración                                      │
    // └─────────────────────────────────────────────────────────────────────┘
    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch (e: any) {
      const reason = e?.name === 'TokenExpiredError' ? 'expirado' : 'inválido';
      throw new UnauthorizedException(`Token ${reason}`);
    }

    // Populate request.user para que controllers/services lo lean directo.
    request.user = payload;

    // `[AUTHZ-HARD.2]` Desactivar = revocar. El token vive 12h y no es revocable; sin este chequeo
    // un usuario despedido/degradado (o su token robado) seguía entrando hasta que expiraba —
    // god-mode incluido, porque el rol se lee del token. Releemos `identity.users` (cacheado 30s):
    // si la cuenta está inactiva o borrada, 401.
    //
    // `[ID.38]` La misma lectura trae el CORTE DE SESIÓN de la cuenta, así que no cuesta una
    // consulta más. Ante error de DB se contesta con el último estado conocido (`medido: false`),
    // no con un "asumo que sí" ciego — ver `getEstadoCuenta`.
    const estado = await this.permsCache.getEstadoCuenta(payload?.sub, payload?.tenant_id);
    if (!estado.activo) {
      throw new UnauthorizedException('La cuenta está desactivada. Iniciá sesión de nuevo.');
    }

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ `[ID.38]` 5. ¿El token es ANTERIOR al corte de sesión de la cuenta?  │
    // └─────────────────────────────────────────────────────────────────────┘
    // El candado que `users_token_ttl_days` dejó anotado y nadie había puesto: hasta hoy,
    // cambiarle la contraseña a alguien **no cerraba su sesión** (se escribía
    // `password_changed_at` y no la leía nadie), y un token filtrado sólo se mataba apagando la
    // cuenta entera — inaceptable en las 18 cuentas de dispositivo, donde eso es apagar la
    // pantalla.
    //
    // `iat` viene en segundos y el corte ya llega truncado a segundos: se comparan en la misma
    // unidad para no rechazar un token emitido en la misma fracción de segundo que el corte.
    // Estrictamente MENOR: un token firmado justo en el segundo del corte sigue valiendo, que es
    // el lado correcto del empate (el otro echaría a quien acaba de entrar con la nueva
    // contraseña).
    const iat = typeof payload?.iat === 'number' ? payload.iat : null;
    if (estado.corteSesionSeg !== null && iat !== null && iat < estado.corteSesionSeg) {
      throw new UnauthorizedException(
        'Tu sesión se cerró (cambio de contraseña o revocación). Iniciá sesión de nuevo.',
      );
    }

    return true;
  }
}
