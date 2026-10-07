import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const GLOBAL = '__global__';
const MODES = ['off', 'dry_run', 'auto'];
const ACTION_TYPES = ['push_product', 'review_price', 'review_delist', 'reorder_outreach'];

export type AutonomyDecision = 'auto' | 'dry_run' | 'co-piloto';

export interface PolicyRow {
  action_type: string;
  mode: string;
  min_confidence: number;
  daily_cap: number;
  value_cap_mxn: number | null;
}

/**
 * Thot (ADR-023) — el dial de autonomía. Decide si una acción propuesta puede
 * auto-ejecutarse, bajo límites explícitos (autoridad GANADA, no en bloque):
 *   1. kill-switch maestro (__global__ debe estar en 'auto').
 *   2. política del action_type en 'auto'.
 *   3. confianza de la acción ≥ min_confidence (la confianza la da L2 → solo auto lo que
 *      la calibración probó que acierta).
 *   4. impacto $ ≤ value_cap_mxn (si hay tope).
 *   5. bajo el daily_cap (conteo de auto_executed de hoy).
 * Cualquier gate que no se cumpla → 'co-piloto' (sigue pidiendo aprobación).
 *
 * Determinista, auditable, reversible. Acceso vía TenantKnexService (RLS).
 */
@Injectable()
export class AutonomyService {
  private readonly logger = new Logger(AutonomyService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Mapa de políticas por action_type (incluye __global__). */
  async getPolicyMap(): Promise<Map<string, PolicyRow>> {
    const rows = await this.tk.run(async (trx) =>
      trx('commercial.autonomy_policies').select('action_type', 'mode', 'min_confidence', 'daily_cap', 'value_cap_mxn'),
    );
    const map = new Map<string, PolicyRow>();
    for (const r of rows) {
      map.set(r.action_type, {
        action_type: r.action_type,
        mode: r.mode,
        min_confidence: Number(r.min_confidence),
        daily_cap: Number(r.daily_cap),
        value_cap_mxn: r.value_cap_mxn != null ? Number(r.value_cap_mxn) : null,
      });
    }
    return map;
  }

  /** Decisión determinista para una acción dada el mapa de políticas + conteos de hoy. */
  decide(
    action: { action_type: string; confidence: number | null; expected_impact: any },
    policyMap: Map<string, PolicyRow>,
    todayCounts: Map<string, number>,
  ): AutonomyDecision {
    const global = policyMap.get(GLOBAL);
    if (!global || global.mode !== 'auto') return 'co-piloto'; // kill-switch maestro

    const p = policyMap.get(action.action_type);
    if (!p || p.mode === 'off') return 'co-piloto';

    const conf = action.confidence != null ? Number(action.confidence) : 0;
    if (conf < p.min_confidence) return 'co-piloto'; // autoridad ganada por calibración

    if (p.value_cap_mxn != null) {
      const impact = this.impactValue(action.expected_impact);
      if (impact != null && impact > p.value_cap_mxn) return 'co-piloto';
    }

    if ((todayCounts.get(action.action_type) || 0) >= p.daily_cap) return 'co-piloto';

    return p.mode === 'auto' ? 'auto' : 'dry_run';
  }

  private impactValue(expectedImpact: any): number | null {
    const e = typeof expectedImpact === 'string' ? safeParse(expectedImpact) : expectedImpact;
    return e && e.value != null ? Number(e.value) : null;
  }

  /** Conteo de acciones auto-ejecutadas HOY por action_type (para el daily_cap). */
  async todayAutoCounts(): Promise<Map<string, number>> {
    const rows = await this.tk.run(async (trx) =>
      trx('commercial.commercial_actions')
        .where('auto_executed', true)
        .whereRaw(`executed_at >= (now() AT TIME ZONE 'America/Mexico_City')::date`)
        .select('action_type')
        .count({ n: '*' })
        .groupBy('action_type'),
    );
    const map = new Map<string, number>();
    for (const r of rows as any[]) map.set(r.action_type, Number(r.n) || 0);
    return map;
  }

  // ── CRUD del dial ──

  async list() {
    const rows = await this.tk.run(async (trx) => trx('commercial.autonomy_policies').select('*').orderBy('action_type'));
    return { rows, total: rows.length };
  }

  async setPolicy(
    actionType: string,
    patch: { mode?: string; min_confidence?: number; daily_cap?: number; value_cap_mxn?: number | null },
  ) {
    if (actionType !== GLOBAL && !ACTION_TYPES.includes(actionType)) {
      throw new BadRequestException(`action_type inválido: ${actionType}`);
    }
    if (patch.mode != null && !MODES.includes(patch.mode)) {
      throw new BadRequestException(`mode debe ser ${MODES.join(' | ')}`);
    }
    if (patch.min_confidence != null && !(patch.min_confidence >= 0 && patch.min_confidence <= 1)) {
      throw new BadRequestException('min_confidence fuera de rango [0..1]');
    }
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const row = {
        tenant_id: trx.raw('public.current_tenant_id()'),
        action_type: actionType,
        mode: patch.mode ?? 'off',
        min_confidence: patch.min_confidence ?? 0.8,
        daily_cap: patch.daily_cap ?? 5,
        value_cap_mxn: patch.value_cap_mxn ?? null,
        updated_by: userId,
        updated_at: trx.fn.now(),
      };
      const merge: any = { updated_by: userId, updated_at: trx.fn.now() };
      if (patch.mode != null) merge.mode = patch.mode;
      if (patch.min_confidence != null) merge.min_confidence = patch.min_confidence;
      if (patch.daily_cap != null) merge.daily_cap = patch.daily_cap;
      if (patch.value_cap_mxn !== undefined) merge.value_cap_mxn = patch.value_cap_mxn;
      const [out] = await trx('commercial.autonomy_policies')
        .insert(row)
        .onConflict(['tenant_id', 'action_type'])
        .merge(merge)
        .returning('*');
      return out;
    });
  }

  /** Panel "Thot actuó solo": acciones auto-ejecutadas (auditoría + deshacer 1-clic). */
  async autoLog() {
    const rows = await this.tk.run(async (trx) =>
      trx('commercial.commercial_actions')
        .where({ auto_executed: true, status: 'executed' })
        .select('id', 'action_type', 'subject_type', 'label', 'title', 'confidence', 'expected_impact', 'result', 'executed_at')
        .orderBy('executed_at', 'desc')
        .limit(100),
    );
    return { rows, total: rows.length };
  }
}

function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}
