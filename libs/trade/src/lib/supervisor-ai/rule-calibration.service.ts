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
 * Horus — Aprendizaje L2: auto-calibración de reglas (RuleCalibrationService).
 *
 * El PRIMER aprendizaje real de Horus: aprende sobre sí mismo. Agrega
 * commercial.supervisor_findings.status por (finding_type, source) → precisión =
 * confirmed / (confirmed + dismissed). Cuando hay suficiente juicio humano (floor),
 * suprime las reglas que el supervisor descarta casi siempre y capa la severidad de
 * las medio-ruidosas. Persiste en commercial.execution_rule_stats; el FindingsEngine
 * lo lee y deja de emitir / capa esas reglas.
 *
 * Invariante (ADR-021): determinista (sin LLM), reversible (recomputa c/corrida; si la
 * precisión se recupera des-suprime), y SIEMPRE overridable por el humano
 * (manual_override no se pisa en el merge). El aprendizaje ajusta supresión / severidad
 * / peso — NUNCA acciona sobre lo laboral.
 *
 * Cold-start: por debajo del floor (floor_met=false) NO se suprime nada → el motor cae
 * a su default. Aprender de 3 muestras sería ruido.
 *
 * Caveat de auto-bloqueo: una regla suprimida deja de emitir → no genera nuevos
 * findings que revisar → su precisión queda congelada. La salida es el override humano
 * (manual_override='enabled') desde el panel L7. Es el diseño honesto: una regla que el
 * supervisor descartó >80% de las veces DEBE dejar de molestar; si el contexto cambia,
 * el humano la reactiva.
 *
 * Acceso runtime: KNEX_CONNECTION (superuser, bypassa RLS) + tenant_id explícito,
 * patrón Horus. Lee/escribe sólo tablas commercial.* propias → sin riesgo 25P02.
 */
const MIN_REVIEWED = 8; // juicios (confirmed+dismissed) mínimos para actuar
const PRECISION_SUPPRESS = 0.2; // < 20% confirmadas → suprimir la regla
const PRECISION_CAP = 0.4; // 20–40% → capar severidad a 'warn' (no 'critical')

