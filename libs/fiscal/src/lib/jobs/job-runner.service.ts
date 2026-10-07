import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { FiscalJob } from './job-queue.service';

export type JobHandler = (job: FiscalJob) => Promise<Record<string, unknown> | void>;

/** Marca un error como PERMANENTE (no reintentar) — p.ej. e.firma inválida (305). */
export class FiscalPermanentError extends Error {}

/**
 * FISCAL.3 — Runner de la cola Postgres. Cron cada 30s: por cada tenant activo
 * reclama jobs vencidos (FOR UPDATE SKIP LOCKED), los despacha al handler
 * registrado por `type`, y aplica backoff exponencial + full jitter; agotados o
 * permanentes → DLQ (status='dead'). Sin BullMQ. Guard anti-solape.
 */
@Injectable()
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly deadHandlers = new Map<string, JobHandler>();
  private running = false;
  private readonly BATCH = 20;
  /** Un job 'running' con lock más viejo que esto se considera huérfano (crash/redeploy
   *  a mitad del handler) y vuelve a 'pending'. Debe superar a la llamada SAT más lenta (~90s). */
  private readonly RUNNING_TIMEOUT_MS = 10 * 60_000;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly tk: TenantKnexService,
  ) {}

  /** Registra el handler de un `type` (lo llaman los orquestadores en onModuleInit). */
  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) this.logger.warn(`Handler de '${type}' sobreescrito`);
    this.handlers.set(type, handler);
  }

  /** Registra un hook que corre cuando un job de ese `type` cae a la DLQ (status='dead').
   *  Permite al orquestador reconciliar el agregado (p.ej. marcar el request en 'error').
   *  Corre dentro del scope de tenant, best-effort (su fallo no re-mata el job). */
  onDead(type: string, handler: JobHandler): void {
    this.deadHandlers.set(type, handler);
  }

  @Cron('*/30 * * * * *')
  async tick(): Promise<void> {
    if (this.running) return;
    if (!this.handlers.size) return; // nada registrado aún
    this.running = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try { await this.tenantCtx.run({ tenantId: t.id }, () => this.drainTenant(t.id)); }
        catch (e: any) { this.logger.warn(`drain tenant ${t.id}: ${e?.message || e}`); }
      }
    } finally {
      this.running = false;
    }
  }

  private async drainTenant(tenantId: string): Promise<void> {
    // Reaper: jobs 'running' con lock vencido (crash/redeploy a mitad del handler)
    // vuelven a 'pending'. attempts ya fue incrementado en el claim, así que un job
    // que muere repetidamente terminará igual en la DLQ.
    await this.tk.run(tenantId, async (trx) => {
      await trx('fiscal.jobs')
        .where({ status: 'running' })
        .andWhere('locked_at', '<', new Date(Date.now() - this.RUNNING_TIMEOUT_MS).toISOString())
        .update({ status: 'pending', locked_at: null, updated_at: trx.fn.now() });
    });

    // Reclamar en su propia trx (libera locks rápido); procesar fuera.
    const claimed = await this.tk.run(tenantId, async (trx) => {
      const r = await trx.raw(
        `WITH claimed AS (
           SELECT id FROM fiscal.jobs
            WHERE status = 'pending' AND run_after <= now()
            ORDER BY run_after LIMIT ?
            FOR UPDATE SKIP LOCKED
         )
         UPDATE fiscal.jobs j SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
           FROM claimed WHERE j.id = claimed.id
         RETURNING j.*`,
        [this.BATCH],
      );
      return (r.rows ?? []) as FiscalJob[];
    });

    for (const job of claimed) {
      const handler = this.handlers.get(job.type);
      if (!handler) { await this.fail(tenantId, job, `Sin handler para type='${job.type}'`, true); continue; }
      try {
        const payload = typeof (job as any).payload === 'string' ? JSON.parse((job as any).payload) : job.payload;
        const result = await handler({ ...job, payload });
        await this.complete(tenantId, job, result ?? null);
      } catch (e: any) {
        const permanent = e instanceof FiscalPermanentError;
        await this.fail(tenantId, job, e?.message || String(e), permanent);
      }
    }
  }

  private complete(tenantId: string, job: FiscalJob, result: unknown): Promise<void> {
    return this.tk.run(tenantId, async (trx) => {
      await trx('fiscal.jobs').where({ tenant_id: tenantId, id: job.id })
        .update({ status: 'done', result: JSON.stringify(result), last_error: null, locked_at: null, updated_at: trx.fn.now() });
    });
  }

  private async fail(tenantId: string, job: FiscalJob, error: string, permanent: boolean): Promise<void> {
    // attempts ya fue incrementado en el claim.
    const dead = permanent || job.attempts >= job.max_attempts;
    const base = Math.min(2 ** job.attempts * 30_000, 20 * 60_000); // exp cap 20min
    const delay = Math.floor(base / 2 + Math.random() * (base / 2));  // full jitter
    await this.tk.run(tenantId, async (trx) => {
      await trx('fiscal.jobs').where({ tenant_id: tenantId, id: job.id }).update({
        status: dead ? 'dead' : 'pending',
        run_after: dead ? trx.fn.now() : new Date(Date.now() + delay).toISOString(),
        last_error: error.slice(0, 2000), locked_at: null, updated_at: trx.fn.now(),
      });
    });
    // Los 'dead' quedan como DLQ consultable/re-encolable manualmente. Además, notificar
    // al orquestador para que reconcilie el agregado (ya estamos en el scope de tenant).
    if (dead) {
      const dh = this.deadHandlers.get(job.type);
      if (dh) {
        try {
          const payload = typeof (job as any).payload === 'string' ? JSON.parse((job as any).payload) : job.payload;
          await dh({ ...job, payload, last_error: error } as FiscalJob & { last_error: string });
        } catch (e: any) {
          this.logger.warn(`onDead('${job.type}') falló: ${e?.message || e}`);
        }
      }
    }
  }
}
