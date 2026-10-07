import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * SM.1 — Bandeja de descuadres + aprendizaje L2 (ADR-029/021).
 *
 * Lista/tría las `reconciliation.discrepancies` del motor y registra el feedback
 * (útil/falso + causa confirmada). El feedback recalcula `precision_score` por
 * regla y auto-suprime las ruidosas (redondeos de centavos) salvo pin humano.
 * Determinista, auditable, reversible. Espeja MaatFindingsService.
 */

const STATUS = ['nuevo', 'en_revision', 'confirmado', 'descartado', 'corregido'];
const VERDICT = ['util', 'falso', 'duplicado', 'ya_corregido'];
const SUPPRESS_PRECISION = 0.3;
const SUPPRESS_MIN_N = 10;

@Injectable()
export class ReconciliationFindingsService {
  private readonly logger = new Logger(ReconciliationFindingsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Bandeja filtrable (plano/status/severity/rule_key). Join a rule_registry. */
  async list(q: { status?: string; plano?: string; severity?: string; rule_key?: string; limit?: number }) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('reconciliation.discrepancies as d')
        .leftJoin('reconciliation.rule_registry as r', function (this: any) { this.on('r.tenant_id', 'd.tenant_id').andOn('r.rule_key', 'd.rule_key'); })
        .select('d.id', 'd.rule_key', 'r.nombre as regla', 'd.plano', 'd.severity', 'd.status', 'd.score',
          'd.titulo', 'd.resumen', 'd.entity', 'd.periodo',
          trx.raw('d.esperado::numeric AS esperado'), trx.raw('d.observado::numeric AS observado'),
          trx.raw('d.diferencia::numeric AS diferencia'), trx.raw('d.importe::numeric AS importe'),
          'd.causa_probable', 'd.causa_confirmada', 'd.evidencia', 'd.first_seen', 'd.last_seen')
        .orderByRaw("CASE d.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END")
        .orderBy('d.importe', 'desc')
        .limit(limit);
      if (q.status) b.where('d.status', q.status);
      else b.whereIn('d.status', ['nuevo', 'en_revision']);
      if (q.plano) b.where('d.plano', q.plano);
      if (q.severity) b.where('d.severity', q.severity);
      if (q.rule_key) b.where('d.rule_key', q.rule_key);
      const rows = await b;
      return rows.map((r: any) => ({ ...r, esperado: r.esperado == null ? null : Number(r.esperado), observado: r.observado == null ? null : Number(r.observado), diferencia: r.diferencia == null ? null : Number(r.diferencia), importe: Number(r.importe) }));
    });
  }

  /** KPIs de cabecera: pendientes, críticos, $ en juego, por plano. */
  async stats() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = () => trx('reconciliation.discrepancies').where('tenant_id', trx.raw('public.current_tenant_id()'));
      const pend: any = await base().whereIn('status', ['nuevo', 'en_revision'])
        .select(trx.raw('COUNT(*)::int AS n'),
          trx.raw("COUNT(*) FILTER (WHERE severity='critical')::int AS criticos"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS monto')).first();
      const porPlano = await base().whereIn('status', ['nuevo', 'en_revision'])
        .groupBy('plano').select('plano', trx.raw('COUNT(*)::int AS n'), trx.raw('ROUND(SUM(importe)::numeric,2) AS monto')).orderBy('plano');
      return {
        pendientes: Number(pend?.n || 0),
        criticos: Number(pend?.criticos || 0),
        monto_en_juego: Number(pend?.monto || 0),
        por_plano: porPlano.map((c: any) => ({ plano: c.plano, n: Number(c.n), monto: Number(c.monto || 0) })),
      };
    });
  }

  /** Salud de las reglas (mini-panel). */
  async rules() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('reconciliation.rule_registry').where('tenant_id', trx.raw('public.current_tenant_id()'))
        .select('rule_key', 'nombre', 'plano', 'enabled', 'pinned', 'suppressed_auto',
          'precision_score', 'findings_total', 'findings_confirmados', 'findings_falsos')
        .orderBy('plano', 'rule_key'),
    );
  }

  async setStatus(id: string, status: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!STATUS.includes(status)) throw new BadRequestException(`status inválido (${STATUS.join('|')})`);
    return this.tk.run(async (trx) => {
      const [row] = await trx('reconciliation.discrepancies').where('id', id)
        .update({ status, updated_at: trx.fn.now() }).returning(['id', 'status', 'rule_key']);
      if (!row) throw new BadRequestException('descuadre no encontrado');
      this.logger.log(`discrepancy ${id} → ${status}${actor ? ` por ${actor}` : ''}`);
      return row;
    });
  }

  /**
   * Veredicto + causa confirmada. util → confirmado, falso → descartado.
   * Recalcula precisión de la regla y auto-suprime si es ruidosa (salvo pin).
   */
  async feedback(id: string, verdict: string, causa?: string, nota?: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!VERDICT.includes(verdict)) throw new BadRequestException(`verdict inválido (${VERDICT.join('|')})`);
    return this.tk.run(async (trx) => {
      const d = await trx('reconciliation.discrepancies').where('id', id).select('id', 'rule_key', 'tenant_id').first();
      if (!d) throw new BadRequestException('descuadre no encontrado');

      await trx('reconciliation.discrepancy_feedback').insert({ tenant_id: d.tenant_id, discrepancy_id: id, verdict, causa: causa || null, nota: nota || null, created_by: actor || null });
      const nuevoStatus = verdict === 'util' ? 'confirmado' : verdict === 'ya_corregido' ? 'corregido' : 'descartado';
      await trx('reconciliation.discrepancies').where('id', id).update({ status: nuevoStatus, causa_confirmada: causa || null, updated_at: trx.fn.now() });

      const agg: any = await trx('reconciliation.discrepancy_feedback as fb')
        .join('reconciliation.discrepancies as d2', function (this: any) { this.on('d2.tenant_id', 'fb.tenant_id').andOn('d2.id', 'fb.discrepancy_id'); })
        .where('d2.tenant_id', d.tenant_id).where('d2.rule_key', d.rule_key)
        .select(
          trx.raw("COUNT(*) FILTER (WHERE fb.verdict = 'util')::int AS conf"),
          trx.raw("COUNT(*) FILTER (WHERE fb.verdict = 'falso')::int AS fals"),
        ).first();
      const conf = Number(agg?.conf || 0), fals = Number(agg?.fals || 0);
      const denom = conf + fals;
      const precision = denom > 0 ? +(conf / denom).toFixed(3) : null;

      const rule = await trx('reconciliation.rule_registry').where({ tenant_id: d.tenant_id, rule_key: d.rule_key }).select('pinned').first();
      const suppress = !rule?.pinned && denom >= SUPPRESS_MIN_N && precision != null && precision < SUPPRESS_PRECISION;
      await trx('reconciliation.rule_registry').where({ tenant_id: d.tenant_id, rule_key: d.rule_key }).update({
        findings_confirmados: conf, findings_falsos: fals, precision_score: precision,
        suppressed_auto: suppress, updated_at: trx.fn.now(),
      });
      if (suppress) this.logger.warn(`Regla ${d.rule_key} auto-suprimida: precisión ${precision} con ${denom} veredictos.`);
      return { ok: true, status: nuevoStatus, rule_key: d.rule_key, precision, suppressed: suppress };
    });
  }

  async pinRule(rule_key: string, pinned: boolean) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const patch: any = { pinned, updated_at: trx.fn.now() };
      if (pinned) patch.suppressed_auto = false;
      const [row] = await trx('reconciliation.rule_registry').where('rule_key', rule_key).update(patch).returning(['rule_key', 'pinned', 'suppressed_auto']);
      if (!row) throw new BadRequestException('regla no encontrada');
      return row;
    });
  }
}
