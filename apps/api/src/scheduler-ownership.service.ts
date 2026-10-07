import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
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
export class SchedulerOwnershipService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SchedulerOwnership');

  constructor(private readonly registry: SchedulerRegistry) {}

  onApplicationBootstrap(): void {
    if (shouldRunInProcessCron()) return;

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
    this.logger.warn(
      `Worker-tier activo y este proceso NO es el worker → detenidos ${stopped} crons/intervals. Los corre el worker (WORKER=true).`,
    );
  }
}
