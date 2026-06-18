import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Track Razonamiento (Horus.R), Sprint R4: verificador de resultado (L3).
 *
 * Cierra el lazo: una acción APROBADA/ejecutada, cuando MADURA (~4 semanas), se mide.
 * Diff-in-diff sobre los snapshots del feature store (commercial.execution_360_snapshots):
 *   Δsujeto  = métrico DESPUÉS − métrico ANTES de la acción
 *   Δtenant  = misma diferencia sobre el resto de sujetos del tipo (control de tendencia)
 *   neto     = Δsujeto − Δtenant   →  worked / no_effect / backfired
 *
 * Ship-collector-before-learner (ADR-021): este service COLECTA outcomes y los expone
 * (getEffectiveness = qué prescripciones funcionan). NO ajusta confianza/prioridad todavía
 * (L4 diferido): el motor sigue decidiendo con L2+corroboración hasta que haya outcomes
 * suficientes. Determinista, auditable, sin LLM.
 *
 * Acceso runtime: KNEX_CONNECTION (superuser) + tenant_id explícito (patrón Horus).
 */
const MATURITY_DAYS = 28; // sólo se mide una acción con >= 28 días de ejecutada
const PRE_FROM = 14; // ventana "antes": [E-14, E]
const POST_FROM = 7; // ventana "después": [E+7, E+28]
const POST_TO = 28;
const THRESHOLD = 5; // |neto| < 5 pts → sin efecto claro
const round2 = (x: number) => Math.round(x * 100) / 100;

// Acción → métrico observable + dirección (todas 'up' = más alto es mejor).
const METRIC_FOR: Record<string, string> = {
  coaching: 'avg_score',
  coaching_focus: 'avg_score',
  escalate: 'avg_score',
  reprioritize_route: 'avg_score',
  visit: 'own_share_pct',
  recover_shelf: 'own_share_pct',
};

