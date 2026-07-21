import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Motor de MEJORAS (Sprint H2.5).
 *
 * Hermano del FindingsEngine, pero al revés: el FindingsEngine detecta PROBLEMAS;
 * este propone OPORTUNIDADES de mejora concretas y accionables. CERO LLM: el motor
 * DECIDE con reglas explicables sobre el feature store + el detalle crudo de
 * capturas; el agente (Horus.2) solo redacta.
 *
 * Emite acciones `kind='opportunity'` a commercial.supervisor_actions (mismo buzón
 * del co-piloto: pending_approval → el supervisor aprueba/rechaza, y al aprobar el
 * ejecutor real crea la tarea/nota — ADR-020).
 *
 * Reglas v1 (defendibles con la data de hoy; degradan con gracia si falta):
 *   - coaching_focus     (collaborator): diagnostica la DEBILIDAD concreta (foto /
 *                        nivel de ejecución Bajo-Crítico / score / caída) y enfoca el coaching.
 *   - recover_shelf      (store): competencia domina el exhibidor → sugiere un
 *                        producto propio CONCRETO (whitespace de la ruta que falta en la tienda).
 *   - reprioritize_route (route): >=2 tiendas de la ruta sin visita → plan de mañana.
 *   - replicate_best     (collaborator): mejor ejecutor → reconocer/replicar (positivo).
 *
 * Lee vía KNEX_CONNECTION (superuser) + tenant_id explícito, igual que el resto de Horus.
 */
const MIN_OBS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: any, d: number) => (v != null && !isNaN(Number(v)) ? Number(v) : d);
const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const isLowLevel = (lvl: any): boolean => {
  if (!lvl) return false;
  const n = stripAccents(String(lvl).toLowerCase());
  return n.includes('bajo') || n.includes('critico');
};

type Thresholds = {
  score_min_pct: number;
  score_drop_pct: number;
  competitor_dominance_pct: number;
  days_no_visit_max: number;
};

@Injectable()
export class OpportunityEngineService {
  private readonly logger = new Logger(OpportunityEngineService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  /** Haversine en metros (ACT.2 reorden / ACT.3 ruta sugerida). */
  private static haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /**
   * ACT.2 — orden de visita por vecino-más-cercano (Haversine). Seed = el de menor
   * visit_sequence actual (o el primero). Los clientes SIN coords conservan su orden
   * relativo al final. Devuelve los ids en el orden propuesto.
   */
  private static nnOrder(
    custs: { id: string; latitude: any; longitude: any; visit_sequence: any }[],
  ): string[] {
    const geo = custs
      .filter((c) => c.latitude != null && c.longitude != null)
      .map((c) => ({ id: c.id, lat: Number(c.latitude), lng: Number(c.longitude), seq: c.visit_sequence }));
    const noGeo = custs.filter((c) => c.latitude == null || c.longitude == null);
    if (geo.length <= 2) return custs.map((c) => c.id); // nada que optimizar
    geo.sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999));
    const remaining = [...geo];
    const order = [remaining.shift()!];
    while (remaining.length) {
      const last = order[order.length - 1];
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = OpportunityEngineService.haversine(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      order.push(remaining.splice(bi, 1)[0]);
    }
    return [...order.map((c) => c.id), ...noGeo.map((c) => c.id)];
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

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /** Km de un recorrido (suma de tramos haversine consecutivos). */
  private static legKm(pts: { lat: number; lng: number }[]): number {
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      m += OpportunityEngineService.haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    }
    return Math.round((m / 1000) * 100) / 100;
  }

