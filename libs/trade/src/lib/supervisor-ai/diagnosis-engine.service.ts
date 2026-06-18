import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Track Razonamiento (Horus.R), Sprint R1: motor de causa raíz.
 *
 * El FindingsEngine emite SÍNTOMAS sueltos (1 row por problema). Este motor
 * RAZONA encima: agrupa los findings abiertos del MISMO sujeto y, cuando ≥2
 * co-ocurren de forma compatible, concluye UNA causa raíz coherente. En vez de
 * "score bajo" + "anaquel flojo" como hallazgos sueltos, diagnostica "la baja de
 * score se explica por ejecución floja" → una sola acción del co-piloto (R2).
 *
 * CERO LLM: el motor decide con reglas explicables; summary = redacción
 * determinista que linkea los síntomas con sus NÚMEROS reales (de evidence).
 * confidence = corroboración (cuántas señales independientes coinciden); la
 * afina la calibración L2 en R2. Invariante: el motor razona, el agente comunica,
 * nada laboral se dispara solo (ADR-016/020/021).
 *
 * Invariante de diseño: un diagnóstico SIEMPRE linkea ≥2 findings. Un síntoma
 * aislado queda atómico (lo acciona el co-piloto 1:1) — el valor de R1 es la
 * correlación, no duplicar lo atómico.
 *
 * Lee vía KNEX_CONNECTION (superuser) + tenant_id explícito, igual que el resto
 * de Horus. UPSERT idempotente por (tenant_id, dedup_key); respeta decisiones
 * humanas (dismissed/confirmed). Los 'open' que ya no aplican pasan a 'resolved'.
 */
const SEV_RANK: Record<string, number> = { info: 0, warn: 1, critical: 2 };
const SCORE_TYPES = ['low_score', 'score_drop', 'self_anomaly'];
const QUALITY_TYPES = ['weak_position', 'weak_concept'];

type Finding = {
  id: string;
  finding_type: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  label: string | null;
  evidence: any;
};

