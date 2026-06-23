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
      add(
        'reprioritize_route',
        'route',
        routeId,
        `Repriorizar ${rname}: ${arr.length} tiendas sin visita`,
        `${arr.length} tiendas de la ruta superan ${th.days_no_visit_max} días sin visita. Priorizar mañana: ${top.map((s) => s.name).join(', ')}.`,
        { route_id: routeId, stores: top, threshold: th.days_no_visit_max },
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
