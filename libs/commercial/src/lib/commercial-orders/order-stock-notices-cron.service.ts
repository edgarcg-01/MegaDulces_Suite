import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { latirCron, TenantKnexService } from '@megadulces/platform-core';
import { declararPendientesViejas, MINUTOS_PARA_DECLARAR } from './order-stock-notices';

/**
 * El `job_key` del latido en `analytics.cron_runs` (y su umbral en `CRON_JOBS` de `db-health`). El
 * nombre NO lleva «KEY»: gitleaks (`generic-api-key`) marca una constante `*_KEY` con un texto aunque
 * no sea un secreto, y escanea cada commit del PR (ya bloqueó #316).
 */
export const LATIDO_BARRIDO_DN = 'dn_registro_barrido';

/**
 * `[DN.8]` Paso 3 del registro de lo que el cliente pidió y puede no haber: cada 5 minutos, toda
 * marca que siga `pendiente` después de `MINUTOS_PARA_DECLARAR` pasa a `sin_dato` con su motivo. Si
 * el paso 2 (después del commit de `place()`) murió, el hueco queda DECLARADO, nunca contado como 0
 * (ADR-056).
 *
 * ⛔ Sólo en el worker (`WORKER=true`): medido en `[CP.8.31]`, todo `@Cron` puede correr también en
 * las 2 réplicas de la API. El barrido aguanta correr en varios a la vez de todos modos: es un solo
 * `UPDATE … WHERE stock_state = 'pendiente'` por tenant (idempotente; el paso 2 escribe con la misma
 * condición, así que ninguno pisa al otro). Segundo 20 para no chocar con los crons de 5 min de
 * televenta (0) y apartados (30).
 *
 * Late en `analytics.cron_runs` (`latirCron`) con su umbral en `CRON_JOBS`: sin eso el sensor de
 * `db-health` lo pinta verde incondicional. Barrer cero es lo normal (`ceroEsOk`); si encontró marcas
 * que declarar, el latido sale en `error`: es la señal de que el paso 2 está fallando.
 */
@Injectable()
export class OrderStockNoticesCronService {
  private readonly logger = new Logger(OrderStockNoticesCronService.name);
  private running = false;

  constructor(private readonly tk: TenantKnexService) {}

  @Cron('20 */5 * * * *')
  async scheduled(): Promise<void> {
    if (process.env.WORKER !== 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      await this.barrer();
    } catch (e) {
      this.logger.error(`[DN.8] el barrido falló: ${(e as Error)?.message || String(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** Una pasada por todos los tenants: en cada uno, declara y late. */
  async barrer(): Promise<{ tenants: number; declaradas: number }> {
    const tenants = (await this.tk.global('identity.tenants').select('id')) as Array<{ id: string }>;
    let declaradas = 0;
    for (const t of tenants) {
      const t0 = Date.now();
      const fallas: string[] = [];
      let n = 0;
      try {
        n = await this.tk.run(t.id, (trx) => declararPendientesViejas(trx, MINUTOS_PARA_DECLARAR));
      } catch (e) {
        fallas.push(`el barrido falló: ${(e as Error)?.message || String(e)}`);
      }
      if (n > 0) {
        fallas.push(`${n} marcas siguieron pendientes más de ${MINUTOS_PARA_DECLARAR} min y se declararon sin_dato: el paso 2 del registro (DN.8) está fallando`);
        this.logger.warn(`[DN.8] tenant ${t.id}: ${n} marcas pendientes declaradas sin_dato`);
      }
      declaradas += n;
      await latirCron(this.tk.global, {
        jobKey: LATIDO_BARRIDO_DN,
        label: 'Registro de lo negado al agendar (barrido)',
        tenantId: t.id,
        rowsAffected: n,
        durationMs: Date.now() - t0,
        fallas,
        ceroEsOk: 'ninguna marca quedó pendiente: el paso 2 completó todo lo agendado (lo normal)',
        host: 'worker',
      });
    }
    return { tenants: tenants.length, declaradas };
  }
}
