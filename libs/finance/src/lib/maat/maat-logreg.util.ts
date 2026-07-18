/**
 * MAAT-IQ — regresión logística pura (sin Nest, testeable). Compartida por
 * MaatLearningService (entrena el modelo vigente) y MaatEvalService (backtest
 * time-split). Determinista y auditable: solo aritmética.
 */

export const sigmoid = (z: number): number =>
  z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

/** Estandariza columnas (media 0, σ 1). Guarda media/σ para scorear igual. */
export function standardize(X: number[][], d: number): { Xs: number[][]; mean: number[]; std: number[] } {
  const n = X.length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (let j = 0; j < d; j++) mean[j] = X.reduce((a, x) => a + x[j], 0) / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(X.reduce((a, x) => a + (x[j] - mean[j]) ** 2, 0) / n) || 1;
  const Xs = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  return { Xs, mean, std };
}

/** Gradiente descendente con L2. X ya estandarizada. */
export function fitLogreg(Xs: number[][], y: number[], d: number, opts?: { lr?: number; epochs?: number; l2?: number }): { w: number[]; b: number } {
  const n = Xs.length;
  const lr = opts?.lr ?? 0.3, epochs = opts?.epochs ?? 600, l2 = opts?.l2 ?? 0.001;
  const w = new Array(d).fill(0); let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Xs[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Xs[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

/** P(y=1) para un vector CRUDO x (aplica media/σ del modelo). */
export function predictRaw(x: number[], w: number[], b: number, mean: number[], std: number[]): number {
  let z = b;
  for (let j = 0; j < w.length; j++) z += w[j] * ((x[j] - mean[j]) / (std[j] || 1));
  return sigmoid(z);
}

/** AUC por rangos (Mann-Whitney U). */
export function auc(preds: number[], y: number[]): number {
  const pos = preds.filter((_, i) => y[i] === 1);
  const neg = preds.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export interface ClassMetrics { accuracy: number; precision: number; recall: number; f1: number; auc: number; tp: number; fp: number; tn: number; fn: number; }

export function classMetrics(preds: number[], y: number[], thr = 0.5): ClassMetrics {
  const n = preds.length;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < n; i++) {
    const yh = preds[i] >= thr ? 1 : 0;
    if (yh && y[i] === 1) tp++;
    else if (yh && y[i] === 0) fp++;
    else if (!yh && y[i] === 0) tn++;
    else fn++;
  }
  const acc = n ? (tp + tn) / n : 0;
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    accuracy: +acc.toFixed(3), precision: +prec.toFixed(3), recall: +rec.toFixed(3),
    f1: +(prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0).toFixed(3),
    auc: +auc(preds, y).toFixed(3), tp, fp, tn, fn,
  };
}

/** Precisión en el top-K por score (lift vs azar). */
export function precisionAtK(scored: { score: number; y: number }[], k: number): number {
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, Math.max(1, k));
  return +(top.reduce((a, r) => a + r.y, 0) / top.length).toFixed(3);
}
