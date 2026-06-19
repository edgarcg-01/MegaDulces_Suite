import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEV_RANK: Record<string, number> = { info: 0, warn: 1, critical: 2 };

type Finding = {
  id: string;
  finding_type: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  label: string | null;
  evidence: any;
};

function parseEvidence(v: any): Record<string, any> {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) || {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Thot (ADR-018) — Track Razonamiento, Sprint T.R1: motor de causa raíz comercial.
 *
 * Análogo al DiagnosisEngine de Horus. Agrupa los commercial_findings abiertos del MISMO
 * sujeto y, cuando ≥2 co-ocurren, concluye UNA causa raíz DOMINANTE (exclusiva: un
 * producto dead+thin es "liquidar", no "redistribuir"). CERO LLM: summary determinista
 * que linkea los síntomas con sus números; confidence = corroboración (la afina T.L2).
 *
 * Causas (producto, dato rico hoy):
 *   - unprofitable_deadweight: low_rotation_priced + margin_laggard → liquidar/delist.
 *   - distribution_misfit    : distribution_gap + low_rotation_priced → reubicar el push.
 *   - low_value_push         : margin_laggard + distribution_gap → revisar precio antes de empujar.
 * (Cliente: difiere hasta tener ≥2 tipos de finding de cliente — hoy solo churn_risk.)
 *
 * Acceso vía TenantKnexService (RLS) + public.current_tenant_id().
 */
@Injectable()
export class CommercialDiagnosisService {
  private readonly logger = new Logger(CommercialDiagnosisService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private symptomPhrase(f: Finding): string {
    const e = parseEvidence(f.evidence);
    const v = (x: any, suf = '') => (x != null ? `${x}${suf}` : '?');
    switch (f.finding_type) {
      case 'low_rotation_priced':
        return `rotación baja (${v(e.sales_units_30d)} u. en 30d)`;
      case 'margin_laggard':
        return `margen ${v(e.margin_pct, '%')}`;
      case 'distribution_gap':
        return `top ${v(e.demand_rank)} en demanda de "${v(e.zona)}" pero ${v(e.pdv_count)} PdVs lo exhiben`;
      case 'churn_risk':
        return `${v(e.recency_days)}d sin pedir (cadencia ${v(e.cadence_days)}d)`;
      default:
        return f.finding_type;
    }
  }

  private maxSeverity(fs: Finding[]): string {
    return fs.reduce((acc, f) => ((SEV_RANK[f.severity] ?? 1) > (SEV_RANK[acc] ?? 1) ? f.severity : acc), 'info');
  }

  private confidence(n: number): number {
    return Math.min(0.92, 0.5 + 0.14 * (n - 1));
  }

  /** Causa raíz dominante de un producto (exclusiva). null si <2 findings compatibles. */
  private diagnoseProduct(
    fs: Finding[],
  ): { rootCause: string; actionHint: string; findings: Finding[]; linkage: string } | null {
    const get = (t: string) => fs.find((f) => f.finding_type === t) || null;
    const rot = get('low_rotation_priced');
    const margin = get('margin_laggard');
    const distrib = get('distribution_gap');

    // Dominante: dead + thin → liquidar (no vale la pena redistribuir algo que no deja).
    if (rot && margin) {
      return {
        rootCause: 'unprofitable_deadweight',
        actionHint: 'delist_or_liquidate',
        findings: [rot, margin, ...(distrib ? [distrib] : [])],
        linkage: `no rota y deja poco margen (${this.symptomPhrase(rot)}; ${this.symptomPhrase(
          margin,
        )}) → candidato a liquidar o sacar del portafolio`,
      };
    }
    if (distrib && rot) {
      return {
        rootCause: 'distribution_misfit',
        actionHint: 'redirect_distribution',
        findings: [distrib, rot],
        linkage: `tiene demanda de zona pero rotación general baja (${this.symptomPhrase(
          distrib,
        )}; ${this.symptomPhrase(rot)}) → reubicar el empuje donde sí se demanda`,
      };
    }
    if (margin && distrib) {
      return {
        rootCause: 'low_value_push',
        actionHint: 'review_price_before_push',
        findings: [margin, distrib],
        linkage: `se empuja distribución de algo de margen flojo (${this.symptomPhrase(
          margin,
        )}; ${this.symptomPhrase(distrib)}) → revisar precio antes de empujar`,
      };
    }
    return null;
  }

  async generateForTenant(): Promise<{ diagnosed: number; resolved: number }> {
    return this.tk.run(async (trx) => {
      const findings: Finding[] = await trx('commercial.commercial_findings')
        .where({ status: 'open' })
        .select('id', 'finding_type', 'severity', 'subject_type', 'subject_id', 'label', 'evidence');

      const bySubject = new Map<string, Finding[]>();
      for (const f of findings) {
        const k = `${f.subject_type}:${f.subject_id}`;
        const arr = bySubject.get(k);
        if (arr) arr.push(f);
        else bySubject.set(k, [f]);
      }

      const rows: any[] = [];
      for (const [, fs] of bySubject) {
        if (fs.length < 2) continue; // síntoma aislado → atómico
        if (fs[0].subject_type !== 'product') continue; // hoy solo productos (cliente difiere)
        const d = this.diagnoseProduct(fs);
        if (!d) continue;
        const label = fs.find((f) => f.label)?.label || null;
        const who = label || 'producto';
        rows.push({
          tenant_id: trx.raw('public.current_tenant_id()'),
          dedup_key: `${d.findings[0].subject_type}:${d.findings[0].subject_id}:${d.rootCause}`,
          root_cause: d.rootCause,
          severity: this.maxSeverity(d.findings),
          subject_type: d.findings[0].subject_type,
          subject_id: d.findings[0].subject_id,
          label: label ? String(label).slice(0, 160) : null,
          finding_ids: JSON.stringify(d.findings.map((f) => f.id)),
          finding_types: JSON.stringify([...new Set(d.findings.map((f) => f.finding_type))]),
          confidence: this.confidence(d.findings.length),
          summary: `${who}: ${d.linkage}.`.slice(0, 2000),
          evidence: JSON.stringify({
            action_hint: d.actionHint,
            corroboration: d.findings.length,
            symptoms: d.findings.map((f) => ({ type: f.finding_type, severity: f.severity, phrase: this.symptomPhrase(f) })),
          }),
          status: 'open',
        });
      }

      const keys = rows.map((r) => r.dedup_key);
      if (rows.length > 0) {
        await trx('commercial.commercial_diagnoses')
          .insert(rows)
          .onConflict(['tenant_id', 'dedup_key'])
          .merge({
            severity: trx.raw('EXCLUDED.severity'),
            label: trx.raw('EXCLUDED.label'),
            finding_ids: trx.raw('EXCLUDED.finding_ids'),
            finding_types: trx.raw('EXCLUDED.finding_types'),
            confidence: trx.raw('EXCLUDED.confidence'),
            summary: trx.raw('EXCLUDED.summary'),
            evidence: trx.raw('EXCLUDED.evidence'),
            status: trx.raw(
              `CASE WHEN commercial.commercial_diagnoses.status IN ('dismissed','confirmed') THEN commercial.commercial_diagnoses.status ELSE 'open' END`,
            ),
            updated_at: trx.fn.now(),
          });
      }

      const resolvedQ = trx('commercial.commercial_diagnoses').whereIn('status', ['open', 'reviewed']);
      if (keys.length) resolvedQ.whereNotIn('dedup_key', keys);
      const resolved = await resolvedQ.update({ status: 'resolved', updated_at: trx.fn.now() });

      return { diagnosed: rows.length, resolved: Number(resolved) || 0 };
    });
  }

  /** Diagnósticos abiertos del tenant (para el co-piloto T.R2 y el panel). */
  async getOpenForTenant(): Promise<any[]> {
    return this.tk.run(async (trx) =>
      trx('commercial.commercial_diagnoses')
        .where({ status: 'open' })
        .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
        .orderBy('confidence', 'desc')
        .select('*'),
    );
  }

  async list(filters: { status?: string } = {}) {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.commercial_diagnoses')
        .where({ status: filters.status || 'open' })
        .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
        .orderBy('confidence', 'desc')
        .limit(100);
      return { rows, total: rows.length };
    });
  }

  async review(id: string, status: string) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    if (!['open', 'reviewed', 'dismissed', 'confirmed'].includes(status)) {
      throw new BadRequestException(`status inválido: ${status}`);
    }
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const [updated] = await trx('commercial.commercial_diagnoses')
        .where({ id })
        .update({
          status,
          reviewed_by: userId && UUID_RE.test(String(userId)) ? userId : null,
          reviewed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning(['id', 'status']);
      if (!updated) throw new NotFoundException('Diagnóstico no encontrado');
      return updated;
    });
  }
}
