import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { shouldRunInProcessCron } from '@megadulces/platform-core';

/**
 * Dueño de los crons (INFRA.3.5, ADR-043) — gate CENTRAL del worker-tier.
 *
 * En vez de tocar el cuerpo de los ~40 `@Cron`, al terminar el bootstrap
 * decidimos por PROCESO si este corre los jobs de fondo:
 *  - `shouldRunInProcessCron()` true (worker-tier OFF, o este ES el worker
 *    WORKER=true) → no hace nada, los crons corren normal.
 *  - false (worker-tier ON y este es el API) → DETIENE todos los cron jobs e
 *    intervals del `SchedulerRegistry`, para que el trabajo de fondo (scans
 *    nocturnos, IA, refresh de MVs, pollers) NO se ejecute en el proceso web
 *    ni se duplique al escalar el API horizontal. Lo corre el worker.
 *
 * Secuencia de rollout segura: primero desplegar el worker sano; recién
 * entonces poner ENABLE_WORKER_QUEUE=true en el API (hasta ese momento el API
 * sigue corriendo los crons, así nunca quedan sin correr en ningún lado).
 */
@Injectable()
export class SchedulerOwnershipService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('SchedulerOwnership');

  constructor(private readonly registry: SchedulerRegistry) {}

  onApplicationBootstrap(): void {
    if (shouldRunInProcessCron()) return;

    const stopped = this.detenerTodo();
    this.logger.warn(
      `Worker-tier activo y este proceso NO es el worker → detenidos ${stopped} crons/intervals. Los corre el worker (WORKER=true).`,
    );
  }

  /**
   * ⭐ `[DEPLOY.1]` **AL APAGARSE NO SE ARRANCA NADA NUEVO.** Medido el 2026-10-13.
   *
   * El worker es `replicas: 1` + `Recreate` (correcto: 51 `@Cron`, dos pods duplicarían
   * escrituras), y su manifiesto **no declaraba `terminationGracePeriodSeconds`** → usaba el
   * default de **30 s** y después llegaba `SIGKILL`. Medido contra `analytics.cron_runs` en
   * prod: de **90** jobs con latido, **27 pasan de 30 s**, 25 de 60 s y 7 de 5 min. O sea
   * que ~30 % de los jobs, si un despliegue los agarra corriendo, mueren a media transacción
   * y Postgres revierte. Eso es lo que se sentía como *"el despliegue no deja terminar las
   * transacciones en curso"*.
   *
   * El arreglo son DOS piezas y ninguna sirve sola:
   *
   *  1. `terminationGracePeriodSeconds: 600` en `ops/k3s/42-worker.deployment.yaml` — le da al
   *     job en vuelo hasta 10 min para terminar solo. Cubre **24 de los 27** medidos. Node
   *     mantiene vivo el bucle de eventos mientras la promesa del job siga pendiente, así que
   *     el proceso NO sale hasta que termina — siempre que nadie llame `process.exit()`.
   *
   *  2. **Esto**: detener el scheduler al recibir la señal. Sin esto, la gracia larga es un
   *     tiro en el pie — un `@Cron` podría dispararse en el segundo 500 de los 600 y morir
   *     igual, sólo que ahora con más ventana para que pase.
   *
   * ⚠️ `job.stop()` **no aborta la corrida en curso**: sólo evita los disparos futuros. Eso es
   * exactamente lo que se quiere — terminar lo que está, no empezar nada.
   *
   * ⛔ Lo que esto NO arregla, y se declara en vez de disfrazarse: los 2 jobs del worker que
   * pasan de 10 min son `analytics_refresh_price_waterfall` (2 h 47 min) y
   * `analytics_refresh_sellout_budget` (68 min). Esperarlos haría que cada despliegue pudiera
   * trabarse casi 3 horas. Van a morir igual — pero son `REFRESH MATERIALIZED VIEW`, que
   * **revierte limpio**: se pierde el trabajo, no el dato. Su mitigación es no desplegar en su
   * ventana (06:20–07:59 MX), no una gracia más larga.
   *
   * ⚠️ Con `Recreate` el pod nuevo no arranca hasta que el viejo se fue, así que un despliegue
   * que caiga sobre un job largo **espera lo que tarde el job** (tope 600 s). Si no hay nada
   * corriendo, sale al instante: el costo sólo se paga cuando de verdad hay algo que salvar.
   */
  onApplicationShutdown(signal?: string): void {
    const stopped = this.detenerTodo();
    this.logger.warn(
      `${signal ?? 'apagado'} recibido → detenidos ${stopped} crons/intervals: no se arranca nada nuevo. `
        + 'Lo que ya estaba corriendo termina solo (tope: terminationGracePeriodSeconds del manifiesto).',
    );
  }

  /** Detiene todo disparo futuro. No toca lo que ya está ejecutándose. */
  private detenerTodo(): number {
    let stopped = 0;
    for (const [, job] of this.registry.getCronJobs()) {
      try {
        job.stop();
        stopped++;
      } catch {
        /* noop */
      }
    }
    for (const name of this.registry.getIntervals()) {
      try {
        this.registry.deleteInterval(name);
        stopped++;
      } catch {
        /* noop */
      }
    }
    return stopped;
  }
}
