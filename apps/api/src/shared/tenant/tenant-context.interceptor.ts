import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Knex } from 'knex';
import { Observable } from 'rxjs';
import { KNEX_CONNECTION_RAW } from '../database/database.module';
import { TenantContextService } from './tenant-context.service';

/**
 * Interceptor GLOBAL que:
 *
 *  1. Extrae tenant_id del Authorization Bearer JWT.
 *  2. Abre un AsyncLocalStorage scope con `{ tenantId, userId, username, roleName }`.
 *  3. Abre una **transacción del pool legacy** con `SET LOCAL app.tenant_id = '...'`
 *     y la guarda en `ctx.legacyTx`. El KNEX_CONNECTION del DatabaseModule legacy
 *     es un Proxy que routea queries a esa tx, así los services single-tenant
 *     (stores, visits, captures, etc.) automáticamente respetan el tenant
 *     context sin modificar ni una línea.
 *  4. Commit al final del request, rollback en error.
 *
 * NOTA importante: el legacy Knex se inyecta via `ModuleRef.get(..., { strict: false })`
 * de manera LAZY en `onModuleInit`. Esto evita ciclo de dependencias entre
 * DatabaseModule (que importa TenantModule) y TenantModule (que provee este
 * interceptor que necesita KNEX_CONNECTION_RAW de DatabaseModule).
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor, OnModuleInit {
  private readonly logger = new Logger(TenantContextInterceptor.name);
  private legacyKnex: Knex | null = null;

  constructor(
    private readonly tenantCtx: TenantContextService,
    private readonly jwtService: JwtService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    // Lazy resolution: cuando NestJS termina de cargar todos los módulos,
    // intentamos resolver KNEX_CONNECTION_RAW del scope global. Si lo
    // encontramos, activamos el wrapping de tx legacy. Si no (caso single-
    // tenant puro sin DatabaseModule legacy), seguimos sin tx.
    try {
      this.legacyKnex = this.moduleRef.get(KNEX_CONNECTION_RAW, { strict: false });
      if (this.legacyKnex) {
        this.logger.log('Legacy Knex RAW resuelto via ModuleRef — tx wrapping ACTIVO en cada request.');
      } else {
        this.logger.warn('Legacy Knex RAW no encontrado — tx wrapping INACTIVO (INSERTs legacy fallarán).');
      }
    } catch (e: any) {
      this.logger.warn(`No se pudo resolver KNEX_CONNECTION_RAW: ${e?.message || e}`);
      this.legacyKnex = null;
    }
  }

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

    const ctxBase = {
      tenantId: payload.tenant_id as string,
      userId: payload.sub,
      username: payload.username,
      roleName: payload.role_name,
    };

    return new Observable((subscriber) => {
      // Sin legacy Knex disponible → solo abrimos scope CLS, sin tx legacy.
      if (!this.legacyKnex) {
        this.tenantCtx.run(ctxBase, () => {
          next.handle().subscribe({
            next: (v) => subscriber.next(v),
            error: (e) => subscriber.error(e),
            complete: () => subscriber.complete(),
          });
        });
        return;
      }

      // Abrimos tx del pool legacy con SET LOCAL app.tenant_id.
      // commit al success, rollback al error.
      this.legacyKnex
        .transaction(async (tx) => {
          await tx.raw(`SET LOCAL app.tenant_id = ?`, [ctxBase.tenantId]);
          await new Promise<void>((resolveTx, rejectTx) => {
            this.tenantCtx.run({ ...ctxBase, legacyTx: tx }, () => {
              next.handle().subscribe({
                next: (value) => subscriber.next(value),
                error: (err) => {
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
          if (!subscriber.closed) subscriber.error(err);
        });
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
