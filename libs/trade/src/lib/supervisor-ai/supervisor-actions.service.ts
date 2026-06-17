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
  // Findings de visión (H2.2):
  vision_stockout: 'visit',
  vision_mismatch: 'flag_recapture',
  vision_invalid: 'flag_recapture',
};

type FindingForAction = {
  id: string;
  finding_type: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  label: string | null;
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

@Injectable()
export class SupervisorActionsService {
  private readonly logger = new Logger(SupervisorActionsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

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
      case 'vision_stockout':
        return `Visita a ${who}: quiebre de stock detectado en foto (${e.stockout_photos ?? '?'} fotos)`;
      case 'vision_mismatch':
        return `Re-auditar a ${who}: declaró propio pero la foto muestra competencia (${e.mismatch_photos ?? '?'})`;
      case 'vision_invalid':
        return `Re-auditar fotos de ${who}: ${e.pct ?? '?'}% inválidas o sin anaquel`;
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
   * Propone/actualiza acciones del co-piloto para UN tenant desde los findings
   * abiertos. Lo invoca el refresh tras generar findings (y el endpoint /compute).
   */
  async proposeForTenant(tenantId: string): Promise<{ proposed: number; expired: number }> {
    if (!tenantId) return { proposed: 0, expired: 0 };

    const findings: FindingForAction[] = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, status: 'open' })
      .select('id', 'finding_type', 'severity', 'subject_type', 'subject_id', 'label', 'evidence');

    const actions: any[] = [];
    for (const f of findings) {
      const actionType = ACTION_FOR[f.finding_type];
      if (!actionType) continue;
      actions.push({
        tenant_id: tenantId,
        finding_id: f.id,
        dedup_key: `${actionType}:${f.subject_type}:${f.subject_id}:${f.finding_type}`,
        action_type: actionType,
        kind: 'finding',
        subject_type: f.subject_type,
        subject_id: f.subject_id,
        label: f.label ? String(f.label).slice(0, 160) : null,
        title: this.titleFor(f).slice(0, 300),
        payload: JSON.stringify({ finding_type: f.finding_type, severity: f.severity }),
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
          payload: this.knex.raw('EXCLUDED.payload'),
          // Respeta decisiones humanas; reabre solo lo expirado.
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_actions.status IN ('approved','rejected','executed') THEN commercial.supervisor_actions.status ELSE 'pending_approval' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    // Expirar las pending de findings cuyo finding ya no aplica (NO toca opportunities).
    const expired = await this.knex('commercial.supervisor_actions')
      .where({ tenant_id: tenantId, kind: 'finding', status: 'pending_approval' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'expired', updated_at: this.knex.fn.now() });

    return { proposed: actions.length, expired: Number(expired) || 0 };
  }

  async listActions(filters: { status?: string; kind?: string }, user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.supervisor_actions').select('*');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.where('status', filters.status || 'pending_approval');
    if (filters.kind) q = q.where('kind', filters.kind);
    q = q.orderBy('created_at', 'desc');
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
      return {
        effect: 'coaching_note',
        coaching_note_id: inserted?.[0]?.id || inserted?.[0] || null,
        category,
        reversible: true,
        external_delivery: 'deferred',
        note: 'Nota de coaching creada (visible al colaborador). Push al teléfono diferido.',
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
      try {
        if (!assignedTo && storeId) {
          const last = await this.knex('daily_captures')
            .where({ tenant_id: tenantId, store_id: storeId })
            .orderBy('hora_inicio', 'desc')
            .first('user_id');
          assignedTo = last?.user_id || null;
        } else if (!assignedTo && routeId) {
          const last = await this.knex('daily_captures')
            .where({ tenant_id: tenantId, route_id: routeId })
            .orderBy('hora_inicio', 'desc')
            .first('user_id');
          assignedTo = last?.user_id || null;
        }
      } catch {
        /* asignación best-effort */
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
      return {
        effect: 'task',
        task_id: inserted?.[0]?.id || inserted?.[0] || null,
        task_type: TASK_TYPE[at],
        assigned_to_user: assignedTo,
        due: 'tomorrow',
        reversible: true,
        external_delivery: 'deferred',
        note: 'Tarea de campo creada para mañana (visible en la app del colaborador). Sync a daily_assignments diferido.',
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
      try {
        const u = await this.knex('users').where({ tenant_id: tenantId, id: userId }).first('meta_puntos');
        await this.knex('users').where({ tenant_id: tenantId, id: userId }).update({ meta_puntos: target });
        return {
          effect: 'set_target',
          previous_target: u?.meta_puntos ?? null,
          new_target: target,
          reversible: true,
          note: 'Objetivo de puntos actualizado.',
        };
      } catch (e: any) {
        return { effect: 'noop', reversible: false, note: `No se pudo fijar el objetivo (${e.message}).` };
      }
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
}
