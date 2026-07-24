import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Queue, Worker } from 'bullmq';

/**
 * Trabajo encolado. `dir` distingue entrada (mensaje del cliente a procesar por
 * el orquestador) de salida (respuesta a enviar por el WhatsAppPort).
 */
export interface WhatsAppJob {
  dir: 'in' | 'out';
  tenant_id?: string | null;
  payload: unknown;
}

export type JobHandler = (job: WhatsAppJob) => Promise<void>;

/**
 * Fase F.0 (ADR-034) — Cola de WhatsApp con DOS modos, elegidos por entorno:
 *
 *   - Con `REDIS_URL`  → **BullMQ** (colas `whatsapp-in` / `whatsapp-out`) con
 *     reintentos + backoff exponencial + idempotencia por jobId. Sobrevive
 *     reinicios y absorbe picos. Es el modo de producción (ADR-034).
 *   - Sin `REDIS_URL`  → **in-process**: procesa el job de inmediato en el mismo
 *     proceso (dev / single-instance). Mismo contrato, sin infra. Es el mismo
 *     patrón de degradación que `CacheModule` (Keyv sobre Redis o en memoria).
 *
 * El productor (`enqueue`) y el consumidor (`process`) no saben en qué modo
 * corren: F.1/F.2 registran el handler con `process(dir, handler)` y publican con
 * `enqueue(job, jobId)`.
 */
@Injectable()
export class WhatsAppQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppQueueService.name);
  private readonly redisUrl = process.env.REDIS_URL || '';

  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly workerConns: any[] = []; // IORedis dedicadas por worker
  private readonly handlers = new Map<'in' | 'out', JobHandler>();
  private connection: any = null; // IORedis del PRODUCTOR (queues)

  // BullMQ solo si REDIS_URL está seteado Y la conexión inicializó bien. Si Redis
  // está caído/ausente, `queues` queda vacío → caemos a in-process sin romper.
  get mode(): 'bullmq' | 'in-process' {
    return this.queues.size > 0 ? 'bullmq' : 'in-process';
  }

  async onModuleInit(): Promise<void> {
    // BullMQ es OPT-IN (WHATSAPP_USE_BULLMQ=true). Por default corre in-process:
    // para el piloto (bot arma / humano confirma, bajo volumen) es más simple y
    // sin la complejidad de workers/conexiones. Redis (para cache) puede estar
    // presente sin que eso fuerce la cola a BullMQ. Se activa cuando escale.
    if (process.env.WHATSAPP_USE_BULLMQ !== 'true') {
      this.logger.log('Cola WhatsApp en modo in-process (WHATSAPP_USE_BULLMQ != true).');
      return;
    }
    if (!this.redisUrl) {
      this.logger.log('WHATSAPP_USE_BULLMQ=true pero sin REDIS_URL — cae a in-process.');
      return;
    }
    try {
      // Import diferido: solo se cargan cuando hay Redis (no penaliza el boot sin él).
      const IORedis = (await import('ioredis')).default;
      const { Queue } = await import('bullmq');
      // BullMQ EXIGE maxRetriesPerRequest=null en la conexión de los workers.
      this.connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
      for (const name of ['whatsapp-in', 'whatsapp-out']) {
        this.queues.set(name, new Queue(name, { connection: this.connection }));
      }
      this.logger.log('Cola WhatsApp en modo BullMQ (Redis) — whatsapp-in / whatsapp-out.');
    } catch (e: any) {
      this.logger.error(`No se pudo inicializar BullMQ (${e?.message}). Cayendo a in-process.`);
      this.connection = null;
      this.queues.clear();
    }
  }

  private queueName(dir: 'in' | 'out'): string {
    return dir === 'in' ? 'whatsapp-in' : 'whatsapp-out';
  }

  /**
   * Registra el handler de un sentido. En modo BullMQ crea el Worker; en
   * in-process solo guarda el callback para invocarlo al encolar.
   */
  async process(dir: 'in' | 'out', handler: JobHandler): Promise<void> {
    this.handlers.set(dir, handler);
    if (this.mode !== 'bullmq') return;
    const IORedis = (await import('ioredis')).default;
    const { Worker } = await import('bullmq');
    // El Worker DEBE tener su PROPIA conexión (usa comandos bloqueantes BRPOPLPUSH).
    // Compartir la conexión del productor deja los jobs en 'waiting' sin consumir.
    const workerConn = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    this.workerConns.push(workerConn);
    const worker = new Worker(
      this.queueName(dir),
      async (job) => {
        await handler(job.data as WhatsAppJob);
      },
      {
        connection: workerConn,
        // Concurrencia moderada — el rate-limit real lo impone Meta al enviar.
        concurrency: 4,
      },
    );
    worker.on('failed', (job, err) => this.logger.error(`job ${job?.id} falló: ${err?.message}`));
    worker.on('error', (err) => this.logger.error(`worker ${dir} error: ${err?.message}`));
    this.workers.push(worker);
  }

  /**
   * Publica un job. `jobId` da idempotencia (mismo id = un solo procesamiento;
   * en entrada usamos el `wa_message_id` de Meta).
   */
  async enqueue(job: WhatsAppJob, jobId?: string): Promise<void> {
    if (this.mode === 'bullmq') {
      const q = this.queues.get(this.queueName(job.dir));
      if (q) {
        await q.add(job.dir, job, {
          jobId,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        });
        return;
      }
    }
    // In-process: ejecuta el handler ya mismo (si hay). Sin handler = se ignora
    // con log (aún no registrado, p. ej. durante el arranque).
    const handler = this.handlers.get(job.dir);
    if (!handler) {
      this.logger.warn(`Sin handler para '${job.dir}' — job descartado (modo in-process).`);
      return;
    }
    try {
      await handler(job);
    } catch (e: any) {
      this.logger.error(`Handler '${job.dir}' falló (in-process, sin reintento): ${e?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const w of this.workers) await w.close().catch(() => undefined);
    for (const c of this.workerConns) await c.quit().catch(() => undefined);
    for (const q of this.queues.values()) await q.close().catch(() => undefined);
    if (this.connection) await this.connection.quit().catch(() => undefined);
  }
}
