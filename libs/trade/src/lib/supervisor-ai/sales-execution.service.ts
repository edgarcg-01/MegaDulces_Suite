import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Venta ↔ Ejecución (Sprint H2.7).
 *
 * Cruza la EJECUCIÓN (exec_score / share del feature store) con la VENTA real de
 * campo (route_tickets 'venta' por vendedor + vendor_sale_lines por tienda/vendedor),
 * read-only y SIN importar Thot/commercial-intelligence — solo lee esas tablas vía
 * KNEX_CONNECTION + tenant explícito (patrón CommercialMap).
 *
 * REALIDAD DE DATOS (audit 2026-06-17): la venta de campo es casi inexistente
 * (1 vendedor con venta, 2 tiendas con líneas, tickets de un solo día). Por eso:
 *   - `getCorrelation` expone lo que hay + doble como DIAGNÓSTICO DE COBERTURA
 *     (cuántos vendedores/tiendas registran venta) — ese es el insight accionable hoy.
 *   - `generateGapFindings` (gap "ejecuta bien pero no registra venta") está GATEADO
 *     por MIN_VENDORS_WITH_SALES: queda DORMIDO hasta que haya volumen, para no
 *     emitir hallazgos sobre ruido (n=1). Se enciende solo cuando la data madura.
 */
const HIGH_EXEC = 60; // exec_score que consideramos "buena ejecución"
const MIN_VENDORS_WITH_SALES = 4; // gate: no juzgar "sin venta" si el registro de venta es inmaduro
const MIN_VISITS = 3;

