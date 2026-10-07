import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { PacError } from './pac-error';

export type EmissionErrorKind = 'timbrado' | 'nota_credito' | 'rep' | 'cancelacion';

export interface EmissionErrorCtx {
  kind: EmissionErrorKind;
  dedup_key: string;
  order_id?: string | null;
  cfdi_uuid?: string | null;
  receptor_rfc?: string | null;
  receptor_nombre?: string | null;
  serie?: string | null;
  folio?: string | null;
  total?: number | null;
  num_parcialidad?: number | null;
}

/**
 * FD.0 — Captura de errores de emisión. Persiste en fiscal.emission_errors cada
 * fallo del PAC (timbrado/NC/REP/cancelación) como hallazgo idempotente por
 * (tenant, dedup_key), y lo resuelve solo cuando un intento posterior tiene éxito.
 *
 * Todo es best-effort: NUNCA lanza (un fallo al registrar el error no debe romper
 * el flujo). Usa la sobrecarga explícita de tenantId de TenantKnexService.run para
 * ser robusto también fuera del contexto de request (auto-timbrado fire-and-forget).
 */
@Injectable()
export class EmissionErrorsService {
  private readonly logger = new Logger(EmissionErrorsService.name);

  constructor(private readonly tk: TenantKnexService) {}

  async record(tenantId: string, ctx: EmissionErrorCtx, err: unknown): Promise<void> {
    try {
      const pe = err instanceof PacError ? err : null;
      const httpStatus = pe?.httpStatus ?? null;
      const provider = pe ? 'sw' : null;
      const code = pe?.pacCode ?? null;
      const message = String(pe?.pacMessage ?? (err as any)?.message ?? err ?? 'error').slice(0, 1000);
      const detail = pe?.pacMessageDetail ? String(pe.pacMessageDetail).slice(0, 2000) : null;
      const raw = pe?.pacRaw != null ? JSON.stringify(pe.pacRaw).slice(0, 20000) : null;

      await this.tk.run(tenantId, (trx) =>
        trx.raw(
          `INSERT INTO fiscal.emission_errors
             (tenant_id, kind, dedup_key, status, order_id, cfdi_uuid, receptor_rfc, receptor_nombre,
              serie, folio, total, num_parcialidad, http_status, pac_provider, pac_code, error_message, error_detail, pac_raw)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
           ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET
             status='open', resolved_at=NULL,
             order_id=COALESCE(EXCLUDED.order_id, fiscal.emission_errors.order_id),
             cfdi_uuid=COALESCE(EXCLUDED.cfdi_uuid, fiscal.emission_errors.cfdi_uuid),
             receptor_rfc=COALESCE(EXCLUDED.receptor_rfc, fiscal.emission_errors.receptor_rfc),
             receptor_nombre=COALESCE(EXCLUDED.receptor_nombre, fiscal.emission_errors.receptor_nombre),
             serie=COALESCE(EXCLUDED.serie, fiscal.emission_errors.serie),
             folio=COALESCE(EXCLUDED.folio, fiscal.emission_errors.folio),
             total=EXCLUDED.total,
             num_parcialidad=COALESCE(EXCLUDED.num_parcialidad, fiscal.emission_errors.num_parcialidad),
             http_status=EXCLUDED.http_status, pac_provider=EXCLUDED.pac_provider, pac_code=EXCLUDED.pac_code,
             error_message=EXCLUDED.error_message, error_detail=EXCLUDED.error_detail, pac_raw=EXCLUDED.pac_raw,
             attempts=fiscal.emission_errors.attempts + 1, last_seen_at=now(), updated_at=now()`,
          [
            tenantId, ctx.kind, ctx.dedup_key, ctx.order_id ?? null, ctx.cfdi_uuid ?? null,
            ctx.receptor_rfc ?? null, ctx.receptor_nombre ?? null, ctx.serie ?? null, ctx.folio ?? null,
            ctx.total ?? null, ctx.num_parcialidad ?? null, httpStatus, provider, code, message, detail, raw,
          ],
        ),
      );
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar el error de emisión (${ctx.dedup_key}): ${e?.message || e}`);
    }
  }

  /** Marca resuelto el hallazgo (best-effort) cuando un intento posterior tiene éxito. */
  async resolve(tenantId: string, dedupKey: string): Promise<void> {
    try {
      await this.tk.run(tenantId, (trx) =>
        trx('fiscal.emission_errors')
          .where({ dedup_key: dedupKey, status: 'open' })
          .update({ status: 'resolved', resolved_at: trx.fn.now(), updated_at: trx.fn.now() }),
      );
    } catch (e: any) {
      this.logger.warn(`No se pudo resolver el error de emisión (${dedupKey}): ${e?.message || e}`);
    }
  }
}