  /**
   * ACT.2/ACT.3 (mapa "rutas reconvertidas"): distancia actual vs óptima por ruta.
   * Read-only para el mapa — NO escribe visit_sequence (eso es el approve del co-piloto).
   */
  async listRouteOptimizations(user: any): Promise<{ routes: any[] }> {
    const tenantId = this.tenantId(user);
    if (!tenantId) return { routes: [] };
    const custs = await this.knex('commercial.customers')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereNotNull('sales_route')
      .select('id', 'name', 'sales_route', 'latitude', 'longitude', 'visit_sequence');

    const acts = await this.knex('commercial.supervisor_actions')
      .where({ tenant_id: tenantId, action_type: 'reprioritize_route', status: 'pending_approval' })
      .select('payload');
    const withAction = new Set<string>();
    for (const a of acts) {
      const p = typeof a.payload === 'string' ? (() => { try { return JSON.parse(a.payload); } catch { return {}; } })() : a.payload || {};
      if (p?.sales_route) withAction.add(String(p.sales_route));
    }

    const byRoute = new Map<string, any[]>();
    for (const c of custs) {
      const k = String(c.sales_route);
      if (!byRoute.has(k)) byRoute.set(k, []);
      byRoute.get(k)!.push(c);
    }

    const routes: any[] = [];
    for (const [sr, arr] of byRoute) {
      const geo = arr.filter((c) => c.latitude != null && c.longitude != null);
      if (geo.length < 2) continue; // no hay recorrido que medir
      const m = this.routeMetrics(arr);
      routes.push({
        sales_route: sr,
        customers: arr.length,
        geolocated: geo.length,
        current_km: m.current_km,
        proposed_km: m.proposed_km,
        improvement_pct: m.improvement_pct,
        has_action: withAction.has(sr),
      });
    }
    routes.sort((a, b) => b.improvement_pct - a.improvement_pct);
    return { routes };
  }

  /** Detalle para el mapa: orden actual, orden propuesto (NN), oportunidades cercanas y métricas. */
  async routeOptimizationDetail(user: any, salesRoute: string): Promise<any> {
    const tenantId = this.tenantId(user);
    const sr = (salesRoute || '').trim();
    if (!tenantId || !sr) return { sales_route: sr, current: [], proposed: [], opportunities: [], metrics: null };

    const arr = await this.knex('commercial.customers')
      .where({ tenant_id: tenantId, sales_route: sr })
      .whereNull('deleted_at')
      .select('id', 'name', 'latitude', 'longitude', 'visit_sequence');

    const byId = new Map(arr.map((c: any) => [c.id, c]));
    const currentOrdered = arr
      .slice()
      .sort((a: any, b: any) => (a.visit_sequence ?? 9999) - (b.visit_sequence ?? 9999) || String(a.name).localeCompare(String(b.name)));
    const proposedIds = OpportunityEngineService.nnOrder(arr as any);

    const toPt = (c: any, seq: number) => ({
      id: c.id,
      name: c.name,
      seq,
      lat: c.latitude != null ? Number(c.latitude) : null,
      lng: c.longitude != null ? Number(c.longitude) : null,
    });
    const current = currentOrdered.map((c: any, i: number) => toPt(c, i + 1));
    const proposed = proposedIds.map((id: string, i: number) => toPt(byId.get(id), i + 1));

    // Oportunidades DENUE cercanas a la ruta (candidate a ≤3km de algún cliente).
    const geoCust = arr.filter((c: any) => c.latitude != null && c.longitude != null);
    let opportunities: any[] = [];
    const prospects =
      (await this.safeQuery(() =>
        this.knex('commercial.prospect_stores')
          .where({ tenant_id: tenantId, status: 'candidate' })
          .whereNotNull('lat')
          .whereNotNull('lng')
          .select('id', 'nombre', 'lat', 'lng', 'scian_label', 'whitespace_score'),
      )) || [];
    for (const p of prospects) {
      let nearest = Infinity;
      for (const c of geoCust) {
        const d = OpportunityEngineService.haversine(+p.lat, +p.lng, +c.latitude, +c.longitude);
        if (d < nearest) nearest = d;
      }
      if (nearest <= 3000) {
        opportunities.push({
          prospect_id: p.id,
          name: p.nombre,
          lat: Number(p.lat),
          lng: Number(p.lng),
          scian_label: p.scian_label,
          whitespace_score: p.whitespace_score != null ? Number(p.whitespace_score) : null,
          nearest_customer_m: Math.round(nearest),
        });
      }
    }
    opportunities = opportunities.sort((a, b) => (b.whitespace_score || 0) - (a.whitespace_score || 0)).slice(0, 15);

    return { sales_route: sr, current, proposed, opportunities, metrics: this.routeMetrics(arr) };
  }

