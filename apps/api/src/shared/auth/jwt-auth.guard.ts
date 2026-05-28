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
  ) {}

  canActivate(context: ExecutionContext): boolean {
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
    return true;
  }
}
