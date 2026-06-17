import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Execution Feature Store (Sprint Horus.0).
 *
 * Computa la "telemetría de ejecución" en campo (no de venta) y la persiste en
 * commercial.execution_360 (1 row UPSERT por subject × ventana). Análogo Trade
 * de customer_360. Lee daily_captures vía KNEX_CONNECTION (superuser, bypassa
 * RLS) + tenant_id explícito, igual que CommercialMap/Reports.
 *
 * Horus.0 computa las señales DIRECTAS de daily_captures (confiables hoy):
 * visitas, score (avg de score_final_pct), tendencia de score, share propio vs
 * competencia, cobertura fotográfica, días sin visita — por colaborador y por
 * tienda, en ventanas de 7 y 30 días. Las señales derivadas (cobertura
 * visitado-vs-planeado, idle, anomalías) quedan en null y las anexa Horus.1/.6.
 */
type Bucket = {
  visits: number;
  scoreSum: number;
  scoreCount: number;
  own: number;
  competitor: number;
  photoWith: number;
  photoTotal: number;
  levelSum: number; // H2.1: peso de nivel de ejecución acumulado
  levelCount: number;
  durSum: number; // H2.1: minutos de visita acumulados
  durCount: number;
  skuSum: number; // H2.1: productos marcados acumulados
  lastVisit: number; // epoch ms
};

type SubjectAgg = {
  label: string;
  w7: Bucket;
  w7prev: Bucket;
  w30: Bucket;
  w30prev: Bucket;
};

const DAY_MS = 86_400_000;
const round2 = (x: number) => Math.round(x * 100) / 100;
const emptyBucket = (): Bucket => ({
  visits: 0,
  scoreSum: 0,
  scoreCount: 0,
  own: 0,
  competitor: 0,
  photoWith: 0,
  photoTotal: 0,
  levelSum: 0,
  levelCount: 0,
  durSum: 0,
  durCount: 0,
  skuSum: 0,
  lastVisit: 0,
});

// Normaliza la rúbrica MIXTA de nivel de ejecución (audit 2026-06-17: conviven
// alto/medio/bajo/crítico con excelente/estandar/basico) a un peso 0..1.
const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const LEVEL_WEIGHT: Record<string, number> = {
  alto: 1,
  excelente: 1,
  medio: 0.6,
  estandar: 0.6,
  basico: 0.35,
  bajo: 0.3,
  critico: 0.1,
};
const levelWeight = (lvl: any): number | null => {
  if (!lvl) return null;
  const n = stripAccents(String(lvl).toLowerCase().trim());
  return n in LEVEL_WEIGHT ? LEVEL_WEIGHT[n] : null;
};