  /** Km actual (por visit_sequence) vs propuesto (NN) sobre los clientes geolocalizados. */
  private routeMetrics(arr: any[]): { current_km: number; proposed_km: number; improvement_pct: number; stops: number } {
    const byId = new Map(arr.map((c: any) => [c.id, c]));
    const currentGeo = arr
      .slice()
      .sort((a: any, b: any) => (a.visit_sequence ?? 9999) - (b.visit_sequence ?? 9999) || String(a.name).localeCompare(String(b.name)))
      .filter((c: any) => c.latitude != null && c.longitude != null)
      .map((c: any) => ({ lat: Number(c.latitude), lng: Number(c.longitude) }));
    const proposedGeo = OpportunityEngineService.nnOrder(arr as any)
      .map((id: string) => byId.get(id))
      .filter((c: any) => c && c.latitude != null && c.longitude != null)
      .map((c: any) => ({ lat: Number(c.latitude), lng: Number(c.longitude) }));
    const current_km = OpportunityEngineService.legKm(currentGeo);
    const proposed_km = OpportunityEngineService.legKm(proposedGeo);
    const improvement_pct = current_km > 0 ? Math.round(((current_km - proposed_km) / current_km) * 1000) / 10 : 0;
    return { current_km, proposed_km, improvement_pct, stops: currentGeo.length };
  }

  private async getThresholds(tenantId: string): Promise<Thresholds> {
    const row = await this.knex('commercial.execution_thresholds').where('tenant_id', tenantId).first();
    return {
      score_min_pct: num(row?.score_min_pct, 25),
      score_drop_pct: num(row?.score_drop_pct, 8),
      competitor_dominance_pct: num(row?.competitor_dominance_pct, 70),
      days_no_visit_max: num(row?.days_no_visit_max, 14),
    };
  }

  /**
   * Ejecuta un query OPCIONAL (enriquecimiento best-effort) sin envenenar la trx del
   * request. El TenantContextInterceptor envuelve cada request autenticada en UNA trx;
   * si un query falla, la trx queda abortada y TODO lo siguiente tira 25P02 ("current
   * transaction is aborted") — aunque el error se haya atrapado. Un SAVEPOINT aísla el
   * fallo (ROLLBACK al savepoint, no a toda la trx). Si no estamos en trx (cron, conexión
   * pooled) el SAVEPOINT no aplica y caemos a query plano. Ver feedback_global_request_tx_25p02.
   */
  private async safeQuery<T>(fn: () => Promise<T>): Promise<T | null> {
    let sp = false;
    try {
      await this.knex.raw('SAVEPOINT horus_opt');
      sp = true;
    } catch {
      /* no estamos dentro de una transacción */
    }
    try {
      const r = await fn();
      if (sp) await this.knex.raw('RELEASE SAVEPOINT horus_opt');
      return r;
    } catch (e: any) {
      if (sp) {
        try {
          await this.knex.raw('ROLLBACK TO SAVEPOINT horus_opt');
        } catch {
          /* noop */
        }
      }
      this.logger.debug(`safeQuery opcional falló: ${e.message}`);
      return null;
    }
  }

