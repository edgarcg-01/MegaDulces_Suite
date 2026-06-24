import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { ProspectsService } from './prospects.service';

/**
 * Re-corre el dedup de prospectos cada noche para todos los tenants activos:
 * cuando se da de alta un cliente nuevo, los prospectos cercanos pasan a
 * `covered` automáticamente (dejan de aparecer como oportunidad). La COSECHA
 * (llamadas a DENUE) es on-demand vía endpoint — DENUE se actualiza ~2×/año,
 * no tiene sentido pegarle a diario. Dedup es local y barato.
 *
 * Pasa un user sintético {tenant_id}: ProspectsService usa KNEX_CONNECTION
 * (superuser) + tenant_id explícito, así que no requiere scope CLS.
 */
@Injectable()
export class ProspectsRefreshService {
  private readonly logger = new Logger(ProspectsRefreshService.name);
  private isRunning = false;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly prospects: ProspectsService,
  ) {}

  @Cron('0 30 9 * * *') // 9:30 UTC ≈ 3:30 AM MX
  async scheduledDedup(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip: dedup previo aún corriendo');
      return;
    }
    this.isRunning = true;
    const start = Date.now();
    let tenants = 0;
    let covered = 0;
    try {
      const rows = await this.knex('public.tenants').where({ activo: true }).select('id');
      tenants = rows.length;
      for (const t of rows) {
        try {
          const r = await this.prospects.dedup({ tenant_id: t.id });
          covered += r.covered;
        } catch (e: any) {
          this.logger.error(`dedup tenant=${t.id} falló: ${e?.message || e}`);
        }
      }
      this.logger.log(`Dedup prospectos: ${tenants} tenants, ${covered} covered en ${Date.now() - start}ms`);
    } finally {
      this.isRunning = false;
    }
  }
}
