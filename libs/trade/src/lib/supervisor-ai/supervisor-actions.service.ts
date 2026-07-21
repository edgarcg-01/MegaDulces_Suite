import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';
import { DiagnosisEngineService } from './diagnosis-engine.service';
import { RuleCalibrationService } from './rule-calibration.service';
import { BaselineLearnerService } from './baseline-learner.service';
import { EventsService } from '../websocket/events.service';

/**
 * Horus — Co-piloto de acciones (Sprint Horus.4).
 *
 * El motor PROPONE una acción por cada finding abierto (status `pending_approval`);
 * el supervisor APRUEBA o RECHAZA. Nada laboral se dispara solo (ADR-020).
 *
 * Ejecutor v1 (approve): efecto INTERNO y reversible — registra la decisión en
 * `result` y confirma el finding asociado. El efecto EXTERNO (push de coaching al
 * colaborador, agendar la visita en daily_assignments) queda DIFERIDO y
 * documentado en `result.external_delivery='deferred'` hasta que el canal exista.
 *
 * Idempotente: UPSERT por (tenant_id, dedup_key); respeta approved/rejected/executed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_FOR: Record<string, string> = {
  score_drop: 'coaching',
  low_score: 'coaching',
  competitor_dominance: 'visit',
  store_at_risk: 'visit',
  // Horus 360 (R2): los findings de ejecución fina ahora SÍ proponen acción atómica
  // cuando no están bundleados en un diagnóstico (R1).
  self_anomaly: 'coaching',
  weak_concept: 'coaching_focus',
  weak_position: 'coaching_focus',
  idle_anomaly: 'coaching',
  planogram_gap: 'recover_shelf',
  // Findings de visión (H2.2):
  vision_stockout: 'visit',
  vision_mismatch: 'flag_recapture',
  vision_invalid: 'flag_recapture',
  // Plan de visita (ACT.1): tiendas planeadas no visitadas → escalar al supervisor.
  missed_visit: 'notify_missed_visit',
};

// R1→R2: traducción del diagnóstico (action_hint) a una acción coherente del co-piloto.
const DIAGNOSIS_ACTION: Record<string, string> = {
  execution_quality_decline: 'coaching_focus',
  time_management_impact: 'coaching',
  sustained_decline: 'coaching',
  store_at_risk_compound: 'recover_shelf',
  team_sustained_decline: 'escalate',
};

const SEV_WEIGHT: Record<string, number> = { info: 1, warn: 2, critical: 3 };

type FindingForAction = {
  id: string;
  finding_type: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  label: string | null;
  source: string;
  evidence: any;
};

function parseEvidence(v: any): Record<string, any> {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) || {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseArray(v: any): any[] {
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

const round3 = (x: number) => Math.round(x * 1000) / 1000;

@Injectable()
export class SupervisorActionsService {
  private readonly logger = new Logger(SupervisorActionsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly diagnosis: DiagnosisEngineService,
    private readonly calibration: RuleCalibrationService,
    private readonly baselines: BaselineLearnerService,
    @Optional() private readonly tenantContext?: TenantContextService,
    @Optional() private readonly events?: EventsService,
  ) {}

  /** HIQ.5 — nudge en vivo al colaborador (best-effort, nunca bloquea el approve). */
  private nudgeField(payload: {
    tenantId: string;
    userId: string;
    kind: 'coaching' | 'task';
    title: string;
    refId?: string | null;
  }): 'ws' | 'deferred' {
    try {
      const ok = this.events?.emitFieldNudge(payload);
      return ok ? 'ws' : 'deferred';
    } catch {
      return 'deferred';
    }
  }

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  private titleFor(f: FindingForAction): string {
    const e = parseEvidence(f.evidence);
    const who = f.label || f.subject_type;
    switch (f.finding_type) {
      case 'score_drop':
        return `Coaching a ${who}: score bajó ${Math.abs(Number(e.score_trend ?? 0))} pts en 7d`;
      case 'low_score':
        return `Coaching a ${who}: score promedio ${e.avg_score ?? '?'}% (bajo el mínimo)`;
      case 'competitor_dominance':
        return `Visita a ${who}: competencia ${e.competitor_share_pct ?? '?'}% del exhibidor`;
      case 'store_at_risk':
        return `Agendar visita a ${who}: ${e.days_since_last_visit ?? '?'} días sin visita`;
      case 'self_anomaly':
        return `Coaching a ${who}: cayó a ${e.current ?? '?'} vs su normal ${e.baseline_mean ?? '?'}`;
      case 'weak_concept':
        return `Coaching enfocado a ${who}: concepto "${e.concept ?? '?'}" flojo (${e.concept_level ?? '?'} vs ${e.overall_level ?? '?'})`;
      case 'weak_position':
        return `Coaching enfocado a ${who}: mejorar posición en anaquel (calidad ${e.position_quality ?? '?'}/100)`;
      case 'idle_anomaly':
        return `Coaching a ${who}: ${e.idle_min_avg ?? '?'} min muertos entre visitas`;
      case 'planogram_gap':
        return `Recuperar anaquel en ${who}: ${e.planogram_present ?? '?'} SKUs del planograma vs pares`;
      case 'vision_stockout':
        return `Visita a ${who}: quiebre de stock detectado en foto (${e.stockout_photos ?? '?'} fotos)`;
      case 'vision_mismatch':
        return `Re-auditar a ${who}: declaró propio pero la foto muestra competencia (${e.mismatch_photos ?? '?'})`;
      case 'vision_invalid':
        return `Re-auditar fotos de ${who}: ${e.pct ?? '?'}% inválidas o sin anaquel`;
      case 'missed_visit':
        return `Escalar a ${who}: quedaron ${e.missed ?? '?'} de ${e.planned ?? '?'} tiendas planeadas sin visitar hoy`;
      default:
        return `Acción sobre ${who}`;
    }
  }

  private executionNote(actionType: string): string {
    return actionType === 'coaching'
      ? 'Coaching registrado para el colaborador (entrega por push diferida hasta habilitar el canal).'
      : actionType === 'visit'
        ? 'Visita marcada para agendar (asignación en daily_assignments diferida).'
        : 'Acción registrada.';
  }

  /**
   * HIQ.4 — valor de negocio por sujeto (proxy determinista y explicable):
   * tienda = Σ monetary_90d de los clientes ligados a ella (customer_360, Thot);
   * colaborador = Σ del valor de las tiendas que capturó en 30d. Best-effort:
   * si customer_360 no resuelve, todo queda sin valor y la prioridad no cambia.
   */
  private async buildValueMap(
    tenantId: string,
  ): Promise<{ get: (subjectType: string, subjectId: string) => number | null; max: number }> {
    const storeVal = new Map<string, number>();
    const collabVal = new Map<string, number>();

    const storeRows = await this.safeQuery(() =>
      this.knex.raw(
        `SELECT c.store_id, SUM(c360.monetary_90d)::numeric AS v
           FROM commercial.customer_360 c360
           JOIN commercial.customers c
             ON c.tenant_id = c360.tenant_id AND c.id = c360.customer_id
          WHERE c360.tenant_id = ? AND c.store_id IS NOT NULL AND c360.monetary_90d > 0
          GROUP BY c.store_id`,
        [tenantId],
      ),
    );
    for (const r of storeRows?.rows || []) {
      storeVal.set(String(r.store_id), Number(r.v) || 0);
    }

    if (storeVal.size) {
      const visits = await this.safeQuery(() =>
        this.knex('daily_captures')
          .where('tenant_id', tenantId)
          .whereNotNull('user_id')
          .whereNotNull('store_id')
          .whereRaw(`hora_inicio >= now() - interval '30 days'`)
          .distinct('user_id', 'store_id'),
      );
      for (const v of visits || []) {
        const sv = storeVal.get(String(v.store_id));
        if (sv) collabVal.set(String(v.user_id), (collabVal.get(String(v.user_id)) || 0) + sv);
      }
    }

    const max = Math.max(0, ...storeVal.values(), ...collabVal.values());
    return {
      max,
      get: (subjectType: string, subjectId: string) => {
        const m = subjectType === 'store' ? storeVal : subjectType === 'collaborator' ? collabVal : null;
        const v = m?.get(String(subjectId));
        return v != null && v > 0 ? v : null;
      },
    };
  }

  /**
   * Propone/actualiza acciones del co-piloto para UN tenant desde los findings
   * abiertos. Lo invoca el refresh tras generar findings (y el endpoint /compute).
   */
  async proposeForTenant(
    tenantId: string,
  ): Promise<{ proposed: number; expired: number; fatigued: number }> {
    if (!tenantId) return { proposed: 0, expired: 0, fatigued: 0 };

    // R2: inputs de decisión — precisión aprendida (L2), baselines (L1), diagnósticos (R1).
    const confMap = await this.calibration.getConfidence(tenantId);
    const baseMap = await this.baselines.getBaselines(tenantId);
    const diagnoses = await this.diagnosis.getOpenForTenant(tenantId);
    // HIQ.4: valor de negocio por sujeto (prioriza lo que cuesta dinero) +
    // cadencia anti-fatiga (no re-coachear a quien recibió coaching hace <7d).
    const values = await this.buildValueMap(tenantId);
    const recentlyCoached = new Set<string>(
      (
        (await this.safeQuery(() =>
          this.knex('commercial.coaching_notes')
            .where('tenant_id', tenantId)
            .whereNull('deleted_at')
            .whereRaw(`created_at >= now() - interval '7 days'`)
            .distinct('collaborator_id'),
        )) || []
      ).map((r: any) => String(r.collaborator_id)),
    );
    let fatigued = 0;
    const COACHING_FAMILY = new Set(['coaching', 'coaching_focus']);

    const findings: FindingForAction[] = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, status: 'open' })
      .select('id', 'finding_type', 'severity', 'subject_type', 'subject_id', 'label', 'source', 'evidence');

    const actions: any[] = [];

    // ── 1) Acción por DIAGNÓSTICO (R1): UNA acción coherente que reemplaza las N sueltas.
    const claimed = new Set<string>(); // finding_ids ya representados por un diagnóstico
    for (const d of diagnoses) {
      const fids = parseArray(d.finding_ids);
      fids.forEach((id: any) => typeof id === 'string' && claimed.add(id));
      const actionType = DIAGNOSIS_ACTION[d.root_cause];
      if (!actionType) continue;
      const types = parseArray(d.finding_types);
      const l2vals = types.length ? types.map((t: string) => confMap.get(`${t}:engine`) ?? 0.6) : [0.6];
      const l2avg = l2vals.reduce((a, b) => a + b, 0) / l2vals.length;
      const conf = round3(((d.confidence != null ? Number(d.confidence) : 0.6) + l2avg) / 2);
      const impact = this.impactFor(d.subject_type, d.subject_id, baseMap);
      if (
        COACHING_FAMILY.has(actionType) &&
        d.subject_type === 'collaborator' &&
        recentlyCoached.has(String(d.subject_id))
      ) {
        fatigued++;
        continue; // anti-fatiga: ya recibió coaching esta semana
      }
      const value = values.get(d.subject_type, d.subject_id);
      actions.push({
        tenant_id: tenantId,
        finding_id: null,
        dedup_key: `diag:${d.subject_type}:${d.subject_id}:${d.root_cause}`,
        action_type: actionType,
        kind: 'diagnosis',
        subject_type: d.subject_type,
        subject_id: d.subject_id,
        label: d.label ? String(d.label).slice(0, 160) : null,
        title: this.diagTitle(d).slice(0, 300),
        rationale: d.summary ? String(d.summary).slice(0, 2000) : null,
        payload: JSON.stringify({ root_cause: d.root_cause, finding_types: types, value_90d: value }),
        confidence: conf,
        expected_impact: impact ? JSON.stringify(impact) : null,
        priority: this.priorityOf(d.severity, conf, impact, value, values.max),
        diagnosis_id: d.id,
        root_cause: d.root_cause,
        proposed_by: 'horus',
        status: 'pending_approval',
      });
    }

    // ── 2) Acción ATÓMICA por finding NO bundleado en un diagnóstico.
    for (const f of findings) {
      if (claimed.has(f.id)) continue; // ya lo representa el diagnóstico (N→1)
      const actionType = ACTION_FOR[f.finding_type];
      if (!actionType) continue;
      if (
        COACHING_FAMILY.has(actionType) &&
        f.subject_type === 'collaborator' &&
        recentlyCoached.has(String(f.subject_id))
      ) {
        fatigued++;
        continue; // anti-fatiga: ya recibió coaching esta semana
      }
      const conf = confMap.get(`${f.finding_type}:${f.source || 'engine'}`) ?? 0.6;
      // missed_visit vive 1 día: el dedup lleva la fecha (evidence.date) → cada
      // jornada es una acción propia y las viejas expiran solas. Y no atamos un
      // expected_impact de avg_score (métrico ajeno a la cobertura de visita).
      const isMissed = f.finding_type === 'missed_visit';
      const missedDate = isMissed ? parseEvidence(f.evidence).date : null;
      const impact = isMissed ? null : this.impactFor(f.subject_type, f.subject_id, baseMap);
      const value = values.get(f.subject_type, f.subject_id);
      actions.push({
        tenant_id: tenantId,
        finding_id: f.id,
        dedup_key: `${actionType}:${f.subject_type}:${f.subject_id}:${f.finding_type}${
          isMissed && missedDate ? `:${missedDate}` : ''
        }`,
        action_type: actionType,
        kind: 'finding',
        subject_type: f.subject_type,
        subject_id: f.subject_id,
        label: f.label ? String(f.label).slice(0, 160) : null,
        title: this.titleFor(f).slice(0, 300),
        rationale: null,
        payload: JSON.stringify({ finding_type: f.finding_type, severity: f.severity, value_90d: value }),
        confidence: round3(conf),
        expected_impact: impact ? JSON.stringify(impact) : null,
        priority: this.priorityOf(f.severity, conf, impact, value, values.max),
        diagnosis_id: null,
        root_cause: null,
        proposed_by: 'horus',
        status: 'pending_approval',
      });
    }

    const keys = actions.map((a) => a.dedup_key);

    if (actions.length > 0) {
      await this.knex('commercial.supervisor_actions')
        .insert(actions)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          finding_id: this.knex.raw('EXCLUDED.finding_id'),
          label: this.knex.raw('EXCLUDED.label'),
          title: this.knex.raw('EXCLUDED.title'),
          rationale: this.knex.raw('EXCLUDED.rationale'),
          payload: this.knex.raw('EXCLUDED.payload'),
          confidence: this.knex.raw('EXCLUDED.confidence'),
          expected_impact: this.knex.raw('EXCLUDED.expected_impact'),
          priority: this.knex.raw('EXCLUDED.priority'),
          diagnosis_id: this.knex.raw('EXCLUDED.diagnosis_id'),
          root_cause: this.knex.raw('EXCLUDED.root_cause'),
          // Respeta decisiones humanas; reabre solo lo expirado.
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_actions.status IN ('approved','rejected','executed') THEN commercial.supervisor_actions.status ELSE 'pending_approval' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    // Expira las pending de finding/diagnosis que ya no aplican (NO toca opportunities).
    const expired = await this.knex('commercial.supervisor_actions')
      .where({ tenant_id: tenantId, status: 'pending_approval' })
      .whereIn('kind', ['finding', 'diagnosis'])
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'expired', updated_at: this.knex.fn.now() });

    return { proposed: actions.length, expired: Number(expired) || 0, fatigued };
  }

  /** Impacto esperado (techo): volver a su normal aprendido (L1). Solo donde hay baseline limpio. */
  private impactFor(
    subjectType: string,
    subjectId: string,
    baseMap: Map<string, { mean: number | null; floor_met: boolean }>,
  ): { metric: string; baseline_mean: number; basis: string } | null {
    if (subjectType !== 'collaborator') return null; // baseline limpio hoy solo p/ colaborador (avg_score)
    const b = baseMap.get(`collaborator:${subjectId}:30:avg_score`);
    if (!b || !b.floor_met || b.mean == null) return null;
    return { metric: 'avg_score', baseline_mean: Number(b.mean), basis: 'baseline' };
  }

  /**
   * Prioridad = severidad × confianza × bonus-de-impacto × factor-de-valor.
   * HIQ.4: el factor de valor (1.0–1.5) sube lo que cuesta dinero — un problema
   * en la tienda que más vende pesa más que el mismo problema en una chica.
   * Sin dato de valor, factor = 1 (no castiga). Solo ordena la bandeja.
   */
  private priorityOf(
    severity: string,
    confidence: number,
    impact: any,
    value: number | null = null,
    maxValue = 0,
  ): number {
    const sev = SEV_WEIGHT[severity] ?? 2;
    const valueFactor = value != null && maxValue > 0 ? 1 + 0.5 * Math.min(1, value / maxValue) : 1;
    return round3(sev * confidence * (impact ? 1.3 : 1) * valueFactor);
  }

  /** Título legible de la acción de un diagnóstico (R1). */
  private diagTitle(d: any): string {
    const who = d.label || d.subject_type;
    switch (d.root_cause) {
      case 'execution_quality_decline':
        return `Coaching enfocado a ${who}: la baja de score viene de ejecución`;
      case 'time_management_impact':
        return `Coaching a ${who}: el tiempo muerto golpea el desempeño`;
      case 'sustained_decline':
        return `Acompañar a ${who}: caída sostenida en ruta`;
      case 'store_at_risk_compound':
        return `Visita de recuperación a ${who} (tienda en riesgo)`;
      case 'team_sustained_decline':
        return `Escalar: ${who} arrastra el promedio del equipo`;
      default:
        return `Acción sobre ${who}`;
    }
  }

  async listActions(filters: { status?: string; kind?: string }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_actions').select('*');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.where('status', filters.status || 'pending_approval');
    if (filters.kind) q = q.where('kind', filters.kind);
    q = q.orderByRaw('priority DESC NULLS LAST').orderBy('created_at', 'desc');
    const rows = await q;
    return { rows, total: rows.length };
  }

  /** Co-piloto: el supervisor APRUEBA → ejecutor interno + confirma el finding. */
  async approveAction(id: string, user: any) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const tenantId = this.tenantId(user);
    const userId = user?.sub || user?.id || user?.userId || null;
    const approvedBy = userId && UUID_RE.test(String(userId)) ? userId : null;

    let q = this.knex('commercial.supervisor_actions').where('id', id);
    if (tenantId) q = q.where('tenant_id', tenantId);
    const action = await q.first();
    if (!action) throw new NotFoundException('Acción no encontrada');
    if (action.status !== 'pending_approval') {
      throw new BadRequestException(`La acción ya está ${action.status}`);
    }

    // Ejecutor REAL (H2.6): traduce la acción en un artefacto in-app concreto
    // (nota de coaching o tarea de campo). Reversible; el push externo sigue diferido.
    const result = await this.executeAction(action, approvedBy, tenantId);
    (result as any).executed_at = new Date().toISOString();

    // Confirma el finding asociado: el supervisor lo validó y accionó.
    if (action.finding_id && tenantId) {
      await this.knex('commercial.supervisor_findings')
        .where({ id: action.finding_id, tenant_id: tenantId })
        .whereIn('status', ['open', 'reviewed'])
        .update({
          status: 'confirmed',
          reviewed_by: approvedBy,
          reviewed_at: this.knex.fn.now(),
          updated_at: this.knex.fn.now(),
        });
    }

    const [updated] = await this.knex('commercial.supervisor_actions')
      .where({ id })
      .update({
        status: 'executed',
        approved_by: approvedBy,
        approved_at: this.knex.fn.now(),
        executed_at: this.knex.fn.now(),
        result: JSON.stringify(result),
        updated_at: this.knex.fn.now(),
      })
      .returning('*');
    return updated;
  }

  async rejectAction(id: string, user: any) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const tenantId = this.tenantId(user);
    const userId = user?.sub || user?.id || user?.userId || null;
    const approvedBy = userId && UUID_RE.test(String(userId)) ? userId : null;

    let q = this.knex('commercial.supervisor_actions').where('id', id);
    if (tenantId) q = q.where('tenant_id', tenantId);
    const action = await q.first();
    if (!action) throw new NotFoundException('Acción no encontrada');
    if (action.status !== 'pending_approval') {
      throw new BadRequestException(`La acción ya está ${action.status}`);
    }

    const [updated] = await this.knex('commercial.supervisor_actions')
      .where({ id })
      .update({
        status: 'rejected',
        approved_by: approvedBy,
        approved_at: this.knex.fn.now(),
        updated_at: this.knex.fn.now(),
      })
      .returning('*');
    return updated;
  }

  /**
   * Ejecuta un query OPCIONAL sin envenenar la trx del request (25P02): el
   * TenantContextInterceptor envuelve cada request en UNA trx; un query que falla
   * —aunque se atrape— la aborta y todo lo siguiente tira "current transaction is
   * aborted". Un SAVEPOINT aísla el fallo (ROLLBACK al savepoint, no a toda la trx);
   * si no hay trx (cron pooled) cae a query plano. Ver feedback_global_request_tx_25p02.
   */
  private async safeQuery<T>(fn: () => Promise<T>): Promise<T | null> {
    let sp = false;
    try {
      await this.knex.raw('SAVEPOINT horus_act');
      sp = true;
    } catch {
      /* fuera de una transacción */
    }
    try {
      const r = await fn();
      if (sp) await this.knex.raw('RELEASE SAVEPOINT horus_act');
      return r;
    } catch (e: any) {
      if (sp) {
        try {
          await this.knex.raw('ROLLBACK TO SAVEPOINT horus_act');
        } catch {
          /* noop */
        }
      }
      this.logger.debug(`safeQuery opcional falló: ${e.message}`);
      return null;
    }
  }

  /**
   * Ejecutor real del co-piloto: traduce la acción APROBADA en un artefacto in-app
   * concreto y reversible. Familia coaching → commercial.coaching_notes (visible al
   * colaborador). Familia campo → commercial.supervisor_tasks (tarea para mañana,
   * auto-asignada al último captor de la tienda/ruta cuando se puede). El efecto
   * EXTERNO (push, sync a daily_assignments) sigue diferido (ADR-020).
   */
  private async executeAction(
    action: any,
    approvedBy: string | null,
    tenantId?: string,
  ): Promise<Record<string, any>> {
    const at = String(action.action_type);
    const subjectType = String(action.subject_type);
    const subjectId = String(action.subject_id || '');
    const payload = parseEvidence(action.payload);
    const tomorrow = this.knex.raw(`((now() AT TIME ZONE 'America/Mexico_City')::date + 1)`);

    // Familia coaching → nota concreta para el colaborador.
    if (at === 'coaching' || at === 'coaching_focus' || at === 'replicate_best') {
      const collaboratorId =
        subjectType === 'collaborator' && UUID_RE.test(subjectId) ? subjectId : null;
      if (!collaboratorId || !tenantId) {
        return { effect: 'noop', reversible: false, note: 'Coaching sin colaborador válido.' };
      }
      const category = payload.category || (at === 'replicate_best' ? 'recognition' : 'general');
      const message = String(action.rationale || action.title || 'Coaching').slice(0, 2000);
      const inserted = await this.knex('commercial.coaching_notes')
        .insert({
          tenant_id: tenantId,
          collaborator_id: collaboratorId,
          supervisor_id: approvedBy,
          action_id: action.id,
          finding_id: action.finding_id || null,
          category,
          message,
          status: 'open',
          created_by: approvedBy,
        })
        .returning('id');
      const noteId = inserted?.[0]?.id || inserted?.[0] || null;
      // HIQ.5 — nudge en vivo al colaborador (durable por pull en /field/my-coaching).
      const delivery = this.nudgeField({
        tenantId,
        userId: collaboratorId,
        kind: 'coaching',
        title: message.slice(0, 120),
        refId: noteId,
      });
      return {
        effect: 'coaching_note',
        coaching_note_id: noteId,
        category,
        reversible: true,
        external_delivery: delivery,
        note:
          delivery === 'ws'
            ? 'Nota de coaching creada y avisada en vivo al colaborador.'
            : 'Nota de coaching creada (visible al colaborador). Aviso en vivo diferido (sin conexión).',
      };
    }

    // Familia campo → tarea para mañana.
    const TASK_TYPE: Record<string, string> = {
      visit: 'visit',
      schedule_visit: 'visit',
      recover_shelf: 'recover',
      reprioritize_route: 'reprioritize',
      flag_recapture: 'recapture',
      flag_review: 'recapture',
    };
    if (TASK_TYPE[at] && tenantId) {
      const storeId =
        subjectType === 'store' && UUID_RE.test(subjectId)
          ? subjectId
          : payload.store_id && UUID_RE.test(String(payload.store_id))
            ? String(payload.store_id)
            : null;
      const routeId =
        subjectType === 'route' && UUID_RE.test(subjectId)
          ? subjectId
          : payload.route_id && UUID_RE.test(String(payload.route_id))
            ? String(payload.route_id)
            : null;
      let assignedTo: string | null =
        subjectType === 'collaborator' && UUID_RE.test(subjectId) ? subjectId : null;
      // Auto-asignación best-effort al último captor — vía SAVEPOINT para no
      // envenenar la trx del request si la query falla (25P02).
      if (!assignedTo && (storeId || routeId)) {
        const col = storeId ? 'store_id' : 'route_id';
        const val = storeId || routeId;
        const last = await this.safeQuery(() =>
          this.knex('daily_captures')
            .where({ tenant_id: tenantId, [col]: val })
            .orderBy('hora_inicio', 'desc')
            .first('user_id'),
        );
        assignedTo = (last as any)?.user_id || null;
      }
      const inserted = await this.knex('commercial.supervisor_tasks')
        .insert({
          tenant_id: tenantId,
          action_id: action.id,
          task_type: TASK_TYPE[at],
          assigned_to_user: assignedTo,
          store_id: storeId,
          route_id: routeId,
          due_date: tomorrow,
          title: String(action.title || 'Tarea').slice(0, 300),
          details: JSON.stringify(payload || {}),
          status: 'pending',
          created_by: approvedBy,
        })
        .returning('id');
      const taskId = inserted?.[0]?.id || inserted?.[0] || null;
      // HIQ.5 — nudge en vivo si la tarea quedó asignada a un colaborador concreto.
      const delivery = assignedTo
        ? this.nudgeField({
            tenantId,
            userId: assignedTo,
            kind: 'task',
            title: String(action.title || 'Tarea de campo').slice(0, 120),
            refId: taskId,
          })
        : 'deferred';
      return {
        effect: 'task',
        task_id: taskId,
        task_type: TASK_TYPE[at],
        assigned_to_user: assignedTo,
        due: 'tomorrow',
        reversible: true,
        external_delivery: delivery,
        note:
          delivery === 'ws'
            ? 'Tarea creada para mañana y avisada en vivo al colaborador.'
            : 'Tarea de campo creada para mañana (visible en la app del colaborador). Sync a daily_assignments diferido.',
      };
    }

    // ACT.4 → escalar la incidencia de visita faltante al SUPERVISOR (web). El
    // aviso al vendedor ya salió automático desde el motor (coaching_notes
    // 'incident' + nudge); aprobar aquí es la parte que ADR-020 exige de un humano.
    // El finding se confirma por el flujo genérico (finding_id seteado).
    if (at === 'notify_missed_visit' && tenantId) {
      const collaboratorId =
        subjectType === 'collaborator' && UUID_RE.test(subjectId) ? subjectId : null;
      let delivery: 'ws' | 'deferred' = 'deferred';
      try {
        const ok = this.events?.emitSupervisorIncident({
          tenantId,
          collaboratorId,
          title: String(action.title || 'Visitas planeadas no realizadas').slice(0, 160),
          refId: action.finding_id || null,
        });
        delivery = ok ? 'ws' : 'deferred';
      } catch {
        delivery = 'deferred';
      }
      return {
        effect: 'incident_escalated',
        reversible: true,
        external_delivery: delivery,
        note:
          delivery === 'ws'
            ? 'Incidencia escalada al supervisor en vivo (web).'
            : 'Incidencia registrada (finding confirmado). Aviso en vivo diferido (sin supervisores conectados).',
      };
    }

    // set_target → users.meta_puntos (reversible: guarda el valor previo).
    if (at === 'set_target' && tenantId) {
      const target = Number(payload.target);
      const userId =
        subjectType === 'collaborator' && UUID_RE.test(subjectId) ? subjectId : null;
      if (!userId || !(target > 0)) {
        return { effect: 'noop', reversible: false, note: 'set_target sin objetivo/colaborador válido.' };
      }
      // SELECT+UPDATE dentro de un SAVEPOINT: si users es vista no-actualizable o el
      // SELECT falla, el rollback al savepoint deja la trx del request sana (no 25P02).
      const res = await this.safeQuery(async () => {
        const u = await this.knex('users').where({ tenant_id: tenantId, id: userId }).first('meta_puntos');
        await this.knex('users').where({ tenant_id: tenantId, id: userId }).update({ meta_puntos: target });
        return { prev: (u as any)?.meta_puntos ?? null };
      });
      if (!res) {
        return { effect: 'noop', reversible: false, note: 'No se pudo fijar el objetivo.' };
      }
      return {
        effect: 'set_target',
        previous_target: res.prev,
        new_target: target,
        reversible: true,
        note: 'Objetivo de puntos actualizado.',
      };
    }

    // Tipo desconocido → registro interno (compat hacia atrás).
    return {
      effect: 'internal',
      note: this.executionNote(at),
      external_delivery: 'deferred',
      reversible: true,
    };
  }

  /** Tareas de campo creadas por el co-piloto (panel "hecho por Horus"). */
  async listTasks(filters: { status?: string }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_tasks').select('*').whereNull('deleted_at');
    if (tenantId) q = q.where('tenant_id', tenantId);
    if (filters.status) q = q.where('status', filters.status);
    q = q.orderBy('created_at', 'desc').limit(50);
    const rows = await q;
    return { rows, total: rows.length };
  }

  /** Notas de coaching creadas por el co-piloto (panel "hecho por Horus"). */
  async listCoachingNotes(filters: { status?: string }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.coaching_notes').select('*').whereNull('deleted_at');
    if (tenantId) q = q.where('tenant_id', tenantId);
    if (filters.status) q = q.where('status', filters.status);
    q = q.orderBy('created_at', 'desc').limit(50);
    const rows = await q;
    return { rows, total: rows.length };
  }

  // ── Field-facing (Batch 2 / #1): el colaborador VE y ACUSA lo suyo ──
  // Estrictamente self-scoped por JWT.sub + tenant → no requiere permiso de dominio.

  private userId(user: any): string | null {
    const id = user?.sub || user?.id || user?.userId || null;
    return id && UUID_RE.test(String(id)) ? String(id) : null;
  }

  /** Tareas de campo asignadas AL usuario autenticado (pendientes). */
  async myTasks(user: any) {
    const tenantId = this.tenantId(user);
    const uid = this.userId(user);
    if (!uid) return { rows: [], total: 0 };
    let q = this.knex('commercial.supervisor_tasks')
      .select('id', 'task_type', 'title', 'details', 'status', 'due_date', 'store_id', 'route_id', 'created_at')
      .whereNull('deleted_at')
      .where('assigned_to_user', uid)
      .where('status', 'pending');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.orderBy('created_at', 'desc').limit(50);
    const rows = await q;
    return { rows, total: rows.length };
  }

  /** Notas de coaching dirigidas al usuario autenticado (abiertas / vistas). */
  async myCoaching(user: any) {
    const tenantId = this.tenantId(user);
    const uid = this.userId(user);
    if (!uid) return { rows: [], total: 0 };
    let q = this.knex('commercial.coaching_notes')
      .select('id', 'category', 'message', 'status', 'created_at')
      .whereNull('deleted_at')
      .where('collaborator_id', uid)
      .whereIn('status', ['open', 'acknowledged']);
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.orderBy('created_at', 'desc').limit(50);
    const rows = await q;
    return { rows, total: rows.length };
  }

  /** Acuse de tarea: el colaborador la marca hecha (solo la SUYA). */
  async ackTask(id: string, user: any) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const tenantId = this.tenantId(user);
    const uid = this.userId(user);
    if (!uid) throw new BadRequestException('usuario inválido');
    let q = this.knex('commercial.supervisor_tasks').where({ id, assigned_to_user: uid }).whereNull('deleted_at');
    if (tenantId) q = q.where('tenant_id', tenantId);
    const updated = await q
      .update({ status: 'done', done_at: this.knex.fn.now(), updated_at: this.knex.fn.now() })
      .returning(['id', 'status']);
    if (!updated.length) throw new NotFoundException('Tarea no encontrada');
    return updated[0];
  }

  /** Acuse de coaching: el colaborador lo marca visto (solo el SUYO). */
  async ackCoaching(id: string, user: any) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const tenantId = this.tenantId(user);
    const uid = this.userId(user);
    if (!uid) throw new BadRequestException('usuario inválido');
    let q = this.knex('commercial.coaching_notes').where({ id, collaborator_id: uid }).whereNull('deleted_at');
    if (tenantId) q = q.where('tenant_id', tenantId);
    const updated = await q
      .update({ status: 'acknowledged', acknowledged_at: this.knex.fn.now(), updated_at: this.knex.fn.now() })
      .returning(['id', 'status']);
    if (!updated.length) throw new NotFoundException('Nota no encontrada');
    return updated[0];
  }
}
