import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';

/**
 * Interceptor GLOBAL que extrae tenant_id del Authorization Bearer JWT y abre
 * un AsyncLocalStorage scope para el resto del request.
 *
 * Decode inline del JWT (no requiere passport-jwt ni JwtAuthGuard separados —
 * minimal wiring para el cutover multi-tenant). Si el cliente manda un Bearer
 * inválido o expirado, NO bloqueamos el request — solo no abrimos scope. La
 * autorización real (rechazar requests sin auth) la hará el JwtAuthGuard
 * cuando se wire (sprint A.0mt.5 cutover).
 *
 * Después de pasar por este interceptor, cualquier service puede inyectar
 * `TenantContextService` y llamar `get()` o `requireTenantId()`.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantContextInterceptor.name);

  constructor(
    private readonly tenantCtx: TenantContextService,
    private readonly jwtService: JwtService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // Distinguir 2 casos a partir del header:
    //   (A) Sin Authorization → endpoint público o legacy. Pasamos sin scope.
    //   (B) Con Authorization Bearer → DEBE ser válido. Si falla la verificación
    //       o no trae tenant_id, devolvemos 401 explícito para que el frontend
    //       sepa hacer logout + redirect a login. Antes pasábamos silencioso y
    //       el endpoint commercial fallaba con 500 confuso (vivido 2026-05-27).
    const auth = request.headers?.authorization;
    if (!auth) {
      return next.handle();
    }

    const payload = this.extractPayload(request);
    if (!payload) {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (!payload.tenant_id) {
      // Token válido pero sin tenant_id → es un JWT legacy (single-tenant).
      // Pasamos sin scope; los endpoints commercial fallarán con su propio
      // mensaje claro, los legacy funcionarán normal.
      request.user = payload;
      return next.handle();
    }

    // Populate request.user para compat con código que lo lee directamente.
    request.user = payload;

    return new Observable((subscriber) => {
      this.tenantCtx.run(
        {
          tenantId: payload.tenant_id as string,
          userId: payload.sub,
          username: payload.username,
          roleName: payload.role_name,
        },
        () => {
          next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });
        },
      );
    });
  }

  private extractPayload(request: any): {
    sub?: string;
    tenant_id?: string;
    username?: string;
    role_name?: string;
  } | null {
    // 1. Si algún guard previo ya pobló request.user, úsalo.
    if (request.user?.tenant_id) return request.user;

    // 2. Decode del Authorization Bearer.
    const auth = request.headers?.authorization;
    if (!auth || typeof auth !== 'string') return null;
    const [scheme, token] = auth.split(' ');
    if (scheme !== 'Bearer' || !token) return null;

    try {
      return this.jwtService.verify(token);
    } catch (e) {
      // Token inválido/expirado — no abrimos scope, no logueamos verbose para
      // evitar ruido de scans/bots.
      return null;
    }
  }
}
