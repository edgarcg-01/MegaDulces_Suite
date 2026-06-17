import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Motor MULTI-SEÑAL (Sprint H2.3).
 *
 * Calcula un score de ejecución 0..100 EXPLICABLE por sujeto (estilo Thot): combina
 * señales normalizadas a [0,1] con pesos y persiste la contribución de cada una en
 * `exec_score_breakdown` (ordenado peor→mejor) → el supervisor ve "qué resta". CERO
 * LLM: el motor decide y explica con números.
 *
 * Robusto a datos faltantes: si una señal no existe (p.ej. avg_score null), se
 * EXCLUYE y se renormalizan los pesos sobre las presentes. Si la confianza (peso
 * presente) < MIN_CONFIDENCE → exec_score null (no se inventa salud sin datos).
 *
 * Multi-señal de verdad: cruza el feature store (execution_360) con los hallazgos
 * de fraude (supervisor_findings source='fraud') para el factor de INTEGRIDAD.
 *
 * Complementa —no reemplaza— las reglas/findings: el score es la salud holística;
 * los findings son problemas puntuales accionables. Corre tras exec360/vision/fraude.
 */
const MIN_CONFIDENCE = 0.4;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

const WEIGHTS = {
  collaborator: { quality: 0.32, exec_level: 0.18, trend: 0.13, photo: 0.12, own: 0.12, integrity: 0.13 },
  store: { own: 0.38, quality: 0.25, exec_level: 0.17, freshness: 0.2 },
};

const LABELS: Record<string, string> = {
  quality: 'calidad de exhibición',
  exec_level: 'nivel de ejecución',
  trend: 'tendencia',
  photo: 'cobertura de foto',
  own: 'share propio',
  integrity: 'integridad',
  freshness: 'frescura de visita',
};

type Sig = { key: string; value: number | null; weight: number };

@Injectable()
export class ScoringEngineService {
  private readonly logger = new Logger(ScoringEngineService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private compute(signals: Sig[]): { score: number; confidence: number; breakdown: any[] } | null {
    const present = signals.filter((s) => s.value != null) as { key: string; value: number; weight: number }[];
    const totalW = present.reduce((a, s) => a + s.weight, 0);
    if (totalW < MIN_CONFIDENCE) return null;
    let score = 0;
    const breakdown = present
      .map((s) => {
        const w = s.weight / totalW;
        const contribution = 100 * s.value * w;
        score += contribution;
        return {
          key: s.key,
          label: LABELS[s.key] || s.key,
          value: round2(s.value),
          weight: round2(w),
          contribution: round2(contribution),
        };
      })
      .sort((a, b) => a.contribution - b.contribution); // peor primero (lo que más resta)
    return { score: round2(score), confidence: round2(totalW), breakdown };
  }

  /** Calcula y persiste exec_score + breakdown para UN tenant. Devuelve cuántos puntuó. */
  async scoreForTenant(tenantId: string): Promise<{ scored: number; skipped: number }> {
    if (!tenantId) return { scored: 0, skipped: 0 };

    const rows = await this.knex('commercial.execution_360').where('tenant_id', tenantId).select('*');

    // Integridad: # de hallazgos de fraude vivos por colaborador.
    const fraudRows = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'fraud', subject_type: 'collaborator' })
      .whereIn('status', ['open', 'confirmed'])
      .select('subject_id');
    const fraudByCollab = new Map<string, number>();
    for (const f of fraudRows) fraudByCollab.set(f.subject_id, (fraudByCollab.get(f.subject_id) || 0) + 1);

    const updates: { id: string; exec_score: number | null; breakdown: string | null }[] = [];
    for (const r of rows) {
      const avg = r.avg_score != null ? Number(r.avg_score) : null;
      const trend = r.score_trend != null ? Number(r.score_trend) : null;
      const photo = r.photo_coverage_pct != null ? Number(r.photo_coverage_pct) : null;
      const own = r.own_share_pct != null ? Number(r.own_share_pct) : null;
      const days = r.days_since_last_visit != null ? Number(r.days_since_last_visit) : null;
      const execLevel = r.exec_level_score != null ? Number(r.exec_level_score) : null; // H2.1

      let signals: Sig[];
      if (r.subject_type === 'collaborator') {
        const w = WEIGHTS.collaborator;
        const fraudCount = fraudByCollab.get(r.subject_id) || 0;
        signals = [
          { key: 'quality', value: avg != null ? clamp01(avg / 100) : null, weight: w.quality },
          { key: 'exec_level', value: execLevel != null ? clamp01(execLevel / 100) : null, weight: w.exec_level },
          { key: 'trend', value: trend != null ? clamp01(0.5 + trend / 40) : null, weight: w.trend },
          { key: 'photo', value: photo != null ? clamp01(photo / 100) : null, weight: w.photo },
          { key: 'own', value: own != null ? clamp01(own / 100) : null, weight: w.own },
          { key: 'integrity', value: clamp01(1 - 0.2 * fraudCount), weight: w.integrity },
        ];
      } else if (r.subject_type === 'store') {
        const w = WEIGHTS.store;
        signals = [
          { key: 'own', value: own != null ? clamp01(own / 100) : null, weight: w.own },
          { key: 'quality', value: avg != null ? clamp01(avg / 100) : null, weight: w.quality },
          { key: 'exec_level', value: execLevel != null ? clamp01(execLevel / 100) : null, weight: w.exec_level },
          { key: 'freshness', value: days != null ? clamp01(1 - days / 30) : null, weight: w.freshness },
        ];
      } else {
        signals = [];
      }

      const res = this.compute(signals);
      updates.push({
        id: r.id,
        exec_score: res ? res.score : null,
        breakdown: res ? JSON.stringify({ confidence: res.confidence, signals: res.breakdown }) : null,
      });
    }

    let scored = 0;
    let skipped = 0;
    const CHUNK = 20;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map((u) => {
          if (u.exec_score == null) skipped++;
          else scored++;
          return this.knex('commercial.execution_360')
            .where('id', u.id)
            .update({ exec_score: u.exec_score, exec_score_breakdown: u.breakdown, updated_at: this.knex.fn.now() });
        }),
      );
    }

    return { scored, skipped };
  }
}
