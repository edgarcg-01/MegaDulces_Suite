import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';

/**
 * Interceptor GLOBAL que extrae tenant_id del Authorization Bearer JWT y abre
 * un AsyncLocalStorage scope para el resto del request.
 *
 * Decode inline del JWT (no requiere passport-jwt). Si el cliente manda un Bearer
 * inválido o expirado, devolvemos 401. Sin Bearer pasa sin scope.
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
    const auth = request.headers?.authorization;

    if (!auth) return next.handle();

    const payload = this.extractPayload(request);
    if (!payload) throw new UnauthorizedException('Token inválido o expirado');

    if (!payload.tenant_id) {
      request.user = payload;
      return next.handle();
    }

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
    if (request.user?.tenant_id) return request.user;

    const auth = request.headers?.authorization;
    if (!auth || typeof auth !== 'string') return null;
    const [scheme, token] = auth.split(' ');
    if (scheme !== 'Bearer' || !token) return null;

    try {
      return this.jwtService.verify(token);
    } catch (e) {
      return null;
    }
  }
}
