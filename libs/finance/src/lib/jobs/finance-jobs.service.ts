import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TenantContextService } from '@megadulces/platform-core';
import { BancosGateway } from '../bank/bancos.gateway';

/** Estado de un trabajo largo de Finanzas. */
export type FinanceJobStatus = 'running' | 'done' | 'error';

export interface FinanceJobRecord {
  id: string;
  /** Identificador estable de la operación (p.ej. `bank-import`). */
  name: string;
  /** Texto corto para la UI ("Import 2026-01"). */
  label: string;
  tenant_id: string | null;
  actor: string | null;
  status: FinanceJobStatus;
  started_at: string;
  finished_at: string | null;
  /** Lo que devolvió la operación (mismo shape que devolvía el endpoint síncrono). */
  result: unknown;
  error: string | null;
}

/** Respuesta 202 de un endpoint que delegó el trabajo. */
export interface FinanceJobAccepted {
  job_id: string;
  queued: true;
  name: string;
  label: string;
  started_at: string;
}

/**
 * Evento WS `finance_job` (namespace `/bancos` = canal WS de Finanzas).
 * `type` y no `interface`: así TS le da index signature implícita y encaja en el
 * `Record<string, unknown>` que expone el gateway (que no depende de este módulo).
 */
export type FinanceJobEvent = {
  job_id: string;
  name: string;
  label: string;
  status: FinanceJobStatus;
  actor: string | null;
  result: unknown;
  error: string | null;
  /** ms que tardó (solo en done/error). */
  took_ms: number | null;
  emitted_at: string;
};

/** Cuántos trabajos recientes se conservan en memoria (por proceso). */
const KEEP = 50;

/**
 * COMM-P0 — Trabajos largos de Finanzas fuera del request.
 *
 * PROBLEMA que resuelve: `location /api/` de nginx no define `proxy_read_timeout`
 * → rige el default de **60 s**. El import del workbook (hasta 25 mb / ~6.5k movs),
 * la conciliación, el reclasificado y los motores de Maat corrían **síncronos**:
 * al pasarse de 60 s el navegador recibía **504** mientras el backend seguía
 * trabajando, y el usuario no sabía si la operación había quedado aplicada.
 *
 * CONTRATO: el endpoint responde **202** con `{ job_id }` y el trabajo sigue en
 * background; al terminar se emite `finance_job` por WS (status `done` | `error`)
 * y la pantalla se refresca. `?sync=true` conserva el camino inline para CLI,
 * smokes y cualquier consumidor que necesite el resultado en la misma respuesta.
 *
 * POR QUÉ AÚN NO ES `pg-boss` (ADR-043): (1) `QueueService.work()` solo consume
 * cuando el proceso corre con `WORKER=true`, y el worker-tier todavía no está
 * desplegado (`ENABLE_WORKER_QUEUE` apagado) → un job encolado hoy no correría
 * nunca; (2) el payload del import es base64 de hasta 25 mb, que no va en una fila
 * de cola (necesita antes subir el archivo a S3/Cloudinary y pasar la llave).
 * Por eso el trabajo corre **detached in-process**: mismo consumo de RAM que hoy,
 * sin el 504. Cuando el worker exista, cambia SOLO este servicio (y hace falta
 * `REDIS_URL` para que el `emit` del worker llegue a los sockets del API).
 *
 * El contexto de tenant (AsyncLocalStorage) sobrevive al detach porque la promesa
 * se crea dentro del scope del request; el `tenant_id` se captura igual de forma
 * explícita para el evento WS.
 */
@Injectable()
export class FinanceJobsService {
  private readonly logger = new Logger(FinanceJobsService.name);
  private readonly jobs = new Map<string, FinanceJobRecord>();

  constructor(
    private readonly tenantCtx: TenantContextService,
    @Optional() private readonly bancos?: BancosGateway,
  ) {}

  /**
   * Arranca `exec` en background y devuelve el acuse 202. Nunca lanza: si `exec`
   * falla, el error queda en el registro y sale por WS como `status: 'error'`.
   */
  run<T>(opts: {
    name: string;
    label: string;
    actor?: string | null;
    exec: () => Promise<T>;
  }): FinanceJobAccepted {
    const tenantId = this.safeTenantId();
    const rec: FinanceJobRecord = {
      id: randomUUID(),
      name: opts.name,
      label: opts.label,
      tenant_id: tenantId,
      actor: opts.actor ?? null,
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      result: null,
      error: null,
    };
    this.remember(rec);
    this.emit(rec, null);

    const t0 = Date.now();
    // Detached a propósito: el request ya respondió 202. El catch es obligatorio
    // (una promesa colgada sin catch tumba el proceso con unhandledRejection).
    void opts
      .exec()
      .then((result) => {
        rec.status = 'done';
        rec.result = result ?? null;
        rec.finished_at = new Date().toISOString();
        this.logger.log(`${rec.name} ok en ${Date.now() - t0}ms (${rec.label})`);
        this.emit(rec, Date.now() - t0);
      })
      .catch((e: any) => {
        rec.status = 'error';
        rec.error = String(e?.message || e).slice(0, 500);
        rec.finished_at = new Date().toISOString();
        this.logger.error(`${rec.name} falló tras ${Date.now() - t0}ms: ${rec.error}`);
        this.emit(rec, Date.now() - t0);
      });

    return {
      job_id: rec.id,
      queued: true,
      name: rec.name,
      label: rec.label,
      started_at: rec.started_at,
    };
  }

  /** Estado de un trabajo (mismo proceso). Null si ya rotó o no existe. */
  get(id: string): FinanceJobRecord | null {
    const rec = this.jobs.get(id);
    if (!rec) return null;
    const tenantId = this.safeTenantId();
    if (tenantId && rec.tenant_id && rec.tenant_id !== tenantId) return null;
    return rec;
  }

  /** Últimos trabajos del tenant (más reciente primero). */
  recent(limit = 20): FinanceJobRecord[] {
    const tenantId = this.safeTenantId();
    return [...this.jobs.values()]
      .filter((j) => !tenantId || !j.tenant_id || j.tenant_id === tenantId)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
      .slice(0, limit);
  }

  private remember(rec: FinanceJobRecord): void {
    this.jobs.set(rec.id, rec);
    while (this.jobs.size > KEEP) {
      const oldest = this.jobs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.jobs.delete(oldest);
    }
  }

  private emit(rec: FinanceJobRecord, tookMs: number | null): void {
    if (!rec.tenant_id) return;
    const ev: FinanceJobEvent = {
      job_id: rec.id,
      name: rec.name,
      label: rec.label,
      status: rec.status,
      actor: rec.actor,
      result: rec.status === 'done' ? rec.result : null,
      error: rec.error,
      took_ms: tookMs,
      emitted_at: new Date().toISOString(),
    };
    try {
      this.bancos?.emitJob(rec.tenant_id, ev);
    } catch (e: any) {
      this.logger.warn(`WS finance_job (${rec.name}) falló: ${e?.message || e}`);
    }
  }

  /** El tenant del request; null si se llama fuera de un request con contexto. */
  private safeTenantId(): string | null {
    try {
      return this.tenantCtx.requireTenantId();
    } catch {
      return null;
    }
  }
}
