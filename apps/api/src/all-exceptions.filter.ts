import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Exception filter global (INFRA.2, ADR-043).
 *
 * Reemplaza al SentryGlobalFilter (Sentry removido). Loguea CADA excepción con
 * status >= 500 a nivel **error**, con método/URL + stacktrace → aparece en los
 * logs (Railway stdout + Loki/Grafana). Sin esto los 500 solo se ven como una
 * línea "info" de pino-http, sin la causa. Delega la respuesta al filtro base
 * de Nest (mismo comportamiento de siempre para el cliente).
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('Exception');

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;

    if (status >= 500) {
      const req = host.switchToHttp().getRequest();
      const where = req ? `${req.method} ${req.originalUrl || req.url}` : 'unknown';
      const err =
        exception instanceof Error
          ? exception
          : new Error(typeof exception === 'string' ? exception : JSON.stringify(exception));
      this.logger.error(`${where} → ${status}: ${err.message}`, err.stack);
    }

    super.catch(exception, host);
  }
}