@Injectable()
export class RuleCalibrationService {
  private readonly logger = new Logger(RuleCalibrationService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /**
   * Recomputa la precisión por regla del tenant y persiste rule_stats.
   * Conserva manual_override (pin humano): no va en el merge del UPSERT.
   */
  async computeForTenant(tenantId: string): Promise<{ rules: number; suppressed: number }> {
    if (!tenantId) return { rules: 0, suppressed: 0 };

    const agg = await this.knex('commercial.supervisor_findings')
      .where('tenant_id', tenantId)
      .select('finding_type', 'source')
      .count({ n_total: '*' })
      .select(
        this.knex.raw(`count(*) FILTER (WHERE status = 'open') AS n_open`),
        this.knex.raw(`count(*) FILTER (WHERE status = 'confirmed') AS n_confirmed`),
        this.knex.raw(`count(*) FILTER (WHERE status = 'dismissed') AS n_dismissed`),
        this.knex.raw(`count(*) FILTER (WHERE status = 'reviewed') AS n_reviewed`),
        this.knex.raw(`count(*) FILTER (WHERE status = 'resolved') AS n_resolved`),
      )
      .groupBy('finding_type', 'source');

    if (agg.length === 0) return { rules: 0, suppressed: 0 };

    // Conservar los overrides humanos previos (el merge no los pisa, pero los
    // necesitamos para contar la supresión EFECTIVA correctamente).
    const prev = await this.knex('commercial.execution_rule_stats')
      .where('tenant_id', tenantId)
      .select('finding_type', 'source', 'manual_override');
    const overrideOf = new Map<string, string | null>();
    prev.forEach((p: any) => overrideOf.set(`${p.finding_type}:${p.source}`, p.manual_override ?? null));

    let suppressedCount = 0;
    const rows = agg.map((a: any) => {
      const nConfirmed = Number(a.n_confirmed) || 0;
      const nDismissed = Number(a.n_dismissed) || 0;
      const reviewedTotal = nConfirmed + nDismissed;
      const precision = reviewedTotal > 0 ? Math.round((nConfirmed / reviewedTotal) * 10000) / 10000 : null;
      const floorMet = reviewedTotal >= MIN_REVIEWED;
      const autoSuppressed = floorMet && precision != null && precision < PRECISION_SUPPRESS;
      const severityCap =
        floorMet && precision != null && precision >= PRECISION_SUPPRESS && precision < PRECISION_CAP ? 'warn' : null;
      // weight: prioridad relativa (panel/orden). precision alta → ~1; baja → hasta 0.2.
      const weight =
        precision != null && floorMet
          ? Math.round(Math.max(0.2, Math.min(1, precision + 0.2)) * 1000) / 1000
          : 1.0;
      const override = overrideOf.get(`${a.finding_type}:${a.source}`) ?? null;
      const effectiveSuppressed =
        override === 'suppressed' ? true : override === 'enabled' ? false : autoSuppressed;
      if (effectiveSuppressed) suppressedCount++;
      return {
        tenant_id: tenantId,
        finding_type: a.finding_type,
        source: a.source,
        n_total: Number(a.n_total) || 0,
        n_open: Number(a.n_open) || 0,
        n_confirmed: nConfirmed,
        n_dismissed: nDismissed,
        n_reviewed: Number(a.n_reviewed) || 0,
        n_resolved: Number(a.n_resolved) || 0,
        reviewed_total: reviewedTotal,
        precision,
        floor_met: floorMet,
        auto_suppressed: autoSuppressed,
        severity_cap: severityCap,
        manual_override: override,
        weight,
        computed_at: this.knex.fn.now(),
        updated_at: this.knex.fn.now(),
      };
    });

    await this.knex('commercial.execution_rule_stats')
      .insert(rows)
      .onConflict(['tenant_id', 'finding_type', 'source'])
      .merge([
        'n_total',
        'n_open',
        'n_confirmed',
        'n_dismissed',
        'n_reviewed',
        'n_resolved',
        'reviewed_total',
        'precision',
        'floor_met',
        'auto_suppressed',
        'severity_cap',
        'weight',
        'computed_at',
        'updated_at',
        // manual_override NO va en el merge → el pin humano se conserva.
      ]);

    return { rules: rows.length, suppressed: suppressedCount };
  }

  /**
   * Mapa de calibración EFECTIVA por (finding_type:source) para que el motor decida
   * suprimir/capar. La supresión efectiva resuelve el override humano sobre el auto.
   */
  async getCalibration(tenantId: string): Promise<Map<string, { suppressed: boolean; cap: string | null }>> {
    const map = new Map<string, { suppressed: boolean; cap: string | null }>();
    if (!tenantId) return map;
    const rows = await this.knex('commercial.execution_rule_stats')
      .where('tenant_id', tenantId)
      .select('finding_type', 'source', 'auto_suppressed', 'severity_cap', 'manual_override');
    for (const s of rows) {
      const suppressed =
        s.manual_override === 'suppressed' ? true : s.manual_override === 'enabled' ? false : !!s.auto_suppressed;
      map.set(`${s.finding_type}:${s.source}`, { suppressed, cap: s.severity_cap ?? null });
    }
    return map;
  }

  /** Scorecard para el panel L7 (qué aprendió Horus sobre sus reglas). */
  async list(user: any) {
    const tenantId = this.tenantId(user);
    let q = this.knex('commercial.execution_rule_stats').select('*');
    if (tenantId) q = q.where('tenant_id', tenantId);
    q = q.orderBy('reviewed_total', 'desc').orderBy('finding_type', 'asc');
    const rows = await q;
    return {
      rows: rows.map((r: any) => ({
        ...r,
        effective_suppressed:
          r.manual_override === 'suppressed'
            ? true
            : r.manual_override === 'enabled'
              ? false
              : !!r.auto_suppressed,
      })),
      total: rows.length,
      computed_at: rows[0]?.computed_at ?? null,
    };
  }

  /** Pin humano (L7): fuerza enabled/suppressed o quita el pin (null). */
  async setOverride(findingType: string, source: string, override: string | null, user: any) {
    const tenantId = this.tenantId(user);
    if (override != null && !['enabled', 'suppressed'].includes(override)) {
      throw new BadRequestException("override debe ser 'enabled' | 'suppressed' | null");
    }
    let q = this.knex('commercial.execution_rule_stats').where({
      finding_type: findingType,
      source: source || 'engine',
    });
    if (tenantId) q = q.where('tenant_id', tenantId);
    const updated = await q
      .update({ manual_override: override, updated_at: this.knex.fn.now() })
      .returning('*');
    if (!updated.length) throw new NotFoundException('Regla sin estadística aún (corré la calibración primero)');
    return updated[0];
  }
}
