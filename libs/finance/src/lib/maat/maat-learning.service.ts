import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { sigmoid, standardize, fitLogreg, classMetrics } from './maat-logreg.util';

/**
 * MAAT-IQ · MIQ.2 — El modelo que APRENDE (ADR-028 + ADR-021 Horus-L).
 *
 * NO es fine-tuning de un LLM (prohibido por ADR-028: el LLM nunca toca números).
 * Es aprendizaje SUPERVISADO, determinista y auditable:
 *   feedback humano (confirmar/descartar) = etiqueta
 *   → regresión logística in-proc = modelo de ranking
 *   → P(hallazgo real y material) ordena la bandeja.
 *
 * Auditable: los coeficientes viven en `finance.finding_model` (intercepto +
 * pesos + media/σ por feature). Se sabe POR QUÉ subió un hallazgo (feature
 * importance), requisito de finanzas. Cold-start seguro: sin modelo, la bandeja
 * cae al score del detector (COALESCE en el list).
 *
 * Active learning: `uncertain()` devuelve los hallazgos donde el modelo está
 * MÁS inseguro (|p−0.5| mínimo) → etiquetar esos rinde más señal por clic.
 *
 * Ciclo (nightly, tras el scan): syncFeatures → train → score.
 */

const MIN_TRAIN = 12;      // mínimo de etiquetas para entrenar
const MIN_PER_CLASS = 3;   // …y al menos esto de cada clase

/** Orden canónico de features. Cambiar aquí = re-entrenar (versión nueva). */
const FEATURES: { name: string; of: (r: any) => number }[] = [
  { name: 'f_log_importe', of: (r) => Math.log1p(Math.abs(Number(r.importe) || 0)) },
  { name: 'f_score', of: (r) => Number(r.score ?? 0.3) },
  { name: 'f_sev', of: (r) => ({ info: 0, warn: 1, critical: 2 } as any)[r.severity] ?? 0 },
  { name: 'f_riesgo', of: (r) => (r.clase === 'riesgo' ? 1 : 0) },
  { name: 'f_error', of: (r) => (r.clase === 'error_captura' ? 1 : 0) },
  { name: 'f_oport', of: (r) => (r.clase === 'oportunidad' ? 1 : 0) },
  { name: 'f_rule_prec', of: (r) => Number(r.rule_prec ?? 0.5) },
  { name: 'f_age_days', of: (r) => daysBetween(r.first_seen, Date.now()) },
  { name: 'f_recur_days', of: (r) => daysBetween(r.first_seen, r.last_seen) },
  { name: 'f_has_prov', of: (r) => (entityHasProv(r.entity) ? 1 : 0) },
];

/** Orden canónico de nombres de features (para el backtest y el scoring). */
export const FEATURE_NAMES: string[] = FEATURES.map((f) => f.name);

function daysBetween(a: any, b: any): number {
  const t1 = typeof a === 'number' ? a : new Date(a).getTime();
  const t2 = typeof b === 'number' ? b : new Date(b).getTime();
  if (!isFinite(t1) || !isFinite(t2)) return 0;
  return Math.max(0, (t2 - t1) / 86_400_000);
}
function entityHasProv(e: any): boolean {
  const o = typeof e === 'string' ? safeJson(e) : e;
  return !!(o && (o.beneficiario || o.proveedor));
}
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
const labelOf = (verdict: string | null): number | null =>
  verdict == null ? null : (verdict === 'util' || verdict === 'ya_corregido') ? 1 : 0;

