import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '../../shared/database/new-database.module';

/**
 * Refresh de materialized views de `analytics.*`. Requiere conexión admin
 * (postgres user) porque sólo el owner puede hacer REFRESH MATERIALIZED VIEW.
 *
 * Estrategia: `REFRESH MATERIALIZED VIEW CONCURRENTLY` por MV. CONCURRENTLY
 * permite que las lecturas no se bloqueen durante el refresh. Requiere UNIQUE
 * INDEX en cada MV (ya creado en la migración).
 *
 * Schedule: cada 15 min ('*\/15 * * * *'). En testdata-scale el refresh tarda
 * ms. Cuando crezca, considerar:
 *   - Aumentar intervalo a 30-60 min
 *   - Refresh asíncrono con job queue (BullMQ) en lugar de blocking cron
 *   - Refresh disparado por eventos ('order:fulfilled' → invalidar)
 */

const MVS = [
  'analytics.mv_sales_overview_30d',
  'analytics.mv_top_customers_30d',
  'analytics.mv_top_products_30d',
];

@Injectable()
export class AnalyticsRefreshService {
  private readonly logger = new Logger(AnalyticsRefreshService.name);
  private isRefreshing = false;

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly adminKnex: Knex | null,
  ) {}

  /**
   * Cron task: refresh cada 15 min en :00, :15, :30, :45.
   * Si una corrida sigue activa cuando la siguiente arranca, skip (flag isRefreshing).
   */
  @Cron('0 */15 * * * *')
  async scheduledRefresh(): Promise<void> {
    if (!this.adminKnex) {
      this.logger.debug('Skip scheduledRefresh: KNEX_NEW_DB_ADMIN no disponible');
      return;
    }
    if (this.isRefreshing) {
      this.logger.warn('Skip scheduledRefresh: corrida anterior aún activa');
      return;
    }
    await this.refreshAll('cron');
  }

  /**
   * Refresh manual disparado por endpoint. Devuelve resultado por MV.
   */
  async refreshAll(source: 'cron' | 'manual' = 'manual'): Promise<{
    refreshed_at: string;
    results: Array<{ mv: string; ok: boolean; ms?: number; error?: string }>;
  }> {
    if (!this.adminKnex) {
      throw new Error(
        'KNEX_NEW_DB_ADMIN no disponible (DATABASE_URL_NEW no seteado en env). No se puede refrescar analytics.*',
      );
    }
    this.isRefreshing = true;
    const results: Array<{ mv: string; ok: boolean; ms?: number; error?: string }> = [];
    try {
      for (const mv of MVS) {
        const start = Date.now();
        try {
          await this.adminKnex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
          const ms = Date.now() - start;
          this.logger.log(`Refreshed ${mv} (${ms}ms, source=${source})`);
          results.push({ mv, ok: true, ms });
        } catch (e: any) {
          this.logger.error(`Refresh ${mv} failed: ${e.message}`);
          results.push({ mv, ok: false, error: e.message });
        }
      }
    } finally {
      this.isRefreshing = false;
    }
    return { refreshed_at: new Date().toISOString(), results };
  }
}
