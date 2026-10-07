import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { RFC_GENERICOS, RFC_REGEX } from './sat-lists.config';

export interface RfcValidationResult {
  tenantId: string;
  scanned: number;   // RFCs distintos revisados
  issues: number;    // RFCs con problema
  nuevos: number;
}

/**
 * FISCAL.1 — Validación estructural de los RFC de proveedores del tenant.
 *
 * Recorre los RFCs distintos en analytics.expense_documents y clasifica:
 *   formato_invalido → no cumple la estructura RFC (posible error de captura/fraude)
 *   rfc_generico     → XAXX010101000 / XEXX010101000 (público en general / extranjero)
 *
 * Upsert idempotente a fiscal.rfc_issues (RLS). Motor determinista, sin LLM.
 * No valida existencia ante el SAT (eso requiere LCO/CSF — diferido).
 */
@Injectable()
export class RfcValidationService {
  private readonly logger = new Logger(RfcValidationService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  validateCurrent(): Promise<RfcValidationResult> {
    return this.validateForTenant(this.tenantCtx.requireTenantId());
  }

  async validateForTenant(tenantId: string): Promise<RfcValidationResult> {
    return this.tk.run(tenantId, async (trx) => {
      const rows: Array<{ rfc: string; doc_count: string; importe_total: string; primera: string; ultima: string }> =
        (await trx.raw(
          `SELECT upper(trim(rfc)) AS rfc, count(*) AS doc_count,
                  coalesce(sum(importe),0) AS importe_total, min(fecha) AS primera, max(fecha) AS ultima
             FROM analytics.expense_documents
            WHERE tenant_id = ? AND rfc IS NOT NULL AND btrim(rfc) <> ''
            GROUP BY upper(trim(rfc))`,
          [tenantId],
        )).rows;

      const issues = rows
        .map((r) => ({ ...r, issue: this.classify(r.rfc) }))
        .filter((r) => r.issue);

      let nuevos = 0;
      for (const it of issues) {
        const res = await trx.raw(
          `INSERT INTO fiscal.rfc_issues
             (tenant_id, rfc, issue_type, doc_count, importe_total, primera_fecha, ultima_fecha, updated_at)
           VALUES (?,?,?,?,?,?,?, now())
           ON CONFLICT (tenant_id, rfc, issue_type) DO UPDATE
             SET doc_count=EXCLUDED.doc_count, importe_total=EXCLUDED.importe_total,
                 primera_fecha=EXCLUDED.primera_fecha, ultima_fecha=EXCLUDED.ultima_fecha, updated_at=now()
           RETURNING (xmax = 0) AS es_nuevo`,
          [tenantId, it.rfc, it.issue, Number(it.doc_count), Number(it.importe_total), it.primera, it.ultima],
        );
        if (res.rows?.[0]?.es_nuevo) nuevos++;
      }

      if (issues.length) this.logger.warn(`Tenant ${tenantId}: ${issues.length} RFC con problema (${nuevos} nuevos).`);
      return { tenantId, scanned: rows.length, issues: issues.length, nuevos };
    });
  }

  private classify(rfc: string): string | null {
    if (RFC_GENERICOS.has(rfc)) return 'rfc_generico';
    if (!RFC_REGEX.test(rfc)) return 'formato_invalido';
    return null;
  }
}
