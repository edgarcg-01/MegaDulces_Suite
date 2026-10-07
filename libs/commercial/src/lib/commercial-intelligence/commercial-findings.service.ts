import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialCalibrationService } from './commercial-calibration.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAP_PER_TYPE = 50; // tope de findings por tipo (anti-flood); se loguea lo truncado
const MARGIN_MIN = 0.08; // < 8% neto → margen rezagado; < 0 → crítico
const num = (v: any, d = 0) => (v != null && !isNaN(Number(v)) ? Number(v) : d);

/**
 * Thot (ADR-018) — Track Razonamiento, Sprint T.R0: motor de findings comerciales.
 *
 * Análogo comercial del FindingsEngine de Horus. Lee customer_360 + catálogo + señales
 * intelligence.* y emite hallazgos deterministas a commercial.commercial_findings.
 * CERO LLM: el motor DECIDE con reglas explicables; el agente (T.R3) redactará.
 *
 * Reglas (calibradas contra el dato real, audit T.R0 2026-06-19):
 *   ACTIVAS (portafolio/distribución — dato rico):
 *     - low_rotation_priced (product): SKU priceado con rotación 'baja' → riesgo dead-stock.
 *     - margin_laggard      (product): SKU priceado con margen neto < 8% (o negativo).
 *     - distribution_gap    (product): top-10 en demanda de zona pero exhibido por ≤2 PdVs.
 *   ESPARCIDA (cliente — dato pobre, se enciende sola al crecer pedidos):
 *     - churn_risk          (customer): con cadencia, at_risk/lost y recency > 2× cadencia.
 *
 * Cap por tipo (anti-flood) + log de lo truncado (sin cap silencioso). Idempotente:
 * UPSERT por (tenant_id, dedup_key); respeta dismissed/confirmed; resuelve lo que ya no
 * aplica. Acceso vía TenantKnexService (RLS real) + public.current_tenant_id().
 */
@Injectable()
export class CommercialFindingsService {
  private readonly logger = new Logger(CommercialFindingsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly calibration: CommercialCalibrationService,
  ) {}

