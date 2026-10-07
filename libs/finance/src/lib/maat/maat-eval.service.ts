import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { standardize, fitLogreg, predictRaw, classMetrics, auc, precisionAtK } from './maat-logreg.util';
import { FEATURE_NAMES } from './maat-learning.service';

/**
 * MAAT-IQ · MIQ.6 — Backtest / evaluación. Hace que "aprende" y "el mejor" sean
 * DEMOSTRABLES, no marketing (ADR-028).
 *
 * Split TEMPORAL honesto: entrena con los hallazgos etiquetados más viejos,
 * evalúa con los más nuevos (nunca al revés). Compara el modelo aprendido contra
 * el ranking del detector (score crudo) → el LIFT es la ganancia real del
 * aprendizaje. Degrada limpio: con pocas etiquetas reporta `ran:false` + por qué.
 */

const MIN_LABELED = 16;   // < esto no vale la pena partir en train/test
const TRAIN_FRAC = 0.7;

@Injectable()
export class MaatEvalService {
  private readonly logger = new Logger(MaatEvalService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async backtest(): Promise<any> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.finding_features as ff')
        .join('finance.findings as f', function (this: any) { this.on('f.tenant_id', 'ff.tenant_id').andOn('f.id', 'ff.finding_id'); })
        .where('ff.tenant_id', trx.raw('public.current_tenant_id()')).whereNotNull('ff.label')
        .orderBy('f.first_seen', 'asc')
        .select('ff.features', 'ff.label', trx.raw('f.score::numeric AS det_score'), 'f.first_seen');
      const n = rows.length;
      if (n < MIN_LABELED) return { ran: false, reason: 'insuficientes etiquetas para backtest', n_labeled: n, min: MIN_LABELED };

      const d = FEATURE_NAMES.length;
      const toVec = (feats: any) => { const o = typeof feats === 'string' ? JSON.parse(feats) : feats; return FEATURE_NAMES.map((k) => Number(o[k]) || 0); };
      const cut = Math.floor(n * TRAIN_FRAC);
      const train = rows.slice(0, cut), test = rows.slice(cut);
      const yTrain = train.map((r: any) => Number(r.label));
      const yTest = test.map((r: any) => Number(r.label));
      const posTest = yTest.filter((v) => v === 1).length;
      if (test.length < 5 || posTest === 0 || posTest === yTest.length) {
        return { ran: false, reason: 'set de prueba sin ambas clases (más feedback resuelve)', n_labeled: n, n_test: test.length, pos_test: posTest };
      }

      // entrena SOLO con lo viejo; estandariza con estadísticos del train
      const Xtr = train.map((r: any) => toVec(r.features));
      const { Xs, mean, std } = standardize(Xtr, d);
      const { w, b } = fitLogreg(Xs, yTrain, d);

      // evalúa en lo nuevo
      const modelPreds = test.map((r: any) => predictRaw(toVec(r.features), w, b, mean, std));
      const detPreds = test.map((r: any) => Number(r.det_score ?? 0.3));
      const model = classMetrics(modelPreds, yTest);
      const baseline = { auc: +auc(detPreds, yTest).toFixed(3) };

      const k = Math.max(1, Math.round(test.length * 0.2));
      const scoredModel = modelPreds.map((score, i) => ({ score, y: yTest[i] }));
      const scoredDet = detPreds.map((score, i) => ({ score, y: yTest[i] }));
      const base_rate = +(posTest / yTest.length).toFixed(3);
      const p_at_k_model = precisionAtK(scoredModel, k);
      const p_at_k_det = precisionAtK(scoredDet, k);

      const result = {
        ran: true,
        n_labeled: n, n_train: train.length, n_test: test.length, base_rate,
        model: { auc: model.auc, precision: model.precision, recall: model.recall, f1: model.f1 },
        baseline_detector: { auc: baseline.auc },
        lift_auc: +(model.auc - baseline.auc).toFixed(3),
        [`precision_at_top${Math.round(k)}`]: { modelo: p_at_k_model, detector: p_at_k_det, azar: base_rate },
        veredicto: model.auc > baseline.auc
          ? 'El modelo aprendido prioriza mejor que el score crudo del detector.'
          : 'Aún no supera al detector — necesita más feedback (etiquetas).',
      };
      this.logger.log(`backtest: n=${n} model.auc=${model.auc} vs detector.auc=${baseline.auc} lift=${result.lift_auc}`);
      return result;
    });
  }
}
