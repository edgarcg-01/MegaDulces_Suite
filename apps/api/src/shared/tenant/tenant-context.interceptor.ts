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
    const url = (request.url || '').split('?')[0];
    const method = request.method;
    const reqId = Math.random().toString(36).slice(2, 8);

    // Ejecutamos el flow como Promise → from() lo convierte en Observable que
    // Nest sabe consumir.
    const handlerPromise = (async () => {
      const t0 = Date.now();
      this.logger.log(`[${reqId}] ${method} ${url} → BEGIN tx tenant=${tenantId}`);
      try {
        const result = await this.legacyRawKnex.transaction(async (tx) => {
          await tx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
          this.logger.log(`[${reqId}] set_config OK (+${Date.now() - t0}ms), invocando handler`);
          const value = await this.tenantCtx.run(
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
          );
          this.logger.log(`[${reqId}] handler resolved (+${Date.now() - t0}ms), pre-COMMIT`);
          return value;
        });
        this.logger.log(`[${reqId}] tx COMMITTED (+${Date.now() - t0}ms), returning to Nest`);
        return result;
      } catch (err: any) {
        this.logger.error(`[${reqId}] tx failed (+${Date.now() - t0}ms): ${err?.message ?? err}`);
        throw err;
      }
    })();

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
