import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Knex } from 'knex';
import { Observable } from 'rxjs';
import { KNEX_CONNECTION_RAW } from '../database/database.module';
import { TenantContextService } from './tenant-context.service';

/**
 * Interceptor GLOBAL que:
 *
 *  1. Extrae el tenant_id del Authorization Bearer JWT (decode inline).
 *  2. Abre un AsyncLocalStorage scope con `{ tenantId, userId, username, roleName }`.
 *  3. Abre una **transacción del pool legacy** con `SET LOCAL app.tenant_id = '...'`
 *     y la guarda en `ctx.legacyTx`. El KNEX_CONNECTION del DatabaseModule legacy
 *     es un Proxy que routea queries a esa tx, así los services single-tenant
 *     (stores, visits, captures, etc.) automáticamente respetan el tenant
 *     context sin modificar ni una línea.
 *  4. Commit al final del request, rollback en error.
 *
 * Sin Authorization → no abre scope ni tx (endpoints públicos: login, health).
 * Con token inválido → 401.
 *
 * NOTA: el `TenantKnexService` (pool nuevo) hace su propio SET LOCAL en cada
 * `tk.run(cb)`. Acá solo manejamos la tx del pool legacy.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantContextInterceptor.name);

  constructor(
    private readonly tenantCtx: TenantContextService,
    private readonly jwtService: JwtService,
    // KNEX_CONNECTION_RAW = el pool legacy SIN proxy. Acá lo usamos para abrir
    // la tx manualmente. Si no está disponible (legacy puro), el wrapping
    // de tx se desactiva y los services legacy operan con el pool normal.
    @Optional()
    @Inject(KNEX_CONNECTION_RAW)
    private readonly legacyKnex: Knex | null = null,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const auth = request.headers?.authorization;

    // Sin Authorization → endpoint público. Pasa sin scope ni tx.
    if (!auth) return next.handle();

    const payload = this.extractPayload(request);
    if (!payload) throw new UnauthorizedException('Token inválido o expirado');

    // Token válido pero sin tenant_id → JWT legacy single-tenant. Pasa sin
    // scope tenant ni tx (los endpoints commercial/logistics fallarán con
    // mensaje claro, los legacy single-tenant siguen funcionando como antes).
    if (!payload.tenant_id) {
      request.user = payload;
      return next.handle();
    }

    request.user = payload;

    const ctxBase = {
      tenantId: payload.tenant_id as string,
      userId: payload.sub,
      username: payload.username,
      roleName: payload.role_name,
    };

    return new Observable((subscriber) => {
      // Si NO hay pool legacy disponible (puede pasar en tests / boot
      // temprano), abrimos solo el scope CLS sin tx.
      if (!this.legacyKnex) {
        this.tenantCtx.run(ctxBase, () => {
          this.subscribeToHandler(next, subscriber);
        });
        return;
      }

      // Abrimos tx del pool legacy + SET LOCAL app.tenant_id.
      // commit al success, rollback al error.
      this.legacyKnex
        .transaction(async (tx) => {
          await tx.raw(`SET LOCAL app.tenant_id = ?`, [ctxBase.tenantId]);

          // Promesa que se resuelve cuando el subscriber complete/error.
          // Si error → throw para que la tx haga rollback automático.
          await new Promise<void>((resolveTx, rejectTx) => {
            this.tenantCtx.run({ ...ctxBase, legacyTx: tx }, () => {
              next.handle().subscribe({
                next: (value) => subscriber.next(value),
                error: (err) => {
                  // Rollback de la tx legacy + propagar al subscriber.
                  subscriber.error(err);
                  rejectTx(err);
                },
                complete: () => {
                  subscriber.complete();
                  resolveTx();
                },
              });
            });
          });
        })
        .catch((err) => {
          // Errores del transaction wrapper que no llegaron al subscriber
          // (raro). Garantizamos que el subscriber siempre cierra.
          if (!subscriber.closed) subscriber.error(err);
        });
    });
  }

  private subscribeToHandler(next: CallHandler, subscriber: any): void {
    next.handle().subscribe({
      next: (v) => subscriber.next(v),
      error: (e) => subscriber.error(e),
      complete: () => subscriber.complete(),
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
