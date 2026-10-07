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
    // `[AUTHZ-HARD.0]` En prod exigimos que STORE_INGEST_KEY esté seteado: el default
    // 'dev_store_ingest_key' está commiteado, así que dejarlo abría el ingest @Public() a
    // cualquiera que leyó el repo. Falla cerrado.
    const expected = process.env.STORE_INGEST_KEY;
    if (!expected) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new UnauthorizedException('store ingest no configurado (falta STORE_INGEST_KEY)');
      }
      // dev: sólo entonces se acepta el default conocido.
      if (key !== 'dev_store_ingest_key') throw new UnauthorizedException('bad store ingest key');
      return true;
    }
    if (!key || key !== expected) throw new UnauthorizedException('bad store ingest key');
    return true;
  }
}
