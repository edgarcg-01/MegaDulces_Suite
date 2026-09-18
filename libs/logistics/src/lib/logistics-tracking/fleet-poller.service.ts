import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { LogisticsTrackingService, SyncResult } from './logistics-tracking.service';

const MEGA = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

/**
 * LT.1 — Poller: cada minuto trae la flota del proveedor y la persiste.
 * Guard de re-entrancy (si una corrida sigue activa, skip). No corre si el
 * proveedor no tiene credenciales (env ausente) → cero ruido en local.
 */
@Injectable()
export class FleetPollerService {
  private readonly logger = new Logger(FleetPollerService.name);
  private running = false;

  constructor(
    private readonly tracking: LogisticsTrackingService,
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> {
    if (!this.tracking.isProviderConfigured()) return;
    if (this.running) {
      this.logger.warn('Skip poll: corrida anterior aún activa');
      return;
    }
    this.running = true;
    const t0 = Date.now();
    try {
      const r = await this.tracking.sync();
      await this.latir(r, Date.now() - t0);
    } catch (e: any) {
      this.logger.error(`poll falló: ${e?.message || e}`);
      await this.latir(null, Date.now() - t0, (e?.message || String(e)).split('\n')[0]);
    } finally {
      this.running = false;
    }
  }

  /**
   * [LT.9] Latido a `analytics.cron_runs` bajo la llave `fleet_gps`.
   *
   * **Por qué existe:** este cron era MUDO. La llave `fleet_gps` la escribía
   * `database/scripts/fleet-poll-onprem.js`, que corría en paralelo haciendo el
   * mismo trabajo — y medido el 2026-09-17 con `pg_stat_statements`, el 93% de
   * las posiciones las insertaba ESTE poller (los dos hacían ~49 intentos/min;
   * el on-prem llegaba 20 s tarde y casi todo le daba conflicto). O sea que el
   * tablero vigilaba el carril que NO entregaba: si este moría, `fleet_gps`
   * seguía verde; si moría el otro, se ponía rojo con el dato fluyendo igual.
   * El latido tenía que venir ACÁ antes de poder apagar aquel carril (ADR-060).
   *
   * Hereda ADR-053: mide **entrega** (`positions`), no "el proceso corrió". Y el
   * error es POR CUENTA, no sobre el total: con la flota repartida en dos cuentas
   * del proveedor, si se cae la que trae las unidades pesadas el total sigue
   * siendo 49 — un número sano que esconde media flota callada.
   *
   * ⚠️ Su umbral vive en `CRON_JOBS` (`apps/api/.../db-health.service.ts`, warnH
   * 0.5 / critH 2). Sin esa entrada `db-health` cae en `cfg ? classify : 'ok'` y
   * un cron parado se vería VERDE.
   */
  private async latir(r: SyncResult | null, ms: number, fatal?: string): Promise<void> {
    try {
      const cuentas = r?.accounts ?? [];
      const mudas = cuentas.filter((a) => !a.ok || a.count === 0);
      const detalle = cuentas.map((a) => `${a.label}=${a.ok ? a.count : 'FALLA'}`).join(' ');
      const error = fatal
        ? fatal.slice(0, 500)
        : r && r.objects === 0
          ? 'el proveedor devolvió 0 objetos — no se entregó nada'
          : mudas.length
            ? `cuenta(s) sin datos: ${mudas.map((a) => `${a.label} (${a.error || '0 objetos'})`).join(' · ')}`.slice(0, 500)
            : null;
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'fleet_gps',
          label: 'Poller GPS de flota (MagniTracking → prod)',
          last_start: new Date(Date.now() - ms),
          last_finish: this.knex.fn.now(),
          status: error ? 'error' : 'ok',
          rows_affected: r?.positions ?? null,
          duration_ms: ms,
          note: r ? `${r.objects} objetos [${detalle}] · ${r.positions} posiciones · ${r.linked} vinculados` : null,
          error,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch (e: any) {
      // El latido nunca rompe al que late (mismo criterio que cron-heartbeat.js).
      this.logger.warn(`latido fleet_gps falló: ${e?.message || e}`);
    }
  }

  /** LT.7 — sync autoritativo ruta↔operador↔camión (cambia poco → cada 15 min). */
  @Cron('0 */15 * * * *')
  async syncRoutes(): Promise<void> {
    if (!this.tracking.isProviderConfigured()) return;
    try {
      await this.tracking.syncRoutesOperators();
    } catch (e: any) {
      this.logger.error(`syncRoutes falló: ${e?.message || e}`);
    }
  }
}