@Injectable()
export class SalesExecutionService {
  private readonly logger = new Logger(SalesExecutionService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  private quadrant(highExec: boolean, hasSales: boolean): string {
    if (highExec && hasSales) return 'ejecuta_y_vende';
    if (highExec && !hasSales) return 'ejecuta_sin_venta'; // el gap interesante
    if (!highExec && hasSales) return 'vende_sin_ejecutar';
    return 'ambos_bajos';
  }

  /** Datos crudos por vendedor/tienda (30d). Reusado por la vista y por el gate. */
  private async collect(tenantId: string) {
    const collab = await this.knex('commercial.execution_360')
      .where({ tenant_id: tenantId, subject_type: 'collaborator', window_days: 30 })
      .select('subject_id', 'label', 'exec_score', 'avg_score', 'visits_done', 'own_share_pct');
    const stores = await this.knex('commercial.execution_360')
      .where({ tenant_id: tenantId, subject_type: 'store', window_days: 30 })
      .select('subject_id', 'label', 'exec_score', 'avg_score', 'visits_done', 'own_share_pct', 'competitor_share_pct');

    const ventaRows = await this.knex('commercial.route_tickets')
      .where({ tenant_id: tenantId, ticket_type: 'venta' })
      .whereNull('deleted_at')
      .whereRaw("ticket_date >= current_date - 30")
      .whereNotNull('vendor_user_id')
      .groupBy('vendor_user_id')
      .select('vendor_user_id')
      .sum({ revenue: 'total' })
      .count({ tickets: '*' });
    const revByVendor = new Map<string, { revenue: number; tickets: number }>();
    ventaRows.forEach((r: any) =>
      revByVendor.set(r.vendor_user_id, { revenue: Number(r.revenue) || 0, tickets: Number(r.tickets) || 0 }),
    );

    const lineVendorRows = await this.knex('commercial.vendor_sale_lines')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw("sale_date >= current_date - 30")
      .whereNotNull('vendor_user_id')
      .groupBy('vendor_user_id')
      .select('vendor_user_id')
      .sum({ units: 'quantity' });
    const unitsByVendor = new Map<string, number>();
    lineVendorRows.forEach((r: any) => unitsByVendor.set(r.vendor_user_id, Number(r.units) || 0));

    const lineStoreRows = await this.knex('commercial.vendor_sale_lines')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw("sale_date >= current_date - 30")
      .whereNotNull('store_id')
      .groupBy('store_id')
      .select('store_id')
      .sum({ units: 'quantity' });
    const unitsByStore = new Map<string, number>();
    lineStoreRows.forEach((r: any) => unitsByStore.set(r.store_id, Number(r.units) || 0));

    return { collab, stores, revByVendor, unitsByVendor, unitsByStore };
  }

  /** Vista read-only: correlación + cobertura de venta. */
  async getCorrelation(user: any) {
    const tenantId = this.tenantId(user);
    if (!tenantId) return { collaborators: [], stores: [], coverage: null };
    const { collab, stores, revByVendor, unitsByVendor, unitsByStore } = await this.collect(tenantId);

    const collaborators = collab.map((c: any) => {
      const rev = revByVendor.get(c.subject_id)?.revenue || 0;
      const units = unitsByVendor.get(c.subject_id) || 0;
      const exec = c.exec_score != null ? Number(c.exec_score) : null;
      const hasSales = rev > 0 || units > 0;
      return {
        subject_id: c.subject_id,
        label: c.label,
        exec_score: exec,
        visits_done: Number(c.visits_done) || 0,
        revenue_30d: rev,
        units_30d: units,
        has_sales: hasSales,
        quadrant: exec != null ? this.quadrant(exec >= HIGH_EXEC, hasSales) : null,
      };
    });

    const storeRows = stores.map((s: any) => {
      const units = unitsByStore.get(s.subject_id) || 0;
      const exec = s.exec_score != null ? Number(s.exec_score) : null;
      const hasSales = units > 0;
      return {
        subject_id: s.subject_id,
        label: s.label,
        exec_score: exec,
        competitor_share_pct: s.competitor_share_pct != null ? Number(s.competitor_share_pct) : null,
        units_30d: units,
        has_sales: hasSales,
        quadrant: exec != null ? this.quadrant(exec >= HIGH_EXEC, hasSales) : null,
      };
    });

    const coverage = {
      window_days: 30,
      collaborators_total: collaborators.length,
      collaborators_with_sales: collaborators.filter((c) => c.has_sales).length,
      stores_total: storeRows.length,
      stores_with_sales: storeRows.filter((s) => s.has_sales).length,
      sales_data_mature: collaborators.filter((c) => c.has_sales).length >= MIN_VENDORS_WITH_SALES,
    };

    // Ordena: el gap interesante (ejecuta_sin_venta) primero.
    const rank = (q: string | null) => (q === 'ejecuta_sin_venta' ? 0 : q === 'ambos_bajos' ? 1 : 2);
    collaborators.sort((a, b) => rank(a.quadrant) - rank(b.quadrant));

    return { collaborators, stores: storeRows, coverage };
  }

  /**
   * Hallazgo de gap ejecución-venta. GATEADO: solo emite si la venta de campo tiene
   * volumen (≥ MIN_VENDORS_WITH_SALES vendedores con venta). Si no, no-op + auto-resuelve
   * los que hubiera. Evita juzgar "sin venta" cuando el registro de venta es inmaduro.
   */
  async generateGapFindings(tenantId: string): Promise<{ open: number; resolved: number; reason?: string }> {
    if (!tenantId) return { open: 0, resolved: 0, reason: 'no_tenant' };
    const { collab, revByVendor, unitsByVendor } = await this.collect(tenantId);

    const vendorsWithSales = collab.filter(
      (c: any) => (revByVendor.get(c.subject_id)?.revenue || 0) > 0 || (unitsByVendor.get(c.subject_id) || 0) > 0,
    ).length;

    const autoResolve = async () =>
      this.knex('commercial.supervisor_findings')
        .where({ tenant_id: tenantId, source: 'engine', finding_type: 'sales_execution_gap', status: 'open' })
        .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    if (vendorsWithSales < MIN_VENDORS_WITH_SALES) {
      const resolved = await autoResolve();
      return { open: 0, resolved: Number(resolved) || 0, reason: 'insufficient_sales_data' };
    }

    const findings: any[] = [];
    for (const c of collab) {
      const exec = c.exec_score != null ? Number(c.exec_score) : null;
      const hasSales = (revByVendor.get(c.subject_id)?.revenue || 0) > 0 || (unitsByVendor.get(c.subject_id) || 0) > 0;
      if (exec != null && exec >= HIGH_EXEC && !hasSales && Number(c.visits_done) >= MIN_VISITS) {
        findings.push({
          tenant_id: tenantId,
          dedup_key: `sales_execution_gap:collaborator:${c.subject_id}`,
          finding_type: 'sales_execution_gap',
          severity: 'warn',
          subject_type: 'collaborator',
          subject_id: c.subject_id,
          label: c.label ? String(c.label).slice(0, 160) : null,
          score: exec,
          evidence: JSON.stringify({ exec_score: exec, visits: Number(c.visits_done), revenue_30d: 0, units_30d: 0 }),
          source: 'engine',
          status: 'open',
        });
      }
    }

    const keys = findings.map((f) => f.dedup_key);
    if (findings.length > 0) {
      await this.knex('commercial.supervisor_findings')
        .insert(findings)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          severity: this.knex.raw('EXCLUDED.severity'),
          label: this.knex.raw('EXCLUDED.label'),
          score: this.knex.raw('EXCLUDED.score'),
          evidence: this.knex.raw('EXCLUDED.evidence'),
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_findings.status IN ('dismissed','confirmed') THEN commercial.supervisor_findings.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }
    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'engine', finding_type: 'sales_execution_gap', status: 'open' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    return { open: findings.length, resolved: Number(resolved) || 0 };
  }
}
