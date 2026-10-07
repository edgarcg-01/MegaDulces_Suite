import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';

/**
 * Cron de limpieza para Fase E.
 *
 * Cada 5 minutos libera las reservas con `expires_at < NOW()` que sigan
 * activas (released_at IS NULL). Marca released_reason='expired'.
 *
 * Esto es defense-in-depth: el endpoint /queue ya excluye reservas vencidas
 * (filtro `expires_at > NOW()`), pero queremos `released_at` populado para
 * análisis/auditoría posterior.
 *
 * Cross-tenant: el cron es un job global del API, no tiene tenant context.
 * Usa `KNEX_NEW_DB_ADMIN` (rol `postgres` superuser) para BYPASS RLS y poder
 * actualizar reservas de TODOS los tenants en un solo UPDATE.
 *
 * Riesgo aceptado: este service no debe exponerse vía HTTP. Solo lo invoca
 * `@Cron` interno del scheduler.
 */
@Injectable()
export class TeleventaCronService {
  private readonly logger = new Logger(TeleventaCronService.name);
  private isRunning = false;

  constructor(@Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex) {}

  @Cron('0 */5 * * * *') // cada 5 min, segundo 0
  async releaseExpired(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('releaseExpired: previous run in progress, skip');
      return;
    }
    this.isRunning = true;
    try {
      const result = await this.knex('commercial.lead_reservations')
        .whereNull('released_at')
        .where('expires_at', '<', this.knex.fn.now())
        .update({
          released_at: this.knex.fn.now(),
          released_reason: 'expired',
        });

      if (result > 0) {
        this.logger.log(`releaseExpired: ${result} reservas expiradas liberadas`);
      }
    } catch (e: any) {
      this.logger.error(`releaseExpired failed: ${e.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
