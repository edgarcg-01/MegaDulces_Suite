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
  posSum: number; // K3: puntuación oficial de ubicación acumulada
  posCount: number;
  lastVisit: number; // epoch ms
};

// K1: bucket por concepto/ubicación (solo ventana 30d). 1 conteo por exhibición.
type CLBucket = {
  n: number;
  levelSum: number;
  levelCount: number;
  own: number;
  competitor: number;
  photoWith: number;
  photoTotal: number;
};
const emptyCL = (): CLBucket => ({
  n: 0,
  levelSum: 0,
  levelCount: 0,
  own: 0,
  competitor: 0,
  photoWith: 0,
  photoTotal: 0,
});

type SubjectAgg = {
  label: string;
  w7: Bucket;
  w7prev: Bucket;
  w30: Bucket;
  w30prev: Bucket;
  concepts: Map<string, CLBucket>; // K1: por conceptoId (30d)
  locations: Map<string, CLBucket>; // K1: por ubicacionId (30d)
  markedPlano: Set<string>; // K4: product_ids del planograma exhibidos (30d, distintos)
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
  posSum: 0,
  posCount: 0,
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

  /**
   * Envuelve un read OPCIONAL en SAVEPOINT: si falla dentro de la trx del request no
   * la envenena (25P02), cae a null. Sin trx (cron pooled) corre plano. Ver
   * feedback_global_request_tx_25p02.
   */
  private async safeQuery<T>(fn: () => Promise<T>): Promise<T | null> {
    let sp = false;
    try {
      await this.knex.raw('SAVEPOINT horus_e360');
      sp = true;
    } catch {
      /* sin trx activa */
    }
    try {
      const r = await fn();
      if (sp) await this.knex.raw('RELEASE SAVEPOINT horus_e360');
      return r;
    } catch (e: any) {
      if (sp) {
        try {
          await this.knex.raw('ROLLBACK TO SAVEPOINT horus_e360');
        } catch {
          /* noop */
        }
      }
      this.logger.debug(`safeQuery opcional falló: ${e.message}`);
      return null;
    }
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

    // K6: mapa de usuarios (zona/supervisor del colaborador) + nombres de zona, para
    // el roll-up org. users/zones son vistas passthrough resolubles vía KNEX_CONNECTION.
    const userInfo = new Map<string, { zona_id: string | null; supervisor_id: string | null; name: string }>();
    const userName = new Map<string, string>();
    const userRows = await this.knex('users')
      .where('tenant_id', tenantId)
      .select('id', 'nombre', 'username', 'zona_id', 'supervisor_id');
    userRows.forEach((u: any) => {
      const nm = u.nombre || u.username || 'Usuario';
      userInfo.set(u.id, { zona_id: u.zona_id, supervisor_id: u.supervisor_id, name: nm });
      userName.set(u.id, nm);
    });
    const zoneName = new Map<string, string>();
    const zoneRows = await this.knex('zones').where('tenant_id', tenantId).select('id', 'name');
    zoneRows.forEach((z: any) => zoneName.set(z.id, z.name));

    // K1: nombres de concepto/ubicación (catalogs.value) para el desglose. Best-effort
    // con SAVEPOINT — `catalogs` puede no resolver en prod (schema/search_path) y esto
    // corre PRIMERO en /compute; sin el savepoint, un fallo envenenaría toda la trx (25P02).
    const catName = new Map<string, string>();
    const ubiWeight = new Map<string, number>(); // K3: peso oficial de la ubicación (catalogs.puntuacion)
    const catRows =
      (await this.safeQuery(() =>
        this.knex('catalogs')
          .whereIn('catalog_id', ['conceptos', 'ubicaciones'])
          .whereNull('deleted_at')
          .select('id', 'value', 'puntuacion', 'catalog_id'),
      )) || [];
    catRows.forEach((c: any) => {
      catName.set(c.id, c.value);
      if (c.catalog_id === 'ubicaciones' && c.puntuacion != null) ubiWeight.set(c.id, Number(c.puntuacion));
    });

    // K4: planograma activo del tenant (product_ids) para medir adherencia. safeQuery
    // por si trade.planogram_skus no resuelve en prod (corre en /compute → anti-25P02).
    const planoRows =
      (await this.safeQuery(() =>
        this.knex('trade.planogram_skus').whereNull('deleted_at').select('product_id'),
      )) || [];
    const planogramSet = new Set<string>(planoRows.map((p: any) => String(p.product_id)));
    const planogramTotal = planogramSet.size;

    const byCollaborator = new Map<string, SubjectAgg>();
    const byStore = new Map<string, SubjectAgg>();
    const byZone = new Map<string, SubjectAgg>(); // K6
    const bySupervisor = new Map<string, SubjectAgg>(); // K6
    const ensure = (map: Map<string, SubjectAgg>, key: string, label: string): SubjectAgg => {
      let a = map.get(key);
      if (!a) {
        a = {
          label,
          w7: emptyBucket(),
          w7prev: emptyBucket(),
          w30: emptyBucket(),
          w30prev: emptyBucket(),
          concepts: new Map(),
          locations: new Map(),
          markedPlano: new Set(),
        };
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
      let posSum = 0; // K3: puntuación oficial de la ubicación
      let posCount = 0;
      // K1: detalle por exhibición (concepto/ubicación) para el desglose 30d.
      const exDetails: {
        cid?: string;
        lid?: string;
        lw: number | null;
        own: boolean;
        comp: boolean;
        photo: boolean;
      }[] = [];
      const capMarked = new Set<string>(); // K4: product_ids marcados en esta captura
      for (const e of Execution360Service.parseArray(r.exhibiciones)) {
        photoTotal++;
        const hasPhoto = !!e.fotoUrl;
        if (hasPhoto) photoWith++;
        const isOwn = e.perteneceMegaDulces === true;
        const isComp = e.perteneceMegaDulces === false;
        if (isOwn) own++;
        else if (isComp) competitor++;
        const lw = levelWeight(e.nivelEjecucion);
        if (lw != null) {
          levelSum += lw;
          levelCount++;
        }
        const uw = e.ubicacionId ? ubiWeight.get(e.ubicacionId) : undefined; // K3
        if (uw != null) {
          posSum += uw;
          posCount++;
        }
        if (Array.isArray(e.productosMarcados)) {
          skuSum += e.productosMarcados.length;
          for (const pid of e.productosMarcados) capMarked.add(String(pid));
        }
        exDetails.push({ cid: e.conceptoId, lid: e.ubicacionId, lw, own: isOwn, comp: isComp, photo: hasPhoto });
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
        b.posSum += posSum; // K3
        b.posCount += posCount;
        if (durMin != null) {
          b.durSum += durMin;
          b.durCount++;
        }
        if (t > b.lastVisit) b.lastVisit = t;
      };

      // K1: acumula el detalle por exhibición en un bucket concepto/ubicación.
      const bumpCL = (map: Map<string, CLBucket>, key: string, d: (typeof exDetails)[number]) => {
        let b = map.get(key);
        if (!b) {
          b = emptyCL();
          map.set(key, b);
        }
        b.n++;
        if (d.lw != null) {
          b.levelSum += d.lw;
          b.levelCount++;
        }
        if (d.own) b.own++;
        else if (d.comp) b.competitor++;
        b.photoTotal++;
        if (d.photo) b.photoWith++;
      };

      const fan = (a: SubjectAgg) => {
        // w7 ⊂ w30 (ventanas independientes, no excluyentes); los "prev" sí lo son.
        if (daysAgo <= 7) apply(a.w7);
        else if (daysAgo <= 14) apply(a.w7prev);
        if (daysAgo <= 30) {
          apply(a.w30);
          for (const d of exDetails) {
            if (d.cid) bumpCL(a.concepts, d.cid, d);
            if (d.lid) bumpCL(a.locations, d.lid, d);
          }
          for (const pid of capMarked) if (planogramSet.has(pid)) a.markedPlano.add(pid); // K4
        } else if (daysAgo <= 60) apply(a.w30prev);
      };

      if (r.user_id) {
        fan(ensure(byCollaborator, r.user_id, r.captured_by_username || 'Colaborador'));
        // K6: la misma captura sube a la zona y al supervisor del colaborador.
        const ui = userInfo.get(r.user_id);
        if (ui?.zona_id) fan(ensure(byZone, ui.zona_id, zoneName.get(ui.zona_id) || 'Zona'));
        if (ui?.supervisor_id) fan(ensure(bySupervisor, ui.supervisor_id, userName.get(ui.supervisor_id) || 'Supervisor'));
      }
      if (r.store_id) fan(ensure(byStore, r.store_id, storeName.get(r.store_id) || 'Tienda'));
    }

    const rows: any[] = [];
    const pushRows = (
      type: 'collaborator' | 'store' | 'zone' | 'supervisor',
      map: Map<string, SubjectAgg>,
      withDetail = true, // org (zone/supervisor) NO lleva by_concept/planograma (detalle por-sujeto)
    ) => {
      for (const [id, a] of map) {
        rows.push(this.buildRow(tenantId, type, id, 7, a.label, a.w7, a.w7prev, now, null, null, catName, null, 0));
        rows.push(
          this.buildRow(
            tenantId,
            type,
            id,
            30,
            a.label,
            a.w30,
            a.w30prev,
            now,
            withDetail ? a.concepts : null,
            withDetail ? a.locations : null,
            catName,
            withDetail ? a.markedPlano : null,
            withDetail ? planogramTotal : 0,
          ),
        );
      }
    };
    pushRows('collaborator', byCollaborator);
    pushRows('store', byStore);
    pushRows('zone', byZone, false); // K6
    pushRows('supervisor', bySupervisor, false); // K6

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
        'by_concept',
        'by_location',
        'planogram_present',
        'planogram_total',
        'position_quality',
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
    subjectType: 'collaborator' | 'store' | 'zone' | 'supervisor',
    subjectId: string,
    windowDays: number,
    label: string,
    cur: Bucket,
    prev: Bucket,
    now: number,
    concepts?: Map<string, CLBucket> | null,
    locations?: Map<string, CLBucket> | null,
    catName?: Map<string, string>,
    markedPlano?: Set<string> | null,
    planogramTotal?: number,
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
    const positionQuality = cur.posCount > 0 ? round2(cur.posSum / cur.posCount) : null; // K3

    // K1: desglose por concepto/ubicación (solo 30d; null en 7d).
    const clToJson = (m?: Map<string, CLBucket> | null): string | null => {
      if (!m || m.size === 0) return null;
      const o: Record<string, any> = {};
      for (const [id, b] of m) {
        const oc = b.own + b.competitor;
        o[id] = {
          label: catName?.get(id) || null,
          n: b.n,
          level_avg: b.levelCount > 0 ? round2((b.levelSum / b.levelCount) * 100) : null,
          own_share_pct: oc > 0 ? round2((b.own / oc) * 100) : null,
          photo_pct: b.photoTotal > 0 ? round2((b.photoWith / b.photoTotal) * 100) : null,
        };
      }
      return JSON.stringify(o);
    };
    const byConcept = clToJson(concepts);
    const byLocation = clToJson(locations);

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
      by_concept: byConcept, // K1
      by_location: byLocation, // K1
      planogram_present: markedPlano ? markedPlano.size : null, // K4
      planogram_total: markedPlano && planogramTotal ? planogramTotal : null, // K4
      position_quality: positionQuality, // K3
      anomaly_count: 0, // Horus.6
      computed_at: this.knex.fn.now(),
      updated_at: this.knex.fn.now(),
    };
  }
}
