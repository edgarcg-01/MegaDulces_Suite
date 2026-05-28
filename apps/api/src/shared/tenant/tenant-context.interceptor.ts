import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Knex } from 'knex';
import { firstValueFrom, from, Observable } from 'rxjs';
import { KNEX_CONNECTION_RAW } from '../database/database.module';
import { legacyTxStorage } from './legacy-tx.als';
import { TenantContextService } from './tenant-context.service';

/**
 * Interceptor GLOBAL que extrae tenant_id del Authorization Bearer JWT y:
 *   1. Abre AsyncLocalStorage scope via TenantContextService (multi-tenant CLS).
 *   2. Abre un trx contra KNEX_CONNECTION_RAW, hace `SET LOCAL app.tenant_id`,
 *      guarda el trx en `legacyTxStorage`, y corre el handler en ese scope.
 *      Esto permite que los servicios legacy (que usan KNEX_CONNECTION) hagan
 *      INSERTs en tablas con `tenant_id NOT NULL` — el trigger SQL
 *      `auto_populate_tenant_id` lee `current_tenant_id()` y rellena el campo.
 *
 * Decode inline del JWT (no requiere passport-jwt). Si el cliente manda un Bearer
 * inválido o expirado, devolvemos 401. Sin Bearer pasa sin scope.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantContextInterceptor.name);

  constructor(
    private readonly tenantCtx: TenantContextService,
    private readonly jwtService: JwtService,
    @Inject(KNEX_CONNECTION_RAW) private readonly legacyRawKnex: Knex,
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
    const tenantId = payload.tenant_id as string;

    // Ejecutamos el flow como Promise → from() lo convierte en Observable que
    // Nest sabe consumir (un único valor → response HTTP → complete).
    //
    // El handler corre dentro de:
    //   - tenantCtx.run (CLS multi-tenant accesible a TenantContextService.get())
    //   - legacyTxStorage.run (CLS para que el Proxy de KNEX_CONNECTION enrute al tx)
    //   - knex.transaction (tx con `app.tenant_id` seteado → trigger lee current_tenant_id())
    //
    // El COMMIT ocurre cuando firstValueFrom resuelve sin error. Si tira →
    // ROLLBACK automático.
    const handlerPromise = this.legacyRawKnex.transaction((tx) =>
      tx
        .raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId])
        .then(() =>
          this.tenantCtx.run(
            {
              tenantId,
              userId: payload.sub,
              username: payload.username,
              roleName: payload.role_name,
            },
            () =>
              legacyTxStorage.run({ tx, tenantId }, () =>
                firstValueFrom(next.handle()),
              ),
          ),
        ),
    );

    return from(handlerPromise);
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