@Injectable()
export class Execution360Service {
  private readonly logger = new Logger(Execution360Service.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  private static parseArray(v: any): any[] {
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

  /** Lee el feature store (endpoint GET). Scoped por tenant explícito. */
  async list(filters: { subject_type?: string; window_days?: number }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.execution_360 as e').select('*');
    if (tenantId) q = q.where('e.tenant_id', tenantId);
    if (filters.subject_type) q = q.where('e.subject_type', filters.subject_type);
    if (filters.window_days) q = q.where('e.window_days', filters.window_days);
    q = q.orderBy('e.window_days', 'asc').orderBy('e.visits_done', 'desc');
    const rows = await q;
    return { rows, total: rows.length, computed_at: rows[0]?.computed_at ?? null };
  }

  /**
   * Computa el feature store de ejecución para UN tenant y hace UPSERT.
   * Trae 60 días de capturas (cubre las ventanas 7/30 + sus períodos previos
   * para el score_trend) y agrega en memoria por colaborador y por tienda.
   */
  async computeForTenant(tenantId: string): Promise<{ rows_upserted: number }> {
    if (!tenantId) return { rows_upserted: 0 };

    const now = Date.now();

    const caps = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .whereRaw("dc.hora_inicio >= now() - interval '60 days'")
      .select(
        'dc.user_id',
        'dc.captured_by_username',
        'dc.store_id',
        'dc.score_final_pct',
        'dc.hora_inicio',
        'dc.hora_fin',
        'dc.exhibiciones',
      );

    // Nombres de tienda para el label de subject_type='store'.
    const storeRows = await this.knex('stores')
      .where('tenant_id', tenantId)
      .whereNull('deleted_at')
      .select('id', 'nombre');
    const storeName = new Map<string, string>();
    storeRows.forEach((s: any) => storeName.set(s.id, s.nombre));

    const byCollaborator = new Map<string, SubjectAgg>();
    const byStore = new Map<string, SubjectAgg>();
    const ensure = (map: Map<string, SubjectAgg>, key: string, label: string): SubjectAgg => {
      let a = map.get(key);
      if (!a) {
        a = { label, w7: emptyBucket(), w7prev: emptyBucket(), w30: emptyBucket(), w30prev: emptyBucket() };
        map.set(key, a);
      }
      return a;
    };

    for (const r of caps) {
      const t = r.hora_inicio ? new Date(r.hora_inicio).getTime() : 0;
      const daysAgo = t > 0 ? (now - t) / DAY_MS : Infinity;
      const score = r.score_final_pct != null ? Number(r.score_final_pct) : null;

      const tEnd = r.hora_fin ? new Date(r.hora_fin).getTime() : 0;
      const durMin = t > 0 && tEnd > t ? (tEnd - t) / 60000 : null;

      let own = 0;
      let competitor = 0;
      let photoWith = 0;
      let photoTotal = 0;
      let levelSum = 0;
      let levelCount = 0;
      let skuSum = 0;
      for (const e of Execution360Service.parseArray(r.exhibiciones)) {
        photoTotal++;
        if (e.fotoUrl) photoWith++;
        if (e.perteneceMegaDulces === true) own++;
        else if (e.perteneceMegaDulces === false) competitor++;
        const lw = levelWeight(e.nivelEjecucion);
        if (lw != null) {
          levelSum += lw;
          levelCount++;
        }
        if (Array.isArray(e.productosMarcados)) skuSum += e.productosMarcados.length;
      }

      const apply = (b: Bucket) => {
        b.visits++;
        if (score != null) {
          b.scoreSum += score;
          b.scoreCount++;
        }
        b.own += own;
        b.competitor += competitor;
        b.photoWith += photoWith;
        b.photoTotal += photoTotal;
        b.levelSum += levelSum;
        b.levelCount += levelCount;
        b.skuSum += skuSum;
        if (durMin != null) {
          b.durSum += durMin;
          b.durCount++;
        }
        if (t > b.lastVisit) b.lastVisit = t;
      };

      const fan = (a: SubjectAgg) => {
        // w7 ⊂ w30 (ventanas independientes, no excluyentes); los "prev" sí lo son.
        if (daysAgo <= 7) apply(a.w7);
        else if (daysAgo <= 14) apply(a.w7prev);
        if (daysAgo <= 30) apply(a.w30);
        else if (daysAgo <= 60) apply(a.w30prev);
      };

      if (r.user_id) fan(ensure(byCollaborator, r.user_id, r.captured_by_username || 'Colaborador'));
      if (r.store_id) fan(ensure(byStore, r.store_id, storeName.get(r.store_id) || 'Tienda'));
    }

    const rows: any[] = [];
    const pushRows = (type: 'collaborator' | 'store', map: Map<string, SubjectAgg>) => {
      for (const [id, a] of map) {
        rows.push(this.buildRow(tenantId, type, id, 7, a.label, a.w7, a.w7prev, now));
        rows.push(this.buildRow(tenantId, type, id, 30, a.label, a.w30, a.w30prev, now));
      }
    };
    pushRows('collaborator', byCollaborator);
    pushRows('store', byStore);

    if (rows.length === 0) return { rows_upserted: 0 };

    await this.knex('commercial.execution_360')
      .insert(rows)
      .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
      .merge([
        'label',
        'visits_done',
        'avg_score',
        'score_trend',
        'own_share_pct',
        'competitor_share_pct',
        'photo_coverage_pct',
        'days_since_last_visit',
        'exec_level_score',
        'avg_visit_min',
        'avg_skus',
        'anomaly_count',
        'computed_at',
        'updated_at',
      ]);

    return { rows_upserted: rows.length };
  }

  /**
   * Snapshot append-only del feature store (1 row/sujeto/ventana/día). Se llama AL
   * FINAL del pipeline (post-scoring) para capturar también exec_score. El feature
   * store es UPSERT in-place y pisa el histórico; sin esto no hay base para tendencia
   * ni atribución hallazgo→resultado. Idempotente por día (UPSERT por fecha).
   */
  async snapshotForTenant(tenantId: string): Promise<{ snapshotted: number }> {
    if (!tenantId) return { snapshotted: 0 };
    const rows = await this.knex('commercial.execution_360')
      .where('tenant_id', tenantId)
      .select(
        'subject_type',
        'subject_id',
        'window_days',
        'label',
        'visits_done',
        'avg_score',
        'exec_score',
        'exec_level_score',
        'own_share_pct',
        'competitor_share_pct',
        'photo_coverage_pct',
        'days_since_last_visit',
      );
    if (rows.length === 0) return { snapshotted: 0 };

    const today = this.knex.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date`);
    const snap = rows.map((r: any) => ({ ...r, tenant_id: tenantId, snapshot_date: today }));
    await this.knex('commercial.execution_360_snapshots')
      .insert(snap)
      .onConflict(['tenant_id', 'snapshot_date', 'subject_type', 'subject_id', 'window_days'])
      .merge([
        'label',
        'visits_done',
        'avg_score',
        'exec_score',
        'exec_level_score',
        'own_share_pct',
        'competitor_share_pct',
        'photo_coverage_pct',
        'days_since_last_visit',
      ]);
    return { snapshotted: snap.length };
  }

  private buildRow(
    tenantId: string,
    subjectType: 'collaborator' | 'store',
    subjectId: string,
    windowDays: number,
    label: string,
    cur: Bucket,
    prev: Bucket,
    now: number,
  ): any {
    const avg = cur.scoreCount > 0 ? round2(cur.scoreSum / cur.scoreCount) : null;
    const avgPrev = prev.scoreCount > 0 ? prev.scoreSum / prev.scoreCount : null;
    const trend = avg != null && avgPrev != null ? round2(avg - avgPrev) : null;
    const ownComp = cur.own + cur.competitor;
    const ownShare = ownComp > 0 ? round2((cur.own / ownComp) * 100) : null;
    const compShare = ownComp > 0 ? round2((cur.competitor / ownComp) * 100) : null;
    const photoCov = cur.photoTotal > 0 ? round2((cur.photoWith / cur.photoTotal) * 100) : null;
    const daysSince = cur.lastVisit > 0 ? Math.floor((now - cur.lastVisit) / DAY_MS) : null;
    const execLevel = cur.levelCount > 0 ? round2((cur.levelSum / cur.levelCount) * 100) : null;
    const avgVisitMin = cur.durCount > 0 ? round2(cur.durSum / cur.durCount) : null;
    const avgSkus = cur.photoTotal > 0 ? round2(cur.skuSum / cur.photoTotal) : null;

    return {
      tenant_id: tenantId,
      subject_type: subjectType,
      subject_id: subjectId,
      window_days: windowDays,
      label: label ? label.slice(0, 160) : null,
      visits_done: cur.visits,
      visits_planned: 0, // Horus.1: integrar daily_assignments
      coverage_pct: null, // Horus.1
      avg_score: avg,
      score_trend: trend,
      idle_min_avg: null, // Horus.1: reusar ReportsService.getIdleSummary
      own_share_pct: ownShare,
      competitor_share_pct: compShare,
      photo_coverage_pct: photoCov,
      days_since_last_visit: daysSince,
      exec_level_score: execLevel, // H2.1
      avg_visit_min: avgVisitMin, // H2.1
      avg_skus: avgSkus, // H2.1
      anomaly_count: 0, // Horus.6
      computed_at: this.knex.fn.now(),
      updated_at: this.knex.fn.now(),
    };
  }
}
