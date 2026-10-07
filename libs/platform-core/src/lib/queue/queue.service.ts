import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';

/**
 * QueueService — cola de jobs sobre el propio Postgres (pg-boss). INFRA.3, ADR-043.
 *
 * Base del **worker-tier**: saca del proceso web el trabajo pesado (crons
 * nocturnos, IA de minutos, refresh de MVs) para que deje de competir por RAM
 * con el tráfico HTTP (causa del OOM/ECONNRESET) y para poder escalar el API
 * horizontalmente sin duplicar los crons.
 *
 * Diseño (dos ejes, todo opt-in):
 *  - `ENABLE_WORKER_QUEUE=true` activa pg-boss. Sin el toggle, el servicio es
 *    INERTE (null-safe) y la app corre exactamente como hoy (crons in-process).
 *  - `WORKER=true` marca al proceso worker: solo ÉL consume (`work`) y agenda
 *    (`schedule`). El proceso API puede PRODUCIR (`send`) pero no consume.
 *
 * Usa `DATABASE_URL_NEW` (rol postgres) porque pg-boss crea/mantiene su schema
 * `pgboss` (DDL) — app_runtime no tiene esos privilegios. Pool propio y chico.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QueueService');
  private boss: PgBoss | null = null;
  private readonly ensured = new Set<string>();

  /** ¿El worker-tier está activo? Sin esto todo es no-op y la app corre legacy. */
  isEnabled(): boolean {
    return (
      process.env.ENABLE_WORKER_QUEUE === 'true' &&
      !!process.env.DATABASE_URL_NEW
    );
  }

  /** ¿Este proceso es el worker (el único que consume/agenda)? */
  isWorker(): boolean {
    return process.env.WORKER === 'true';
  }

  async onModuleInit(): Promise<void> {
    if (!this.isEnabled()) {
      if (process.env.ENABLE_WORKER_QUEUE === 'true') {
        this.logger.warn(
          'ENABLE_WORKER_QUEUE=true pero falta DATABASE_URL_NEW → cola inerte.',
        );
      }
      return;
    }
    try {
      this.boss = new PgBoss({
        connectionString: process.env.DATABASE_URL_NEW,
        schema: 'pgboss',
        // Pool propio y chico: no comparte con el runtime de la app.
        max: Number(process.env.QUEUE_POOL_MAX) || 4,
        ssl:
          process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : undefined,
      });
      this.boss.on('error', (err) =>
        this.logger.error(`pg-boss error: ${err?.message || err}`),
      );
      await this.boss.start();
      this.logger.log(
        `pg-boss listo (${this.isWorker() ? 'WORKER: consume+agenda' : 'API: solo produce'}).`,
      );
    } catch (err) {
      // Nunca tumbar el boot por la cola: degradar a inerte.
      this.boss = null;
      this.logger.error(
        `No se pudo iniciar pg-boss (${(err as Error)?.message}) → cola inerte.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) {
      await this.boss.stop({ graceful: true }).catch(() => undefined);
      this.boss = null;
    }
  }

  private async ensureQueue(name: string): Promise<void> {
    if (!this.boss || this.ensured.has(name)) return;
    // Idempotente: crea la cola si no existe (pg-boss v10+ lo exige antes de send/work).
    await this.boss.createQueue(name).catch(() => undefined);
    this.ensured.add(name);
  }

  /**
   * Encola un job. Funciona desde cualquier proceso (API o worker). No-op si la
   * cola está inerte → el caller debe tener un fallback (correr inline) cuando
   * `isEnabled()` es false. Devuelve el jobId o null.
   */
  async send<T extends object>(
    queue: string,
    data: T,
    opts: Record<string, unknown> = {},
  ): Promise<string | null> {
    if (!this.boss) return null;
    await this.ensureQueue(queue);
    return this.boss.send(queue, data, opts);
  }

  /**
   * Registra un consumidor. SOLO corre en el worker (`WORKER=true`) — en el API
   * es no-op, para que el trabajo pesado no se ejecute en el proceso web.
   */
  async work<T extends object>(
    queue: string,
    handler: (job: { id: string; data: T }) => Promise<void>,
    opts: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.boss || !this.isWorker()) return;
    await this.ensureQueue(queue);
    // pg-boss entrega un batch (array) por default; normalizamos a 1-por-1.
    await this.boss.work<T>(queue, opts, async (jobs) => {
      for (const job of jobs) {
        await handler({ id: job.id, data: job.data });
      }
    });
    this.logger.log(`worker suscrito a la cola '${queue}'.`);
  }

  /**
   * Agenda un job recurrente por cron. SOLO en el worker. Reemplaza a un
   * `@Cron` in-process cuando el worker-tier está activo.
   */
  async schedule<T extends object>(
    queue: string,
    cron: string,
    data: T = {} as T,
    opts: Record<string, unknown> = { tz: 'America/Mexico_City' },
  ): Promise<void> {
    if (!this.boss || !this.isWorker()) return;
    await this.ensureQueue(queue);
    await this.boss.schedule(queue, cron, data, opts);
    this.logger.log(`cron '${cron}' agendado en la cola '${queue}'.`);
  }
}
