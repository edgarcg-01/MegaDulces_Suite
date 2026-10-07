import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';

/**
 * HIQ.2 (Fase Horus-IQ) — Umbrales contextuales por percentiles del tenant.
 *
 * Los defaults globales (score_min=25, drop=8, dominance=70, days=14) son
 * constantes calibradas una vez; este servicio los recalcula desde la
 * DISTRIBUCIÓN REAL del tenant (percentiles de execution_360) y los UPSERTea
 * en commercial.execution_thresholds — que FindingsEngine/OpportunityEngine ya
 * leen como override. "Bajo" pasa a significar "bajo PARA ESTE equipo".
 *
 * Gobierno (ADR-021): determinista + auditable (auto_tuned_at) + overridable
 * (manual_lock=true → pin humano, el learner no pisa). Gates anti-ruido:
 * muestra mínima por métrica y clamps a rangos defendibles — con 5 sujetos un
 * percentil es anécdota, no distribución.
 */
const MIN_SUBJECTS = 8;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (x: number) => Math.round(x * 10) / 10;

@Injectable()
export class AdaptiveThresholdsService {
  private readonly logger = new Logger(AdaptiveThresholdsService.name);

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /** Recalcula los umbrales del tenant desde percentiles. No-op si manual_lock. */
  async computeForTenant(tenantId: string): Promise<{ tuned: string[]; skipped: string }> {
    if (!tenantId) return { tuned: [], skipped: 'no_tenant' };

    const existing = await this.knex('commercial.execution_thresholds')
      .where('tenant_id', tenantId)
      .first();
    if (existing?.manual_lock) return { tuned: [], skipped: 'manual_lock' };

    const [agg] = await this.knex
      .with('collab30', (q) =>
        q
          .from('commercial.execution_360')
          .where({ tenant_id: tenantId, subject_type: 'collaborator', window_days: 30 })
          .whereNotNull('avg_score')
          .select('avg_score'),
      )
      .with('collab7', (q) =>
        q
          .from('commercial.execution_360')
          .where({ tenant_id: tenantId, subject_type: 'collaborator', window_days: 7 })
          .whereNotNull('score_trend')
          .select('score_trend'),
      )
      .with('store30', (q) =>
        q
          .from('commercial.execution_360')
          .where({ tenant_id: tenantId, subject_type: 'store', window_days: 30 })
          .select('competitor_share_pct', 'days_since_last_visit'),
      )
      .select(
        this.knex.raw(`(select count(*)::int from collab30) as n_collab`),
        this.knex.raw(`(select percentile_cont(0.10) within group (order by avg_score) from collab30) as score_p10`),
        this.knex.raw(`(select count(*)::int from collab7) as n_trend`),
        this.knex.raw(`(select stddev_samp(score_trend) from collab7) as trend_sd`),
        this.knex.raw(
          `(select count(*)::int from store30 where competitor_share_pct is not null) as n_dom`,
        ),
        this.knex.raw(
          `(select percentile_cont(0.90) within group (order by competitor_share_pct) from store30 where competitor_share_pct is not null) as dom_p90`,
        ),
        this.knex.raw(
          `(select count(*)::int from store30 where days_since_last_visit is not null) as n_days`,
        ),
        this.knex.raw(
          `(select percentile_cont(0.90) within group (order by days_since_last_visit) from store30 where days_since_last_visit is not null) as days_p90`,
        ),
      );

    const patch: Record<string, any> = {};
    const tuned: string[] = [];

    if (Number(agg?.n_collab) >= MIN_SUBJECTS && agg?.score_p10 != null) {
      patch.score_min_pct = round1(clamp(Number(agg.score_p10), 15, 40));
      tuned.push(`score_min_pct=${patch.score_min_pct}`);
    }
    if (Number(agg?.n_trend) >= MIN_SUBJECTS && agg?.trend_sd != null) {
      // Caída "anormal" ≈ 1σ de la variación natural del equipo (clamp defendible).
      patch.score_drop_pct = round1(clamp(Number(agg.trend_sd), 5, 15));
      tuned.push(`score_drop_pct=${patch.score_drop_pct}`);
    }
    if (Number(agg?.n_dom) >= MIN_SUBJECTS && agg?.dom_p90 != null) {
      patch.competitor_dominance_pct = round1(clamp(Number(agg.dom_p90), 60, 85));
      tuned.push(`competitor_dominance_pct=${patch.competitor_dominance_pct}`);
    }
    if (Number(agg?.n_days) >= MIN_SUBJECTS && agg?.days_p90 != null) {
      patch.days_no_visit_max = Math.round(clamp(Number(agg.days_p90), 7, 30));
      tuned.push(`days_no_visit_max=${patch.days_no_visit_max}`);
    }

    if (tuned.length === 0) return { tuned: [], skipped: 'insufficient_sample' };

    patch.tenant_id = tenantId;
    patch.auto_tuned_at = this.knex.fn.now();
    await this.knex('commercial.execution_thresholds')
      .insert(patch)
      .onConflict(['tenant_id'])
      .merge(Object.keys(patch).filter((k) => k !== 'tenant_id'));

    this.logger.log(`Umbrales adaptativos tenant=${tenantId}: ${tuned.join(' · ')}`);
    return { tuned, skipped: '' };
  }
}
