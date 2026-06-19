import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { PushDirectivesService } from './push-directives.service';
import { CommercialCalibrationService } from './commercial-calibration.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEV_WEIGHT: Record<string, number> = { info: 1, warn: 2, critical: 3 };
const MARGIN_TARGET_PCT = 15; // objetivo de margen al estimar el uplift de review_price
const num = (v: any, d = 0) => (v != null && !isNaN(Number(v)) ? Number(v) : d);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

// finding atómico → acción del co-piloto.
const ACTION_FOR: Record<string, string> = {
  distribution_gap: 'push_product',
  low_rotation_priced: 'review_delist',
  margin_laggard: 'review_price',
  churn_risk: 'reorder_outreach',
};
// causa raíz (T.R1) → acción coherente (reemplaza las sueltas, N→1).
const DIAGNOSIS_ACTION: Record<string, string> = {
  unprofitable_deadweight: 'review_delist',
  distribution_misfit: 'push_product',
  low_value_push: 'review_price',
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
function parseArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Thot (ADR-018) — Track Razonamiento, Sprint T.R2: co-piloto comercial.
 *
 * Análogo a SupervisorActionsService de Horus. Consume los diagnósticos (T.R1) y los
 * findings atómicos → propone acciones con confianza + impacto en $ + prioridad. N→1:
 * un diagnóstico reemplaza las acciones sueltas de sus síntomas. El humano aprueba/
 * rechaza; al aprobar, ejecutor INTERNO reversible (push_product → push_directive real).
 *
 * RLS real (TenantKnexService). El cómputo del impacto es determinista desde la evidencia
 * de los findings (uplift de margen = brecha × precio × unidades); null donde no se puede.
 */
@Injectable()
export class CommercialActionsService {
  private readonly logger = new Logger(CommercialActionsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly directives: PushDirectivesService,
    private readonly calibration: CommercialCalibrationService,
  ) {}

  private titleForFinding(f: any): string {
    const e = parseEvidence(f.evidence);
    const who = f.label || 'producto';
    switch (f.finding_type) {
      case 'distribution_gap':
        return `Empujar "${who}": top ${e.demand_rank ?? '?'} en ${e.zona || 'la zona'} pero ${num(e.pdv_count)} PdVs lo exhiben`;
      case 'low_rotation_priced':
        return `Revisar "${who}": rotación baja (${num(e.sales_units_30d)} u./30d), candidato a liquidar`;
      case 'margin_laggard':
        return `Revisar precio de "${who}": margen ${num(e.margin_pct)}%`;
      case 'churn_risk':
        return `Recontactar a ${who}: ${num(e.recency_days)}d sin pedir`;
      default:
        return `Acción sobre ${who}`;
    }
  }

  private titleForDiagnosis(d: any): string {
    const who = d.label || 'producto';
    switch (d.root_cause) {
      case 'unprofitable_deadweight':
        return `Liquidar/sacar "${who}": no rota y deja poco margen`;
      case 'distribution_misfit':
        return `Reubicar el empuje de "${who}" donde se demanda`;
      case 'low_value_push':
        return `Revisar precio de "${who}" antes de empujar distribución`;
      default:
        return `Acción sobre ${who}`;
    }
  }

  /** Impacto $ desde la evidencia de un finding atómico (per-unidad para margen). */
  private impactForFinding(f: any): { kind: string; value: number; basis: string } | null {
    if (f.finding_type !== 'margin_laggard') return null;
    const e = parseEvidence(f.evidence);
    const price = num(e.price);
    const marginPct = num(e.margin_pct);
    if (price <= 0) return null;
    const uplift = ((MARGIN_TARGET_PCT - marginPct) / 100) * price;
    if (uplift <= 0) return null;
    return { kind: 'per_unit_margin_uplift_mxn', value: Math.round(uplift * 100) / 100, basis: 'evidence' };
  }

  /** Impacto $ de un diagnóstico desde sus findings bundleados (uplift mensual de margen). */
  private impactForDiagnosis(d: any, byId: Map<string, any>): { kind: string; value: number; basis: string } | null {
    if (d.root_cause !== 'unprofitable_deadweight') return null;
    const fids = parseArray(d.finding_ids);
    let price = 0;
    let marginPct = 0;
    let units = 0;
    let hasMargin = false;
    let hasUnits = false;
    for (const id of fids) {
      const f = byId.get(id);
      if (!f) continue;
      const e = parseEvidence(f.evidence);
      if (f.finding_type === 'margin_laggard') {
        price = num(e.price);
        marginPct = num(e.margin_pct);
        hasMargin = true;
      }
      if (f.finding_type === 'low_rotation_priced') {
        units = num(e.sales_units_30d);
        hasUnits = true;
      }
    }
    if (!hasMargin || price <= 0) return null;
    const perUnit = ((MARGIN_TARGET_PCT - marginPct) / 100) * price;
    if (perUnit <= 0) return null;
    // dead-stock: unidades ~0 → el impacto real es liberar capital, no margen mensual.
    const monthly = hasUnits ? perUnit * units : 0;
    return {
      kind: monthly > 0 ? 'monthly_margin_uplift_mxn' : 'per_unit_margin_uplift_mxn',
      value: Math.round((monthly > 0 ? monthly : perUnit) * 100) / 100,
      basis: 'evidence',
    };
  }

  private priorityOf(severity: string, confidence: number, impact: any): number {
    return round3((SEV_WEIGHT[severity] ?? 2) * confidence * (impact ? 1.3 : 1));
  }

  async proposeForTenant(): Promise<{ proposed: number; expired: number }> {
    // T.L2: confianza por finding_type aprendida (precisión); cold-start 0.6. Run previo
    // (no anidar tk.run).
    const confMap = await this.calibration.getConfidence();
    return this.tk.run(async (trx) => {
      const diagnoses = await trx('commercial.commercial_diagnoses')
        .where({ status: 'open' })
        .select('id', 'root_cause', 'severity', 'subject_type', 'subject_id', 'label', 'confidence', 'summary', 'finding_ids', 'finding_types');
      const findings = await trx('commercial.commercial_findings')
        .where({ status: 'open' })
        .select('id', 'finding_type', 'severity', 'subject_type', 'subject_id', 'label', 'evidence');
      const byId = new Map<string, any>(findings.map((f: any) => [f.id, f]));

      const actions: any[] = [];
      const claimed = new Set<string>();

      // 1) Acción por diagnóstico (N→1).
      for (const d of diagnoses) {
        parseArray(d.finding_ids).forEach((id: any) => typeof id === 'string' && claimed.add(id));
        const actionType = DIAGNOSIS_ACTION[d.root_cause];
        if (!actionType) continue;
        // Confianza = corroboración del diagnóstico × precisión aprendida de sus reglas (T.L2).
        const types = parseArray(d.finding_types);
        const l2vals = types.length ? types.map((t: string) => confMap.get(t) ?? 0.6) : [0.6];
        const l2avg = l2vals.reduce((a, b) => a + b, 0) / l2vals.length;
        const conf = round3(((d.confidence != null ? Number(d.confidence) : 0.6) + l2avg) / 2);
        const impact = this.impactForDiagnosis(d, byId);
        actions.push({
          tenant_id: trx.raw('public.current_tenant_id()'),
          finding_id: null,
          diagnosis_id: d.id,
          dedup_key: `diag:${d.subject_type}:${d.subject_id}:${d.root_cause}`,
          kind: 'diagnosis',
          action_type: actionType,
          subject_type: d.subject_type,
          subject_id: d.subject_id,
          label: d.label ? String(d.label).slice(0, 160) : null,
          title: this.titleForDiagnosis(d).slice(0, 300),
          rationale: d.summary ? String(d.summary).slice(0, 2000) : null,
          payload: JSON.stringify({ root_cause: d.root_cause }),
          confidence: round3(conf),
          expected_impact: impact ? JSON.stringify(impact) : null,
          priority: this.priorityOf(d.severity, conf, impact),
          root_cause: d.root_cause,
          proposed_by: 'thot',
          status: 'pending_approval',
        });
      }

      // 2) Acción atómica por finding no bundleado.
      for (const f of findings) {
        if (claimed.has(f.id)) continue;
        const actionType = ACTION_FOR[f.finding_type];
        if (!actionType) continue;
        const conf = confMap.get(f.finding_type) ?? 0.6; // T.L2: precisión aprendida
        const impact = this.impactForFinding(f);
        actions.push({
          tenant_id: trx.raw('public.current_tenant_id()'),
          finding_id: f.id,
          diagnosis_id: null,
          dedup_key: `${actionType}:${f.subject_type}:${f.subject_id}:${f.finding_type}`,
          kind: 'finding',
          action_type: actionType,
          subject_type: f.subject_type,
          subject_id: f.subject_id,
          label: f.label ? String(f.label).slice(0, 160) : null,
          title: this.titleForFinding(f).slice(0, 300),
          rationale: null,
          payload: JSON.stringify({ finding_type: f.finding_type }),
          confidence: round3(conf),
          expected_impact: impact ? JSON.stringify(impact) : null,
          priority: this.priorityOf(f.severity, conf, impact),
          root_cause: null,
          proposed_by: 'thot',
          status: 'pending_approval',
        });
      }

      const keys = actions.map((a) => a.dedup_key);
      if (actions.length > 0) {
        await trx('commercial.commercial_actions')
          .insert(actions)
          .onConflict(['tenant_id', 'dedup_key'])
          .merge({
            finding_id: trx.raw('EXCLUDED.finding_id'),
            diagnosis_id: trx.raw('EXCLUDED.diagnosis_id'),
            label: trx.raw('EXCLUDED.label'),
            title: trx.raw('EXCLUDED.title'),
            rationale: trx.raw('EXCLUDED.rationale'),
            payload: trx.raw('EXCLUDED.payload'),
            confidence: trx.raw('EXCLUDED.confidence'),
            expected_impact: trx.raw('EXCLUDED.expected_impact'),
            priority: trx.raw('EXCLUDED.priority'),
            root_cause: trx.raw('EXCLUDED.root_cause'),
            status: trx.raw(
              `CASE WHEN commercial.commercial_actions.status IN ('approved','rejected','executed') THEN commercial.commercial_actions.status ELSE 'pending_approval' END`,
            ),
            updated_at: trx.fn.now(),
          });
      }

      const expiredQ = trx('commercial.commercial_actions').where({ status: 'pending_approval' });
      if (keys.length) expiredQ.whereNotIn('dedup_key', keys);
      const expired = await expiredQ.update({ status: 'expired', updated_at: trx.fn.now() });

      return { proposed: actions.length, expired: Number(expired) || 0 };
    });
  }

  async listActions(filters: { status?: string; kind?: string } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.commercial_actions').select('*');
      q = q.where('status', filters.status || 'pending_approval');
      if (filters.kind) q = q.where('kind', filters.kind);
      q = q.orderByRaw('priority DESC NULLS LAST').orderBy('created_at', 'desc').limit(200);
      const rows = await q;
      return { rows, total: rows.length };
    });
  }

  /** Co-piloto: aprueba → ejecutor interno reversible + confirma el origen. */
  async approveAction(id: string) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const userId = this.tenantCtx.get()?.userId || null;
    const approvedBy = userId && UUID_RE.test(String(userId)) ? userId : null;

    // Lee la acción (RLS) y valida estado en su propia trx.
    const action = await this.tk.run(async (trx) => trx('commercial.commercial_actions').where({ id }).first());
    if (!action) throw new NotFoundException('Acción no encontrada');
    if (action.status !== 'pending_approval') throw new BadRequestException(`La acción ya está ${action.status}`);

    const result = await this.executeAction(action);

    return this.tk.run(async (trx) => {
      // Confirma el finding/diagnóstico de origen (el humano lo validó y accionó).
      if (action.diagnosis_id) {
        await trx('commercial.commercial_diagnoses')
          .where({ id: action.diagnosis_id })
          .whereIn('status', ['open', 'reviewed'])
          .update({ status: 'confirmed', reviewed_by: approvedBy, reviewed_at: trx.fn.now(), updated_at: trx.fn.now() });
      } else if (action.finding_id) {
        await trx('commercial.commercial_findings')
          .where({ id: action.finding_id })
          .whereIn('status', ['open', 'reviewed'])
          .update({ status: 'confirmed', reviewed_by: approvedBy, reviewed_at: trx.fn.now(), updated_at: trx.fn.now() });
      }
      const [updated] = await trx('commercial.commercial_actions')
        .where({ id })
        .update({
          status: 'executed',
          approved_by: approvedBy,
          approved_at: trx.fn.now(),
          executed_at: trx.fn.now(),
          result: JSON.stringify(result),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return updated;
    });
  }

  async rejectAction(id: string) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const userId = this.tenantCtx.get()?.userId || null;
    const approvedBy = userId && UUID_RE.test(String(userId)) ? userId : null;
    return this.tk.run(async (trx) => {
      const action = await trx('commercial.commercial_actions').where({ id }).first();
      if (!action) throw new NotFoundException('Acción no encontrada');
      if (action.status !== 'pending_approval') throw new BadRequestException(`La acción ya está ${action.status}`);
      const [updated] = await trx('commercial.commercial_actions')
        .where({ id })
        .update({ status: 'rejected', approved_by: approvedBy, approved_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning('*');
      return updated;
    });
  }

  /**
   * Ejecutor real del co-piloto. push_product → crea un push_directive (Thot lo consume →
   * lazo cerrado), reversible vía remove(). El resto = nota interna; el cambio sensible
   * (delist de catálogo, cambio de precio, WhatsApp) queda DIFERIDO (ADR-020).
   */
  private async executeAction(action: any): Promise<Record<string, any>> {
    if (action.action_type === 'push_product' && action.subject_type === 'product' && UUID_RE.test(action.subject_id)) {
      try {
        const dir = await this.directives.create({
          directive_type: 'manual_product',
          target_id: action.subject_id,
          reason: `Thot: ${String(action.root_cause || 'distribución')}`.slice(0, 80),
          boost: 0.7,
        });
        return { effect: 'push_directive', directive_id: dir.id, reversible: true, note: 'Directriz de empuje creada (Thot la usa en la próxima recomendación).' };
      } catch (e: any) {
        this.logger.warn(`push_directive falló (${e.message}); nota interna`);
        return { effect: 'internal', reversible: true, external_delivery: 'deferred', note: `No se pudo crear la directriz: ${e.message}` };
      }
    }
    const note =
      action.action_type === 'review_delist'
        ? 'Marcado para revisión de delist/liquidación (cambio de catálogo diferido).'
        : action.action_type === 'review_price'
          ? 'Marcado para revisión de precio (cambio de precio diferido).'
          : action.action_type === 'reorder_outreach'
            ? 'Marcado para recontacto de reorden (WhatsApp diferido).'
            : 'Acción registrada.';
    return { effect: 'internal', reversible: true, external_delivery: 'deferred', note };
  }
}