  /** Genera/actualiza los findings comerciales del tenant ACTUAL (scope CLS). */
  async generateForTenant(): Promise<{ open: number; resolved: number; suppressed: number; capped: Record<string, number> }> {
    // L2 (ADR-021): calibración aprendida — suprime las reglas que el analista descarta casi
    // siempre y capa las medio-ruidosas. Run previo (no anidar tk.run); cold-start neutro.
    const calib = await this.calibration.getCalibration();
    let suppressed = 0;
    return this.tk.run(async (trx) => {
      const findings: any[] = [];
      const capped: Record<string, number> = {};
      const add = (
        finding_type: string,
        severity: string,
        subject_type: string,
        subject_id: string,
        label: string | null,
        score: number,
        evidence: any,
      ) => {
        const c = calib.get(finding_type);
        if (c?.suppressed) {
          suppressed++;
          return; // regla aprendida como ruidosa → no molesta
        }
        if (c?.cap === 'warn' && severity === 'critical') severity = 'warn';
        findings.push({
          tenant_id: trx.raw('public.current_tenant_id()'),
          dedup_key: `${finding_type}:${subject_type}:${subject_id}`,
          finding_type,
          severity,
          subject_type,
          subject_id,
          label: label ? String(label).slice(0, 160) : null,
          score: Math.round(score * 100) / 100,
          evidence: JSON.stringify(evidence),
          source: 'engine',
          status: 'open',
        });
      };
      const capAndLog = (type: string, rows: any[]): any[] => {
        if (rows.length > CAP_PER_TYPE) {
          capped[type] = rows.length;
          this.logger.log(`commercial_findings: ${type} encontró ${rows.length}, emite top ${CAP_PER_TYPE}`);
          return rows.slice(0, CAP_PER_TYPE);
        }
        return rows;
      };

      // Lista de precios default (representativa para margen/rotación del portafolio).
      const def = await trx('commercial.price_lists')
        .where({ is_default: true, active: true })
        .whereNull('deleted_at')
        .first('id');
      const priceListId = def?.id || null;

      if (priceListId) {
        // Productos priceados (intención comercial de vender) + margen neto + rotación.
        const priced = await trx.raw(
          `
          SELECT p.id, p.nombre, p.rotation_tier, p.sales_units_30d,
                 pp.price, p.cost_with_tax, COALESCE(pp.tax_rate, 0) AS tax_rate,
                 CASE WHEN p.cost_with_tax > 0 AND pp.price > 0
                      THEN (pp.price - p.cost_with_tax / (1 + COALESCE(pp.tax_rate, 0))) / pp.price
                      ELSE NULL END AS margin_net
          FROM catalog.products p
          JOIN commercial.product_prices pp
            ON pp.product_id = p.id AND pp.tenant_id = p.tenant_id
           AND pp.price_list_id = ? AND pp.deleted_at IS NULL AND pp.price > 0
          LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
          WHERE p.tenant_id = public.current_tenant_id() AND p.deleted_at IS NULL
            AND (b.is_commercial = true OR b.is_commercial IS NULL)
            AND p.nombre NOT ILIKE '%GRATIS%'
          `,
          [priceListId],
        );
        const rows = priced.rows || [];

        // 1) low_rotation_priced: priceado + rotación 'baja' → riesgo dead-stock.
        const lowRot = rows
          .filter((r: any) => r.rotation_tier === 'baja')
          .sort((a: any, b: any) => num(a.sales_units_30d) - num(b.sales_units_30d));
        for (const r of capAndLog('low_rotation_priced', lowRot)) {
          const s30 = num(r.sales_units_30d);
          add('low_rotation_priced', s30 === 0 ? 'critical' : 'warn', 'product', r.id, r.nombre, 100 / (1 + s30), {
            rotation_tier: r.rotation_tier,
            sales_units_30d: s30,
            price: num(r.price),
          });
        }

        // 2) margin_laggard: margen neto < 8% (crítico si negativo).
        const lowMargin = rows
          .filter((r: any) => r.margin_net != null && Number(r.margin_net) < MARGIN_MIN)
          .sort((a: any, b: any) => Number(a.margin_net) - Number(b.margin_net));
        for (const r of capAndLog('margin_laggard', lowMargin)) {
          const m = Number(r.margin_net);
          add('margin_laggard', m < 0 ? 'critical' : 'warn', 'product', r.id, r.nombre, (MARGIN_MIN - m) * 100, {
            margin_pct: Math.round(m * 100),
            price: num(r.price),
            cost_with_tax: num(r.cost_with_tax),
            threshold_pct: MARGIN_MIN * 100,
          });
        }
      }

      // 3) distribution_gap: top-10 en demanda de zona pero exhibido por ≤2 PdVs (whitespace).
      const distrib = await trx.raw(
        `
        WITH demanded AS (
          SELECT zd.product_id, zd.zona, zd.rank, zd.demand_index,
                 ROW_NUMBER() OVER (PARTITION BY zd.product_id ORDER BY zd.rank ASC) AS rn
          FROM intelligence.zone_demand zd
          WHERE zd.tenant_id = public.current_tenant_id() AND zd.rank <= 10
        ),
        pres AS (
          SELECT product_id, COUNT(DISTINCT customer_id) AS pdv_count
          FROM intelligence.pdv_presence
          WHERE tenant_id = public.current_tenant_id()
          GROUP BY product_id
        )
        SELECT d.product_id, d.zona, d.rank, d.demand_index, COALESCE(pr.pdv_count, 0) AS pdv_count, p.nombre
        FROM demanded d
        JOIN catalog.products p
          ON p.id = d.product_id AND p.tenant_id = public.current_tenant_id() AND p.deleted_at IS NULL
        LEFT JOIN pres pr ON pr.product_id = d.product_id
        WHERE d.rn = 1 AND COALESCE(pr.pdv_count, 0) <= 2
        ORDER BY d.rank ASC, d.demand_index DESC NULLS LAST
        `,
      );
      const distribRows = distrib.rows || [];
      for (const r of capAndLog('distribution_gap', distribRows)) {
        const pdv = num(r.pdv_count);
        add('distribution_gap', pdv === 0 ? 'warn' : 'info', 'product', r.product_id, r.nombre, num(r.demand_index) * 100, {
          zona: r.zona,
          demand_rank: num(r.rank),
          demand_index: Math.round(num(r.demand_index) * 100) / 100,
          pdv_count: pdv,
        });
      }

      // 4) churn_risk (esparcido): cliente con cadencia, at_risk/lost y recency > 2× cadencia.
      const churn = await trx('commercial.customer_360 as c360')
        .join('commercial.customers as c', 'c.id', 'c360.customer_id')
        .whereNotNull('c360.cadence_days')
        .whereIn('c360.lifecycle_stage', ['at_risk', 'lost'])
        .whereNull('c.deleted_at')
        .whereRaw('c360.recency_days > c360.cadence_days * 2')
        .select(
          'c360.customer_id',
          'c.name',
          'c.code',
          'c360.recency_days',
          'c360.cadence_days',
          'c360.lifecycle_stage',
          'c360.last_order_at',
        );
      for (const r of churn) {
        add('churn_risk', r.lifecycle_stage === 'lost' ? 'critical' : 'warn', 'customer', r.customer_id, r.name || r.code, num(r.recency_days), {
          recency_days: num(r.recency_days),
          cadence_days: num(r.cadence_days),
          lifecycle_stage: r.lifecycle_stage,
          last_order_at: r.last_order_at,
        });
      }

      // UPSERT idempotente + resolución de lo que ya no aplica (patrón Horus).
      const keys = findings.map((f) => f.dedup_key);
      if (findings.length > 0) {
        await trx('commercial.commercial_findings')
          .insert(findings)
          .onConflict(['tenant_id', 'dedup_key'])
          .merge({
            severity: trx.raw('EXCLUDED.severity'),
            label: trx.raw('EXCLUDED.label'),
            score: trx.raw('EXCLUDED.score'),
            evidence: trx.raw('EXCLUDED.evidence'),
            status: trx.raw(
              `CASE WHEN commercial.commercial_findings.status IN ('dismissed','confirmed') THEN commercial.commercial_findings.status ELSE 'open' END`,
            ),
            updated_at: trx.fn.now(),
          });
      }

      const resolvedQ = trx('commercial.commercial_findings')
        .where({ source: 'engine', status: 'open' });
      if (keys.length) resolvedQ.whereNotIn('dedup_key', keys);
      const resolved = await resolvedQ.update({ status: 'resolved', updated_at: trx.fn.now() });

      return { open: findings.length, resolved: Number(resolved) || 0, suppressed, capped };
    });
  }

  /** Bandeja de findings comerciales (default open), priorizada por severidad + score. */
  async listFindings(filters: { status?: string; severity?: string; subject_type?: string } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.commercial_findings').select('*');
      q = q.where('status', filters.status || 'open');
      if (filters.severity) q = q.where('severity', filters.severity);
      if (filters.subject_type) q = q.where('subject_type', filters.subject_type);
      q = q
        .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
        .orderBy('score', 'desc')
        .limit(200);
      const rows = await q;
      return { rows, total: rows.length };
    });
  }

  /** Feedback humano: descarta/confirma/marca-revisado un finding comercial. */
  async reviewFinding(id: string, status: string) {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    if (!['dismissed', 'confirmed', 'reviewed'].includes(status)) {
      throw new BadRequestException('status debe ser dismissed | confirmed | reviewed');
    }
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const updated = await trx('commercial.commercial_findings')
        .where({ id })
        .update({
          status,
          reviewed_by: userId && UUID_RE.test(String(userId)) ? userId : null,
          reviewed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (!updated.length) throw new NotFoundException('Finding no encontrado');
      return updated[0];
    });
  }
}
