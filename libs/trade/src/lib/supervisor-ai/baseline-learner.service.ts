import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Aprendizaje L1: baselines por sujeto (BaselineLearnerService).
 *
 * Aprende lo "normal" de cada sujeto desde el histórico append-only
 * (commercial.execution_360_snapshots): media + desviación rodante por
 * (subject, window_days, metric). Persiste en commercial.execution_baselines
 * (long, 1 row/métrica). El FindingsEngine lo lee para el z-score: detecta el sujeto
 * que cae respecto de SU PROPIA historia (no de un umbral global) y deja de gritar por
 * el que "siempre fue bajo".
 *
 * Invariante (ADR-021): determinista, auditable, sin LLM. Gate por CALENDARIO:
 * `floor_met` = n_obs >= MIN_OBS_BASELINE (~1 semana de snapshots diarios). Por debajo
 * del piso el motor cae al default global (cold-start honesto). Aprender la "normalidad"
 * con 2 días sería ruido.
 *
 * Acceso runtime: KNEX_CONNECTION (superuser) + tenant_id explícito (patrón Horus).
 */
const MIN_OBS_BASELINE = 7; // snapshots (días) mínimos para que el baseline sea "de fiar"
const LOOKBACK_DAYS = 60;
const METRICS = ['avg_score', 'exec_score', 'exec_level_score', 'own_share_pct', 'photo_coverage_pct'];
const round2 = (x: number) => Math.round(x * 100) / 100;

@Injectable()
export class BaselineLearnerService {
  private readonly logger = new Logger(BaselineLearnerService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /**
   * Recomputa los baselines del tenant desde los snapshots (ventana LOOKBACK_DAYS) y
   * hace UPSERT (long, por métrica). Una sola agregación SQL con count/avg/stddev/min/max
   * por métrica → unpivot en JS (maneja nulls por métrica con su propio n).
   */
  async computeForTenant(tenantId: string): Promise<{ baselines: number; floor_met: number }> {
    if (!tenantId) return { baselines: 0, floor_met: 0 };

    const aggSelect = METRICS.map(
      (m) =>
        `count(${m}) AS n_${m}, avg(${m}) AS m_${m}, stddev_samp(${m}) AS sd_${m}, min(${m}) AS min_${m}, max(${m}) AS max_${m}`,
    ).join(',\n      ');

    const agg = await this.knex('commercial.execution_360_snapshots')
      .where('tenant_id', tenantId)
      .whereRaw(`snapshot_date >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int`, [LOOKBACK_DAYS])
      .groupBy('subject_type', 'subject_id', 'window_days')
      .select('subject_type', 'subject_id', 'window_days')
      .select(this.knex.raw(aggSelect));

    if (agg.length === 0) return { baselines: 0, floor_met: 0 };

    const rows: any[] = [];
    let floorMetCount = 0;
    for (const a of agg) {
      for (const metric of METRICS) {
        const n = Number(a[`n_${metric}`]) || 0;
        if (n < 2) continue; // al menos 2 puntos para media/dispersión
        const mean = a[`m_${metric}`] != null ? round2(Number(a[`m_${metric}`])) : null;
        const sd = a[`sd_${metric}`] != null ? round2(Number(a[`sd_${metric}`])) : null;
        const floor = n >= MIN_OBS_BASELINE;
        if (floor) floorMetCount++;
        rows.push({
          tenant_id: tenantId,
          subject_type: a.subject_type,
          subject_id: a.subject_id,
          window_days: a.window_days,
          metric,
          mean,
          stddev: sd,
          n_obs: n,
          min_val: a[`min_${metric}`] != null ? round2(Number(a[`min_${metric}`])) : null,
          max_val: a[`max_${metric}`] != null ? round2(Number(a[`max_${metric}`])) : null,
          floor_met: floor,
          computed_at: this.knex.fn.now(),
          updated_at: this.knex.fn.now(),
        });
      }
    }
    if (rows.length === 0) return { baselines: 0, floor_met: 0 };

    await this.knex('commercial.execution_baselines')
      .insert(rows)
      .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days', 'metric'])
      .merge(['mean', 'stddev', 'n_obs', 'min_val', 'max_val', 'floor_met', 'computed_at', 'updated_at']);

    return { baselines: rows.length, floor_met: floorMetCount };
  }

  /**
   * Mapa de baselines por `${subject_type}:${subject_id}:${window_days}:${metric}` para
   * que el motor calcule el z-score contra la propia historia del sujeto.
   */
  async getBaselines(
    tenantId: string,
  ): Promise<Map<string, { mean: number | null; stddev: number | null; n_obs: number; floor_met: boolean }>> {
    const map = new Map<string, { mean: number | null; stddev: number | null; n_obs: number; floor_met: boolean }>();
    if (!tenantId) return map;
    const rows = await this.knex('commercial.execution_baselines')
      .where('tenant_id', tenantId)
      .select('subject_type', 'subject_id', 'window_days', 'metric', 'mean', 'stddev', 'n_obs', 'floor_met');
    for (const b of rows) {
      map.set(`${b.subject_type}:${b.subject_id}:${b.window_days}:${b.metric}`, {
        mean: b.mean != null ? Number(b.mean) : null,
        stddev: b.stddev != null ? Number(b.stddev) : null,
        n_obs: Number(b.n_obs) || 0,
        floor_met: !!b.floor_met,
      });
    }
    return map;
  }

  /** Baselines para el panel L7 (lo "normal" aprendido por sujeto). */
  async list(filters: { subject_type?: string; metric?: string }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.execution_baselines').select('*');
    if (tenantId) q = q.where('tenant_id', tenantId);
    if (filters.subject_type) q = q.where('subject_type', filters.subject_type);
    if (filters.metric) q = q.where('metric', filters.metric);
    q = q.orderBy('floor_met', 'desc').orderBy('n_obs', 'desc');
    const rows = await q;
    return { rows, total: rows.length, computed_at: rows[0]?.computed_at ?? null };
  }
}
