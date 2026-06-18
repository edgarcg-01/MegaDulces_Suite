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
import { RuleCalibrationService } from './rule-calibration.service';
import { BaselineLearnerService } from './baseline-learner.service';

/**
 * Horus — Motor de findings determinista (Sprint Horus.1).
 *
 * Lee el feature store (commercial.execution_360) + umbrales (execution_thresholds)
 * y emite hallazgos a commercial.supervisor_findings. CERO LLM: el motor DECIDE
 * con reglas explicables; el agente (Horus.2) solo redacta `explanation`.
 *
 * Reglas v1 (calibradas con datos reales, audit 2026-06-16). Solo se emiten las
 * defendibles con la cobertura de datos actual:
 *   - score_drop          (collaborator, 7d): la calidad cayó >= score_drop_pct.
 *   - low_score           (collaborator, 30d): calidad promedio bajo score_min_pct.
 *   - competitor_dominance(store, 30d): la competencia tiene >= dominance_pct del exhibidor.
 *   - store_at_risk       (store): tienda antes visitada que dejó de visitarse.
 * NO se emiten low_coverage / idle_anomaly / low_photo_coverage: la data no existe
 * (cobertura/idle) o el basal las haría ruido (foto ~49% es lo normal).
 *
 * Guard min_observations: no se juzga a un subject con < 3 observaciones en la
 * ventana (evita falsos positivos por muestra chica).
 *
 * Idempotencia: UPSERT por (tenant_id, dedup_key). Respeta decisiones humanas
 * (dismissed/confirmed NO se pisan al recomputar). Los 'open' de motor que ya no
 * aplican pasan a 'resolved'.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_OBS = 3;
const num = (v: any, d: number) => (v != null && !isNaN(Number(v)) ? Number(v) : d);

type Thresholds = {
  score_min_pct: number;
  score_drop_pct: number;
  competitor_dominance_pct: number;
  days_no_visit_max: number;
};

@Injectable()
export class FindingsEngineService {
  private readonly logger = new Logger(FindingsEngineService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly calibration: RuleCalibrationService,
    private readonly baselines: BaselineLearnerService,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  private async getThresholds(tenantId: string): Promise<Thresholds> {
    const row = await this.knex('commercial.execution_thresholds')
      .where('tenant_id', tenantId)
      .first();
    return {
      score_min_pct: num(row?.score_min_pct, 25),
      score_drop_pct: num(row?.score_drop_pct, 8),
      competitor_dominance_pct: num(row?.competitor_dominance_pct, 70),
      days_no_visit_max: num(row?.days_no_visit_max, 14),
    };
  }

  /**
   * Genera/actualiza los findings de motor para UN tenant desde el feature store.
   * Lo invoca el refresh tras recomputar execution_360 (y el endpoint /compute).
   */
  async generateForTenant(tenantId: string): Promise<{ open: number; resolved: number; suppressed: number }> {
    if (!tenantId) return { open: 0, resolved: 0, suppressed: 0 };
    const th = await this.getThresholds(tenantId);

    // L2 (ADR-021): calibración aprendida. Las reglas que el supervisor descarta casi
    // siempre se SUPRIMEN (no se emiten); las medio-ruidosas se CAPAN a 'warn'. Mapa
    // por (finding_type:source); el motor escribe source='engine'.
    const calib = await this.calibration.getCalibration(tenantId);
    const baselines = await this.baselines.getBaselines(tenantId); // L1: lo "normal" por sujeto (z-score)
    let suppressed = 0;

    const rows = await this.knex('commercial.execution_360')
      .where('tenant_id', tenantId)
      .select('*');

    const findings: any[] = [];
    const add = (findingType: string, severity: string, r: any, score: number, evidence: any) => {
      const c = calib.get(`${findingType}:engine`);
      if (c?.suppressed) {
        suppressed++;
        return; // regla aprendida como ruidosa → no molesta al supervisor
      }
      const sev = c?.cap === 'warn' && severity === 'critical' ? 'warn' : severity;
      findings.push({
        tenant_id: tenantId,
        dedup_key: `${findingType}:${r.subject_type}:${r.subject_id}:${r.window_days}`,
        finding_type: findingType,
        severity: sev,
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        label: r.label ? String(r.label).slice(0, 160) : null,
        score: Math.round(score * 100) / 100,
        evidence: JSON.stringify(evidence),
        source: 'engine',
        status: 'open',
      });
    };

    for (const r of rows) {
      const visits = num(r.visits_done, 0);
      const avg = r.avg_score != null ? Number(r.avg_score) : null;
      const trend = r.score_trend != null ? Number(r.score_trend) : null;
      const compShare = r.competitor_share_pct != null ? Number(r.competitor_share_pct) : null;
      const daysSince = r.days_since_last_visit != null ? Number(r.days_since_last_visit) : null;

      if (r.subject_type === 'collaborator' && visits >= MIN_OBS) {
        // score_drop: caída reciente (7d vs 7d previos) — la señal más accionable.
        if (r.window_days === 7 && trend != null && trend <= -th.score_drop_pct) {
          const mag = -trend;
          add('score_drop', mag >= 20 ? 'critical' : 'warn', r, mag, {
            avg_score: avg,
            score_trend: trend,
            window_days: 7,
            visits,
            threshold: th.score_drop_pct,
          });
        }
        // low_score: nivel absoluto bajo sostenido (30d).
        if (r.window_days === 30 && avg != null && avg < th.score_min_pct) {
          add('low_score', avg < th.score_min_pct / 2 ? 'critical' : 'warn', r, avg, {
            avg_score: avg,
            window_days: 30,
            visits,
            threshold: th.score_min_pct,
          });
        }
      }

      if (r.subject_type === 'store' && r.window_days === 30) {
        // competitor_dominance: la competencia domina los exhibidores de la tienda.
        // Guard por visits (proxy de # exhibiciones; v1 no guarda el conteo crudo).
        if (compShare != null && compShare >= th.competitor_dominance_pct && visits >= MIN_OBS) {
          add('competitor_dominance', compShare >= 85 ? 'critical' : 'warn', r, compShare, {
            competitor_share_pct: compShare,
            own_share_pct: r.own_share_pct != null ? Number(r.own_share_pct) : null,
            visits,
            threshold: th.competitor_dominance_pct,
          });
        }
        // store_at_risk: tienda (antes visitada) que dejó de visitarse.
        // CAVEAT: solo cubre tiendas con store_id en capturas (~29% hoy); NO
        // detecta tiendas nunca visitadas.
        if (daysSince != null && daysSince > th.days_no_visit_max) {
          add('store_at_risk', daysSince > th.days_no_visit_max * 2 ? 'critical' : 'warn', r, daysSince, {
            days_since_last_visit: daysSince,
            threshold: th.days_no_visit_max,
          });
        }
      }

      // L1 (ADR-021): anomalía vs la PROPIA historia del sujeto (z-score sobre avg_score
      // 30d). Complementa low_score (umbral global): capta la caída relativa que el umbral
      // absoluto no ve (90→75) e ignora al "siempre bajo". Sujeta a la calibración L2.
      if (r.window_days === 30 && avg != null && visits >= MIN_OBS) {
        const b = baselines.get(`${r.subject_type}:${r.subject_id}:30:avg_score`);
        if (b && b.floor_met && b.mean != null && b.stddev != null) {
          const drop = b.mean - avg;
          const z = b.stddev > 0 ? (avg - b.mean) / b.stddev : 0;
          if (drop >= Math.max(2 * b.stddev, 8)) {
            add('self_anomaly', z <= -3 || drop >= 25 ? 'critical' : 'warn', r, Math.round(drop * 100) / 100, {
              metric: 'avg_score',
              current: avg,
              baseline_mean: Math.round(b.mean * 100) / 100,
              baseline_stddev: Math.round(b.stddev * 100) / 100,
              baseline_n_obs: b.n_obs,
              z: Math.round(z * 100) / 100,
              window_days: 30,
            });
          }
        }
      }

      // K1 (Horus 360): desglose por concepto. Si un tipo de exhibidor lo ejecuta
      // notablemente PEOR que su propio promedio → coaching concreto ("flojeás la
      // cabecera"). Toma el peor concepto con datos suficientes. Sujeta a calibración L2.
      if (r.window_days === 30 && r.exec_level_score != null && r.by_concept) {
        const overall = Number(r.exec_level_score);
        const byC = typeof r.by_concept === 'string' ? JSON.parse(r.by_concept) : r.by_concept;
        let worst: any = null;
        for (const cid of Object.keys(byC || {})) {
          const c = byC[cid];
          if (c && c.n >= MIN_OBS && c.level_avg != null && (!worst || c.level_avg < worst.level_avg)) {
            worst = { ...c, cid };
          }
        }
        if (worst && overall - Number(worst.level_avg) >= 25) {
          const gap = Math.round((overall - Number(worst.level_avg)) * 100) / 100;
          add('weak_concept', gap >= 40 ? 'warn' : 'info', r, gap, {
            concept: worst.label || worst.cid,
            concept_level: Number(worst.level_avg),
            overall_level: overall,
            exhibiciones: worst.n,
            window_days: 30,
          });
        }
      }
    }

    const keys = findings.map((f) => f.dedup_key);

    if (findings.length > 0) {
      await this.knex('commercial.supervisor_findings')
        .insert(findings)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          severity: this.knex.raw('EXCLUDED.severity'),
          label: this.knex.raw('EXCLUDED.label'),
          score: this.knex.raw('EXCLUDED.score'),
          evidence: this.knex.raw('EXCLUDED.evidence'),
          // Preserva decisiones humanas; reabre solo lo auto-resuelto/revisado.
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_findings.status IN ('dismissed','confirmed') THEN commercial.supervisor_findings.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    // Resolver los 'open' de motor que ya no aplican en esta corrida.
    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'engine', status: 'open' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    return { open: findings.length, resolved: Number(resolved) || 0, suppressed };
  }

  /** Bandeja de hallazgos (default: status=open), priorizada por severidad + score. */
  async listFindings(
    filters: { status?: string; severity?: string; subject_type?: string },
    user: any,
  ) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_findings').select('*');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.where('status', filters.status || 'open');
    if (filters.severity) q = q.where('severity', filters.severity);
    if (filters.subject_type) q = q.where('subject_type', filters.subject_type);
    q = q
      .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
      .orderBy('score', 'desc');
    const rows = await q;
    return { rows, total: rows.length };
  }

  /** Feedback loop: el supervisor descarta/confirma/marca-revisado un hallazgo. */
  async reviewFinding(id: string, status: string, user: any) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    if (!['dismissed', 'confirmed', 'reviewed'].includes(status)) {
      throw new BadRequestException('status debe ser dismissed | confirmed | reviewed');
    }
    const tenantId = this.tenantId(user);
    const userId = user?.sub || user?.id || user?.userId || null;
    let q = this.knex('commercial.supervisor_findings').where('id', id);
    if (tenantId) q = q.where('tenant_id', tenantId);
    const updated = await q
      .update({
        status,
        reviewed_by: userId && UUID_RE.test(String(userId)) ? userId : null,
        reviewed_at: this.knex.fn.now(),
        updated_at: this.knex.fn.now(),
      })
      .returning('*');
    if (!updated.length) throw new NotFoundException('Finding no encontrado');

    // Crítico: al DESCARTAR un finding ya accionado, sus artefactos (nota de coaching /
    // tarea) quedarían vivos en la app del colaborador. Soft-borrarlos propaga la decisión
    // humana al campo. coaching_notes enlaza por finding_id; supervisor_tasks por action_id.
    if (status === 'dismissed') {
      const scope = (qb: any) => {
        if (tenantId) qb.where('tenant_id', tenantId);
      };
      await this.knex('commercial.coaching_notes')
        .where('finding_id', id)
        .whereNull('deleted_at')
        .modify(scope)
        .update({ deleted_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
      const acts = await this.knex('commercial.supervisor_actions')
        .where('finding_id', id)
        .modify(scope)
        .select('id');
      const actionIds = acts.map((a: any) => a.id);
      if (actionIds.length) {
        await this.knex('commercial.supervisor_tasks')
          .whereIn('action_id', actionIds)
          .whereNull('deleted_at')
          .modify(scope)
          .update({ status: 'cancelled', deleted_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
      }
    }

    return updated[0];
  }
}
