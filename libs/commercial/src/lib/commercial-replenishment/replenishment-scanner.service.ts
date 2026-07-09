import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';

/**
 * RA.8 — Scanner nocturno de reabastecimiento. Detecta situaciones críticas y las
 * persiste en commercial.replenishment_findings (bandeja HITL, idempotente por
 * dedup_key). El motor decide, el humano trabaja la bandeja (ADR-016).
 *
 *   agotado_abc  = clase A con existencia disponible ≤ 0        → crítica
 *   bajo_reorden = existencia ≤ punto de reorden (reorden > 0)  → alta (A) / media (resto)
 *
 * Corre como postgres user (KNEX_NEW_DB) con SET LOCAL app.tenant_id por tenant
 * (mismo patrón que AlertsScannerService). Resta el tránsito (RA.5). Al cerrar cada
 * tenant, resuelve los hallazgos 'open' cuya condición ya no se cumple.
 *
 * WS realtime = diferido (la bandeja es la superficie). El cron se puede apagar con
 * ENABLE_REPLENISHMENT_SCAN=false; el endpoint manual /scan-now siempre funciona.
 */
@Injectable()
export class ReplenishmentScannerService {
  private readonly logger = new Logger(ReplenishmentScannerService.name);
  private isRunning = false;

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  @Cron('0 0 6 * * *') // 06:00 UTC = 00:00 America/Mexico_City
  async scheduledScan(): Promise<void> {
    if (process.env.ENABLE_REPLENISHMENT_SCAN === 'false') return;
    if (this.isRunning) { this.logger.warn('Skip: previous scan still running'); return; }
    await this.scanAllTenants();
  }

  async scanAllTenants(): Promise<{ tenants: number; findings: number }> {
    this.isRunning = true;
    let findings = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) findings += await this.scanTenant(t.id);
      this.logger.log(`Reorden scan: ${tenants.length} tenants, ${findings} hallazgos activos`);
      return { tenants: tenants.length, findings };
    } finally {
      this.isRunning = false;
    }
  }

  async scanTenant(tenantId: string): Promise<number> {
    let count = 0;
    await this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);

      const oh = '(COALESCE(s.quantity,0) - COALESCE(s.reserved_quantity,0))';
      const it = 'COALESCE(pit.qty_in_transit, 0)';
      // Objetivo = máximo (restock real). Sugerido neto de tránsito.
      const sugg = `GREATEST(0, rp.max_stock - ${oh} - ${it})`;

      const rows: any[] = await trx('commercial.reorder_policy as rp')
        .leftJoin('commercial.stock as s', (j) =>
          j.on('s.tenant_id', 'rp.tenant_id').andOn('s.warehouse_id', 'rp.warehouse_id').andOn('s.product_id', 'rp.product_id'))
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .leftJoin('commercial.abc_classification as abc', (j) =>
          j.on('abc.tenant_id', 'rp.tenant_id').andOn('abc.warehouse_id', 'rp.warehouse_id').andOn('abc.product_id', 'rp.product_id'))
        .leftJoin('analytics.purchase_in_transit as pit', (j) =>
          j.on('pit.tenant_id', 'rp.tenant_id').andOn('pit.warehouse_id', 'rp.warehouse_id').andOn('pit.product_id', 'rp.product_id'))
        .where('rp.tenant_id', tenantId)
        .andWhere('rp.reorder_point', '>', 0)
        .andWhereRaw(`${oh} <= rp.reorder_point`) // sólo crítico (≤ punto de reorden)
        .select(
          'rp.warehouse_id', 'rp.product_id',
          trx.raw(`${oh} AS on_hand`),
          'rp.reorder_point',
          trx.raw(`${it} AS in_transit`),
          trx.raw('abc.abc_class AS abc_class'),
          trx.raw(`${sugg} AS suggested_qty`),
          trx.raw(`ROUND(${sugg} * COALESCE(pr.cost_base,0), 2) AS suggested_cost`),
        );

      const seen: string[] = [];
      for (const r of rows) {
        const onHand = Number(r.on_hand);
        const abc = (r.abc_class || '').toUpperCase();
        const isA = abc === 'A';
        const kind = onHand <= 0 && isA ? 'agotado_abc' : 'bajo_reorden';
        // agotado_abc sólo para clase A agotada; el resto es bajo_reorden.
        const severity = kind === 'agotado_abc' ? 'critica' : (isA ? 'alta' : 'media');
        const dedup = `${kind}:${r.warehouse_id}:${r.product_id}`;
        seen.push(dedup);
        await trx.raw(
          `INSERT INTO commercial.replenishment_findings
             (tenant_id, warehouse_id, product_id, kind, severity, dedup_key, status, abc_class, on_hand, reorder_point, in_transit, suggested_qty, suggested_cost, first_seen_at, last_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, now(), now(), now())
           ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET
             status='open', severity=EXCLUDED.severity, abc_class=EXCLUDED.abc_class,
             on_hand=EXCLUDED.on_hand, reorder_point=EXCLUDED.reorder_point, in_transit=EXCLUDED.in_transit,
             suggested_qty=EXCLUDED.suggested_qty, suggested_cost=EXCLUDED.suggested_cost,
             last_seen_at=now(), resolved_at=NULL, updated_at=now()`,
          [tenantId, r.warehouse_id, r.product_id, kind, severity, dedup, abc || null,
           onHand, Number(r.reorder_point), Number(r.in_transit), Number(r.suggested_qty), Number(r.suggested_cost)],
        );
        count++;
      }

      // Resolver los hallazgos abiertos cuya condición ya no aplica.
      if (seen.length) {
        await trx('commercial.replenishment_findings')
          .where({ tenant_id: tenantId, status: 'open' })
          .whereNotIn('dedup_key', seen)
          .update({ status: 'resolved', resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
      } else {
        await trx('commercial.replenishment_findings')
          .where({ tenant_id: tenantId, status: 'open' })
          .update({ status: 'resolved', resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
      }
    });
    return count;
  }
}
