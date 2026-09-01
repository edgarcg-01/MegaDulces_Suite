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
  // PERF (mig 20260831150000): momentum r30/r90 para ThotService.suggest(). Antes se
  // agregaba 90d de sales_daily en vivo por request (~1.4 s); ahora es un join al matview.
  { name: 'analytics.mv_product_momentum' },
  // PERF (mig 20260831160000): ventas del mes en curso pre-agregadas para el path diario
  // de sellOut (mes en curso nunca es month-aligned → escaneaba 111k filas + sort-a-disco).
  { name: 'analytics.mv_sales_current_month' },
  // NOTA: analytics.mv_wincaja_sales_daily NO va en este array de 15 min. Se alimenta de una carga
  // Access→Postgres que aterriza ~05:00 MX una vez al día (el resto del histórico está congelado) →
  // se refresca NIGHTLY en refreshWincajaDaily() (06:20 MX, tras la carga). Refrescarlo cada 15 min
  // era puro desperdicio y devolvía la contención del pool admin (0-2) → 2.6 min por request de sell-out.
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
   * PASO 3 (mig 20260901160000) — refresh del rollup diario de wincaja
   * (`analytics.mv_wincaja_sales_daily`, all-history). Va aparte del cron de 15 min y corre UNA vez al
   * día porque wincaja se alimenta por una carga Access→Postgres que aterriza ~05:00 MX (medido: las
   * 3 sucursales vivas 00/30/32 cargaron 05:01–05:06); el resto del histórico está congelado. Refrescar
   * cada 15 min era puro desperdicio y devolvía la contención del pool admin (0-2) que causaba los
   * 2.6 min por request de sell-out.
   *
   * 06:20 MX: DESPUÉS de la carga (~05:06) con margen, y off del borde de 15 min (:00/:15/:30/:45) para
   * no competir por el pool admin con el otro cron. El contenedor ya corre en America/Mexico_City → sin
   * `timeZone`. REFRESH CONCURRENTLY (no bloquea las lecturas de sellOut) + ANALYZE (grano fino → el
   * planner necesita stats frescas o elige un plan catastrófico). No es FDW → sin el gate de FDW del loop.
   */
  @Cron('0 20 6 * * *')
  async refreshWincajaDaily(): Promise<void> {
    const admin = this.adminKnex;
    if (!admin) {
      this.logger.debug('Skip refreshWincajaDaily: KNEX_NEW_DB_ADMIN no disponible');
      return;
    }
    const mv = 'analytics.mv_wincaja_sales_daily';
    const start = Date.now();
    let ok = false;
    let errMsg: string | null = null;
    try {
      const found = (
        await admin.raw(`SELECT relkind, relispopulated FROM pg_class WHERE oid = ?::regclass`, [mv])
      ).rows;
      if (!found.length || found[0].relkind !== 'm') {
        this.logger.debug(
          `Skip ${mv}: no es materialized view (relkind=${found.length ? found[0].relkind : 'missing'}).`,
        );
        return;
      }
      const concurrently = found[0].relispopulated ? 'CONCURRENTLY ' : '';
      await admin.raw(`REFRESH MATERIALIZED VIEW ${concurrently}${mv}`);
      await admin.raw(`ANALYZE ${mv}`);
      ok = true;
      this.logger.log(
        `Refreshed ${mv} (${Date.now() - start}ms, source=cron-nightly${concurrently ? '' : ', initial populate'})`,
      );
    } catch (e: any) {
      errMsg = e.message || String(e);
      this.logger.error(`Refresh ${mv} (nightly) failed: ${errMsg}`);
    }
    // Heartbeat → Salud BD (grupo Crons), job propio para no pisar el del cron de 15 min.
    try {
      const MEGA = '00000000-0000-0000-0000-00000000d01c';
      await admin('analytics.cron_runs')
        .insert({
          tenant_id: MEGA, job_key: 'analytics_refresh_wincaja', label: 'Refresh MV wincaja (nightly)',
          last_start: admin.fn.now(), last_finish: admin.fn.now(),
          status: ok ? 'ok' : 'error', rows_affected: ok ? 1 : 0,
          error: errMsg ? errMsg.slice(0, 500) : null, host: 'api', updated_at: admin.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_finish', 'status', 'rows_affected', 'error', 'host', 'updated_at']);
    } catch { /* heartbeat no debe romper el refresh */ }
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
          // relkind: solo 'm' (materialized view) es refrescable. En prod el
          // hotfix convirtió catalog.products_top_sellers en TABLA + public.* en
          // VIEW normal (sincronizadas manualmente desde el ERP). Refrescar una
          // vista/tabla tira "is not a table or materialized view". Si no es MV,
          // saltamos sin error: su data llega por sync externo, no por REFRESH.
          // relispopulated: CONCURRENTLY exige que la MV ya esté poblada al menos
          // una vez (WITH NO DATA → false). Si no, REFRESH normal primero.
          const found = (
            await this.adminKnex.raw(
              `SELECT relkind, relispopulated FROM pg_class WHERE oid = ?::regclass`,
              [mv],
            )
          ).rows;
          if (!found.length || found[0].relkind !== 'm') {
            const kind = found.length ? found[0].relkind : 'missing';
            this.logger.debug(
              `Skip ${mv}: no es materialized view (relkind=${kind}) — data por sync externo, no por REFRESH.`,
            );
            results.push({ mv, ok: true, skipped: true });
            continue;
          }
          const concurrently = found[0].relispopulated ? 'CONCURRENTLY ' : '';
          await this.adminKnex.raw(
            `REFRESH MATERIALIZED VIEW ${concurrently}${mv}`,
          );
          // ANALYZE post-refresh: REFRESH reemplaza los datos pero no actualiza las stats del
          // planner. En MVs de grano fino (p.ej. mv_wincaja_sales_daily ~99k filas/mes) sin stats
          // frescas el planner elige un plan catastrófico al leerlas (verificado: timeout vs 739ms
          // con ANALYZE). Barato para las MVs chicas; `mv` sale de MVS (no user input).
          await this.adminKnex.raw(`ANALYZE ${mv}`);
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
    // Heartbeat → Salud BD (grupo Crons). error si alguna MV real falló (no skip).
    try {
      const failed = results.filter((r) => !r.ok && !r.skipped);
      const ok = results.filter((r) => r.ok && !r.skipped).length;
      const MEGA = '00000000-0000-0000-0000-00000000d01c';
      await this.adminKnex!('analytics.cron_runs')
        .insert({
          tenant_id: MEGA, job_key: 'analytics_refresh', label: 'Refresh MVs analytics',
          last_start: this.adminKnex!.fn.now(), last_finish: this.adminKnex!.fn.now(),
          status: failed.length ? 'error' : 'ok', rows_affected: ok,
          error: failed.length ? failed.map((f) => f.mv).join(', ').slice(0, 500) : null,
          host: 'api', updated_at: this.adminKnex!.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_finish', 'status', 'rows_affected', 'error', 'host', 'updated_at']);
    } catch { /* heartbeat no debe romper el refresh */ }
    return { refreshed_at: new Date().toISOString(), results };
  }
}