type DiagDraft = {
  rootCause: string;
  actionHint: string;
  findings: Finding[];
  linkage: string;
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

@Injectable()
export class DiagnosisEngineService {
  private readonly logger = new Logger(DiagnosisEngineService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /** Frase determinista por síntoma, citando los números reales de evidence. */
  private symptomPhrase(f: Finding): string {
    const e = parseEvidence(f.evidence);
    const v = (x: any, suf = '') => (x != null ? `${x}${suf}` : '?');
    switch (f.finding_type) {
      case 'low_score':
        return `score ${v(e.avg_score, '%')} (mínimo ${v(e.threshold, '%')})`;
      case 'score_drop':
        return `score cayó ${v(Math.abs(Number(e.score_trend ?? 0)))} pts en 7d`;
      case 'self_anomaly':
        return `bajó a ${v(e.current, '%')} vs su normal ${v(e.baseline_mean, '%')} (z ${v(e.z)})`;
      case 'weak_position':
        return `posición floja (calidad ${v(e.position_quality)}/100, anaquel/detrás)`;
      case 'weak_concept':
        return `concepto "${v(e.concept)}" en ${v(e.concept_level)} vs ${v(e.overall_level)} general`;
      case 'idle_anomaly':
        return `${v(e.idle_min_avg)} min de tiempo muerto entre visitas`;
      case 'competitor_dominance':
        return `competencia ${v(e.competitor_share_pct, '%')} del exhibidor`;
      case 'store_at_risk':
        return `${v(e.days_since_last_visit)} días sin visita`;
      case 'planogram_gap':
        return `solo ${v(e.planogram_present)} SKUs del planograma (mediana de pares ${v(e.peer_median)})`;
      default:
        return f.finding_type;
    }
  }

  private maxSeverity(fs: Finding[]): string {
    return fs.reduce(
      (acc, f) => ((SEV_RANK[f.severity] ?? 1) > (SEV_RANK[acc] ?? 1) ? f.severity : acc),
      'info',
    );
  }

  /** Corroboración: más señales independientes coincidentes → más confianza. R2 la multiplica por la precisión L2. */
  private confidence(n: number): number {
    return Math.min(0.92, 0.5 + 0.14 * (n - 1));
  }

  /** Aplica las reglas de causa raíz a los findings de UN sujeto. 0..N diagnósticos. */
  private diagnoseSubject(fs: Finding[]): DiagDraft[] {
    const subjectType = fs[0].subject_type;
    const pick = (...types: string[]) => fs.filter((f) => types.includes(f.finding_type));
    const get = (type: string) => fs.find((f) => f.finding_type === type) || null;
    const out: DiagDraft[] = [];

    if (subjectType === 'collaborator') {
      const score = pick(...SCORE_TYPES);
      const quality = pick(...QUALITY_TYPES);
      const idle = get('idle_anomaly');

      // A — la baja de score se EXPLICA por una debilidad de ejecución concreta.
      if (score.length >= 1 && quality.length >= 1) {
        out.push({
          rootCause: 'execution_quality_decline',
          actionHint: 'coaching_focus',
          findings: [...score, ...quality],
          linkage: `la baja de score se explica por ejecución floja (${quality
            .map((f) => this.symptomPhrase(f))
            .join('; ')})`,
        });
      }

      // B — el tiempo muerto está golpeando el desempeño.
      if (idle && score.length >= 1) {
        out.push({
          rootCause: 'time_management_impact',
          actionHint: 'reprioritize_route',
          findings: [idle, ...score],
          linkage: `${this.symptomPhrase(idle)} y eso golpea el desempeño; revisar planificación de ruta`,
        });
      }

      // C — caída sostenida SIN causa de ejecución localizada → acompañamiento general.
      if (score.length >= 2 && quality.length === 0) {
        out.push({
          rootCause: 'sustained_decline',
          actionHint: 'coaching',
          findings: score,
          linkage: `caída sostenida sin causa de ejecución localizada; acompañamiento en ruta`,
        });
      }
    }

    if (subjectType === 'store') {
      const comp = get('competitor_dominance');
      const secondary = [get('store_at_risk'), get('planogram_gap')].filter(Boolean) as Finding[];
      // D — tienda en riesgo COMPUESTO: competencia gana espacio + falta atención/SKUs.
      if (comp && secondary.length >= 1) {
        out.push({
          rootCause: 'store_at_risk_compound',
          actionHint: 'recover_shelf',
          findings: [comp, ...secondary],
          linkage: `tienda en riesgo compuesto: ${this.symptomPhrase(comp)}, sumado a ${secondary
            .map((f) => this.symptomPhrase(f))
            .join(' y ')}; visita de recuperación`,
        });
      }
    }

    if (subjectType === 'zone' || subjectType === 'supervisor') {
      const low = get('low_score');
      const drop = get('score_drop');
      // E — el equipo/zona arrastra el promedio de forma sostenida → escalar.
      if (low && drop) {
        const who = subjectType === 'zone' ? 'la zona' : 'el equipo';
        out.push({
          rootCause: 'team_sustained_decline',
          actionHint: 'escalate',
          findings: [low, drop],
          linkage: `${who} arrastra el promedio de forma sostenida; revisar con el responsable`,
        });
      }
    }

    return out;
  }

  /** Genera/actualiza los diagnósticos de UN tenant desde los findings abiertos. */
  async generateForTenant(tenantId: string): Promise<{ diagnosed: number; resolved: number }> {
    if (!tenantId) return { diagnosed: 0, resolved: 0 };

    const findings: Finding[] = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, status: 'open' })
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
      if (fs.length < 2) continue; // un síntoma aislado es atómico (lo acciona el co-piloto 1:1)
      for (const d of this.diagnoseSubject(fs)) {
        const label = fs.find((f) => f.label)?.label || null;
        const sev = this.maxSeverity(d.findings);
        const who = label || d.findings[0].subject_type;
        rows.push({
          tenant_id: tenantId,
          dedup_key: `${d.findings[0].subject_type}:${d.findings[0].subject_id}:${d.rootCause}`,
          root_cause: d.rootCause,
          severity: sev,
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
            symptoms: d.findings.map((f) => ({
              type: f.finding_type,
              severity: f.severity,
              phrase: this.symptomPhrase(f),
            })),
          }),
          status: 'open',
        });
      }
    }

    const keys = rows.map((r) => r.dedup_key);

    if (rows.length > 0) {
      await this.knex('commercial.supervisor_diagnoses')
        .insert(rows)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          severity: this.knex.raw('EXCLUDED.severity'),
          label: this.knex.raw('EXCLUDED.label'),
          finding_ids: this.knex.raw('EXCLUDED.finding_ids'),
          finding_types: this.knex.raw('EXCLUDED.finding_types'),
          confidence: this.knex.raw('EXCLUDED.confidence'),
          summary: this.knex.raw('EXCLUDED.summary'),
          evidence: this.knex.raw('EXCLUDED.evidence'),
          // Respeta decisiones humanas; reabre lo demás.
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_diagnoses.status IN ('dismissed','confirmed') THEN commercial.supervisor_diagnoses.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    const resolved = await this.knex('commercial.supervisor_diagnoses')
      .where({ tenant_id: tenantId })
      .whereIn('status', ['open', 'reviewed'])
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    return { diagnosed: rows.length, resolved: Number(resolved) || 0 };
  }

  /** Diagnósticos abiertos de un tenant (para el co-piloto en R2 y el panel). */
  async getOpenForTenant(tenantId: string): Promise<any[]> {
    if (!tenantId) return [];
    return this.knex('commercial.supervisor_diagnoses')
      .where({ tenant_id: tenantId, status: 'open' })
      .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
      .orderBy('confidence', 'desc')
      .select('*');
  }

  /** Feedback humano sobre un diagnóstico (dismissed/confirmed/reviewed/open). El motor no lo pisa. */
  async review(id: string, status: string, user: any) {
    const allowed = ['open', 'reviewed', 'dismissed', 'confirmed'];
    if (!allowed.includes(status)) {
      throw new BadRequestException(`status inválido: ${status}`);
    }
    const tenantId = this.tenantId(user);
    const userId = user?.sub || user?.id || user?.userId || null;
    const reviewedBy =
      userId && /^[0-9a-f-]{36}$/i.test(String(userId)) ? String(userId) : null;
    let q = this.knex('commercial.supervisor_diagnoses').where('id', id);
    if (tenantId) q = q.where('tenant_id', tenantId);
    const [updated] = await q
      .update({
        status,
        reviewed_by: reviewedBy,
        reviewed_at: this.knex.fn.now(),
        updated_at: this.knex.fn.now(),
      })
      .returning(['id', 'status']);
    if (!updated) throw new NotFoundException('Diagnóstico no encontrado');
    return updated;
  }

  /** Listado para el panel (filtrable por status). */
  async list(filters: { status?: string }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_diagnoses').select('*');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.where('status', filters.status || 'open');
    q = q
      .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
      .orderBy('confidence', 'desc')
      .limit(100);
    const rows = await q;
    return { rows, total: rows.length };
  }
}
