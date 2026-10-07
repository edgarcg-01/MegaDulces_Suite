import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * Fase RH · `[RH.1.2]` — llave de máquina a máquina para el lector de relojes.
 *
 * Verifica el header `x-hr-ingest-key` contra `HR_INGEST_KEY`. El endpoint es `@Public()`
 * (sin JWT de usuario) porque lo llama el lector, no un navegador. Mismo patrón que
 * `StoreIngestGuard`: en producción falla CERRADO si la llave no está configurada; en
 * desarrollo sólo acepta el valor conocido de desarrollo.
 *
 * ⚠️ Deuda con nombre (ADR-056): es el segundo guard de ingesta casi idéntico (el primero es
 * `StoreIngestGuard`). Cuando aparezca el tercero, va a `platform-core` como fábrica.
 */
@Injectable()
export class HrIngestGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers?.['x-hr-ingest-key'];
    const expected = process.env['HR_INGEST_KEY'];
    if (!expected) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new UnauthorizedException('ingesta de relojes no configurada (falta HR_INGEST_KEY)');
      }
      if (key !== 'dev_hr_ingest_key') throw new UnauthorizedException('llave de ingesta de relojes inválida');
      return true;
    }
    if (!key || key !== expected) throw new UnauthorizedException('llave de ingesta de relojes inválida');
    return true;
  }
}
