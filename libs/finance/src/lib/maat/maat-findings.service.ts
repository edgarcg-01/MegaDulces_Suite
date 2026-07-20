import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT.2 — Bandeja de hallazgos + aprendizaje L2 (ADR-028/021).
 *
 * Lista/tría los `finance.findings` producidos por MaatDetectorService y registra
 * el feedback (útil/falso). El feedback recalcula `precision_score` por regla y,
 * cuando una regla es ruidosa (precisión < umbral con muestra suficiente), la
 * AUTO-SUPRIME (deja de generar hallazgos) — salvo que un humano la haya fijado
 * (`pinned`). Determinista, auditable, reversible: el LLM queda fuera del lazo.
 */

const STATUS = ['nuevo', 'en_revision', 'confirmado', 'descartado', 'corregido'];
const VERDICT = ['util', 'falso', 'duplicado', 'ya_corregido'];
const SUPPRESS_PRECISION = 0.3;   // < 30% de precisión…
const SUPPRESS_MIN_N = 10;        // …con ≥10 veredictos → auto-supresión

@Injectable()
export class MaatFindingsService {
  private readonly logger = new Logger(MaatFindingsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Bandeja filtrable. Join a rule_registry para el nombre legible de la regla. */
  async list(q: { status?: string; clase?: string; severity?: string; rule_key?: string; limit?: number }) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('finance.findings as f')
        .leftJoin('finance.rule_registry as r', function (this: any) { this.on('r.tenant_id', 'f.tenant_id').andOn('r.rule_key', 'f.rule_key'); })
        .select('f.id', 'f.rule_key', 'r.nombre as regla', 'f.clase', 'f.severity', 'f.status', 'f.score',
          trx.raw('f.model_score::numeric AS model_score'), 'f.model_version', 'f.skeptic_verdict',
          'f.titulo', 'f.resumen', 'f.entity', 'f.periodo', trx.raw('f.importe::numeric AS importe'),
          'f.evidencia', 'f.first_seen', 'f.last_seen')
        // prioridad APRENDIDA primero (MIQ.2); en cold-start cae al score del detector
        // ajustado por el veredicto del escéptico (MIQ.4): los refutados se hunden.
        .orderByRaw("COALESCE(f.model_score, f.score * CASE f.skeptic_verdict WHEN 'refutado' THEN 0.3 WHEN 'debil' THEN 0.6 ELSE 1 END, f.score, 0) DESC")
        .orderByRaw("CASE f.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END")
        .orderBy('f.importe', 'desc')
        .limit(limit);
      // default: solo pendientes (nuevo/en_revision) salvo que pidan un status
      if (q.status) b.where('f.status', q.status);
      else b.whereIn('f.status', ['nuevo', 'en_revision']);
      if (q.clase) b.where('f.clase', q.clase);
      if (q.severity) b.where('f.severity', q.severity);
      if (q.rule_key) b.where('f.rule_key', q.rule_key);
      const rows = await b;
      return rows.map((r: any) => ({ ...r, importe: Number(r.importe), model_score: r.model_score == null ? null : Number(r.model_score) }));
    });
  }

  /** KPIs de la bandeja (cabecera): pendientes, críticos, $ en riesgo, por clase. */
  async stats() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = () => trx('finance.findings').where('tenant_id', trx.raw('public.current_tenant_id()'));
      const pend: any = await base().whereIn('status', ['nuevo', 'en_revision'])
        .select(trx.raw('COUNT(*)::int AS n'),
          trx.raw("COUNT(*) FILTER (WHERE severity='critical')::int AS criticos"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS monto')).first();
      const porClase = await base().whereIn('status', ['nuevo', 'en_revision'])
        .groupBy('clase').select('clase', trx.raw('COUNT(*)::int AS n')).orderBy('clase');
      return {
        pendientes: Number(pend?.n || 0),
        criticos: Number(pend?.criticos || 0),
        monto_en_riesgo: Number(pend?.monto || 0),
        por_clase: porClase.map((c: any) => ({ clase: c.clase, n: Number(c.n) })),
      };
    });
  }

  /** Salud de las reglas: precisión, conteos, estado (para el mini-panel). */
  async rules() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('finance.rule_registry').where('tenant_id', trx.raw('public.current_tenant_id()'))
        .select('rule_key', 'nombre', 'clase', 'enabled', 'pinned', 'suppressed_auto',
          'precision_score', 'findings_total', 'findings_confirmados', 'findings_falsos')
        .orderBy('clase', 'rule_key'),
    );
  }

  /** Cambia el estado de triage de un hallazgo. */
  async setStatus(id: string, status: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!STATUS.includes(status)) throw new BadRequestException(`status inválido (${STATUS.join('|')})`);
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.findings').where('id', id)
        .update({ status, updated_at: trx.fn.now() }).returning(['id', 'status', 'rule_key']);
      if (!row) throw new BadRequestException('hallazgo no encontrado');
      this.logger.log(`finding ${id} → ${status}${actor ? ` por ${actor}` : ''}`);
      return row;
    });
  }

  /**
   * Registra el veredicto de Finanzas y recalcula la precisión de la regla (L2).
   * util → confirmado, falso → descartado (sincroniza el status del hallazgo).
   * Recalcula precision = confirmados/(confirmados+falsos) y auto-suprime si es ruidosa.
   */
  async feedback(id: string, verdict: string, nota?: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!VERDICT.includes(verdict)) throw new BadRequestException(`verdict inválido (${VERDICT.join('|')})`);
    return this.tk.run(async (trx) => {
      const f = await trx('finance.findings').where('id', id).select('id', 'rule_key', 'tenant_id').first();
      if (!f) throw new BadRequestException('hallazgo no encontrado');

      await trx('finance.finding_feedback').insert({ tenant_id: f.tenant_id, finding_id: id, verdict, nota: nota || null, created_by: actor || null });
      const nuevoStatus = verdict === 'util' ? 'confirmado' : verdict === 'ya_corregido' ? 'corregido' : 'descartado';
      await trx('finance.findings').where('id', id).update({ status: nuevoStatus, updated_at: trx.fn.now() });

      // Recalcular precisión de la regla desde TODO su feedback (confirmado vs falso).
      const agg: any = await trx('finance.finding_feedback as fb')
        .join('finance.findings as f2', function (this: any) { this.on('f2.tenant_id', 'fb.tenant_id').andOn('f2.id', 'fb.finding_id'); })
        .where('f2.tenant_id', f.tenant_id).where('f2.rule_key', f.rule_key)
        .select(
          trx.raw("COUNT(*) FILTER (WHERE fb.verdict = 'util')::int AS conf"),
          trx.raw("COUNT(*) FILTER (WHERE fb.verdict = 'falso')::int AS fals"),
        ).first();
      const conf = Number(agg?.conf || 0), fals = Number(agg?.fals || 0);
      const denom = conf + fals;
      const precision = denom > 0 ? +(conf / denom).toFixed(3) : null;

      const rule = await trx('finance.rule_registry').where({ tenant_id: f.tenant_id, rule_key: f.rule_key }).select('pinned').first();
      const suppress = !rule?.pinned && denom >= SUPPRESS_MIN_N && precision != null && precision < SUPPRESS_PRECISION;
      await trx('finance.rule_registry').where({ tenant_id: f.tenant_id, rule_key: f.rule_key }).update({
        findings_confirmados: conf, findings_falsos: fals, precision_score: precision,
        suppressed_auto: suppress, updated_at: trx.fn.now(),
      });
      if (suppress) this.logger.warn(`Regla ${f.rule_key} auto-suprimida: precisión ${precision} con ${denom} veredictos.`);
      return { ok: true, status: nuevoStatus, rule_key: f.rule_key, precision, suppressed: suppress };
    });
  }

  /** Fija/desfija una regla (pinned = nunca auto-suprimir; reactiva si estaba suprimida). */
  async pinRule(rule_key: string, pinned: boolean) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const patch: any = { pinned, updated_at: trx.fn.now() };
      if (pinned) patch.suppressed_auto = false; // fijar reactiva
      const [row] = await trx('finance.rule_registry').where('rule_key', rule_key).update(patch).returning(['rule_key', 'pinned', 'suppressed_auto']);
      if (!row) throw new BadRequestException('regla no encontrada');
      return row;
    });
  }
}
