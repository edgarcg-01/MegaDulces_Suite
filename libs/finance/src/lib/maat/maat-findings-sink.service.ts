import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  FinanceFindingsSinkPort,
  FinanceFindingInput,
  FinanceRuleInput,
} from '@megadulces/contracts';

/**
 * MAAT — Impl del port FINANCE_FINDINGS_SINK_PORT (ADR-028).
 *
 * Deja que otros dominios (p.ej. libs/fiscal) empujen hallazgos a la bandeja
 * unificada de Maat (finance.findings) SIN acoplarse a este módulo: consumen el
 * token declarado en contracts; el binding vive en el composition root.
 *
 * Garantías:
 *  - Registra la regla en finance.rule_registry ANTES de insertar (la FK
 *    (tenant_id, rule_key) lo exige), preservando la calibración humana
 *    (enabled/pinned/params/precision/suppressed) igual que MaatDetectorService.
 *  - Respeta el aprendizaje L2: no inserta hallazgos de reglas suprimidas o
 *    deshabilitadas (skipped).
 *  - UPSERT idempotente por dedup_key; NO pisa el status (triage humano).
 *  - Best-effort: nunca lanza hacia el caller.
 */
@Injectable()
export class MaatFindingsSinkService implements FinanceFindingsSinkPort {
  private readonly logger = new Logger(MaatFindingsSinkService.name);

  constructor(private readonly tk: TenantKnexService) {}

  async pushFindings(
    tenantId: string,
    findings: FinanceFindingInput[],
    rules: FinanceRuleInput[] = [],
  ): Promise<{ inserted: number; skipped: number }> {
    if (!findings?.length) return { inserted: 0, skipped: 0 };
    try {
      return await this.tk.run(tenantId, async (trx) => {
        // 1. Registrar reglas (preservando calibración humana).
        for (const r of rules) {
          await trx('finance.rule_registry')
            .insert({
              tenant_id: tenantId,
              rule_key: r.rule_key,
              nombre: r.nombre,
              descripcion: r.descripcion ?? null,
              clase: r.clase,
              params: JSON.stringify(r.params ?? {}),
            })
            .onConflict(['tenant_id', 'rule_key'])
            .merge({ nombre: r.nombre, descripcion: r.descripcion ?? null, clase: r.clase, updated_at: trx.fn.now() });
        }

        // 2. Reglas activas (respeta L2: enabled && !suppressed_auto).
        const active = new Set(
          (await trx('finance.rule_registry')
            .where({ tenant_id: tenantId, enabled: true, suppressed_auto: false })
            .select('rule_key')
          ).map((r: any) => r.rule_key),
        );

        // 3. UPSERT de hallazgos (solo reglas activas). No pisa status.
        let inserted = 0;
        let skipped = 0;
        const touched = new Set<string>();
        for (const f of findings) {
          if (!active.has(f.rule_key)) { skipped++; continue; }
          const res = await trx.raw(
            `INSERT INTO finance.findings
               (tenant_id, rule_key, clase, severity, status, score, titulo, resumen, entity, periodo, importe, evidencia, dedup_key, first_seen, last_seen, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'nuevo', ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, now(), now(), now(), now())
             ON CONFLICT (tenant_id, dedup_key) DO UPDATE
               SET last_seen = now(), importe = EXCLUDED.importe, resumen = EXCLUDED.resumen, titulo = EXCLUDED.titulo,
                   severity = EXCLUDED.severity, evidencia = EXCLUDED.evidencia, score = EXCLUDED.score, updated_at = now()
             RETURNING (xmax = 0) AS is_insert`,
            [tenantId, f.rule_key, f.clase, f.severity, f.score, f.titulo, f.resumen,
              JSON.stringify(f.entity ?? {}), f.periodo, f.importe, JSON.stringify(f.evidencia ?? {}), f.dedup_key],
          );
          if (res.rows?.[0]?.is_insert) inserted++;
          touched.add(f.rule_key);
        }

        // 4. Refrescar findings_total de las reglas tocadas (para la UI de Maat).
        for (const ruleKey of touched) {
          const total = Number(
            (await trx('finance.findings').where({ tenant_id: tenantId, rule_key: ruleKey }).count('* as c').first())?.c || 0,
          );
          await trx('finance.rule_registry').where({ tenant_id: tenantId, rule_key: ruleKey })
            .update({ findings_total: total, updated_at: trx.fn.now() });
        }

        if (inserted || skipped) this.logger.log(`sink: ${inserted} hallazgos nuevos, ${skipped} omitidos (regla suprimida).`);
        return { inserted, skipped };
      });
    } catch (e: any) {
      this.logger.warn(`pushFindings falló (best-effort): ${e?.message || e}`);
      return { inserted: 0, skipped: findings.length };
    }
  }
}
