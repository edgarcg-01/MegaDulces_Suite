import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * Guard máquina-a-máquina para el ingest del poller on-prem. Verifica el header
 * `x-store-ingest-key` contra `STORE_INGEST_KEY`. El endpoint es `@Public()` (sin
 * JWT de usuario) porque lo llama el runner, no un navegador.
 */
@Injectable()
export class StoreIngestGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers?.['x-store-ingest-key'];
    const expected = process.env.STORE_INGEST_KEY || 'dev_store_ingest_key';
    if (!key || key !== expected) throw new UnauthorizedException('bad store ingest key');
    return true;
  }
}
