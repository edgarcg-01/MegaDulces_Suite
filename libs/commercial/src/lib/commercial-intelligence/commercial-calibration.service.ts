import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const MIN_REVIEWED = 8; // juicios (confirmed+dismissed) mínimos para actuar
const PRECISION_SUPPRESS = 0.2; // < 20% confirmadas → suprimir
const PRECISION_CAP = 0.4; // 20–40% → capar severidad a 'warn'

/**
 * Thot (ADR-018) — Track Aprendizaje, Sprint T.L2: auto-calibración de reglas comerciales.
 *
 * Análogo a RuleCalibrationService de Horus. Aprende sobre sí mismo: precisión por
 * finding_type = confirmed / (confirmed + dismissed) del juicio humano sobre
 * commercial_findings. Con suficiente juicio (floor) suprime las reglas que el analista
 * descarta casi siempre y capa las medio-ruidosas. El FindingsEngine lo lee (deja de
 * emitir/capa) y el co-piloto ajusta la confianza de las acciones.
 *
 * Determinista, reversible, overridable (manual_override no va en el merge). Cold-start
 * neutro. Acceso vía TenantKnexService (RLS).
 */
@Injectable()
export class CommercialCalibrationService {
  private readonly logger = new Logger(CommercialCalibrationService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Recomputa la precisión por finding_type y persiste. Conserva manual_override (pin humano). */
  async computeForTenant(): Promise<{ rules: number; suppressed: number }> {
    return this.tk.run(async (trx) => {
      const agg = await trx('commercial.commercial_findings')
        .select('finding_type')
        .count({ n_total: '*' })
        .select(
          trx.raw(`count(*) FILTER (WHERE status = 'open') AS n_open`),
          trx.raw(`count(*) FILTER (WHERE status = 'confirmed') AS n_confirmed`),
          trx.raw(`count(*) FILTER (WHERE status = 'dismissed') AS n_dismissed`),
          trx.raw(`count(*) FILTER (WHERE status = 'resolved') AS n_resolved`),
        )
        .groupBy('finding_type');
      if (agg.length === 0) return { rules: 0, suppressed: 0 };

      const prev = await trx('commercial.commercial_rule_stats').select('finding_type', 'manual_override');
      const overrideOf = new Map<string, string | null>();
      prev.forEach((p: any) => overrideOf.set(p.finding_type, p.manual_override ?? null));

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
        const weight =
          precision != null && floorMet ? Math.round(Math.max(0.2, Math.min(1, precision + 0.2)) * 1000) / 1000 : 1.0;
        const override = overrideOf.get(a.finding_type) ?? null;
        const effectiveSuppressed = override === 'suppressed' ? true : override === 'enabled' ? false : autoSuppressed;
        if (effectiveSuppressed) suppressedCount++;
        return {
          tenant_id: trx.raw('public.current_tenant_id()'),
          finding_type: a.finding_type,
          n_total: Number(a.n_total) || 0,
          n_open: Number(a.n_open) || 0,
          n_confirmed: nConfirmed,
          n_dismissed: nDismissed,
          n_resolved: Number(a.n_resolved) || 0,
          reviewed_total: reviewedTotal,
          precision,
          floor_met: floorMet,
          auto_suppressed: autoSuppressed,
          severity_cap: severityCap,
          manual_override: override,
          weight,
          computed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        };
      });

      await trx('commercial.commercial_rule_stats')
        .insert(rows)
        .onConflict(['tenant_id', 'finding_type'])
        .merge([
          'n_total', 'n_open', 'n_confirmed', 'n_dismissed', 'n_resolved', 'reviewed_total',
          'precision', 'floor_met', 'auto_suppressed', 'severity_cap', 'weight', 'computed_at', 'updated_at',
          // manual_override NO va en el merge → el pin humano se conserva.
        ]);

      return { rules: rows.length, suppressed: suppressedCount };
    });
  }

  /** Mapa de calibración efectiva por finding_type (suprimir/capar) para el motor. */
  async getCalibration(): Promise<Map<string, { suppressed: boolean; cap: string | null }>> {
    const map = new Map<string, { suppressed: boolean; cap: string | null }>();
    const rows = await this.tk.run(async (trx) =>
      trx('commercial.commercial_rule_stats').select('finding_type', 'auto_suppressed', 'severity_cap', 'manual_override'),
    );
    for (const s of rows) {
      const suppressed = s.manual_override === 'suppressed' ? true : s.manual_override === 'enabled' ? false : !!s.auto_suppressed;
      map.set(s.finding_type, { suppressed, cap: s.severity_cap ?? null });
    }
    return map;
  }

  /** Multiplicador de confianza por finding_type (precisión aprendida; cold-start 0.6). */
  async getConfidence(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const rows = await this.tk.run(async (trx) =>
      trx('commercial.commercial_rule_stats').select('finding_type', 'precision', 'floor_met', 'manual_override'),
    );
    for (const r of rows) {
      const base = r.floor_met && r.precision != null ? Math.max(0.3, Math.min(1, Number(r.precision))) : 0.6;
      const conf = r.manual_override === 'enabled' ? Math.max(base, 0.8) : base;
      map.set(r.finding_type, Math.round(conf * 1000) / 1000);
    }
    return map;
  }

  /** Scorecard para el panel (qué aprendió Thot sobre sus reglas). */
  async list() {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.commercial_rule_stats')
        .select('*')
        .orderBy('reviewed_total', 'desc')
        .orderBy('finding_type', 'asc');
      return {
        rows: rows.map((r: any) => ({
          ...r,
          effective_suppressed:
            r.manual_override === 'suppressed' ? true : r.manual_override === 'enabled' ? false : !!r.auto_suppressed,
        })),
        total: rows.length,
        computed_at: rows[0]?.computed_at ?? null,
      };
    });
  }

  /** Pin humano: fuerza enabled/suppressed o quita el pin (null). */
  async setOverride(findingType: string, override: string | null) {
    if (override != null && !['enabled', 'suppressed'].includes(override)) {
      throw new BadRequestException("override debe ser 'enabled' | 'suppressed' | null");
    }
    return this.tk.run(async (trx) => {
      const updated = await trx('commercial.commercial_rule_stats')
        .where({ finding_type: findingType })
        .update({ manual_override: override, updated_at: trx.fn.now() })
        .returning('*');
      if (!updated.length) throw new NotFoundException('Regla sin estadística aún (corré la calibración primero)');
      return updated[0];
    });
  }
}