@Injectable()
export class MaatLearningService {
  private readonly logger = new Logger(MaatLearningService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Ciclo completo nightly: reconstruye features → entrena → scorea. */
  async runLearning(): Promise<any> {
    const feats = await this.syncFeatures();
    const train = await this.train();
    const score = await this.score();
    return { features: feats, train, score };
  }

  // ── feature store: 1 fila por hallazgo, etiqueta desde el último feedback ──
  async syncFeatures(): Promise<{ total: number; etiquetados: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.findings as f')
        .leftJoin('finance.rule_registry as r', function (this: any) { this.on('r.tenant_id', 'f.tenant_id').andOn('r.rule_key', 'f.rule_key'); })
        .select('f.id', 'f.rule_key', 'f.clase', 'f.severity', 'f.score', 'f.importe', 'f.entity',
          'f.first_seen', 'f.last_seen', 'r.precision_score as rule_prec',
          trx.raw(`(SELECT verdict FROM finance.finding_feedback fb
                     WHERE fb.tenant_id = f.tenant_id AND fb.finding_id = f.id
                     ORDER BY fb.created_at DESC LIMIT 1) AS verdict`))
        .where('f.tenant_id', tenantId);
      let etiquetados = 0;
      for (const r of rows) {
        const vec: Record<string, number> = {};
        for (const f of FEATURES) vec[f.name] = round6(f.of(r));
        const label = labelOf(r.verdict);
        if (label != null) etiquetados++;
        await trx('finance.finding_features')
          .insert({
            tenant_id: tenantId, finding_id: r.id, rule_key: r.rule_key,
            features: JSON.stringify(vec), label, importe: Number(r.importe) || 0,
            labeled_at: label != null ? trx.fn.now() : null,
          })
          .onConflict(['tenant_id', 'finding_id'])
          .merge({ features: JSON.stringify(vec), label, importe: Number(r.importe) || 0, rule_key: r.rule_key, updated_at: trx.fn.now(), labeled_at: label != null ? trx.fn.now() : null });
      }
      return { total: rows.length, etiquetados };
    });
  }

  // ── entrena regresión logística sobre las features etiquetadas ──
  async train(): Promise<any> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const labeled = await trx('finance.finding_features')
        .where('tenant_id', tenantId).whereNotNull('label').select('features', 'label');
      const n = labeled.length;
      const nPos = labeled.filter((r: any) => Number(r.label) === 1).length;
      const nNeg = n - nPos;
      if (n < MIN_TRAIN || nPos < MIN_PER_CLASS || nNeg < MIN_PER_CLASS) {
        return { trained: false, reason: 'insuficientes etiquetas', n_labeled: n, n_pos: nPos, n_neg: nNeg, min: MIN_TRAIN };
      }
      const d = FEATURES.length;
      const X: number[][] = labeled.map((r: any) => {
        const o = typeof r.features === 'string' ? JSON.parse(r.features) : r.features;
        return FEATURES.map((f) => Number(o[f.name]) || 0);
      });
      const y: number[] = labeled.map((r: any) => Number(r.label));

      // estandarizar (guarda media/σ para scorear igual)
      const { Xs, mean, std } = standardize(X, d);
      const { w, b } = fitLogreg(Xs, y, d);

      // métricas en el set de entrenamiento (el honesto time-split va en el backtest)
      const preds = Xs.map((x) => sigmoid(b + x.reduce((a, v, j) => a + v * w[j], 0)));
      const metrics = classMetrics(preds, y);
      const importance = FEATURES.map((f, j) => ({ feature: f.name, weight: +w[j].toFixed(3) }))
        .sort((a, b2) => Math.abs(b2.weight) - Math.abs(a.weight));

      const cur = await trx('finance.finding_model').where('tenant_id', tenantId).max('version as v').first();
      const version = Number(cur?.v || 0) + 1;
      await trx('finance.finding_model').insert({
        tenant_id: tenantId, version, algo: 'logreg',
        feature_names: JSON.stringify(FEATURES.map((f) => f.name)),
        coef: JSON.stringify({ intercept: b, weights: w, mean, std }),
        n_train: n, n_pos: nPos,
        metrics: JSON.stringify({ ...metrics, importance }),
      });
      this.logger.log(`train v${version}: n=${n} (${nPos}+/${nNeg}-) acc=${metrics.accuracy} auc=${metrics.auc}`);
      return { trained: true, version, n_labeled: n, n_pos: nPos, n_neg: nNeg, metrics, importance };
    });
  }

  // ── scorea los hallazgos abiertos con el modelo vigente ──
  async score(): Promise<any> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const model = await trx('finance.finding_model').where('tenant_id', tenantId).orderBy('version', 'desc').first();
      if (!model) return { scored: 0, cold_start: true, msg: 'sin modelo aún — la bandeja usa el score del detector' };
      const coef = typeof model.coef === 'string' ? JSON.parse(model.coef) : model.coef;
      const names: string[] = typeof model.feature_names === 'string' ? JSON.parse(model.feature_names) : model.feature_names;
      const { intercept, weights, mean, std } = coef;

      const rows = await trx('finance.findings as f')
        .leftJoin('finance.rule_registry as r', function (this: any) { this.on('r.tenant_id', 'f.tenant_id').andOn('r.rule_key', 'f.rule_key'); })
        .whereIn('f.status', ['nuevo', 'en_revision']).where('f.tenant_id', tenantId)
        .select('f.id', 'f.rule_key', 'f.clase', 'f.severity', 'f.score', 'f.importe', 'f.entity', 'f.first_seen', 'f.last_seen', 'r.precision_score as rule_prec');
      let scored = 0;
      for (const r of rows) {
        const raw: Record<string, number> = {};
        for (const f of FEATURES) raw[f.name] = f.of(r);
        let z = Number(intercept);
        for (let j = 0; j < names.length; j++) {
          const v = Number(raw[names[j]]) || 0;
          z += Number(weights[j]) * ((v - Number(mean[j])) / (Number(std[j]) || 1));
        }
        const p = +sigmoid(z).toFixed(4);
        await trx('finance.findings').where({ tenant_id: tenantId, id: r.id }).update({ model_score: p, model_version: model.version, updated_at: trx.fn.now() });
        await trx('finance.finding_features').where({ tenant_id: tenantId, finding_id: r.id }).update({ model_score: p, updated_at: trx.fn.now() });
        scored++;
      }
      this.logger.log(`score v${model.version}: ${scored} hallazgos abiertos priorizados.`);
      return { scored, version: model.version };
    });
  }

  /** Active learning: hallazgos donde el modelo está MÁS inseguro (etiquetar rinde más). */
  async uncertain(limit = 15): Promise<any> {
    this.tenantCtx.requireTenantId();
    const lim = Math.min(50, Math.max(1, Number(limit) || 15));
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.findings')
        .where('tenant_id', trx.raw('public.current_tenant_id()'))
        .whereIn('status', ['nuevo', 'en_revision'])
        .whereNotNull('model_score').where('model_version', '>', 0)
        .select('id', 'rule_key', 'titulo', 'severity', 'clase', trx.raw('importe::numeric AS importe'),
          trx.raw('model_score::numeric AS model_score'), trx.raw('abs(model_score - 0.5) AS incertidumbre'))
        .orderBy('incertidumbre', 'asc').limit(lim);
      return rows.map((r: any) => ({ ...r, importe: Number(r.importe), model_score: Number(r.model_score) }));
    });
  }

  /** Estado del modelo vigente + tamaño del dataset (para el panel/status). */
  async status(): Promise<any> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const model = await trx('finance.finding_model').where('tenant_id', trx.raw('public.current_tenant_id()')).orderBy('version', 'desc').first();
      const feat: any = await trx('finance.finding_features').where('tenant_id', trx.raw('public.current_tenant_id()'))
        .select(trx.raw('COUNT(*)::int AS total'),
          trx.raw('COUNT(*) FILTER (WHERE label IS NOT NULL)::int AS etiquetados'),
          trx.raw('COUNT(*) FILTER (WHERE label = 1)::int AS positivos'),
          trx.raw('COUNT(*) FILTER (WHERE model_score IS NOT NULL)::int AS scoreados')).first();
      return {
        modelo: model ? {
          version: model.version, algo: model.algo, n_train: model.n_train, n_pos: model.n_pos,
          trained_at: model.trained_at,
          metrics: typeof model.metrics === 'string' ? JSON.parse(model.metrics) : model.metrics,
        } : null,
        dataset: { total: Number(feat?.total || 0), etiquetados: Number(feat?.etiquetados || 0), positivos: Number(feat?.positivos || 0), scoreados: Number(feat?.scoreados || 0) },
        listo_para_entrenar: Number(feat?.etiquetados || 0) >= MIN_TRAIN,
      };
    });
  }

}

function round6(n: number): number { return Math.round((Number(n) || 0) * 1e6) / 1e6; }