@Injectable()
export class OutcomeVerifierService {
  private readonly logger = new Logger(OutcomeVerifierService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /** Promedio + n del métrico en una ventana de días relativa a executed_at, desde snapshots 30d. */
  private async windowAvg(
    tenantId: string,
    subjectType: string,
    subjectId: string,
    metric: string,
    executedAt: any,
    fromDays: number,
    toDays: number,
    exclude: boolean,
  ): Promise<{ v: number | null; n: number }> {
    const q = this.knex('commercial.execution_360_snapshots')
      .where({ tenant_id: tenantId, subject_type: subjectType, window_days: 30 })
      .whereRaw(`snapshot_date BETWEEN (?::date + ?::int) AND (?::date + ?::int)`, [
        executedAt,
        fromDays,
        executedAt,
        toDays,
      ])
      .whereNotNull(metric);
    if (exclude) q.whereNot('subject_id', subjectId);
    else q.where('subject_id', subjectId);
    const row = await q.avg({ v: metric }).count({ n: '*' }).first();
    return { v: row?.v != null ? Number(row.v) : null, n: Number(row?.n) || 0 };
  }

  /** Mide los outcomes maduros aún sin medir de UN tenant. */
  async measureForTenant(tenantId: string): Promise<{ measured: number; insufficient: number }> {
    if (!tenantId) return { measured: 0, insufficient: 0 };

    const actions = await this.knex('commercial.supervisor_actions')
      .where({ tenant_id: tenantId, status: 'executed', outcome_status: 'pending' })
      .whereNotNull('executed_at')
      .whereRaw(`executed_at <= (now() AT TIME ZONE 'America/Mexico_City') - (?::int * interval '1 day')`, [
        MATURITY_DAYS,
      ])
      .select('id', 'action_type', 'subject_type', 'subject_id', 'executed_at', 'root_cause');

    let measured = 0;
    let insufficient = 0;

    for (const a of actions) {
      const metric = METRIC_FOR[a.action_type];
      if (!metric) {
        // No es una acción de métrico observable → cerrar como inconclusa (no re-escanear).
        await this.knex('commercial.supervisor_actions')
          .where({ id: a.id, tenant_id: tenantId })
          .update({
            outcome_status: 'insufficient_data',
            outcome_verdict: 'inconclusive',
            outcome_detail: JSON.stringify({ reason: 'metric_not_observable', action_type: a.action_type }),
            outcome_measured_at: this.knex.fn.now(),
            updated_at: this.knex.fn.now(),
          });
        insufficient++;
        continue;
      }

      const before = await this.windowAvg(tenantId, a.subject_type, a.subject_id, metric, a.executed_at, -PRE_FROM, 0, false);
      const after = await this.windowAvg(tenantId, a.subject_type, a.subject_id, metric, a.executed_at, POST_FROM, POST_TO, false);

      if (before.n === 0 || after.n === 0 || before.v == null || after.v == null) {
        await this.knex('commercial.supervisor_actions')
          .where({ id: a.id, tenant_id: tenantId })
          .update({
            outcome_status: 'insufficient_data',
            outcome_verdict: 'inconclusive',
            outcome_detail: JSON.stringify({ reason: 'no_snapshots', metric, n_before: before.n, n_after: after.n }),
            outcome_measured_at: this.knex.fn.now(),
            updated_at: this.knex.fn.now(),
          });
        insufficient++;
        continue;
      }

      // Control de tendencia: el resto de sujetos del tipo en las mismas ventanas.
      const cBefore = await this.windowAvg(tenantId, a.subject_type, a.subject_id, metric, a.executed_at, -PRE_FROM, 0, true);
      const cAfter = await this.windowAvg(tenantId, a.subject_type, a.subject_id, metric, a.executed_at, POST_FROM, POST_TO, true);
      const control =
        cBefore.n > 0 && cAfter.n > 0 && cBefore.v != null && cAfter.v != null ? cAfter.v - cBefore.v : 0;

      const delta = after.v - before.v;
      const net = round2(delta - control);
      const verdict = net >= THRESHOLD ? 'worked' : net <= -THRESHOLD ? 'backfired' : 'no_effect';

      await this.knex('commercial.supervisor_actions')
        .where({ id: a.id, tenant_id: tenantId })
        .update({
          outcome_status: 'measured',
          outcome_verdict: verdict,
          outcome_delta: net,
          outcome_detail: JSON.stringify({
            metric,
            before: round2(before.v),
            after: round2(after.v),
            delta: round2(delta),
            control: round2(control),
            net,
            n_before: before.n,
            n_after: after.n,
            control_applied: cBefore.n > 0 && cAfter.n > 0,
            post_window: [POST_FROM, POST_TO],
          }),
          outcome_measured_at: this.knex.fn.now(),
          updated_at: this.knex.fn.now(),
        });
      measured++;
    }

    return { measured, insufficient };
  }

  /**
   * L3 — efectividad agregada: de las acciones MEDIDAS, qué % funcionó por causa raíz /
   * tipo de acción. Es el aprendizaje observable (qué prescripciones mueven la aguja).
   * Read-only: NO ajusta la confianza todavía (L4 diferido, ship-collector-before-learner).
   */
  async getEffectiveness(user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_actions')
      .where('outcome_status', 'measured')
      .select(this.knex.raw(`COALESCE(root_cause, action_type) AS key`), 'action_type')
      .count({ measured: '*' })
      .select(
        this.knex.raw(`count(*) FILTER (WHERE outcome_verdict = 'worked') AS worked`),
        this.knex.raw(`count(*) FILTER (WHERE outcome_verdict = 'no_effect') AS no_effect`),
        this.knex.raw(`count(*) FILTER (WHERE outcome_verdict = 'backfired') AS backfired`),
        this.knex.raw(`round(avg(outcome_delta)::numeric, 2) AS avg_delta`),
      )
      .groupByRaw(`COALESCE(root_cause, action_type), action_type`);
    if (tenantId) q = q.where('tenant_id', tenantId);
    const rows = await q;
    return {
      rows: rows.map((r: any) => {
        const measured = Number(r.measured) || 0;
        const worked = Number(r.worked) || 0;
        return {
          key: r.key,
          action_type: r.action_type,
          measured,
          worked,
          no_effect: Number(r.no_effect) || 0,
          backfired: Number(r.backfired) || 0,
          avg_delta: r.avg_delta != null ? Number(r.avg_delta) : null,
          effectiveness: measured > 0 ? Math.round((worked / measured) * 100) / 100 : null,
        };
      }),
      total: rows.length,
    };
  }

  /** Outcomes recientes ya medidos (para el panel "qué pasó después"). */
  async listOutcomes(user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_actions')
      .where('outcome_status', 'measured')
      .select('id', 'action_type', 'subject_type', 'label', 'title', 'root_cause', 'outcome_verdict', 'outcome_delta', 'outcome_detail', 'outcome_measured_at');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.orderBy('outcome_measured_at', 'desc').limit(50);
    const rows = await q;
    return { rows, total: rows.length };
  }
}