  /**
   * Genera/actualiza las oportunidades de mejora para UN tenant. Lo invoca el
   * refresh tras proponer acciones de findings (y el endpoint /compute).
   */
  async generateForTenant(tenantId: string): Promise<{ proposed: number; expired: number }> {
    if (!tenantId) return { proposed: 0, expired: 0 };
    const th = await this.getThresholds(tenantId);

    // Feature store, indexado por sujeto/ventana.
    const fs = await this.knex('commercial.execution_360').where('tenant_id', tenantId).select('*');
    const collab30 = new Map<string, any>();
    const collab7 = new Map<string, any>();
    const store30 = new Map<string, any>();
    for (const r of fs) {
      if (r.subject_type === 'collaborator') {
        (Number(r.window_days) === 7 ? collab7 : collab30).set(r.subject_id, r);
      } else if (r.subject_type === 'store' && Number(r.window_days) === 30) {
        store30.set(r.subject_id, r);
      }
    }

    // Detalle crudo (60d) para diagnóstico fino: mix de nivel por colaborador,
    // productos propios por tienda y por ruta (para el whitespace de recover_shelf).
    const caps = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .whereRaw("dc.hora_inicio >= now() - interval '60 days'")
      .select('dc.user_id', 'dc.store_id', 'dc.exhibiciones');

    const stores = await this.knex('stores')
      .where('tenant_id', tenantId)
      .whereNull('deleted_at')
      .select('id', 'nombre', 'ruta_id');
    const storeMap = new Map<string, any>();
    stores.forEach((s: any) => storeMap.set(s.id, s));

    const lvlByCollab = new Map<string, { low: number; total: number }>();
    const ownByStore = new Map<string, Map<string, number>>();
    const ownByRoute = new Map<string, Map<string, number>>();
    const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

    for (const c of caps) {
      const exhibs = OpportunityEngineService.parseArray(c.exhibiciones);
      if (c.user_id) {
        let agg = lvlByCollab.get(c.user_id);
        if (!agg) {
          agg = { low: 0, total: 0 };
          lvlByCollab.set(c.user_id, agg);
        }
        for (const e of exhibs) {
          agg.total++;
          if (isLowLevel(e.nivelEjecucion)) agg.low++;
        }
      }
      const routeId = c.store_id ? storeMap.get(c.store_id)?.ruta_id : null;
      for (const e of exhibs) {
        if (e.perteneceMegaDulces !== true) continue;
        const prods = Array.isArray(e.productosMarcados) ? e.productosMarcados : [];
        for (const p of prods) {
          if (typeof p !== 'string' || !UUID_RE.test(p)) continue;
          if (c.store_id) {
            let m = ownByStore.get(c.store_id);
            if (!m) {
              m = new Map();
              ownByStore.set(c.store_id, m);
            }
            inc(m, p);
          }
          if (routeId) {
            let m = ownByRoute.get(routeId);
            if (!m) {
              m = new Map();
              ownByRoute.set(routeId, m);
            }
            inc(m, p);
          }
        }
      }
    }

    const opps: any[] = [];
    const add = (
      actionType: string,
      subjectType: string,
      subjectId: string,
      title: string,
      rationale: string,
      payload: any,
      label: any,
    ) => {
      opps.push({
        tenant_id: tenantId,
        finding_id: null,
        dedup_key: `opp:${actionType}:${subjectType}:${subjectId}`,
        action_type: actionType,
        kind: 'opportunity',
        subject_type: subjectType,
        subject_id: subjectId,
        label: label ? String(label).slice(0, 160) : null,
        title: String(title).slice(0, 300),
        rationale: rationale ? String(rationale).slice(0, 2000) : null,
        payload: JSON.stringify(payload || {}),
        proposed_by: 'horus',
        status: 'pending_approval',
      });
    };

    // ── coaching_focus: la debilidad más pronunciada del colaborador ──
    for (const [userId, r] of collab30) {
      const visits = num(r.visits_done, 0);
      if (visits < MIN_OBS) continue;
      const avg = r.avg_score != null ? Number(r.avg_score) : null;
      const photo = r.photo_coverage_pct != null ? Number(r.photo_coverage_pct) : null;
      const r7 = collab7.get(userId);
      const trend7 = r7?.score_trend != null ? Number(r7.score_trend) : null;
      const lvl = lvlByCollab.get(userId);
      const lowPct = lvl && lvl.total > 0 ? Math.round((lvl.low / lvl.total) * 100) : null;
      const scoreGoal = Math.round(th.score_min_pct * 1.6);

      const weaknesses: { cat: string; sev: number; msg: string }[] = [];
      if (photo != null && photo < 60)
        weaknesses.push({ cat: 'photo', sev: 60 - photo, msg: `Solo ${photo}% de exhibiciones con foto. Exigir evidencia fotográfica en cada visita.` });
      if (lowPct != null && lowPct > 35)
        weaknesses.push({ cat: 'execution', sev: lowPct, msg: `${lowPct}% de exhibiciones en nivel Bajo/Crítico. Acompañar en ruta para subir la calidad de ejecución.` });
      if (avg != null && avg < th.score_min_pct * 1.6)
        weaknesses.push({ cat: 'score', sev: th.score_min_pct * 1.6 - avg, msg: `Score promedio ${avg}% (objetivo ≥ ${scoreGoal}%). Repasar criterios de exhibición.` });
      if (trend7 != null && trend7 <= -th.score_drop_pct)
        weaknesses.push({ cat: 'score', sev: -trend7 + 5, msg: `Score cayó ${Math.abs(trend7)} pts esta semana. Acompañamiento inmediato en ruta.` });

      if (!weaknesses.length) continue;
      weaknesses.sort((a, b) => b.sev - a.sev);
      const top = weaknesses[0];
      const focusLabel = top.cat === 'photo' ? 'foto' : top.cat === 'execution' ? 'nivel de ejecución' : 'score';
      add(
        'coaching_focus',
        'collaborator',
        userId,
        `Coaching enfocado a ${r.label || 'colaborador'}: ${focusLabel}`,
        top.msg,
        { category: top.cat, avg_score: avg, photo_coverage_pct: photo, low_level_pct: lowPct, score_trend: trend7 },
        r.label,
      );
    }

    // ── recover_shelf: competencia domina → producto propio concreto (whitespace) ──
    const suggestedProductIds = new Set<string>();
    const recoverDraft: { storeId: string; r: any; compShare: number; productId: string | null }[] = [];
    for (const [storeId, r] of store30) {
      const visits = num(r.visits_done, 0);
      if (visits < MIN_OBS) continue;
      const comp = r.competitor_share_pct != null ? Number(r.competitor_share_pct) : null;
      if (comp == null || comp < th.competitor_dominance_pct) continue;
      const routeId = storeMap.get(storeId)?.ruta_id || null;
      let productId: string | null = null;
      const routeOwn = routeId ? ownByRoute.get(routeId) : null;
      const storeOwn = ownByStore.get(storeId) || new Map();
      if (routeOwn) {
        let best: [string, number] | null = null;
        for (const [pid, cnt] of routeOwn) {
          if (storeOwn.has(pid)) continue; // ya está en la tienda → no es whitespace
          if (!best || cnt > best[1]) best = [pid, cnt];
        }
        if (best) {
          productId = best[0];
          suggestedProductIds.add(productId);
        }
      }
      recoverDraft.push({ storeId, r, compShare: comp, productId });
    }

    // Nombre de los productos sugeridos (best-effort; si falla, degrada a genérico).
    const prodName = new Map<string, string>();
    if (suggestedProductIds.size) {
      const rows = await this.safeQuery(() =>
        this.knex('catalog.products').whereIn('id', [...suggestedProductIds]).select('id', 'nombre'),
      );
      (rows || []).forEach((p: any) => prodName.set(p.id, p.nombre));
    }
    for (const d of recoverDraft) {
      const pname = d.productId ? prodName.get(d.productId) : null;
      const rationale = pname
        ? `La competencia ocupa ${d.compShare}% del exhibidor. Empujar "${pname}": es propio y rota en la ruta, pero falta en esta tienda.`
        : `La competencia ocupa ${d.compShare}% del exhibidor. Visita enfocada para recuperar espacio con un SKU propio de alta rotación.`;
      add(
        'recover_shelf',
        'store',
        d.storeId,
        `Recuperar anaquel en ${d.r.label || 'tienda'} (competencia ${d.compShare}%)`,
        rationale,
        { competitor_share_pct: d.compShare, suggested_product_id: d.productId, suggested_product_name: pname || null, store_id: d.storeId },
        d.r.label,
      );
    }

    // ── reprioritize_route: rutas con >=2 tiendas sin visita ──
    const routeRisk = new Map<string, { id: string; name: string; days: number }[]>();
    for (const [storeId, r] of store30) {
      const days = r.days_since_last_visit != null ? Number(r.days_since_last_visit) : null;
      if (days == null || days <= th.days_no_visit_max) continue;
      const routeId = storeMap.get(storeId)?.ruta_id;
      if (!routeId) continue;
      let arr = routeRisk.get(routeId);
      if (!arr) {
        arr = [];
        routeRisk.set(routeId, arr);
      }
      arr.push({ id: storeId, name: r.label || 'Tienda', days });
    }
    const routeNames = new Map<string, string>();
    if (routeRisk.size) {
      const rows = await this.safeQuery(() =>
        this.knex('catalogs').whereIn('id', [...routeRisk.keys()]).select('id', 'value'),
      );
      (rows || []).forEach((c: any) => routeNames.set(c.id, c.value));
    }
    for (const [routeId, arr] of routeRisk) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => b.days - a.days);
      const top = arr.slice(0, 5);
      const rname = routeNames.get(routeId) || 'ruta';

