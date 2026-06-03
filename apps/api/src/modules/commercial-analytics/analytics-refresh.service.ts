import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';

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

/**
 * MVs a refrescar. `requires_fdw=true` significa que el SELECT joinea con
 * `analytics_external.*` (postgres_fdw → 192.168.0.245). Esos refresh se
 * skippean automáticamente si el FDW no es alcanzable, sin reintentar 15min
 * más tarde y sin spamear el log.
 */
const MVS: Array<{ name: string; requires_fdw?: boolean }> = [
  { name: 'analytics.mv_sales_overview_30d' },
  { name: 'analytics.mv_top_customers_30d' },
  { name: 'analytics.mv_top_products_30d' },
  { name: 'public.products_top_sellers', requires_fdw: true },
];

@Injectable()
export class AnalyticsRefreshService {
  private readonly logger = new Logger(AnalyticsRefreshService.name);
  private isRefreshing = false;
  /**
   * Cache TTL para el check de salud del FDW. Si una vez falla, no volvemos
   * a probar hasta 30 min después — sino cada cron tick (15 min) ata una
   * conexión esperando timeout al FDW caído.
   */
  private fdwUnhealthyUntil: number = 0;

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
    const results: Array<{ mv: string; ok: boolean; ms?: number; error?: string; skipped?: boolean }> = [];
    const now = Date.now();
    try {
      for (const entry of MVS) {
        const mv = entry.name;

        // FDW health gate: si una corrida previa marcó el FDW como caído,
        // saltamos las MVs que lo requieren hasta que pase la ventana.
        if (entry.requires_fdw && this.fdwUnhealthyUntil > now) {
          const minutesLeft = Math.ceil((this.fdwUnhealthyUntil - now) / 60_000);
          this.logger.debug(
            `Skip ${mv}: FDW marcado unhealthy hasta hace ${minutesLeft} min restantes`,
          );
          results.push({ mv, ok: false, skipped: true, error: 'fdw_unhealthy' });
          continue;
        }

        const start = Date.now();
        try {
          // CONCURRENTLY exige que la MV ya esté poblada al menos una vez. Si
          // se creó WITH NO DATA (o es una DB nueva sin seed inicial),
          // relispopulated=false y CONCURRENTLY falla. En ese caso hacemos un
          // REFRESH normal primero para poblarla; las siguientes corridas ya
          // usan CONCURRENTLY sin bloquear lecturas.
          const [{ relispopulated }] = (
            await this.adminKnex.raw(
              `SELECT relispopulated FROM pg_class WHERE oid = ?::regclass`,
              [mv],
            )
          ).rows;
          const concurrently = relispopulated ? 'CONCURRENTLY ' : '';
          await this.adminKnex.raw(
            `REFRESH MATERIALIZED VIEW ${concurrently}${mv}`,
          );
          const ms = Date.now() - start;
          this.logger.log(
            `Refreshed ${mv} (${ms}ms, source=${source}${concurrently ? '' : ', initial populate'})`,
          );
          results.push({ mv, ok: true, ms });
        } catch (e: any) {
          const msg = e.message || String(e);
          // Detectar fallos del FDW para marcar unhealthy y no reintentar
          // cada 15 min (sino cada tick ata una conexión esperando timeout).
          const isFdwDown =
            entry.requires_fdw &&
            /could not connect to server|connection to server.*failed|no route to host|ETIMEDOUT/i.test(
              msg,
            );
          if (isFdwDown) {
            this.fdwUnhealthyUntil = Date.now() + 30 * 60_000;
            this.logger.warn(
              `Refresh ${mv} skip: FDW unreachable. No reintentaremos por 30 min. (${msg.slice(0, 120)})`,
            );
          } else {
            this.logger.error(`Refresh ${mv} failed: ${msg}`);
          }
          results.push({ mv, ok: false, error: msg });
        }
      }
    } finally {
      this.isRefreshing = false;
    }
    return { refreshed_at: new Date().toISOString(), results };
  }
}
