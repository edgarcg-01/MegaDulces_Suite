import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Fase PREV.3 — Índice de riesgo de inventario (Apéndice B §14-15).
 *
 * Recalcula, por (almacén, producto), un score + nivel desde los expedientes de
 * investigación + los conteos de monitoreo (ventana 90d), para DIRIGIR RECURSOS de
 * Prevención. La reincidencia (más expedientes / PNI) sube el nivel. NO acusa personas:
 * el eje es SKU/almacén, nunca colaborador.
 *
 * Determinista (motor decide, ADR-016). Recálculo manual por endpoint; el scanner
 * nocturno multi-tenant queda diferido (necesita scope CLS sintético).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_DAYS = 90;

export interface RiskInputs {
  investigations: number;
  pni: number;
  monitoringLosses: number;
  shrinkValue: number;
}

@Injectable()
export class InventoryRiskService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Score + nivel deterministas. PNI y reincidencia pesan más; el valor aporta acotado. */
  static computeScore(i: RiskInputs): { score: number; level: 'bajo' | 'medio' | 'alto' | 'critico' } {
    const score =
      i.investigations * 10 +
      i.pni * 25 +
      i.monitoringLosses * 8 +
      Math.min(i.shrinkValue / 1000, 50);
    const rounded = Math.round(score * 100) / 100;
    // Reincidencia + no-identificada = crítico.
    let level: 'bajo' | 'medio' | 'alto' | 'critico';
    if (rounded >= 60 || (i.pni >= 1 && i.investigations >= 2)) level = 'critico';
    else if (rounded >= 30 || i.investigations >= 2 || i.pni >= 1) level = 'alto';
    else if (rounded >= 10 || i.monitoringLosses >= 1 || i.investigations >= 1) level = 'medio';
    else level = 'bajo';
    return { score: rounded, level };
  }

  /** Recalcula el índice (ventana 90d). Idempotente: DELETE+INSERT del scope. */
  async compute(warehouseId?: string): Promise<{ computed: number }> {
    if (warehouseId && !UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      // A) Expedientes de investigación (ventana 90d).
      const invRes = await trx.raw(
        `SELECT warehouse_id, product_id,
                COUNT(*)::int AS investigations_count,
                COUNT(*) FILTER (WHERE root_cause = 'PNI' OR status = 'monitoring')::int AS pni_count,
                COALESCE(SUM(ABS(value_at_cost)) FILTER (WHERE difference < 0), 0)::numeric AS shrink_value,
                MAX(opened_at) AS last_event_at
           FROM commercial.inventory_investigations
          WHERE opened_at >= now() - interval '${WINDOW_DAYS} days'
            ${warehouseId ? 'AND warehouse_id = ?' : ''}
          GROUP BY warehouse_id, product_id`,
        warehouseId ? [warehouseId] : [],
      );
      // B) Pérdidas en monitoreo (ventana 90d).
      const monRes = await trx.raw(
        `SELECT m.warehouse_id, m.product_id,
                COUNT(c.*) FILTER (WHERE c.difference < 0)::int AS monitoring_losses,
                MAX(c.counted_at) AS last_count_at
           FROM commercial.inventory_monitoring m
           JOIN commercial.inventory_monitoring_counts c
             ON c.tenant_id = m.tenant_id AND c.monitoring_id = m.id
          WHERE m.started_at >= now() - interval '${WINDOW_DAYS} days'
            ${warehouseId ? 'AND m.warehouse_id = ?' : ''}
          GROUP BY m.warehouse_id, m.product_id`,
        warehouseId ? [warehouseId] : [],
      );

      const map = new Map<string, any>();
      for (const r of invRes.rows) {
        map.set(`${r.warehouse_id}|${r.product_id}`, {
          warehouse_id: r.warehouse_id,
          product_id: r.product_id,
          investigations_count: Number(r.investigations_count),
          pni_count: Number(r.pni_count),
          monitoring_losses: 0,
          shrink_value: Number(r.shrink_value),
          last_event_at: r.last_event_at,
        });
      }
      for (const r of monRes.rows) {
        const key = `${r.warehouse_id}|${r.product_id}`;
        const e = map.get(key) || {
          warehouse_id: r.warehouse_id, product_id: r.product_id,
          investigations_count: 0, pni_count: 0, monitoring_losses: 0, shrink_value: 0, last_event_at: null,
        };
        e.monitoring_losses = Number(r.monitoring_losses);
        if (r.last_count_at && (!e.last_event_at || new Date(r.last_count_at) > new Date(e.last_event_at))) {
          e.last_event_at = r.last_count_at;
        }
        map.set(key, e);
      }

      const rows = Array.from(map.values()).map((e) => {
        const { score, level } = InventoryRiskService.computeScore({
          investigations: e.investigations_count,
          pni: e.pni_count,
          monitoringLosses: e.monitoring_losses,
          shrinkValue: e.shrink_value,
        });
        return { ...e, risk_score: score, risk_level: level };
      });

      // Reemplazo del scope (idempotente).
      if (warehouseId) await trx('commercial.inventory_risk_index').where({ warehouse_id: warehouseId }).del();
      else await trx('commercial.inventory_risk_index').del();

      if (rows.length) {
        await trx('commercial.inventory_risk_index').insert(
          rows.map((r) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: r.warehouse_id,
            product_id: r.product_id,
            investigations_count: r.investigations_count,
            pni_count: r.pni_count,
            monitoring_losses: r.monitoring_losses,
            shrink_value: r.shrink_value,
            risk_score: r.risk_score,
            risk_level: r.risk_level,
            last_event_at: r.last_event_at,
            computed_at: trx.fn.now(),
          })),
        );
      }
      return { computed: rows.length };
    });
  }

  async list(query: { risk_level?: string; warehouse_id?: string; limit?: number }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(1000, Math.max(1, Number(query.limit) || 300));
    return this.tk.run(async (trx) => {
      let q = trx('commercial.inventory_risk_index as r')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'r.tenant_id').andOn('w.id', '=', 'r.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'r.product_id');
      if (query.risk_level) q = q.where('r.risk_level', query.risk_level);
      if (query.warehouse_id) q = q.where('r.warehouse_id', query.warehouse_id);
      return q
        .select(
          'r.id', 'r.warehouse_id', 'w.code as warehouse_code',
          'r.product_id', 'p.sku', 'p.nombre as product_name',
          'r.investigations_count', 'r.pni_count', 'r.monitoring_losses',
          'r.shrink_value', 'r.risk_score', 'r.risk_level', 'r.last_event_at', 'r.computed_at',
        )
        .orderBy('r.risk_score', 'desc')
        .limit(limit);
    });
  }
}