      // ACT.2: orden de visita óptimo (NN-Haversine) sobre los clientes de la ruta.
      // `sales_route` (= catalogs.value) matchea `commercial.customers.sales_route`.
      // Best-effort: si no hay ≥3 clientes geolocalizados, no adjuntamos orden y el
      // ejecutor cae a la tarea de repriorización (comportamiento previo).
      const custs =
        (await this.safeQuery(() =>
          this.knex('commercial.customers')
            .where({ tenant_id: tenantId, sales_route: rname })
            .whereNull('deleted_at')
            .select('id', 'name', 'latitude', 'longitude', 'visit_sequence'),
        )) || [];
      const geoCount = custs.filter((c: any) => c.latitude != null && c.longitude != null).length;
      let proposedOrder: Array<{ id: string; name: string; seq: number }> | null = null;
      if (geoCount > 2) {
        const orderedIds = OpportunityEngineService.nnOrder(custs as any);
        const byId = new Map(custs.map((c: any) => [c.id, c]));
        proposedOrder = orderedIds.map((id, i) => ({ id, name: byId.get(id)?.name || '—', seq: i + 1 }));
      }
      const rationale =
        `${arr.length} tiendas de la ruta superan ${th.days_no_visit_max} días sin visita. Priorizar mañana: ${top
          .map((s) => s.name)
          .join(', ')}.` +
        (proposedOrder ? ` Reordena ${proposedOrder.length} paradas por cercanía al aprobar.` : '');
      add(
        'reprioritize_route',
        'route',
        routeId,
        `Repriorizar ${rname}: ${arr.length} tiendas sin visita`,
        rationale,
        {
          route_id: routeId,
          sales_route: rname,
          stores: top,
          threshold: th.days_no_visit_max,
          proposed_order: proposedOrder,
          current_order: proposedOrder
            ? custs
                .slice()
                .sort(
                  (a: any, b: any) =>
                    (a.visit_sequence ?? 9999) - (b.visit_sequence ?? 9999),
                )
                .map((c: any) => ({ id: c.id, name: c.name }))
            : null,
        },
        rname,
      );
    }

    // ── replicate_best: el mejor ejecutor del período (positivo) ──
    let best: any = null;
    for (const [, r] of collab30) {
      const visits = num(r.visits_done, 0);
      const avg = r.avg_score != null ? Number(r.avg_score) : null;
      if (visits < MIN_OBS || avg == null) continue;
      if (!best || avg > Number(best.avg_score)) best = r;
    }
    if (best && Number(best.avg_score) >= 60) {
      add(
        'replicate_best',
        'collaborator',
        best.subject_id,
        `Reconocer y replicar a ${best.label || 'colaborador'} (score ${best.avg_score}%)`,
        `Mejor ejecución del período (${best.avg_score}% en ${best.visits_done} visitas). Reconocer y compartir su método con el equipo.`,
        { avg_score: Number(best.avg_score), visits: Number(best.visits_done) },
        best.label,
      );
    }

    // ── add_opportunity_store (ACT.3): prospecto DENUE de alto whitespace sin cobertura ──
    // Degrada con gracia si el módulo DENUE no está presente (safeQuery → null → []).
    const prospects =
      (await this.safeQuery(() =>
        this.knex('commercial.prospect_stores')
          .where({ tenant_id: tenantId, status: 'candidate' })
          .whereNotNull('lat')
          .whereNotNull('lng')
          .andWhere('whitespace_score', '>=', 60)
          .orderBy('whitespace_score', 'desc')
          .limit(3)
          .select('id', 'nombre', 'lat', 'lng', 'scian_label', 'whitespace_score', 'calle', 'num_ext', 'colonia', 'municipio'),
      )) || [];
    if (prospects.length) {
      // Ruta sugerida = sales_route del cliente propio geolocalizado más cercano.
      const geoCusts =
        (await this.safeQuery(() =>
          this.knex('commercial.customers')
            .where({ tenant_id: tenantId })
            .whereNull('deleted_at')
            .whereNotNull('latitude')
            .whereNotNull('longitude')
            .whereNotNull('sales_route')
            .select('latitude', 'longitude', 'sales_route'),
        )) || [];
      for (const p of prospects) {
        let bestRoute: string | null = null;
        let bd = Infinity;
        for (const c of geoCusts) {
          const d = OpportunityEngineService.haversine(+p.lat, +p.lng, +c.latitude, +c.longitude);
          if (d < bd) {
            bd = d;
            bestRoute = c.sales_route;
          }
        }
        const addr = [p.calle, p.num_ext, p.colonia, p.municipio].filter(Boolean).join(' ');
        add(
          'add_opportunity_store',
          'prospect',
          p.id,
          `Alta de oportunidad: ${p.nombre || 'PdV'} (score ${Math.round(Number(p.whitespace_score))})`,
          `PdV de INEGI sin cobertura${bestRoute ? `, cerca de ${bestRoute}` : ''}${
            p.scian_label ? ` · ${p.scian_label}` : ''
          }. Darlo de alta como cliente pedible al aprobar.`,
          {
            prospect_id: p.id,
            name: p.nombre,
            lat: +p.lat,
            lng: +p.lng,
            scian_label: p.scian_label,
            whitespace_score: Number(p.whitespace_score),
            suggested_sales_route: bestRoute,
            address: addr,
            nearest_customer_m: isFinite(bd) ? Math.round(bd) : null,
          },
          p.nombre,
        );
      }
    }

    // UPSERT (respeta decisiones humanas) + expira las pending que ya no aplican.
    const keys = opps.map((o) => o.dedup_key);
    if (opps.length > 0) {
      await this.knex('commercial.supervisor_actions')
        .insert(opps)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          finding_id: this.knex.raw('EXCLUDED.finding_id'),
          action_type: this.knex.raw('EXCLUDED.action_type'),
          label: this.knex.raw('EXCLUDED.label'),
          title: this.knex.raw('EXCLUDED.title'),
          rationale: this.knex.raw('EXCLUDED.rationale'),
          payload: this.knex.raw('EXCLUDED.payload'),
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_actions.status IN ('approved','rejected','executed') THEN commercial.supervisor_actions.status ELSE 'pending_approval' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    const expired = await this.knex('commercial.supervisor_actions')
      .where({ tenant_id: tenantId, kind: 'opportunity', status: 'pending_approval' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'expired', updated_at: this.knex.fn.now() });

    return { proposed: opps.length, expired: Number(expired) || 0 };
  }
}
