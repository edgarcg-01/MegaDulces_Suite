import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

export interface EnqueueInput {
  queue: string;
  type: string;
  payload?: Record<string, unknown>;
  dedupKey?: string;        // idempotencia: re-encolar el mismo no duplica
  runAfterMs?: number;      // delay inicial
  maxAttempts?: number;
}

export interface FiscalJob {
  id: string; tenant_id: string; queue: string; type: string;
  payload: Record<string, unknown>; status: string; attempts: number;
  max_attempts: number; run_after: string; dedup_key: string | null; last_error: string | null;
}

/**
 * FISCAL.3 — Encolado idempotente sobre fiscal.jobs. Tenant-scoped (RLS).
 */
@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Encola (o no-op si dedupKey ya existe). Devuelve el job o el existente. */
  async enqueue(tenantId: string, input: EnqueueInput): Promise<FiscalJob> {
    return this.tk.run(tenantId, async (trx) => {
      const row = {
        tenant_id: tenantId,
        queue: input.queue,
        type: input.type,
        payload: JSON.stringify(input.payload ?? {}),
        dedup_key: input.dedupKey ?? null,
        max_attempts: input.maxAttempts ?? 8,
        run_after: new Date(Date.now() + (input.runAfterMs ?? 0)).toISOString(),
      };
      if (input.dedupKey) {
        // El índice único es PARCIAL (ux_fiscal_jobs_dedup ... WHERE dedup_key IS NOT NULL);
        // Postgres exige repetir el predicado en el ON CONFLICT o lanza 42P10.
        const [job] = await trx('fiscal.jobs').insert(row)
          .onConflict(trx.raw('(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL'))
          .ignore().returning('*');
        if (job) return job as FiscalJob;
        return (await trx('fiscal.jobs').where({ tenant_id: tenantId, dedup_key: input.dedupKey }).first()) as FiscalJob;
      }
      const [job] = await trx('fiscal.jobs').insert(row).returning('*');
      return job as FiscalJob;
    });
  }

  /** Re-encola un job para correr después (delay), reseteando a pending. */
  async requeue(tenantId: string, jobId: string, delayMs: number): Promise<void> {
    await this.tk.run(tenantId, async (trx) => {
      await trx('fiscal.jobs').where({ tenant_id: tenantId, id: jobId })
        .update({ status: 'pending', run_after: new Date(Date.now() + delayMs).toISOString(), locked_at: null, updated_at: trx.fn.now() });
    });
  }
}
